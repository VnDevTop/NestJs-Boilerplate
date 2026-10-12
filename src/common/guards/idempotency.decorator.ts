import { SetMetadata } from '@nestjs/common';

import { type IdempotencyPolicy } from './idempotency-policy.interface.js';

export const IDEMPOTENCY_KEY = 'idempotency';

/**
 * Requires an `Idempotency-Key` header, and replays the answer to a repeat.
 *
 * **For routes where doing the work twice is worse than being slightly slower.**
 * Creating an account, deleting one, replacing a permission set. Not for routes
 * that are naturally idempotent — a `PATCH` that sets a field to a value is
 * already the same answer twice, and making it replay-cached buys nothing and
 * costs a redis round trip.
 *
 * The header is **required**, not optional. A route marked with this and called
 * without the key is a 400, because a client that does not know about idempotency
 * is exactly the client that will retry blindly — and generating a key on its
 * behalf would silently promise a guarantee the caller is not making.
 *
 * ```ts
 * @Idempotent()
 * @Post()
 * create(@Body() dto: CreateUserDto) { … }
 * ```
 */
export const Idempotent = (policy: IdempotencyPolicy = {}) =>
  SetMetadata(IDEMPOTENCY_KEY, policy);
