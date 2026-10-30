import { registerAs } from '@nestjs/config';

export interface OidcProviderConfig {
  name: string;
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  redirectUri?: string;
  scopes: string[];
}

export interface OidcConfig {
  providers: OidcProviderConfig[];
}

function providerConfig(name: string, envPrefix: string, defaultScopes: string[]): OidcProviderConfig {
  const clientId = process.env[`${envPrefix}_CLIENT_ID`];
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
  return {
    name,
    enabled: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    issuer: process.env[`${envPrefix}_ISSUER`],
    redirectUri: process.env[`${envPrefix}_REDIRECT_URI`],
    scopes: (process.env[`${envPrefix}_SCOPES`] ?? defaultScopes.join(' ')).split(' ').filter(Boolean),
  };
}

export const oidcConfig = registerAs<OidcConfig>(
  'oidc',
  (): OidcConfig => ({
    providers: [
      providerConfig('google', 'GOOGLE_OIDC', ['openid', 'email', 'profile']),
      providerConfig('microsoft', 'MICROSOFT_OIDC', ['openid', 'email', 'profile']),
      providerConfig('github', 'GITHUB_OIDC', ['read:user', 'user:email']),
      providerConfig('apple', 'APPLE_OIDC', ['openid', 'email', 'name']),
    ],
  }),
);