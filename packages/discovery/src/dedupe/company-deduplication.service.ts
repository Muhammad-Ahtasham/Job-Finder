import type {
  CompanyDeduplicationService,
  DedupeDecision,
  ExistingCompanySnapshot,
  MatchAlternative,
  NormalizedCandidate,
} from '../types';
import { dice, jaccard, jaroWinkler } from './similarity';

type Tier = 'AUTO' | 'REVIEW' | 'NONE';

interface Evaluation extends MatchAlternative {
  tier: Tier;
}

/** Thresholds are deliberately conservative; see docs/adr/0003-company-deduplication.md. */
export const DEDUPE_THRESHOLDS = {
  /** Domain equal but names this dissimilar ⇒ not safe to merge automatically. */
  domainNameMin: 0.6,
  /** Fuzzy name similarity at/above which a human is asked. */
  fuzzyReview: 0.88,
  /** Tokens unique to each name must resemble each other at least this much (see distinctiveTokensAgree). */
  distinctiveTokenMin: 0.85,
  /** Address similarity needed to corroborate an exact name+city match. */
  addressCorroboration: 0.7,
  /** Address similarity that, with a plausible name, triggers a review. */
  addressReview: 0.8,
  addressReviewNameMin: 0.6,
  maxAlternatives: 3,
} as const;

export function nameSimilarity(
  a: Pick<NormalizedCandidate, 'nameKey' | 'coreName' | 'nameTokens' | 'coreTokens'>,
  b: Pick<ExistingCompanySnapshot, 'nameKey' | 'coreName' | 'nameTokens' | 'coreTokens'>,
): number {
  const full = Math.max(jaroWinkler(a.nameKey, b.nameKey), jaccard(a.nameTokens, b.nameTokens));
  const core =
    a.coreTokens.length && b.coreTokens.length
      ? Math.max(jaroWinkler(a.coreName, b.coreName), jaccard(a.coreTokens, b.coreTokens))
      : 0;
  // Core-only agreement ("Folio3 Software" vs "Folio3 Labs") is slightly discounted so an
  // exact full-name match always outranks it.
  return Math.max(full, core * 0.97);
}

export class DefaultCompanyDeduplicationService implements CompanyDeduplicationService {
  decide(candidate: NormalizedCandidate, existing: ExistingCompanySnapshot[]): DedupeDecision {
    const evaluations = existing
      .map((company) => this.evaluate(candidate, company))
      .filter((evaluation) => evaluation.tier !== 'NONE');

    const auto = evaluations.filter((e) => e.tier === 'AUTO');
    if (auto.length === 1) {
      const [match] = auto;
      return {
        type: 'MATCH',
        companyId: match!.companyId,
        score: match!.score,
        reasons: match!.reasons,
      };
    }
    if (auto.length > 1) {
      // The candidate "certainly" matches several different companies: the *existing*
      // data is inconsistent. Never pick one silently.
      return { type: 'REVIEW', alternatives: this.top(auto) };
    }

    const review = evaluations.filter((e) => e.tier === 'REVIEW');
    if (review.length > 0) return { type: 'REVIEW', alternatives: this.top(review) };
    return { type: 'NEW' };
  }

  private top(evaluations: Evaluation[]): MatchAlternative[] {
    return evaluations
      .sort((a, b) => b.score - a.score)
      .slice(0, DEDUPE_THRESHOLDS.maxAlternatives)
      .map(({ companyId, score, reasons }) => ({ companyId, score, reasons }));
  }

