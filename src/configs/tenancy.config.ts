import { registerAs } from '@nestjs/config';

import {
  DEFAULT_TENANT_HEADER,
  DEFAULT_TENANT_ID,
} from '../common/tenancy/tenant.constants.js';

export interface TenancyConfig {
  /**
   * Whether the tenant is resolved from the request.
   *
   * **Off by default, and the column is there anyway.** The tenant column is on
   * every table from the start, so the schema does not change when the first
   * customer arrives — which is the whole point of adding it early. Turning the
   * feature on changes which tenant the requests resolve to, not the shape of
   * the database.
   */
  enabled: boolean;

  /**
   * The header the tenant is read from.
   *
   * **The header rather than the host, by default.** A header is explicit and
   * the deployment decides it; a host is implicit, and a host is also whatever
   * somebody typed into a browser. The host is still supported — a deployment
   * that serves one tenant per domain needs it — but it is a choice rather than
   * the default.
   */
  header: string;

  /**
   * The domain the deployment serves itself on.
   *
   * **Needed to read a tenant out of a host, and unset means the host is not
   * a source.** `acme.example.com` is the tenant `acme` and `example.com` is
   * the deployment — and nothing in the two tells them apart except knowing
   * what the deployment's own domain is. A deployment that does not say is a
   * deployment whose host names nothing, so a request has to use the header.
   */
  baseDomain?: string;

  /**
   * The tenant every row belongs to while the feature is off.
   *
   * Overridable, so a deployment can point its rows at a tenant that already
   * exists rather than at a placeholder.
   */
  defaultTenantId: string;
}

export const tenancyConfig = registerAs('tenancy', (): TenancyConfig => ({
  enabled: process.env.MULTI_TENANT === 'true',
  header: process.env.TENANT_HEADER ?? DEFAULT_TENANT_HEADER,
  baseDomain: process.env.TENANT_BASE_DOMAIN,
  defaultTenantId: process.env.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
}));
