/**
 * Counts a hit and decides, in one atomic step.
 *
 * A Lua script rather than a read and a write because the read and the write are
 * the bug. Two requests arrive together, both read `hits: 4` against a limit of
 * five, both write `5`, and both are allowed through. A limiter that lets a
 * burst through in pairs is not a limiter, and the burst is exactly what an
 * attacker sends.
 *
 * The counters live in one hash so the whole decision is a single `EVALSHA`:
 *
 * - `hits`        requests counted in the current window
 * - `expiresAt`   when that window ends, in epoch milliseconds
 * - `blockedUntil` when the block lifts, absent or in the past when not blocked
 *
 * On blocking, `hits` is reset to zero and the window restarts once the block
 * lifts. Without that reset the counter is still above the limit when the block
 * expires, so the first request after it is blocked again and the account can
 * never get back in without the window elapsing. That turns a temporary lockout
 * into a permanent one.
 *
 * Milliseconds throughout: `@nestjs/throttler` v5 onward passes `ttl` and
 * `blockDuration` in milliseconds, and `PEXPIRE` matches.
 */
const THROTTLE_SCRIPT = `
local key       = KEYS[1]
local ttl       = tonumber(ARGV[1])
local limit     = tonumber(ARGV[2])
local blockFor  = tonumber(ARGV[3])
local now       = tonumber(ARGV[4])

local blockedUntil = tonumber(redis.call('HGET', key, 'blockedUntil') or '0')
local hits         = tonumber(redis.call('HGET', key, 'hits') or '0')
local expiresAt    = tonumber(redis.call('HGET', key, 'expiresAt') or '0')

-- Already blocked: report the block without touching the counters, so the
-- block does not extend itself every time somebody retries into it.
if blockedUntil > now then
  return { hits, expiresAt - now, 1, blockedUntil - now }
end

hits = redis.call('HINCRBY', key, 'hits', 1)

if hits == 1 then
  expiresAt = now + ttl
  redis.call('HSET', key, 'expiresAt', expiresAt)
  redis.call('PEXPIRE', key, ttl)
end

if blockFor > 0 and hits > limit then
  redis.call('HSET', key, 'blockedUntil', now + blockFor)
  redis.call('HSET', key, 'hits', 0)
  redis.call('HSET', key, 'expiresAt', now + blockFor)
  redis.call('PEXPIRE', key, blockFor)

  return { hits, ttl, 1, blockFor }
end

return { hits, expiresAt - now, 0, 0 }
`;

/**
 * What the script returns: four numbers, in the order the `return` statements
 * above produce them.
 *
 * Typed as a tuple of numbers because that is what redis hands back. It is not
 * booleans: Lua returns `1` and `0`, and declaring `isBlocked` as a boolean would
 * make `=== 1` a comparison the compiler believes cannot happen, which is how a
 * permanently blocked caller gets let through.
 */
type ThrottleTuple = [number, number, number, number];

export { THROTTLE_SCRIPT };
export type { ThrottleTuple };
