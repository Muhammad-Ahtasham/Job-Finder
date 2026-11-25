import { z } from 'zod';
import { normalizeSkill, findSkillsInText } from '../skills';
import {
  EDUCATION_LEVELS,
  ROLE_CATEGORIES,
  SENIORITIES,
  type AiMeta,
  type EducationLevel,
  type RoleCategory,
  type Seniority,
} from '../types';
import {
  fence,
  occursIn,
  runStructured,
  safeText,
  unitInterval,
  UNTRUSTED_NOTICE,
  type AiProvider,
  type AiResult,
} from './provider';

/** Bump a version whenever a prompt or schema changes: it is stored with every result. */
export const PROMPT_VERSIONS = {
  titleNormalization: 'title-normalization/v1',
  skillExtraction: 'skill-extraction/v1',
  descriptionParsing: 'description-parsing/v1',
  roleClassification: 'role-classification/v1',
  semanticMatching: 'semantic-matching/v1',
  matchExplanation: 'match-explanation/v1',
} as const;

const MAX_DESCRIPTION_CHARS = 8000;

// Words a normalized title may use even if the posting spells them differently ("SWE" → "Software").
const ROLE_VOCAB = new Set(
  `software engineer developer programmer backend back end frontend front full stack web mobile data
  scientist analyst machine learning ai devops site reliability cloud platform security qa quality
  assurance test automation product project program manager designer ux ui lead architect
  administrator specialist consultant representative executive officer coordinator associate marketing
  sales support customer success business intelligence database network systems embedded game writer
  editor accountant finance hr recruiter operations`.split(/\s+/),
);

// ---------------------------------------------------------------- schemas (also the JSON schema sent to the model)

export const titleOutputSchema = z.object({
  normalizedTitle: safeText(120),
  /** Only when the title itself states a level. */
  seniority: z.enum(SENIORITIES).optional(),
  /** The words of the original title that state the seniority. */
  seniorityQuote: safeText(80).optional(),
});

export const skillsOutputSchema = z.object({
  skills: z
    .array(
      z.object({
        name: safeText(60),
        kind: z.enum(['REQUIRED', 'PREFERRED']),
        /** A short quote from the posting where the skill is mentioned. */
        quote: safeText(240),
      }),
    )
    .max(40),
});

export const descriptionOutputSchema = z.object({
  experience: z
    .array(
      z.object({
        quote: safeText(300),
        minYears: z.number().int().min(0).max(40),
        maxYears: z.number().int().min(0).max(40).optional(),
        mandatory: z.boolean(),
      }),
    )
    .max(6),
  education: z
    .array(
      z.object({
        quote: safeText(300),
        level: z.enum(EDUCATION_LEVELS),
        mandatory: z.boolean(),
      }),
    )
    .max(4),
  certifications: z.array(z.object({ quote: safeText(200), mandatory: z.boolean() })).max(8),
});

export const roleOutputSchema = z.object({
  category: z.enum(ROLE_CATEGORIES),
  confidence: unitInterval,
});

export const semanticOutputSchema = z.object({
  similarity: unitInterval,
  reason: safeText(240),
});

export const explanationOutputSchema = z.object({ explanation: safeText(700) });

// ---------------------------------------------------------------- validated, grounded results

export interface AiTitleResult {
  normalizedTitle: string;
  seniority: Seniority | null;
}
export interface AiSkill {
  key: string;
  name: string;
  kind: 'REQUIRED' | 'PREFERRED';
  quote: string;
}
export interface AiDescriptionResult {
  experience: { quote: string; minYears: number; maxYears: number | null; mandatory: boolean }[];
  education: { quote: string; level: EducationLevel; mandatory: boolean }[];
  certifications: { quote: string; mandatory: boolean }[];
}

export interface JobText {
  title: string;
  description: string | null;
  department?: string | null;
}

const system = (task: string) =>
  `You are a careful analyst working on ${task} for job postings. ${UNTRUSTED_NOTICE}`;

const jobBlock = (job: JobText) =>
  `Title: ${job.title.slice(0, 200)}\n${fence('job', job.description ?? '(no description)', MAX_DESCRIPTION_CHARS)}`;

