import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { FetchError } from './errors';
import type { DomainRateLimiter } from './rate-limiter';
import {
  parseSafeUrl,
  resolvePublicAddresses,
  systemResolver,
  type DnsResolver,
  type ResolvedAddress,
} from './url-guard';

/** Injection seam for tests; production uses node:http / node:https. */
export type RequestImpl = (options: RequestOptions) => ClientRequest;

const defaultRequest: RequestImpl = (options) =>
  options.protocol === 'https:' ? https.request(options) : http.request(options);

export interface SafeFetcherConfig {
  userAgent: string;
  resolver?: DnsResolver;
  requestImpl?: RequestImpl;
  rateLimiter?: DomainRateLimiter;
  /**
   * Awaited for every hop (the first URL AND each redirect target) after the syntactic
   * checks and before any connection: this is where robots.txt is enforced.
   */
  authorize?: (url: URL, signal: AbortSignal | undefined) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchOptions {
  allowedContentTypes: readonly string[];
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Used only for robots.txt itself, which must not be gated by robots.txt. */
  skipAuthorize?: boolean;
}

export interface SafeFetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  /** Every URL visited before the final one. */
  redirects: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The only component that talks to the open internet on behalf of crawled content. Every
 * outbound request goes through here, and each hop (including redirects) is:
 *   1. syntactically validated (http/https, no credentials, port 80/443, public DNS name),
 *   2. authorised (robots.txt) and rate-limited per registrable domain,
 *   3. DNS-resolved with EVERY answer required to be a public address,
 *   4. connected to the IP that was just validated (the socket's `lookup` is pinned), so a
 *      second DNS answer at connect time — DNS rebinding — is never consulted.
 * Responses are bounded in time and size (after decompression), limited to allow-listed
 * content types, and never interpreted: this class returns text and nothing else.
 */
export class SafeFetcher {
  private readonly resolver: DnsResolver;
  private readonly requestImpl: RequestImpl;

  constructor(private readonly config: SafeFetcherConfig) {
    this.resolver = config.resolver ?? systemResolver;
    this.requestImpl = config.requestImpl ?? defaultRequest;
  }

  async fetchText(startUrl: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
    const maxRedirects = options.maxRedirects ?? this.config.maxRedirects ?? 5;
    const visited: string[] = [];
    let current = startUrl;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = parseSafeUrl(current); // throws INVALID_URL / BLOCKED_HOST
      if (options.signal?.aborted) throw new FetchError('Cancelled', 'CANCELLED');
      if (this.config.authorize && !options.skipAuthorize) {
        await this.config.authorize(url, options.signal);
      }
      await this.config.rateLimiter?.acquire(url.hostname, { signal: options.signal });

      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs ?? 10_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

      try {
        const addresses = await abortable(
          resolvePublicAddresses(url.hostname.replace(/\.$/, ''), this.resolver),
          signal,
        );
        const response = await this.send(url, addresses, signal, options.accept);
        const status = response.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) throw new FetchError('Redirect without Location', 'BAD_REDIRECT', status);
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new FetchError('Redirect target is not a valid URL', 'BAD_REDIRECT', status);
          }
          parseSafeUrl(next); // report the specific reason (scheme, host, port) first
          if (url.protocol === 'https:' && next.protocol !== 'https:') {
            throw new FetchError('Redirect downgrades HTTPS to HTTP', 'BAD_REDIRECT', status);
          }
          visited.push(url.href);
          current = next; // re-validated at the top of the loop
          continue;
        }

        if (status < 200 || status >= 300) {
          response.destroy();
          throw new FetchError(`HTTP ${status}`, 'HTTP_ERROR', status);
        }

        const contentType = baseContentType(response.headers['content-type']);
        if (!contentType || !options.allowedContentTypes.includes(contentType)) {
          response.destroy();
          throw new FetchError(
            `Content type "${contentType || 'unknown'}" is not allowed`,
            'UNSUPPORTED_CONTENT_TYPE',
            status,
          );
        }
        if (/attachment/i.test(String(response.headers['content-disposition'] ?? ''))) {
          response.destroy();
          throw new FetchError('Downloads are not allowed', 'UNSUPPORTED_CONTENT_TYPE', status);
        }
        const maxBytes = options.maxBytes ?? this.config.maxBytes ?? 1024 * 1024;
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          throw new FetchError('Response is too large', 'RESPONSE_TOO_LARGE', status);
        }

