import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { UrlRejectedError } from '../errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443']);

/** Hostnames used by cloud instance-metadata services. Blocked regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export function parseIpv4ToBytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] as string;
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

export function parseIpv6ToBytes(address: string): Uint8Array | null {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  const bytes = new Uint8Array(16);
  let embeddedV4: Uint8Array | null = null;

  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    embeddedV4 = parseIpv4ToBytes(text.slice(lastColon + 1));
    if (!embeddedV4) return null;
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const doubleColon = text.indexOf('::');
  let head: string[];
  let tail: string[];

  if (doubleColon === -1) {
    head = text.split(':');
    tail = [];
  } else {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    head = text.slice(0, doubleColon).split(':').filter((g) => g !== '');
    tail = text.slice(doubleColon + 2).split(':').filter((g) => g !== '');
  }

  if (head.length + tail.length > 8) return null;
  if (doubleColon === -1 && head.length !== 8) return null;

  const groups: number[] = new Array<number>(8).fill(0);
  for (let i = 0; i < head.length; i++) {
    const parsed = parseHextet(head[i] as string);
    if (parsed === null) return null;
    groups[i] = parsed;
  }
  for (let i = 0; i < tail.length; i++) {
    const parsed = parseHextet(tail[tail.length - 1 - i] as string);
    if (parsed === null) return null;
    groups[7 - i] = parsed;
  }

  for (let i = 0; i < 8; i++) {
    const group = groups[i] as number;
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }

  if (embeddedV4) bytes.set(embeddedV4, 12);
  return bytes;
}

function parseHextet(group: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  return parseInt(group, 16);
}

/** True for loopback, link-local, private, CGNAT, multicast, reserved and metadata ranges. */
export function isBlockedIpv4(bytes: Uint8Array): boolean {
  const [a, b] = [bytes[0] as number, bytes[1] as number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (also Alibaba metadata)
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

export function isBlockedIpv6(bytes: Uint8Array): boolean {
  const isZeroPrefix = bytes.slice(0, 15).every((byte) => byte === 0);
  if (isZeroPrefix && (bytes[15] === 0 || bytes[15] === 1)) return true; // :: and ::1

  const first = bytes[0] as number;
  const second = bytes[1] as number;

  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xff) return true; // ff00::/8 multicast
  if (first === 0x20 && second === 0x02) return true; // 2002::/16 6to4 can tunnel to private v4

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) embed a v4 address.
  const v4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    first === 0x00 &&
    second === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);

  if (v4Mapped || nat64) return isBlockedIpv4(bytes.slice(12));

  return false;
}

export function isBlockedIpLiteral(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const bytes = parseIpv4ToBytes(address);
    return bytes === null || isBlockedIpv4(bytes);
  }
  if (version === 6) {
    const bytes = parseIpv6ToBytes(address);
    return bytes === null || isBlockedIpv6(bytes);
  }
  return false;
}

export interface UrlGuardOptions {
  allowPrivateHosts: boolean;
  /** Injectable for tests; defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

const defaultResolve = async (
  hostname: string,
): Promise<{ address: string; family: number }[]> => lookup(hostname, { all: true });

/**
 * Validates a user-supplied URL before it reaches the browser.
 *
 * Without this, any URL typed at the prompt (or piped in from a script) can drive the agent
 * into the loopback interface, an RFC1918 host, or a cloud metadata endpoint, and the page
 * contents are then forwarded to a third-party LLM. Every resolved address is checked, not
 * just the first, because a hostile name can return a mix of public and private records.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  options: UrlGuardOptions,
): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new UrlRejectedError(rawUrl, 'empty URL');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UrlRejectedError(trimmed, 'not a valid absolute URL (include https://)');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlRejectedError(trimmed, `protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new UrlRejectedError(trimmed, 'embedded credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) throw new UrlRejectedError(trimmed, 'missing hostname');

  if (options.allowPrivateHosts) return url;

  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlRejectedError(trimmed, `port ${url.port} is not allowed (expected 80 or 443)`);
  }
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new UrlRejectedError(trimmed, `hostname "${hostname}" is blocked`);
  }
  if (isIP(hostname) !== 0) {
    if (isBlockedIpLiteral(hostname)) {
      throw new UrlRejectedError(trimmed, `IP ${hostname} is in a blocked range`);
    }
    return url;
  }

  let records: { address: string; family: number }[];
  try {
    records = await (options.resolve ?? defaultResolve)(hostname);
  } catch {
    throw new UrlRejectedError(trimmed, `DNS resolution failed for "${hostname}"`);
  }

  if (records.length === 0) {
    throw new UrlRejectedError(trimmed, `"${hostname}" did not resolve to any address`);
  }
  for (const record of records) {
    if (isBlockedIpLiteral(record.address)) {
      throw new UrlRejectedError(
        trimmed,
        `"${hostname}" resolves to blocked address ${record.address}`,
      );
    }
  }

  return url;
}
