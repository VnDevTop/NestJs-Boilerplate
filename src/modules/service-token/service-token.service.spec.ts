import { ServiceTokenService } from './service-token.service';
import { ServiceTokenScope, ServiceTokenSubject } from './service-token.enum';

describe('ServiceTokenService', () => {
  let service: ServiceTokenService;

  beforeEach(() => {
    service = new ServiceTokenService({
      getOrThrow: () => SERVICE_TOKEN_MAX_AGE,
    } as any);
  });

  describe('generateToken', () => {
    it('generates a valid service token', () => {
      const scopes = new Set([
        ServiceTokenScope.UserRead,
        ServiceTokenScope.JobRead,
      ]);
      const { token, expiresAt, iat } = service.generateToken(
        ServiceTokenSubject.User,
        scopes,
        3600000, // 1 hour
      );

      expect(token).toBeDefined();
      expect(token.length > 0).toBe(true);
      expect(expiresAt).toBeInstanceOf(Date);
      expect(iat).toBeDefined();
      expect(iat).toBeLessThanOrEqual(Date.now() / 1000);
    });

    it('generates a token with default expiry (24h)', () => {
      const scopes = new Set([ServiceTokenScope.UserRead]);
      const { token, expiresAt, iat } = service.generateToken(
        ServiceTokenSubject.User,
        scopes,
      );

      expect(token).toBeDefined();
      expect(token.length > 0).toBe(true);
      expect(expiresAt).toBeInstanceOf(Date);
      // Default should be ~24 hours
      const maxAge = expiresAt.getTime() - iat! * 1000;
      expect(maxAge).toBeGreaterThan(86400000 * 0.9); // at least 90% of 24h
      expect(maxAge).toBeLessThan(86400000 * 1.1); // at most 110% of 24h
    });
  });

  describe('verifyToken', () => {
    it('verifies a valid token', () => {
      const scopes = new Set([ServiceTokenScope.UserRead]);
      const { token } = service.generateToken(
        ServiceTokenSubject.System,
        scopes,
      );

      const result = service.verifyToken(token);

      expect(result.valid).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.payload?.sub).toBe(ServiceTokenSubject.System);
      expect(result.payload?.scopes).toEqual(scopes);
    });

    it('rejects an invalid token format', () => {
      const result = service.verifyToken('not-a-valid-token');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects an expired token', () => {
      // Create a token that expired long ago
      const expiredToken = Buffer.from(
        JSON.stringify({
          sub: ServiceTokenSubject.User,
          scopes: [ServiceTokenScope.UserRead],
          iat: 1, // issued long ago
          exp: 2, // expired long ago
          type: 'service-token',
        }),
      ).toString('base64');

      const result = service.verifyToken(expiredToken);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('rejects a token with wrong type', () => {
      const fakeToken = Buffer.from(
        JSON.stringify({
          sub: ServiceTokenSubject.User,
          scopes: [ServiceTokenScope.UserRead],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          type: 'wrong-type',
        }),
      ).toString('base64');

      const result = service.verifyToken(fakeToken);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid token type');
    });
  });

  describe('hasScope', () => {
    it('returns true for a token with the specified scope', () => {
      const scopes = new Set([
        ServiceTokenScope.UserRead,
        ServiceTokenScope.JobRead,
      ]);
      const { token } = service.generateToken(ServiceTokenSubject.User, scopes);

      expect(service.hasScope(token, ServiceTokenScope.UserRead)).toBe(true);
      expect(service.hasScope(token, ServiceTokenScope.JobRead)).toBe(true);
      expect(service.hasScope(token, ServiceTokenScope.AuditRead)).toBe(false);
    });

    it('returns false for an invalid token', () => {
      const result = service.hasScope(
        'invalid-token',
        ServiceTokenScope.UserRead,
      );

      expect(result).toBe(false);
    });
  });

  describe('hasAnyScope', () => {
    it('returns true if the token has any of the specified scopes', () => {
      const scopes = new Set([ServiceTokenScope.UserRead]);
      const { token } = service.generateToken(ServiceTokenSubject.User, scopes);

      expect(service.hasAnyScope(token, ServiceTokenScope.UserRead)).toBe(true);
      expect(service.hasAnyScope(token, ServiceTokenScope.JobRead)).toBe(false);
      expect(
        service.hasAnyScope(
          token,
          new Set([ServiceTokenScope.UserRead, ServiceTokenScope.JobRead]),
        ),
      ).toBe(true);
    });

    it('returns false for an invalid token', () => {
      const result = service.hasAnyScope(
        'invalid-token',
        ServiceTokenScope.UserRead,
      );

      expect(result).toBe(false);
    });
  });

  describe('revokeToken', () => {
    it('logs the revocation', () => {
      // This should not throw
      expect(() => service.revokeToken('any-token')).not.toThrow();
    });
  });
});
