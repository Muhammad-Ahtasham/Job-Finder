import { isAggregatorDomain, normalizeWebsite } from '@jobfinder/discovery';
import { AI_CONFIDENCE_CAP, type AiAssistant } from './ai';
import {
  AMBIGUOUS_BELOW,
  classifyEmailDeterministic,
  emailDomainMatches,
  emailPublicationConfidence,
  extractEmailCandidates,
  normalizeEmail,
} from './emails';
import { contentHash, parsePage, type ParsedPage } from './html';
import { extractLinkedInCompanies, rankLinkedIn } from './linkedin';
import {
  canonicalizeUrl,
  classifyPage,
  isKnownJobBoard,
  looksLikeErrorPage,
  registrableDomain,
} from './pages';
import { FetchError } from './security/errors';
import type { PageFetcher } from './security/polite-fetcher';
import type { SafeFetchResult } from './security/safe-fetcher';
import type {
  CrawlStats,
  DiscoveredPage,
  EnrichmentContext,
  EnrichmentError,
  ExtractedContact,
  PageType,
  SiteDiscoveryInput,
  SiteDiscoveryResult,
  WebsiteEnrichmentProvider,
  WebsiteVerificationInput,
  WebsiteVerificationResult,
} from './types';
import { coreNameTokens, scoreWebsite } from './website-verification';

const HTML_TYPES = ['text/html', 'application/xhtml+xml'] as const;

/** Fetch priority and the well-known fallbacks tried only when the site never linked the page. */
const CRAWL_TYPES = ['CONTACT', 'CAREERS', 'JOBS', 'ABOUT', 'TEAM'] as const;
type CrawlType = (typeof CRAWL_TYPES)[number];
const PROBE_PATHS: Partial<Record<CrawlType, string[]>> = {
  CONTACT: ['/contact', '/contact-us'],
  CAREERS: ['/careers', '/jobs'],
  ABOUT: ['/about', '/about-us'],
};

export interface CrawlerProviderOptions {
  fetcher: PageFetcher;
  ai?: AiAssistant;
  /** Hard cap on page requests per site (robots.txt not counted). */
  maxRequests?: number;
  /** Hard cap on AI calls per site. */
  maxAiCalls?: number;
}

function toEnrichmentError(error: unknown): EnrichmentError {
  if (error instanceof FetchError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'UNEXPECTED',
    message: error instanceof Error ? error.message : 'Unexpected error',
    retryable: false,
  };
}

/**
 * Website enrichment over plain HTTP + deterministic HTML parsing. Nothing is executed.
 * Every request goes through the injected PageFetcher (SSRF-guarded, robots-aware,
 * rate-limited); LinkedIn is never fetched — its URLs are only read from the company's own site.
 */
export class CrawlerWebsiteEnrichmentProvider implements WebsiteEnrichmentProvider {
  readonly id = 'http-crawler';
  private readonly fetcher: PageFetcher;
  private readonly ai?: AiAssistant;
  private readonly maxRequests: number;
  private readonly maxAiCalls: number;

  constructor(options: CrawlerProviderOptions) {
    this.fetcher = options.fetcher;
    this.ai = options.ai;
    this.maxRequests = options.maxRequests ?? 12;
    this.maxAiCalls = options.maxAiCalls ?? 8;
  }

  // ------------------------------------------------------------ verification

