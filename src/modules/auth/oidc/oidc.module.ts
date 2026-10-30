import { Module } from '@nestjs/common';
import { OidcProviderRegistry } from './oidc-provider.registry.js';
import { OidcProviderFactory } from './oidc-provider.factory.js';

@Module({
  providers: [OidcProviderRegistry, OidcProviderFactory],
  exports: [OidcProviderRegistry, OidcProviderFactory],
})
export class OidcModule {}