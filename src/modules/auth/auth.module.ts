import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { HttpModule } from '@nestjs/axios';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountLockController } from './account-lock.controller.js';
import { AccountLockService } from './account-lock.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  AccountUnlockToken,
  EmailVerificationToken,
  PasswordHistoryEntry,
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
import { accountSecurityConfig } from '../../configs/account-security.config.js';
import { sessionConfig } from '../../configs/session.config.js';
import {
  passwordPolicyConfig,
  type PasswordPolicyConfig,
} from '../../configs/password-policy.config.js';
import { jwtAccessTokenConfig, throttlerConfig } from '../../configs/index.js';
import { MetricsModule } from '../../core/metrics/index.js';
import { MailModule } from '../mail/mail.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { QueueModule } from '../queue/index.js';
import { NotificationEventsModule } from '../notification/notification-events.module.js';
import {
  BREACH_CHECKER,
  type BreachChecker,
  PASSWORD_HISTORY_READER,
  type PasswordHistoryCheck,
  PasswordPolicyService,
} from './password-policy.service.js';
import { PasswordBreachService } from './password-breach.service.js';
import { PasswordHistoryService } from './password-history.service.js';

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
    // `AuthService` records the sign-in attempt counters, which is the only
    // sign-in signal that survives a redis outage. The parameter has a default so
    // a hand-built harness can omit it, and a default does not exempt it from
    // injection — the provider still has to be visible here.
    MetricsModule,
    // For the queue: auth enqueues mail instead of sending it, which is what
    // keeps a slow provider out of the registration request.
    QueueModule,
    // For the operator alerts: a registration, a lockout, a new device and a
    // two-factor change all raise one. Above the queue, like the mail enqueue, so
    // nothing here depends on a channel being reachable.
    NotificationEventsModule,
    // For the audit interceptor `AccountLockController` binds, so the erasure
    // request writes a row. `AuditModule` imports nothing but TypeORM, so this
    // edge is one-directional and cannot close a cycle.
    AuditModule,
    // The policy is defined next to the endpoints that enforce it, which is what
    // the config's own docblock has claimed since Phase 13 and what was not true
    // until now: the namespace existed and nothing read it.
    ConfigModule.forFeature(passwordPolicyConfig),
    // For the permanent lockout. Same reasoning as the policy above: the rule is
    // defined where it is enforced.
    ConfigModule.forFeature(accountSecurityConfig),
    // For the session's maximum age. Same reasoning again, and this one is
    // enforced in exactly one place — the rotation — so there is no argument for
    // putting it anywhere else.
    ConfigModule.forFeature(sessionConfig),
    // Outbound HTTP client for the breach lookup. Config is left to the
    // deployment; the default timeout is axios' own.
    HttpModule,
    TypeOrmModule.forFeature([
      AccountUnlockToken,
      RefreshToken,
      UserDevice,
      TwoFactorSecret,
      PasswordResetToken,
      EmailVerificationToken,
      PasswordHistoryEntry,
    ]),
    JwtModule.registerAsync(jwtAccessTokenConfig.asProvider()),
  ],
  controllers: [AuthController, AccountLockController],
  providers: [
    LoginLockoutService,
    AccountLockService,
    PasswordPolicyService,
    PasswordBreachService,
    PasswordHistoryService,
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
    {
      // The history reader is the same shape as the breach checker: present or
      // absent. Here it is always present — the service answers "no" itself when
      // `PASSWORD_HISTORY_COUNT` is zero — so the policy does not need to know what
      // the count is in order to decide whether to ask.
      provide: PASSWORD_HISTORY_READER,
      inject: [PasswordHistoryService],
      useFactory: (history: PasswordHistoryService): PasswordHistoryCheck =>
        history,
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
