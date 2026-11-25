import { hashOf } from './hash';
import { roleTokens } from './rules';
import { normalizeSkillList, skillName } from './skills';
import type { RoleCategory, Seniority, SkillKind, WorkplaceType } from './types';
import { classifyRoleRules } from './rules';

/** Bump when scoring logic changes: stored matches with another version are recomputed. */
export const MATCH_ENGINE_VERSION = 'match-engine/v1';

export interface MatchWeights {
  role: number;
  skills: number;
  experience: number;
  location: number;
}

/** Initial weights: role 30%, skills 40%, experience 20%, location/workplace 10%. */
export const DEFAULT_WEIGHTS: MatchWeights = {
  role: 0.3,
  skills: 0.4,
  experience: 0.2,
  location: 0.1,
};

/** Weights scaled to sum to 1. Throws when no weight is positive (a configuration error). */
export function normalizeWeights(weights: MatchWeights): MatchWeights {
  const w = {
    role: Math.max(0, weights.role),
    skills: Math.max(0, weights.skills),
    experience: Math.max(0, weights.experience),
    location: Math.max(0, weights.location),
  };
  const sum = w.role + w.skills + w.experience + w.location;
  if (!(sum > 0)) throw new Error('At least one matching weight must be positive');
  return {
    role: round(w.role / sum, 6),
    skills: round(w.skills / sum, 6),
    experience: round(w.experience / sum, 6),
    location: round(w.location / sum, 6),
  };
}

export interface MatchPreferences {
  weights: MatchWeights;
  /** The ideal hire's years of experience; null = unspecified. */
  yearsExperience: number | null;
  seniorities: Seniority[];
  workplaceTypes: WorkplaceType[];
  /** Preferred places; empty = the project's own city and country. */
  locations: string[];
}

export const DEFAULT_PREFERENCES: MatchPreferences = {
  weights: DEFAULT_WEIGHTS,
  yearsExperience: null,
  seniorities: [],
  workplaceTypes: [],
  locations: [],
};

export interface MatchProject {
  targetRoles: string[];
  targetSkills: string[];
  /** ISO 3166-1 alpha-2. */
  country: string;
  city: string;
}

export interface MatchJob {
  title: string;
  normalizedTitle: string | null;
  seniority: Seniority;
  roleCategory: RoleCategory | null;
  skills: { key: string; name: string; kind: SkillKind }[];
  minYears: number | null;
  maxYears: number | null;
  location: string | null;
  locations: string[];
  workplaceType: WorkplaceType;
  /** Hash of the job's analysis: part of the input hash. */
  analysisHash: string;
}

export type ExperienceFitValue = 'MEETS' | 'BELOW' | 'ABOVE' | 'UNKNOWN';
export type LocationFitValue = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN';

export interface EvidenceItem {
  kind: 'ROLE' | 'SKILL_MATCHED' | 'SKILL_MISSING' | 'EXPERIENCE' | 'LOCATION' | 'WORKPLACE';
  label: string;
  detail: string | null;
  jobText: string | null;
  score: number | null;
}

export interface MatchResult {
  /** 0..100, two decimals. */
  score: number;
  roleScore: number | null;
  skillsScore: number | null;
  experienceScore: number | null;
  locationScore: number | null;
  matchedSkills: string[];
  missingSkills: string[];
  experienceFit: ExperienceFitValue;
  locationFit: LocationFitValue;
  /** 0..1 */
  confidence: number;
  weights: MatchWeights;
  evidence: EvidenceItem[];
  /** Deterministic explanation (always available; an AI one may replace it). */
  explanation: string;
  facts: string;
  allowedNumbers: Set<string>;
}

