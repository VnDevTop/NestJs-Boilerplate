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
   * The caller revoked one session from the session list, leaving the others.
   *
   * Distinct from `Logout` because the two mean different things when somebody
   * reads the record later: `Logout` is this device signing out, this is a person
   * closing one entry in a list. A stored varchar, so adding it needs no
   * migration.
   */
  SessionRevoked = 'session_revoked',
}
