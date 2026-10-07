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
  iat?: number;
  exp?: number;
}
