import { looksLikePromptInjection, RULES_META } from './ai/provider';
import { PROMPT_VERSIONS, type JobAi } from './ai/tasks';
import { hashOf } from './hash';
import {
  classifyRoleRules,
  detectSeniority,
  extractEducationRules,
  extractExperienceMentions,
  extractSalaryRules,
  extractSkillsRules,
  headlineExperience,
  normalizeTitleRules,
} from './rules';
import type {
  AiMeta,
  JobAnalysis,
  JobContent,
  RequirementItem,
  RoleCategory,
  Seniority,
  SkillItem,
} from './types';

/** Hash of everything analysis reads: when it changes, the stored analysis is stale. */
export const jobContentHash = (job: JobContent): string =>
  hashOf({
    title: job.title,
    description: job.description,
    location: job.location,
    locations: job.locations,
    department: job.department,
    employmentType: job.employmentType,
    workplaceType: job.workplaceType,
  });

const MIN_AI_CATEGORY_CONFIDENCE = 0.5;

export interface AnalyzeOptions {
  /** Absent → rules only. */
  ai?: JobAi | null;
}

/**
 * Turn one raw posting into structured intelligence. Rules always run first and always produce a
 * complete result; the AI (when configured) may only ADD validated, quote-grounded information:
 * it can fill a gap (a skill, a category, a seniority) but never overrides a rule-derived value
 * and is never trusted for salary. If anything about the AI fails the rule result stands.
 */
export async function analyzeJob(
  job: JobContent,
  options: AnalyzeOptions = {},
): Promise<JobAnalysis> {
  const notes: string[] = [];
  const description = job.description;

  // ---- 1. rules
  let normalizedTitle = normalizeTitleRules(job.title);
  let seniority: Seniority = detectSeniority(job.title);
  let roleCategory: RoleCategory | null =
    classifyRoleRules(normalizedTitle) ?? classifyRoleRules(job.title);
  const skills = new Map<string, SkillItem>(
    extractSkillsRules(normalizedTitle, description).map((s) => [s.key, s]),
  );
  const mentions = extractExperienceMentions(description);
  const requirements: RequirementItem[] = [
    ...mentions.map((m): RequirementItem => ({
      kind: 'EXPERIENCE',
      text: m.text,
      mandatory: m.mandatory,
      minYears: m.minYears,
      maxYears: m.maxYears,
      level: null,
      source: 'RULES',
    })),
    ...extractEducationRules(description),
  ];
  let headline = headlineExperience(mentions);
  const salary = extractSalaryRules(description);

  // ---- 2. AI, only for postings that do not try to talk to it
  let meta: AiMeta = RULES_META;
  const ai = options.ai;
  if (ai) {
    if (looksLikePromptInjection(`${job.title}\n${description ?? ''}`)) {
      notes.push('AI skipped: the posting contains text addressed to an AI');
    } else {
      const text = { title: job.title, description, department: job.department };
      const [titleR, skillsR, descR, roleR] = await Promise.all([
        ai.normalizeTitle(text),
        ai.extractSkills({ ...text, title: normalizedTitle }),
        ai.parseDescription(text),
        ai.classifyRole({ ...text, title: normalizedTitle }),
      ]);
      const used: string[] = [];

      if (titleR.ok) {
        normalizedTitle = titleR.data.normalizedTitle;
        if (seniority === 'UNKNOWN' && titleR.data.seniority) seniority = titleR.data.seniority;
        roleCategory = roleCategory ?? classifyRoleRules(normalizedTitle);
        used.push(PROMPT_VERSIONS.titleNormalization);
      } else notes.push(`title normalization: ${titleR.reason}`);

      if (skillsR.ok) {
        for (const s of skillsR.data) {
          if (!skills.has(s.key)) {
            skills.set(s.key, {
              key: s.key,
              name: s.name,
              kind: s.kind,
              evidence: s.quote.slice(0, 200),
              source: 'AI',
            });
          }
        }
        used.push(PROMPT_VERSIONS.skillExtraction);
      } else notes.push(`skill extraction: ${skillsR.reason}`);

      if (descR.ok) {
        const known = (min: number, max: number | null) =>
          requirements.some(
            (r) => r.kind === 'EXPERIENCE' && r.minYears === min && r.maxYears === max,
          );
        for (const e of descR.data.experience) {
          if (known(e.minYears, e.maxYears)) continue;
          requirements.push({
            kind: 'EXPERIENCE',
            text: e.quote.slice(0, 400),
            mandatory: e.mandatory,
            minYears: e.minYears,
            maxYears: e.maxYears,
            level: null,
            source: 'AI',
          });
        }
        for (const e of descR.data.education) {
          if (requirements.some((r) => r.kind === 'EDUCATION' && r.level === e.level)) continue;
          requirements.push({
            kind: 'EDUCATION',
            text: e.quote.slice(0, 400),
            mandatory: e.mandatory,
            minYears: null,
            maxYears: null,
            level: e.level,
            source: 'AI',
          });
        }
        for (const c of descR.data.certifications) {
          requirements.push({
            kind: 'CERTIFICATION',
            text: c.quote.slice(0, 400),
            mandatory: c.mandatory,
            minYears: null,
            maxYears: null,
            level: null,
            source: 'AI',
          });
        }
        if (!headline) {
          const first = requirements.find(
            (r) => r.kind === 'EXPERIENCE' && r.mandatory && r.minYears !== null,
          );
          if (first) headline = { minYears: first.minYears!, maxYears: first.maxYears };
        }
        used.push(PROMPT_VERSIONS.descriptionParsing);
      } else notes.push(`description parsing: ${descR.reason}`);

      if (roleR.ok) {
        const ruleCategory = classifyRoleRules(normalizedTitle) ?? classifyRoleRules(job.title);
        if (!ruleCategory && roleR.data.confidence >= MIN_AI_CATEGORY_CONFIDENCE) {
          roleCategory = roleR.data.category;
        } else if (ruleCategory && ruleCategory !== roleR.data.category) {
          notes.push(
            `role classification: kept rule category ${ruleCategory} over AI ${roleR.data.category}`,
          );
        }
        used.push(PROMPT_VERSIONS.roleClassification);
      } else notes.push(`role classification: ${roleR.reason}`);

      if (used.length > 0)
        meta = {
          provider: ai.provider.id,
          model: ai.provider.model,
          promptVersion: used.join(','),
        };
    }
  }

  const skillList = [...skills.values()];
  return {
    contentHash: jobContentHash(job),
    normalizedTitle,
    seniority,
    roleCategory,
    skills: skillList,
    requirements,
    salary,
    minYears: headline?.minYears ?? null,
    maxYears: headline?.maxYears ?? null,
    confidence: analysisConfidence({
      hasDescription: !!description,
      skills: skillList.length,
      seniority,
      roleCategory,
      experience: headline !== null,
      ai: meta.provider !== 'rules',
    }),
    meta,
    notes,
  };
}

/** 0..1: how much of the posting could be structured. A title alone is worth little. */
export function analysisConfidence(input: {
  hasDescription: boolean;
  skills: number;
  seniority: Seniority;
  roleCategory: RoleCategory | null;
  experience: boolean;
  ai: boolean;
}): number {
  let c = 0.2;
  if (input.hasDescription) c += 0.2;
  if (input.skills > 0) c += 0.2 + Math.min(input.skills, 5) * 0.02;
  if (input.seniority !== 'UNKNOWN') c += 0.1;
  if (input.roleCategory) c += 0.1;
  if (input.experience) c += 0.1;
  if (input.ai) c += 0.05;
  return Math.round(Math.min(c, 1) * 100) / 100;
}