        const { text, bytes } = await readBody(response, maxBytes, signal);
        return {
          url: url.href,
          status,
          contentType,
          body: text,
          bytes,
          redirects: visited,
        };
      } catch (error) {
        throw toFetchError(error, options.signal, timeout);
      }
    }
    throw new FetchError(`More than ${maxRedirects} redirects`, 'TOO_MANY_REDIRECTS');
  }

  private send(
    url: URL,
    addresses: ResolvedAddress[],
    signal: AbortSignal,
    accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  ): Promise<IncomingMessage> {
    // The pinned lookup: the socket may only ever connect to an address we validated above.
    const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      if (lookupOptions && (lookupOptions as { all?: boolean }).all) {
        cb(
          null,
          addresses.map((a) => ({ address: a.address, family: a.family })),
        );
      } else {
        cb(null, addresses[0]!.address, addresses[0]!.family);
      }
    };
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = this.requestImpl({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false, // fresh connection; no pooling across validated IPs
        lookup: pinned,
        signal,
        headers: {
          'user-agent': this.config.userAgent,
          accept,
          'accept-language': 'en',
          'accept-encoding': 'gzip, deflate, br',
          connection: 'close',
        },
      });
      request.once('response', resolve);
      request.once('error', reject);
      request.end();
    });
  }
}

function baseContentType(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}

function charsetOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /charset\s*=\s*"?([\w.:-]+)/i.exec(value ?? '');
  return match ? match[1]!.toLowerCase() : 'utf-8';
}

function decoderFor(encoding: string | undefined): Transform | undefined {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return undefined;
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      throw new FetchError('Unsupported content encoding', 'UNSUPPORTED_CONTENT_TYPE');
  }
}

/** Reads at most `maxBytes` of DECODED data, so a compression bomb cannot exhaust memory. */
async function readBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number }> {
  let decoder: Transform | undefined;
  try {
    decoder = decoderFor(response.headers['content-encoding']);
  } catch (error) {
    response.destroy();
    throw error;
  }
  const onAbort = () => response.destroy(signal.reason as Error);
  signal.addEventListener('abort', onAbort, { once: true });

  let raw = 0;
  response.on('data', (chunk: Buffer) => {
    raw += chunk.length;
    if (raw > maxBytes)
      response.destroy(new FetchError('Response is too large', 'RESPONSE_TOO_LARGE'));
  });
  let source: Readable = response;
  if (decoder) {
    response.on('error', (error) => decoder!.destroy(error));
    source = response.pipe(decoder);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) {
        throw new FetchError('Response is too large', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    response.destroy();
    decoder?.destroy();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  const data = Buffer.concat(chunks, total);
  let text: string;
  try {
    text = new TextDecoder(charsetOf(response.headers['content-type'])).decode(data);
  } catch {
    text = new TextDecoder('utf-8').decode(data);
  }
  return { text, bytes: total };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function toFetchError(error: unknown, userSignal: AbortSignal | undefined, timeout: AbortSignal) {
  if (error instanceof FetchError) return error;
  if (userSignal?.aborted) return new FetchError('Cancelled', 'CANCELLED');
  if (timeout.aborted) return new FetchError('Request timed out', 'TIMEOUT');
  return new FetchError(
    `Network error${error instanceof Error && 'code' in error ? ` (${String(error.code)})` : ''}`,
    'NETWORK_ERROR',
  );
}
