import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { authDeviceSessionsKey, CacheService } from '../../core/cache/index.js';
import type { CacheConfig } from '../../configs/index.js';
import { UsersService } from '../users/users.service.js';

import { UserDeviceDto } from './dto/index.js';
import { UserDevice } from './entities/index.js';
import { DeviceMetadata } from './types/index.js';

@Injectable()
export class DeviceService {
  constructor(
    @InjectRepository(UserDevice)
    private readonly devicesRepository: Repository<UserDevice>,
    private readonly usersService: UsersService,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
  ) {}

  private get store(): EntityManager {
    return this.devicesRepository.manager;
  }

  private get deviceTtl(): number {
    return this.configService.getOrThrow<CacheConfig>('cache').authUserTtl;
  }

  /**
   * Resolves the device behind an incoming login request.
   *
   * Devices are fingerprinted by user agent, so repeated logins from the same
   * browser or app reuse a single row instead of piling up duplicates. A
   * previously revoked device is reactivated, because logging in again from the
   * same client is a legitimate new session.
   */
  async register(
    userId: string,
    metadata: DeviceMetadata,
    manager: EntityManager = this.store,
  ): Promise<UserDevice> {
    const existing = await manager.findOne(UserDevice, {
      where: {
        userId,
        userAgent: metadata.userAgent === null ? IsNull() : metadata.userAgent,
      },
    });

    if (existing) {
      existing.ipAddress = metadata.ipAddress;
      existing.deviceName = metadata.deviceName ?? existing.deviceName;
      existing.isActive = true;

      return manager.save(existing);
    }

    const device = manager.create(UserDevice, {
      userId,
      deviceName: metadata.deviceName,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      isActive: true,
    });

    return manager.save(device);
  }

  async listByUserId(userId: string): Promise<UserDeviceDto[]> {
    const devices = await this.devicesRepository.find({
      where: { userId, isActive: true },
      order: { createdAt: 'DESC' },
    });

    return UserDeviceDto.fromEntities(devices);
  }

  async findActiveById(
    userId: string,
    deviceId: string,
  ): Promise<UserDevice | null> {
    return this.devicesRepository.findOne({
      where: { id: deviceId, userId, isActive: true },
    });
  }

  /**
   * One device whether or not it is active, for minting an access token.
   *
   * `findActiveById` refuses a revoked device, which is right for listing and
   * wrong here: a revoked device can still hold a live refresh token, and
   * refusing to read it would turn "this session was revoked" into "this session
   * does not exist", which is a different failure for the caller to diagnose.
   */
  async findByIdForSession(
    userId: string,
    deviceId: string,
  ): Promise<UserDevice | null> {
    return this.devicesRepository.findOne({ where: { id: deviceId, userId } });
  }

  async revoke(userId: string, deviceId: string): Promise<UserDevice> {
    const device = await this.findActiveById(userId, deviceId);

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    device.isActive = false;

    try {
      // The version bump is what revokes the access tokens; `isActive` is what the
      // admin screens read. Setting only the flag would leave every token already
      // minted on this device working for the rest of its lifetime, which is the
      // opposite of what revoking a device means to whoever asked.
      device.sessionsVersion = (device.sessionsVersion ?? 0) + 1;

      return await this.devicesRepository.save(device);
    } finally {
      await this.usersService.invalidateAuthCache(userId);
    }
  }

  async revokeAllByUserId(userId: string): Promise<number> {
    const result = await this.devicesRepository.update(
      { userId, isActive: true },
      { isActive: false },
    );

    await this.usersService.invalidateAuthCache(userId);

    return result.affected ?? 0;
  }

  /**
   * Every device of a user with the version its sessions were minted against.
   *
   * Read by the strategy on each request whose access token names a device, which
   * is what makes signing out of one browser leave the others signed in.
   *
   * Cached because it is on the request path, and invalidated by the same call
   * that drops a user's claims, since there is no version bump that changes one
   * device without changing who is presenting it.
   *
   * Every device of the user is in the answer, revoked ones included. An absent
   * device is refused by the caller rather than skipped, because that is what a
   * deleted device looks like from here.
   */
  async findSessionVersions(userId: string): Promise<Record<string, number>> {
    return this.cache.wrap<Record<string, number>>(
      authDeviceSessionsKey(userId),
      async () => {
        const devices = await this.devicesRepository.find({
          select: { id: true, sessionsVersion: true },
          where: { userId },
        });

        return Object.fromEntries(
          devices.map((device) => [device.id, device.sessionsVersion ?? 0]),
        );
      },
      { ttl: this.deviceTtl },
    );
  }

  /**
   * Ends every access token minted on one device, leaving other devices alone.
   *
   * The increment is what actually revokes: the strategy compares the version in
   * the token against the one here, so a token minted before this call is behind
   * and refused. `isActive` alone would not do it, because the strategy never
   * read that column and a revoked device's row is still perfectly findable.
   *
   * The cached answers are dropped after the statement rather than before it, for
   * the same reason everywhere else in this cache: a read landing in between would
   * refill the map from the row being revoked and keep the token alive for the
   * rest of the TTL, which is the opposite of what was asked for.
   */
  async revokeDeviceSessions(userId: string, deviceId: string): Promise<void> {
    try {
      await this.devicesRepository.increment(
        { id: deviceId, userId },
        'sessionsVersion',
        1,
      );
    } finally {
      await this.usersService.invalidateAuthCache(userId);
    }
  }
}
