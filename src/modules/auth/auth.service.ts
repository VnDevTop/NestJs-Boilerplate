import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { JwtPayload, RequestUser } from '../../common/interfaces/index.js';
import { MetricsService } from '../../core/metrics/index.js';
import {
  getRequestId,
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
import { NotificationEventsService } from '../notification/notification-events.service.js';
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
import { AccountLockService } from './account-lock.service.js';
import { LoginLockedException } from './exceptions/login-locked.exception.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { PasswordPolicyService } from './password-policy.service.js';
import { PasswordHistoryService } from './password-history.service.js';
import { PASSWORD_CHANGE_REASON } from './entities/index.js';
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
  | {
      status: 'ok';
      refreshToken: string;
      deviceId: string | null;
      /** The new session's id, so the new access token can be revoked with it. */
      sessionId: string;
      /**
       * The session this rotation superseded, which the caller must record as
       * revoked. Separate from `sessionId` because the new access token carries one
       * and the old one has to die.
       */
      supersededSessionId: string;
    }
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
    private readonly notifications: NotificationEventsService,
    private readonly passwordPolicy: PasswordPolicyService,
    private readonly passwordHistory: PasswordHistoryService,
    private readonly accountLock: AccountLockService,
    // Default-constructed so every existing harness that builds `AuthService` with
    // fourteen collaborators still builds. With `prom-client` absent it is a no-op,
    // which is the state this runs in.
    private readonly metrics: MetricsService = new MetricsService(),
  ) {}

  private get appConfig(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }

  async register(
    registerDto: RegisterDto,
    metadata: DeviceMetadata,
  ): Promise<AuthToken> {
    // Before the hash, not after. Hashing is deliberately slow, so a policy check
    // that ran afterwards would have spent the work and then thrown it away — and a
    // signup that reaches the database before refusing a password is a signup that
    // has already charged somebody scrypt for the privilege of being told no.
    await this.assertPasswordAcceptable(registerDto.password);

    const passwordHash = await hashPassword(registerDto.password);

    const user = await this.usersService.create({
      email: registerDto.email,
      password: passwordHash,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
    });

    // The very first entry, written after the row exists and outside a transaction,
    // because `create` is not one. The ordering is the point: a history row whose
    // user does not exist is an orphan the cascade cannot clean up, whereas a
    // missing history row costs a user the ability to reuse this one password.
    await this.passwordHistory.record(
      user.id,
      passwordHash,
      PASSWORD_CHANGE_REASON.Register,
    );

    const { token, device, sessionId } = await this.issueSession(
      user.id,
      metadata,
    );

    // The account is usable before the address is confirmed; Phase 19 adds the
    // gate. Issuing the link here means a user who never checks the address
    // cannot be reached later without asking for a new one.
    void this.sendVerification(user).catch(() => undefined);

    // The operator alert is not awaited, and `notify` does not reject anyway.
    // Detached rather than awaited so nothing about the notification path can delay
    // a token that is already ready to return. Reads the address and the name off
    // the response DTO rather than re-querying the user: `create` already returned
    // it and a second read would be a second answer that could differ.
    void this.notifyRegistered(user.id, user.email, user.firstName ?? '');

    return this.createAuthToken(user, token, device, sessionId);
  }

  /**
   * Tells the operators a new account exists.
   *
   * Carries the user's id so a preference can mute it and the log row can be found
   * later. Carries nothing else from the user: the event renders an address and a
   * first name, and an event that could read `user.password` is one refactor away
   * from posting a credential to a shared channel.
   */
  private async notifyRegistered(
    userId: string,
    email: string,
    firstName: string,
  ): Promise<void> {
    await this.notifications.notify(
      'user.registered',
      { email, firstName },
      { userId },
    );
  }

  /**
   * Password check only. When the account has 2FA enabled no tokens are issued
   * here, the caller receives a short lived challenge instead and has to prove
   * the second factor on the two-factor login route.
   */
  /**
   * Counts a rejected attempt and notifies when the failures become news.
   *
   * The owner's mail goes only when the account exists, and only on the attempt
   * that begins a block. Sending per rejected request would turn the login route
   * into a way to make the application mail an address repeatedly.
   *
   * The **operator** alert is deliberately not gated on the account existing. The
   * lockout counts failures for addresses nobody registered — that is the price of
   * not letting a 429 answer which addresses exist — so an operator watching for
   * attack traffic needs to see a burst against an address that is not in the
   * database. It is gated on `firstBlock` instead, which is the deduplication that
   * matters: one alert per block, not one per rejected request.
   *
   * The address is carried in the clear because an operator cannot act on a hash.
   * That is a deliberate trade against `notification_logs` holding personal data,
   * which is what `RETENTION_NOTIFICATION_LOGS_DAYS` bounds.
   */
  private async recordLoginFailure(email: string): Promise<void> {
    // Counted here rather than inside the lockout service, because this runs on
    // every failure including the ones for addresses nobody registered — and that
    // difference is the whole point. An attacker spraying a list of addresses shows
    // up here as a rising failure count against a flat success count, which is the
    // one signal that survives a redis outage: the rate limiter and the lockout both
    // fail open, and this does not.
    this.metrics.loginAttempt('failure');

    const state = await this.loginLockout.recordFailure(email);

    // Every failure, not only the one that starts a temporary block. The permanent
    // lock counts the same failures and crosses at a much higher number, so a call
    // made only on `firstBlock` would stop after the first five and the lock would
    // never fire.
    await this.accountLock.lockOnRepeatedFailures(email, state.failures);

    if (!state.firstBlock) {
      return;
    }

    await this.notifications.notify('auth.login.failed', {
      email,
      failures: state.failures,
      blockedMinutes: Math.max(1, Math.ceil(state.retryAfterSeconds / 60)),
    });

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

    // A locked account is in this branch rather than a check of its own, because
    // the answer has to be the one an unregistered address gets. A separate 403
    // would tell anybody burning twenty attempts which addresses exist, and the
    // owner has the mail that explains it anyway.
    if (!user || !user.isActive || user.lockedAt !== null) {
      // Counted even for a locked account, and that is deliberate rather than an
      // oversight: the temporary block still applies, and an attacker hammering a
      // locked account should not find the temporary limits quietly switched off
      // underneath them.
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

    // Counted before anything else can fail, so the pair of them is a ratio over
    // completed sign-ins rather than one over an uneven subset.
    this.metrics.loginAttempt('success');

    // Cleared before anything else can fail, so a transient error later in the
    // sign-in does not leave a count that will block the next honest attempt.
    await this.loginLockout.reset(loginDto.email);

    const userResponse = UserResponseDto.fromEntity(user);

    if (await this.twoFactorService.isEnabled(user.id)) {
      return this.twoFactorService.issueChallenge(user.id);
    }

    const { token, device, sessionId, isNewDevice } = await this.issueSession(
      user.id,
      metadata,
    );

    // A new device is worth an operator alert and a repeat sign-in is not, which is
    // why this hangs off `created` rather than off the login itself. Every sign-in
    // alerting would train an operator to ignore the channel.
    if (isNewDevice) {
      void this.notifyNewDevice(user.email, user.id, metadata);
    }

    return this.createAuthToken(userResponse, token, device, sessionId);
  }

  /**
   * Tells the operators a sign-in arrived from a device nobody had seen.
   *
   * The timestamp is formatted here rather than inside the event, because an event
   * is a pure function of its data and a `Date` in the payload would make two
   * renderings of the same queued job differ.
   */
  private async notifyNewDevice(
    email: string,
    userId: string,
    metadata: DeviceMetadata,
  ): Promise<void> {
    await this.notifications.notify(
      'auth.device.login',
      {
        email,
        deviceName: metadata.deviceName ?? 'unrecognised device',
        ip: metadata.ipAddress ?? 'unknown',
        time: new Date().toISOString(),
      },
      { userId },
    );
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
    // The request id travels with the job rather than being read at send time,
    // because the send happens in the worker — possibly much later, if the queue
    // is backed up — and by then the async context that held it is gone. A
    // `mail_logs` row that cannot be joined to the request that produced it is a
    // row nobody can follow back to a person.
    return this.jobQueue
      .enqueue('mail', {
        name: MAIL_JOB,
        payload: { ...payload, requestId: getRequestId() },
        dedupeKey: key,
      })
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
    // Before `consume`, so a refused password never spends the token. The token is
    // single use and spending it on a rejected attempt would leave the user who
    // mistyped their new password needing the whole reset flow again.
    await this.assertPasswordAcceptable(resetPasswordDto.newPassword);

    await this.passwordResetService.consume(
      resetPasswordDto.token,
      resetPasswordDto.newPassword,
    );

    const generic = new GenericMessageDto();
    generic.message = 'Your password has been changed. Sign in again.';

    return generic;
  }

  /**
   * Refuses a password the policy will not accept.
   *
   * One call site for the policy and one place that turns its answer into an HTTP
   * error, so `register` and `reset-password` cannot drift into checking different
   * subsets of the same rules.
   *
   * Every reason is in the message rather than only the first. A user who typed a
   * password failing three rules is shown three, because finding them one submit at
   * a time is how a reset form gets abandoned halfway.
   */
  private async assertPasswordAcceptable(password: string): Promise<void> {
    const result = await this.passwordPolicy.check(password);

    if (result.ok) {
      return;
    }

    throw new BadRequestException(result.reasons.join(' '));
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

    // Same reason as the password path: a lock is a lock, and finishing a
    // two-factor sign-in is another way in.
    if (!user || !user.isActive || user.lockedAt !== null) {
      throw new UnauthorizedException('Invalid two-factor challenge');
    }

    await this.twoFactorService.verifyChallenge(userId, twoFactorLoginDto.code);

    const { token, device, sessionId } = await this.issueSession(
      user.id,
      metadata,
    );

    return this.createAuthToken(
      UserResponseDto.fromEntity(user),
      token,
      device,
      sessionId,
    );
  }

  twoFactorSetup(currentUser: RequestUser): Promise<TwoFactorSetup> {
    return this.twoFactorService.setup(currentUser.id, currentUser.email);
  }

  /**
   * Confirming a setup turns two-factor on, which is the strongest security change
   * a user can make to their own account and the one an operator most wants to know
   * happened.
   *
   * The address comes from the request user rather than a lookup, because the
   * strategy verified it on this very request and a second read would be a second
   * answer that could differ from the one the guard authorised.
   */
  async twoFactorVerify(
    currentUser: RequestUser,
    twoFactorCodeDto: TwoFactorCodeDto,
  ): Promise<TwoFactorEnabledResponseDto> {
    const { recoveryCodes } = await this.twoFactorService.verifySetup(
      currentUser.id,
      twoFactorCodeDto.code,
    );

    void this.notifications.notify(
      'auth.2fa.enabled',
      { email: currentUser.email },
      { userId: currentUser.id },
    );

    return { enabled: true, recoveryCodes };
  }

  /**
   * Disabling a second factor is the same event in the wrong direction, and the one
   * worth alerting on harder: it is also the first thing an attacker with a
   * compromised password does.
   */
  async twoFactorDisable(
    currentUser: RequestUser,
    twoFactorCodeDto: TwoFactorCodeDto,
  ): Promise<void> {
    await this.twoFactorService.disable(currentUser.id, twoFactorCodeDto.code);

    void this.notifications.notify(
      'auth.2fa.disabled',
      { email: currentUser.email },
      { userId: currentUser.id },
    );
  }

  async refresh(
    refreshTokenDto: RefreshTokenDto,
    metadata: DeviceMetadata,
  ): Promise<AuthToken> {
    const payload = this.refreshTokenService.verify(
      refreshTokenDto.refreshToken,
    );
    const user = await this.usersService.findById(payload.sub);

    // A locked account cannot mint new access tokens either. Without this the lock
    // would be undone by a client holding a refresh token: every call here would
    // be refused by the strategy, and a client that reacts by refreshing would be
    // handed a fresh token and try again, forever.
    if (!user || !user.isActive || user.lockedAt !== null) {
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

    // The rotation superseded the session the old access token was minted from, so
    // that token stops working rather than running out its full fifteen minutes.
    //
    // After the commit, never inside the rotation: a record written before the
    // transaction committed would kill the access token of a refresh that then
    // rolled back, leaving the client with a working refresh token and no working
    // access token at all.
    //
    // The cost, stated plainly: a client that loses the response to this refresh is
    // left with nothing that works, and its retry presents a rotated token, which
    // is the reuse signal that drops every session of the account. Without this the
    // old access token would have carried it for up to fifteen minutes first. A
    // lost response and a leaked token are indistinguishable from here, and the
    // existing design already treats them as the same thing.
    await this.refreshTokenService.markSessionRevoked(
      rotation.supersededSessionId,
    );

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
      rotation.sessionId,
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

    const jti = await this.refreshTokenService.revokeByIdForUser(
      currentUser.id,
      sessionId,
      RefreshTokenRevokedReason.SessionRevoked,
    );

    // Revoking the refresh token only stops the *next* access token being minted.
    // The access token already in that session's hand would keep working for the
    // rest of its fifteen minutes, so the session is recorded as revoked too, and
    // the strategy refuses any token that names it.
    //
    // Not device-scoped and not account-scoped: this is one session, and the other
    // sessions on this machine have to survive it.
    await this.refreshTokenService.markSessionRevoked(jti);
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
  ): Promise<{
    token: string;
    device: UserDevice;
    sessionId: string;
    /** True when this call created the device row rather than reusing one. */
    isNewDevice: boolean;
  }> {
    // `created` rather than a second lookup, because "is this device new" is the
    // question the notification asks and `register` is the only place that knows:
    // asking again after the fact would find the row that `register` just created.
    const { device, created } = await this.deviceService.register(
      userId,
      metadata,
    );
    const tokenMetadata = this.toTokenMetadata(metadata);
    const { token, record } = await this.refreshTokenService.issue(
      userId,
      tokenMetadata,
      device.id,
    );

    return { token, device, sessionId: record.jti, isNewDevice: created };
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

      return {
        status: 'ok',
        refreshToken: token,
        deviceId: current.deviceId,
        sessionId: record.jti,
        supersededSessionId: current.jti,
      };
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
    sessionId: string,
  ): Promise<AuthToken> {
    const accessToken = await this.signAccessToken(user, device, sessionId);

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
    sessionId: string,
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
      // The session, so revoking one session also stops the access token already
      // in that session's hand. Without it, `DELETE /auth/sessions/:id` only took
      // effect at the next refresh.
      sid: sessionId,
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
