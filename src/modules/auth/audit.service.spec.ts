import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let service: AuditService;
  let repository: any;

  beforeEach(() => {
    repository = {
      create: vi.fn((data) => data),
      save: vi.fn().mockResolvedValue(undefined),
    };
    service = new AuditService(repository);
  });

  it('saves an audit log', async () => {
    await service.log({ action: 'auth.login', userId: '1', metadata: { email: 'a@test.com' } });
    expect(repository.create).toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalled();
  });

  it('does not throw when save fails', async () => {
    repository.save.mockRejectedValue(new Error('db error'));
    await expect(service.log({ action: 'auth.login' })).resolves.toBeUndefined();
  });
});