import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ServiceTokenScope,
  ServiceTokenSubject,
  createServiceToken,
  verifyServiceToken,
  SERVICE_TOKEN_MAX_AGE,
  SERVICE_TOKEN_CLOCK_SKEW,
} from './service-token.enum';

@Injectable()
export class ServiceTokenService {
  private readonly logger = new Logger(ServiceTokenService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Generates a service token for the given subject and scopes.
   *
   * @param subject The subject the token acts upon
   * @param scopes The scopes the token is granted
   * @param expiresIn How long until the token expires (defaults to 24h)
   * @returns The generated service token with metadata
   */
  generateToken(
    subject: ServiceTokenSubject,
    scopes: ReadonlySet<ServiceTokenScope>,
    expiresIn?: number,
  ): { token: string; expiresAt: Date; iat: number } {
    const token = createServiceToken(subject, scopes, expiresIn);
    const iat = Math.floor(Date.now() / 1000);
    const expiresAt = new Date(
      (iat + Math.floor((expiresIn ?? SERVICE_TOKEN_MAX_AGE) / 1000)) * 1000,
    );

    this.logger.log(
      `Generated service token for subject=${subject}, scopes=${Array.from(scopes).join(',')}`,
    );

    return { token, expiresAt, iat };
  }

  /**
   * Verifies a service token and returns the decoded payload.
   *
   * @param token The service token to verify
   * @returns The verification result
   */
  verifyToken(token: string): {
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
    return verifyServiceToken(token);
  }

  /**
   * Checks if a token has the given scope.
   *
   * @param token The service token to check
   * @param scope The scope to check for
   * @returns Whether the token has the specified scope
   */
  hasScope(token: string, scope: ServiceTokenScope): boolean {
    const result = this.verifyToken(token);

    if (!result.valid || !result.payload) {
      return false;
    }

    const tokenScopes =
      result.payload.scopes instanceof Set
        ? result.payload.scopes
        : new Set(Array.from(result.payload.scopes));

    return tokenScopes.has(scope);
  }

  /**
   * Checks if a token has any of the given scopes.
   *
   * @param token The service token to check
   * @param scopes The scopes to check for
   * @returns Whether the token has any of the specified scopes
   */
  hasAnyScope(
    token: string,
    requiredScopes: ReadonlySet<ServiceTokenScope>,
  ): boolean {
    const result = this.verifyToken(token);

    if (!result.valid || !result.payload) {
      return false;
    }

    const tokenScopes =
      result.payload.scopes instanceof Set
        ? result.payload.scopes
        : new Set(Array.from(result.payload.scopes));

    const requiredScopeSet =
      requiredScopes instanceof Set
        ? requiredScopes
        : new Set([requiredScopes] as ServiceTokenScope);

    return Array.from(tokenScopes).some((s) =>
      requiredScopeSet.has(s as ServiceTokenScope),
    );
  }

  /**
   * Revokes a service token by adding it to a revocation list.
   *
   * In a production implementation, this would use Redis or a database to track
   * revoked tokens. For now, we log the revocation.
   *
   * @param token The service token to revoke
   */
  revokeToken(token: string): void {
    this.logger.log(`Revoking service token`);
    // In a real implementation, store the token ID in Redis with a TTL
  }
}
