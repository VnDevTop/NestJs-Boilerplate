import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ManagerOnly, Permissions } from '../../common/decorators/index.js';
import { Permission } from '../../common/enums/index.js';
import { PaginatedResultDto } from '../../common/pagination/index.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLogDto } from '../audit/dto/audit-log.dto.js';
import { AuditQueryDto } from '../audit/dto/audit-query.dto.js';

/**
 * The audit trail, read.
 *
 * **In the admin module rather than beside the trail.** Every `/admin/` route
 * lives here, and this one is about the application's own operations rather than
 * about its data. The audit module owns the trail, the entity and the query
 * surface; this owns the route that exposes them — the same split the retention
 * routes have.
 *
 * ## Who may read it, and why that is not the same question as who may manage
 *
 * **`@ManagerOnly()` and `audit:read` are both here, and they are not the same
 * gate.**
 *
 * `isManager` is a column on the user row, and an administrator can set it on
 * any account through `PATCH /users/:id`. So the manager check is a flag the
 * people this route reports on can hand out — and a route whose gate can be
 * widened by its own subjects is not a gate.
 *
 * `audit:read` is the real one, and it is held by the super administrator
 * alone. The trail records what every privileged actor did, including the
 * failures, and reading it is reading the conduct of the operators rather than
 * the data of the users. An administrator already holds `UserRead`, so the
 * personal data in the snapshots is not new to them; what is new is seeing
 * their peers' attempts, refused ones included.
 *
 * **The cost is stated rather than hidden.** An ordinary administrator
 * investigating an incident needs an escalation, because the trail is the one
 * surface that describes what the operators did. That is the right default for
 * the only read surface that describes the people who hold the keys, and the
 * escalation is one request to one person.
 */
@ApiTags('Admin Audit')
@ApiBearerAuth('access-token')
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * A page of the trail.
   *
   * **Cursor paged.** Pass `meta.nextCursor` back as `cursor` for the next page.
   * The response carries no total on purpose — `meta.hasMore` is the honest
   * answer, and a count over a year of rows is a second query that goes stale
   * between the two.
   *
   * **The four axes of an investigation are filters**: who did it (`actorId`,
   * `actorEmail`, `actorType`), what they did (`action`), what they did it to
   * (`targetType`, `targetId`) and when (`from`, `to`). `outcome` and
   * `requestId` are there because a refused request is evidence and because the
   * request id is what ties a row to the log lines of the same request.
   */
  @ManagerOnly()
  @Permissions(Permission.AuditRead)
  @Get()
  @ApiOperation({
    summary: 'Read the audit trail',
    description:
      'Cursor paged. Pass `meta.nextCursor` back as `cursor` for the next page. ' +
      'Filter by actor, action, target, outcome and window.',
  })
  @ApiOkResponse({ type: AuditLogDto, isArray: true })
  findAll(
    @Query() query: AuditQueryDto,
  ): Promise<PaginatedResultDto<AuditLogDto>> {
    return this.auditService.list(query);
  }
}
