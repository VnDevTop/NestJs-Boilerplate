import type { OidcProvider } from '../oidc-provider.interface.js';
import type { OidcProfile } from '../oidc-profile.interface.js';
import type { OidcProviderConfig } from '../../../../config/oidc.config.js';

export class GitHubOidcProvider implements OidcProvider {
  readonly name = 'github';

  constructor(private readonly config: OidcProviderConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async getAuthorizationUrl(state: string, _nonce: string, redirectUri: string): Promise<string> {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.config.clientId!);
    url.searchParams.set('redirect_uri', redirectUri || this.config.redirectUri || '');
    url.searchParams.set('scope', this.config.scopes.join(' '));
    url.searchParams.set('state', state);
    return url.href;
  }

  async handleCallback(params: {
    code: string;
    state?: string;
    redirectUri: string;
  }): Promise<OidcProfile> {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri || this.config.redirectUri,
        state: params.state,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error('GitHub token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      throw new Error('GitHub access token missing');
    }

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!userResponse.ok) {
      throw new Error('GitHub user fetch failed');
    }

    const user = (await userResponse.json()) as {
      id: number;
      login: string;
      name?: string;
      email?: string;
    };

    let email = user.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (emailsResponse.ok) {
        const emails = (await emailsResponse.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        email = emails.find((item) => item.primary && item.verified)?.email ?? emails[0]?.email;
      }
    }

    return {
      provider: this.name,
      subject: String(user.id),
      email,
      name: user.name ?? user.login,
      raw: user as Record<string, unknown>,
    };
  }
}