import { parse } from 'tldts';
import { foldText, removeGenericWords, stripLegalSuffixes, tokenize } from '@jobfinder/discovery';
import type { ParsedPage } from './html';
import type { Evidence, VerificationStatus, WebsiteDecision } from './types';

/** Tokens that identify the company: legal suffixes and generic industry words removed. */
export function coreNameTokens(companyName: string): string[] {
  const tokens = stripLegalSuffixes(tokenize(foldText(companyName)));
  const core = removeGenericWords(tokens, new Set());
  return core.length > 0 ? core : tokens;
}

const paddedFold = (text: string) => ` ${foldText(text)} `;

/** True when (nearly) all identifying tokens occur as whole words in `text`. */
export function containsName(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const folded = paddedFold(text);
  const hits = tokens.filter((t) => folded.includes(` ${t} `)).length;
  return tokens.length <= 3 ? hits === tokens.length : hits / tokens.length >= 0.75;
}

function countOccurrences(text: string, phrase: string): number {
  if (!phrase) return 0;
  return paddedFold(text).split(` ${phrase} `).length - 1;
}

const PARKED =
  /\b(domain (name )?(is )?(for sale|available)|buy this domain|this domain (is|may be) for sale|parked (free|domain)|account suspended|default web ?site page|coming soon|under construction|index of \/|apache2? (ubuntu )?default page|welcome to nginx|website expired|related searches)\b/i;

export interface WebsiteScoreInput {
  companyName: string;
  city?: string | null;
  /** Domain the candidate URL named. */
  requestedDomain: string;
  /** URL the homepage finally resolved to. */
  finalUrl: string;
  page: ParsedPage;
}

export interface WebsiteScore {
  decision: WebsiteDecision;
  confidence: number;
  status: VerificationStatus;
  evidence: Evidence[];
  domain: string;
}

export const OFFICIAL_THRESHOLD = 0.65;
export const REJECT_BELOW = 0.35;

/**
 * Deterministic website verification: a weighted sum of observed facts, each recorded as
 * Evidence. A domain that merely resembles the name is never enough on its own — OFFICIAL
 * additionally requires the company's name to appear on the page itself (title, site name,
 * heading or JSON-LD). Pages too thin to read (script-rendered shells) are never auto-rejected.
 */
export function scoreWebsite(input: WebsiteScoreInput): WebsiteScore {
  const { page, finalUrl } = input;
  const tokens = coreNameTokens(input.companyName);
  const evidence: Evidence[] = [];
  const add = (signal: string, detail: string, weight: number) =>
    evidence.push({ signal, detail, weight: Number(weight.toFixed(2)), url: finalUrl });

  const final = parse(new URL(finalUrl).hostname, { allowPrivateDomains: true });
  const domain = (final.domain ?? new URL(finalUrl).hostname).toLowerCase();
  if (domain !== input.requestedDomain) {
    add('REDIRECTED_DOMAIN', `Candidate ${input.requestedDomain} redirects to ${domain}`, -0.05);
  }

  // ---- domain vs name
  const label = (final.domainWithoutSuffix ?? '').replace(/-/g, '');
  const joined = tokens.join('');
  if (label && joined) {
    if (label === joined || label === foldText(input.companyName).replace(/ /g, '')) {
      add('DOMAIN_NAME_MATCH', `Domain "${label}" equals the company name`, 0.35);
    } else if (
      (joined.length >= 4 && label.includes(joined)) ||
      (label.length >= 4 && joined.includes(label)) ||
      tokens.every((t) => label.includes(t))
    ) {
      add('DOMAIN_NAME_PARTIAL', `Domain "${label}" contains the company name`, 0.25);
    }
  }

  // ---- the company's name on the page itself
  const nameSources: [string, string, number][] = [
    ['TITLE', page.title, 0.35],
    ['SITE_NAME', page.siteName, 0.35],
    ['JSON_LD_NAME', page.jsonLd.names.join(' | '), 0.35],
    ['HEADING', page.h1.join(' | '), 0.25],
    ['META_DESCRIPTION', page.metaDescription, 0.15],
  ];
  const matched = nameSources.filter(([, text]) => text && containsName(text, tokens));
  let onPageName = 0;
  if (matched.length > 0) {
    onPageName = Math.min(
      0.45,
      Math.max(...matched.map(([, , w]) => w)) + 0.05 * (matched.length - 1),
    );
    add(
      'NAME_ON_PAGE',
      `Company name found in ${matched.map(([s]) => s.toLowerCase()).join(', ')}`,
      onPageName,
    );
  }
  const phrase = tokens.join(' ');
  if (countOccurrences(page.text, phrase) >= 2) {
    add('NAME_IN_BODY', 'Company name appears repeatedly in the page text', 0.1);
  }

  // ---- location
  const city = input.city ? foldText(input.city) : '';
  if (city) {
    const haystack = `${page.text} ${page.jsonLd.addresses.join(' ')}`;
    if (paddedFold(haystack).includes(` ${city} `)) {
      add('CITY_MENTIONED', `"${input.city}" is mentioned on the page`, 0.15);
    }
  }

  // ---- negatives
  const thin = page.text.length < 250 && page.links.length < 5;
  if (PARKED.test(`${page.title} ${page.text.slice(0, 1500)}`) && page.text.length < 1500) {
    add('PARKED_OR_PLACEHOLDER', 'Page looks like a parked, default or placeholder site', -0.8);
  }
  if (thin) {
    add('THIN_PAGE', 'Very little server-rendered content to verify against (script-rendered?)', 0);
  }
  if (onPageName === 0 && !evidence.some((e) => e.signal.startsWith('DOMAIN_NAME'))) {
    add('NAME_NOT_FOUND', 'Neither the page nor the domain mentions the company name', -0.3);
  }

  const raw = evidence.reduce((sum, e) => sum + e.weight, 0);
  const score = Math.max(0, Math.min(1, Number(raw.toFixed(2))));
  const parked = evidence.some((e) => e.signal === 'PARKED_OR_PLACEHOLDER');

  let decision: WebsiteDecision;
  if (parked) decision = 'REJECTED';
  else if (score >= OFFICIAL_THRESHOLD && onPageName > 0) decision = 'OFFICIAL';
  else if (score < REJECT_BELOW && !thin) decision = 'REJECTED';
  else decision = 'UNCERTAIN';

  return {
    decision,
    confidence: decision === 'REJECTED' ? Number(Math.min(0.99, 1 - score).toFixed(2)) : score,
    status:
      decision === 'OFFICIAL' ? 'VERIFIED' : decision === 'REJECTED' ? 'FAILED' : 'UNVERIFIED',
    evidence,
    domain,
  };
}
