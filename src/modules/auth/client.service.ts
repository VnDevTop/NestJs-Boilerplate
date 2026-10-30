import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { Client } from './entities/client.entity.js';

@Injectable()
export class ClientService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,
  ) {}

  async findByClientId(clientId: string): Promise<Client | null> {
    return this.clientRepository.findOne({
      where: { clientId },
      select: {
        id: true,
        clientId: true,
        clientSecretHash: true,
        scopes: true,
        status: true,
      },
    });
  }

  async validate(clientId: string, clientSecret: string): Promise<Client> {
    const client = await this.findByClientId(clientId);
    if (!client || client.status !== 'active' || !client.clientSecretHash) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    const valid = await argon2.verify(client.clientSecretHash, clientSecret);
    if (!valid) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    return client;
  }
}