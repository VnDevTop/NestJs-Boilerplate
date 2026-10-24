import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import {
  Audited,
  CurrentUser,
  Permissions,
  RequireVerifiedEmail,
  Roles,
} from '../../common/decorators/index.js';
import { Idempotent } from '@nestjs/idempotency';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import type { RequestUser } from '../../common/interfaces/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
  UserResponseDto,
  UserSearchDto,
  UserSearchResultDto,
} from './dto/index.js';
import type { PaginatedResultDto } from '../../common/pagination/index.js';
import { ExportService, type ExportFormat } from './export/export.service.js';
import { UsersService } from './users.service.js';

@ApiTags('Users')
@ApiBearerAuth('access-token')
// Bound at the controller, deciding per route from `@Audited()`. A route in here
// without the decorator is still unaudited — `audit-policy.spec.ts` reads the real
// handler metadata to catch that, for the same reason the verified-email gate has
// one: a convention nobody checks is a convention that erodes.
@UseInterceptors(AuditInterceptor)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly exportService: ExportService,
  ) {}

  // Idempotent because a retry here creates a second person. The client's retry is
  // the honest reason: it timed out, it does not know whether the first one landed,
  // and without this it has no way to find out without issuing a second POST.
  @Idempotent({ required: true })
  @Audited({
    action: 'users.create',
    targetType: 'user',
    // A create only learns the id from what it created.
    targetIdFrom: ['result'],
  })
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserWrite)
  @Post()
  @ApiOperation({ summary: 'Create a user' })
  @ApiOkResponse({ type: UserResponseDto })
  // The service returns the entity, because it is the only writer of
  // `users.password` and `register` needs the digest it produced for the
  // password history. Mapping to the response DTO here keeps the hash off the
  // wire and out of the audit row's `after` snapshot.
  async create(@Body() createUserDto: CreateUserDto): Promise<UserResponseDto> {
    const user = await this.usersService.create(createUserDto);

    return UserResponseDto.fromEntity(user);
  }

  /**
   * The users that match a search, best first.
   *
   * **A POST, because a search is a body.** The query is a sentence somebody
   * typed, and a sentence has spaces, quotes, brackets and colons in it — all
   * of which have to be escaped in a URL and all of which are wrong in one. The
   * body also has room for the facets, which do not fit in a path.
   *
   * **Not idempotency-keyed, because it changes nothing.** A read that asked for
   * a key would make every search box carry a header it has no reason to send,
   * and the guard is for writes — a request that creates a second thing.
   *
   * **Gated on `user:read`,** which is the permission to read a user record.
   * The search reads user records and finds them by name, and the permission
   * that says a caller may read a user record is the one that says they may
   * find one.
   */
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserRead)
  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search users',
    description:
      'The best matches for a query, and the counts of the matching rows per ' +
      'facet. A bare word searches the address, the names and the role; ' +
      '`email:ada`, `"ada lovelace"` and `role:admin` narrow it.',
  })
  @ApiOkResponse({ type: UserSearchResultDto })
  search(@Body() body: UserSearchDto): Promise<UserSearchResultDto> {
    return this.usersService.search(body);
  }

  /**
   * A page of users.
   *
   * **Cursor paged, and the sort is declared rather than free-text.** Both are
   * enforced in the service against an allow-list, so a request cannot name a
   * column this route does not offer.
   *
   * The body is still the array it always was — `ResponseTransformInterceptor`
   * lifts `meta` to the top of the envelope — so a client reading `data` needs no
   * change. A client that wants a second page reads `meta.nextCursor` and passes
   * it back verbatim.
   */
  @Roles(Role.Admin, Role.SuperAdmin)
  @Get()
  @ApiOperation({
    summary: 'List users',
    description:
      'Cursor paged. Pass `meta.nextCursor` back as `cursor` for the next page. ' +
      'The response carries no total on purpose — `meta.hasMore` is the honest ' +
      'answer, and a total would change under a client walking the list.',
  })
  @ApiOkResponse({ type: UserResponseDto, isArray: true })
  findAll(
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedResultDto<UserResponseDto>> {
    return this.usersService.findAll(query);
  }

  /**
   * Everything held about the caller, as CSV or JSON.
   *
   * **`?format=` rather than the `Accept` header.** Both are legitimate ways to ask
   * for a representation, and this is a download rather than a document a client
   * renders: a browser following `Accept` would pick JSON and then try to display
   * newline-delimited JSON as one broken page. A query parameter says what the file
   * is without a content negotiation the caller has to win.
   *
   * **Confirmed address required.** An export is everything held about a person, and
   * for this application that includes the ip addresses they signed in from and the
   * user agents they used. Serving it to an account whose address was never verified
   * would hand that list to whoever registered it — the same reasoning as the
   * erasure route, and for the same reason.
   *
   * **No administrator can fetch it for somebody else.** Not a permission, not a
   * path parameter: this endpoint reads the caller's own id and has no way to be
   * pointed at another one. A support agent who needs to see a user's data asks the
   * user for their export, which is also what most privacy regimes require.
   *
   * **Streamed straight to the response.** `StreamableFile` pipes TypeORM's cursor
   * rather than collecting it, so the largest accounts — the ones with the most to
   * export — are the ones that work.
   */
  @RequireVerifiedEmail()
  @Get('me/export')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Download everything held about this account',
    description:
      'CSV or newline-delimited JSON, streamed. Contains no credential: ' +
      'no password, no two-factor secret, no recovery code, no token, and ' +
      'no password hash.',
  })
  @ApiProduces('text/csv', 'application/x-ndjson')
  @ApiOkResponse({ description: 'The export, as a download' })
  export(
    @CurrentUser() currentUser: RequestUser,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): StreamableFile {
    const chosen: ExportFormat = format === 'json' ? 'json' : 'csv';

    response.setHeader(
      'Content-Type',
      chosen === 'json' ? 'application/x-ndjson' : 'text/csv',
    );
    // A filename, so the file a browser saves is recognisable rather than called
    // `export`. `attachment` because the content is a subject's whole record and
    // rendering it in a tab is never what anybody wants.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="account-export-${currentUser.id}.${chosen}"`,
    );

    return new StreamableFile(
      this.exportService.stream(currentUser.id, chosen),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user profile by id' })
  @ApiOkResponse({ type: UserResponseDto })
  findProfile(@Param('id') id: string): Promise<UserResponseDto> {
    return this.usersService.findProfileById(id);
  }

  @Audited({
    action: 'users.update',
    targetType: 'user',
    targetIdFrom: [['param', 'id']],
  })
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserWrite)
  @Patch(':id')
  @ApiOperation({ summary: 'Update a user' })
  @ApiOkResponse({ type: UserResponseDto })
  update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.usersService.update(id, updateUserDto);
  }

  // A retry after a lost 204 answers 404, which a client reads as "the delete
  // failed" when in fact it is the second delete. This is the exact confusion the
  // header exists to remove.
  @Idempotent({ required: true })
  @Audited({
    action: 'users.delete',
    targetType: 'user',
    targetIdFrom: [['param', 'id']],
    // A 204 has nothing to diff, and diffing it would store an empty object that
    // reads as "nothing changed" rather than "the row is gone".
    diffResponse: false,
  })
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserDelete)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a user' })
  @ApiNoContentResponse({ description: 'User deleted successfully' })
  remove(
    @Param('id') id: string,
    @CurrentUser() currentUser: RequestUser,
  ): Promise<void> {
    // The caller is passed through so the notification names who did it. An alert
    // reading "account deleted" is half the information; one naming an
    // administrator is the other half, and it is the difference between a routine
    // offboarding and an incident.
    return this.usersService.softDelete(id, currentUser.email);
  }
}
