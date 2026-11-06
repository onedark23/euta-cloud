// Public-address check for environment base URLs (SPEC 환경 "주소"): the cloud runner reaches
// targets only through public URLs, so a host that resolves to a private/internal address is
// flagged "cloud run not possible" (still saved — local runs work).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AddressCheck } from '@euta-cloud/shared';

export type HostResolver = (host: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.svc', '.cluster.local'];

function ipv4Private(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const [a = 0, b = 0] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return ipv4Private(mapped[1]!);
  return /^(fc|fd)/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) return ipv6Private(ip);
  return true;
}

export async function checkPublicAddress(baseUrl: string, resolve: HostResolver): Promise<AddressCheck> {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    return isPrivateAddress(host) ? { public: false, reason: `${host} is a private or reserved address` } : { public: true };
  }
  if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { public: false, reason: `${host} is an internal host name` };
  }
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return { public: false, reason: `${host} could not be resolved` };
  }
  if (!addrs.length) return { public: false, reason: `${host} could not be resolved` };
  const priv = addrs.find(isPrivateAddress);
  if (priv) return { public: false, reason: `${host} resolves to a private address (${priv})` };
  return { public: true };
}
