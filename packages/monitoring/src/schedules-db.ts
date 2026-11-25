import type { Prisma, PrismaClient } from '@jobfinder/database';
import {
  defaultIntervalMinutes,
  kindForProvider,
  nextRunAfterAnswer,
  scopeKey,
  type IntervalDefaults,
} from './schedule';

/** Works inside or outside a transaction. */
export type ScheduleDb =
  Pick<PrismaClient, 'monitoringSchedule' | 'jobSource'> | Prisma.TransactionClient;

export interface EnsureOptions {
  intervals: IntervalDefaults;
  now?: Date;
  random?: () => number;
  /** Force the enabled flag of the schedules that get created (default: follow the company). */
  enabled?: boolean;
}

/**
 * Makes sure every active job source (and the website, if there is one) of a company has a
 * schedule. Existing schedules are never touched, so a person's interval or pause survives.
 *
 * New schedules follow the company: if all of its schedules are paused, the company is paused
 * and a source discovered later starts paused too.
 */
export async function ensureCompanySchedules(
  db: ScheduleDb,
  company: { id: string; workspaceId: string; website: string | null },
  options: EnsureOptions,
): Promise<{ created: number }> {
  const now = options.now ?? new Date();
  const [sources, existing] = await Promise.all([
    db.jobSource.findMany({
      where: { companyId: company.id, status: 'ACTIVE' },
      select: { id: true, providerId: true },
    }),
    db.monitoringSchedule.findMany({
      where: { companyId: company.id },
      select: { scopeKey: true, enabled: true },
    }),
  ]);
  const have = new Set(existing.map((s) => s.scopeKey));
  const paused = existing.length > 0 && existing.every((s) => !s.enabled);
  const enabled = options.enabled ?? !paused;

  const wanted: Prisma.MonitoringScheduleCreateManyInput[] = [];
  const add = (
    kind: 'ATS_BOARD' | 'CAREER_PAGE' | 'WEBSITE',
    id: string,
    jobSourceId: string | null,
  ) => {
    const key = scopeKey(kind, id);
    if (have.has(key)) return;
    const intervalMinutes = defaultIntervalMinutes(kind, options.intervals);
    wanted.push({
      workspaceId: company.workspaceId,
      companyId: company.id,
      jobSourceId,
      kind,
      scopeKey: key,
      enabled,
      intervalMinutes,
      // The first scheduled check is one interval away (the discovery run just did the baseline).
      nextRunAt: nextRunAfterAnswer(now, intervalMinutes, options.random),
    });
  };
  for (const source of sources) add(kindForProvider(source.providerId), source.id, source.id);
  if (company.website) add('WEBSITE', company.id, null);

  if (wanted.length === 0) return { created: 0 };
  const result = await db.monitoringSchedule.createMany({ data: wanted, skipDuplicates: true });
  return { created: result.count };
}

/** Turns monitoring of one company on or off (creating missing schedules when turning it on). */
export async function setCompanyMonitoring(
  db: ScheduleDb,
  company: { id: string; workspaceId: string; website: string | null },
  enabled: boolean,
  options: EnsureOptions,
): Promise<void> {
  if (enabled) await ensureCompanySchedules(db, company, { ...options, enabled: true });
  await db.monitoringSchedule.updateMany({
    where: { companyId: company.id, workspaceId: company.workspaceId },
    data: { enabled, ...(enabled ? {} : { lockedUntil: null }) },
  });
}
