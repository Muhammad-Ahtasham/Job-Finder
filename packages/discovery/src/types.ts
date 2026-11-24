/**
 * Provider-facing contracts for company discovery. This package is pure TypeScript:
 * no database, no NestJS. The worker owns persistence and orchestration.
 */

export type NameConfidence = 'HIGH' | 'LOW';

export interface CandidateAddress {
  line?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

/**
 * A company as returned by a provider, before normalization. Nothing here is verified:
 * a missing website / phone / description is normal and never a reason to drop it.
 */
export interface CompanyCandidate {
  providerId: string;
  /** The provider's own stable identifier (e.g. "node/123"), if it has one. */
  externalId?: string;
  name: string;
  /** LOW when the name was inferred (e.g. from a web page title or a domain). */
  nameConfidence: NameConfidence;
  websiteUrl?: string;
  description?: string;
  address?: CandidateAddress;
  coordinates?: { lat: number; lng: number };
  phones?: string[];
  /** Business registration identifiers when the source publishes them (scheme e.g. NTN, VATIN). */
  registrationNumbers?: { scheme: string; value: string }[];
  /** Where the provider found it (listing / result URL). */
  sourceUrl?: string;
  matchedKeyword?: string;
  retrievedAt: Date;
  /** Minimal provenance payload; only what the provider's terms allow us to persist. */
  raw?: Record<string, unknown>;
}

/** How long and in what form the provider's terms let us keep what it returns. */
export type StoragePolicy = 'PERMANENT' | 'TTL' | 'ID_ONLY';

export interface ProviderTerms {
  termsUrl: string;
  /** ISO date the terms were last read by a human; re-check periodically. */
  reviewedAt: string;
  storage: StoragePolicy;
  ttlDays?: number;
  /** Attribution text required by the licence (shown wherever the data is shown). */
  attribution?: string;
  /** Whether systematic / bulk harvesting is permitted by the terms. */
  bulkAllowed: boolean;
  notes?: string;
}

/** Enforced by the worker: one BullMQ queue per provider with this limiter + concurrency. */
export interface ProviderRateLimit {
  maxRequests: number;
  perMs: number;
  concurrency: number;
}

export interface DiscoveryProjectInput {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  city: string;
  industry: string;
  keywords: string[];
}

export type DiscoveryQueryKind = 'KEYWORD' | 'AREA';

export interface DiscoveryQuery {
  kind: DiscoveryQueryKind;
  /** Stable within (run, provider); used for idempotent task creation. */
  key: string;
  keyword?: string;
  project: DiscoveryProjectInput;
}

export interface DiscoveryPage {
  candidates: CompanyCandidate[];
  /** Results the provider dropped as non-companies (directories, social pages, ...). */
  filtered: number;
  /** Opaque cursor for the next page; absent when exhausted. */
  nextCursor?: string;
}

export interface SearchContext {
  signal?: AbortSignal;
}

export interface CompanyDiscoveryProvider {
  readonly id: string;
  readonly displayName: string;
  readonly terms: ProviderTerms;
  readonly rateLimit: ProviderRateLimit;
  /**
   * True when every result is guaranteed to lie inside the project's city (e.g. an
   * area-bounded map query). Only then may the project's city be assumed for a candidate
   * that did not state its own; otherwise "city unknown" must stay unknown.
   */
  readonly cityScoped: boolean;
  /** Which queries this provider needs for a project (keyword searches, area scans, ...). */
  planQueries(project: DiscoveryProjectInput): DiscoveryQuery[];
  /** Fetch one page. Must throw ProviderError for failures so the worker can classify them. */
  search(
    query: DiscoveryQuery,
    cursor: string | undefined,
    context?: SearchContext,
  ): Promise<DiscoveryPage>;
}

export type IdentityType = 'DOMAIN' | 'PROVIDER_ID' | 'REGISTRATION_NUMBER';

export interface IdentityKey {
  type: IdentityType;
  /** Namespace: provider id for PROVIDER_ID, scheme for REGISTRATION_NUMBER, '' for DOMAIN. */
  scope: string;
  value: string;
}

export interface NormalizedCandidate {
  candidate: CompanyCandidate;
  displayName: string;
  /** Folded name without legal suffixes ("arbisoft"). */
  nameKey: string;
  /** nameKey without generic industry words ("software", "technologies", ...). */
  coreName: string;
  nameTokens: string[];
  coreTokens: string[];
  countryCode: string;
  city?: string;
  cityKey?: string;
  website?: { url: string; host: string; domain: string };
  phones: string[];
  address?: { raw: string; tokens: string[] };
  identities: IdentityKey[];
  /** Deterministic per-provider key: makes persistence of the same hit idempotent. */
  sourceKey: string;
}

export type NormalizationRejectReason = 'EMPTY_NAME' | 'INVALID_NAME';

export type NormalizationResult =
  { ok: true; value: NormalizedCandidate } | { ok: false; reason: NormalizationRejectReason };

export interface NormalizationContext {
  country: string;
  /** The project's city. Applied to candidates lacking one only when `cityTrusted`. */
  city?: string;
  cityTrusted?: boolean;
}

export interface CompanyNormalizationService {
  normalize(candidate: CompanyCandidate, context: NormalizationContext): NormalizationResult;
}

/** The persisted facts about an existing company needed for matching. */
export interface ExistingCompanySnapshot {
  id: string;
  displayName: string;
  nameKey: string;
  coreName: string;
  nameTokens: string[];
  coreTokens: string[];
  cityKeys: string[];
  addresses: string[][];
  domains: string[];
  phones: string[];
  registrationNumbers: { scope: string; value: string }[];
  providerIds: { scope: string; value: string }[];
}

export interface MatchAlternative {
  companyId: string;
  score: number;
  reasons: string[];
}

export type DedupeDecision =
  | { type: 'NEW' }
  | { type: 'MATCH'; companyId: string; score: number; reasons: string[] }
  /** Ambiguous: keep the candidate as its own company and ask a human. Never auto-merged. */
  | { type: 'REVIEW'; alternatives: MatchAlternative[] };

export interface CompanyDeduplicationService {
  decide(candidate: NormalizedCandidate, existing: ExistingCompanySnapshot[]): DedupeDecision;
}
