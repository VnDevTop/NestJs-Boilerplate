import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The shape of a BCP 47 language tag.
 *
 * Constrained rather than left open because this column is part of a cache key and a
 * unique index, and a value with a colon in it makes both harder to read in a `KEYS`
 * scan without making anything safer.
 *
 * Named rather than inline so the pattern is one identifier: an inline literal
 * carrying its own parentheses inside a decorator's argument list is what broke the
 * DTO scanner in `request-dto-validation.spec.ts`, and the next reader should not have
 * to rediscover why.
 */
const LANGUAGE_TAG = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;

/**
 * The template an operator wants to store.
 *
 * The three parts are a whole template rather than a patch, for the same reason
 * `SetRolePermissionsDto` is a full set: the request states what the template should
 * say, and a partial update would need a merge rule for "which part did they mean".
 *
 * `version` is optimistic concurrency rather than decoration. Two operators editing a
 * password reset email at once is the normal case in a team, and without it the
 * second save silently overwrites the first one's wording — which is the failure
 * version history exists to make recoverable, and much cheaper to prevent.
 */
export class UpdateMailTemplateDto {
  @ApiProperty({
    example: 'Welcome to {{appName}}',
    description:
      'The subject line, as handlebars. May only use {{ }}, which escapes.',
    maxLength: 255,
  })
  // `whitelist: true` strips anything no validator names, so an undecorated property
  // silently arrives as undefined. Every field here is decorated.
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;

  @ApiProperty({
    example: 'Hello {{firstName}},\n\nYour account is ready.',
    description: 'The plain-text body, as handlebars.',
  })
  @IsString()
  text!: string;

  @ApiProperty({
    example: '<p>Hello {{firstName}},</p>',
    description:
      'The html body, as handlebars. Wrapped in the shared shell, so this is the ' +
      'inner markup only. The envelope around it belongs to the application.',
  })
  @IsString()
  html!: string;

  @ApiPropertyOptional({
    example: 'en',
    description:
      'BCP 47 tag. Defaults to "en", which is the locale every send resolves today.',
    default: 'en',
  })
  @IsOptional()
  @IsString()
  @Matches(LANGUAGE_TAG, {
    message: 'locale must be a language tag such as "en" or "pt-BR"',
  })
  locale?: string;

  @ApiPropertyOptional({
    example: 2,
    description:
      'The version this edit is based on. The save is refused if the stored ' +
      'template is no longer that version, so two operators cannot silently ' +
      'overwrite each other. Omit to skip the check.',
  })
  // Present because of this decorator rather than because of `@ApiPropertyOptional`.
  // `whitelist: true` strips a property no validator names, so an undecorated
  // `version` arrives as `undefined`, the conflict check never fires, and the
  // optimistic concurrency the field exists for silently does nothing — while
  // Swagger keeps advertising it. Caught by `request-dto-validation.spec.ts`.
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

/** What a stored template looks like, for the read side. */
export class MailTemplateResponseDto {
  @ApiProperty({ example: 'reset-password' })
  name!: string;

  @ApiProperty({ example: 'en' })
  locale!: string;

  @ApiProperty({ example: 'file', enum: ['file', 'database'] })
  origin!: 'file' | 'database';

  @ApiProperty({ example: 2, nullable: true })
  version!: number | null;

  @ApiProperty({ example: 'Welcome to {{appName}}' })
  subject!: string;

  @ApiProperty({ example: 'Hello {{firstName}},' })
  text!: string;

  @ApiProperty({ example: '<p>Hello {{firstName}},</p>' })
  html!: string;

  @ApiPropertyOptional({
    example: '2026-01-31T09:15:00.000Z',
    description: 'When it was last saved. Absent for a shipped template.',
  })
  updatedAt?: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  updatedBy!: string | null;
}

/** One field an editor may interpolate. */
export class MailTemplateFieldDto {
  @ApiProperty({ example: 'firstName' })
  name!: string;

  @ApiProperty({ example: 'The name they registered with.' })
  description!: string;

  @ApiProperty({ example: 'Ada' })
  sample!: string | number | null;
}

/** The editor's view of a template: the source plus the contract it must satisfy. */
export class MailTemplateDetailDto extends MailTemplateResponseDto {
  @ApiPropertyOptional({
    type: [MailTemplateFieldDto],
    description:
      'The variables this template may interpolate. Anything else renders empty, ' +
      'so this is what the form offers rather than a free-text field list.',
  })
  fields?: MailTemplateFieldDto[];
}

/** A rendered preview, so an operator sees the result before saving. */
export class MailTemplatePreviewDto {
  @ApiProperty({ example: 'Welcome to Boilerplate' })
  subject!: string;

  @ApiProperty({ example: 'Hello Ada,\n\nYour Boilerplate account is ready.' })
  text!: string;

  @ApiProperty({ example: '<!doctype html>…' })
  html!: string;
}

/** What a preview was rendered from. */
export class MailTemplatePreviewResponseDto {
  @ApiProperty({ example: 'reset-password' })
  name!: string;

  @ApiProperty({ example: 'en' })
  locale!: string;

  @ApiProperty({
    example: 'database',
    enum: ['file', 'database'],
    description: 'Where the previewed source came from.',
  })
  origin!: 'file' | 'database';

  @ApiProperty({ type: MailTemplatePreviewDto })
  rendered!: MailTemplatePreviewDto;

  @ApiPropertyOptional({
    description:
      'The fields the template was rendered with, when sample data was used.',
  })
  data?: Record<string, unknown>;
}
