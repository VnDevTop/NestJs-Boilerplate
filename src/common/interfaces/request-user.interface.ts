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
}
