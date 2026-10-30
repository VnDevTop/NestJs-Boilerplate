import { describe, it, expect } from 'vitest';
import { User, UserRole, UserStatus } from './user.entity.js';

describe('User entity', () => {
  it('exports role and status enums', () => {
    expect(UserRole.USER).toBe('user');
    expect(UserRole.ADMIN).toBe('admin');
    expect(UserStatus.ACTIVE).toBe('active');
  });

  it('can be instantiated', () => {
    const user = new User();
    user.email = 'a@test.com';
    user.roles = [UserRole.USER];
    user.status = UserStatus.ACTIVE;
    expect(user.email).toBe('a@test.com');
    expect(user.roles).toContain(UserRole.USER);
  });
});