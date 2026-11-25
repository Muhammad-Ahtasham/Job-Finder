import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FetchError,
  InMemoryDomainRateLimiter,
  PoliteFetcher,
  RobotsPolicy,
  SafeFetcher,
  isPublicIp,
  parseSafeUrl,
  type DnsResolver,
  type RequestImpl,
} from '../src';

const PUBLIC_IP = '93.184.216.34';

describe('isPublicIp', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '169.254.0.1',
    '100.64.0.1',
    '100.100.100.200', // Alibaba metadata
    '192.0.0.192', // Oracle metadata
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254', // AWS IPv6 metadata
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:169.254.169.254',
    '::ffff:10.1.2.3',
    '64:ff9b::7f00:1', // NAT64 embedding 127.0.0.1
    '2002:7f00:1::', // 6to4 embedding 127.0.0.1
    '2001:db8::1',
    '::127.0.0.1',
    'not-an-ip',
    '',
  ])('rejects %s', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('accepts %s', (address) => {
    expect(isPublicIp(address)).toBe(true);
  });
});

describe('parseSafeUrl', () => {
  it.each([
    ['file:///etc/passwd', 'INVALID_URL'],
    ['ftp://example.com/', 'INVALID_URL'],
    ['gopher://example.com/', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['data:text/html,hi', 'INVALID_URL'],
    ['http://user:pass@example.com/', 'INVALID_URL'],
    ['https://example.com:8443/', 'INVALID_URL'],
    ['http://example.com:22/', 'INVALID_URL'],
    ['http://localhost/', 'BLOCKED_HOST'],
    ['http://LOCALHOST./', 'BLOCKED_HOST'],
    ['http://app.localhost/', 'BLOCKED_HOST'],
    ['http://127.0.0.1/', 'BLOCKED_HOST'],
    ['http://2130706433/', 'BLOCKED_HOST'], // decimal 127.0.0.1
    ['http://0x7f.1/', 'BLOCKED_HOST'], // hex/short form
    ['http://017700000001/', 'BLOCKED_HOST'], // octal
    ['http://[::1]/', 'BLOCKED_HOST'],
    ['http://[::ffff:127.0.0.1]/', 'BLOCKED_HOST'],
    ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_HOST'],
    ['http://metadata.google.internal/', 'BLOCKED_HOST'],
    ['http://metadata/', 'BLOCKED_HOST'],
    ['http://printer.local/', 'BLOCKED_HOST'],
    ['http://intranet/', 'BLOCKED_HOST'],
    ['http://something.unknowntld/', 'BLOCKED_HOST'],
  ])('rejects %s', (input, code) => {
    expect(() => parseSafeUrl(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('accepts ordinary company sites', () => {
    expect(parseSafeUrl('https://www.acme-tech.com/careers').hostname).toBe('www.acme-tech.com');
    expect(parseSafeUrl('http://acme-tech.com:80/').port).toBe('');
  });
});

// ------------------------------------------------------------- SafeFetcher end to end

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = (_req, res) => res.end();
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const DNS: Record<string, string[]> = {
  'acme-tech.com': [PUBLIC_IP],
  'www.acme-tech.com': [PUBLIC_IP],
  'mixed.example-co.com': [PUBLIC_IP, '10.0.0.7'], // one private answer poisons the name
  'rebind.example-co.com': ['192.168.0.10'],
  'v6-mapped.example-co.com': ['::ffff:127.0.0.1'],
  'other-site.com': ['93.184.216.35'],
};
const resolver: DnsResolver = async (host) => {
  const records = DNS[host];
  if (!records) throw new Error('ENOTFOUND');
  return records.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

interface Seen {
  host: string;
  pinned: string[];
}
const seen: Seen[] = [];

/** Route every "public" hostname to the local test server, but record what the socket was pinned to. */
const requestImpl: RequestImpl = (options) => {
  const pinned: string[] = [];
  (options.lookup as (h: string, o: object, cb: (e: null, a: unknown) => void) => void)(
    options.hostname as string,
    { all: true },
    (_e, addresses) => pinned.push(...(addresses as { address: string }[]).map((a) => a.address)),
  );
  seen.push({ host: options.hostname as string, pinned });
  return http.request({
    host: '127.0.0.1',
    port,
    path: options.path,
    method: options.method,
    headers: { ...options.headers, host: options.hostname as string },
    signal: options.signal,
  });
};

const fetcher = (extra: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) =>
  new SafeFetcher({ userAgent: 'TestBot/1.0', resolver, requestImpl, ...extra });
const HTML = { allowedContentTypes: ['text/html'] } as const;

const html =
  (body: string): Handler =>
  (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  };
const redirect =
  (location: string, status = 302): Handler =>
  (_req, res) => {
    res.statusCode = status;
    res.setHeader('location', location);
    res.end();
  };
const failsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  expect((error as FetchError).code).toBe(code);
};

describe('SafeFetcher', () => {
  it('fetches HTML and pins the socket to the validated address', async () => {
    seen.length = 0;
    handler = html('<html>hello</html>');
    const result = await fetcher().fetchText('https://acme-tech.com/', HTML);
    expect(result.body).toContain('hello');
    expect(seen[0]).toEqual({ host: 'acme-tech.com', pinned: [PUBLIC_IP] });
  });

  it('refuses a name when ANY of its DNS answers is private (rebinding / mixed records)', async () => {
    await failsWith(fetcher().fetchText('https://mixed.example-co.com/', HTML), 'BLOCKED_ADDRESS');
    await failsWith(fetcher().fetchText('https://rebind.example-co.com/', HTML), 'BLOCKED_ADDRESS');
    await failsWith(
      fetcher().fetchText('https://v6-mapped.example-co.com/', HTML),
      'BLOCKED_ADDRESS',
    );
  });

  it('resolves once per hop: a DNS answer that changes later is never used', async () => {
    let calls = 0;
    const flipping: DnsResolver = async () => {
      calls += 1;
      return [{ address: calls === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }];
    };
    seen.length = 0;
    handler = html('ok');
    await fetcher({ resolver: flipping }).fetchText('https://acme-tech.com/', HTML);
    expect(calls).toBe(1);
    expect(seen[0]!.pinned).toEqual([PUBLIC_IP]);
  });

  it('reports DNS failures as retryable', async () => {
    const error = await fetcher()
      .fetchText('https://nonexistent-company.com/', HTML)
      .catch((e: FetchError) => e);
    expect((error as FetchError).code).toBe('DNS_FAILED');
    expect((error as FetchError).retryable).toBe(true);
  });

  describe('redirects', () => {
    it('follows a redirect to another public site and re-validates it', async () => {
      handler = (req, res) =>
        req.headers.host === 'acme-tech.com'
          ? redirect('https://other-site.com/landing')(req, res)
          : html('landed')(req, res);
      const result = await fetcher().fetchText('https://acme-tech.com/', HTML);
      expect(result.url).toBe('https://other-site.com/landing');
      expect(result.redirects).toEqual(['https://acme-tech.com/']);
    });

    it.each([
      ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_HOST'],
      ['http://localhost:80/admin', 'BLOCKED_HOST'],
      ['http://127.0.0.1/', 'BLOCKED_HOST'],
      ['http://[::1]/', 'BLOCKED_HOST'],
      ['https://rebind.example-co.com/', 'BLOCKED_ADDRESS'],
      ['file:///etc/passwd', 'INVALID_URL'],
      ['gopher://acme-tech.com/', 'INVALID_URL'],
      ['https://acme-tech.com:6379/', 'INVALID_URL'],
    ])('blocks a redirect to %s', async (target, code) => {
      handler = redirect(target);
      await failsWith(fetcher().fetchText('https://acme-tech.com/', HTML), code);
    });

    it('blocks an HTTPS → HTTP downgrade', async () => {
      handler = redirect('http://other-site.com/');
      await failsWith(fetcher().fetchText('https://acme-tech.com/', HTML), 'BAD_REDIRECT');
    });

    it('limits redirect chains', async () => {
      handler = redirect('https://acme-tech.com/loop');
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', { ...HTML, maxRedirects: 3 }),
        'TOO_MANY_REDIRECTS',
      );
    });

    it('rejects a redirect without a Location header', async () => {
      handler = (_req, res) => {
        res.statusCode = 302;
        res.end();
      };
      await failsWith(fetcher().fetchText('https://acme-tech.com/', HTML), 'BAD_REDIRECT');
    });
  });

  describe('response limits', () => {
    it('rejects content types outside the allow-list', async () => {
      for (const type of [
        'application/pdf',
        'application/zip',
        'application/octet-stream',
        'image/png',
      ]) {
        handler = (_req, res) => {
          res.setHeader('content-type', type);
          res.end('data');
        };
        await failsWith(
          fetcher().fetchText('https://acme-tech.com/', HTML),
          'UNSUPPORTED_CONTENT_TYPE',
        );
      }
    });

    it('rejects a missing content type and attachments', async () => {
      handler = (_req, res) => res.end('x');
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', HTML),
        'UNSUPPORTED_CONTENT_TYPE',
      );
      handler = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.setHeader('content-disposition', 'attachment; filename=a.html');
        res.end('x');
      };
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', HTML),
        'UNSUPPORTED_CONTENT_TYPE',
      );
    });

    it('rejects a declared Content-Length over the limit without reading it', async () => {
      handler = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.setHeader('content-length', '5000000');
        res.write('x');
      };
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', { ...HTML, maxBytes: 1000 }),
        'RESPONSE_TOO_LARGE',
      );
    });

    it('aborts a streamed body that exceeds the limit (no Content-Length)', async () => {
      handler = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.write('a'.repeat(2000));
        setTimeout(() => res.end('b'.repeat(2000)), 10);
      };
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', { ...HTML, maxBytes: 1000 }),
        'RESPONSE_TOO_LARGE',
      );
    });

    it('stops a compression bomb by limiting DECODED size', async () => {
      const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024)); // ~20 KB on the wire, 20 MB decoded
      expect(bomb.length).toBeLessThan(50_000);
      handler = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.setHeader('content-encoding', 'gzip');
        res.end(bomb);
      };
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', { ...HTML, maxBytes: 100_000 }),
        'RESPONSE_TOO_LARGE',
      );
    });

    it('decodes small gzip responses', async () => {
      handler = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.setHeader('content-encoding', 'gzip');
        res.end(gzipSync('<p>zipped hello</p>'));
      };
      expect((await fetcher().fetchText('https://acme-tech.com/', HTML)).body).toContain(
        'zipped hello',
      );
    });

    it('enforces the request timeout', async () => {
      handler = () => undefined; // never answers
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', { ...HTML, timeoutMs: 150 }),
        'TIMEOUT',
      );
    });

    it('stops a body that stalls after the headers', async () => {
      handler = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.write('partial');
      };
      await failsWith(
        fetcher().fetchText('https://acme-tech.com/', { ...HTML, timeoutMs: 200 }),
        'TIMEOUT',
      );
    });

    it('honours cancellation', async () => {
      handler = () => undefined;
      const controller = new AbortController();
      const promise = fetcher().fetchText('https://acme-tech.com/', {
        ...HTML,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await failsWith(promise, 'CANCELLED');
    });

    it('classifies HTTP errors (and which are retryable)', async () => {
      handler = (_req, res) => {
        res.statusCode = 404;
        res.end();
      };
      const notFound = await fetcher()
        .fetchText('https://acme-tech.com/', HTML)
        .catch((e: FetchError) => e);
      expect(notFound).toMatchObject({ code: 'HTTP_ERROR', httpStatus: 404, retryable: false });
      handler = (_req, res) => {
        res.statusCode = 503;
        res.end();
      };
      const unavailable = await fetcher()
        .fetchText('https://acme-tech.com/', HTML)
        .catch((e: FetchError) => e);
      expect(unavailable).toMatchObject({ httpStatus: 503, retryable: true });
    });
  });

  it('sends an identifying User-Agent and no cookies or credentials', async () => {
    let headers: http.IncomingHttpHeaders = {};
    handler = (req, res) => {
      headers = req.headers;
      html('ok')(req, res);
    };
    await fetcher().fetchText('https://acme-tech.com/', HTML);
    expect(headers['user-agent']).toBe('TestBot/1.0');
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.referer).toBeUndefined();
  });
});

