import { cleanLocation, cleanTitle, inferWorkplaceFromLocation, sha1 } from './normalize';
import type { BoardRef, NormalizedJob } from './types';

/** AI-proposed (already grounded) jobs → NormalizedJob. Only fields the page itself gave. */
export function groundJobsToNormalized(
  proposed: { title: string; url?: string; location?: string }[],
  board: BoardRef,
): NormalizedJob[] {
  const seen = new Set<string>();
  const out: NormalizedJob[] = [];
  for (const p of proposed) {
    const title = cleanTitle(p.title);
    if (!title) continue;
    const url = p.url ?? board.boardUrl;
    const externalId = sha1(p.url ?? `${board.boardUrl}#${title}`);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const location = cleanLocation(p.location);
    out.push({
      providerId: board.providerId,
      boardKey: board.boardKey,
      externalId,
      title,
      description: null,
      location,
      locations: location ? [location] : [],
      department: null,
      employmentType: 'UNKNOWN',
      workplaceType: inferWorkplaceFromLocation(location),
      applicationUrl: p.url ?? null,
      sourceUrl: url,
      publishedAt: null,
      extraction: 'AI',
    });
  }
  return out;
}
