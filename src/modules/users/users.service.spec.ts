import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let repository: any;

  beforeEach(() => {
    repository = {
      findOne: vi.fn(),
      create: vi.fn((data) => ({ ...data, id: 'user-id' })),
      save: vi.fn(async (data) => data),
      update: vi.fn().mockResolvedValue(undefined),
      softDelete: vi.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(repository);
  });

  it('finds by email', async () => {
    repository.findOne.mockResolvedValue({ id: '1', email: 'a@test.com' });
    const user = await service.findByEmail('a@test.com');
    expect(user?.email).toBe('a@test.com');
  });

  it('finds by email with password', async () => {
    repository.findOne.mockResolvedValue({ id: '1', passwordHash: 'hash' });
    const user = await service.findByEmailWithPassword('a@test.com');
    expect(user?.passwordHash).toBe('hash');
  });

  it('finds by id', async () => {
    repository.findOne.mockResolvedValue({ id: '1' });
    const user = await service.findById('1');
    expect(user?.id).toBe('1');
  });

  it('finds by id with refresh token', async () => {
    repository.findOne.mockResolvedValue({ id: '1', refreshTokenHash: 'hash' });
    const user = await service.findByIdWithRefreshToken('1');
    expect(user?.refreshTokenHash).toBe('hash');
  });

  it('creates user', async () => {
    const user = await service.create({ email: 'a@test.com' } as any);
    expect(repository.create).toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalled();
    expect(user.email).toBe('a@test.com');
  });

  it('saves user', async () => {
    const user = { id: '1', email: 'a@test.com' } as any;
    const result = await service.save(user);
    expect(repository.save).toHaveBeenCalledWith(user);
    expect(result).toBe(user);
  });

  it('sets refresh token hash', async () => {
    await service.setRefreshTokenHash('1', 'hash');
    expect(repository.update).toHaveBeenCalledWith('1', { refreshTokenHash: 'hash' });
  });

  it('soft deletes user', async () => {
    await service.softDelete('1');
    expect(repository.softDelete).toHaveBeenCalledWith('1');
  });
});