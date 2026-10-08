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
    // Through the cache rather than `findById`, which is the one query per
    // request this phase removes. The claims it returns are a projection without
    // the password hash, because nothing here needs it.
    const user = await this.usersService.findAuthClaims(payload.sub);

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
    // Also defaulted here, not only in `findAuthClaims`, because redis outlives a
    // deploy: an entry written by the build before that method existed carries no
    // version at all, and reading it as anything other than zero would refuse
    // every request that lands on it during the next minute.
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
      // request instead of once per guarded route. Cached per role from Phase
      // 17b; the guard is written against the request user, so it does not care
      // where the names came from.
      permissions: await this.permissionsService.forRole(user.role),
    };
  }
}
