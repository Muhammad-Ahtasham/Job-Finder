/**
 * Contracts for job discovery. Pure TypeScript: no database, no NestJS. The worker owns
 * persistence and orchestration.
 */

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERNSHIP',
  'TEMPORARY',
  'OTHER',
  'UNKNOWN',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORKPLACE_TYPES = ['ONSITE', 'REMOTE', 'HYBRID', 'UNKNOWN'] as const;
export type WorkplaceType = (typeof WORKPLACE_TYPES)[number];

export type ExtractionKind = 'API' | 'JSON_LD' | 'MICRODATA' | 'HTML' | 'AI';

/** A job board on a supported ATS, or a generic career page. */
export interface BoardRef {
  providerId: string;
  /** Provider-specific identifier: Greenhouse board token, Lever site, Ashby board name, or page URL. */
  boardKey: string;
  /** Public URL of the board (what a person would open). */
  boardUrl: string;
  /** Lever only: which Lever instance hosts the site. */
  region?: 'eu';
}

export interface NormalizedJob {
  providerId: string;
  boardKey: string;
  /** The provider's own stable id (generic pages: a hash of the job URL). */
  externalId: string;
  title: string;
  /** Plain text only: provider HTML is stripped, never stored or rendered. */
  description: string | null;
  location: string | null;
  locations: string[];
  department: string | null;
  employmentType: EmploymentType;
  workplaceType: WorkplaceType;
  /** Exactly as the provider published it. Never rewritten, never submitted to. */
  applicationUrl: string | null;
  /** The page describing the job. */
  sourceUrl: string;
  publishedAt: Date | null;
  /** Only when the source published an expiry date (JSON-LD `validThrough`). */
  expiresAt?: Date | null;
  /**
   * Set only when the source itself marks the posting as closed (not merely absent from a list):
   * the one case where a job is closed without a confirming second check.
   */
  explicitlyClosed?: boolean;
  extraction: ExtractionKind;
}

export interface JobFetchError {
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
}

/**
 * The four outcomes are deliberately distinct. Only NO_OPENINGS means "there are no
 * vacancies"; FAILED and INCONCLUSIVE mean "we do not know".
 */
export type JobFetchResult =
  /** Jobs were found. `authoritative`: the official API answered completely, so a job it no longer lists is closed. */
  | { outcome: 'JOBS'; jobs: NormalizedJob[]; pagesFetched: number; authoritative: boolean }
  /** The source positively reported zero openings (empty API answer, or the page says so). */
  | { outcome: 'NO_OPENINGS'; pagesFetched: number; authoritative: boolean; evidence: string }
  /** A page was read but nothing could be extracted and it does not say there are no jobs. */
  | { outcome: 'INCONCLUSIVE'; reason: string; pagesFetched: number }
  /** The request failed. `jobs` holds whatever was read before the failure (never used to close jobs). */
  | { outcome: 'FAILED'; error: JobFetchError; jobs: NormalizedJob[]; pagesFetched: number };

export interface JobProviderContext {
  signal?: AbortSignal;
  ai?: AiJobExtractor;
}

export interface JobProviderTerms {
  docsUrl: string;
  /** ISO date the documentation was last read. */
  reviewedAt: string;
  notes?: string;
}

export interface JobDiscoveryProvider {
  readonly id: string;
  readonly displayName: string;
  readonly terms: JobProviderTerms;
  /** Recognise a board from a URL (pure; no network). */
  identify(url: string): BoardRef | null;
  /** Fetch every published job, following pagination where the API has it. Never throws for source failures. */
  fetchJobs(board: BoardRef, context?: JobProviderContext): Promise<JobFetchResult>;
}

/** Optional AI fallback for career pages the deterministic extractors cannot read. */
export interface AiJobExtractor {
  extractJobs(input: {
    pageUrl: string;
    text: string;
    links: { text: string; url: string }[];
  }): Promise<{ title: string; url?: string; location?: string }[]>;
}
