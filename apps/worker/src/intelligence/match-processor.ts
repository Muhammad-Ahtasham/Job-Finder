import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@jobfinder/database';
import {
  DEFAULT_PREFERENCES,
  evaluateMatch,
  type JobAi,
  type MatchJob,
  type MatchPreferences,
} from '@jobfinder/intelligence';
import { PRISMA } from '../infrastructure.module';
import { JOB_AI } from './intelligence.tokens';

const BATCH = 100;

export interface MatchSummary {
  evaluated: number;
  reused: number;
  failed: number;
}

/**
 * Scores every open, analysed job of a project's companies against the project. Idempotent and
 * repeatable: a match whose input hash is unchanged is left alone (no AI call, no write), and an
 * unchanged AI role similarity is reused when only weights or preferences changed.
 */
@Injectable()
export class MatchProcessor {
  private readonly logger = new Logger(MatchProcessor.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Optional() @Inject(JOB_AI) private readonly ai?: JobAi | null,
  ) {}

  /**
   * Repeats while the project's inputs change under it (a preferences edit during a run), so the
   * last write always reflects the latest preferences.
   */
  async matchProject(projectId: string): Promise<MatchSummary> {
    const total: MatchSummary = { evaluated: 0, reused: 0, failed: 0 };
    for (let pass = 0; pass < 3; pass++) {
      const before = await this.stamp(projectId);
      if (!before) return total;
      const s = await this.pass(projectId);
      total.evaluated += s.evaluated;
      total.reused += s.reused;
      total.failed += s.failed;
      if ((await this.stamp(projectId)) === before) break;
    }
    return total;
  }

  private async stamp(projectId: string): Promise<string | null> {
    const p = await this.prisma.searchProject.findUnique({
      where: { id: projectId },
      select: { updatedAt: true, matchPreference: { select: { version: true } } },
    });
    return p ? `${p.updatedAt.toISOString()}:${p.matchPreference?.version ?? 0}` : null;
  }

  private async pass(projectId: string): Promise<MatchSummary> {
    const summary: MatchSummary = { evaluated: 0, reused: 0, failed: 0 };
    const project = await this.prisma.searchProject.findUnique({
      where: { id: projectId },
      include: { matchPreference: true },
    });
    if (!project) return summary;
    const row = project.matchPreference;
    const preferences: MatchPreferences = row
      ? {
          weights: {
            role: row.roleWeight,
            skills: row.skillsWeight,
            experience: row.experienceWeight,
            location: row.locationWeight,
          },
          yearsExperience: row.yearsExperience,
          seniorities: row.seniorities,
          workplaceTypes: row.workplaceTypes,
          locations: row.locations,
        }
      : DEFAULT_PREFERENCES;

    const inProject = { run: { projectId } };
    let cursor: string | undefined;
    for (;;) {
      const jobs = await this.prisma.job.findMany({
        where: {
          workspaceId: project.workspaceId,
          status: 'OPEN',
          analysisHash: { not: null },
          company: {
            status: 'ACTIVE',
            OR: [
              { results: { some: inProject } },
              { mergedFrom: { some: { results: { some: inProject } } } },
            ],
          },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          skills: true,
          matches: { where: { projectId }, take: 1 },
        },
      });
      if (jobs.length === 0) break;
      cursor = jobs[jobs.length - 1]!.id;

      for (const job of jobs) {
        try {
          const matchJob: MatchJob = {
            title: job.title,
            normalizedTitle: job.normalizedTitle,
            seniority: job.seniority,
            roleCategory: job.roleCategory as MatchJob['roleCategory'],
            skills: job.skills.map((s) => ({ key: s.skillKey, name: s.name, kind: s.kind })),
            minYears: job.minYearsExperience,
            maxYears: job.maxYearsExperience,
            location: job.location,
            locations: job.locations,
            workplaceType: job.workplaceType,
            analysisHash: job.analysisHash!,
          };
          const prior = job.matches[0];
          const ev = await evaluateMatch({
            job: matchJob,
            jobDescription: job.description,
            project: {
              targetRoles: project.targetRoles,
              targetSkills: project.targetSkills,
              country: project.country,
              city: project.city,
            },
            preferences,
            analysisConfidence: job.analysisConfidence ?? 0.5,
            ai: this.ai,
            previous: prior
              ? {
                  inputHash: prior.inputHash,
                  semanticHash: prior.semanticHash,
                  semanticScore: prior.semanticScore,
                }
              : null,
          });
          if (ev.reused) {
            summary.reused += 1;
            continue;
          }
          const r = ev.result;
          const data = {
            score: r.score,
            roleScore: r.roleScore,
            skillsScore: r.skillsScore,
            experienceScore: r.experienceScore,
            locationScore: r.locationScore,
            matchedSkills: r.matchedSkills,
            missingSkills: r.missingSkills,
            experienceFit: r.experienceFit,
            locationFit: r.locationFit,
            explanation: ev.explanation,
            explanationSource: ev.explanationSource,
            confidence: r.confidence,
            provider: ev.meta.provider,
            model: ev.meta.model,
            promptVersion: ev.meta.promptVersion,
            weights: r.weights as unknown as Prisma.InputJsonValue,
            inputHash: ev.inputHash,
            semanticHash: ev.semanticHash,
            semanticScore: ev.semanticScore,
            computedAt: new Date(),
          };
          await this.prisma.$transaction(async (tx) => {
            const match = await tx.jobMatch.upsert({
              where: { projectId_jobId: { projectId, jobId: job.id } },
              create: { workspaceId: project.workspaceId, projectId, jobId: job.id, ...data },
              update: data,
            });
            await tx.jobMatchEvidence.deleteMany({ where: { matchId: match.id } });
            await tx.jobMatchEvidence.createMany({
              data: r.evidence.map((e, position) => ({
                matchId: match.id,
                kind: e.kind,
                label: e.label.slice(0, 200),
                detail: e.detail,
                jobText: e.jobText,
                score: e.score,
                position,
              })),
            });
          });
          summary.evaluated += 1;
        } catch (error) {
          summary.failed += 1;
          this.logger.error(`Match ${projectId}/${job.id} failed: ${(error as Error).message}`);
        }
      }
    }
    return summary;
  }
}
