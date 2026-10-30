import { Injectable } from '@nestjs/common';
import type { OidcProvider } from './oidc-provider.interface.js';

@Injectable()
export class OidcProviderRegistry {
  private readonly providers = new Map<string, OidcProvider>();
  private readonly factories = new Map<string, (config: any) => OidcProvider>();

  registerFactory(name: string, factory: (config: any) => OidcProvider): void {
    this.factories.set(name, factory);
  }

  register(provider: OidcProvider): void {
    if (provider.isEnabled()) {
      this.providers.set(provider.name, provider);
    }
  }

  get(name: string): OidcProvider | undefined {
    return this.providers.get(name);
  }

  getEnabled(): OidcProvider[] {
    return [...this.providers.values()];
  }

  hasFactory(name: string): boolean {
    return this.factories.has(name);
  }

  create(name: string, config: any): OidcProvider | undefined {
    const factory = this.factories.get(name);
    return factory ? factory(config) : undefined;
  }
}