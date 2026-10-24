import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { Audited, Permissions } from '../../common/decorators/index.js';
import { Idempotent } from '@nestjs/idempotency';
import { Permission } from '../../common/enums/index.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { MailTemplateStore } from '../mail/mail-template.store.js';
import { loadShippedTemplate } from '../mail/templates/shipped-templates.js';
import {
  editableFields,
  sampleData,
  type TemplateField,
} from '../mail/templates/template-fields.js';
import {
  TEMPLATE_NAMES,
  hasTemplate,
  type TemplateName,
} from '../mail/templates/template.registry.js';
import {
  MailTemplateDetailDto,
  MailTemplatePreviewResponseDto,
  MailTemplateResponseDto,
  UpdateMailTemplateDto,
} from './dto/index.js';

/**
 * Editing a transactional email in the running application.
 *
 * ## Why the route exists
 *
 * Before Phase 22 the only way to change a welcome email was a commit and a deploy.
 * That is the right default for a boilerplate — the templates are code, they are
 * reviewed in a diff — and it is what makes this an opt-in surface rather than a
 * replacement. An operator who never calls this gets the templates that shipped.
 *
 * ## Why an edit is audited
 *
 * A template is the wording of a security message. Whoever changes "If this was not
 * you, no action is needed" changes what an attacker's target reads before clicking,
 * and an audit trail that does not record it leaves the most consequential string in
 * the application unattributable.
 *
 * ## The write path cannot make a broken email
 *
 * `MailTemplateStore.save` refuses a template that contains a triple-brace expression
 * or does not compile, so what is stored is what the next send renders. The preview
 * route exists so an operator finds that out before saving rather than after.
 */
@ApiTags('Admin')
@UseInterceptors(AuditInterceptor)
@Controller('admin/mail-templates')
export class AdminMailTemplatesController {
  constructor(private readonly templates: MailTemplateStore) {}

