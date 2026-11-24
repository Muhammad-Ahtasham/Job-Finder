import { foldText, tokenize } from '../normalization/text';
import type {
  CompanyCandidate,
  CompanyDiscoveryProvider,
  DiscoveryPage,
  DiscoveryProjectInput,
  DiscoveryQuery,
  ProviderRateLimit,
  ProviderTerms,
} from '../types';

interface FixtureCompany {
  name: string;
  externalId?: string;
  websiteUrl?: string;
  address?: CompanyCandidate['address'];
  phones?: string[];
  /** Matches when any word of a search keyword appears here. */
  topics: string[];
}

/**
 * DEVELOPMENT / DEMO ONLY. Synthetic companies (names prefixed "Fixture", invented
 * domains that are never fetched) so the whole pipeline — queues, dedupe, reviews, progress,
 * UI — can be exercised without API keys or network access. The factory refuses to create
 * these in production, and they carry no real data.
 *
 * The two datasets overlap on purpose:
 *  - "Fixture Alpha Soft" appears in both and shares a domain  → matched automatically
 *  - "Fixture Beta Systems" appears in both but one side has no website or city → ambiguous,
 *    raised for human review (never auto-merged)
 *  - "Fixture Gamma Labs" / "Fixture Epsilon Works" have no website → kept as incomplete
 */
const DIRECTORY: FixtureCompany[] = [
  {
    name: 'Fixture Alpha Soft Pvt Ltd',
    websiteUrl: 'https://www.fixture-alpha-soft.com.pk/',
    topics: ['software', 'it'],
  },
  { name: 'Fixture Beta Systems', websiteUrl: undefined, topics: ['software', 'saas'] },
  { name: 'Fixture Gamma Labs', topics: ['technology'] },
  {
    name: 'Fixture Delta Technologies',
    websiteUrl: 'https://fixture-delta-tech.com.pk',
    topics: ['technology', 'it'],
  },
];

const MAP: FixtureCompany[] = [
  {
    name: 'Fixture Alpha Soft',
    externalId: 'fixture/1',
    websiteUrl: 'https://fixture-alpha-soft.com.pk',
    address: { line: 'Block 4, Gulberg III' },
    phones: ['042 111 000 001'],
    topics: ['software', 'it'],
  },
  {
    name: 'Fixture Beta Systems',
    externalId: 'fixture/2',
    address: { line: 'Johar Town' },
    topics: ['software', 'saas'],
  },
  { name: 'Fixture Epsilon Works', externalId: 'fixture/3', topics: ['software', 'technology'] },
  {
    name: 'Fixture Zeta Digital',
    externalId: 'fixture/4',
    websiteUrl: 'https://fixture-zeta-digital.com.pk',
    topics: ['saas', 'technology'],
  },
];

export class FixtureProvider implements CompanyDiscoveryProvider {
  readonly displayName: string;
  readonly terms: ProviderTerms = {
    termsUrl: 'https://example.invalid/synthetic-fixture-data',
    reviewedAt: '2026-11-25',
    storage: 'PERMANENT',
    attribution: 'Synthetic development fixture data',
    bulkAllowed: true,
    notes: 'Not real data. Disabled in production.',
  };
  readonly rateLimit: ProviderRateLimit = { maxRequests: 5, perMs: 1000, concurrency: 2 };

  constructor(
    readonly id: 'fixture-directory' | 'fixture-map',
    readonly cityScoped: boolean,
    private readonly data: FixtureCompany[],
  ) {
    this.displayName =
      id === 'fixture-map' ? 'Fixture map (dev only)' : 'Fixture directory (dev only)';
  }

  planQueries(project: DiscoveryProjectInput): DiscoveryQuery[] {
    return project.keywords.map((keyword) => ({
      kind: 'KEYWORD' as const,
      key: `kw:${foldText(keyword)}`,
      keyword,
      project,
    }));
  }

  async search(query: DiscoveryQuery): Promise<DiscoveryPage> {
    const words = new Set(tokenize(foldText(query.keyword ?? '')));
    const retrievedAt = new Date();
    const hits = this.data.filter((company) => company.topics.some((topic) => words.has(topic)));
    return {
      candidates: hits.map((company) => ({
        providerId: this.id,
        externalId: company.externalId,
        name: company.name,
        nameConfidence: 'HIGH' as const,
        websiteUrl: company.websiteUrl,
        address: company.address,
        phones: company.phones,
        matchedKeyword: query.keyword,
        retrievedAt,
        raw: { fixture: true },
      })),
      filtered: 0,
    };
  }
}

export const createFixtureProviders = (): FixtureProvider[] => [
  new FixtureProvider('fixture-directory', false, DIRECTORY),
  new FixtureProvider('fixture-map', true, MAP),
];
