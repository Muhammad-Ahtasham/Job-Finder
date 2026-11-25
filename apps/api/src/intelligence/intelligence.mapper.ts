import type {
  Company,
  Job,
  JobMatch as MatchRow,
  JobMatchEvidence,
  JobObservation as ObservationRow,
  JobRequirement as RequirementRow,
  JobSkill as SkillRow,
  MatchPreference,
} from '@jobfinder/database';
import {
  matchWeightsSchema,
  type JobDetail,
  type JobMatch,
  type JobObservation,
  type MatchPreferences,
} from '@jobfinder/contracts';
import { DEFAULT_WEIGHTS } from '@jobfinder/intelligence';
import { toJob } from '../companies/jobs.mapper';

const iso = (d: Date | null) => d?.toISOString() ?? null;

export type JobWithDetail = Job & {
  source: { providerId: string };
  company: Pick<Company, 'displayName'>;
  skills: SkillRow[];
  requirements: RequirementRow[];
};

export const JOB_DETAIL_INCLUDE = {
  source: { select: { providerId: true } },
  company: { select: { displayName: true } },
  skills: { orderBy: [{ kind: 'asc' as const }, { name: 'asc' as const }] },
  requirements: { orderBy: { id: 'asc' as const } },
};

export function toJobDetail(job: JobWithDetail): JobDetail {
  const hasSalary = job.salaryMin !== null || job.salaryMax !== null;
  return {
    ...toJob(job),
    companyId: job.companyId,
    companyName: job.company.displayName,
    normalizedTitle: job.normalizedTitle,
    seniority: job.seniority,
    roleCategory: job.roleCategory,
    salary: hasSalary
      ? {
          min: job.salaryMin,
          max: job.salaryMax,
          currency: job.salaryCurrency,
          period: job.salaryPeriod,
          text: job.salaryText,
        }
      : null,
    minYearsExperience: job.minYearsExperience,
    maxYearsExperience: job.maxYearsExperience,
    expiresAt: iso(job.expiresAt),
    statusReason: job.statusReason,
    statusChangedAt: iso(job.statusChangedAt),
    skills: job.skills.map((s) => ({
      key: s.skillKey,
      name: s.name,
      kind: s.kind,
      evidence: s.evidence,
      source: s.source,
    })),
    requirements: job.requirements.map((r) => ({
      kind: r.kind,
      text: r.text,
      mandatory: r.mandatory,
      minYears: r.minYears,
      maxYears: r.maxYears,
      level: r.level,
      source: r.source,
    })),
    analysis: {
      state: job.analysisHash ? 'ANALYZED' : 'PENDING',
      analyzedAt: iso(job.analyzedAt),
      provider: job.analysisProvider,
      model: job.analysisModel,
      promptVersion: job.analysisPromptVersion,
      confidence: job.analysisConfidence,
    },
  };
}

export function toObservation(o: ObservationRow): JobObservation {
  const changes =
    o.changes && typeof o.changes === 'object' && !Array.isArray(o.changes) ? o.changes : {};
  return {
    id: o.id,
    kind: o.kind,
    fromStatus: o.fromStatus,
    toStatus: o.toStatus,
    reason: o.reason,
    changes: changes as Record<string, unknown>,
    checkId: o.checkId,
    observedAt: o.observedAt.toISOString(),
  };
}

export function toPreferences(row: MatchPreference | null): MatchPreferences {
  return row
    ? {
        weights: {
          role: row.roleWeight,
          skills: row.skillsWeight,
          experience: row.experienceWeight,
          location: row.locationWeight,
        },
        yearsExperience: row.yearsExperience,
        seniorities: row.seniorities.filter(
          (s) => s !== 'UNKNOWN',
        ) as MatchPreferences['seniorities'],
        workplaceTypes: row.workplaceTypes.filter(
          (w) => w !== 'UNKNOWN',
        ) as MatchPreferences['workplaceTypes'],
        locations: row.locations,
        minScore: row.minScore,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      }
    : {
        weights: {
          role: DEFAULT_WEIGHTS.role,
          skills: DEFAULT_WEIGHTS.skills,
          experience: DEFAULT_WEIGHTS.experience,
          location: DEFAULT_WEIGHTS.location,
        },
        yearsExperience: null,
        seniorities: [],
        workplaceTypes: [],
        locations: [],
        minScore: 0,
        version: 0,
        updatedAt: null,
      };
}

export function toMatch(
  match: MatchRow & { evidence: JobMatchEvidence[]; job: JobWithDetail },
): JobMatch {
  const weights = matchWeightsSchema.safeParse(match.weights);
  return {
    id: match.id,
    projectId: match.projectId,
    score: match.score,
    components: {
      role: match.roleScore,
      skills: match.skillsScore,
      experience: match.experienceScore,
      location: match.locationScore,
    },
    weights: weights.success ? weights.data : { ...DEFAULT_WEIGHTS },
    matchedSkills: match.matchedSkills,
    missingSkills: match.missingSkills,
    experienceFit: match.experienceFit,
    locationFit: match.locationFit,
    explanation: match.explanation,
    explanationSource: match.explanationSource,
    confidence: match.confidence,
    provider: match.provider,
    model: match.model,
    promptVersion: match.promptVersion,
    computedAt: match.computedAt.toISOString(),
    evidence: [...match.evidence]
      .sort((a, b) => a.position - b.position)
      .map((e) => ({
        kind: e.kind,
        label: e.label,
        detail: e.detail,
        jobText: e.jobText,
        score: e.score,
      })),
    job: toJobDetail(match.job),
  };
}
