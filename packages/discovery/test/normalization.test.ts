import { describe, expect, it } from 'vitest';
import {
  DefaultCompanyNormalizationService,
  isValidCountryCode,
  normalizeWebsite,
  type CompanyCandidate,
} from '../src';

const service = new DefaultCompanyNormalizationService();
const base = (over: Partial<CompanyCandidate>): CompanyCandidate => ({
  providerId: 'test',
  name: 'X',
  nameConfidence: 'HIGH',
  retrievedAt: new Date(),
  ...over,
});
const ctx = { country: 'PK', city: 'Lahore', cityTrusted: true };

function norm(over: Partial<CompanyCandidate>) {
  const result = service.normalize(base(over), ctx);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result.value;
}

describe('name normalization', () => {
  it('strips legal suffixes, punctuation, case and diacritics', () => {
    expect(norm({ name: 'Arbisoft (Pvt.) Ltd.' }).nameKey).toBe('arbisoft');
    expect(norm({ name: 'ARBISOFT PRIVATE LIMITED' }).nameKey).toBe('arbisoft');
    expect(norm({ name: 'Zoë & Co' }).nameKey).toBe('zoe and');
  });

  it('derives a core name without generic industry words and place names', () => {
    const n = norm({ name: 'Folio3 Software Technologies Lahore' });
    expect(n.coreName).toBe('folio3');
    expect(n.nameKey).toBe('folio3 software technologies lahore');
  });

  it('falls back to the full name when everything is generic', () => {
    expect(norm({ name: 'Tech Solutions' }).coreName).toBe('tech solutions');
  });

  it('assumes the project city only when the provider is city-scoped', () => {
    const untrusted = service.normalize(base({ name: 'Acme' }), { country: 'PK', city: 'Lahore' });
    expect(untrusted.ok && untrusted.value.cityKey).toBeFalsy();
    expect(norm({ name: 'Acme' }).cityKey).toBe('lahore');
    // an explicit city always wins
    expect(norm({ name: 'Acme', address: { city: 'Karachi' } }).cityKey).toBe('karachi');
  });

  it('rejects empty and absurd names but keeps sparse companies', () => {
    expect(service.normalize(base({ name: '   ' }), ctx)).toEqual({
      ok: false,
      reason: 'EMPTY_NAME',
    });
    expect(service.normalize(base({ name: '!!!' }), ctx)).toEqual({
      ok: false,
      reason: 'INVALID_NAME',
    });
    const sparse = norm({ name: 'Bare Minimum Co' });
    expect(sparse.website).toBeUndefined();
    expect(sparse.phones).toEqual([]);
    expect(sparse.address).toBeUndefined();
  });
});

describe('website / domain', () => {
  it('normalizes to the registrable domain and homepage', () => {
    expect(normalizeWebsite('https://www.Arbisoft.com/about?x=1')).toEqual({
      url: 'https://arbisoft.com/',
      host: 'arbisoft.com',
      domain: 'arbisoft.com',
    });
    expect(normalizeWebsite('careers.example.com.pk')?.domain).toBe('example.com.pk');
  });

  it('keeps private-suffix hosts distinct so hosting platforms never merge companies', () => {
    expect(normalizeWebsite('https://acme.github.io')?.domain).toBe('acme.github.io');
    expect(normalizeWebsite('https://other.github.io')?.domain).toBe('other.github.io');
  });

  it('rejects non-sites', () => {
    for (const bad of ['mailto:a@b.com', 'http://127.0.0.1', 'http://localhost', 'not a url', '']) {
      expect(normalizeWebsite(bad)).toBeUndefined();
    }
  });

  it('never turns an aggregator domain into an identity', () => {
    const n = norm({ name: 'Acme', websiteUrl: 'https://www.linkedin.com/company/acme' });
    expect(n.website).toBeUndefined();
    expect(n.identities.find((i) => i.type === 'DOMAIN')).toBeUndefined();
  });
});

describe('identities, phones, addresses', () => {
  it('builds domain, provider and registration identities', () => {
    const n = norm({
      name: 'Acme',
      externalId: 'node/42',
      websiteUrl: 'https://acme.pk',
      registrationNumbers: [{ scheme: 'ntn', value: '1234-567-8' }],
    });
    expect(n.identities).toEqual(
      expect.arrayContaining([
        { type: 'DOMAIN', scope: '', value: 'acme.pk' },
        { type: 'PROVIDER_ID', scope: 'test', value: 'node/42' },
        { type: 'REGISTRATION_NUMBER', scope: 'NTN', value: '12345678' },
      ]),
    );
    expect(n.sourceKey).toBe('ext:node/42');
  });

  it('derives a stable sourceKey without ids', () => {
    expect(norm({ name: 'Acme', websiteUrl: 'https://acme.pk/about' }).sourceKey).toBe(
      'web:acme.pk',
    );
    expect(norm({ name: 'Acme Pvt Ltd' }).sourceKey).toBe('name:acme|lahore');
  });

  it('normalizes Pakistani phone numbers to E.164', () => {
    expect(norm({ name: 'A', phones: ['042 111 000 123'] }).phones).toEqual(['+9242111000123']);
    expect(norm({ name: 'A', phones: ['+92 300 1234567; 0321-7654321'] }).phones).toEqual([
      '+923001234567',
      '+923217654321',
    ]);
    expect(norm({ name: 'A', phones: ['123'] }).phones).toEqual([]);
  });

  it('drops city/country tokens and abbreviates addresses', () => {
    const n = norm({
      name: 'A',
      address: { line: '12 Main Boulevard, Gulberg III, Lahore, Pakistan' },
    });
    expect(n.address?.tokens).toEqual(['12', 'main', 'blvd', 'gulberg', 'iii']);
  });

  it('validates ISO country codes', () => {
    expect(isValidCountryCode('PK')).toBe(true);
    expect(isValidCountryCode('ZZ')).toBe(false);
    expect(isValidCountryCode('pk')).toBe(false);
  });
});
