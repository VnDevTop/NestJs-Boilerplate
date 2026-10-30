import { registerAs } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import type { JwtModuleOptions } from '@nestjs/jwt';

let cachedKeys: { privateKey: string; publicKey: string } | undefined;

function getKeys(): { privateKey: string; publicKey: string } {
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    return {
      privateKey: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      publicKey: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
    };
  }
  if (!cachedKeys) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    cachedKeys = { privateKey, publicKey };
  }
  return cachedKeys;
}

export type JwtConfig = JwtModuleOptions & { refreshTtl: string };

export const jwtConfig = registerAs<JwtConfig>(
  'jwt',
  (): JwtConfig => {
    const keys = getKeys();
    const accessTtl = process.env.JWT_ACCESS_TTL ?? '15m';
    const refreshTtl = process.env.JWT_REFRESH_TTL ?? '7d';
    return {
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      signOptions: { algorithm: 'RS256', expiresIn: accessTtl as any },
      refreshTtl,
    };
  },
);