import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretPost,
  discovery,
  fetchUserInfo,
  skipSubjectCheck,
} from 'openid-client';
import type { Configuration } from 'openid-client';
import type { OidcProvider } from '../oidc-provider.interface.js';
import type { OidcProfile } from '../oidc-profile.interface.js';
import type { OidcProviderConfig } from '../../../../config/oidc.config.js';

export class GoogleOidcProvider implements OidcProvider {
  readonly name = 'google';
  private configurationPromise?: Promise<Configuration>;

  constructor(private readonly config: OidcProviderConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private async getConfiguration(): Promise<Configuration> {
    if (!this.configurationPromise) {
      const issuer = this.config.issuer ?? 'https://accounts.google.com';
      this.configurationPromise = discovery(
        new URL(issuer),
        this.config.clientId!,
        this.config.clientSecret!,
        ClientSecretPost(this.config.clientSecret),
      );
    }
    return this.configurationPromise;
  }

  async getAuthorizationUrl(state: string, nonce: string, redirectUri: string): Promise<string> {
    const configuration = await this.getConfiguration();
    const url = buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri || this.config.redirectUri || '',
      scope: this.config.scopes.join(' '),
      state,
      nonce,
      response_type: 'code',
    });
    return url.href;
  }

  async handleCallback(params: {
    code: string;
    state?: string;
    redirectUri: string;
  }): Promise<OidcProfile> {
    const configuration = await this.getConfiguration();
    const currentUrl = new URL(params.redirectUri || this.config.redirectUri!);
    currentUrl.searchParams.set('code', params.code);
    if (params.state) {
      currentUrl.searchParams.set('state', params.state);
    }

    const tokens = await authorizationCodeGrant(configuration, currentUrl, {
      expectedState: params.state,
    });

    const claims = tokens.claims();
    const userInfo = await fetchUserInfo(
      configuration,
      tokens.access_token!,
      claims?.sub ?? skipSubjectCheck,
    );

    return {
      provider: this.name,
      subject: String(claims?.sub ?? userInfo.sub),
      email: userInfo.email ? String(userInfo.email) : undefined,
      name: userInfo.name ? String(userInfo.name) : undefined,
      raw: userInfo as Record<string, unknown>,
    };
  }
}