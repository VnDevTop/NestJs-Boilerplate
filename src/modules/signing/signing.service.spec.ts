import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { SigningService } from './signing.service.js';
import { Request } from 'express';

describe('SigningService', () => {
  let service: SigningService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SigningService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue('test-secret'),
            getOrThrow: vi
              .fn()
              .mockReturnValue({ maxAge: 600_000, clockSkew: 120_000 }),
          },
        },
      ],
    }).compile();

    service = module.get<SigningService>(SigningService);
  });

  function createMockReq(headers: Record<string, string> = {}): Request {
    return {
      get: (name: string) => headers[name.toLowerCase()],
      headers,
    } as unknown as Request;
  }

  describe('verifySignature', () => {
    it('should return false when no signature header', () => {
      const req = createMockReq({});
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return false when signature format is invalid', () => {
      const req = createMockReq({ 'x-signature': 'invalid' });
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return false when timestamp is too old', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 700_000; // > maxAge
      const req = createMockReq({
        'x-signature': `t=${oldTimestamp},v1=invalid`,
      });
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return false when clock skew is too large', () => {
      const skewedTimestamp = Math.floor(Date.now() / 1000) + 200_000; // > clockSkew
      const req = createMockReq({
        'x-signature': `t=${skewedTimestamp},v1=invalid`,
      });
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return true when age is within allowed window', () => {
      const req = createMockReq({
        'x-signature': `t=${Math.floor(Date.now() / 1000)},v1=mock`,
      });
      // When age is within window and skew, the method returns true (signature
      // content not validated here). This ensures the age/skew checks pass.
      expect(service['verifySignature'](req, 'secret')).toBe(true);
    });
  });
});
