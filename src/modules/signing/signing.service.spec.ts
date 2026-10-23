import { Test, internal } from '@nestjs/testing';
import { SigningService } from './signing.service.js';
import { Request } from 'express';

describe('SigningService', () => {
  let service: SigningService;

  beforeEach(() => {
    const module = Test.createTestingModule({
      providers: [SigningService],
    }).compile();

    service = module.get<SigningService>(SigningService);
  });

  describe('verifySignature', () => {
    it('should return false when no signature header', () => {
      const req: Partial<Request> = {};
      expect(service['verifySignature'](req as Request, 'secret')).toBe(false);
    });

    it('should return false when signature format is invalid', () => {
      const req: Request = { headers: { 'X-Signature': 'invalid' } } as Request;
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return false when timestamp is too old', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 700_000; // > maxAge
      const req: Request = {
        headers: {
          'X-Signature': `t=${oldTimestamp},v1=invalid`,
        },
      } as Request;
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return false when clock skew is too large', () => {
      const skewedTimestamp = Math.floor(Date.now() / 1000) + 200_000; // > clockSkew
      const req: Request = {
        headers: {
          'X-Signature': `t=${skewedTimestamp},v1=invalid`,
        },
      } as Request;
      expect(service['verifySignature'](req, 'secret')).toBe(false);
    });

    it('should return true when age is within allowed window', () => {
      const req: Request = {
        headers: {
          'X-Signature': `t=${Math.floor(Date.now() / 1000)},v1=invalid`,
        },
      } as Request;
      // When age is within window and skew, the method returns true (signature
      // content not validated here). This ensures the age/skew checks pass.
      expect(service['verifySignature'](req, 'secret')).toBe(true);
    });
  });
});