  private evaluate(c: NormalizedCandidate, e: ExistingCompanySnapshot): Evaluation {
    const result = (tier: Tier, score: number, reasons: string[]): Evaluation => ({
      companyId: e.id,
      tier,
      score: Math.round(score * 1000) / 1000,
      reasons,
    });

    // ---- Hard negative: two different registration numbers in the same scheme.
    const registrationOverlap = c.identities.some(
      (id) =>
        id.type === 'REGISTRATION_NUMBER' &&
        e.registrationNumbers.some((r) => r.scope === id.scope && r.value === id.value),
    );
    const registrationConflict =
      !registrationOverlap &&
      c.identities.some(
        (id) =>
          id.type === 'REGISTRATION_NUMBER' &&
          e.registrationNumbers.some((r) => r.scope === id.scope && r.value !== id.value),
      );

    // ---- Deterministic keys.
    const providerIdOverlap = c.identities.some(
      (id) =>
        id.type === 'PROVIDER_ID' &&
        e.providerIds.some((p) => p.scope === id.scope && p.value === id.value),
    );
    if (providerIdOverlap) return result('AUTO', 1, ['same provider id']);
    if (registrationOverlap) return result('AUTO', 1, ['same registration number']);
    if (registrationConflict) return result('NONE', 0, ['different registration numbers']);

    const nameSim = nameSimilarity(c, e);
    const candidateDomain = c.website?.domain;
    const domainEqual = Boolean(candidateDomain && e.domains.includes(candidateDomain));
    const domainConflict = Boolean(
      candidateDomain && e.domains.length > 0 && !e.domains.includes(candidateDomain),
    );

    if (domainEqual) {
      return nameSim >= DEDUPE_THRESHOLDS.domainNameMin
        ? result('AUTO', 0.98, ['same website domain', `name similarity ${nameSim.toFixed(2)}`])
        : result('REVIEW', 0.7, [
            'same website domain',
            `names differ (similarity ${nameSim.toFixed(2)})`,
          ]);
    }

    const cityRelation = relation(c.cityKey, e.cityKeys);
    const addressSim = bestAddressSimilarity(c.address?.tokens ?? [], e.addresses);
    const phoneEqual = c.phones.some((p) => e.phones.includes(p));
    const nameExact = c.nameKey.length > 0 && c.nameKey === e.nameKey;
    const conflictNote = domainConflict ? ['different website domains'] : [];

    if (nameExact && cityRelation === 'same') {
      const corroborated = addressSim >= DEDUPE_THRESHOLDS.addressCorroboration || phoneEqual;
      if (corroborated && !domainConflict) {
        return result('AUTO', 0.95, [
          'same name and city',
          phoneEqual ? 'same phone' : `address similarity ${addressSim.toFixed(2)}`,
        ]);
      }
      return result('REVIEW', corroborated ? 0.85 : 0.8, [
        'same name and city',
        corroborated ? 'corroborated' : 'no corroborating address/phone',
        ...conflictNote,
      ]);
    }
    if (nameExact && cityRelation === 'unknown') {
      return result('REVIEW', 0.75, ['same name, city unknown on one side', ...conflictNote]);
    }
    if (nameExact && cityRelation === 'different') {
      return result('NONE', 0, ['same name but different city']);
    }

    if (
      nameSim >= DEDUPE_THRESHOLDS.fuzzyReview &&
      cityRelation !== 'different' &&
      distinctiveTokensAgree(c.coreTokens, e.coreTokens)
    ) {
      return result('REVIEW', nameSim * 0.9, [
        `similar name (${nameSim.toFixed(2)})`,
        cityRelation === 'same' ? 'same city' : 'city unknown',
        ...conflictNote,
      ]);
    }
    if (
      addressSim >= DEDUPE_THRESHOLDS.addressReview &&
      nameSim >= DEDUPE_THRESHOLDS.addressReviewNameMin
    ) {
      return result('REVIEW', 0.6 + 0.3 * nameSim, [
        `similar address (${addressSim.toFixed(2)})`,
        `name similarity ${nameSim.toFixed(2)}`,
        ...conflictNote,
      ]);
    }
    return result('NONE', 0, []);
  }
}

/**
 * Guards fuzzy name matching against a shared leading word: "Fixture Delta" and "Fixture Zeta"
 * score ~0.92 on Jaro-Winkler purely because of "Fixture". The tokens that are NOT shared must
 * themselves resemble each other ("techlogix" ~ "techlogics"); if one name's tokens are a subset
 * of the other's ("folio3" ⊂ "folio3 labs") they agree too.
 */
export function distinctiveTokensAgree(a: string[], b: string[]): boolean {
  const inA = new Set(a);
  const inB = new Set(b);
  const onlyA = a.filter((token) => !inB.has(token));
  const onlyB = b.filter((token) => !inA.has(token));
  if (onlyA.length === 0 || onlyB.length === 0) return true;
  const covered = (xs: string[], ys: string[]) =>
    xs.every((x) => ys.some((y) => jaroWinkler(x, y) >= DEDUPE_THRESHOLDS.distinctiveTokenMin));
  return covered(onlyA, onlyB) && covered(onlyB, onlyA);
}

function relation(
  candidateCity: string | undefined,
  existingCities: string[],
): 'same' | 'different' | 'unknown' {
  if (!candidateCity || existingCities.length === 0) return 'unknown';
  return existingCities.includes(candidateCity) ? 'same' : 'different';
}

function bestAddressSimilarity(candidate: string[], existing: string[][]): number {
  if (candidate.length === 0) return 0;
  return existing.reduce((best, tokens) => Math.max(best, dice(candidate, tokens)), 0);
}
