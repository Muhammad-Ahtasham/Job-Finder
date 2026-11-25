import { randomUUID } from 'node:crypto';
import type { Company, ExtractionRun, PrismaClient } from '@jobfinder/database';
import {
  FetchError,
  type PageFetcher,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '@jobfinder/enrichment';

export const page = (title: string, body: string, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;

const NAV = `<nav><a href="/about-us">About Us</a> <a href="/careers">Careers</a>
  <a href="/contact-us">Contact</a></nav>`;

/** A believable company site: name in title/heading, city in the footer, published mailboxes. */
export function acmeSite(host = 'acme-tech.com'): Record<string, string> {
  const o = `https://${host}`;
  return {
    [`${o}/`]: page(
      'Acme Technologies | Software company in Lahore',
      `${NAV}<h1>Acme Technologies</h1><p>Acme Technologies builds software in Lahore. Acme Technologies ships.</p>
       <footer><a href="https://www.linkedin.com/company/acme-tech">LinkedIn</a></footer>`,
    ),
    [`${o}/about-us`]: page(
      'About Acme Technologies',
      `${NAV}<p>Founded 2010. <a href="mailto:info@${host}">info@${host}</a></p>`,
    ),
    [`${o}/careers`]: page(
      'Careers at Acme',
      `${NAV}<p>Send your CV to <a href="mailto:careers@${host}">careers@${host}</a> or hr [at] ${host.replace('.', ' [dot] ')}</p>`,
    ),
    [`${o}/contact-us`]: page(
      'Contact',
      `${NAV}<p>Write to <a href="mailto:hello@${host}">hello@${host}</a></p>`,
    ),
  };
}

/** A different company's site, to be rejected as a wrong candidate. */
export const bakerySite = (host = 'zenith-bakery.com'): Record<string, string> => ({
  [`https://${host}/`]: page(
    'Zenith Bakery',
    `<p>${'Fresh bread baked daily in Karachi. '.repeat(12)}</p>${'<a href="/menu">Menu</a>'.repeat(6)}`,
  ),
});

/** In-memory internet: serves pages, injects failures, counts requests. */
export class FakeInternet implements PageFetcher {
  readonly requested: string[] = [];
  readonly failures = new Map<string, FetchError>();
  constructor(readonly sites: Record<string, string> = {}) {}

  add(site: Record<string, string>): this {
    Object.assign(this.sites, site);
    return this;
  }

  async fetchText(url: string | URL, _options: SafeFetchOptions): Promise<SafeFetchResult> {
    const key = typeof url === 'string' ? url : url.href;
    this.requested.push(key);
    const failure = this.failures.get(key) ?? this.failures.get(new URL(key).origin + '/*');
    if (failure) throw failure;
    const body = this.sites[key];
    if (body === undefined) throw new FetchError('HTTP 404', 'HTTP_ERROR', 404);
    return {
      url: key,
      status: 200,
      contentType: 'text/html',
      body,
      bytes: body.length,
      redirects: [],
    };
  }
}

export async function createWorkspace(prisma: PrismaClient) {
  const user = await prisma.user.create({
    data: { email: `enr-${randomUUID()}@example.test`, name: 'Enrich Test', passwordHash: 'x' },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: 'WS',
      slug: `ws-${randomUUID()}`,
      members: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  return { userId: user.id, workspaceId: workspace.id };
}

export function createCompany(
  prisma: PrismaClient,
  workspaceId: string,
  extra: Record<string, unknown> = {},
  name = 'Acme Technologies Pvt. Ltd.',
): Promise<Company> {
  return prisma.company.create({
    data: {
      workspaceId,
      displayName: name,
      nameKey: name.toLowerCase(),
      coreName: 'acme',
      nameTokens: ['acme', 'technologies'],
      coreTokens: ['acme'],
      country: 'PK',
      city: 'Lahore',
      ...extra,
    },
  });
}

export function createRun(
  prisma: PrismaClient,
  fixture: { workspaceId: string; userId: string },
  companyId: string,
): Promise<ExtractionRun> {
  return prisma.extractionRun.create({
    data: {
      workspaceId: fixture.workspaceId,
      companyId,
      requestedById: fixture.userId,
      activeKey: companyId,
    },
  });
}

export async function waitForTerminalRun(
  prisma: PrismaClient,
  runId: string,
  timeoutMs = 20_000,
): Promise<ExtractionRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await prisma.extractionRun.findUniqueOrThrow({ where: { id: runId } });
    if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`Run ${runId} stuck in ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
