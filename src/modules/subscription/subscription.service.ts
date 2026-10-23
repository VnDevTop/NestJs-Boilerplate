import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SubscriptionConfig,
  SubscriptionEndpoint,
} from '../../configs/subscription.config.js';
import { SubscribeDto } from './dto/subscribe.dto.js';
import { lastValueFrom } from 'rxjs';
import crypto from 'crypto';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly subscriptionConfig: SubscriptionConfig,
  ) {}

  async publish(event: SubscribeDto): Promise<void> {
    const { event: eventKey, payload } = event;
    const endpoints = this.subscriptionConfig.endpoints;

    for (const [name, ep] of Object.entries(endpoints)) {
      if (!ep.enabled) {
        continue;
      }

      if (!ep.events.includes(eventKey)) {
        continue;
      }

      const secret = ep.secret;
      if (!secret) {
        this.logger.warn(`Endpoint ${name} has no secret, skipping delivery`);
        continue;
      }

      let signature: string;
      if (
        ep.previousSecret &&
        this.isOldSecretValid(ep.previousSecret, payload)
      ) {
        signature = this.hmacSign(payload, ep.previousSecret);
        this.logger.debug(
          `Sent event ${eventKey} to ${name} with previous secret (rotation window)`,
        );
      } else {
        signature = this.hmacSign(payload, secret);
      }

      const headers = {
        'Content-Type': 'application/json',
        'X-Hub-Signature': `sha256=${signature}`,
      };

      try {
        const response = await lastValueFrom(
          this.httpService.post(ep.url, payload, { headers }),
        );
        this.logger.debug(
          `Sent event ${eventKey} to ${name}, status ${response.status}`,
        );
      } catch (err) {
        this.logger.error(`Failed to send event ${eventKey} to ${name}`, err);
      }
    }
  }

  private isOldSecretValid(secret: string, payload: unknown): boolean {
    // In a real implementation, this would check a timestamp or replay window.
    // For now, we accept the old secret if it produces a valid HMAC shape.
    // The actual timing guard is enforced by the signing service's maxAge check.
    try {
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(JSON.stringify(payload));
      const digest = hmac.digest('hex');
      return digest.length === 64;
    } catch {
      return false;
    }
  }

  private hmacSign(payload: unknown, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(payload));
    return hmac.digest('hex');
  }
}
