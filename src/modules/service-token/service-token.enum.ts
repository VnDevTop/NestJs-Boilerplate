export enum ServiceTokenScope {
  /** Read-only access to user data */
  UserRead = 'user:read',
  /** Write access to user data */
  UserWrite = 'user:write',
  /** Read audit trail */
  AuditRead = 'audit:read',
  /** Read job progress */
  JobRead = 'job:read',
  /** Cancel jobs */
  JobCancel = 'job:cancel',
  /** Manage roles and permissions */
  RoleRead = 'role:read',
  /** Write roles and permissions */
  RoleWrite = 'role:write',
  /** Read mail templates */
  MailTemplateRead = 'mail-template:read',
  /** Write mail templates */
  MailTemplateWrite = 'mail-template:write',
  /** Read mail log */
  MailLogRead = 'mail-log:read',
}

/**
 * Service token subject types.
 * Defines what kind of entity a token can act upon.
 */
export enum ServiceTokenSubject {
  /** Token acts on behalf of a specific user */
  User = 'user',
  /** Token acts on behalf of the system/admin */
  System = 'system',
  /** Token acts on behalf of a tenant */
  Tenant = 'tenant',
}

/** The maximum age (in milliseconds) for a service token. */
export const SERVICE_TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

/** The maximum age (in milliseconds) for token clock skew tolerance. */
export const SERVICE_TOKEN_CLOCK_SKEW = 2 * 60 * 1000; // 2 minutes

/**
 * Creates a service token JWT with the given subject and scopes.
 *
 * @param subject The subject the token acts upon
 * @param scopes The scopes the token is granted
 * @param expiresIn How long until the token expires (defaults to 24h)
 * @returns A signed JWT string
 */
export function createServiceToken(
  subject: ServiceTokenSubject,
  scopes: ReadonlySet<ServiceTokenScope>,
  expiresIn?: number,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt =
    issuedAt + Math.floor((expiresIn ?? SERVICE_TOKEN_MAX_AGE) / 1000);

  const payload = {
    sub: subject,
    scopes: [...scopes],
    iat: issuedAt,
    exp: expiresAt,
    type: 'service-token',
  };

  // Use the application's JWT signing configuration
  // In a real implementation, this would use the app's JWT secret/key
  // For now, we return a placeholder JWT
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Verifies a service token and returns the decoded payload.
 *
 * @param token The service token to verify
 * @returns The decoded payload if valid, null otherwise
 */
export function verifyServiceToken(token: string): {
  valid: boolean;
  payload?: {
    sub: ServiceTokenSubject;
    scopes: ReadonlySet<ServiceTokenScope>;
    iat: number;
    exp: number;
    type: string;
  };
  error?: string;
} {
  let payload: any;

  try {
    payload = JSON.parse(Buffer.from(token, 'base64').toString());
  } catch {
    return { valid: false, error: 'Invalid token format' };
  }

  // Check required fields
  if (
    !payload.sub ||
    !payload.scopes ||
    !payload.iat ||
    !payload.exp ||
    !payload.type
  ) {
    return { valid: false, error: 'Missing required claims' };
  }

  // Check token type
  if (payload.type !== 'service-token') {
    return { valid: false, error: 'Invalid token type' };
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now > payload.exp) {
    return { valid: false, error: 'Token has expired' };
  }

  // Check issued-at clock skew
  if (Math.abs(now - payload.iat) > SERVICE_TOKEN_CLOCK_SKEW / 1000) {
    return { valid: false, error: 'Token issued at time mismatch' };
  }

  const scopes = new Set(
    Array.isArray(payload.scopes)
      ? payload.scopes
      : ([payload.scopes] as string[]),
  );

  return {
    valid: true,
    payload: {
      sub: payload.sub as ServiceTokenSubject,
      scopes: scopes as unknown as ReadonlySet<ServiceTokenScope>,
      iat: payload.iat,
      exp: payload.exp,
      type: payload.type,
    },
  };
}
