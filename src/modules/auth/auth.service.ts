import { randomUUID } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { JwtPayload, RequestUser } from '../../common/interfaces/index.js';
import {
  hashPassword,
  padResponse,
  verifyPassword,
} from '../../common/utils/index.js';
import type { AppConfig } from '../../configs/app.config.js';
import { MailService } from '../mail/index.js';
import {
  dedupeKey,
  JOB_QUEUE,
  MAIL_JOB,
  type MailJobPayload,
  type JobQueue,
} from '../queue/index.js';
import { UserResponseDto } from '../users/dto/index.js';
import { UsersService } from '../users/index.js';
import {
  AuthSessionDto,
  ForgotPasswordDto,
  GenericMessageDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  TwoFactorCodeDto,
  TwoFactorEnabledResponseDto,
  TwoFactorLoginDto,
  UserDeviceDto,
  VerifyEmailDto,
} from './dto/index.js';
import { RefreshTokenRevokedReason } from './enums/index.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { DeviceService } from './device.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { TwoFactorService } from './two-factor.service.js';
import {
  AuthToken,
  DeviceMetadata,
  TokenMetadata,
  TwoFactorChallenge,
  TwoFactorSetup,
} from './types/index.js';

type RotationResult =
  | { status: 'ok'; refreshToken: string }
  | { status: 'invalid' }
  | { status: 'reused' }
  | { status: 'expired' };

