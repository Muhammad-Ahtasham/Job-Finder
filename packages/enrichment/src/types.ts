/**
 * Contracts for company website enrichment. This package is pure TypeScript: no database,
 * no NestJS. The worker owns persistence and orchestration.
 *
 * Everything crawled is UNTRUSTED input. It is parsed deterministically, size-bounded, and
 * only ever treated as data: no script is executed and no instruction in it is followed.
 */

/** Mirrors the database FieldStatus. MISSING is a company-level state, not a result. */
export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'FAILED';

export const PAGE_TYPES = [
  'HOMEPAGE',
  'ABOUT',
  'CONTACT',
  'CAREERS',
  'JOBS',
  'TEAM',
  'OTHER',
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const EMAIL_CATEGORIES = ['HR', 'CAREERS', 'RECRUITMENT', 'GENERAL', 'OTHER'] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export type ClassifiedBy = 'RULES' | 'AI';

export type WebsiteDecision = 'OFFICIAL' | 'REJECTED' | 'UNCERTAIN';

/** One observed fact for or against a decision. `weight` is signed and shown to reviewers. */
export interface Evidence {
  signal: string;
  detail: string;
  weight: number;
  url?: string;
}

export interface WebsiteVerificationInput {
  companyName: string;
  city?: string | null;
  candidateWebsite: string;
}

export interface EnrichmentError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface FetchedPage {
  url: string;
  html: string;
}

export interface WebsiteVerificationResult {
  candidateUrl: string;
  /** Homepage after redirects. Absent when it could not be fetched. */
  finalUrl?: string;
  /** Registrable domain of the page that was actually evaluated. */
  domain?: string;
  decision: WebsiteDecision;
  /** 0..1. How sure we are of `decision`, from the weighted evidence. */
  confidence: number;
  evidence: Evidence[];
  /** OFFICIAL → VERIFIED · REJECTED → FAILED · UNCERTAIN → UNVERIFIED. */
  status: VerificationStatus;
  /** Set when the decision is UNCERTAIN only because the site could not be reached. */
  error?: EnrichmentError;
  /** The fetched homepage, so discovery need not fetch it twice. Never persisted. */
  homepage?: FetchedPage;
}

export type PageFetchStatus =
  | 'FETCHED'
  | 'DISCOVERED' // known from a link, deliberately not fetched (e.g. an external job board)
  | 'BLOCKED_ROBOTS'
  | 'BLOCKED_UNSAFE'
  | 'FAILED';

export interface DiscoveredPage {
  url: string;
  type: PageType;
  typeConfidence: number;
  classifiedBy: ClassifiedBy;
  title?: string;
  fetchStatus: PageFetchStatus;
  httpStatus?: number;
  contentType?: string;
  /** SHA-256 of the extracted visible text: detects changes without storing the page. */
  contentHash?: string;
  errorCode?: string;
  /** URL of the page whose link led here. */
  discoveredFrom?: string;
  depth: number;
  /** True when the page lives on another registrable domain (e.g. an ATS job board). */
  external: boolean;
  fetchedAt?: Date;
}

export type ContactKind = 'EMAIL' | 'LINKEDIN';
export type ExtractionMethod =
  'MAILTO' | 'TEXT' | 'JSON_LD' | 'OBFUSCATED' | 'CLOUDFLARE_PROTECTED' | 'AI_ASSISTED' | 'LINK';

export interface ExtractedContact {
  kind: ContactKind;
  /** Lower-cased e-mail address or canonical LinkedIn company URL. */
  value: string;
  category?: EmailCategory;
  classifiedBy: ClassifiedBy;
  confidence: number;
  /**
   * VERIFIED means exactly one thing: the value is published on a page of the verified
   * official website (and, for e-mail, on the company's own domain). It is NEVER a claim that
   * the mailbox exists or accepts mail — nothing here sends mail or probes SMTP/DNS.
   */
  verificationStatus: VerificationStatus;
  verificationMethod: string;
  sourceUrl: string;
  extractionMethod: ExtractionMethod;
  extractedAt: Date;
  /** E-mail only: the address is on the company's own domain. */
  domainMatch?: boolean;
  /** Short quote around the value, for reviewers. */
  context?: string;
}

export interface CrawlStats {
  requests: number;
  pagesFetched: number;
  blockedByRobots: number;
  blockedUnsafe: number;
  failed: number;
  aiCalls: number;
}

export interface SiteDiscoveryInput {
  companyName: string;
  /** Verified homepage URL. */
  siteUrl: string;
  /** Mark contacts VERIFIED only when the site is verified (manual approval counts). */
  siteVerified: boolean;
  homepage?: FetchedPage;
}

export interface SiteDiscoveryResult {
  pages: DiscoveredPage[];
  contacts: ExtractedContact[];
  stats: CrawlStats;
  errors: EnrichmentError[];
}

export interface EnrichmentContext {
  signal?: AbortSignal;
}

export interface WebsiteEnrichmentProvider {
  readonly id: string;
  /** Decide whether `candidateWebsite` is really this company's official site, with evidence. */
  verifyWebsite(
    input: WebsiteVerificationInput,
    context?: EnrichmentContext,
  ): Promise<WebsiteVerificationResult>;
  /** Discover pages and publicly published contacts on an already-chosen site. */
  discoverSite(
    input: SiteDiscoveryInput,
    context?: EnrichmentContext,
  ): Promise<SiteDiscoveryResult>;
}

/** Finds candidate websites for a company that has none (e.g. via a licensed search API). */
export interface WebsiteCandidateFinder {
  readonly id: string;
  findCandidates(
    input: { companyName: string; city?: string | null; country?: string },
    context?: EnrichmentContext,
  ): Promise<string[]>;
}
