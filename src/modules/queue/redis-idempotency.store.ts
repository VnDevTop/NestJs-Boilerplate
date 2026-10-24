import { Injectable, Logger } from '@nestjs/common';

import {
  IdempotencyStorage,
  type IdempotencyAcquireResult,
  type IdempotencyStore,
} from '@nestjs/idempotency';

import { RedisClientService } from './redis-client.service.js';

const PREFIX = 'idem';

const ACQUIRE_SCRIPT = `
local ok = redis.call('SET', KEYS[1], ARGV[4], 'NX', 'PX', tonumber(ARGV[3]))
if ok then
  return {1}
end
return {0, redis.call('GET', KEYS[1])}
`;

const COMPLETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, obj = pcall(cjson.decode, current)
if not ok or type(obj) ~= 'table' or obj.state ~= 'lock' or obj.owner ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', tonumber(ARGV[2]))
return 1
`;

const RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, obj = pcall(cjson.decode, current)
if not ok or type(obj) ~= 'table' or obj.state ~= 'lock' or obj.owner ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

const EXTEND_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, obj = pcall(cjson.decode, current)
if not ok or type(obj) ~= 'table' or obj.state ~= 'lock' or obj.owner ~= ARGV[1] then
  return 0
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly logger = new Logger(RedisIdempotencyStore.name);

  constructor(
    private readonly redis: RedisClientService,
    storage: IdempotencyStorage,
  ) {
    storage.registerSource(this);
  }

  async acquire(
    key: string,
    owner: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<IdempotencyAcquireResult> {
    const lockRecord = JSON.stringify({ state: 'lock', owner, fingerprint });

    let result = await this.redis.eval(
      ACQUIRE_SCRIPT,
      [`${PREFIX}:${key}`],
      [owner, fingerprint, lockTtl, lockRecord],
    );

    if (result === null) {
      throw new Error('idempotency store unavailable');
    }

    if (!Array.isArray(result) || result[0] !== 1) {
      // Key may have expired between SET and GET; treat as acquired.
      const existingRaw = Array.isArray(result) ? result[1] : null;
      if (existingRaw === null || existingRaw === undefined) {
        return { state: 'acquired' };
      }

      const existing = JSON.parse(String(existingRaw)) as {
        state: string;
        fingerprint: string;
        response: unknown;
      };

      if (existing.state === 'lock') {
        return { state: 'in-flight', fingerprint: existing.fingerprint };
      }

      return {
        state: 'completed',
        fingerprint: existing.fingerprint,
        response: existing.response as never,
      };
    }

    return { state: 'acquired' };
  }

  async complete(
    key: string,
    owner: string,
    response: Parameters<IdempotencyStore['complete']>[2],
    ttl: number,
  ): Promise<boolean> {
    const current = await this.redis.get(`${PREFIX}:${key}`);
    let fingerprint = '';

    if (current) {
      try {
        fingerprint =
          (JSON.parse(current) as { fingerprint?: string }).fingerprint ?? '';
      } catch {
        fingerprint = '';
      }
    }

    const completedRecord = JSON.stringify({
      state: 'completed',
      fingerprint,
      response,
    });

    const result = await this.redis.eval(
      COMPLETE_SCRIPT,
      [`${PREFIX}:${key}`],
      [owner, ttl, completedRecord],
    );

    if (result === null) {
      throw new Error('idempotency store unavailable');
    }

    return result === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      [`${PREFIX}:${key}`],
      [owner],
    );

    if (result === null) {
      throw new Error('idempotency store unavailable');
    }

    return result === 1;
  }

  async extend(key: string, owner: string, lockTtl: number): Promise<boolean> {
    const result = await this.redis.eval(
      EXTEND_SCRIPT,
      [`${PREFIX}:${key}`],
      [owner, lockTtl],
    );

    if (result === null) {
      throw new Error('idempotency store unavailable');
    }

    return result === 1;
  }
}
