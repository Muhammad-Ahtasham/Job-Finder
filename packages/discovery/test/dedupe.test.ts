import { describe, expect, it } from 'vitest';
import {
  DefaultCompanyDeduplicationService,
  DefaultCompanyNormalizationService,
  jaroWinkler,
  type CompanyCandidate,
  type ExistingCompanySnapshot,
} from '../src';

const normalizer = new DefaultCompanyNormalizationService();
const dedupe = new DefaultCompanyDeduplicationService();

function candidate(over: Partial<CompanyCandidate>) {
  const result = normalizer.normalize(
    { providerId: 'p1', name: 'X', nameConfidence: 'HIGH', retrievedAt: new Date(), ...over },
    { country: 'PK', city: 'Lahore', cityTrusted: true },
  );
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** Build the snapshot the worker would load for an existing company. */
function existing(id: string, over: Partial<CompanyCandidate>): ExistingCompanySnapshot {
  const n = candidate(over);
  return {
    id,
    displayName: n.displayName,
    nameKey: n.nameKey,
    coreName: n.coreName,
    nameTokens: n.nameTokens,
    coreTokens: n.coreTokens,
    cityKeys: n.cityKey ? [n.cityKey] : [],
    addresses: n.address?.tokens.length ? [n.address.tokens] : [],
    domains: n.website ? [n.website.domain] : [],
    phones: n.phones,
    registrationNumbers: n.identities
      .filter((i) => i.type === 'REGISTRATION_NUMBER')
      .map(({ scope, value }) => ({ scope, value })),
    providerIds: n.identities
      .filter((i) => i.type === 'PROVIDER_ID')
      .map(({ scope, value }) => ({ scope, value })),
  };
}

describe('deterministic matches', () => {
  it('matches on provider external id', () => {
    const decision = dedupe.decide(candidate({ name: 'Anything', externalId: 'node/1' }), [
      existing('a', { name: 'Totally Different', externalId: 'node/1' }),
    ]);
    expect(decision).toMatchObject({ type: 'MATCH', companyId: 'a' });
  });

  it('matches on registration number even when names differ', () => {
    const decision = dedupe.decide(
      candidate({ name: 'New Name', registrationNumbers: [{ scheme: 'NTN', value: '1234567' }] }),
      [
        existing('a', {
          name: 'Old Name',
          registrationNumbers: [{ scheme: 'NTN', value: '1234567' }],
        }),
      ],
    );
    expect(decision).toMatchObject({ type: 'MATCH', companyId: 'a' });
  });

  it('treats different registration numbers as distinct companies', () => {
    const decision = dedupe.decide(
      candidate({ name: 'Acme', registrationNumbers: [{ scheme: 'NTN', value: '1111111' }] }),
      [existing('a', { name: 'Acme', registrationNumbers: [{ scheme: 'NTN', value: '2222222' }] })],
    );
    expect(decision.type).toBe('NEW');
  });

  it('matches on domain when names are similar', () => {
    const decision = dedupe.decide(
      candidate({ name: 'Arbisoft', websiteUrl: 'https://arbisoft.com/careers' }),
      [existing('a', { name: 'Arbisoft Pvt Ltd', websiteUrl: 'https://www.arbisoft.com' })],
    );
    expect(decision).toMatchObject({ type: 'MATCH', companyId: 'a' });
  });

  it('sends same-domain/different-name to review, never auto-merge', () => {
    const decision = dedupe.decide(
      candidate({ name: 'Zeta Holdings', websiteUrl: 'https://shared.pk' }),
      [existing('a', { name: 'Quantum Labs', websiteUrl: 'https://shared.pk' })],
    );
    expect(decision.type).toBe('REVIEW');
  });
});

describe('name + city + corroboration', () => {
  it('auto-matches exact name+city with similar address', () => {
    const decision = dedupe.decide(
      candidate({ name: 'Netsol', address: { line: '12 Main Boulevard, Gulberg III' } }),
      [existing('a', { name: 'Netsol Pvt Ltd', address: { line: '12 Main Blvd, Gulberg III' } })],
    );
    expect(decision).toMatchObject({ type: 'MATCH', companyId: 'a' });
  });

  it('does not auto-match exact name+city when the address clearly differs', () => {
    const decision = dedupe.decide(
      candidate({ name: 'Netsol', address: { line: '12 Main Boulevard, Gulberg III' } }),
      [existing('a', { name: 'Netsol', address: { line: '77 Canal Road, Johar Town' } })],
    );
    expect(decision.type).toBe('REVIEW');
  });

  it('auto-matches exact name+city with the same phone', () => {
    const decision = dedupe.decide(candidate({ name: 'Netsol', phones: ['042 111 000 123'] }), [
      existing('a', { name: 'Netsol Ltd', phones: ['+92 42 111000123'] }),
    ]);
    expect(decision).toMatchObject({ type: 'MATCH', companyId: 'a' });
  });

  it('asks for review on exact name+city without corroboration', () => {
    const decision = dedupe.decide(candidate({ name: 'Netsol' }), [
      existing('a', { name: 'Netsol' }),
    ]);
    expect(decision.type).toBe('REVIEW');
  });

  it('does not match same name in a different city', () => {
    const decision = dedupe.decide(candidate({ name: 'Netsol', address: { city: 'Karachi' } }), [
      existing('a', { name: 'Netsol' }),
    ]);
    expect(decision.type).toBe('NEW');
  });

  it('downgrades an otherwise certain match when websites conflict', () => {
    const decision = dedupe.decide(
      candidate({
        name: 'Netsol',
        phones: ['042 111 000 123'],
        websiteUrl: 'https://netsol-a.com',
      }),
      [
        existing('a', {
          name: 'Netsol',
          phones: ['042 111 000 123'],
          websiteUrl: 'https://netsol-b.com',
        }),
      ],
    );
    expect(decision.type).toBe('REVIEW');
    if (decision.type === 'REVIEW') {
      expect(decision.alternatives[0]!.reasons).toContain('different website domains');
    }
  });
});

describe('fuzzy matching', () => {
  it('sends very similar names to review', () => {
    const decision = dedupe.decide(candidate({ name: 'Techlogix' }), [
      existing('a', { name: 'Techlogics' }),
    ]);
    expect(decision.type).toBe('REVIEW');
  });

  it('does not flag names that only share a leading word (regression found in a live run)', () => {
    // Jaro-Winkler alone scores these ~0.92 because of the shared "Fixture".
    for (const [a, b] of [
      ['Fixture Zeta', 'Fixture Delta'],
      ['Fixture Alpha Labs', 'Fixture Beta Labs'],
      ['Apex Tower', 'Apex Gate'],
    ] as const) {
      expect(
        dedupe.decide(candidate({ name: a }), [existing('x', { name: b })]).type,
        `${a} vs ${b}`,
      ).toBe('NEW');
    }
  });

  it('still flags genuinely similar names, including subset names', () => {
    expect(
      dedupe.decide(candidate({ name: 'Techlogix' }), [existing('a', { name: 'Techlogics' })]).type,
    ).toBe('REVIEW');
    expect(
      dedupe.decide(candidate({ name: 'Folio3' }), [existing('a', { name: 'Folio3 Labs' })]).type,
    ).toBe('REVIEW');
  });

  it('keeps unrelated companies separate', () => {
    const decision = dedupe.decide(candidate({ name: 'Arbisoft' }), [
      existing('a', { name: 'Systems Limited' }),
      existing('b', { name: 'Folio3' }),
    ]);
    expect(decision.type).toBe('NEW');
  });

  it('never silently picks between several certain matches', () => {
    const decision = dedupe.decide(candidate({ name: 'Acme', externalId: 'node/9' }), [
      existing('a', { name: 'Acme', externalId: 'node/9' }),
      existing('b', { name: 'Acme Two', externalId: 'node/9' }),
    ]);
    expect(decision.type).toBe('REVIEW');
  });

  it('scores identical strings 1 and unrelated strings low', () => {
    expect(jaroWinkler('arbisoft', 'arbisoft')).toBe(1);
    expect(jaroWinkler('arbisoft', 'zzzzzzzz')).toBeLessThan(0.5);
  });
});

describe('sparse candidates are still decided', () => {
  it('handles a candidate with only a name', () => {
    expect(dedupe.decide(candidate({ name: 'Lonely Company' }), []).type).toBe('NEW');
  });
});
