import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The bounds here are the widest this boilerplate allows, not a policy
 * recommendation.
 *
 * Deliberately the *widest*, and looser than the policy that is actually applied:
 * `PasswordPolicyService` checks the configured minimum, the character classes and
 * the optional strength score, and this pair of decorators only stops a megabyte of
 * password reaching the validator. Pinning `@MinLength` to the configured value is
 * not possible here — decorators are evaluated when the class is defined, before
 * `ConfigModule` has read anything — so tightening these would freeze a number at
 * import time and leave the real rule invisible in the Swagger schema.
 */
export class ResetPasswordDto {
  @ApiProperty({
    example: 'aGVsbG8td29ybGQtdG9rZW4',
    description: 'The token from the reset link. Single use.',
  })
  @IsString()
  token!: string;

  @ApiProperty({
    example: 'a-new-strong-password',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
