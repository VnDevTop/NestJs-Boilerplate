import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OidcConfig } from '../../../config/oidc.config.js';
import { OidcProviderRegistry } from './oidc-provider.registry.js';

@Injectable()
export class OidcProviderFactory {
  constructor(
    private readonly registry: OidcProviderRegistry,
    private readonly configService: ConfigService,
  ) {}

  registerEnabledProviders(): void {
    const config = this.configService.get<OidcConfig>('oidc');
    if (!config) {
      return;
    }

    for (const providerConfig of config.providers) {
      if (!providerConfig.enabled) {
        continue;
      }
      const provider = this.registry.create(providerConfig.name, providerConfig);
      if (provider) {
        this.registry.register(provider);
      }
    }
  }
}