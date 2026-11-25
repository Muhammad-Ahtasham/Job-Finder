/**
 * Contracts for job intelligence. Pure TypeScript: no database, no NestJS, no network (the AI
 * provider is an injected interface). The worker owns persistence and orchestration.
 */

export const SENIORITIES = [
  'INTERN',
  'JUNIOR',
  'MID',
  'SENIOR',
  'LEAD',
  'MANAGER',
  'DIRECTOR',
  'EXECUTIVE',
  'UNKNOWN',
] as const;
export type Seniority = (typeof SENIORITIES)[number];

/** Coarse role families. `null` on a job means "not classified", never a guess. */
export const ROLE_CATEGORIES = [
  'SOFTWARE_ENGINEERING',
  'DATA_AI',
  'DEVOPS_INFRASTRUCTURE',
  'QA_TESTING',
  'SECURITY',
  'DESIGN',
  'PRODUCT',
  'PROJECT_MANAGEMENT',
  'MARKETING',
  'SALES',
  'CUSTOMER_SUPPORT',
  'HUMAN_RESOURCES',
  'FINANCE_ACCOUNTING',
  'OPERATIONS',
  'LEGAL',
  'CONTENT_WRITING',
  'IT_SUPPORT',
  'OTHER',
] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export const EDUCATION_LEVELS = [
  'HIGH_SCHOOL',
  'DIPLOMA',
  'BACHELOR',
  'MASTER',
  'DOCTORATE',
] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const SALARY_PERIODS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export type EmploymentType =
  'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERNSHIP' | 'TEMPORARY' | 'OTHER' | 'UNKNOWN';
export type WorkplaceType = 'ONSITE' | 'REMOTE' | 'HYBRID' | 'UNKNOWN';

export type AnalysisSource = 'RULES' | 'AI';
export type SkillKind = 'REQUIRED' | 'PREFERRED';
export type RequirementKind = 'EXPERIENCE' | 'EDUCATION' | 'CERTIFICATION' | 'LANGUAGE' | 'OTHER';

/** What analysis reads from a stored job. */
export interface JobContent {
  title: string;
  description: string | null;
  location: string | null;
  locations: string[];
  department: string | null;
  employmentType: EmploymentType;
  workplaceType: WorkplaceType;
}

export interface SkillItem {
  /** Canonical key used for matching ("nodejs"). */
  key: string;
  /** Canonical display name ("Node.js"). */
  name: string;
  kind: SkillKind;
  /** Text from the posting the skill was read from (always a real excerpt). */
  evidence: string | null;
  source: AnalysisSource;
}

export interface RequirementItem {
  kind: RequirementKind;
  /** An excerpt of the posting, never a paraphrase. */
  text: string;
  mandatory: boolean;
  minYears: number | null;
  maxYears: number | null;
  level: EducationLevel | null;
  source: AnalysisSource;
}

export interface SalaryInfo {
  min: number | null;
  max: number | null;
  /** ISO code when the posting gave one (or an unambiguous symbol); otherwise the symbol as written. */
  currency: string;
  period: SalaryPeriod | null;
  /** The exact text the figures were read from. */
  text: string;
}

/** Provenance of the AI used for an analysis; "rules" when none was. */
export interface AiMeta {
  provider: string;
  model: string;
  promptVersion: string;
}

export interface JobAnalysis {
  contentHash: string;
  normalizedTitle: string;
  seniority: Seniority;
  roleCategory: RoleCategory | null;
  skills: SkillItem[];
  requirements: RequirementItem[];
  salary: SalaryInfo | null;
  minYears: number | null;
  maxYears: number | null;
  /** 0..1: how much of the posting we could structure. */
  confidence: number;
  meta: AiMeta;
  /** Non-fatal notes: AI skipped, output rejected, ... */
  notes: string[];
}
