import { SetMetadata } from '@nestjs/common';

import { EMAIL_VERIFIED_KEY } from '../constants/index.js';

/**
 * Requires the caller to have confirmed their address.
 *
 * **Opt-in, like `@ManagerOnly()` and not like the JWT guard.** Requiring a
 * verified address everywhere would lock a new user out of the very route they need
 * to verify it, and would make `register` — which returns a token for an unverified
 * account — pointless. The routes that need it say so.
 *
 * **Which routes is a product decision, and this boilerplate's answer is narrow.**
 * Applied to password changes, two-factor setup and the device and session
 * routes: the actions that turn a stolen session into a permanent one, or that
 * change how the account authenticates. Everything a new account has to be able to
 * do — read a profile, change a name, sign out — stays open, because a user who
 * never confirms their address should still be able to use their account.
 */
export const RequireVerifiedEmail = () => SetMetadata(EMAIL_VERIFIED_KEY, true);
