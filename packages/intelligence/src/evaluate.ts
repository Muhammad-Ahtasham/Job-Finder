import { RULES_META } from './ai/provider';
import { PROMPT_VERSIONS, type JobAi } from './ai/tasks';
import { hashOf } from './hash';
import {
  computeMatch,
  matchInputHash,
  type MatchJob,
  type MatchPreferences,
  type MatchProject,
  type MatchResult,
} from './matching';
import { normalizeSkillList } from './skills';
import type { AiMeta, AnalysisSource } from './types';

/** What an earlier evaluation of the same (project, job) stored. */
export interface PreviousMatch {
  inputHash: string;
  semanticHash: string | null;
  semanticScore: number | null;
}

export interface EvaluatedMatch {
  inputHash: string;
  semanticHash: string | null;
  semanticScore: number | null;
  result: MatchResult;
  explanation: string;
  explanationSource: AnalysisSource;
  meta: AiMeta;
  notes: string[];
}

export type Evaluation = { reused: true } | ({ reused: false } & EvaluatedMatch);

/**
 * Score one job for one project. Repeatable by construction:
 *  - the score is a pure function of the inputs (computeMatch);
 *  - the only non-deterministic input, the AI role similarity, is stored with the hash of ITS
 *    inputs and reused while they are unchanged — so changing weights or preferences never
 *    re-asks the model, and re-running an unchanged match is a no-op (`reused: true`).
 */
export async function evaluateMatch(input: {
  job: MatchJob;
  /** Description excerpt used only for the AI role judgement. */
  jobDescription: string | null;
  project: MatchProject;
  preferences: MatchPreferences;
  analysisConfidence: number;
  ai?: JobAi | null;
  previous?: PreviousMatch | null;
}): Promise<Evaluation> {
  const { job, project, preferences, previous } = input;
  const ai = input.ai ?? null;
  const roles = project.targetRoles.map((r) => r.trim()).filter(Boolean);
  const notes: string[] = [];

  const semanticKey =
    ai && roles.length > 0
      ? hashOf({
          task: 'semantic',
          roles,
          title: job.normalizedTitle ?? job.title,
          category: job.roleCategory,
          skills: job.skills.map((s) => s.key).sort(),
          analysisHash: job.analysisHash,
          provider: ai.provider.id,
          model: ai.provider.model,
          prompt: PROMPT_VERSIONS.semanticMatching,
        })
      : null;

  const expectedHash = matchInputHash({ job, project, preferences, semanticKey });
  if (previous && previous.inputHash === expectedHash) return { reused: true };

  // ---- the AI role similarity (reused when its own inputs are unchanged)
  let semanticScore: number | null = null;
  let semanticHash: string | null = null;
  let aiUsed = false;
  if (ai && semanticKey) {
    if (previous?.semanticHash === semanticKey && previous.semanticScore !== null) {
      semanticScore = previous.semanticScore;
      semanticHash = semanticKey;
      aiUsed = true;
    } else {
      const answer = await ai.semanticMatch({
        targetRoles: roles,
        job: {
          title: job.normalizedTitle ?? job.title,
          description: input.jobDescription,
          skills: job.skills.map((s) => s.name),
        },
      });
      if (answer.ok) {
        semanticScore = answer.data.similarity;
        semanticHash = semanticKey;
        aiUsed = true;
      } else notes.push(`semantic matching: ${answer.reason}`);
    }
  }

  const result = computeMatch({
    job,
    project,
    preferences,
    semantic: semanticScore !== null ? { similarity: semanticScore } : null,
    analysisConfidence: input.analysisConfidence,
  });

  // ---- explanation: the deterministic one always exists; an AI one replaces it only if valid
  let explanation = result.explanation;
  let explanationSource: AnalysisSource = 'RULES';
  let explainedByAi = false;
  if (ai && result.confidence > 0) {
    const answer = await ai.explainMatch(result.facts, result.allowedNumbers);
    if (answer.ok) {
      explanation = answer.data;
      explanationSource = 'AI';
      explainedByAi = true;
    } else notes.push(`match explanation: ${answer.reason}`);
  }

  const versions = [
    ...(aiUsed ? [PROMPT_VERSIONS.semanticMatching] : []),
    ...(explainedByAi ? [PROMPT_VERSIONS.matchExplanation] : []),
  ];
  const meta: AiMeta =
    ai && versions.length > 0
      ? { provider: ai.provider.id, model: ai.provider.model, promptVersion: versions.join(',') }
      : RULES_META;

  return {
    reused: false,
    // When the AI was wanted but failed, store the hash of what was ACTUALLY computed so the
    // next pass sees a mismatch and tries again.
    inputHash: matchInputHash({ job, project, preferences, semanticKey: semanticHash }),
    semanticHash,
    semanticScore,
    result,
    explanation,
    explanationSource,
    meta,
    notes,
  };
}

/** Skill keys of a project's explicit skill list (used by callers that build hashes of their own). */
export const projectSkillKeys = (skills: string[]): string[] =>
  normalizeSkillList(skills).map((s) => s.key);