  async verifyWebsite(
    input: WebsiteVerificationInput,
    context: EnrichmentContext = {},
  ): Promise<WebsiteVerificationResult> {
    const site = normalizeWebsite(input.candidateWebsite);
    const base = { candidateUrl: input.candidateWebsite };
    if (!site) {
      return {
        ...base,
        decision: 'REJECTED',
        confidence: 1,
        status: 'FAILED',
        evidence: [{ signal: 'INVALID_URL', detail: 'Not a plain http(s) website', weight: -1 }],
      };
    }
    if (isAggregatorDomain(site.domain)) {
      return {
        ...base,
        domain: site.domain,
        decision: 'REJECTED',
        confidence: 0.99,
        status: 'FAILED',
        evidence: [
          {
            signal: 'AGGREGATOR_DOMAIN',
            detail: `${site.domain} is a directory, social network or job board, not the company's own site`,
            weight: -1,
          },
        ],
      };
    }

    let fetched: SafeFetchResult;
    try {
      fetched = await this.fetcher.fetchText(site.url, {
        allowedContentTypes: HTML_TYPES,
        signal: context.signal,
      });
    } catch (error) {
      const failure = toEnrichmentError(error);
      const unsafe = error instanceof FetchError && error.unsafe;
      return {
        ...base,
        domain: site.domain,
        decision: unsafe ? 'REJECTED' : 'UNCERTAIN',
        confidence: unsafe ? 1 : 0,
        status: unsafe ? 'FAILED' : 'UNVERIFIED',
        evidence: [
          {
            signal: unsafe ? 'UNSAFE_URL' : 'UNREACHABLE',
            detail: failure.message,
            weight: unsafe ? -1 : 0,
          },
        ],
        error: failure,
      };
    }

    const finalDomain = registrableDomain(fetched.url);
    if (finalDomain && isAggregatorDomain(finalDomain)) {
      return {
        ...base,
        finalUrl: fetched.url,
        domain: finalDomain,
        decision: 'REJECTED',
        confidence: 0.99,
        status: 'FAILED',
        evidence: [
          {
            signal: 'AGGREGATOR_DOMAIN',
            detail: `${site.domain} redirects to ${finalDomain}`,
            weight: -1,
            url: fetched.url,
          },
        ],
      };
    }

    const page = parsePage(fetched.body, fetched.url);
    const score = scoreWebsite({
      companyName: input.companyName,
      city: input.city,
      requestedDomain: site.domain,
      finalUrl: fetched.url,
      page,
    });
    return {
      ...base,
      finalUrl: fetched.url,
      domain: score.domain,
      decision: score.decision,
      confidence: score.confidence,
      status: score.status,
      evidence: score.evidence,
      homepage: { url: fetched.url, html: fetched.body },
    };
  }

  // ------------------------------------------------------------- discovery

  async discoverSite(
    input: SiteDiscoveryInput,
    context: EnrichmentContext = {},
  ): Promise<SiteDiscoveryResult> {
    const run = new SiteCrawl(
      this.fetcher,
      this.ai,
      this.maxRequests,
      this.maxAiCalls,
      input,
      context,
    );
    return run.execute();
  }
}

interface FetchedSitePage {
  result: SafeFetchResult;
  parsed: ParsedPage;
}

/** One crawl of one site. Holds all per-run state so the provider itself stays stateless. */
class SiteCrawl {
  private readonly pages = new Map<string, DiscoveredPage>();
  private readonly contacts = new Map<string, ExtractedContact>();
  private readonly errors: EnrichmentError[] = [];
  private readonly stats: CrawlStats = {
    requests: 0,
    pagesFetched: 0,
    blockedByRobots: 0,
    blockedUnsafe: 0,
    failed: 0,
    aiCalls: 0,
  };
  private readonly tokens: string[];
  private readonly siteDomain: string;
  private readonly linkedin: { url: string; fromJsonLd: boolean }[] = [];

  constructor(
    private readonly fetcher: PageFetcher,
    private readonly ai: AiAssistant | undefined,
    private readonly maxRequests: number,
    private readonly maxAiCalls: number,
    private readonly input: SiteDiscoveryInput,
    private readonly context: EnrichmentContext,
  ) {
    this.tokens = coreNameTokens(input.companyName);
    this.siteDomain = registrableDomain(input.siteUrl) ?? new URL(input.siteUrl).hostname;
  }

  async execute(): Promise<SiteDiscoveryResult> {
    const homepage = await this.loadHomepage();
    if (homepage) {
      const homeUrl = canonicalizeUrl(homepage.result.url);
      await this.record(homepage, homeUrl, 'HOMEPAGE', 1, 'RULES', undefined, 0);
      await this.crawlLinked(homepage, homeUrl);
    }
    this.finishContacts();
    return {
      pages: [...this.pages.values()],
      contacts: [...this.contacts.values()],
      stats: this.stats,
      errors: this.errors,
    };
  }

  private get budgetLeft(): boolean {
    return this.stats.requests < this.maxRequests && !this.context.signal?.aborted;
  }

