import { ApiProperty } from '@nestjs/swagger';

import { RefreshToken } from '../entities/index.js';

/**
 * One live session: a single refresh token, with enough of its device to
 * recognise it.
 *
 * Distinct from `UserDeviceDto` on purpose. A device is a machine, and a session
 * is one sign-in on that machine. The two differ whenever a browser has more than
 * one live refresh chain, and they are revoked differently: `DELETE /devices/:id`
 * ends every session on the device, `DELETE /sessions/:id` ends one of them.
 */
export class AuthSessionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Pass to DELETE /auth/sessions/:id',
  })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  deviceId!: string | null;

  @ApiProperty({ nullable: true, example: 'MacBook Pro' })
  deviceName!: string | null;

  @ApiProperty({ nullable: true, example: '203.0.113.7' })
  ipAddress!: string | null;

  @ApiProperty({ nullable: true, example: 'Mozilla/5.0 (Macintosh)' })
  userAgent!: string | null;

  @ApiProperty({ example: '2026-10-10T09:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    description: 'When the refresh token stops working',
    example: '2026-10-11T09:00:00.000Z',
  })
  expiresAt!: string;

  /**
   * `deviceName` is passed in rather than read from a relation, because
   * `refresh_tokens.deviceId` is a bare uuid column with no foreign key and this
   * phase does not add one. A caller has a handful of devices, so they are read
   * once and mapped rather than joined per session.
   */
  static fromEntity(
    token: RefreshToken,
    deviceName: string | null = null,
  ): AuthSessionDto {
    const dto = new AuthSessionDto();

    dto.id = token.id;
    dto.deviceId = token.deviceId;
    dto.deviceName = deviceName;
    dto.ipAddress = token.ipAddress;
    dto.userAgent = token.userAgent;
    dto.createdAt = token.createdAt.toISOString();
    dto.expiresAt = token.expiresAt.toISOString();

    return dto;
  }
}
