import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { JwtPayload, RequestUser } from '../../../common/interfaces/index.js';
import { PermissionsService } from '../../users/permissions.service.js';
import { UsersService } from '../../users/index.js';
import { DeviceService } from '../device.service.js';
import { RefreshTokenService } from '../refresh-token.service.js';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly permissionsService: PermissionsService,
    private readonly deviceService: DeviceService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly tenantContext: TenantContextService = new TenantContextService(),
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

    // A permanently locked account stops here, and this is the check that makes
    // the word "permanent" mean anything.
    //
    // Locking also bumps the sessions version, so every token minted before the
    // lock is already refused by the comparison below. This line is not redundant
    // with that: the version check has an explicit exception for tokens predating
    // the claim, and a lock must have no such exception — a lock that left one
    // fifteen minute window open would be an outage with extra steps, and the
    // window is exactly when an attacker who already holds a token is using it.
    //
    // 401 rather than 403 on purpose. The caller did present a credential, and the
    // distinction between "your token is no good" and "your account is locked"
    // tells an attacker which of the two they are dealing with; the owner learns
    // the reason from the mail that came with the lock.
    if (user.lockedAt !== null) {
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

    // The per-device half of the revocation check, and the reason logout can
    // leave the other machines alone.
    //
    // Only reached when the token names a device. A token minted before this
    // claim existed carries neither and skips straight past, which is what keeps
    // a deploy from signing everybody out.
    if (payload.did !== undefined) {
      await this.assertDeviceSession(user.id, payload.did, payload.dv);
    }

    // The session half. `DELETE /auth/sessions/:id` revokes one refresh token, and
    // without this the access token already minted from it keeps working until it
    // expires on its own.
    //
    // Skipped for a token that names no session, which is every token minted before
    // this claim existed. Reading an absent claim as "no session, nothing to
    // check" is what keeps a deploy from signing everybody out.
    if (payload.sid !== undefined) {
      await this.assertSessionLive(payload.sid);
    }

    const current = this.tenantContext.current();

    if (
      payload.tenantId !== undefined &&
      current !== undefined &&
      payload.tenantId !== current.id
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
      // From the row, not the token: confirming an address must take effect on the
      // next request rather than when a fifteen minute token expires.
      isEmailVerified: user.isEmailVerified,
      tenantId: payload.tenantId ?? current?.id,
    };
  }

  /**
   * Refuses a token whose device has been signed out.
   *
   * Two ways to fail, and the second is the one that matters. A version behind
   * the device is the ordinary case: this device was signed out. A device that is
   * **absent** from the map is refused too, because that is what a deleted device
   * looks like from here. Treating absence as "nothing to check" would let a
   * device that retention removed last night keep its token this morning.
   */
  /**
   * Refuses a token whose session has been revoked.
   *
   * A miss is not a pass and a miss is not a fail either: it means no revocation
   * was ever recorded for this session, which is the normal case. The entry is
   * written by the revoke and expires on its own once every access token it could
   * have stopped has expired, so there is nothing to clean up and nothing that can
   * be resurrected by the cache emptying.
   */
  private async assertSessionLive(sessionId: string): Promise<void> {
    if (await this.refreshTokenService.isSessionRevoked(sessionId)) {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async assertDeviceSession(
    userId: string,
    deviceId: string,
    tokenVersion: number | undefined,
  ): Promise<void> {
    const versions = await this.deviceService.findSessionVersions(userId);
    const currentVersion = versions[deviceId];

    if (currentVersion === undefined) {
      throw new UnauthorizedException('Invalid access token');
    }

    // A token with no version predates the column, and is accepted only while the
    // device is still at zero. Strict equality would refuse it, signing out
    // every device that has never been revoked from, on deploy.
    const current = currentVersion ?? 0;
    const presented = tokenVersion === undefined ? 0 : tokenVersion;

    if (presented !== current) {
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
