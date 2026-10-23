import { SsrfGuardService } from './ssrf.guard.service';

describe('SsrfGuardService', () => {
  let service: SsrfGuardService;

  beforeEach(() => {
    service = new SsrfGuardService();
  });

  describe('checkUrl', () => {
    it('should allow public addresses', async () => {
      const result = await service.checkUrl('https://example.com');
      expect(result.safe).toBe(true);
    });

    it('should block loopback IPv4 127.0.0.1', async () => {
      const result = await service.checkUrl('http://127.0.0.1:3000/endpoint');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('restricted');
    });

    it('should block link-local address 169.254.169.254', async () => {
      const result = await service.checkUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('restricted');
    });

    it('should block private range 10.x.x.x', async () => {
      const result = await service.checkUrl('http://10.0.0.1/endpoint');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('restricted');
    });

    it('should block private range 172.16-31.x.x', async () => {
      const result = await service.checkUrl('http://172.16.0.1/endpoint');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('restricted');
    });

    it('should block private range 192.168.x.x', async () => {
      const result = await service.checkUrl('http://192.168.1.1/endpoint');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('restricted');
    });

    it('should block DNS rebinding to metadata address', async () => {
      const result = await service.checkUrl('http://metadata.local/');
      expect(result.safe).toBe(false);
    });
  });
});