  private async loadHomepage(): Promise<FetchedSitePage | undefined> {
    const pre = this.input.homepage;
    if (pre) {
      return {
        result: this.fromPrefetched(pre.url, pre.html),
        parsed: parsePage(pre.html, pre.url),
      };
    }
    return this.fetchPage(this.input.siteUrl, 'HOMEPAGE', undefined, 0);
  }

  private fromPrefetched(url: string, html: string): SafeFetchResult {
    return {
      url,
      status: 200,
      contentType: 'text/html',
      body: html,
      bytes: html.length,
      redirects: [],
    };
  }

  /** Fetch one page; failures become page rows + tracked errors, never exceptions. */
  private async fetchPage(
    url: string,
    type: PageType,
    from: string | undefined,
    depth: number,
    options: { quietNotFound?: boolean } = {},
  ): Promise<FetchedSitePage | undefined> {
    if (!this.budgetLeft) return undefined;
    this.stats.requests += 1;
    try {
      const result = await this.fetcher.fetchText(url, {
        allowedContentTypes: HTML_TYPES,
        signal: this.context.signal,
      });
      // A redirect off the company's domain is not "the company's page": use nothing from it.
      if (registrableDomain(result.url) !== this.siteDomain) {
        this.stats.failed += 1;
        this.setPage({
          ...this.blank(canonicalizeUrl(url), type, from, depth),
          fetchStatus: 'FAILED',
          errorCode: 'OFF_SITE_REDIRECT',
        });
        return undefined;
      }
      this.stats.pagesFetched += 1;
      return { result, parsed: parsePage(result.body, result.url) };
    } catch (error) {
      const failure = toEnrichmentError(error);
      const fetchError = error instanceof FetchError ? error : undefined;
      const robots = fetchError?.code === 'ROBOTS_DISALLOWED';
      const notFound = fetchError?.httpStatus === 404 || fetchError?.httpStatus === 410;

      if (robots) this.stats.blockedByRobots += 1;
      else if (fetchError?.unsafe) this.stats.blockedUnsafe += 1;
      else if (!(options.quietNotFound && notFound)) this.stats.failed += 1;

      if (options.quietNotFound && (notFound || robots)) {
        return undefined; // a guessed URL that is not there is not worth a record
      }
      this.errors.push(failure);
      this.setPage({
        ...this.blank(canonicalizeUrl(url), type, from, depth),
        fetchStatus:
          fetchError?.code === 'ROBOTS_DISALLOWED' || fetchError?.code === 'ROBOTS_UNAVAILABLE'
            ? 'BLOCKED_ROBOTS'
            : fetchError?.unsafe
              ? 'BLOCKED_UNSAFE'
              : 'FAILED',
        httpStatus: fetchError?.httpStatus,
        errorCode: failure.code,
      });
      return undefined;
    }
  }

  private blank(
    url: string,
    type: PageType,
    from: string | undefined,
    depth: number,
  ): DiscoveredPage {
    return {
      url,
      type,
      typeConfidence: 0,
      classifiedBy: 'RULES',
      fetchStatus: 'DISCOVERED',
      discoveredFrom: from,
      depth,
      external: registrableDomain(url) !== this.siteDomain,
    };
  }

  private setPage(page: DiscoveredPage): void {
    const existing = this.pages.get(page.url);
    // A fetched record is never downgraded by a later "discovered" one.
    if (!existing || existing.fetchStatus !== 'FETCHED' || page.fetchStatus === 'FETCHED') {
      this.pages.set(page.url, page);
    }
  }

  /** Store a fetched page, run extraction on it, and return the final type it was given. */
  private async record(
    fetched: FetchedSitePage,
    url: string,
    type: PageType,
    confidence: number,
    classifiedBy: 'RULES' | 'AI',
    from: string | undefined,
    depth: number,
  ): Promise<PageType> {
    const { parsed, result } = fetched;
    let finalType = type;
    let finalConfidence = confidence;
    if (type !== 'HOMEPAGE' && looksLikeErrorPage(parsed.title, parsed.text)) {
      finalType = 'OTHER';
      finalConfidence = 0.9;
    }
    this.setPage({
      url,
      type: finalType,
      typeConfidence: finalConfidence,
      classifiedBy,
      title: parsed.title || undefined,
      fetchStatus: 'FETCHED',
      httpStatus: result.status,
      contentType: result.contentType,
      contentHash: contentHash(parsed.text),
      discoveredFrom: from,
      depth,
      external: false,
      fetchedAt: new Date(),
    });
    // Contacts are only taken from pages that really are what they claim to be.
    if (!(finalType === 'OTHER' && type !== 'OTHER')) await this.extract(parsed, url, finalType);
    return finalType;
  }

