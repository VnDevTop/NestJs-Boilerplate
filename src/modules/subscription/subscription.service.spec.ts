import { SubscriptionService } from './subscription.service.js';

describe('SubscriptionService hmacSign', () => {
  const service = new SubscriptionService(
    {} as any,
    {} as any,
    { enabled: true, endpoints: {} } as any,
  );

  it('produces a valid HMAC-SHA256 signature', () => {
    const payload = { test: 'data' };
    const secret = 'test-secret';
    const signature = service['hmacSign'](payload, secret);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64);
  });

  it('produces different signatures for different secrets', () => {
    const payload = { test: 'data' };
    const sig1 = service['hmacSign'](payload, 'secret1');
    const sig2 = service['hmacSign'](payload, 'secret2');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const sig1 = service['hmacSign']({ a: 1 }, 'secret');
    const sig2 = service['hmacSign']({ b: 2 }, 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('isOldSecretValid returns true for valid HMAC shape', () => {
    const service = new SubscriptionService(
      {} as any,
      {} as any,
      { enabled: true, endpoints: {} } as any,
    );
    const payload = { test: 'data' };
    expect(service['isOldSecretValid']('test-secret', payload)).toBe(true);
  });

  it('isOldSecretValid returns false for invalid input', () => {
    const service = new SubscriptionService(
      {} as any,
      {} as any,
      { enabled: true, endpoints: {} } as any,
    );
    expect(service['isOldSecretValid']('', { test: 'data' })).toBe(false);
  });
});
