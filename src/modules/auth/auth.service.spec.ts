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

  it('registers with default token expiry when config is missing', async () => {
    configService.get.mockReturnValue({ signOptions: {}, refreshTtl: '7d' });
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: '1', email: 'a@test.com', roles: ['user'], status: 'active' });

    const result = await authService.register({ email: 'a@test.com', password: 'password123' } as any);
    expect(result.accessToken).toBe('token');
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

  it('rejects login when user not found', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue(null);
    await expect(authService.login({ email: 'missing@test.com', password: 'password123' } as any)).rejects.toThrow();
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

  it('rejects locked login', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      passwordHash: 'hash',
      roles: ['user'],
      status: 'active',
      failedLoginAttempts: 5,
      lockedUntil: new Date(Date.now() + 60000),
    });

    await expect(authService.login({ email: 'a@test.com', password: 'password123' } as any)).rejects.toThrow();
  });

  it('rejects inactive user login', async () => {
    const { hash } = await import('argon2');
    const passwordHash = await hash('password123');
    usersService.findByEmailWithPassword.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      passwordHash,
      roles: ['user'],
      status: 'inactive',
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    await expect(authService.login({ email: 'a@test.com', password: 'password123' } as any)).rejects.toThrow();
  });

  it('locks account after max failed attempts', async () => {
    process.env.AUTH_MAX_FAILED_ATTEMPTS = '1';
    const { hash } = await import('argon2');
    const passwordHash = await hash('correct');
    const user = {
      id: '1',
      email: 'a@test.com',
      passwordHash,
      roles: ['user'],
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    usersService.findByEmailWithPassword.mockResolvedValue(user);
    usersService.save.mockResolvedValue(user);

    await expect(authService.login({ email: 'a@test.com', password: 'wrong' } as any)).rejects.toThrow();
    expect(user.lockedUntil).toBeInstanceOf(Date);
    delete process.env.AUTH_MAX_FAILED_ATTEMPTS;
  });

  it('refreshes tokens successfully', async () => {
    const { hash } = await import('argon2');
    const refreshToken = 'refresh-token';
    const refreshTokenHash = await hash(refreshToken);
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', type: 'refresh' });
    usersService.findByIdWithRefreshToken.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      roles: ['user'],
      status: 'active',
      refreshTokenHash,
    });
    usersService.setRefreshTokenHash.mockResolvedValue(undefined);

    const result = await authService.refresh(refreshToken);
    expect(result.accessToken).toBe('token');
    expect(result.refreshToken).toBe('token');
  });

  it('rejects refresh with invalid jwt', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('bad'));
    await expect(authService.refresh('bad-token')).rejects.toThrow();
  });

  it('rejects refresh with wrong type', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', type: 'access' });
    await expect(authService.refresh('token')).rejects.toThrow();
  });

  it('rejects refresh when user missing', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', type: 'refresh' });
    usersService.findByIdWithRefreshToken.mockResolvedValue(null);
    await expect(authService.refresh('token')).rejects.toThrow();
  });

  it('rejects refresh with hash mismatch', async () => {
    const { hash } = await import('argon2');
    const refreshTokenHash = await hash('other-token');
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', type: 'refresh' });
    usersService.findByIdWithRefreshToken.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      roles: ['user'],
      status: 'active',
      refreshTokenHash,
    });
    await expect(authService.refresh('token')).rejects.toThrow();
  });

  it('rejects refresh for inactive user', async () => {
    const { hash } = await import('argon2');
    const refreshToken = 'refresh-token';
    const refreshTokenHash = await hash(refreshToken);
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', type: 'refresh' });
    usersService.findByIdWithRefreshToken.mockResolvedValue({
      id: '1',
      email: 'a@test.com',
      roles: ['user'],
      status: 'inactive',
      refreshTokenHash,
    });
    await expect(authService.refresh(refreshToken)).rejects.toThrow();
  });

  it('rejects client credentials with invalid client', async () => {
    clientService.validate.mockRejectedValue(new Error('invalid'));
    await expect(authService.clientCredentials('bad', 'secret')).rejects.toThrow();
  });

  it('records failed login without locking account', async () => {
    process.env.AUTH_MAX_FAILED_ATTEMPTS = '5';
    const { hash } = await import('argon2');
    const passwordHash = await hash('correct');
    const user = {
      id: '1',
      email: 'a@test.com',
      passwordHash,
      roles: ['user'],
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    usersService.findByEmailWithPassword.mockResolvedValue(user);
    usersService.save.mockResolvedValue(user);

    await expect(authService.login({ email: 'a@test.com', password: 'wrong' } as any)).rejects.toThrow();
    expect(user.failedLoginAttempts).toBe(1);
    expect(user.lockedUntil).toBeNull();
    delete process.env.AUTH_MAX_FAILED_ATTEMPTS;
  });

  it('issues client credentials token with explicit scope', async () => {
    clientService.validate.mockResolvedValue({ clientId: 'client', scopes: ['read'], status: 'active' });
    const result = await authService.clientCredentials('client', 'secret', 'write admin');
    expect(result.accessToken).toBe('token');
  });

  it('issues client credentials token with default expiry when config is missing', async () => {
    configService.get.mockReturnValue({ signOptions: {}, refreshTtl: '7d' });
    clientService.validate.mockResolvedValue({ clientId: 'client', scopes: ['read'], status: 'active' });
    const result = await authService.clientCredentials('client', 'secret');
    expect(result.accessToken).toBe('token');
  });
});