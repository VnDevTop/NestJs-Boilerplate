export enum RefreshTokenRevokedReason {
  Rotated = 'rotated',
  Logout = 'logout',
  LogoutAll = 'logout_all',
  DeviceRevoked = 'device_revoked',
  ReuseDetected = 'reuse_detected',
  Expired = 'expired',
  /** Every session is revoked when a password is reset, including this device's. */
  PasswordChanged = 'password_changed',
  /**
   * The session reached its maximum age.
   *
   * Distinct from `Expired` because it is a different fact: the token's own
   * window had not run out, the *session* had. A client reading the two reasons
   * apart learns something useful — an expired token is an old client, a session
   * that outlived its ceiling is a session somebody kept alive.
   *
   * Deliberately **not** `Rotated`, which is the only reason reuse detection
   * treats as theft. A client that comes back after the ceiling closed is a stale
   * client, not an attacker, and answering a sweep here would let a user lock
   * themselves out by leaving a phone on a train.
   */
  AbsoluteTimeout = 'absolute_timeout',
  /**
   * The caller revoked one session from the session list, leaving the others.
   *
   * Distinct from `Logout` because the two mean different things when somebody
   * reads the record later: `Logout` is this device signing out, this is a person
   * closing one entry in a list. A stored varchar, so adding it needs no
   * migration.
   */
  SessionRevoked = 'session_revoked',
}
