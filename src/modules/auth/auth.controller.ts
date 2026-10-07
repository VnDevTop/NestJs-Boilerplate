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
} from '../../common/decorators/index.js';
import type { RequestUser } from '../../common/interfaces/index.js';
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
  @Post('refresh-token')
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

  @Get('devices')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List the active devices of the current user' })
  @ApiOkResponse({ type: UserDeviceDto, isArray: true })
  devices(@CurrentUser() currentUser: RequestUser): Promise<UserDeviceDto[]> {
    return this.authService.listDevices(currentUser);
  }

  /**
   * Live sessions, one per refresh chain.
   *
   * Separate from `devices`, which lists machines. One device can hold more than
   * one session, and revoking them is not the same act: `devices/:id` ends every
   * session on the machine, `sessions/:id` ends one of them.
   */
  @Get('sessions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List the current user live sessions' })
  @ApiOkResponse({ type: AuthSessionDto, isArray: true })
  sessions(@CurrentUser() currentUser: RequestUser): Promise<AuthSessionDto[]> {
    return this.authService.listSessions(currentUser);
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
