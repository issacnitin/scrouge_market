import { describe, expect, it } from 'vitest';
import {
  assertUrlAllowed,
  isBlockedIpLiteral,
  parseIpv6ToBytes,
} from '../src/net/url-guard.js';
import { UrlRejectedError } from '../src/errors.js';

const publicResolve = (address = '93.184.216.34') =>
  Promise.resolve([{ address, family: 4 }]);

const options = (overrides: Partial<Parameters<typeof assertUrlAllowed>[1]> = {}) => ({
  allowPrivateHosts: false,
  resolve: () => publicResolve(),
  ...overrides,
});

describe('IP literal classification', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS/Azure instance metadata
    '100.100.100.200', // Alibaba metadata via CGNAT range
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks IPv4 %s', (ip) => {
    expect(isBlockedIpLiteral(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '192.169.0.1'])(
    'allows public IPv4 %s',
    (ip) => {
      expect(isBlockedIpLiteral(ip)).toBe(false);
    },
  );

  it.each([
    '::1',
    '0:0:0:0:0:0:0:1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '64:ff9b::127.0.0.1', // NAT64-embedded loopback
    '2002:7f00:1::', // 6to4
  ])('blocks IPv6 %s', (ip) => {
    expect(isBlockedIpLiteral(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888'])('allows public IPv6 %s', (ip) => {
    expect(isBlockedIpLiteral(ip)).toBe(false);
  });

  it('expands compressed IPv6 correctly', () => {
    expect(Array.from(parseIpv6ToBytes('::1') ?? [])).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIpv6ToBytes('fe80::1')?.[0]).toBe(0xfe);
    expect(parseIpv6ToBytes('not-an-ip')).toBeNull();
  });
});

describe('assertUrlAllowed', () => {
  it('accepts a normal public https URL', async () => {
    const url = await assertUrlAllowed('https://example.com/forum', options());
    expect(url.host).toBe('example.com');
  });

  it.each([
    ['file:///etc/passwd', 'protocol'],
    ['ftp://example.com', 'protocol'],
    ['javascript:alert(1)', 'protocol'],
  ])('rejects %s', async (input, reason) => {
    await expect(assertUrlAllowed(input, options())).rejects.toThrow(UrlRejectedError);
    await expect(assertUrlAllowed(input, options())).rejects.toThrow(new RegExp(reason));
  });

  it('rejects embedded credentials', async () => {
    await expect(assertUrlAllowed('https://user:pw@example.com', options())).rejects.toThrow(
      /credentials/,
    );
  });

  it('rejects localhost and metadata hostnames', async () => {
    for (const host of ['http://localhost/', 'http://metadata.google.internal/']) {
      await expect(assertUrlAllowed(host, options())).rejects.toThrow(/blocked/);
    }
  });

  it('rejects a private IP literal without any DNS call', async () => {
    const resolve = (): never => {
      throw new Error('resolver must not be called for IP literals');
    };
    await expect(assertUrlAllowed('http://127.0.0.1:80/', options({ resolve }))).rejects.toThrow(
      /blocked range/,
    );
  });

  it('rejects a public hostname that resolves to a private address (DNS rebinding)', async () => {
    await expect(
      assertUrlAllowed(
        'https://evil.example.com',
        options({ resolve: () => publicResolve('169.254.169.254') }),
      ),
    ).rejects.toThrow(/blocked address 169\.254\.169\.254/);
  });

  it('rejects when any one of several resolved addresses is private', async () => {
    await expect(
      assertUrlAllowed(
        'https://mixed.example.com',
        options({
          resolve: () =>
            Promise.resolve([
              { address: '93.184.216.34', family: 4 },
              { address: '10.1.2.3', family: 4 },
            ]),
        }),
      ),
    ).rejects.toThrow(/10\.1\.2\.3/);
  });

  it('rejects non-standard ports', async () => {
    await expect(assertUrlAllowed('http://example.com:8080/', options())).rejects.toThrow(
      /port 8080/,
    );
  });

  it('rejects hosts that fail to resolve', async () => {
    await expect(
      assertUrlAllowed(
        'https://nope.invalid',
        options({ resolve: () => Promise.reject(new Error('ENOTFOUND')) }),
      ),
    ).rejects.toThrow(/DNS resolution failed/);
  });

  it('allows private hosts only when explicitly opted in', async () => {
    const url = await assertUrlAllowed('http://127.0.0.1:3000/', {
      allowPrivateHosts: true,
    });
    expect(url.port).toBe('3000');
  });
});
