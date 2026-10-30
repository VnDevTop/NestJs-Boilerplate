import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtKeyService } from './jwt-key.service.js';

describe('JwtKeyService', () => {
  let service: JwtKeyService;
  let repository: any;

  beforeEach(() => {
    repository = {
      findOne: vi.fn(),
      create: vi.fn((data) => ({ ...data, id: 'key-id' })),
      save: vi.fn(async (data) => data),
      update: vi.fn().mockResolvedValue(undefined),
    };
    service = new JwtKeyService(repository);
  });

  it('returns existing active key', async () => {
    repository.findOne.mockResolvedValue({ kid: 'key-v1', version: 1, isActive: true });
    const key = await service.getActiveKey();
    expect(key.kid).toBe('key-v1');
  });

  it('creates a key when none exists', async () => {
    repository.findOne.mockResolvedValue(null);
    const key = await service.getActiveKey();
    expect(repository.create).toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalled();
    expect(key.isActive).toBe(true);
  });

  it('finds key by kid', async () => {
    repository.findOne.mockResolvedValue({ kid: 'key-v2' });
    const key = await service.findByKid('key-v2');
    expect(key?.kid).toBe('key-v2');
  });

  it('rotates keys', async () => {
    repository.findOne.mockResolvedValue({ kid: 'key-v1', version: 1, isActive: true });
    const key = await service.rotate();
    expect(repository.update).toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalled();
    expect(key.version).toBe(2);
  });
});