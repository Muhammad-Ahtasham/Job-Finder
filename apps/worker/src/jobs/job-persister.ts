import type { JobSource, PrismaClient } from '@jobfinder/database';
import { jobFingerprint, type JobFetchResult, type NormalizedJob } from '@jobfinder/jobs';

export interface CheckSummary {
  checkId: string;
  outcome: JobFetchResult['outcome'];
  jobsFound: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsClosed: number;
  duplicatesSkipped: number;
  retryable: boolean;
  errorCode?: string;
}

/** Providers whose lists are complete and official. A job they carry supersedes a scraped copy. */
const isScraped = (providerId: string) => providerId === 'generic-html';

/**
 * Writes one source check: the JobCheck row, the jobs it saw, closures, and the source's
 * health — atomically. Key rules:
 *  - jobs are unique per (source, externalId), so re-running a check never duplicates;
 *  - a job already carried by an official ATS source is not re-imported from a scraped page
 *    (same title + place), and an ATS job closes a previously scraped twin;
 *  - jobs are closed ONLY by an authoritative, successful answer. A failed or inconclusive
 *    check, or a partial page, changes no job's status.
 */
export async function persistCheck(
  prisma: PrismaClient,
  source: JobSource,
  runId: string,
  result: JobFetchResult,
  startedAt: Date,
): Promise<CheckSummary> {
  const now = new Date();
  const jobs: NormalizedJob[] =
    result.outcome === 'JOBS' || result.outcome === 'FAILED' ? result.jobs : [];
  const authoritative =
    (result.outcome === 'JOBS' || result.outcome === 'NO_OPENINGS') && result.authoritative;

  return prisma.$transaction(async (tx) => {
    const check = await tx.jobCheck.create({
      data: {
        workspaceId: source.workspaceId,
        companyId: source.companyId,
        sourceId: source.id,
        runId,
        outcome: result.outcome,
        authoritative,
        pagesFetched: result.pagesFetched,
        errorCode: result.outcome === 'FAILED' ? result.error.code : null,
        errorMessage: result.outcome === 'FAILED' ? result.error.message.slice(0, 500) : null,
        retryable: result.outcome === 'FAILED' ? result.error.retryable : null,
        httpStatus: result.outcome === 'FAILED' ? (result.error.httpStatus ?? null) : null,
        evidence:
          result.outcome === 'NO_OPENINGS'
            ? result.evidence
            : result.outcome === 'INCONCLUSIVE'
              ? result.reason
              : null,
        startedAt,
      },
    });

    let created = 0;
    let updated = 0;
    let duplicates = 0;

    if (jobs.length > 0) {
      const existing = await tx.job.findMany({ where: { sourceId: source.id } });
      const byExternal = new Map(existing.map((j) => [j.externalId, j]));
      // Same vacancy already provided by another source of this company?
      const otherOpen = await tx.job.findMany({
        where: { companyId: source.companyId, status: 'OPEN', sourceId: { not: source.id } },
        select: {
          id: true,
          fingerprint: true,
          sourceId: true,
          source: { select: { providerId: true } },
        },
      });

      for (const job of jobs) {
        const fingerprint = jobFingerprint(job.title, job.location);
        const data = {
          fingerprint,
          title: job.title,
          description: job.description,
          location: job.location,
          locations: job.locations,
          department: job.department,
          employmentType: job.employmentType,
          workplaceType: job.workplaceType,
          applicationUrl: job.applicationUrl,
          sourceUrl: job.sourceUrl,
          publishedAt: job.publishedAt,
          extraction: job.extraction,
        };
        const prior = byExternal.get(job.externalId);
        const twins = otherOpen.filter((o) => o.fingerprint === fingerprint);
        const officialTwin =
          isScraped(source.providerId) && twins.some((t) => !isScraped(t.source.providerId));
        if (prior && officialTwin) {
          // An official source carries this vacancy: a scraped copy must not be (re)opened.
          if (prior.status === 'OPEN') {
            await tx.job.update({
              where: { id: prior.id },
              data: { status: 'CLOSED', closedAt: now },
            });
            duplicates += 1;
          }
          continue;
        }
        if (prior) {
          const changed =
            prior.title !== data.title ||
            prior.description !== data.description ||
            prior.location !== data.location ||
            prior.applicationUrl !== data.applicationUrl ||
            prior.employmentType !== data.employmentType ||
            prior.workplaceType !== data.workplaceType ||
            prior.status !== 'OPEN';
          await tx.job.update({
            where: { id: prior.id },
            data: {
              ...data,
              status: 'OPEN',
              closedAt: null,
              lastSeenAt: now,
              lastCheckId: check.id,
            },
          });
          if (changed) updated += 1;
          continue;
        }

        if (officialTwin) {
          duplicates += 1; // an official source already has it
          continue;
        }
        await tx.job.create({
          data: {
            workspaceId: source.workspaceId,
            companyId: source.companyId,
            sourceId: source.id,
            externalId: job.externalId,
            firstSeenAt: now,
            lastSeenAt: now,
            lastCheckId: check.id,
            ...data,
          },
        });
        created += 1;
        if (!isScraped(source.providerId)) {
          // The official copy supersedes any scraped twin.
          const scrapedTwins = twins.filter((t) => isScraped(t.source.providerId)).map((t) => t.id);
          if (scrapedTwins.length > 0) {
            await tx.job.updateMany({
              where: { id: { in: scrapedTwins } },
              data: { status: 'CLOSED', closedAt: now },
            });
            duplicates += scrapedTwins.length;
          }
        }
      }
    }

    let closed = 0;
    if (authoritative) {
      const keep = jobs.map((j) => j.externalId);
      const gone = await tx.job.updateMany({
        where: { sourceId: source.id, status: 'OPEN', externalId: { notIn: keep } },
        data: { status: 'CLOSED', closedAt: now },
      });
      closed = gone.count;
    }

    const answered = result.outcome === 'JOBS' || result.outcome === 'NO_OPENINGS';
    await tx.jobSource.update({
      where: { id: source.id },
      data: {
        lastCheckedAt: now,
        lastOutcome: result.outcome,
        ...(answered ? { lastSuccessAt: now, consecutiveFailures: 0 } : {}),
        ...(result.outcome === 'FAILED' ? { consecutiveFailures: { increment: 1 } } : {}),
      },
    });
    await tx.jobCheck.update({
      where: { id: check.id },
      data: {
        jobsFound: jobs.length,
        jobsCreated: created,
        jobsUpdated: updated,
        jobsClosed: closed,
        duplicatesSkipped: duplicates,
        finishedAt: now,
      },
    });
    if (authoritative) {
      await tx.company.updateMany({
        where: { id: source.companyId, careersStatus: { not: 'VERIFIED' } },
        data: { careersStatus: 'VERIFIED' },
      });
    }

    return {
      checkId: check.id,
      outcome: result.outcome,
      jobsFound: jobs.length,
      jobsCreated: created,
      jobsUpdated: updated,
      jobsClosed: closed,
      duplicatesSkipped: duplicates,
      retryable: result.outcome === 'FAILED' && result.error.retryable,
      errorCode: result.outcome === 'FAILED' ? result.error.code : undefined,
    };
  });
}
