import type { OidcProfile } from './oidc-profile.interface.js';
import type { OidcProviderConfig } from '../../../config/oidc.config.js';

export interface OidcProvider {
  readonly name: string;
  isEnabled(): boolean;
  getAuthorizationUrl(state: string, nonce: string, redirectUri: string): Promise<string>;
  handleCallback(params: {
    code: string;
    state?: string;
    redirectUri: string;
  }): Promise<OidcProfile>;
}

export interface OidcProviderFactory {
  readonly providerName: string;
  create(config: OidcProviderConfig): OidcProvider;
}