describe('InMemoryDomainRateLimiter', () => {
  it('spaces requests to one registrable domain, across subdomains', async () => {
    let now = 1_000;
    const waited: number[] = [];
    const limiter = new InMemoryDomainRateLimiter(2000, () => now);
    const started = Date.now();
    // The reservation math does not need real sleeping: only the first call is instant.
    await limiter.acquire('acme-tech.com');
    const second = limiter.acquire('careers.acme-tech.com', { signal: AbortSignal.timeout(50) });
    await expect(second).rejects.toBeDefined(); // would have had to wait ~2s
    waited.push(Date.now() - started);
    expect(waited[0]).toBeLessThan(1000);
    now += 10_000; // far in the future: free again
    await expect(limiter.acquire('acme-tech.com')).resolves.toBeUndefined();
    await expect(limiter.acquire('unrelated-site.com')).resolves.toBeUndefined();
  });
});

describe('PoliteFetcher (robots.txt)', () => {
  const polite = (extra = {}) =>
    new PoliteFetcher({
      userAgent: 'JobFinderBot/0.1 (+test)',
      minIntervalMs: 0,
      resolver,
      requestImpl,
      ...extra,
    });
  const site =
    (robots: string | number, pages: Record<string, string> = {}): Handler =>
    (req, res) => {
      if (req.url === '/robots.txt') {
        if (typeof robots === 'number') {
          res.statusCode = robots;
          return void res.end();
        }
        res.setHeader('content-type', 'text/plain');
        return void res.end(robots);
      }
      if (req.url! in pages) return html(pages[req.url!]!)(req, res);
      res.statusCode = 404;
      res.end();
    };

  it('obeys Disallow rules, including for redirect destinations', async () => {
    handler = site('User-agent: *\nDisallow: /private\nAllow: /private/public', {
      '/ok': 'fine',
      '/private/public': 'allowed by longer rule',
    });
    const f = polite();
    expect((await f.fetchText('https://acme-tech.com/ok', HTML)).body).toBe('fine');
    await failsWith(f.fetchText('https://acme-tech.com/private/x', HTML), 'ROBOTS_DISALLOWED');
    expect((await f.fetchText('https://acme-tech.com/private/public', HTML)).body).toContain(
      'allowed',
    );
  });

  it('obeys a group addressed to our own token over *', async () => {
    handler = site('User-agent: *\nAllow: /\n\nUser-agent: JobFinderBot\nDisallow: /', {
      '/': 'x',
    });
    await failsWith(polite().fetchText('https://acme-tech.com/', HTML), 'ROBOTS_DISALLOWED');
  });

  it('treats a missing robots.txt (404) as allow-all', async () => {
    handler = site(404, { '/': 'open' });
    expect((await polite().fetchText('https://acme-tech.com/', HTML)).body).toBe('open');
  });

  it('refuses to crawl when robots.txt cannot be read (5xx)', async () => {
    handler = site(503, { '/': 'closed' });
    const error = await polite()
      .fetchText('https://acme-tech.com/', HTML)
      .catch((e: FetchError) => e);
    expect(error).toMatchObject({ code: 'ROBOTS_UNAVAILABLE', retryable: true });
  });

  it('still blocks unsafe hosts before any robots lookup', async () => {
    await failsWith(polite().fetchText('http://169.254.169.254/', HTML), 'BLOCKED_HOST');
  });
});

describe('RobotsPolicy', () => {
  const token = 'JobFinderBot';
  it('longest match wins; Allow wins ties; wildcards and $ work', () => {
    const policy = RobotsPolicy.parse(
      [
        'User-agent: *',
        'Disallow: /a',
        'Allow: /a/b',
        'Disallow: /*.pdf$',
        'Disallow: /tie',
        'Allow: /tie',
        'Crawl-delay: 5',
      ].join('\n'),
    );
    expect(policy.isAllowed('/a/x', token)).toBe(false);
    expect(policy.isAllowed('/a/b/c', token)).toBe(true);
    expect(policy.isAllowed('/doc.pdf', token)).toBe(false);
    expect(policy.isAllowed('/doc.pdf?x=1', token)).toBe(true);
    expect(policy.isAllowed('/tie', token)).toBe(true);
    expect(policy.isAllowed('/other', token)).toBe(true);
    expect(policy.crawlDelayMs(token)).toBe(5000);
  });

  it('empty Disallow allows everything; comments and junk are ignored', () => {
    const policy = RobotsPolicy.parse('# hi\nUser-agent: *\nDisallow:\nnonsense line\n');
    expect(policy.isAllowed('/anything', token)).toBe(true);
  });
});
