import type { CandidateAddress } from '../types';
import { foldText, tokenize } from './text';

const ABBREVIATIONS: Record<string, string> = {
  street: 'st',
  road: 'rd',
  avenue: 'ave',
  boulevard: 'blvd',
  block: 'blk',
  phase: 'ph',
  floor: 'fl',
  plaza: 'plz',
  building: 'bldg',
  opposite: 'opp',
  sector: 'sec',
  commercial: 'comm',
  market: 'mkt',
  colony: 'col',
  society: 'soc',
  town: 'twn',
};

const NOISE = new Set(['near', 'the', 'and', 'in', 'at', 'of', 'office', 'no', 'number']);

export interface NormalizedAddress {
  raw: string;
  tokens: string[];
}

/**
 * Tokenized, abbreviation-normalized address. City/country tokens are removed so that the
 * comparison focuses on the part that distinguishes one location from another.
 */
export function normalizeAddress(
  address: CandidateAddress | undefined,
  stopwords: Set<string>,
): NormalizedAddress | undefined {
  if (!address) return undefined;
  const raw = [address.line, address.region, address.postalCode]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(', ');
  if (!raw) return undefined;

  const tokens = tokenize(foldText(raw))
    .map((token) => ABBREVIATIONS[token] ?? token)
    .filter((token) => !NOISE.has(token) && !stopwords.has(token));
  // A single token ("lahore") cannot distinguish locations; keep the raw text but no tokens.
  return { raw, tokens: tokens.length >= 2 ? tokens : [] };
}
