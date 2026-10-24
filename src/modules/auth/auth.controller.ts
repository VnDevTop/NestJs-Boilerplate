import { Throttle } from '@nestjs/throttler';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
  ApiAcceptedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

import { ThrottleByEmailGuard } from '../../common/guards/index.js';
import { Idempotent } from '@nestjs/idempotency';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import {
  DEVICE_NAME_HEADER,
  DEVICE_NAME_MAX_LENGTH,
  mailThrottleOptions,
} from '../../common/constants/index.js';
import {
  CurrentUser,
  DeviceName,
  Public,
  RequireVerifiedEmail,
} from '../../common/decorators/index.js';
import type { RequestUser } from '../../common/interfaces/index.js';
import {
  CursorPaginationQueryDto,
  type PaginatedResultDto,
} from '../../common/pagination/index.js';
import { UserResponseDto } from '../users/dto/index.js';
import {
  AuthSessionDto,
  AuthTokenResponseDto,
  ForgotPasswordDto,
  GenericMessageDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  TwoFactorChallengeResponseDto,
  TwoFactorCodeDto,
  TwoFactorEnabledResponseDto,
  TwoFactorLoginDto,
  TwoFactorSetupResponseDto,
  UserDeviceDto,
  VerifyEmailDto,
} from './dto/index.js';
import { AuthService, LoginResult } from './auth.service.js';
import { AuthToken, DeviceMetadata } from './types/index.js';

