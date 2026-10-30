import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as argon2 from 'argon2';
import { ClientService } from './client.service.js';

describe('ClientService', () => {
  let service: ClientService;
  let repository: any;

  beforeEach(() => {
    repository = {
      findOne: vi.fn(),
    };
    service = new ClientService(repository);
  });

  it('finds client by id', async () => {
    repository.findOne.mockResolvedValue({ clientId: 'client-1' });
    const client = await service.findByClientId('client-1');
    expect(client?.clientId).toBe('client-1');
  });

  it('validates valid client credentials', async () => {
    const hash = await argon2.hash('secret');
    repository.findOne.mockResolvedValue({
      id: '1',
      clientId: 'client-1',
      clientSecretHash: hash,
      scopes: ['read'],
      status: 'active',
    });

    const client = await service.validate('client-1', 'secret');
    expect(client.clientId).toBe('client-1');
  });

  it('throws for unknown client', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.validate('missing', 'secret')).rejects.toThrow();
  });

  it('throws for invalid secret', async () => {
    const hash = await argon2.hash('secret');
    repository.findOne.mockResolvedValue({
      id: '1',
      clientId: 'client-1',
      clientSecretHash: hash,
      scopes: ['read'],
      status: 'active',
    });
    await expect(service.validate('client-1', 'wrong')).rejects.toThrow();
  });

  it('throws for inactive client', async () => {
    const hash = await argon2.hash('secret');
    repository.findOne.mockResolvedValue({
      id: '1',
      clientId: 'client-1',
      clientSecretHash: hash,
      scopes: ['read'],
      status: 'inactive',
    });
    await expect(service.validate('client-1', 'secret')).rejects.toThrow();
  });
});