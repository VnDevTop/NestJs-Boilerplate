import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Role } from '../../../common/enums/index.js';
import { User } from '../entities/index.js';

export class UserResponseDto {
  @ApiProperty({
    example: '8d7d34d4-8a52-4a7f-a92e-2d6d3ef9e631',
  })
  id!: string;

  @ApiProperty({
    example: 'john@example.com',
  })
  email!: string;

  @ApiPropertyOptional({
    example: 'John',
    nullable: true,
  })
  firstName!: string | null;

  @ApiPropertyOptional({
    example: 'Doe',
    nullable: true,
  })
  lastName!: string | null;

  @ApiProperty({
    enum: Role,
    example: Role.User,
  })
  role!: Role;

  @ApiProperty({
    example: true,
  })
  isActive!: boolean;

  @ApiProperty({
    example: false,
  })
  isManager!: boolean;

  @ApiProperty({
    example: 0,
    description:
      'Bumped to kill every access token at once. Not shown to clients; ' +
      'present so a token can be minted with the value the strategy checks.',
  })
  sessionsVersion!: number;

  @ApiProperty({
    example: false,
    description:
      'Whether the address is confirmed. The account works either way; Phase ' +
      '19 uses this to gate sensitive actions.',
  })
  isEmailVerified!: boolean;

  @ApiPropertyOptional({
    example: '2026-09-26T00:00:00.000Z',
    nullable: true,
  })
  lastLoginAt!: Date | null;

  @ApiProperty({
    example: '2026-09-26T00:00:00.000Z',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-09-26T00:00:00.000Z',
  })
  updatedAt!: Date;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
  })
  deletedAt!: Date | null;

  constructor(user: User) {
    this.id = user.id;
    this.email = user.email;
    this.firstName = user.firstName;
    this.lastName = user.lastName;
    this.role = user.role;
    this.isActive = user.isActive;
    this.isManager = user.isManager;
    this.sessionsVersion = user.sessionsVersion;
    this.isEmailVerified = user.isEmailVerified;
    this.lastLoginAt = user.lastLoginAt;
    this.createdAt = user.createdAt;
    this.updatedAt = user.updatedAt;
    this.deletedAt = user.deletedAt;
  }

  static fromEntity(user: User): UserResponseDto {
    return new UserResponseDto(user);
  }

  static fromEntities(users: User[]): UserResponseDto[] {
    return users.map((user) => UserResponseDto.fromEntity(user));
  }
}