const DEVICE_NAME_API_HEADER = {
  name: DEVICE_NAME_HEADER,
  required: false,
  description:
    'Friendly name for this device, shown in the device list. ' +
    'Derived from the user agent when omitted.',
  schema: { type: 'string', maxLength: DEVICE_NAME_MAX_LENGTH },
};

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Registration is cheap to call and creates rows, so it gets its own
  // tighter budget than the global one.
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  // Registration is the clearest case in the application. A client that loses the
  // response to a register has a token it never saw and an account it cannot sign
  // into; retrying gets it a conflict, because the address now exists. The replayed
  // answer hands back the same tokens instead.
  @Idempotent({ required: true })
  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiOkResponse({ type: AuthTokenResponseDto })
  @ApiHeader(DEVICE_NAME_API_HEADER)
  register(
    @Body() registerDto: RegisterDto,
    @DeviceName() deviceName: string | null,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthToken> {
    return this.authService.register(
      registerDto,
      this.getMetadata(deviceName, ipAddress, userAgent),
    );
  }

  // Password guessing is the reason this route exists, so it is the
  // tightest limit in the app.
  @UseGuards(ThrottleByEmailGuard)
  @RateLimit('login')
  @Public()
  @Post('login')
  // 200, not the 201 a POST gets by default. A sign-in creates nothing; it
  // exchanges a credential for a token, and a client that branches on the status
  // reads 201 as "something was created". `@ApiOkResponse` already said 200 above
  // it, so the documentation and the wire disagreed.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiExtraModels(AuthTokenResponseDto, TwoFactorChallengeResponseDto)
  @ApiOkResponse({
    description:
      'Token pair, or a two-factor challenge when the account requires 2FA',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AuthTokenResponseDto) },
        { $ref: getSchemaPath(TwoFactorChallengeResponseDto) },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  @ApiHeader(DEVICE_NAME_API_HEADER)
  login(
    @Body() loginDto: LoginDto,
    @DeviceName() deviceName: string | null,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LoginResult> {
    return this.authService.login(
      loginDto,
      this.getMetadata(deviceName, ipAddress, userAgent),
    );
  }

  // A six digit code has a million combinations, so it must not be
  // brute forceable.
  @UseGuards(ThrottleByEmailGuard)
  @RateLimit('login')
  @Public()
  @Post('2fa/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a login that requires a second factor',
    description:
      'Exchanges a challenge token and a second factor for a token pair.',
  })
  @ApiOkResponse({ type: AuthTokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid challenge or code' })
  @ApiHeader(DEVICE_NAME_API_HEADER)
  twoFactorLogin(
    @Body() twoFactorLoginDto: TwoFactorLoginDto,
    @DeviceName() deviceName: string | null,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthToken> {
    return this.authService.twoFactorLogin(
      twoFactorLoginDto,
      this.getMetadata(deviceName, ipAddress, userAgent),
    );
  }

  // The two-factor routes are the ones that change how an account authenticates, so
  // they require a confirmed address. Turning on a second factor and then losing
  // access to the address is a lockout nobody can undo from the login screen.
  @RequireVerifiedEmail()
  @Post('2fa/setup')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Generate a two-factor secret',
    description:
      'Returns a secret, an otpauth URI and a QR code. Two-factor is not active until the setup is verified.',
  })
  @ApiOkResponse({ type: TwoFactorSetupResponseDto })
  twoFactorSetup(
    @CurrentUser() currentUser: RequestUser,
  ): Promise<TwoFactorSetupResponseDto> {
    return this.authService.twoFactorSetup(currentUser);
  }

  @Throttle({ default: { limit: 5, ttl: 300000 } })
  @RequireVerifiedEmail()
  @Post('2fa/verify')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Activate two-factor authentication',
    description:
      'Confirms the pending secret and returns single use recovery codes.',
  })
  @ApiOkResponse({ type: TwoFactorEnabledResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid verification code' })
  twoFactorVerify(
    @CurrentUser() currentUser: RequestUser,
    @Body() twoFactorCodeDto: TwoFactorCodeDto,
  ): Promise<TwoFactorEnabledResponseDto> {
    return this.authService.twoFactorVerify(currentUser, twoFactorCodeDto);
  }

  @RequireVerifiedEmail()
  @Post('2fa/disable')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disable two-factor authentication',
    description: 'Requires a valid code or a recovery code.',
  })
  @ApiNoContentResponse({ description: 'Two-factor authentication disabled' })
  @ApiUnauthorizedResponse({ description: 'Invalid verification code' })
  twoFactorDisable(
    @CurrentUser() currentUser: RequestUser,
    @Body() twoFactorCodeDto: TwoFactorCodeDto,
  ): Promise<void> {
    return this.authService.twoFactorDisable(currentUser, twoFactorCodeDto);
  }

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Public()
  /**
   * Always 202, never 200 or 404.
   *
   * The status is the same for a known and an unknown address on purpose. A
   * different status for a miss is an account enumeration oracle that needs no
   * timing analysis to read.
   */
  @UseGuards(ThrottleByEmailGuard)
  @RateLimit('mail')
  @Throttle(mailThrottleOptions())
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always returns 202 with the same message, whether or not an account ' +
      'exists for the address. Check the mailbox rather than the response.',
  })
  @ApiAcceptedResponse({ type: GenericMessageDto })
  @ApiTooManyRequestsResponse({
    description: 'Too many reset requests from this address',
  })
  forgotPassword(
    @Body() forgotPasswordDto: ForgotPasswordDto,
    @Ip() ipAddress: string,
  ): Promise<GenericMessageDto> {
    return this.authService.forgotPassword(forgotPasswordDto, ipAddress);
  }

  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Set a new password with a reset token',
    description:
      'The token is single use. On success every other session is signed out, ' +
      'including this device.',
  })
  @ApiAcceptedResponse({ type: GenericMessageDto })
  @ApiBadRequestResponse({
    description: 'The token is unknown, already used or expired',
  })
  @ApiTooManyRequestsResponse({
    description: 'Too many attempts',
  })
  resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
  ): Promise<GenericMessageDto> {
    return this.authService.resetPassword(resetPasswordDto);
  }

  /**
   * Public on purpose: the person clicking the link is not signed in yet, which
   * is exactly when an address needs confirming. The token is the credential.
   */
  @Throttle(mailThrottleOptions())
  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Confirm an email address with a token',
    description:
      'Single use. The account is usable before the address is confirmed.',
  })
  @ApiAcceptedResponse({ type: GenericMessageDto })
  @ApiBadRequestResponse({
    description: 'The token is unknown, already used or expired',
  })
  verifyEmail(
    @Body() verifyEmailDto: VerifyEmailDto,
  ): Promise<GenericMessageDto> {
    return this.authService.verifyEmail(verifyEmailDto);
  }

  @UseGuards(ThrottleByEmailGuard)
  @RateLimit('mail')
  @Throttle(mailThrottleOptions())
  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send another confirmation link',
    description:
      'Always 202 with the same message, whether the address is unknown, ' +
      'unverified or already confirmed.',
  })
  @ApiAcceptedResponse({ type: GenericMessageDto })
  @ApiTooManyRequestsResponse({
    description: 'Too many requests from this address',
  })
  resendVerification(
    @Body() resendVerificationDto: ResendVerificationDto,
    @Ip() ipAddress: string,
  ): Promise<GenericMessageDto> {
    return this.authService.resendVerification(
      resendVerificationDto,
      ipAddress,
    );
  }

  @RateLimit('refresh')
  // A refresh mints a new access token from a refresh token, so it is the one route
  // where an unconfirmed address would let an account nobody owns be kept alive
  // indefinitely.
  @RequireVerifiedEmail()
  @Post('refresh-token')
  // 200 for the same reason as login: a rotation replaces one token with another
  // and creates nothing a client can address afterwards.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Rotates the refresh token. The previous token is revoked and cannot be used again.',
  })
  @ApiOkResponse({ type: AuthTokenResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token is invalid, expired, revoked or reused',
  })
  refreshToken(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthToken> {
    return this.authService.refresh(
      refreshTokenDto,
      this.getMetadata(null, ipAddress, userAgent),
    );
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the refresh token of the current session' })
  @ApiNoContentResponse({ description: 'Session revoked successfully' })
  logout(@Body() logoutDto: LogoutDto): Promise<void> {
    return this.authService.logout(logoutDto);
  }

  @Post('logout-all')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke every refresh token and deactivate every device',
  })
  @ApiNoContentResponse({ description: 'All sessions revoked successfully' })
  logoutAll(@CurrentUser() currentUser: RequestUser): Promise<void> {
    return this.authService.logoutAll(currentUser);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiOkResponse({ type: UserResponseDto })
  me(@CurrentUser() currentUser: RequestUser): Promise<UserResponseDto> {
    return this.authService.getMe(currentUser);
  }

  /**
   * A page of the caller's active devices.
   *
   * Cursor paged, so the response size is set by `limit` rather than by how many
   * machines the account has accumulated. `meta.nextCursor` goes back as `cursor`.
   */
  @Get('devices')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List a page of the current user active devices' })
  @ApiOkResponse({ type: UserDeviceDto, isArray: true })
  devices(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResultDto<UserDeviceDto>> {
    return this.authService.listDevices(currentUser, query);
  }

  /**
   * Live sessions, one per refresh chain.
   *
   * Separate from `devices`, which lists machines. One device can hold more than
   * one session, and revoking them is not the same act: `devices/:id` ends every
   * session on the machine, `sessions/:id` ends one of them.
   *
   * Paged for the same reason, and with a sharper edge: sessions are *created* by
   * using the application, so a client that walks a list without a bound is the
   * normal case rather than an accident.
   */
  @Get('sessions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List a page of the current user live sessions' })
  @ApiOkResponse({ type: AuthSessionDto, isArray: true })
  sessions(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResultDto<AuthSessionDto>> {
    return this.authService.listSessions(currentUser, query);
  }

  /**
   * Revokes one session.
   *
   * Scoped to the caller's own sessions: an id that is not one of theirs is a 404,
   * which is deliberately indistinguishable from one that does not exist. Answering
   * "not yours" would confirm that somebody else's session id is real.
   */
  @Delete('sessions/:id')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one session, leaving the others alone' })
  @ApiNoContentResponse({ description: 'Session revoked' })
  @ApiNotFoundResponse({ description: 'Session not found' })
  revokeSession(
    @CurrentUser() currentUser: RequestUser,
    @Param('id') sessionId: string,
  ): Promise<void> {
    return this.authService.revokeSession(currentUser, sessionId);
  }

  @Delete('devices/:id')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a device and every refresh token attached to it',
  })
  @ApiNoContentResponse({ description: 'Device revoked successfully' })
  @ApiNotFoundResponse({ description: 'Device not found' })
  revokeDevice(
    @CurrentUser() currentUser: RequestUser,
    @Param('id') deviceId: string,
  ): Promise<void> {
    return this.authService.revokeDevice(currentUser, deviceId);
  }

  private getMetadata(
    deviceName: string | null,
    ipAddress: string,
    userAgent?: string,
  ): DeviceMetadata {
    return {
      deviceName,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    };
  }
}
