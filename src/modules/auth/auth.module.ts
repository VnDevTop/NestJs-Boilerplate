import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  EmailVerificationToken,
  PasswordResetToken,
  RefreshToken,
  TwoFactorSecret,
  UserDevice,
} from './entities/index.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { DeviceService } from './device.service.js';
import { TwoFactorService } from './two-factor.service.js';
import { JwtStrategy } from './strategies/index.js';
import { ConfigService } from '@nestjs/config';
import {
  passwordPolicyConfig,
  type PasswordPolicyConfig,
} from '../../configs/password-policy.config.js';
import { jwtAccessTokenConfig, throttlerConfig } from '../../configs/index.js';
import { MailModule } from '../mail/index.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { QueueModule } from '../queue/index.js';
import { NotificationEventsModule } from '../notification/notification-events.module.js';
import {
  BREACH_CHECKER,
  type BreachChecker,
  PasswordPolicyService,
} from './password-policy.service.js';
import { PasswordBreachService } from './password-breach.service.js';

@Module({
  imports: [
    PassportModule,
    // ThrottleByEmailGuard needs the throttler options and storage, and
    // ThrottlerModule is not global. Declaring it here rather than relying on
    // app.module means AuthModule resolves on its own, so a test that builds it
    // without the whole application still works. The same config provider is
    // used, so THROTTLE_TTL and THROTTLE_LIMIT apply here as well.
    ThrottlerModule.forRootAsync(throttlerConfig.asProvider()),
    // Mail is an export of MailModule, so the template names and the transport
    // live in the mail module rather than in auth.
    MailModule,
    // For the queue: auth enqueues mail instead of sending it, which is what
    // keeps a slow provider out of the registration request.
    QueueModule,
    // For the operator alerts: a registration, a lockout, a new device and a
    // two-factor change all raise one. Above the queue, like the mail enqueue, so
    // nothing here depends on a channel being reachable.
    NotificationEventsModule,
    // The policy is defined next to the endpoints that enforce it, which is what
    // the config's own docblock has claimed since Phase 13 and what was not true
    // until now: the namespace existed and nothing read it.
    ConfigModule.forFeature(passwordPolicyConfig),
    // For the breach lookup, which is the one network call the policy can make.
    // Only here so that an application which never sets
    // `PASSWORD_CHECK_BREACH_LIST` has no HTTP client in its graph for it.
    HttpModule,
    TypeOrmModule.forFeature([
      RefreshToken,
      UserDevice,
      TwoFactorSecret,
      PasswordResetToken,
      EmailVerificationToken,
    ]),
    JwtModule.registerAsync(jwtAccessTokenConfig.asProvider()),
  ],
  controllers: [AuthController],
  providers: [
    LoginLockoutService,
    PasswordPolicyService,
    PasswordBreachService,
    {
      // Present only when the deployment asked for the check. A `null` provider is
      // the same shape `loadOptional` returns, so the policy service reads one
      // thing rather than branching on whether the feature is configured.
      provide: BREACH_CHECKER,
      inject: [ConfigService, PasswordBreachService],
      useFactory: (
        configService: ConfigService,
        breach: PasswordBreachService,
      ): BreachChecker | null => {
        const enabled =
          configService.getOrThrow<PasswordPolicyConfig>(
            'passwordPolicy',
          ).checkBreachList;

        if (enabled) {
          return breach;
        }

        return null;
      },
    },
    AuthService,
    RefreshTokenService,
    PasswordResetService,
    EmailVerificationService,
    DeviceService,
    TwoFactorService,
    JwtStrategy,
  ],
  exports: [AuthService, RefreshTokenService, DeviceService, TwoFactorService],
})
export class AuthModule {}
