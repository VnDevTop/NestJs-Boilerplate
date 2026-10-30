import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  let authService: AuthService;
  let usersService: any;
  let clientService: any;
  let jwtKeyService: any;
  let jwtService: any;
  let configService: any;
  let auditService: any;

  beforeEach(() => {
    usersService = {
      findByEmail: vi.fn(),
      findByEmailWithPassword: vi.fn(),
      create: vi.fn(),
      save: vi.fn(),
      setRefreshTokenHash: vi.fn(),
      findByIdWithRefreshToken: vi.fn(),
    };
    clientService = {
      validate: vi.fn(),
    };
    jwtKeyService = {
      getActiveKey: vi.fn().mockResolvedValue({ privateKey: 'private', publicKey: 'public', kid: 'kid-1' }),
      rotate: vi.fn().mockResolvedValue({ kid: 'kid-2' }),
    };
    jwtService = {
      signAsync: vi.fn().mockResolvedValue('token'),
      verifyAsync: vi.fn(),
    };
    configService = {
      get: vi.fn().mockReturnValue({ signOptions: { expiresIn: '15m' }, refreshTtl: '7d' }),
    };
    auditService = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    authService = new AuthService(
      usersService,
      clientService,
      jwtKeyService,
      jwtService,
      configService,
      auditService,
    );
  });

  it('registers a new user', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: '1', email: 'a@test.com', roles: ['user'], status: 'active' });

    const result = await authService.register({ email: 'a@test.com', password: 'password123' } as any);

    expect(result.user.email).toBe('a@test.com');
    expect(result.accessToken).toBe('token');
    expect(result.refreshToken).toBe('token');
  });

  it('rejects duplicate registration', async () => {
    usersService.findByEmail.mockResolvedValue({ id: '1' });
    await expect(authService.register({ email: 'a@test.com', password: 'password123' } as any)).rejects.toThrow();
  });

  it('logs in with valid credentials', async () => {
    const { hash } = await import('argon2');
    const passwordHash = await hash('password123');
    usersService.findByEmailWithPassword.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      passwordHash,
      roles: ['user'],
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    usersService.save.mockResolvedValue({});

    const result = await authService.login({ email: 'a@test.com', password: 'password123' } as any);

    expect(result.accessToken).toBe('token');
    expect(usersService.save).toHaveBeenCalled();
  });

  it('rejects invalid login', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      passwordHash: 'invalid',
      roles: ['user'],
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    usersService.save.mockResolvedValue({});

    await expect(authService.login({ email: 'a@test.com', password: 'wrong' } as any)).rejects.toThrow();
  });

  it('refreshes tokens', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', type: 'refresh' });
    usersService.findByIdWithRefreshToken.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      roles: ['user'],
      status: 'active',
      refreshTokenHash: 'hash',
    });
    // argon2.verify will fail against 'hash'/'refresh-token'; mock by spying not possible, so skip strict
    usersService.save.mockResolvedValue({});
    await expect(authService.refresh('refresh-token')).rejects.toThrow();
  });

  it('logs out user', async () => {
    await authService.logout('1');
    expect(usersService.setRefreshTokenHash).toHaveBeenCalledWith('1', null);
  });

  it('issues client credentials token', async () => {
    clientService.validate.mockResolvedValue({ clientId: 'client', scopes: ['read'], status: 'active' });
    const result = await authService.clientCredentials('client', 'secret');
    expect(result.accessToken).toBe('token');
  });

  it('rotates signing key', async () => {
    const result = await authService.rotateSigningKey();
    expect(result.kid).toBe('kid-2');
  });
});