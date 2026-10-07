import { describe, expect, it } from 'vitest';

import { AuthSessionDto } from './auth-session.dto.js';

function token(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    deviceId: 'd1',
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    createdAt: new Date('2026-10-10T09:00:00.000Z'),
    expiresAt: new Date('2026-10-11T09:00:00.000Z'),
    ...overrides,
  } as never;
}

describe('AuthSessionDto', () => {
  it('carries the id the revoke route takes', () => {
    expect(AuthSessionDto.fromEntity(token()).id).toBe('s1');
  });

  it('formats both timestamps as ISO strings', () => {
    const dto = AuthSessionDto.fromEntity(token());

    expect(dto.createdAt).toBe('2026-10-10T09:00:00.000Z');
    expect(dto.expiresAt).toBe('2026-10-11T09:00:00.000Z');
  });

  it('takes the device name from the caller, because the token has no such column', () => {
    expect(AuthSessionDto.fromEntity(token(), 'MacBook Pro').deviceName).toBe(
      'MacBook Pro',
    );
  });

  it('has no device name when the caller passed none', () => {
    expect(AuthSessionDto.fromEntity(token()).deviceName).toBeNull();
  });

  it('keeps a session whose device is gone, with no name', () => {
    // A removed device does not make the session harmless; dropping the row would
    // hide a session that can still refresh.
    const dto = AuthSessionDto.fromEntity(token(), null);

    expect(dto.id).toBe('s1');
    expect(dto.deviceName).toBeNull();
  });

  it('handles a session with no device at all', () => {
    const dto = AuthSessionDto.fromEntity(token({ deviceId: null }));

    expect(dto.deviceId).toBeNull();
  });

  it('carries the address the sign-in came from', () => {
    // The one field that identifies a session nobody recognises by device name.
    const dto = AuthSessionDto.fromEntity(token());

    expect(dto.ipAddress).toBe('203.0.113.7');
    expect(dto.userAgent).toBe('Mozilla/5.0');
  });

  it('does not expose the token hash or the jti', () => {
    // Neither belongs in a response body a client might log.
    const dto = AuthSessionDto.fromEntity(token({ tokenHash: 'h', jti: 'j' }));

    expect(Object.keys(dto)).not.toContain('tokenHash');
    expect(Object.keys(dto)).not.toContain('jti');
  });
});
