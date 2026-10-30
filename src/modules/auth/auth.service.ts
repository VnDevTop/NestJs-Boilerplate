import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { UsersService } from '../users/users.service.js';
import { ClientService } from './client.service.js';
import { JwtKeyService } from './jwt-key.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { User, UserStatus } from '../users/entities/user.entity.js';
import type { JwtConfig } from '../../config/jwt.config.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly clientService: ClientService,
    private readonly jwtKeyService: JwtKeyService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<{ user: Omit<User, 'passwordHash'> } & AuthTokens> {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      roles: ['user'] as User['roles'],
      status: UserStatus.ACTIVE,
    });

    const tokens = await this.issueTokens(user);
    return { user: this.sanitize(user), ...tokens };
  }

  async login(dto: LoginDto): Promise<{ user: Omit<User, 'passwordHash'> } & AuthTokens> {
    const user = await this.usersService.findByEmailWithPassword(dto.email);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const maxAttempts = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 5);
    const lockMinutes = Number(process.env.AUTH_LOCK_DURATION_MINUTES ?? 15);

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= maxAttempts) {
        user.lockedUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
      }
      await this.usersService.save(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.usersService.save(user);

    const tokens = await this.issueTokens(user);
    return { user: this.sanitize(user), ...tokens };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: { sub?: string; type?: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh' || !payload.sub) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.findByIdWithRefreshToken(payload.sub);
    if (!user || !user.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const valid = await argon2.verify(user.refreshTokenHash, refreshToken);
    if (!valid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    return this.issueTokens(user as User);
  }

  async logout(userId: string): Promise<void> {
    await this.usersService.setRefreshTokenHash(userId, null);
  }

  async rotateSigningKey(): Promise<{ kid: string }> {
    const key = await this.jwtKeyService.rotate();
    return { kid: key.kid };
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const jwt = this.configService.get<JwtConfig>('jwt')!;
    const key = await this.jwtKeyService.getActiveKey();

    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        roles: user.roles,
        type: 'access',
      },
      {
        privateKey: key.privateKey,
        keyid: key.kid,
        algorithm: 'RS256',
        expiresIn: jwt.signOptions?.expiresIn ?? '15m',
      } as any,
    );

    const refreshToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        type: 'refresh',
        jti: randomUUID(),
      },
      {
        privateKey: key.privateKey,
        keyid: key.kid,
        algorithm: 'RS256',
        expiresIn: jwt.refreshTtl as any,
      } as any,
    );

    const hash = await argon2.hash(refreshToken);
    await this.usersService.setRefreshTokenHash(user.id, hash);

    return { accessToken, refreshToken };
  }

  async clientCredentials(clientId: string, clientSecret: string, scope?: string): Promise<{ accessToken: string }> {
    const client = await this.clientService.validate(clientId, clientSecret);
    const scopes = scope ? scope.split(' ').filter(Boolean) : client.scopes;
    const jwt = this.configService.get<JwtConfig>('jwt')!;
    const key = await this.jwtKeyService.getActiveKey();
    const accessToken = await this.jwtService.signAsync(
      {
        sub: client.clientId,
        scopes,
        type: 'access',
      },
      {
        privateKey: key.privateKey,
        keyid: key.kid,
        algorithm: 'RS256',
        expiresIn: jwt.signOptions?.expiresIn ?? '15m',
      } as any,
    );
    return { accessToken };
  }

  private sanitize(user: User): Omit<User, 'passwordHash'> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}