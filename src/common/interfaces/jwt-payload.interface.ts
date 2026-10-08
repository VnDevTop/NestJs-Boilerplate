export interface JwtPayload {
  sub: string;
  email: string;
  role?: string;
  isManager?: boolean;
  /**
   * The user's `sessionsVersion` at the moment this token was minted.
   *
   * Optional because tokens issued before the column existed do not carry it, and
   * `JwtStrategy` reads that absence as "this predates revocation tracking"
   * rather than as a version of zero.
   */
  sv?: number;
  /**
   * The device this token was minted on, and that device's `sessionsVersion` at
   * the time.
   *
   * Both absent together for a token issued before this existed, and
   * `JwtStrategy` reads that absence as "this predates per-device revocation"
   * rather than as a device of none. Reading them as zero would sign every
   * signed-in user out on deploy.
   *
   * `did` alone is what makes the check optional rather than the version: a token
   * that names no device has nothing to compare, and that is the pre-existing
   * case. A token that names a device and no version is a token minted from a
   * database where the column is not there yet, and is compared against zero,
   * which is the same rule `sv` follows.
   */
  did?: string;
  /** This device's `sessionsVersion` when the token was minted. */
  dv?: number;
  iat?: number;
  exp?: number;
}
