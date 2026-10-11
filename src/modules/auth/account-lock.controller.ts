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
  CurrentUser,
  Permissions,
  Public,
  RateLimit,
  Roles,
} from '../../common/decorators/index.js';
import type { RequestUser } from '../../common/interfaces/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { mailThrottleOptions } from '../../common/constants/index.js';
import { ThrottleByEmailGuard } from '../../common/guards/index.js';
import { GenericMessageDto } from './dto/generic-message.dto.js';
import { RequestUnlockDto } from './dto/request-unlock.dto.js';
import { AccountLockService } from './account-lock.service.js';

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
export class AccountLockController {
  constructor(private readonly accountLock: AccountLockService) {}

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
