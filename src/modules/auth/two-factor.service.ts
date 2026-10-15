import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions, JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { Repository } from 'typeorm';

import {
  RECOVERY_CODE_COUNT,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_LOCK_MINUTES,
  TOTP_MAX_FAILED_ATTEMPTS,
  TOTP_PERIOD,
  TWO_FACTOR_CHALLENGE_TTL,
} from '../../common/constants/index.js';
import {
  decrypt,
  deriveKey,
  encrypt,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../../common/utils/index.js';
import { TwoFactorOptions } from '../../configs/index.js';
import { TwoFactorSecret } from './entities/index.js';
import {
  TwoFactorChallenge,
  TwoFactorChallengePayload,
  TwoFactorSetup,
} from './types/index.js';

@Injectable()
export class TwoFactorService {
  constructor(
    @InjectRepository(TwoFactorSecret)
    private readonly twoFactorRepository: Repository<TwoFactorSecret>,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  private get options(): TwoFactorOptions {
    return this.configService.getOrThrow<TwoFactorOptions>('twoFactor');
  }

  private get encryptionKey(): Buffer {
    return deriveKey(this.options.encryptionKey);
  }

  private get accessTokenSecret(): string {
    const { secret } =
      this.configService.getOrThrow<JwtModuleOptions>('jwtAccessToken');

    if (typeof secret !== 'string') {
      throw new Error('JWT access token secret is not configured');
    }

    return secret;
  }

  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new NotFoundException('Two-factor authentication is disabled');
    }
  }

  async isEnabled(userId: string): Promise<boolean> {
    if (!this.options.enabled) {
      return false;
    }

    const record = await this.twoFactorRepository.findOne({
      where: { userId, isEnabled: true },
    });

    return record !== null;
  }

  /**
   * Issues a brand new secret and replaces any pending one, so repeated setup
   * calls never leave an orphaned secret behind.
   */
  async setup(userId: string, account: string): Promise<TwoFactorSetup> {
    this.assertEnabled();

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = this.createTotp(account, secret);
    const encrypted = encrypt(secret.base32, this.encryptionKey);

    const record = this.twoFactorRepository.create({
      userId,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
      recoveryCodes: [],
      isEnabled: false,
      enabledAt: null,
      lastUsedAt: null,
      lastUsedCounter: null,
      failedAttempts: 0,
      lockedUntil: null,
    });

    await this.twoFactorRepository.save(record);

    const otpauthUrl = totp.toString();

    return {
      secret: secret.base32,
      otpauthUrl,
      qrCode: await QRCode.toDataURL(otpauthUrl),
    };
  }

  /**
   * Confirms the setup with a code from the authenticator app. Only then does
   * 2FA become active, and only then are recovery codes issued.
   */
  async verifySetup(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    this.assertEnabled();

    const record = await this.requireRecord(userId);

    if (record.isEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }

    const totp = this.totpFromRecord(record);
    const delta = totp.validate({ token: code, window: 1 });

    if (delta === null) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const plainCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);

    record.isEnabled = true;
    record.enabledAt = new Date();
    record.lastUsedCounter = totp.counter() - delta;
    record.failedAttempts = 0;
    record.lockedUntil = null;
    record.recoveryCodes = await Promise.all(
      plainCodes.map((plain: string) => hashRecoveryCode(plain)),
    );

    await this.twoFactorRepository.save(record);

    return { recoveryCodes: plainCodes };
  }

  async disable(userId: string, code: string): Promise<void> {
    this.assertEnabled();

    const record = await this.requireRecord(userId);

    if (!record.isEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    // The record is dropped right after, so consuming a recovery code here only
    // matters for the duration of this call.
    if (
      !this.isCodeAccepted(record, code) &&
      // Awaited rather than tested synchronously: a Promise is truthy, so
      // `!this.isRecoveryCode(...)` would have accepted every wrong code ever
      // typed. The scrypt derivation behind it is what makes this async.
      !(await this.isRecoveryCode(record, code))
    ) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.twoFactorRepository.delete({ id: record.id });
  }

  /**
   * Verifies the second factor during login. Accepts a TOTP code or a recovery
   * code, and applies a temporary lock after repeated failures.
   */
  async verifyChallenge(userId: string, code: string): Promise<void> {
    this.assertEnabled();

    const record = await this.requireRecord(userId);

    if (!record.isEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    this.assertNotLocked(record);

    if (await this.consumeRecoveryCode(record, code)) {
      await this.twoFactorRepository.save(record);

      return;
    }

    const totp = this.totpFromRecord(record);
    const delta = totp.validate({ token: code, window: 1 });
    const acceptedCounter = delta === null ? null : totp.counter() - delta;

    const isReplay =
      acceptedCounter !== null &&
      record.lastUsedCounter !== null &&
      acceptedCounter <= record.lastUsedCounter;

    if (acceptedCounter === null || isReplay) {
      this.registerFailure(record);
      await this.twoFactorRepository.save(record);

      throw new UnauthorizedException(
        isReplay
          ? 'Verification code already used'
          : 'Invalid verification code',
      );
    }

    record.lastUsedCounter = acceptedCounter;
    record.lastUsedAt = new Date();
    record.failedAttempts = 0;
    record.lockedUntil = null;

    await this.twoFactorRepository.save(record);
  }

  issueChallenge(userId: string): TwoFactorChallenge {
    const payload: TwoFactorChallengePayload = {
      sub: userId,
      jti: randomUUID(),
      type: 'two_factor_challenge',
    };

    const challengeToken = this.jwtService.sign(payload, {
      secret: this.accessTokenSecret,
      expiresIn: TWO_FACTOR_CHALLENGE_TTL,
    });

    const { iat, exp } = this.jwtService.decode<{
      iat?: number;
      exp?: number;
    }>(challengeToken);

    return {
      twoFactorRequired: true,
      challengeToken,
      expiresIn: exp && iat ? exp - iat : 0,
    };
  }

  verifyChallengeToken(token: string): string {
    let payload: TwoFactorChallengePayload;

    try {
      payload = this.jwtService.verify<TwoFactorChallengePayload>(token, {
        secret: this.accessTokenSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid two-factor challenge');
    }

    if (payload.type !== 'two_factor_challenge' || !payload.sub) {
      throw new UnauthorizedException('Invalid two-factor challenge');
    }

    return payload.sub;
  }

  private createTotp(label: string, secret: OTPAuth.Secret): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: this.options.issuer,
      label,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      secret,
    });
  }

  private async requireRecord(userId: string): Promise<TwoFactorSecret> {
    const record = await this.twoFactorRepository.findOne({
      where: { userId },
    });

    if (!record) {
      throw new NotFoundException('Two-factor authentication is not set up');
    }

    return record;
  }

  private totpFromRecord(record: TwoFactorSecret): OTPAuth.TOTP {
    const plain = decrypt(
      {
        ciphertext: record.secretCiphertext,
        iv: record.secretIv,
        authTag: record.secretAuthTag,
      },
      this.encryptionKey,
    );

    return this.createTotp(record.userId, OTPAuth.Secret.fromBase32(plain));
  }

  /**
   * True when the code is valid and has not been spent yet. A code from a step
   * at or below the last accepted step is a replay.
   */
  private isCodeAccepted(record: TwoFactorSecret, code: string): boolean {
    const totp = this.totpFromRecord(record);
    const delta = totp.validate({ token: code, window: 1 });

    if (delta === null) {
      return false;
    }

    const counter = totp.counter() - delta;

    if (record.lastUsedCounter !== null && counter <= record.lastUsedCounter) {
      return false;
    }

    record.lastUsedCounter = counter;
    record.lastUsedAt = new Date();
    record.failedAttempts = 0;
    record.lockedUntil = null;

    return true;
  }

  private async isRecoveryCode(
    record: TwoFactorSecret,
    code: string,
  ): Promise<boolean> {
    for (const stored of record.recoveryCodes) {
      if (await verifyRecoveryCode(code, stored)) {
        return true;
      }
    }

    return false;
  }

  private async consumeRecoveryCode(
    record: TwoFactorSecret,
    code: string,
  ): Promise<boolean> {
    let index = -1;

    for (let i = 0; i < record.recoveryCodes.length; i += 1) {
      if (await verifyRecoveryCode(code, record.recoveryCodes[i]!)) {
        index = i;
        break;
      }
    }

    if (index < 0) {
      return false;
    }

    record.recoveryCodes = record.recoveryCodes.filter(
      (_: string, i: number) => i !== index,
    );
    record.lastUsedAt = new Date();
    record.failedAttempts = 0;
    record.lockedUntil = null;

    return true;
  }

  private assertNotLocked(record: TwoFactorSecret): void {
    if (record.lockedUntil && record.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(
        'Too many invalid attempts, try again later',
      );
    }
  }

  private registerFailure(record: TwoFactorSecret): void {
    record.failedAttempts += 1;

    if (record.failedAttempts >= TOTP_MAX_FAILED_ATTEMPTS) {
      const until = new Date();
      until.setMinutes(until.getMinutes() + TOTP_LOCK_MINUTES);
      record.lockedUntil = until;
      record.failedAttempts = 0;
    }
  }
}
