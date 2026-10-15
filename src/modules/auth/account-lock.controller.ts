import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import {
  Audited,
  CurrentUser,
  Permissions,
  Public,
  RateLimit,
  RequireVerifiedEmail,
  Roles,
} from '../../common/decorators/index.js';
import type { RequestUser } from '../../common/interfaces/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { mailThrottleOptions } from '../../common/constants/index.js';
import { ThrottleByEmailGuard } from '../../common/guards/index.js';
import { GenericMessageDto } from './dto/generic-message.dto.js';
import { RequestErasureDto } from './dto/request-erasure.dto.js';
import { UsersService } from '../users/users.service.js';
import { RequestUnlockDto } from './dto/request-unlock.dto.js';
import { AccountLockService } from './account-lock.service.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';

/**
 * The permanent lockout's three routes, together.
 *
 * In the auth module rather than the users module for one concrete reason: clearing
 * a lock has to clear the redis failure count as well as the row, and
 * `LoginLockoutService` lives here. Putting the admin route in `users` would mean
 * `UsersModule` importing `AuthModule`, which imports it right back.
 *
 * **Two public routes, one administrative.** The public pair is the owner's own way
 * out; the admin route is the fallback for when the address is gone. Both end in
 * `AccountLockService`, so there is one place where a lock is cleared and one place
 * where the failure count is cleared with it.
 */
@ApiTags('Auth')
@Controller('auth/account')
// Bound at the controller, like `UsersController`, because it costs nothing on the
// routes that carry no `@Audited`: the interceptor returns `next.handle()`
// untouched when the metadata is absent, without reading the request or the
// database.
//
// This binding is load-bearing rather than decorative. `POST /erasure` has
// carried `@Audited` since it was written, and nothing ever read the metadata,
// because the interceptor was never attached — so a right-to-erasure, the most
// sensitive event in a privacy workflow, left no audit row at all. The decorator
// was documentation of an intention that no test could catch: `audit-policy.spec`
// reads handler metadata and asserts the action names are right, and it passes
// just as happily on metadata that will never be consumed.
@UseInterceptors(AuditInterceptor)
export class AccountLockController {
  constructor(
    private readonly accountLock: AccountLockService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Asks for the link that clears a lock.
   *
   * Throttled like `forgot-password`, and for the same reason: it sends mail to an
   * address a caller supplied, so an unbounded route is a way to fill somebody's
   * inbox through this application.
   *
   * The response never varies. An address nobody registered, an account that is not
   * locked and an account whose address was never confirmed all get the same
   * message, because a caller who can tell those apart learns which addresses
   * exist and which accounts are in trouble.
   */
  @UseGuards(ThrottleByEmailGuard)
  @RateLimit('mail')
  @Throttle(mailThrottleOptions())
  @Public()
  @Post('unlock')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a link that clears a permanent lockout',
    description:
      'Sent to the confirmed address on the account. The response is the same ' +
      'whether or not the address has an account and whether or not it is ' +
      'locked, so it cannot be used to find out who has one.',
  })
  @ApiOkResponse({ type: GenericMessageDto })
  async requestUnlock(
    @Body() requestUnlockDto: RequestUnlockDto,
  ): Promise<GenericMessageDto> {
    await this.accountLock.requestUnlock(requestUnlockDto.email);

    const generic = new GenericMessageDto();
    generic.message =
      'If an account exists for that address and is locked, an unlock link is ' +
      'on its way.';

    return generic;
  }

  /**
   * Clears the lock behind an emailed link.
   *
   * The token in the path is the credential, so this is `@Public()` for the same
   * reason `verify-email` is: the person clicking the link is not signed in, and
   * that is the whole point of the link.
   */
  @Public()
  @Post('unlock/:token')
  @ApiOperation({
    summary: 'Clear a permanent lockout with an emailed token',
    description:
      'Single use, and the same message for an unknown, expired and spent ' +
      'token so a caller cannot tell which tokens were ever issued.',
  })
  @ApiOkResponse({ type: GenericMessageDto })
  async unlock(@Param('token') token: string): Promise<GenericMessageDto> {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new BadRequestException(
        'This unlock link is invalid or has expired',
      );
    }

    await this.accountLock.unlockWithToken(token);

    const generic = new GenericMessageDto();
    generic.message = 'Your account is unlocked. You can sign in again.';

    return generic;
  }

  /**
   * Asks for this account to be erased.
   *
   * **Confirmed address required**, and that is the whole security of the route.
   * An erasure is not reversible by the person who asked for it once the grace
   * period ends, so a request from an account whose address was never verified is
   * a request from somebody who cannot prove the inbox is theirs — and that is
   * exactly the shape of an attack: sign somebody up with their address, erase the
   * account they cannot get into.
   *
   * Soft, not immediate. The row stays for `RETENTION_SOFT_DELETED_USERS_DAYS` so
   * an operator can reverse a deletion made in anger. That is why this is a
   * `POST` and not a `DELETE`: it starts a process rather than performing an act.
   */
  @RequireVerifiedEmail()
  @Audited({
    action: 'users.erasure.requested',
    targetType: 'user',
    targetIdFrom: ['user'],
    diffResponse: false,
  })
  @Post('erasure')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Ask for this account to be erased',
    description:
      'Soft deletes the account now and hard deletes it at the end of the ' +
      'retention window. Notification preferences are removed immediately.',
  })
  @ApiOkResponse({ type: GenericMessageDto })
  async requestErasure(
    @CurrentUser() currentUser: RequestUser,
    @Body() body: RequestErasureDto,
  ): Promise<GenericMessageDto> {
    await this.usersService.requestDeletion(
      currentUser.id,
      body.reason ?? 'requested by the account owner',
      'the account owner',
    );

    const generic = new GenericMessageDto();
    generic.message =
      'Your account has been marked for deletion. You can restore it by ' +
      'contacting support before the retention window closes.';

    return generic;
  }

  /**
   * Clears somebody else's lock.
   *
   * `UserWrite` rather than a permission of its own: this is the same authority as
   * editing a user, and a dedicated permission would be one more grant an
   * administrator has to remember to hand out before they can do their job.
   */
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserWrite)
  @Patch(':id/unlock')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Clear a lockout on an account',
    description:
      'The operator route: for when the confirmed address is gone and the ' +
      'owner cannot use the emailed link.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: GenericMessageDto })
  async unlockById(
    @Param('id') id: string,
    @CurrentUser() currentUser: RequestUser,
  ): Promise<GenericMessageDto> {
    await this.accountLock.clear(id, currentUser.email);

    const generic = new GenericMessageDto();
    generic.message = 'The account is unlocked and has been told so.';

    return generic;
  }
}
