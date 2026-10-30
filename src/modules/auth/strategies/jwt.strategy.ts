import { Injectable } from '@nestjs/common';

import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtKeyService } from '../jwt-key.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(jwtKeyService: JwtKeyService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      secretOrKeyProvider: (_request, rawJwtToken, done) => {
        void (async () => {
          try {
            const [headerSegment] = rawJwtToken.split('.');
            const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8')) as {
              kid?: string;
            };
            if (!header.kid) {
              done(new Error('Missing kid'));
              return;
            }
            const key = await jwtKeyService.findByKid(header.kid);
            if (!key) {
              done(new Error('Unknown signing key'));
              return;
            }
            done(null, key.publicKey);
          } catch (error) {
            done(error as Error);
          }
        })();
      },
    });
  }

  validate(payload: { sub: string; email: string; roles: string[] }) {
    return {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles ?? [],
    };
  }
}