const round = (value: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ------------------------------------------------------------------ components

/** Role similarity from titles alone: token overlap, with a floor for the same role family. */
export function roleSimilarityRules(
  targetRoles: string[],
  job: Pick<MatchJob, 'title' | 'normalizedTitle' | 'roleCategory'>,
): { score: number; best: string | null } | null {
  const roles = targetRoles.map((r) => r.trim()).filter(Boolean);
  if (roles.length === 0) return null;
  const jobTokens = roleTokens(job.normalizedTitle ?? job.title);
  let best = { score: 0, role: null as string | null };
  for (const role of roles) {
    const tokens = roleTokens(role);
    const overlap = tokens.filter((t) => jobTokens.includes(t)).length;
    const dice =
      tokens.length + jobTokens.length === 0
        ? 0
        : (2 * overlap) / (tokens.length + jobTokens.length);
    const sameFamily = job.roleCategory !== null && classifyRoleRules(role) === job.roleCategory;
    const score = Math.max(dice, sameFamily ? 0.5 : 0);
    if (score > best.score) best = { score, role };
  }
  return { score: round(best.score), best: best.role };
}

/** The AI similarity is a refinement of the title overlap, never a replacement for it. */
export const blendRole = (rules: number, ai: number | null): number =>
  round(ai === null ? rules : 0.4 * rules + 0.6 * clamp01(ai));

export interface SkillsResult {
  score: number;
  matched: string[];
  missing: string[];
  evidence: EvidenceItem[];
}

export function skillsOverlap(
  targetSkills: string[],
  jobSkills: MatchJob['skills'],
): SkillsResult | null {
  const wanted = new Map(normalizeSkillList(targetSkills).map((s) => [s.key, s]));
  if (wanted.size === 0 || jobSkills.length === 0) return null;
  const required = jobSkills.filter((s) => s.kind === 'REQUIRED');
  const preferred = jobSkills.filter((s) => s.kind === 'PREFERRED');
  const cover = (list: MatchJob['skills']) =>
    list.filter((s) => wanted.has(s.key)).length / list.length;
  const score =
    required.length > 0 && preferred.length > 0
      ? 0.8 * cover(required) + 0.2 * cover(preferred)
      : required.length > 0
        ? cover(required)
        : cover(preferred);
  const display = (s: MatchJob['skills'][number]) => s.name || skillName(s.key);
  const ordered = [...required, ...preferred];
  const matched = ordered.filter((s) => wanted.has(s.key));
  const missing = ordered.filter((s) => !wanted.has(s.key));
  return {
    score: round(score),
    matched: matched.map(display),
    missing: missing.map(display),
    evidence: [
      ...matched.map((s): EvidenceItem => ({
        kind: 'SKILL_MATCHED',
        label: display(s),
        detail: `${s.kind === 'REQUIRED' ? 'Required' : 'Preferred'} by the job and in the project's skills`,
        jobText: null,
        score: 1,
      })),
      ...missing.map((s): EvidenceItem => ({
        kind: 'SKILL_MISSING',
        label: display(s),
        detail: `${s.kind === 'REQUIRED' ? 'Required' : 'Preferred'} by the job, not in the project's skills`,
        jobText: null,
        score: 0,
      })),
    ],
  };
}

const SENIORITY_ORDER: Seniority[] = [
  'INTERN',
  'JUNIOR',
  'MID',
  'SENIOR',
  'LEAD',
  'MANAGER',
  'DIRECTOR',
  'EXECUTIVE',
];

export function experienceFit(
  prefs: Pick<MatchPreferences, 'yearsExperience' | 'seniorities'>,
  job: Pick<MatchJob, 'minYears' | 'maxYears' | 'seniority'>,
): { fit: ExperienceFitValue; score: number | null; detail: string | null } {
  const parts: { fit: ExperienceFitValue; score: number; detail: string }[] = [];

  const years = prefs.yearsExperience;
  if (years !== null && job.minYears !== null) {
    if (years < job.minYears) {
      parts.push({
        fit: 'BELOW',
        score: clamp01(1 - (job.minYears - years) / Math.max(job.minYears, 1)),
        detail: `The job asks for ${job.minYears}+ years; the project targets ${years}`,
      });
    } else if (job.maxYears !== null && years > job.maxYears) {
      parts.push({
        fit: 'ABOVE',
        score: years - job.maxYears > 3 ? 0.6 : 0.8,
        detail: `The job asks for ${job.minYears}-${job.maxYears} years; the project targets ${years}`,
      });
    } else {
      parts.push({
        fit: 'MEETS',
        score: 1,
        detail: `${years} years meets the job's ${job.minYears}+ years`,
      });
    }
  }

  const wanted = prefs.seniorities.filter((s) => s !== 'UNKNOWN');
  if (wanted.length > 0 && job.seniority !== 'UNKNOWN') {
    if (wanted.includes(job.seniority)) {
      parts.push({ fit: 'MEETS', score: 1, detail: `${job.seniority} is a wanted seniority` });
    } else {
      const rank = (s: Seniority) => SENIORITY_ORDER.indexOf(s);
      const ranks = wanted.map(rank);
      const lo = Math.min(...ranks);
      const hi = Math.max(...ranks);
      const r = rank(job.seniority);
      if (r > hi) {
        parts.push({
          fit: 'BELOW',
          score: clamp01(1 - 0.35 * (r - hi)),
          detail: `${job.seniority} is above the wanted seniority`,
        });
      } else {
        parts.push({
          fit: 'ABOVE',
          score: clamp01(1 - 0.2 * (lo - r)),
          detail: `${job.seniority} is below the wanted seniority`,
        });
      }
    }
  }

  if (parts.length === 0) return { fit: 'UNKNOWN', score: null, detail: null };
  const fit = parts.some((p) => p.fit === 'BELOW')
    ? 'BELOW'
    : parts.some((p) => p.fit === 'ABOVE')
      ? 'ABOVE'
      : 'MEETS';
  return {
    fit,
    score: round(parts.reduce((s, p) => s + p.score, 0) / parts.length),
    detail: parts.map((p) => p.detail).join('; '),
  };
}

const fold = (v: string) =>
  v
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const countryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

const containsPhrase = (haystack: string, phrase: string) =>
  phrase.length > 0 && ` ${haystack} `.includes(` ${phrase} `);

export function locationFit(
  project: Pick<MatchProject, 'city' | 'country'>,
  prefs: Pick<MatchPreferences, 'locations' | 'workplaceTypes'>,
  job: Pick<MatchJob, 'location' | 'locations' | 'workplaceType'>,
): {
  fit: LocationFitValue;
  score: number | null;
  detail: string | null;
  workplaceDetail: string | null;
} {
  const remoteOk = prefs.workplaceTypes.length === 0 || prefs.workplaceTypes.includes('REMOTE');
  const workplaceExcluded =
    prefs.workplaceTypes.length > 0 &&
    job.workplaceType !== 'UNKNOWN' &&
    !prefs.workplaceTypes.includes(job.workplaceType);
  const workplaceDetail = workplaceExcluded
    ? `The job is ${job.workplaceType.toLowerCase()}; wanted: ${prefs.workplaceTypes.join(', ').toLowerCase()}`
    : null;
  const factor = workplaceExcluded ? 0.4 : 1;

  if (job.workplaceType === 'REMOTE' && remoteOk) {
    return { fit: 'MATCH', score: round(factor), detail: 'The job is remote', workplaceDetail };
  }

  const places = [job.location, ...job.locations].filter((l): l is string => !!l).map(fold);
  if (places.length === 0) {
    // No stated place and not remote: location cannot be judged.
    return workplaceExcluded
      ? { fit: 'PARTIAL', score: round(0.4), detail: null, workplaceDetail }
      : { fit: 'UNKNOWN', score: null, detail: null, workplaceDetail };
  }

  const preferred = prefs.locations.map(fold).filter(Boolean);
  const cities = preferred.length > 0 ? preferred : [fold(project.city)];
  const country = fold(countryName(project.country));
  const anyPlace = (needles: string[]) =>
    places.some((p) => needles.some((n) => containsPhrase(p, n)));

  if (anyPlace(cities))
    return {
      fit: 'MATCH',
      score: round(factor),
      detail: 'The job is in a wanted location',
      workplaceDetail,
    };
  if (preferred.length === 0 && anyPlace([country, project.country.toLowerCase()])) {
    return {
      fit: 'PARTIAL',
      score: round(0.6 * factor),
      detail: `The job is in ${countryName(project.country)}, not the project's city`,
      workplaceDetail,
    };
  }
  return {
    fit: 'MISMATCH',
    score: 0,
    detail: 'The job is not in a wanted location',
    workplaceDetail,
  };
}

// ------------------------------------------------------------------ the match

export interface SemanticRole {
  /** 0..1 from the AI, already validated. */
  similarity: number;
}

/** Everything a score depends on, hashed: equal hash → the stored match is current. */
export function matchInputHash(input: {
  job: MatchJob;
  project: MatchProject;
  preferences: MatchPreferences;
  semanticKey: string | null;
}): string {
  return hashOf({
    engine: MATCH_ENGINE_VERSION,
    job: input.job,
    project: {
      roles: input.project.targetRoles,
      skills: normalizeSkillList(input.project.targetSkills)
        .map((s) => s.key)
        .sort(),
      country: input.project.country,
      city: input.project.city,
    },
    preferences: { ...input.preferences, weights: normalizeWeights(input.preferences.weights) },
    semanticKey: input.semanticKey,
  });
}

/** Deterministic: the same inputs always produce the same result, bit for bit. */
export function computeMatch(input: {
  job: MatchJob;
  project: MatchProject;
  preferences: MatchPreferences;
  /** AI role similarity, when one was obtained. */
  semantic?: SemanticRole | null;
  /** Whether the job analysis itself used AI, and how complete it was (0..1). */
  analysisConfidence: number;
}): MatchResult {
  const { job, project, preferences } = input;
  const weights = normalizeWeights(preferences.weights);
  const evidence: EvidenceItem[] = [];

  // ---- components (null = cannot be judged)
  const rules = roleSimilarityRules(project.targetRoles, job);
  const roleScore = rules ? blendRole(rules.score, input.semantic?.similarity ?? null) : null;
  if (rules && roleScore !== null) {
    evidence.push({
      kind: 'ROLE',
      label: job.normalizedTitle ?? job.title,
      detail:
        `Title similarity ${Math.round(rules.score * 100)}%` +
        (rules.best ? ` to "${rules.best}"` : '') +
        (input.semantic
          ? `; semantic similarity ${Math.round(input.semantic.similarity * 100)}%`
          : ''),
      jobText: job.title,
      score: roleScore,
    });
  }

  const skills = skillsOverlap(project.targetSkills, job.skills);
  if (skills) evidence.push(...skills.evidence);

  const exp = experienceFit(preferences, job);
  if (exp.detail) {
    evidence.push({
      kind: 'EXPERIENCE',
      label: exp.fit,
      detail: exp.detail,
      jobText:
        job.minYears !== null
          ? `${job.minYears}${job.maxYears !== null ? `-${job.maxYears}` : '+'} years`
          : null,
      score: exp.score,
    });
  }

  const loc = locationFit(project, preferences, job);
  if (loc.detail) {
    evidence.push({
      kind: 'LOCATION',
      label: loc.fit,
      detail: loc.detail,
      jobText: job.location,
      score: loc.score,
    });
  }
  if (loc.workplaceDetail) {
    evidence.push({
      kind: 'WORKPLACE',
      label: job.workplaceType,
      detail: loc.workplaceDetail,
      jobText: null,
      score: null,
    });
  }

  // ---- weighted mean over the components we could judge
  const parts: [number | null, number][] = [
    [roleScore, weights.role],
    [skills?.score ?? null, weights.skills],
    [exp.score, weights.experience],
    [loc.score, weights.location],
  ];
  const known = parts.filter((p): p is [number, number] => p[0] !== null && p[1] > 0);
  const coverage = known.reduce((s, [, w]) => s + w, 0);
  const score =
    coverage > 0 ? round((known.reduce((s, [v, w]) => s + v * w, 0) / coverage) * 100, 2) : 0;

  // Confidence: how much of the weight we could judge × how well the job was understood, and a
  // small discount when the role judgement is title overlap only.
  const confidence = round(
    coverage *
      clamp01(input.analysisConfidence) *
      (roleScore !== null && !input.semantic ? 0.95 : 1),
    2,
  );

  const matchedSkills = skills?.matched ?? [];
  const missingSkills = skills?.missing ?? [];
  const facts = describeFacts({
    job,
    score,
    roleScore,
    skillsScore: skills?.score ?? null,
    experienceScore: exp.score,
    locationScore: loc.score,
    matchedSkills,
    missingSkills,
    experienceFit: exp.fit,
    locationFit: loc.fit,
    experienceDetail: exp.detail,
    locationDetail: loc.detail,
    workplaceDetail: loc.workplaceDetail,
  });

  return {
    score,
    roleScore,
    skillsScore: skills?.score ?? null,
    experienceScore: exp.score,
    locationScore: loc.score,
    matchedSkills,
    missingSkills,
    experienceFit: exp.fit,
    locationFit: loc.fit,
    confidence,
    weights,
    evidence,
    explanation: templateExplanation({
      job,
      score,
      matchedSkills,
      missingSkills,
      experienceFit: exp.fit,
      experienceDetail: exp.detail,
      locationFit: loc.fit,
      locationDetail: loc.detail,
      roleScore,
      coverage,
    }),
    facts: facts.text,
    allowedNumbers: facts.numbers,
  };
}

const pct = (v: number | null) => (v === null ? 'unknown' : `${Math.round(v * 100)}%`);

function describeFacts(f: {
  job: MatchJob;
  score: number;
  roleScore: number | null;
  skillsScore: number | null;
  experienceScore: number | null;
  locationScore: number | null;
  matchedSkills: string[];
  missingSkills: string[];
  experienceFit: ExperienceFitValue;
  locationFit: LocationFitValue;
  experienceDetail: string | null;
  locationDetail: string | null;
  workplaceDetail: string | null;
}): { text: string; numbers: Set<string> } {
  const text = [
    `Job: ${f.job.normalizedTitle ?? f.job.title}`,
    `Overall score: ${Math.round(f.score)} out of 100`,
    `Role similarity: ${pct(f.roleScore)}`,
    `Skills overlap: ${pct(f.skillsScore)}`,
    `Matched skills: ${f.matchedSkills.slice(0, 15).join(', ') || 'none'}`,
    `Missing skills: ${f.missingSkills.slice(0, 15).join(', ') || 'none'}`,
    `Experience fit: ${f.experienceFit} (${pct(f.experienceScore)}). ${f.experienceDetail ?? ''}`,
    `Location fit: ${f.locationFit} (${pct(f.locationScore)}). ${f.locationDetail ?? ''} ${f.workplaceDetail ?? ''}`,
  ].join('\n');
  const numbers = new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);
  return { text, numbers };
}

