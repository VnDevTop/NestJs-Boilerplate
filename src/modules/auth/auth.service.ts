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
import { LoginLockedException } from './exceptions/login-locked.exception.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { User } from '../users/entities/index.js';
import { UserDevice } from './entities/index.js';
import { TwoFactorService } from './two-factor.service.js';
import {
  AuthToken,
  DeviceMetadata,
  TokenMetadata,
  TwoFactorChallenge,
  TwoFactorSetup,
} from './types/index.js';

type RotationResult =
  | { status: 'ok'; refreshToken: string; deviceId: string | null }
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
    private readonly loginLockout: LoginLockoutService,
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

    const { token, device } = await this.issueSession(user.id, metadata);

    // The account is usable before the address is confirmed; Phase 19 adds the
    // gate. Issuing the link here means a user who never checks the address
    // cannot be reached later without asking for a new one.
    void this.sendVerification(user).catch(() => undefined);

    return this.createAuthToken(user, token, device);
  }

  /**
   * Password check only. When the account has 2FA enabled no tokens are issued
   * here, the caller receives a short lived challenge instead and has to prove
   * the second factor on the two-factor login route.
   */
  /**
   * Counts a rejected attempt and notifies the owner when it starts a lockout.
   *
   * The mail goes only when the account exists, and only on the attempt that
   * begins the block. Sending per rejected request would turn the login route into
   * a way to make the application mail an address repeatedly.
   */
  private async recordLoginFailure(email: string): Promise<void> {
    const state = await this.loginLockout.recordFailure(email);

    if (!state.firstBlock) {
      return;
    }

    const user = await this.usersService.findByEmail(email);

    if (!user || !user.isActive) {
      return;
    }

    // Enqueued rather than sent, so a slow provider cannot hold the response
    // that is already on its way back to the caller.
    await this.enqueueMail(
      {
        to: user.email,
        template: 'account-locked',
        data: {
          reason: `Too many failed sign-in attempts. Try again in about ${Math.max(
            1,
            Math.ceil(state.retryAfterSeconds / 60),
          )} minute(s).`,
          supportUrl: this.mailService.buildUrl('/support'),
          appName: this.appConfig.name,
        },
      },
      // Keyed on the block length, so a second lockout after a lapse notifies
      // again while the attempts inside one block do not.
      dedupeKey({
        template: 'account-locked',
        to: user.email,
        subjectId: String(state.retryAfterSeconds),
      }),
    );
  }

  /**
   * Signs a user in, counting failures and blocking the account for a while when
   * there are too many.
   *
   * The order is load-bearing. The block is checked *before* the user is looked
   * up, and a failure is recorded for *every* rejected attempt whether or not the
   * address exists. That is what keeps the answer identical for a real account and
   * a made-up one: if only real accounts could produce a 429, the status code
   * would answer the question the enumeration floor in
   * `enumeration.spec.ts` exists to keep quiet.
   *
   * The trade is that anybody can lock an address out by failing to guess it, and
   * the owner may never see an attempt. The block is short, grows with the failures
   * and then stops growing, which slows that attack far more than it inconveniences
   * a real person.
   */
  async login(
    loginDto: LoginDto,
    metadata: DeviceMetadata,
  ): Promise<LoginResult> {
    const lockout = await this.loginLockout.inspect(loginDto.email);

    if (lockout.blocked) {
      throw new LoginLockedException(lockout.retryAfterSeconds);
    }

    const user = await this.usersService.findByEmail(loginDto.email);

    if (!user || !user.isActive) {
      await this.recordLoginFailure(loginDto.email);

      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await verifyPassword(
      loginDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      await this.recordLoginFailure(loginDto.email);

      throw new UnauthorizedException('Invalid email or password');
    }

    // Cleared before anything else can fail, so a transient error later in the
    // sign-in does not leave a count that will block the next honest attempt.
    await this.loginLockout.reset(loginDto.email);

    const userResponse = UserResponseDto.fromEntity(user);

    if (await this.twoFactorService.isEnabled(user.id)) {
      return this.twoFactorService.issueChallenge(user.id);
    }

    const { token, device } = await this.issueSession(user.id, metadata);

    return this.createAuthToken(userResponse, token, device);
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

    const { token, device } = await this.issueSession(user.id, metadata);

    return this.createAuthToken(
      UserResponseDto.fromEntity(user),
      token,
      device,
    );
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

    // The access token has to name the device it was minted on, and carry that
    // device's current version, or signing out of this device would not touch it.
    // A device that has since been deleted cannot be named, so the session is over
    // even though its refresh token still verifies.
    if (rotation.deviceId === null) {
      // A session with no device cannot produce a device-scoped access token, and
      // minting one without the claim would silently downgrade that session to a
      // token no logout can reach. Refusing is the fail-closed answer.
      throw new UnauthorizedException('Invalid refresh token');
    }

    const device = await this.deviceService.findByIdForSession(
      user.id,
      rotation.deviceId,
    );

    if (!device) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.createAuthToken(
      UserResponseDto.fromEntity(user),
      rotation.refreshToken,
      device,
    );
  }

  async logout(logoutDto: LogoutDto): Promise<void> {
    const { jti } = this.refreshTokenService.verify(logoutDto.refreshToken, {
      ignoreExpiration: true,
    });

    // The refresh token carries no device claim, so the device behind this session
    // comes from the row the token points at. Read before the revoke, because the
    // revoke is a flag on that same row.
    const record = await this.refreshTokenService.findByJti(jti);

    await this.refreshTokenService.revokeByJti(
      jti,
      RefreshTokenRevokedReason.Logout,
    );

    // Revoking the refresh token only stops the *next* access token being minted.
    // The access token in the caller's hand would keep working for the rest of its
    // fifteen minutes, which is not what signing out of a device means to whoever
    // just did it.
    //
    // Scoped to this device rather than the account, so the phone and the laptop
    // stay signed in. `logoutAll` is the one that takes everything.
    //
    // A token with no device cannot be scoped to one. It also predates the access
    // token claim that names a device, so there is nothing on it for the bump to
    // catch, and skipping it is consistent rather than a hole.
    if (record?.deviceId) {
      await this.deviceService.revokeDeviceSessions(
        record.userId,
        record.deviceId,
      );
    }
  }

  async logoutAll(currentUser: RequestUser): Promise<void> {
    if (!currentUser?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    // The cache delete is wrapped around the transaction rather than placed inside
    // it: a request arriving before the commit would repopulate the entry from
    // the old snapshot and cache the version we are revoking. See
    // `runThenInvalidateAuthCache`.
    await this.usersService.runThenInvalidateAuthCache(currentUser.id, () =>
      this.refreshTokenService.runInTransaction(async (manager) => {
        await this.refreshTokenService.revokeAllByUserId(
          currentUser.id,
          RefreshTokenRevokedReason.LogoutAll,
          manager,
        );

        // Inside the transaction, and as an increment rather than a read and a
        // write. If this committed without the version moving, every access token
        // would keep working for its full lifetime while the refresh tokens behind
        // them were gone, so the account looked revoked and was not.
        await manager.increment(
          User,
          { id: currentUser.id },
          'sessionsVersion',
          1,
        );

        await this.deviceService.revokeAllByUserId(currentUser.id);
      }),
    );
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
  ): Promise<{ token: string; device: UserDevice }> {
    const device = await this.deviceService.register(userId, metadata);
    const tokenMetadata = this.toTokenMetadata(metadata);
    const { token } = await this.refreshTokenService.issue(
      userId,
      tokenMetadata,
      device.id,
    );

    return { token, device };
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

      return { status: 'ok', refreshToken: token, deviceId: current.deviceId };
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
    device: { id: string; sessionsVersion: number },
  ): Promise<AuthToken> {
    const accessToken = await this.signAccessToken(user, device);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.getExpiresIn(accessToken),
      user,
    };
  }

  private async signAccessToken(
    user: UserResponseDto,
    device: { id: string; sessionsVersion: number },
  ): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      isManager: user.isManager,
      // Naming the device is what lets signing out of one browser leave the
      // others alone. `sv` above is per account and takes every device with it;
      // these two are the same counter narrowed to the machine the token was
      // minted on.
      did: device.id,
      dv: device.sessionsVersion ?? 0,
      // Carried so "log out everywhere" is visible on the next request instead
      // of after this token expires. Read from the DTO rather than re-fetched, so
      // the value in the token always matches the row it was minted from.
      sv: user.sessionsVersion,
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
