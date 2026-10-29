import { registerAs } from '@nestjs/config';
import type { ObserveOptions } from '@nestjs/observe';

export const observeConfig = registerAs('observe', (): ObserveOptions => ({
  appKey: process.env.OBSERVE_APP_KEY,
  appSecret: process.env.OBSERVE_APP_SECRET,
  serviceId: process.env.OBSERVE_SERVICE_ID ?? '',
}));