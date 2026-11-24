import type {
  CompanyCandidate,
  CompanyNormalizationService,
  IdentityKey,
  NormalizationContext,
  NormalizationResult,
} from '../types';
import { normalizeAddress } from './address';
import { normalizePhones } from './phone';
import { foldText, removeGenericWords, stripLegalSuffixes, tokenize, unique } from './text';
import { isAggregatorDomain, normalizeWebsite } from './website';

const MAX_NAME_LENGTH = 200;

export class DefaultCompanyNormalizationService implements CompanyNormalizationService {
  normalize(candidate: CompanyCandidate, context: NormalizationContext): NormalizationResult {
    const displayName = candidate.name.replace(/\s+/g, ' ').trim();
    if (!displayName) return { ok: false, reason: 'EMPTY_NAME' };
    if (displayName.length > MAX_NAME_LENGTH) return { ok: false, reason: 'INVALID_NAME' };

    const countryCode = (candidate.address?.country ?? context.country).toUpperCase();
    const cityRaw =
      candidate.address?.city?.trim() ||
      (context.cityTrusted ? context.city?.trim() : undefined) ||
      undefined;
    const cityKey = cityRaw ? foldText(cityRaw) || undefined : undefined;

    // Words that describe *where* the company is say nothing about *who* it is.
    const placeStopwords = new Set<string>([
      ...tokenize(cityKey ?? ''),
      ...tokenize(foldText(context.city ?? '')),
      ...tokenize(foldText(countryNameOf(countryCode))),
    ]);

    const folded = foldText(displayName);
    const allTokens = tokenize(folded);
    if (allTokens.length === 0) return { ok: false, reason: 'INVALID_NAME' };

    const nameTokens = stripLegalSuffixes(allTokens);
    const nameKey = nameTokens.join(' ');
    const coreTokens = removeGenericWords(nameTokens, placeStopwords);
    // If everything was generic ("Tech Solutions"), fall back to the full name.
    const effectiveCore = coreTokens.length > 0 ? coreTokens : nameTokens;

    const website = normalizeWebsite(candidate.websiteUrl);
    const usableWebsite = website && !isAggregatorDomain(website.domain) ? website : undefined;

    const identities: IdentityKey[] = [];
    if (usableWebsite) {
      identities.push({ type: 'DOMAIN', scope: '', value: usableWebsite.domain });
    }
    if (candidate.externalId) {
      identities.push({
        type: 'PROVIDER_ID',
        scope: candidate.providerId,
        value: candidate.externalId,
      });
    }
    for (const registration of candidate.registrationNumbers ?? []) {
      const value = registration.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const scheme = registration.scheme.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (value.length >= 4 && scheme) {
        identities.push({ type: 'REGISTRATION_NUMBER', scope: scheme, value });
      }
    }

    const sourceKey = candidate.externalId
      ? `ext:${candidate.externalId}`
      : usableWebsite
        ? `web:${usableWebsite.domain}`
        : `name:${nameKey}|${cityKey ?? ''}`;

    return {
      ok: true,
      value: {
        candidate,
        displayName,
        nameKey,
        coreName: effectiveCore.join(' '),
        nameTokens: unique(nameTokens),
        coreTokens: unique(effectiveCore),
        countryCode,
        city: cityRaw,
        cityKey,
        website: usableWebsite,
        phones: normalizePhones(candidate.phones, countryCode),
        address: normalizeAddress(candidate.address, placeStopwords),
        identities: dedupeIdentities(identities),
        sourceKey,
      },
    };
  }
}

function dedupeIdentities(identities: IdentityKey[]): IdentityKey[] {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = `${identity.type}|${identity.scope}|${identity.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function countryNameOf(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** ICU names unassigned codes "Unknown Region" (e.g. ZZ) instead of failing. */
const UNKNOWN_REGION = countryNameOf('ZZ');

export function isValidCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  const name = countryNameOf(code);
  return name !== code && name !== UNKNOWN_REGION;
}
