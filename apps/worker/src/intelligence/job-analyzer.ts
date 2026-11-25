import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@jobfinder/database';
import { analyzeJob, jobContentHash, type JobAi, type JobAnalysis } from '@jobfinder/intelligence';
import { PRISMA } from '../infrastructure.module';
import { JOB_AI } from './intelligence.tokens';

const INT_MAX = 2_000_000_000;

/**
 * Turns raw postings into structured jobs: normalized title, seniority, role category, skills,
 * requirements and (only when published) salary. Pending = `analysisHash IS NULL`; the persister
 * clears it whenever a posting's content changes, so analysis is always redone for new content
 * and never for unchanged content.
 */
@Injectable()
export class JobAnalyzer {
  private readonly logger = new Logger(JobAnalyzer.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Optional() @Inject(JOB_AI) private readonly ai?: JobAi | null,
  ) {}

  /** Analyse up to `limit` pending jobs. Returns the companies/workspaces whose jobs changed. */
  async analyzePending(limit: number): Promise<{ analyzed: number; workspaceIds: string[] }> {
    const pending = await this.prisma.job.findMany({
      where: { analysisHash: null, status: { in: ['OPEN', 'UNKNOWN'] } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, workspaceId: true },
    });
    const workspaces = new Set<string>();
    let analyzed = 0;
    for (const { id, workspaceId } of pending) {
      try {
        if (await this.analyze(id)) {
          analyzed += 1;
          workspaces.add(workspaceId);
        }
      } catch (error) {
        this.logger.error(`Analysis of job ${id} failed: ${(error as Error).message}`);
      }
    }
    return { analyzed, workspaceIds: [...workspaces] };
  }

  /** Analyse one job. False when the job vanished or changed while it was being analysed. */
  async analyze(jobId: string): Promise<boolean> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return false;
    const content = {
      title: job.title,
      description: job.description,
      location: job.location,
      locations: job.locations,
      department: job.department,
      employmentType: job.employmentType,
      workplaceType: job.workplaceType,
    };
    const analysis = await analyzeJob(content, { ai: this.ai });
    return this.save(jobId, analysis);
  }

  private async save(jobId: string, a: JobAnalysis): Promise<boolean> {
    const salary =
      a.salary && (a.salary.min ?? 0) <= INT_MAX && (a.salary.max ?? 0) <= INT_MAX
        ? a.salary
        : null;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.job.findUnique({ where: { id: jobId } });
      // The posting changed while we were analysing: leave it pending and do it again.
      if (!current || jobContentHash(current as never) !== a.contentHash) return false;

      await tx.job.update({
        where: { id: jobId },
        data: {
          contentHash: a.contentHash,
          analysisHash: a.contentHash,
          analyzedAt: new Date(),
          normalizedTitle: a.normalizedTitle,
          seniority: a.seniority,
          roleCategory: a.roleCategory,
          salaryMin: salary?.min ?? null,
          salaryMax: salary?.max ?? null,
          salaryCurrency: salary?.currency ?? null,
          salaryPeriod: salary?.period ?? null,
          salaryText: salary?.text ?? null,
          minYearsExperience: a.minYears,
          maxYearsExperience: a.maxYears,
          analysisProvider: a.meta.provider,
          analysisModel: a.meta.model,
          analysisPromptVersion: a.meta.promptVersion,
          analysisConfidence: a.confidence,
        },
      });
      await tx.jobSkill.deleteMany({ where: { jobId } });
      await tx.jobRequirement.deleteMany({ where: { jobId } });
      await tx.jobSkill.createMany({
        data: a.skills.map((s) => ({
          jobId,
          skillKey: s.key,
          name: s.name,
          kind: s.kind,
          evidence: s.evidence,
          source: s.source,
        })),
        skipDuplicates: true,
      });
      await tx.jobRequirement.createMany({
        data: a.requirements.map((r) => ({
          jobId,
          kind: r.kind,
          text: r.text,
          mandatory: r.mandatory,
          minYears: r.minYears,
          maxYears: r.maxYears,
          level: r.level,
          source: r.source,
        })),
      });
      await tx.jobObservation.create({
        data: {
          workspaceId: current.workspaceId,
          jobId,
          kind: 'ANALYZED',
          contentHash: a.contentHash,
          reason: a.notes.length > 0 ? a.notes.join('; ').slice(0, 500) : null,
          changes: {
            seniority: a.seniority,
            roleCategory: a.roleCategory,
            skills: a.skills.length,
            requirements: a.requirements.length,
            provider: a.meta.provider,
            model: a.meta.model,
          } as Prisma.InputJsonValue,
        },
      });
      return true;
    });
  }
}
