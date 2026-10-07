import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { JwtPayload, RequestUser } from '../../../common/interfaces/index.js';
import { PermissionsService } from '../../users/permissions.service.js';
import { UsersService } from '../../users/index.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly permissionsService: PermissionsService,
  ) {
    const secretOrKey = configService.get<string>('jwtAccessToken.secret');

    if (!secretOrKey) {
      throw new Error('JWT access token secret is not configured');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey,
    });
  }

  async validate(payload: JwtPayload): Promise<RequestUser> {
    const user = await this.usersService.findById(payload.sub);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid access token');
    }

    // The one check that makes logout-everywhere immediate.
    //
    // A token with no `sv` predates the claim, and is accepted only while the
    // user is still at version zero, meaning nothing has ever asked for all their
    // sessions to die. The moment they do, the version moves and every token
    // without a claim is refused alongside the ones that carry a stale one.
    //
    // That is why the comparison is not simply "versions must be equal": a strict
    // equality would reject the un-claimed token of a user who never revoked
    // anything, which on deploy would sign out every signed-in user for a
    // fifteen minute token to have expired on its own anyway.
    const tokenVersion = payload.sv;
    const currentVersion = user.sessionsVersion ?? 0;

    if (
      tokenVersion === undefined
        ? currentVersion !== 0
        : tokenVersion !== currentVersion
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isManager: user.isManager,
      isActive: user.isActive,
      // Resolved here rather than in the guard so the lookup happens once per
      // request instead of once per guarded route. Phase 17b replaces this with a
      // cache read; the guard is written against the request user either way, so
      // that change does not touch it.
      permissions: await this.permissionsService.forRole(user.role),
    };
  }
}
