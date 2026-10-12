import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestErasureDto {
  @ApiPropertyOptional({
    example: 'I no longer use this service',
    description:
      "Why, in the account holder's words. Stored on the row and the only " +
      'explanation it will ever carry — the hard delete at the end of the ' +
      'retention window removes everything else.',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
