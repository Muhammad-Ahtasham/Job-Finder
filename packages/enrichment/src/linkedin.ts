/**
 * LinkedIn company URLs are read from the company's OWN website (links, JSON-LD sameAs) and
 * nothing else. linkedin.com is never fetched: its User Agreement prohibits scraping and
 * bots, so a URL here means "the company's site points to this page", not "we checked it".
 */
const RESERVED_SLUGS = new Set(['linkedin', 'share', 'sharing', 'company', 'login', 'signup']);

export function extractLinkedInCompanies(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return undefined;
  const match = /^\/company\/([a-z0-9][a-z0-9._%-]{1,99})(?:\/|$)/i.exec(url.pathname);
  if (!match) return undefined;
  const slug = decodeURIComponent(match[1]!).toLowerCase();
  if (RESERVED_SLUGS.has(slug) || /^\d+$/.test(slug)) return undefined;
  return `https://www.linkedin.com/company/${slug}`;
}

export interface RankedLinkedIn {
  url: string;
  confidence: number;
  /** The single page we are willing to call "the company's LinkedIn". */
  primary: boolean;
}

/**
 * One distinct slug is the company's page. Several (partners, parent company, customers)
 * are ranked: JSON-LD sameAs and slugs that contain the company's name win; only the winner
 * can ever be called primary, and only when it is clearly ahead.
 */
export function rankLinkedIn(
  hits: { url: string; fromJsonLd: boolean }[],
  nameTokens: string[],
): RankedLinkedIn[] {
  const byUrl = new Map<string, { count: number; jsonLd: boolean }>();
  for (const hit of hits) {
    const entry = byUrl.get(hit.url) ?? { count: 0, jsonLd: false };
    entry.count += 1;
    entry.jsonLd ||= hit.fromJsonLd;
    byUrl.set(hit.url, entry);
  }
  const joined = nameTokens.join('');
  const scored = [...byUrl.entries()].map(([url, entry]) => {
    const slug = url.slice(url.lastIndexOf('/') + 1).replace(/[^a-z0-9]/g, '');
    const nameMatch = joined.length >= 3 && (slug.includes(joined) || joined.includes(slug));
    const confidence = Math.min(
      0.95,
      0.5 +
        (entry.jsonLd ? 0.25 : 0) +
        (nameMatch ? 0.15 : 0) +
        Math.min(entry.count - 1, 2) * 0.025,
    );
    return { url, confidence: Number(confidence.toFixed(2)), nameMatch, jsonLd: entry.jsonLd };
  });
  scored.sort((a, b) => b.confidence - a.confidence);
  const [first, second] = scored;
  return scored.map((item) => ({
    url: item.url,
    confidence: item.confidence,
    primary:
      item === first &&
      (scored.length === 1 ||
        ((item.jsonLd || item.nameMatch) && item.confidence - second!.confidence >= 0.1)),
  }));
}
