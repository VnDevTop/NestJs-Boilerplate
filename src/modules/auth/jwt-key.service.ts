import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { generateKeyPairSync } from 'node:crypto';
import { JwtKey } from './entities/jwt-key.entity.js';

@Injectable()
export class JwtKeyService {
  constructor(
    @InjectRepository(JwtKey)
    private readonly jwtKeyRepository: Repository<JwtKey>,
  ) {}

  async getActiveKey(): Promise<JwtKey> {
    let key = await this.jwtKeyRepository.findOne({
      where: { isActive: true },
      order: { version: 'DESC' },
    });

    if (!key) {
      key = await this.createKey(1, true);
    }

    return key;
  }

  async findByKid(kid: string): Promise<JwtKey | null> {
    return this.jwtKeyRepository.findOne({ where: { kid } });
  }

  async rotate(): Promise<JwtKey> {
    const current = await this.getActiveKey();
    await this.jwtKeyRepository.update({ isActive: true }, { isActive: false });
    const nextVersion = current.version + 1;
    return this.createKey(nextVersion, true);
  }

  private async createKey(version: number, isActive: boolean): Promise<JwtKey> {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const key = this.jwtKeyRepository.create({
      kid: `key-v${version}`,
      version,
      algorithm: 'RS256',
      privateKey,
      publicKey,
      isActive,
    });

    return this.jwtKeyRepository.save(key);
  }
}