  // ------------------------------------------------------------ link crawl

  private async crawlLinked(home: FetchedSitePage, homeUrl: string): Promise<void> {
    type Candidate = { url: string; type: CrawlType; confidence: number; ambiguous: boolean };
    const best = new Map<CrawlType, Candidate>();

    for (const link of home.parsed.links) {
      let host: string;
      try {
        host = new URL(link.url).hostname;
      } catch {
        continue;
      }
      const url = canonicalizeUrl(link.url);
      const classification = classifyPage(url, link.text);
      const type = classification.type;
      if (type === 'HOMEPAGE' || type === 'OTHER') continue;

      if (registrableDomain(host) !== this.siteDomain) {
        // Off-site: only a known job board linked as careers/jobs is worth remembering.
        if (
          (type === 'CAREERS' || type === 'JOBS') &&
          isKnownJobBoard(host) &&
          !this.pages.has(url)
        ) {
          this.setPage({
            ...this.blank(url, type, homeUrl, 1),
            typeConfidence: classification.confidence,
            fetchStatus: 'DISCOVERED',
          });
        }
        continue;
      }
      const current = best.get(type);
      if (
        !current ||
        classification.confidence > current.confidence ||
        (classification.confidence === current.confidence && url.length < current.url.length)
      ) {
        best.set(type, {
          url,
          type,
          confidence: classification.confidence,
          ambiguous: classification.ambiguous,
        });
      }
    }

    for (const type of CRAWL_TYPES) {
      const candidate = best.get(type);
      if (!candidate || candidate.url === homeUrl || !this.budgetLeft) continue;
      const fetched = await this.fetchPage(candidate.url, type, homeUrl, 1);
      if (!fetched) continue;
      await this.recordClassified(
        fetched,
        candidate.url,
        type,
        candidate.confidence,
        candidate.ambiguous,
        homeUrl,
      );
    }

    for (const type of CRAWL_TYPES) {
      if (this.hasPage(type) || (type === 'CAREERS' && this.hasPage('JOBS'))) continue;
      for (const path of PROBE_PATHS[type] ?? []) {
        if (!this.budgetLeft) break;
        const url = canonicalizeUrl(new URL(path, homeUrl).href);
        if (this.pages.has(url)) continue;
        const fetched = await this.fetchPage(url, type, undefined, 1, { quietNotFound: true });
        if (!fetched) continue;
        const final = await this.recordClassified(fetched, url, type, 0.8, false, undefined);
        if (final === type) break;
      }
    }
  }

  /** A page of this type was fetched, or (for off-site job boards) at least discovered. */
  private hasPage(type: PageType): boolean {
    return [...this.pages.values()].some(
      (p) => p.type === type && (p.fetchStatus === 'FETCHED' || p.fetchStatus === 'DISCOVERED'),
    );
  }

  /** Record a page; when the type is ambiguous, ask the optional AI assistant to confirm it. */
  private async recordClassified(
    fetched: FetchedSitePage,
    url: string,
    type: CrawlType,
    confidence: number,
    ambiguous: boolean,
    from: string | undefined,
  ): Promise<PageType> {
    let finalType: PageType = type;
    let finalConfidence = confidence;
    let by: 'RULES' | 'AI' = 'RULES';
    if (ambiguous && this.ai && this.aiAvailable()) {
      this.stats.aiCalls += 1;
      const opinion = await this.ai.classifyPage({
        url,
        title: fetched.parsed.title,
        headings: fetched.parsed.h1,
        snippet: fetched.parsed.text.slice(0, 1500),
        candidates: ['ABOUT', 'CONTACT', 'CAREERS', 'JOBS', 'TEAM'],
      });
      if (opinion) {
        finalType = opinion.type;
        finalConfidence = Math.min(opinion.confidence, AI_CONFIDENCE_CAP);
        by = 'AI';
      }
    }
    return this.record(fetched, url, finalType, finalConfidence, by, from, 1);
  }

