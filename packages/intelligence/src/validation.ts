/**
 * Deterministic validation of published facts. Nothing here involves AI: a URL or a date is
 * either valid by these rules or it is dropped.
 */

const URL_MAX = 2000;
const URL_IN_TEXT = /(?:https?:\/\/|ftp:\/\/|www\.)\S+/i;

/** The URL exactly as published if it is a plain public http(s) URL, otherwise null. */
export function validateHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || value.length > URL_MAX || /[\u0000-\u001f\u007f\s]/.test(value))
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return null;
  if (!host.includes('.') && !host.includes(':')) return null;
  return value;
}

/** Lowercase host without "www.": a stable domain key for comparing where URLs lead. */
export function normalizeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Does free text (e.g. AI output) contain something that looks like a URL? */
export const containsUrl = (text: string): boolean => URL_IN_TEXT.test(text);

const MIN_YEAR = 2000;
const FUTURE_SLACK_MS = 24 * 3_600_000;

/** A publication date must be a real date, not before 2000 and not in the future (1 day of clock slack). */
export function validatePublishedAt(
  value: Date | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  if (value.getUTCFullYear() < MIN_YEAR) return null;
  if (value.getTime() > now.getTime() + FUTURE_SLACK_MS) return null;
  return value;
}

/** An expiry date must be real, after the publication date (when known) and at most 3 years ahead. */
export function validateExpiresAt(
  value: Date | null | undefined,
  publishedAt: Date | null,
  now: Date = new Date(),
): Date | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  if (value.getUTCFullYear() < MIN_YEAR) return null;
  if (publishedAt && value.getTime() < publishedAt.getTime()) return null;
  if (value.getTime() > now.getTime() + 3 * 365 * 24 * 3_600_000) return null;
  return value;
}
