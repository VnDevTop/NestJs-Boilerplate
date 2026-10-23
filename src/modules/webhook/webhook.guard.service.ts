import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class WebhookGuardService {
  private readonly logger = new Logger(WebhookGuardService.name);

  /**
   * Parse the raw body from the request.
   * Must be used with body-parser that preserves the raw body,
   * e.g. @nestjs/platform-express's raw body middleware.
   */
  getRawBody(request: Request): Buffer {
    // In a real implementation, this would extract the raw body
    // that was stored by the NestJS body parser configuration.
    // For now, return the body as-is.
    return request.body instanceof Buffer
      ? request.body
      : Buffer.from(String(request.body));
  }

  /**
   * Verify an HMAC-SHA256 signature over a payload.
   *
   * Expected format: t=<timestamp>,v1=<hmac-sha256>
   * Also supports format: v1=<hmac-sha256> (without timestamp for simple cases)
   *
   * @param rawBody The raw request body buffer
   * @param signatureHeader The X-Signature header value
   * @param secret The shared secret for HMAC verification
   * @returns {object} Verification result with status and details
   */
  verifySignature(
    rawBody: Buffer,
    signatureHeader: string,
    secret: string,
  ): { valid: boolean; timestamp?: number; error?: string } {
    if (!signatureHeader) {
      return { valid: false, error: 'Missing X-Signature header' };
    }

    // Parse the signature header
    // Format: t=<timestamp>,v1=<hmac-sha256>
    const parts = signatureHeader.split(',');
    if (parts.length < 1 || !parts[0].startsWith('v1=')) {
      return {
        valid: false,
        error: 'Invalid signature format, expected v1=<hmac-sha256>',
      };
    }

    const signature = parts[1].trim().replace('v1=', '');
    if (!signature) {
      return { valid: false, error: 'Missing signature value' };
    }

    // Check for timestamp (replay protection)
    let timestamp: number | undefined;
    if (parts.length >= 2 && parts[0].startsWith('t=')) {
      timestamp = parseInt(parts[0].slice(2), 10);
      if (isNaN(timestamp)) {
        return { valid: false, error: 'Invalid timestamp format' };
      }
    }

    // Constant-time comparison to prevent timing attacks
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    const match = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex'),
    );

    const valid = match;

    if (!valid) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Replay protection: check timestamp freshness
    if (timestamp !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      const age = now - timestamp;

      // Reject if older than 10 minutes (configurable)
      const maxAge = 600_000; // 10 minutes
      if (age > maxAge) {
        return { valid: false, error: `Payload too old: age=${age}s` };
      }

      // Allow clock skew
      const clockSkew = 120_000; // 2 minutes
      if (Math.abs(age) > clockSkew) {
        return { valid: false, error: `Clock skew too large: age=${age}s` };
      }
    }

    return { valid: true, timestamp };
  }

  /**
   * Deduplicate webhook events by checking the provider's event ID.
   * A repeat event should be acknowledged and dropped.
   *
   * @param eventId The provider's event ID
   * @returns {object} Deduplication result
   */
  checkDeduplication(_eventId: string): {
    alreadyProcessed: boolean;
    action: 'acknowledge' | 'process';
  } {
    // In a real implementation, this would check a Redis store or database
    // for previously seen event IDs.
    // For now, we simulate deduplication with a simple cache.

    // This is a placeholder - real implementation would use:
    // - Redis SET to store processed event IDs with TTL
    // - OR a database table with event ID and received timestamp
    // - OR a message queue deduplication feature

    const alreadyProcessed = false; // Placeholder
    const action: 'acknowledge' | 'process' = alreadyProcessed
      ? 'acknowledge'
      : 'process';

    return { alreadyProcessed, action };
  }
}
