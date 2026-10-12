import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RequestUnlockDto {
  @ApiProperty({
    example: 'john@example.com',
    description:
      'Address to send the unlock link to. The link is only ever sent to an ' +
      'account whose address is confirmed, and the response is the same ' +
      'whether or not such an account exists or is locked, so this route ' +
      'cannot be used to enumerate users.',
  })
  @IsEmail()
  email!: string;
}
