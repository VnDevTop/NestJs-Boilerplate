import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ClientCredentialsDto } from './dto/client-credentials.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  logout(@Req() req: { user: { id: string } }) {
    return this.authService.logout(req.user.id);
  }

  @Post('token')
  token(@Body() dto: ClientCredentialsDto) {
    if (dto.grant_type !== 'client_credentials') {
      throw new UnauthorizedException('Unsupported grant type');
    }
    return this.authService.clientCredentials(dto.client_id, dto.client_secret, dto.scope);
  }

  @Post('keys/rotate')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('admin')
  rotateKeys() {
    return this.authService.rotateSigningKey();
  }
}