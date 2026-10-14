import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';

import type { NotificationChannelName } from '../../../configs/notification.config.js';
import { NOTIFICATION_EVENT_KEYS } from '../notification.events.js';

/** One event's answer for one channel, as the read side reports it. */
export class NotificationPreferenceDto {
  @ApiProperty({
    enum: NOTIFICATION_EVENT_KEYS,
    example: 'auth.device.login',
    description:
      'The event this preference is about. An event absent from the list is not muted.',
  })
  event!: string;

  @ApiProperty({
    enum: ['console', 'email', 'telegram', 'slack', 'discord'],
    example: 'slack',
    description: 'The channel this preference applies to.',
  })
  channel!: NotificationChannelName;

  @ApiProperty({
    example: false,
    description:
      'False means the user does not want this event on this channel. A pair with no row at all is enabled, because the default is opt-out.',
  })
  enabled!: boolean;
}

/**
 * What a user receives, and the complete set they have an opinion about.
 *
 * The enabled events are listed separately from the muted ones rather than only
 * returning rows, because "everything except these three" is the answer a client
 * needs and it cannot be derived from three rows.
 */
export class NotificationPreferencesDto {
  @ApiProperty({ type: [String], example: NOTIFICATION_EVENT_KEYS })
  availableEvents!: string[];

  @ApiProperty({
    type: [String],
    example: ['console', 'email', 'telegram', 'slack', 'discord'],
  })
  availableChannels!: string[];

  @ApiProperty({
    type: [NotificationPreferenceDto],
    description:
      'Only the pairs the user has changed. An empty list means nothing is muted.',
  })
  preferences!: NotificationPreferenceDto[];
}

/**
 * One pair to change.
 *
 * The validators are not decoration. The global pipe runs with `whitelist: true`,
 * which strips any property no class-validator decorator names, so a DTO
 * documented only with `@ApiProperty` arrives at the controller as `undefined` —
 * every field of this one did, and `PATCH /notifications/preferences` had nothing
 * to write. Found by the end-to-end suite.
 */
export class UpdateNotificationPreferenceDto {
  @ApiProperty({
    enum: NOTIFICATION_EVENT_KEYS,
    example: 'user.registered',
    description: 'The event to change.',
  })
  @IsIn(NOTIFICATION_EVENT_KEYS)
  event!: string;

  @ApiProperty({
    enum: ['console', 'email', 'telegram', 'slack', 'discord'],
    example: 'slack',
    description: 'The channel to change it on.',
  })
  @IsIn(['console', 'email', 'telegram', 'slack', 'discord'])
  channel!: NotificationChannelName;

  @ApiProperty({
    example: false,
    description:
      'False mutes the pair. True clears the override, because true is the default anyway.',
  })
  @IsBoolean()
  enabled!: boolean;
}

/** A change request. Several pairs at once, each applied independently. */
export class UpdateNotificationPreferencesDto {
  @ApiProperty({
    type: [UpdateNotificationPreferenceDto],
    example: [
      { event: 'user.registered', channel: 'slack', enabled: false },
      { event: 'auth.device.login', channel: 'console', enabled: false },
    ],
    description:
      'The pairs to change. Pairs not listed are left as they are, so a client built before an event existed does not clear it on every save.',
  })
  @IsArray()
  // Bounded because each entry is a write, and an unbounded list is a way to ask
  // the server to do an unbounded number of them in one request.
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UpdateNotificationPreferenceDto)
  preferences!: UpdateNotificationPreferenceDto[];
}