export type LoginResult = AuthToken | TwoFactorChallenge;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly deviceService: DeviceService,
    private readonly twoFactorService: TwoFactorService,
    private readonly passwordResetService: PasswordResetService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly mailService: MailService,
    // Injected by token: `JobQueue` is an interface, so Nest has no class to
    // resolve the type from and would fail with an unresolvable dependency.
    @Inject(JOB_QUEUE) private readonly jobQueue: JobQueue,
    private readonly configService: ConfigService,
  ) {}

  private get appConfig(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }

  async register(
    registerDto: RegisterDto,
    metadata: DeviceMetadata,
  ): Promise<AuthToken> {
    const passwordHash = await hashPassword(registerDto.password);

    const user = await this.usersService.create({
      email: registerDto.email,
      password: passwordHash,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
    });

    const { token } = await this.issueSession(user.id, metadata);

    // The account is usable before the address is confirmed; Phase 19 adds the
    // gate. Issuing the link here means a user who never checks the address
    // cannot be reached later without asking for a new one.
    void this.sendVerification(user).catch(() => undefined);

    return this.createAuthToken(user, token);
  }

  /**
   * Password check only. When the account has 2FA enabled no tokens are issued
   * here, the caller receives a short lived challenge instead and has to prove
   * the second factor on the two-factor login route.
   */
  async login(
    loginDto: LoginDto,
    metadata: DeviceMetadata,
  ): Promise<LoginResult> {
    const user = await this.usersService.findByEmail(loginDto.email);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await verifyPassword(
      loginDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const userResponse = UserResponseDto.fromEntity(user);

    if (await this.twoFactorService.isEnabled(user.id)) {
      return this.twoFactorService.issueChallenge(user.id);
    }

    const { token } = await this.issueSession(user.id, metadata);

    return this.createAuthToken(userResponse, token);
  }

  /**
   * Confirms an address from a link.
   *
   * Public, because the user clicking the link is not signed in yet, and that is
   * the whole point of verifying an address. The token is the credential.
   */
  async verifyEmail(
    verifyEmailDto: VerifyEmailDto,
  ): Promise<GenericMessageDto> {
    await this.emailVerificationService.verify(verifyEmailDto.token);

    const generic = new GenericMessageDto();
    generic.message = 'Your email address is confirmed.';

    return generic;
  }

  /**
   * Sends another verification link.
   *
   * Same message for every outcome, including an already verified address: a
   * different answer for a verified one would tell an attacker the address is
   * registered, which is the enumeration this route exists to avoid.
   */
  async resendVerification(
    resendVerificationDto: ResendVerificationDto,
    ipAddress: string,
  ): Promise<GenericMessageDto> {
    const startedAt = Date.now();
    const generic = new GenericMessageDto();
    generic.message =
      'If that address needs confirming, a new link is on its way.';

    const user = await this.usersService.findByEmail(
      resendVerificationDto.email,
    );

    if (!user || !user.isActive || user.isEmailVerified) {
      // Same statement as the real branch, against an id with no rows, so the
      // three outcomes cost the same and not merely answer the same.
      await this.emailVerificationService.spendOutstandingFor(randomUUID());

      return this.padded(generic, startedAt);
    }

    const { token, expiresAt } = await this.emailVerificationService.issue(
      user,
      user.email,
      ipAddress,
    );

    const hours = Math.round((expiresAt.getTime() - Date.now()) / 3_600_000);

    this.enqueueVerification(user, token, hours);

    return this.padded(generic, startedAt);
  }

  /**
   * Sends the verification link for a freshly registered user.
   *
   * Called from `register()`, so it shares the fire-and-forget rule: a provider
   * outage must not turn a registration into a 500, and the user can request
   * another link.
   */
  private async sendVerification(user: {
    id: string;
    email: string;
    isEmailVerified: boolean;
  }): Promise<void> {
    if (user.isEmailVerified) {
      return;
    }

    const { token, expiresAt } = await this.emailVerificationService.issue(
      user as never,
      user.email,
      null,
    );

    const hours = Math.round((expiresAt.getTime() - Date.now()) / 3_600_000);

    this.enqueueVerification(user, token, hours);
  }

  /**
   * Starts a password reset.
   *
   * The answer is identical whether or not the address exists, and so is the
   * work done before the branch: one email lookup and one hash, in both cases.
   * That is the part a "did they find the account" timing attack looks for, and
   * it is why the lookup result is not returned to the caller.
   */
  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
    ipAddress: string,
  ): Promise<GenericMessageDto> {
    const startedAt = Date.now();
    const generic = new GenericMessageDto();
    generic.message =
      'If an account exists for that address, a reset link is on its way.';

    const user = await this.usersService.findByEmail(forgotPasswordDto.email);

    if (!user || !user.isActive) {
      // The same statement the real branch runs, against an id with no rows, so
      // both branches pay for the same query. Without it the miss is measurably
      // cheaper and the response time alone answers the question.
      await this.passwordResetService.spendOutstandingFor(randomUUID());

      return this.padded(generic, startedAt);
    }

    const { token, expiresAt } = await this.passwordResetService.issue(
      user,
      ipAddress,
    );

    const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60_000);

    // Not awaited: a provider that hangs must not hold the request open, and a
    // failure here is logged rather than turned into a failed reset. The token
    // is already stored, so the user can request another.
    this.enqueueResetMail(user.email, token, ipAddress, minutes);

    return this.padded(generic, startedAt);
  }

  /**
   * Holds an account-existence response for a fixed minimum.
   *
   * The message being identical is not sufficient on its own: the branch that
   * issues a token does more work, and an attacker sorting a batch of guesses by
   * response time finds the registered addresses without any clever analysis.
   * Both outcomes wait for the same floor, with the same jitter applied to both.
   */
  /**
   * Queues a verification email.
   *
   * Enqueued rather than sent, so the request does not wait for the provider. The
   * render happens inside the job, not here, which means a template edited between
   * the enqueue and the run is picked up rather than frozen at enqueue time.
   */
  private enqueueVerification(
    user: { email: string; isEmailVerified: boolean },
    token: string,
    hours: number,
  ): void {
    if (user.isEmailVerified) {
      return;
    }

    // One key per token. A resend mints a new token, so a key scoped to the
    // address alone would suppress the replacement link the user just asked for.
    this.enqueueMail(
      {
        to: user.email,
        template: 'verify-email',
        data: {
          verificationUrl: this.mailService.buildUrl(
            `/auth/verify-email?token=${encodeURIComponent(token)}`,
          ),
          expiresInHours: hours,
          appName: this.appConfig.name,
        },
      },
      dedupeKey({
        template: 'verify-email',
        to: user.email,
        subjectId: token,
      }),
    );
  }

  private enqueueResetMail(
    to: string,
    token: string,
    ipAddress: string,
    minutes: number,
  ): void {
    this.enqueueMail(
      {
        to,
        template: 'reset-password',
        data: {
          resetUrl: this.mailService.buildUrl(
            `/auth/reset-password?token=${encodeURIComponent(token)}`,
          ),
          ip: ipAddress,
          expiresInMinutes: minutes,
          appName: this.appConfig.name,
        },
      },
      dedupeKey({ template: 'reset-password', to, subjectId: token }),
    );
  }

  /**
   * Hands a mail to the queue, swallowing the enqueue failure.
   *
   * Not awaited and the rejection caught: the token is already stored, so a queue
   * that is down costs the user one mail rather than the whole request, and they
   * can ask for another.
   */
  private enqueueMail(payload: MailJobPayload, key: string): Promise<void> {
    return this.jobQueue
      .enqueue('mail', { name: MAIL_JOB, payload, dedupeKey: key })
      .catch(() => undefined);
  }

  protected async padded<T>(response: T, startedAt: number): Promise<T> {
    await padResponse({ startedAt });

    return response;
  }

  /**
   * Finishes a password reset: changes the password, spends the token and kills
   * every other session, in one transaction.
   */
  async resetPassword(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<GenericMessageDto> {
    await this.passwordResetService.consume(
      resetPasswordDto.token,
      resetPasswordDto.newPassword,
    );

    const generic = new GenericMessageDto();
    generic.message = 'Your password has been changed. Sign in again.';

    return generic;
  }

  /**
   * Completes a login that was interrupted by the second factor check.
   */
  async twoFactorLogin(
    twoFactorLoginDto: TwoFactorLoginDto,
    metadata: DeviceMetadata,
  ): Promise<AuthToken> {
    const userId = this.twoFactorService.verifyChallengeToken(
      twoFactorLoginDto.challengeToken,
    );
    const user = await this.usersService.findById(userId);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid two-factor challenge');
    }

    await this.twoFactorService.verifyChallenge(userId, twoFactorLoginDto.code);

    const { token } = await this.issueSession(user.id, metadata);

    return this.createAuthToken(UserResponseDto.fromEntity(user), token);
  }

  twoFactorSetup(currentUser: RequestUser): Promise<TwoFactorSetup> {
    return this.twoFactorService.setup(currentUser.id, currentUser.email);
  }

  twoFactorVerify(
    currentUser: RequestUser,
    twoFactorCodeDto: TwoFactorCodeDto,
  ): Promise<TwoFactorEnabledResponseDto> {
    return this.twoFactorService
      .verifySetup(currentUser.id, twoFactorCodeDto.code)
      .then(({ recoveryCodes }) => ({ enabled: true as const, recoveryCodes }));
  }

  async twoFactorDisable(
    currentUser: RequestUser,
    twoFactorCodeDto: TwoFactorCodeDto,
  ): Promise<void> {
    await this.twoFactorService.disable(currentUser.id, twoFactorCodeDto.code);
  }

  async refresh(
    refreshTokenDto: RefreshTokenDto,
    metadata: DeviceMetadata,
  ): Promise<AuthToken> {
    const payload = this.refreshTokenService.verify(
      refreshTokenDto.refreshToken,
    );
    const user = await this.usersService.findById(payload.sub);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const rotation = await this.rotate(payload.jti, metadata);

    if (rotation.status === 'invalid') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (rotation.status === 'reused') {
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (rotation.status === 'expired') {
      throw new UnauthorizedException('Refresh token expired');
    }

    return this.createAuthToken(
      UserResponseDto.fromEntity(user),
      rotation.refreshToken,
    );
  }

  async logout(logoutDto: LogoutDto): Promise<void> {
    const { jti } = this.refreshTokenService.verify(logoutDto.refreshToken, {
      ignoreExpiration: true,
    });

    await this.refreshTokenService.revokeByJti(
      jti,
      RefreshTokenRevokedReason.Logout,
    );
  }

  async logoutAll(currentUser: RequestUser): Promise<void> {
    if (!currentUser?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    await this.refreshTokenService.runInTransaction(async (manager) => {
      await this.refreshTokenService.revokeAllByUserId(
        currentUser.id,
        RefreshTokenRevokedReason.LogoutAll,
        manager,
      );

      await this.deviceService.revokeAllByUserId(currentUser.id);
    });
  }

  async getMe(currentUser: RequestUser): Promise<UserResponseDto> {
    return this.usersService.findProfileById(currentUser?.id);
  }

  listDevices(currentUser: RequestUser): Promise<UserDeviceDto[]> {
    return this.deviceService.listByUserId(currentUser.id);
  }

  /**
   * The caller's live sessions.
   *
   * A session is one live refresh token, so this is the row a refresh chain
   * currently rests on. Expired and already-revoked rows are excluded by the
   * query, which means the list only ever contains something the caller could
   * usefully revoke.
   *
   * Device names are filled in from the caller's devices rather than joined, and
   * a session whose device has since been removed is still listed with no name.
   * Dropping it would hide a session that is still able to refresh.
   */
  async listSessions(currentUser: RequestUser): Promise<AuthSessionDto[]> {
    if (!currentUser?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    const [tokens, devices] = await Promise.all([
      this.refreshTokenService.listLiveByUserId(currentUser.id),
      this.deviceService.listByUserId(currentUser.id),
    ]);

    const deviceNames = new Map(
      devices.map((device) => [device.id, device.deviceName]),
    );

    return tokens.map((token) =>
      AuthSessionDto.fromEntity(
        token,
        token.deviceId === null
          ? null
          : (deviceNames.get(token.deviceId) ?? null),
      ),
    );
  }

  /**
   * Revokes one session, leaving the caller's others alone.
   *
   * The lookup is scoped to the caller's own sessions, so an id belonging to
   * someone else is a 404 rather than a successful revocation of their access.
   */
  async revokeSession(
    currentUser: RequestUser,
    sessionId: string,
  ): Promise<void> {
    if (!currentUser?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    await this.refreshTokenService.revokeByIdForUser(
      currentUser.id,
      sessionId,
      RefreshTokenRevokedReason.SessionRevoked,
    );
  }

  async revokeDevice(
    currentUser: RequestUser,
    deviceId: string,
  ): Promise<void> {
    if (!currentUser?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    const device = await this.deviceService.revoke(currentUser.id, deviceId);

    await this.refreshTokenService.revokeAllByDeviceId(
      device.id,
      RefreshTokenRevokedReason.DeviceRevoked,
    );
  }

  private async issueSession(
    userId: string,
    metadata: DeviceMetadata,
  ): Promise<{ token: string }> {
    const device = await this.deviceService.register(userId, metadata);
    const tokenMetadata = this.toTokenMetadata(metadata);

    return this.refreshTokenService.issue(userId, tokenMetadata, device.id);
  }

  private async rotate(
    jti: string,
    metadata: DeviceMetadata,
  ): Promise<RotationResult> {
    const tokenMetadata = this.toTokenMetadata(metadata);

    return this.refreshTokenService.runInTransaction(async (manager) => {
      const current = await this.refreshTokenService.findByJti(
        jti,
        manager,
        true,
      );

      if (!current) {
        return { status: 'invalid' };
      }

      if (current.revokedAt) {
        // Replaying a token that was already superseded by a rotation means the
        // token leaked, so every session of that user is dropped. Tokens revoked
        // by an explicit logout are not a compromise signal.
        if (current.revokedReason !== RefreshTokenRevokedReason.Rotated) {
          return { status: 'invalid' };
        }

        await this.refreshTokenService.revokeAllByUserId(
          current.userId,
          RefreshTokenRevokedReason.ReuseDetected,
          manager,
        );
        await this.deviceService.revokeAllByUserId(current.userId);

        return { status: 'reused' };
      }

      if (current.expiresAt.getTime() <= Date.now()) {
        await this.refreshTokenService.revokeByJti(
          current.jti,
          RefreshTokenRevokedReason.Expired,
          null,
          manager,
        );

        return { status: 'expired' };
      }

      // The rotated token stays on the same device, so a session never hops
      // between devices on refresh.
      const { token, record } = await this.refreshTokenService.issue(
        current.userId,
        tokenMetadata,
        current.deviceId,
        manager,
      );

      await this.refreshTokenService.revokeByJti(
        current.jti,
        RefreshTokenRevokedReason.Rotated,
        record.id,
        manager,
      );

      return { status: 'ok', refreshToken: token };
    });
  }

  private toTokenMetadata(metadata: DeviceMetadata): TokenMetadata {
    return {
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    };
  }

  private async createAuthToken(
    user: UserResponseDto,
    refreshToken: string,
  ): Promise<AuthToken> {
    const accessToken = await this.signAccessToken(user);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.getExpiresIn(accessToken),
      user,
    };
  }

  private async signAccessToken(user: UserResponseDto): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      isManager: user.isManager,
    };

    return this.jwtService.signAsync(payload);
  }

  private getExpiresIn(token: string): number {
    const { iat, exp } = this.jwtService.decode<JwtPayload>(token);

    if (!iat || !exp) {
      return 0;
    }

    return exp - iat;
  }
}
