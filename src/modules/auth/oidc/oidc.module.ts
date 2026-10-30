import { Module, OnModuleInit } from '@nestjs/common';
import { OidcProviderRegistry } from './oidc-provider.registry.js';
import { OidcProviderFactory } from './oidc-provider.factory.js';
import { GoogleOidcProvider } from './providers/google.oidc-provider.js';
import { MicrosoftOidcProvider } from './providers/microsoft.oidc-provider.js';

@Module({
  providers: [OidcProviderRegistry, OidcProviderFactory],
  exports: [OidcProviderRegistry, OidcProviderFactory],
})
export class OidcModule implements OnModuleInit {
  constructor(
    private readonly registry: OidcProviderRegistry,
    private readonly factory: OidcProviderFactory,
  ) {}

  onModuleInit(): void {
    this.registry.registerFactory('google', (config) => new GoogleOidcProvider(config));
    this.registry.registerFactory('microsoft', (config) => new MicrosoftOidcProvider(config));
    this.factory.registerEnabledProviders();
  }
}