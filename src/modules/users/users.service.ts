import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        roles: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  findByIdWithRefreshToken(id: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id },
      select: {
        id: true,
        email: true,
        roles: true,
        status: true,
        refreshTokenHash: true,
      },
    });
  }

  create(data: Partial<User>): Promise<User> {
    const user = this.userRepository.create(data);
    return this.userRepository.save(user);
  }

  save(user: User): Promise<User> {
    return this.userRepository.save(user);
  }

  setRefreshTokenHash(id: string, hash: string | null): Promise<void> {
    return this.userRepository
      .update(id, { refreshTokenHash: hash })
      .then(() => undefined);
  }

  softDelete(id: string): Promise<void> {
    return this.userRepository.softDelete(id).then(() => undefined);
  }
}