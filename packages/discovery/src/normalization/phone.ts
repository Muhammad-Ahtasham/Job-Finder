import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/**
 * Normalize free-form phone strings (possibly ";"-separated lists) to E.164. Numbers that
 * are not even *possible* are dropped; no claim of validity/reachability is made.
 */
export function normalizePhones(inputs: string[] | undefined, country: string): string[] {
  if (!inputs?.length) return [];
  const result = new Set<string>();
  for (const input of inputs) {
    for (const part of input.split(/[;,/]|\bor\b/i)) {
      const raw = part.trim();
      if (raw.length < 6) continue;
      const parsed = parsePhoneNumberFromString(raw, country as CountryCode);
      if (parsed?.isPossible()) result.add(parsed.number);
    }
  }
  return [...result];
}