  /**
   * Every template, whether or not it has been overridden.
   *
   * The shipped ones are listed alongside the stored ones because an operator
   * choosing what to edit needs to see what exists, not only what somebody has
   * already touched.
   */
  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List every mail template and where each one resolves from',
  })
  @ApiOkResponse({ type: [MailTemplateResponseDto] })
  @Permissions(Permission.MailTemplateRead)
  async list(): Promise<MailTemplateResponseDto[]> {
    return Promise.all(TEMPLATE_NAMES.map((name) => this.summarise(name)));
  }

  /**
   * One template: its source, where it came from, and the fields it may use.
   *
   * The field list is the data contract made visible. An editor that interpolates
   * something not on it renders an empty string, which produces an email with a hole
   * in it that nobody notices until a user reports it.
   */
  @Get(':name')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Read one template, with the fields it may interpolate',
  })
  @ApiParam({ name: 'name', enum: TEMPLATE_NAMES })
  @ApiOkResponse({ type: MailTemplateDetailDto })
  @Permissions(Permission.MailTemplateRead)
  async read(
    @Param('name') name: string,
    @Query('locale') locale?: string,
  ): Promise<MailTemplateDetailDto> {
    const templateName = this.resolveName(name);
    const targetLocale = this.resolveLocale(locale);
    const row = await this.templates.stored(templateName, targetLocale);
    const resolved = await this.templates.resolve(templateName, targetLocale);

    return {
      ...resolved,
      name: templateName,
      locale: targetLocale,
      updatedAt: row?.updatedAt.toISOString(),
      updatedBy: row?.updatedBy ?? null,
      fields: editableFields(templateName) as TemplateField[],
    };
  }

  /**
   * Renders a candidate template against sample data and returns the result.
   *
   * This is the route that makes the feature safe to use. Without it an operator
   * saves an edit and learns it was broken from a customer's support ticket, because
   * nothing else in the flow reports a bad template back to whoever wrote it.
   *
   * Nothing is persisted, and the escaping rules are the same ones the send path
   * applies — so a preview that renders is a preview of what will actually go out,
   * rather than a second, more forgiving renderer.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Render a template against sample data without saving it',
  })
  @ApiOkResponse({ type: MailTemplatePreviewResponseDto })
  @Permissions(Permission.MailTemplateRead)
  async preview(
    @Body() body: UpdateMailTemplateDto & { name?: string },
  ): Promise<MailTemplatePreviewResponseDto> {
    const name = this.resolveName(body.name ?? '');
    const locale = this.resolveLocale(body.locale);

    const rendered = await this.templates.renderPreview(name, {
      subject: body.subject,
      text: body.text,
      html: body.html,
    });

    return {
      name,
      locale,
      origin: 'database',
      rendered,
      data: sampleData(name),
    };
  }

  /**
   * Stores a template, preserving the version it replaces.
   *
   * Idempotent because a client that loses the response has no way to confirm what it
   * saved without sending it all again, and `version` is what makes a second attempt
   * safe to recognise rather than apply twice.
   */
  @Idempotent({ required: true })
  @Audited({
    action: 'templates.mail.update',
    targetType: 'mail-template',
    // From the path, not the body: the name is a path parameter on every other route
    // here, and `AuditTargetSource` reads the request's params. Reading it from the
    // body would work for the audit entry and then diverge from every other policy.
    targetIdFrom: [['param', 'name']],
    // The response is the template, so the audit diff records the new wording. The
    // old wording is in `mail_template_versions`, which is why that table exists
    // rather than the audit row carrying a reconstructed before-state.
    diffResponse: true,
  })
  @Put(':name')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Replace a template, keeping the version it replaces',
  })
  @ApiParam({ name: 'name', enum: TEMPLATE_NAMES })
  @ApiOkResponse({ type: MailTemplateResponseDto })
  @Permissions(Permission.MailTemplateWrite)
  async replace(
    @Param('name') name: string,
    @Body() body: UpdateMailTemplateDto,
    @Query('locale') locale?: string,
  ): Promise<MailTemplateResponseDto> {
    const templateName = this.resolveName(name);
    const targetLocale = this.resolveLocale(locale);

    if (body.version !== undefined) {
      const current = await this.templates.stored(templateName, targetLocale);

      // A stored template whose version has moved on means somebody else saved in
      // between. Refusing is cheaper than a merge rule, and the operator can re-read
      // and decide which wording should win.
      if (current && current.version !== body.version) {
        throw new ConflictException(
          `The ${templateName} template is at version ${current.version}, not ` +
            `${body.version}. Read it again and reapply the edit.`,
        );
      }

      // No row at all but a version was sent: the template was reset to the shipped
      // file, and the edit the operator was looking at no longer exists to build on.
      if (!current && body.version > 1) {
        throw new ConflictException(
          `The ${templateName} template has no stored version, so version ` +
            `${body.version} cannot be replaced. Read it again and reapply the edit.`,
        );
      }
    }

    const saved = await this.templates
      .save({
        name: templateName,
        locale: targetLocale,
        subject: body.subject,
        text: body.text,
        html: body.html,
        updatedBy: null,
      })
      // A refused template is bad input, not a server fault. `save` throws a plain
      // `Error`, which Nest reports as a 500, and an operator whose edit was
      // refused because of a triple-brace deserves the message that says so rather
      // than an internal error they cannot act on.
      .catch((error: unknown) => {
        throw new BadRequestException(
          error instanceof Error ? error.message : String(error),
        );
      });

    return {
      name: saved.name,
      locale: saved.locale,
      origin: 'database',
      version: saved.version,
      subject: saved.subject,
      text: saved.text,
      html: saved.html,
      updatedAt: saved.updatedAt.toISOString(),
      updatedBy: saved.updatedBy,
    };
  }

  /**
   * Puts a template back to the shipped file.
   *
   * A delete rather than a copy of the file's contents into the row, so that a later
   * change to the file takes effect. That is the whole reason the file is a fallback
   * and not only a seed.
   */
  @Idempotent({ required: true })
  @Audited({
    action: 'templates.mail.reset',
    targetType: 'mail-template',
    targetIdFrom: [['param', 'name']],
  })
  @Delete(':name')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Go back to the template that shipped with the application',
  })
  @ApiParam({ name: 'name', enum: TEMPLATE_NAMES })
  @ApiOkResponse({ type: MailTemplateResponseDto })
  @Permissions(Permission.MailTemplateWrite)
  async reset(
    @Param('name') name: string,
    @Query('locale') locale?: string,
  ): Promise<MailTemplateResponseDto> {
    const templateName = this.resolveName(name);
    const targetLocale = this.resolveLocale(locale);

    const existing = await this.templates.stored(templateName, targetLocale);

    if (!existing) {
      throw new NotFoundException(
        `The ${templateName} template is already the shipped one for ${targetLocale}.`,
      );
    }

    // Preserved before the delete, so "what did it say before I reset it" is
    // answerable from the history rather than only from the log.
    await this.templates.save({
      name: templateName,
      locale: targetLocale,
      subject: existing.subject,
      text: existing.text,
      html: existing.html,
      updatedBy: null,
    });

    await this.templates.reset(templateName, targetLocale);

    const shipped = loadShippedTemplate(templateName)!;

    return {
      name: templateName,
      locale: targetLocale,
      origin: 'file',
      version: null,
      subject: shipped.subject,
      text: shipped.text,
      html: shipped.html,
      updatedBy: null,
    };
  }

  private async summarise(
    name: TemplateName,
  ): Promise<MailTemplateResponseDto> {
    const resolved = await this.templates.resolve(name);
    const row = await this.templates.stored(name);

    return {
      name,
      locale: 'en',
      origin: resolved.origin,
      version: resolved.version,
      subject: resolved.subject,
      text: resolved.text,
      html: resolved.html,
      updatedAt: row?.updatedAt.toISOString(),
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /**
   * Turns a path parameter into a template name, or refuses it.
   *
   * The name is a key into the code registry, not a database key, so an unknown one
   * has no row and no file. A 404 rather than a 400 because from the caller's side it
   * is a missing resource, and because a route that accepted an arbitrary name would
   * let a caller write a template nothing ever sends.
   */
  private resolveName(name: string): TemplateName {
    if (!hasTemplate(name)) {
      throw new NotFoundException(
        `No mail template named "${name}". Known templates: ${TEMPLATE_NAMES.join(', ')}.`,
      );
    }

    return name;
  }

  private resolveLocale(locale?: string): string {
    return locale ?? 'en';
  }
}
