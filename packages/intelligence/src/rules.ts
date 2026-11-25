import { findSkillsInText } from './skills';
import type {
  EducationLevel,
  RequirementItem,
  RoleCategory,
  SalaryInfo,
  SalaryPeriod,
  Seniority,
  SkillItem,
} from './types';

/**
 * Deterministic extraction. Everything here reads what the posting SAYS and nothing else: a
 * field the text does not state stays null / UNKNOWN.
 */

const clip = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);

// ------------------------------------------------------------------ title

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bsr\.?(?=\s)/gi, 'Senior'],
  [/\bjr\.?(?=\s)/gi, 'Junior'],
  [/\bswe\b/gi, 'Software Engineer'],
  [/\bsde\b/gi, 'Software Development Engineer'],
  [/\bdev\b/gi, 'Developer'],
  [/\beng\b/gi, 'Engineer'],
  [/\bmgr\b/gi, 'Manager'],
  [/\bqa\b/gi, 'QA'],
];

const SENIORITY_WORDS =
  /\b(senior|junior|lead|principal|staff|intern|trainee|apprentice|entry[- ]level|mid[- ]level|graduate|associate)\b/gi;

/** Location / remote / hiring notes that decorate a title but are not part of the role. */
const DECORATION = [
  /\((?:[^)]*\b(?:remote|hybrid|on-?site|contract|full[- ]time|part[- ]time|m\/f\/?d?|f\/m\/?d?|all genders|urgent|hiring|immediate|openings?)\b[^)]*)\)/gi,
  /\[[^\]]*\]/g,
  /\s[-–|@]\s(?:remote|hybrid|on-?site|urgent|immediate|hiring)\b.*$/i,
];

