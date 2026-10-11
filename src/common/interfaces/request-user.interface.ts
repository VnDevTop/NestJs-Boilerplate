export interface RequestUser {
  id: string;
  email: string;
  role?: string;
  isManager: boolean;
  isActive: boolean;
  /**
   * The names this user's role holds, resolved once by the strategy.
   *
   * Always an array, never undefined, so `PermissionsGuard` cannot be tricked by
   * a token minted before the claim existed into looking like a user with no
   * permissions and into being refused by a route it should pass.
   */
  permissions: string[];
  /**
   * Whether this user's address is confirmed.
   *
   * Carried on the request user rather than looked up by the guard, for the same
   * reason the role is: a guard that reads the database turns an authorization
   * check into a query on every request, which is the cost Phase 17b exists to
   * remove.
   *
   * Unlike every other field here, this one is read from the *database* rather than
   * from the token, and that is deliberate. Putting it in the token would make an
   * unverified user stay unverified for the life of the token — up to fifteen
   * minutes after confirming — which is long enough that a gate built on it reads
   * as broken. The column is already in the cached claims, so reading it costs
   * nothing extra and takes effect on the next request.
   */
  isEmailVerified: boolean;
}
