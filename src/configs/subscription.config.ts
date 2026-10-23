import { registerAs } from '@nestjs/config';

/**
 * The name of a subscription endpoint.
 */
export type SubscriptionEndpointName = string;

/**
 * One configured subscription endpoint.
 *
 * `events` lists the event keys the endpoint wants to receive.
 * `secret` is an HMAC secret shared with the caller so the receiver can
 * verify the signature of the payload.  Rotation is supported: the previous
 * secret is kept for a short window so a deploy does not break verification
 * halfway through.
 */
export interface SubscriptionEndpoint {
  /** URL that receives POST requests with event payloads. */
  url: string;
  /** Event keys this endpoint is interested in. */
  events: string[];
  /** HMAC secret used to sign the payload. */
  secret: string;
  /** Previous secret, kept for the rotation window. */
  previousSecret?: string;
  /** Enabled flag – when false no deliveries are attempted. */
  enabled: boolean;
}

/** Configuration for all subscription endpoints. */
export interface SubscriptionConfig {
  /** Master switch. When false every endpoint is skipped. */
  enabled: boolean;
  /** Per‑endpoint switches, checked alongside the master switch. */
  endpoints: Record<SubscriptionEndpointName, SubscriptionEndpoint>;
}

/** Master switch – when false no endpoint receives anything. */
const flag = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === 'true';

/**
 * Raw config comes as comma‑separated `key=value` pairs.
 * `parseEndpoints` turns `ENDPOINT_NAME=url,events,secret` into the
 * structured `SubscriptionEndpoint`.
 */
function parseEndpoint(raw: string): SubscriptionEndpoint | undefined {
  const parts = raw.split(',');
  if (parts.length < 3) {
    return undefined;
  }
  const [url, eventsStr, secret] = parts.slice(0, 3);
  if (!url || !secret) {
    return undefined;
  }
  const events = eventsStr
    .split('|')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  return {
    url,
    events,
    secret,
    previousSecret: undefined,
    enabled: true,
  };
}

/** Turns `ENDPOINT1=url,events,secret,prevSecret,enabled` etc into a record. */
function parseEndpoints(
  raw: string,
): Record<SubscriptionEndpointName, SubscriptionEndpoint> {
  const endpoints: Record<SubscriptionEndpointName, SubscriptionEndpoint> = {};
  if (!raw || raw.trim() === '') {
    return endpoints;
  }
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const ep = parseEndpoint(value);
    if (ep) {
      endpoints[name] = ep;
    }
  }
  return endpoints;
}

export const subscriptionConfig = registerAs(
  'subscription',
  (): SubscriptionConfig => ({
    enabled: flag(process.env.SUBSCRIPTION_ENABLED),
    endpoints: parseEndpoints(process.env.SUBSCRIPTION_ENDPOINTS ?? ''),
  }),
);
