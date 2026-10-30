import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from '../users/users.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { User, UserStatus } from '../users/entities/user.entity.js';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  async register(dto: RegisterDto): Promise<Omit<User, 'passwordHash'>> {
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

    return this.sanitize(user);
  }

  async login(dto: LoginDto): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.usersService.findByEmailWithPassword(dto.email);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    return this.sanitize(user);
  }

  private sanitize(user: User): Omit<User, 'passwordHash'> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}