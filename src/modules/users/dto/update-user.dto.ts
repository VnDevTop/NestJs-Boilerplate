import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Role } from '../../../common/enums/index.js';

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'john@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  /**
   * A plaintext password, hashed by the service — the same contract `register` and
   * `CreateUserDto` have. The client never holds a hash, and the request body is
   * not a place to put one.
   *
   * Setting it ends every session that account has, including the one making the
   * request. An administrator who resets a password on behalf of somebody who
   * cannot reach their inbox is closing a door the old key still opens, and leaving
   * the old sessions alive would make the reset cosmetic.
   */
  @ApiPropertyOptional({
    description: 'Plaintext. Hashed before storage; ends every session.',
    minLength: 8,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  @ApiPropertyOptional({
    example: 'John',
  })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({
    example: 'Doe',
  })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({
    enum: Role,
    example: Role.User,
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isManager?: boolean;
}