function templateExplanation(f: {
  job: MatchJob;
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  experienceFit: ExperienceFitValue;
  experienceDetail: string | null;
  locationFit: LocationFitValue;
  locationDetail: string | null;
  roleScore: number | null;
  coverage: number;
}): string {
  if (f.coverage === 0) {
    return 'There is not enough information to compare this job with the project: set target roles, skills, experience or location preferences.';
  }
  const title = f.job.normalizedTitle ?? f.job.title;
  const parts = [`${title} scores ${Math.round(f.score)} out of 100.`];
  if (f.roleScore !== null) {
    parts.push(
      f.roleScore >= 0.7
        ? 'The role is close to what the project is looking for.'
        : f.roleScore >= 0.4
          ? 'The role is partly related to what the project is looking for.'
          : 'The role is only loosely related to what the project is looking for.',
    );
  }
  if (f.matchedSkills.length > 0)
    parts.push(`Matching skills: ${f.matchedSkills.slice(0, 8).join(', ')}.`);
  if (f.missingSkills.length > 0)
    parts.push(
      `Skills the job asks for that the project lacks: ${f.missingSkills.slice(0, 8).join(', ')}.`,
    );
  if (f.experienceDetail) parts.push(`${f.experienceDetail}.`);
  if (f.locationDetail) parts.push(`${f.locationDetail}.`);
  return parts.join(' ').slice(0, 900);
}
