import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/index.js';
import type { RequestUser } from '../../common/interfaces/index.js';
import type { NotificationChannelName } from '../../configs/notification.config.js';
import {
  NotificationPreferencesDto,
  UpdateNotificationPreferencesDto,
} from './dto/index.js';
import {
  isNotificationEventKey,
  NOTIFICATION_EVENT_KEYS,
  type NotificationEventKey,
} from './notification.events.js';
import {
  NotificationPreferencesService,
  type PreferenceEntry,
} from './notification-preferences.service.js';

const CHANNELS: NotificationChannelName[] = [
  'console',
  'email',
  'telegram',
  'slack',
  'discord',
];

/**
 * A user's own notification preferences, and nothing else.
 *
 * No admin variant on purpose. A preference belongs to the person it silences, and
 * the only interesting question about somebody else's is the one an operator asks
 * of `notification_logs`, which is a different resource with a different
 * permission. A route that let an administrator mute another user's alerts would be
 * a way to stop somebody being told their account was just used.
 */
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get('preferences')
  @ApiOperation({
    summary: "Read the caller's notification preferences",
  })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  async list(
    @CurrentUser() currentUser: RequestUser,
  ): Promise<NotificationPreferencesDto> {
    const rows = await this.preferences.list(currentUser.id);

    return {
      availableEvents: [...NOTIFICATION_EVENT_KEYS],
      availableChannels: [...CHANNELS],
      preferences: rows.map((row) => ({
        event: row.event,
        channel: row.channel,
        enabled: row.enabled,
      })),
    };
  }

  /**
   * Mutes or unmutes pairs.
   *
   * 204 rather than the updated list, because the caller already knows what it
   * asked for and a re-read would be a second round trip to confirm a write that
   * either happened or raised. Validation happens here rather than through a
   * `ValidationPipe` DTO because these are two enums and a boolean, and the error
   * messages below name which one was wrong — a pipe would say "event must be a
   * valid enum value" and leave the caller guessing which value it meant.
   */
  @Patch('preferences')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mute or unmute events per channel for the caller',
  })
  async update(
    @CurrentUser() currentUser: RequestUser,
    @Body() body: UpdateNotificationPreferencesDto,
  ): Promise<void> {
    if (!Array.isArray(body?.preferences)) {
      throw new BadRequestException('preferences must be an array');
    }

    const entries: PreferenceEntry[] = [];

    for (const raw of body.preferences) {
      if (!isNotificationEventKey(raw?.event)) {
        throw new BadRequestException(
          `Unknown event "${String(raw?.event)}", expected one of ${NOTIFICATION_EVENT_KEYS.join(', ')}`,
        );
      }

      if (!CHANNELS.includes(raw?.channel)) {
        throw new BadRequestException(
          `Unknown channel "${String(raw?.channel)}", expected one of ${CHANNELS.join(', ')}`,
        );
      }

      if (typeof raw.enabled !== 'boolean') {
        throw new BadRequestException(
          `enabled must be true or false for ${raw.event} on ${raw.channel}`,
        );
      }

      entries.push({
        event: raw.event as NotificationEventKey,
        channel: raw.channel,
        enabled: raw.enabled,
      });
    }

    await this.preferences.apply(currentUser.id, entries);
  }
}