const wordsOf = (value: string) => value.toLowerCase().match(/[a-z0-9+#.]+/g) ?? [];

/**
 * The six AI tasks. Every method returns validated data or `{ ok: false }`; none can throw, and
 * none can introduce a fact the posting does not contain (quotes must occur in the text, numbers
 * must occur in their quote, titles may only use words from the posting or the role vocabulary).
 */
export class JobAi {
  constructor(readonly provider: AiProvider) {}

  async normalizeTitle(job: JobText): Promise<AiResult<AiTitleResult>> {
    const result = await runStructured(
      this.provider,
      {
        task: 'title-normalization',
        promptVersion: PROMPT_VERSIONS.titleNormalization,
        system:
          system('job title normalization') +
          ' Return the role title without seniority words, location, remote/hybrid notes, or hiring tags, with abbreviations expanded (e.g. "Sr. SWE (Remote)" → "Software Engineer"). Report seniority only if the title states it, and quote the words that state it.',
        user: `Original title: ${job.title.slice(0, 200)}\n${fence('job', (job.description ?? '').slice(0, 1500), 1500)}`,
        maxTokens: 300,
      },
      titleOutputSchema,
    );
    if (!result.ok) return result;
    const { normalizedTitle, seniority, seniorityQuote } = result.data;
    const haystack = `${job.title} ${job.description ?? ''}`.toLowerCase();
    const bad = wordsOf(normalizedTitle).filter(
      (w) => !haystack.includes(w) && !ROLE_VOCAB.has(w) && !ROLE_VOCAB.has(w.replace(/s$/, '')),
    );
    if (bad.length > 0)
      return { ok: false, reason: `title uses words not in the posting: ${bad.join(', ')}` };
    return {
      ok: true,
      meta: result.meta,
      data: {
        normalizedTitle,
        // The seniority claim must be backed by words of the ORIGINAL title.
        seniority:
          seniority &&
          seniority !== 'UNKNOWN' &&
          seniorityQuote &&
          occursIn(seniorityQuote, job.title)
            ? seniority
            : null,
      },
    };
  }

  async extractSkills(job: JobText): Promise<AiResult<AiSkill[]>> {
    if (!job.description) return { ok: false, reason: 'no description' };
    const result = await runStructured(
      this.provider,
      {
        task: 'skill-extraction',
        promptVersion: PROMPT_VERSIONS.skillExtraction,
        system:
          system('skill extraction') +
          ' List the technical and professional skills the posting asks the candidate to have. REQUIRED = needed; PREFERRED = nice to have / a plus. Do not list technologies that only describe the company. Give a short exact quote for each.',
        user: jobBlock(job),
        maxTokens: 1500,
      },
      skillsOutputSchema,
    );
    if (!result.ok) return result;
    const text = `${job.title}\n${job.description}`;
    const skills = new Map<string, AiSkill>();
    for (const item of result.data.skills) {
      if (!occursIn(item.quote, text)) continue; // not in the posting: dropped
      const normalized = normalizeSkill(item.name);
      if (!normalized) continue;
      // The skill itself must be visible in its quote (by name, or as a known alias).
      const visible =
        occursIn(item.name, item.quote) ||
        occursIn(normalized.name, item.quote) ||
        findSkillsInText(item.quote).some((s) => s.key === normalized.key);
      if (!visible) continue;
      const existing = skills.get(normalized.key);
      if (existing?.kind === 'REQUIRED') continue;
      skills.set(normalized.key, {
        key: normalized.key,
        name: normalized.name,
        kind: item.kind,
        quote: item.quote,
      });
    }
    return { ok: true, meta: result.meta, data: [...skills.values()] };
  }

  async parseDescription(job: JobText): Promise<AiResult<AiDescriptionResult>> {
    if (!job.description) return { ok: false, reason: 'no description' };
    const result = await runStructured(
      this.provider,
      {
        task: 'description-parsing',
        promptVersion: PROMPT_VERSIONS.descriptionParsing,
        system:
          system('job description parsing') +
          ' Extract experience requirements (years), education requirements and certifications that the posting explicitly states. Quote the sentence for each. Do not infer or estimate years; do not report anything that is not written.',
        user: jobBlock(job),
        maxTokens: 1200,
      },
      descriptionOutputSchema,
    );
    if (!result.ok) return result;
    const text = job.description;
    const digits = (value: number) => new RegExp(`(?<!\\d)${value}(?!\\d)`);
    return {
      ok: true,
      meta: result.meta,
      data: {
        experience: result.data.experience
          .filter(
            (e) =>
              occursIn(e.quote, text) &&
              digits(e.minYears).test(e.quote) &&
              (e.maxYears === undefined ||
                (e.maxYears >= e.minYears && digits(e.maxYears).test(e.quote))),
          )
          .map((e) => ({
            quote: e.quote,
            minYears: e.minYears,
            maxYears: e.maxYears ?? null,
            mandatory: e.mandatory,
          })),
        education: result.data.education.filter((e) => occursIn(e.quote, text)),
        certifications: result.data.certifications.filter((c) => occursIn(c.quote, text)),
      },
    };
  }

  async classifyRole(
    job: JobText,
  ): Promise<AiResult<{ category: RoleCategory; confidence: number }>> {
    const result = await runStructured(
      this.provider,
      {
        task: 'role-classification',
        promptVersion: PROMPT_VERSIONS.roleClassification,
        system:
          system('role classification') + ' Pick the single best role family for the posting.',
        user: `${jobBlock({ ...job, description: (job.description ?? '').slice(0, 2500) })}`,
        maxTokens: 200,
      },
      roleOutputSchema,
    );
    return result.ok ? { ok: true, meta: result.meta, data: result.data } : result;
  }

  /** How close is this posting to the roles a project is looking for? 0..1. */
  async semanticMatch(input: {
    targetRoles: string[];
    job: JobText & { skills: string[] };
  }): Promise<AiResult<{ similarity: number; reason: string }>> {
    const result = await runStructured(
      this.provider,
      {
        task: 'semantic-matching',
        promptVersion: PROMPT_VERSIONS.semanticMatching,
        system:
          system('semantic role matching') +
          " Score from 0 to 1 how closely the posting's role matches ANY of the wanted roles: 1 = the same role, 0.7 = a closely related role, 0.4 = adjacent, 0 = unrelated. Judge the role, not the seniority, location or skills.",
        user: `Wanted roles: ${input.targetRoles.slice(0, 20).join('; ')}\n${jobBlock({
          ...input.job,
          description: `Skills: ${input.job.skills.slice(0, 30).join(', ')}\n${(input.job.description ?? '').slice(0, 1500)}`,
        })}`,
        maxTokens: 300,
      },
      semanticOutputSchema,
    );
    return result.ok ? { ok: true, meta: result.meta, data: result.data } : result;
  }

  /**
   * A plain-language explanation of an already-computed match. The model may only restate the
   * facts it is given: any number it writes that is not among them rejects the answer.
   */
  async explainMatch(facts: string, allowedNumbers: Set<string>): Promise<AiResult<string>> {
    const result = await runStructured(
      this.provider,
      {
        task: 'match-explanation',
        promptVersion: PROMPT_VERSIONS.matchExplanation,
        system:
          system('match explanation') +
          ' Explain in 2-3 plain sentences why this job does or does not fit, using only the facts provided. Do not add requirements, numbers or opinions that are not in the facts.',
        user: fence('facts', facts, 3000),
        maxTokens: 400,
      },
      explanationOutputSchema,
    );
    if (!result.ok) return result;
    const numbers = result.data.explanation.match(/\d+(?:\.\d+)?/g) ?? [];
    const stray = numbers.filter((n) => !allowedNumbers.has(n));
    if (stray.length > 0)
      return {
        ok: false,
        reason: `explanation cites numbers not in the facts: ${stray.join(', ')}`,
      };
    return { ok: true, meta: result.meta, data: result.data.explanation };
  }
}

export type { AiMeta };