  private aiAvailable(): boolean {
    return this.stats.aiCalls < this.maxAiCalls;
  }

  // ------------------------------------------------------------ extraction

  private async extract(parsed: ParsedPage, url: string, pageType: PageType): Promise<void> {
    const now = new Date();
    const found = extractEmailCandidates(parsed);

    if (
      found.length === 0 &&
      this.ai &&
      (pageType === 'CONTACT' || pageType === 'CAREERS' || pageType === 'JOBS')
    ) {
      const hint = /\bat\b[\s\S]{0,60}\bdot\b/i.exec(parsed.text);
      if (hint && this.aiAvailable()) {
        this.stats.aiCalls += 1;
        const start = Math.max(0, (hint.index ?? 0) - 200);
        const snippet = parsed.text.slice(start, start + 600);
        for (const email of await this.ai.extractEmails({ snippet })) {
          const normalized = normalizeEmail(email);
          if (normalized)
            found.push({ email: normalized, method: 'AI_ASSISTED', context: snippet });
        }
      }
    }

    for (const candidate of found) {
      const domainMatch = emailDomainMatches(candidate.email, this.siteDomain);
      let classification = classifyEmailDeterministic(candidate.email, {
        pageType,
        text: candidate.context,
      });
      let classifiedBy: 'RULES' | 'AI' = 'RULES';
      if (classification.confidence < AMBIGUOUS_BELOW && this.ai && this.aiAvailable()) {
        this.stats.aiCalls += 1;
        const opinion = await this.ai.classifyEmail({
          email: candidate.email,
          context: candidate.context,
          pageType,
        });
        if (opinion && opinion.confidence > classification.confidence) {
          classification = {
            ...classification,
            category: opinion.category,
            confidence: opinion.confidence,
          };
          classifiedBy = 'AI';
        }
      }
      const verified = this.input.siteVerified && domainMatch && candidate.method !== 'AI_ASSISTED';
      const contact: ExtractedContact = {
        kind: 'EMAIL',
        value: candidate.email,
        category: classification.category,
        classifiedBy,
        confidence: emailPublicationConfidence({ method: candidate.method, domainMatch, pageType }),
        verificationStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
        verificationMethod: verified
          ? 'PUBLISHED_ON_VERIFIED_SITE'
          : !domainMatch
            ? 'EXTERNAL_DOMAIN_ADDRESS'
            : 'PUBLISHED_ON_UNVERIFIED_SITE',
        sourceUrl: url,
        extractionMethod: candidate.method,
        extractedAt: now,
        domainMatch,
        context: candidate.context,
      };
      const existing = this.contacts.get(contact.value);
      if (!existing || contact.confidence > existing.confidence)
        this.contacts.set(contact.value, contact);
    }

    for (const link of parsed.links) {
      const li = extractLinkedInCompanies(link.url);
      if (li) this.linkedin.push({ url: li, fromJsonLd: false });
    }
    for (const same of parsed.jsonLd.sameAs) {
      const li = extractLinkedInCompanies(same);
      if (li) this.linkedin.push({ url: li, fromJsonLd: true });
    }
  }

  private finishContacts(): void {
    if (this.linkedin.length === 0) return;
    const sourceUrl = this.input.siteUrl;
    for (const ranked of rankLinkedIn(this.linkedin, this.tokens)) {
      const verified = this.input.siteVerified && ranked.primary;
      this.contacts.set(ranked.url, {
        kind: 'LINKEDIN',
        value: ranked.url,
        classifiedBy: 'RULES',
        confidence: ranked.confidence,
        verificationStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
        verificationMethod: verified ? 'LINKED_FROM_VERIFIED_SITE' : 'LINKED_FROM_UNVERIFIED_SITE',
        sourceUrl,
        extractionMethod: 'LINK',
        extractedAt: new Date(),
      });
    }
  }
}
