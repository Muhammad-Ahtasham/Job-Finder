import { describe, expect, it } from 'vitest';
import {
  createFixtureProviders,
  createProviders,
  DefaultCompanyDeduplicationService,
  DefaultCompanyNormalizationService,
  type CompanyCandidate,
  type ExistingCompanySnapshot,
  type DiscoveryProjectInput,
} from '../src';

const project: DiscoveryProjectInput = {
  country: 'PK',
  city: 'Lahore',
  industry: 'Software Development',
  keywords: ['Software House', 'SaaS Company', 'Technology Company'],
};

describe('fixture providers (dev/demo only)', () => {
  it('are disabled unless explicitly allowed (never in production)', () => {
    const off = createProviders({ enabled: ['fixture-directory', 'fixture-map'], userAgent: 'ua' });
    expect(off.providers).toHaveLength(0);
    expect(off.skipped.map((s) => s.reason)).toEqual([
      'fixture providers are synthetic and disabled in production',
      'fixture providers are synthetic and disabled in production',
    ]);
    const on = createProviders({
      enabled: ['fixture-directory', 'fixture-map'],
      userAgent: 'ua',
      allowFixtures: true,
    });
    expect(on.providers.map((p) => p.id)).toEqual(['fixture-directory', 'fixture-map']);
  });

  it('only return synthetic, clearly labelled companies', async () => {
    for (const provider of createFixtureProviders()) {
      const pages = await Promise.all(provider.planQueries(project).map((q) => provider.search(q)));
      const names = pages.flatMap((p) => p.candidates.map((c) => c.name));
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((n) => n.startsWith('Fixture '))).toBe(true);
      expect(provider.terms.attribution).toMatch(/Synthetic/);
    }
  });

  it('exercise match, review and incomplete-company paths through normalize + dedupe', async () => {
    const [directory, map] = createFixtureProviders();
    const normalizer = new DefaultCompanyNormalizationService();
    const dedupe = new DefaultCompanyDeduplicationService();
    const collect = async (provider: typeof directory): Promise<CompanyCandidate[]> => {
      const pages = await Promise.all(
        provider!.planQueries(project).map((q) => provider!.search(q)),
      );
      return pages.flatMap((p) => p.candidates);
    };

    // Fold both providers into an in-memory "workspace", the way the persister does.
    const store: ExistingCompanySnapshot[] = [];
    const outcomes: Record<string, string> = {};
    const seenSourceKeys = new Set<string>(); // the persister's per-run idempotency check
    for (const [provider, candidates] of [
      [directory!, await collect(directory!)],
      [map!, await collect(map!)],
    ] as const) {
      for (const candidate of candidates) {
        const n = normalizer.normalize(candidate, {
          country: 'PK',
          city: 'Lahore',
          cityTrusted: provider.cityScoped,
        });
        if (!n.ok) continue;
        const sourceKey = `${provider.id}|${n.value.sourceKey}`;
        if (seenSourceKeys.has(sourceKey)) continue; // same hit via another keyword: recorded once
        seenSourceKeys.add(sourceKey);
        const decision = dedupe.decide(n.value, store);
        outcomes[`${provider.id}:${candidate.name}`] = decision.type;
        if (decision.type === 'MATCH') continue;
        store.push({
          id: `${store.length}`,
          displayName: n.value.displayName,
          nameKey: n.value.nameKey,
          coreName: n.value.coreName,
          nameTokens: n.value.nameTokens,
          coreTokens: n.value.coreTokens,
          cityKeys: n.value.cityKey ? [n.value.cityKey] : [],
          addresses: n.value.address?.tokens.length ? [n.value.address.tokens] : [],
          domains: n.value.website ? [n.value.website.domain] : [],
          phones: n.value.phones,
          registrationNumbers: [],
          providerIds: [],
        });
      }
    }

    expect(outcomes['fixture-map:Fixture Alpha Soft']).toBe('MATCH'); // shared domain
    expect(outcomes['fixture-map:Fixture Beta Systems']).toBe('REVIEW'); // ambiguous, never auto-merged
    expect(outcomes['fixture-map:Fixture Epsilon Works']).toBe('NEW'); // incomplete but kept
    expect(outcomes['fixture-directory:Fixture Gamma Labs']).toBe('NEW');
    expect(outcomes['fixture-map:Fixture Zeta Digital']).toBe('NEW'); // shares only the word "Fixture"
    // Exactly one ambiguous pair in the whole dataset: no review noise.
    expect(Object.values(outcomes).filter((outcome) => outcome === 'REVIEW')).toHaveLength(1);
  });
});
