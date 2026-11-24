/** Fold to lowercase ASCII-ish tokens: strips diacritics and punctuation, "&" → "and". */
export function foldText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokenize(folded: string): string[] {
  return folded ? folded.split(' ') : [];
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Trailing corporate-form tokens; removed so "Arbisoft Pvt. Ltd." equals "Arbisoft". */
const LEGAL_SUFFIXES = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'llc',
  'llp',
  'plc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'gmbh',
  'smc',
  'sdn',
  'bhd',
  'pte',
  'co',
]);

/** Generic industry words: they carry little identity ("Folio3 Software" ≈ "Folio3"). */
const GENERIC_WORDS = new Set([
  'software',
  'softwares',
  'technologies',
  'technology',
  'tech',
  'solutions',
  'solution',
  'systems',
  'system',
  'services',
  'service',
  'group',
  'consulting',
  'consultants',
  'infotech',
  'it',
  'ict',
  'digital',
  'global',
  'international',
  'intl',
  'enterprises',
  'enterprise',
  'associates',
  'house',
  'development',
  'developers',
  'and',
  'the',
  'of',
]);

export function stripLegalSuffixes(tokens: string[]): string[] {
  const result = [...tokens];
  while (result.length > 1 && LEGAL_SUFFIXES.has(result[result.length - 1]!)) result.pop();
  // "(SMC-Private) Limited" style: drop a trailing "smc private" remnant too.
  return result;
}

export function removeGenericWords(tokens: string[], extraStopwords: Set<string>): string[] {
  return tokens.filter((token) => !GENERIC_WORDS.has(token) && !extraStopwords.has(token));
}
