import { Injectable, Logger } from '@nestjs/common';
import { resolve4, resolve6 } from 'dns';
import { promisify } from 'util';

const resolveV4 = promisify(resolve4);
const resolveV6 = promisify(resolve6);

const LOOPBACK = '127.0.0.1';
const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
];
const LINK_LOCAL = '169.254.0.0/16';
const METADATA_ADDRESS = '169.254.169.254';

@Injectable()
export class SsrfGuardService {
  private readonly logger = new Logger(SsrfGuardService.name);

  async checkUrl(url: string): Promise<{ safe: boolean; reason?: string }> {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      // Resolve the hostname to IP addresses
      const addresses = await this.resolveHostname(hostname);

      // If no addresses resolved, the hostname is either unresolvable or an IP
      if (addresses.length === 0) {
        // If it looks like an IP address, still check it
        if (this.isIpAddress(hostname)) {
          return { safe: this.isRestrictedAddress(hostname), reason: hostname };
        }
        // Could not resolve hostname - treat as unsafe (potential DNS rebinding)
        return { safe: false, reason: 'Could not resolve hostname' };
      }

      for (const addr of addresses) {
        if (this.isRestrictedAddress(addr)) {
          this.logger.warn(`SSRF blocked: resolved to restricted address ${addr}`);
          return { safe: false, reason: `Resolved to restricted address: ${addr}` };
        }
      }

      return { safe: true };
    } catch {
      return { safe: false, reason: 'Invalid URL format' };
    }
  }

  private async resolveHostname(hostname: string): Promise<string[]> {
    const addresses: string[] = [];

    // Try IPv4
    try {
      const v4 = await resolveV4(hostname);
      addresses.push(...v4);
    } catch {
      // IPv4 resolution may fail, continue to IPv6
    }

    // Try IPv6
    try {
      const v6 = await resolveV6(hostname);
      addresses.push(...v6);
    } catch {
      // IPv6 resolution may fail
    }

    // If no addresses resolved, check if hostname is an IP directly
    if (addresses.length === 0 && this.isIpAddress(hostname)) {
      addresses.push(hostname);
    }

    return addresses;
  }

  private isRestrictedAddress(addr: string): boolean {
    // Check for exact loopback match
    if (addr === LOOPBACK) {
      return true;
    }

    // Check for link-local (169.254.x.x)
    if (addr.startsWith('169.254.')) {
      return true;
    }

    // Check for metadata address specifically
    if (addr === METADATA_ADDRESS) {
      return true;
    }

    // Check private ranges (CIDR notation handled by simple prefix checks)
    // 10.0.0.0/8
    if (addr.startsWith('10.')) {
      return true;
    }
    // 172.16.0.0/12 - 172.16.0.0 to 172.31.255.255
    if (addr.startsWith('172.')) {
      const secondOctet = parseInt(addr.split('.')[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) {
        return true;
      }
    }
    // 192.168.0.0/16
    if (addr.startsWith('192.168.')) {
      return true;
    }

    return false;
  }

  private isIpAddress(hostname: string): boolean {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  }
}