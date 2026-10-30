import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from './entities/client.entity.js';
import { ClientService } from './client.service.js';
import { OidcModule } from './oidc/oidc.module.js';
import { jwtConfig } from '../../config/jwt.config.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([Client]),
    PassportModule,
    JwtModule.registerAsync(jwtConfig.asProvider()),
    OidcModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, ClientService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}