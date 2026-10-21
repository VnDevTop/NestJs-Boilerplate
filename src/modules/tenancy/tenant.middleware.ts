import {
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

import type { TenancyConfig } from '../../configs/tenancy.config.js';
import {
  TenantRegistry,
  type TenantContextValue,
} from './tenant-registry.service.js';

/** A request that carries the tenant it was resolved to. */
export interface RequestWithTenant extends Request {
  tenant?: TenantContextValue;
}

/**
 * Which tenant a request is for.
 *
 * **The header first, then the host.** A header is explicit — a gateway or a
 * client sets it, and it says what it means. A host is implicit, and it is
 * also whatever somebody typed into a browser, so it is the second choice and
 * only when the deployment has asked for it.
 *
 * **The host's first label is the tenant**, so `acme.example.com` is the
 * tenant `acme`. A host with no such label is no tenant, and a request with
 * no tenant is a 401.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);

  constructor(
    private readonly registry: TenantRegistry,
    private readonly configService: ConfigService,
  ) {}

  async use(
    request: RequestWithTenant,
    _response: Response,
    next: NextFunction,
  ): Promise<void> {
    const config = this.configService.getOrThrow<TenancyConfig>('tenancy');

    if (!config.enabled) {
      // The feature is off, so every request is the default tenant. The column
      // is on every table whatever the feature says, and this is the value it
      // carries.
      request.tenant = this.registry.defaultTenant();

      return next();
    }

    const slug = this.slugFrom(request, config);

    if (slug === null) {
      throw new UnauthorizedException(
        'This request names no tenant. Send the tenant header, or use a host ' +
          'that names one.',
      );
    }

    const tenant = await this.registry.findBySlug(slug);

    if (tenant === null) {
      // Not a default and not an error page: a 401, because the request asked
      // for data that does not exist and answering it with this deployment's
      // rows would be worse than refusing it.
      this.logger.warn(`Refusing a request for the unknown tenant "${slug}"`);

      throw new UnauthorizedException(`There is no tenant called "${slug}".`);
    }

    if (!this.registry.isServing(tenant)) {
      this.logger.warn(`Refusing a request for the disabled tenant "${slug}"`);

      throw new UnauthorizedException(
        `The tenant "${slug}" is not being served.`,
      );
    }

    request.tenant = tenant;

    return next();
  }

  /** The tenant a request names, or null. */
  private slugFrom(
    request: RequestWithTenant,
    config: TenancyConfig,
  ): string | null {
    const header = request.header(config.header);

    if (header !== undefined && header.trim() !== '') {
      return header.trim();
    }

    const baseDomain = config.baseDomain;

    if (baseDomain === undefined || baseDomain === '') {
      // Without the deployment's own domain there is nothing to tell a
      // deployment's host from a tenant's, and guessing would read
      // `example.com` as the tenant `example`.
      return null;
    }

    const host = request.hostname;

    if (!host.endsWith(baseDomain)) {
      return null;
    }

    // What is in front of the deployment's own domain is the tenant: the
    // first label of it, so a nested subdomain still names the same tenant.
    const inFront = host
      .slice(0, host.length - baseDomain.length)
      .replace(/\.$/, '');

    if (inFront === '') {
      // The deployment's own host, with nothing in front of it.
      return null;
    }

    return inFront.split('.')[0] ?? null;
  }
}