const titleCase = (value: string) =>
  value
    .split(' ')
    .map((word) =>
      /^[A-Z0-9/+#.&-]{2,}$/.test(word) || /\d/.test(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');

/** "Sr. Backend Dev (Remote)" → "Backend Developer". Seniority is reported separately. */
export function normalizeTitleRules(title: string): string {
  let t = ` ${title} `;
  for (const re of DECORATION) t = t.replace(re, ' ');
  for (const [re, replacement] of ABBREVIATIONS) t = t.replace(re, replacement);
  t = t.replace(SENIORITY_WORDS, ' ');
  t = t.replace(/\s+(?:I{1,3}|IV|V)\s*$/i, ' ').replace(/\s+level\s+[1-5]\s*$/i, ' ');
  t = t.replace(/[,;:/\\-]+\s*$/g, '').replace(/^\s*[,;:/\\-]+/g, '');
  t = clip(t, 120);
  return t ? titleCase(t) : clip(title, 120);
}

const NON_SENIORITY_MANAGER =
  /\b(product|project|program|programme|account|customer success|community|social media|content|office|brand|campaign)\s+manager\b/i;

/** Seniority stated in the TITLE. The description is never used to guess it. */
export function detectSeniority(title: string): Seniority {
  const t = title.toLowerCase();
  if (/\b(intern|internship|trainee|apprentice)\b/.test(t)) return 'INTERN';
  if (/\b(chief|c[etfio]o|vp|vice president|svp|evp|president)\b/.test(t)) return 'EXECUTIVE';
  if (/\bdirector\b/.test(t) || /\bhead of\b/.test(t)) return 'DIRECTOR';
  if (/\b(manager|management)\b/.test(t) && !NON_SENIORITY_MANAGER.test(t)) return 'MANAGER';
  if (/\b(lead|principal|staff|architect)\b/.test(t)) return 'LEAD';
  if (/\b(senior|sr\.?|snr)(?=\W|$)/.test(t) || /\s(?:iii|iv)\s*$/.test(t)) return 'SENIOR';
  if (/\b(junior|jr\.?|entry[- ]level|graduate|associate)(?=\W|$)/.test(t)) return 'JUNIOR';
  if (/\bmid[- ]level\b|\bintermediate\b/.test(t) || /\sii\s*$/.test(t)) return 'MID';
  return 'UNKNOWN';
}

// ------------------------------------------------------------------ role category

const CATEGORY_RULES: [RoleCategory, RegExp][] = [
  ['SECURITY', /\b(security|cyber|penetration|infosec|soc analyst)\b/i],
  ['QA_TESTING', /\b(qa|quality assurance|test(?:er|ing)?|sdet|automation engineer)\b/i],
  [
    'DEVOPS_INFRASTRUCTURE',
    /\b(devops|sre|site reliability|infrastructure|platform engineer|cloud engineer|systems? administrator|sysadmin|release engineer)\b/i,
  ],
  [
    'DATA_AI',
    /\b(data|machine learning|ml|ai|artificial intelligence|analytics|bi|business intelligence|nlp|scientist|statistician)\b/i,
  ],
  ['DESIGN', /\b(designer|design|ux|ui|creative director|illustrator|animator|graphic)\b/i],
  [
    'PROJECT_MANAGEMENT',
    /\b(project manager|program manager|scrum master|delivery manager|project coordinator)\b/i,
  ],
  ['PRODUCT', /\b(product (?:manager|owner|analyst|lead)|product management)\b/i],
  [
    'SOFTWARE_ENGINEERING',
    /\b(software|developer|programmer|engineer|backend|back-end|frontend|front-end|full[- ]?stack|web|mobile|android|ios|java|python|node|react|\.net|php|golang|embedded|firmware|application)\b/i,
  ],
  [
    'CUSTOMER_SUPPORT',
    /\b(customer (?:support|service|success)|support (?:agent|specialist|representative)|call cent(?:er|re)|help ?desk)\b/i,
  ],
  [
    'IT_SUPPORT',
    /\b(it support|technical support|desktop support|network (?:engineer|administrator))\b/i,
  ],
  ['MARKETING', /\b(marketing|seo|growth|brand|social media|ppc|campaign|community manager)\b/i],
  ['CONTENT_WRITING', /\b(writer|copywriter|editor|content (?:creator|strategist|specialist))\b/i],
  ['SALES', /\b(sales|business development|account executive|account manager|bdm|bdr|sdr)\b/i],
  [
    'HUMAN_RESOURCES',
    /\b(hr|human resources?|recruit(?:er|ment)|talent acquisition|people (?:operations|partner))\b/i,
  ],
  [
    'FINANCE_ACCOUNTING',
    /\b(account(?:ant|ing)|finance|financial|auditor|audit|bookkeeper|payroll|tax)\b/i,
  ],
  ['LEGAL', /\b(legal|lawyer|counsel|paralegal|compliance)\b/i],
  [
    'OPERATIONS',
    /\b(operations|logistics|supply chain|procurement|administrator|admin|coordinator|office)\b/i,
  ],
];

/** Role family from the (normalized) title; null when no rule fits. */
export function classifyRoleRules(title: string): RoleCategory | null {
  for (const [category, re] of CATEGORY_RULES) if (re.test(title)) return category;
  return null;
}

// ------------------------------------------------------------------ description structure

export type Section = 'REQUIRED' | 'PREFERRED' | 'OTHER' | 'NONE';

const H_PREFERRED =
  /\b(preferred|nice[- ]to[- ]have|bonus|good to have|desirable|desired|a plus|advantage|extra credit|would be great)\b/i;
const H_REQUIRED =
  /\b(requirements?|qualifications?|what you(?:'|’)?ll need|what we(?:'|’)?re looking for|must[- ]have|you have|about you|your profile|who you are|skills|essential|minimum|basic|experience|expertise|tech(?:nical)? stack|competenc)/i;
const H_OTHER =
  /\b(responsibilit|what you(?:'|’)?ll do|about (?:the )?(?:role|us|company|team)|benefits|perks|we offer|how to apply|the role|duties|why join|our (?:mission|culture|values)|what we offer|equal opportunity)\b/i;

export interface Line {
  text: string;
  section: Section;
}

const isHeading = (line: string) => {
  const t = line.replace(/^[\s#*_>-]+|[\s*_:]+$/g, '');
  return (
    t.length > 0 &&
    t.length <= 70 &&
    (/:\s*$/.test(line.trim()) || !/[.!?]$/.test(t)) &&
    !/^[-•*·]/.test(line.trim())
  );
};

/** Split a description into lines tagged with the section heading they sit under. */
export function structureDescription(description: string | null): Line[] {
  if (!description) return [];
  const lines: Line[] = [];
  let section: Section = 'NONE';
  for (const raw of description.split(/\n+/)) {
    const text = raw.replace(/^[\s•*·\-–]+/, '').trim();
    if (!text) continue;
    if (isHeading(raw) && raw.trim().length <= 70) {
      if (H_PREFERRED.test(text)) {
        section = 'PREFERRED';
        continue;
      }
      if (H_OTHER.test(text)) {
        section = 'OTHER';
        continue;
      }
      if (H_REQUIRED.test(text)) {
        section = 'REQUIRED';
        continue;
      }
    }
    lines.push({ text: clip(text, 400), section });
  }
  return lines;
}

const CUE_PREFERRED = H_PREFERRED;
const CUE_REQUIRED =
  /\b(required|must|essential|proficien|strong|solid|hands[- ]on|experience (?:with|in|using)|knowledge of|expertise|working knowledge|ability to)\b/i;

// ------------------------------------------------------------------ skills

/**
 * Skills the posting asks for. REQUIRED when named in the title, a requirements-style section, an
 * unstructured posting, or with a requirement cue; PREFERRED when under a "nice to have" heading
 * or with a preference cue. Skills that only appear under "responsibilities" / "about us" are
 * not requirements and are not reported.
 */
export function extractSkillsRules(title: string, description: string | null): SkillItem[] {
  const out = new Map<string, SkillItem>();
  const add = (key: string, name: string, kind: SkillItem['kind'], evidence: string) => {
    const existing = out.get(key);
    // REQUIRED wins over PREFERRED when both are stated.
    if (existing && (existing.kind === 'REQUIRED' || kind === 'PREFERRED')) return;
    out.set(key, { key, name, kind, evidence: clip(evidence, 200), source: 'RULES' });
  };

  for (const s of findSkillsInText(title)) add(s.key, s.name, 'REQUIRED', title);

  const lines = structureDescription(description);
  for (const line of lines) {
    const skills = findSkillsInText(line.text);
    if (skills.length === 0) continue;
    let kind: SkillItem['kind'] | null = null;
    if (CUE_PREFERRED.test(line.text) || line.section === 'PREFERRED') kind = 'PREFERRED';
    else if (line.section === 'REQUIRED') kind = 'REQUIRED';
    else if (line.section === 'NONE')
      kind = 'REQUIRED'; // an unstructured posting: what it names, it asks for
    else if (CUE_REQUIRED.test(line.text)) kind = 'REQUIRED'; // OTHER section but phrased as a requirement
    if (!kind) continue;
    for (const s of skills) add(s.key, s.name, kind, line.text);
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ experience

export interface ExperienceMention {
  text: string;
  minYears: number;
  maxYears: number | null;
  mandatory: boolean;
  section: Section;
}

const RANGE = /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i;
const AT_LEAST =
  /(?:at least|minimum(?: of)?|min\.?|over|more than)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i;
const PLUS = /(\d{1,2})\s*\+\s*(?:years?|yrs?)/i;
const PLAIN =
  /(\d{1,2})\s*(?:years?|yrs?)(?:['’]s?)?\s+(?:of\s+)?(?:(?:[\w/&-]+\s+){0,4})?(?:experience|exp\b)/i;
const EXPERIENCE_WORD = /\b(experience|exp\b|background|worked|working)\b/i;

/** "3-5 years", "5+ years of experience", "at least 2 years" — only when the sentence is about experience. */
export function extractExperienceMentions(description: string | null): ExperienceMention[] {
  const found: ExperienceMention[] = [];
  for (const line of structureDescription(description)) {
    if (!EXPERIENCE_WORD.test(line.text)) continue;
    let min: number | null = null;
    let max: number | null = null;
    const range = RANGE.exec(line.text);
    if (range) {
      min = Number(range[1]);
      max = Number(range[2]);
      if (max < min) [min, max] = [max, min];
    } else {
      const single = AT_LEAST.exec(line.text) ?? PLUS.exec(line.text) ?? PLAIN.exec(line.text);
      if (single) min = Number(single[1]);
    }
    if (min === null || min > 40) continue;
    found.push({
      text: line.text,
      minYears: min,
      maxYears: max !== null && max <= 40 ? max : null,
      mandatory: !(CUE_PREFERRED.test(line.text) || line.section === 'PREFERRED'),
      section: line.section,
    });
  }
  return found;
}

/** The posting's headline experience figure: the first mandatory mention, preferring requirement sections. */
export function headlineExperience(
  mentions: ExperienceMention[],
): { minYears: number; maxYears: number | null } | null {
  const mandatory = mentions.filter((m) => m.mandatory);
  const pick = mandatory.find((m) => m.section === 'REQUIRED') ?? mandatory[0];
  return pick ? { minYears: pick.minYears, maxYears: pick.maxYears } : null;
}

// ------------------------------------------------------------------ education

const EDUCATION_PATTERNS: [EducationLevel, RegExp][] = [
  ['DOCTORATE', /\b(ph\.?d\.?|doctorate|doctoral)\b/i],
  ['MASTER', /\b(master(?:'|’)?s?|m\.?sc\.?|m\.?s\.?(?= (?:degree|in))|mba|m\.?phil|m\.?eng)\b/i],
  [
    'BACHELOR',
    /\b(bachelor(?:'|’)?s?|b\.?sc\.?|b\.?s\.?(?= (?:degree|in))|b\.?e\.?(?= (?:degree|in))|b\.?tech|bs ?cs|bscs|undergraduate degree|university degree|college degree|degree in)\b/i,
  ],
  ['DIPLOMA', /\b(diploma|associate degree|dae)\b/i],
  [
    'HIGH_SCHOOL',
    /\b(high school|secondary school|matric(?:ulation)?|intermediate certificate|fsc|a[- ]levels?)\b/i,
  ],
];
const LEVEL_RANK: Record<EducationLevel, number> = {
  HIGH_SCHOOL: 0,
  DIPLOMA: 1,
  BACHELOR: 2,
  MASTER: 3,
  DOCTORATE: 4,
};
const EDUCATION_CONTEXT =
  /\b(degree|diploma|bachelor|master|ph\.?d|education|graduate|qualification|b\.?sc|m\.?sc|mba|b\.?tech|matric|high school|bs ?cs)/i;

export function extractEducationRules(description: string | null): RequirementItem[] {
  const out: RequirementItem[] = [];
  for (const line of structureDescription(description)) {
    if (!EDUCATION_CONTEXT.test(line.text)) continue;
    const levels = EDUCATION_PATTERNS.filter(([, re]) => re.test(line.text)).map(
      ([level]) => level,
    );
    if (levels.length === 0) continue;
    // "Bachelor's or Master's" asks for the lower level.
    const level = levels.reduce((a, b) => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b));
    out.push({
      kind: 'EDUCATION',
      text: line.text,
      mandatory: !(CUE_PREFERRED.test(line.text) || line.section === 'PREFERRED'),
      minYears: null,
      maxYears: null,
      level,
      source: 'RULES',
    });
  }
  return out.slice(0, 5);
}

// ------------------------------------------------------------------ salary

const CURRENCY_TOKEN = '(?:USD|EUR|GBP|PKR|INR|AED|SAR|CAD|AUD|CHF|SGD|\\$|€|£|₹|Rs\\.?|PKR|US\\$)';
const AMOUNT = '(\\d{1,3}(?:[,\\s]\\d{3})+|\\d+(?:\\.\\d+)?)\\s*(k|K)?';
const SALARY_RE = new RegExp(
  `(${CURRENCY_TOKEN})\\s?${AMOUNT}(?:\\s*(?:-|–|—|to)\\s*(?:${CURRENCY_TOKEN})?\\s?${AMOUNT})?(?!\\d)`,
  'i',
);
const SALARY_CONTEXT =
  /\b(salary|compensation|pay|wage|base|remuneration|package|ctc|stipend|per\s+(?:hour|day|week|month|year|annum)|annual|monthly|hourly|\/\s*(?:hr|hour|day|week|mo|month|yr|year)|p\.a\.|per annum)\b/i;
const SCALE_WORD = /^\s*(?:m\b|mn\b|million|billion|bn\b|b\b)/i;

const SYMBOL_CURRENCY: Record<string, string> = { '€': 'EUR', '£': 'GBP', '₹': 'INR', us$: 'USD' };

function periodOf(text: string): SalaryPeriod | null {
  const t = text.toLowerCase();
  if (/(per|\/|a)\s*(hour|hr)\b|\bhourly\b/.test(t)) return 'HOUR';
  if (/(per|\/|a)\s*day\b|\bdaily\b/.test(t)) return 'DAY';
  if (/(per|\/|a)\s*week\b|\bweekly\b/.test(t)) return 'WEEK';
  if (/(per|\/|a)\s*(month|mo)\b|\bmonthly\b/.test(t)) return 'MONTH';
  if (/(per|\/|a)\s*(year|yr|annum)\b|\bannual(?:ly)?\b|\bp\.a\.|\bannum\b/.test(t)) return 'YEAR';
  return null;
}

const toNumber = (digits: string, k: string | undefined): number | null => {
  const n = Number(digits.replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(k ? n * 1000 : n);
};

/** A salary only when the posting publishes one: an explicit currency, an amount and salary context. */
export function extractSalaryRules(description: string | null): SalaryInfo | null {
  for (const line of structureDescription(description)) {
    const m = SALARY_RE.exec(line.text);
    if (!m) continue;
    const after = line.text.slice(m.index + m[0].length);
    if (SCALE_WORD.test(after)) continue; // "$5 million in funding"
    const period = periodOf(line.text);
    if (!SALARY_CONTEXT.test(line.text) && !period) continue;
    // "100-120k": the unit applies to both ends.
    const unit = m[3] ?? m[5];
    const a = toNumber(m[2]!, unit);
    const high = m[4] ? toNumber(m[4], unit) : null;
    if (a === null) continue;
    const min = Math.min(a, high ?? a);
    const max = Math.max(a, high ?? a);
    const token = m[1]!.replace(/\.$/, '');
    const currency =
      SYMBOL_CURRENCY[token.toLowerCase()] ??
      (/^[A-Za-z]{3}$/.test(token) ? token.toUpperCase() : token);
    return {
      min,
      max: high === null ? null : max,
      currency,
      period,
      text: clip(line.text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 30), 160),
    };
  }
  return null;
}

// ------------------------------------------------------------------ lookups used by matching

const ROLE_SYNONYMS: Record<string, string> = {
  developer: 'engineer',
  programmer: 'engineer',
  dev: 'engineer',
  swe: 'software engineer',
  frontend: 'front end',
  'front-end': 'front end',
  backend: 'back end',
  'back-end': 'back end',
  fullstack: 'full stack',
  'full-stack': 'full stack',
  js: 'javascript',
  ml: 'machine learning',
  qa: 'quality assurance',
  sde: 'software engineer',
  ui: 'ux',
};
const STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'for', 'in', 'at', '&', '-', 'to']);

/** Role words with synonyms collapsed, for comparing "Backend Developer" with "Back-End Engineer". */
export function roleTokens(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(SENIORITY_WORDS, ' ')
    .replace(/[(),/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    const mapped = ROLE_SYNONYMS[word] ?? word;
    for (const part of mapped.split(' ')) {
      const stem = part.length > 3 ? part.replace(/(ing|ers?|s)$/, '') : part;
      if (stem && !STOP.has(stem)) out.push(stem);
    }
  }
  return [...new Set(out)];
}
