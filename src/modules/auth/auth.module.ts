import { Module } from '@nestjs/common';
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
import { jwtAccessTokenConfig, throttlerConfig } from '../../configs/index.js';
import { MailModule } from '../mail/index.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { QueueModule } from '../queue/index.js';

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
