import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parse } from 'tldts';
import { FetchError } from './errors';
import { isPublicIp } from './ip';

/** Company sites are served on the standard ports; anything else is not worth the SSRF risk. */
export const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443]);

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.corp',
  '.lan',
  '.home',
  '.arpa',
];
const MAX_URL_LENGTH = 2048;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: DnsResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Syntactic SSRF checks (no network): http(s) only, no credentials, standard ports, a real
 * DNS name under a known public suffix. Throws FetchError('INVALID_URL' | 'BLOCKED_HOST').
 */
export function parseSafeUrl(input: string | URL): URL {
  let url: URL;
  try {
    if (typeof input === 'string' && input.length > MAX_URL_LENGTH) throw new Error('too long');
    url = new URL(input);
  } catch {
    throw new FetchError('URL is not valid', 'INVALID_URL');
  }
  if (url.href.length > MAX_URL_LENGTH) throw new FetchError('URL is too long', 'INVALID_URL');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`Scheme "${url.protocol}" is not allowed`, 'INVALID_URL');
  }
  if (url.username || url.password) {
    throw new FetchError('URLs with credentials are not allowed', 'INVALID_URL');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) throw new FetchError(`Port ${port} is not allowed`, 'INVALID_URL');

  assertPublicHostname(url.hostname);
  return url;
}

/** Name-level checks. The WHATWG URL parser has already canonicalised 0x7f.1, 2130706433, … */
export function assertPublicHostname(rawHostname: string): void {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!hostname) throw new FetchError('URL has no host', 'INVALID_URL');
  if (isIP(hostname)) throw new FetchError('IP-literal hosts are not allowed', 'BLOCKED_HOST');
  if (hostname === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new FetchError('Internal host names are not allowed', 'BLOCKED_HOST');
  }
  const parsed = parse(hostname, { allowPrivateDomains: true });
  // Rejects single-label names ("metadata", "intranet") and unknown suffixes ("foo.bar").
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) {
    throw new FetchError('Host is not a public domain name', 'BLOCKED_HOST');
  }
}

/**
 * Resolve a host and require EVERY answer to be a public address. A single private record in
 * the answer set rejects the whole name (a classic rebinding trick is to mix them). The
 * returned addresses are what the connection must be pinned to, so a second, different DNS
 * answer at connect time can never be used.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: DnsResolver,
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new FetchError(`DNS lookup failed for ${hostname}`, 'DNS_FAILED');
  }
  if (addresses.length === 0) throw new FetchError(`No DNS records for ${hostname}`, 'DNS_FAILED');
  const bad = addresses.find((a) => !isPublicIp(a.address));
  if (bad) {
    throw new FetchError(`${hostname} resolves to a non-public address`, 'BLOCKED_ADDRESS');
  }
  return addresses;
}
