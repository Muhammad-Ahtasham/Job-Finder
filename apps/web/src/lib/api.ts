import {
  companyDetailSchema,
  createProjectRequestSchema,
  discoveryResultListResponseSchema,
  matchReviewSchema,
  meResponseSchema,
  problemSchema,
  projectListResponseSchema,
  projectSchema,
  reviewListResponseSchema,
  runListResponseSchema,
  runProgressSchema,
  runSchema,
  type CreateProjectRequest,
  type LoginRequest,
  type MeResponse,
  type RegisterRequest,
} from '@jobfinder/contracts';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Same-origin calls: Next rewrites /api/* to the API, so the HttpOnly session cookie
 * is first-party. This module only transports data; all rules live in the API.
 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const problem = problemSchema.safeParse(await response.json().catch(() => null));
    const message = problem.success
      ? Array.isArray(problem.data.message)
        ? problem.data.message.join('\n')
        : problem.data.message
      : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return response;
}

async function json<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return schema.parse(await response.json());
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---------------------------------------------------------------- auth
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await json('/api/v1/auth/me', meResponseSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const login = (input: LoginRequest) =>
  json('/api/v1/auth/login', meResponseSchema, post(input));

export const register = (input: RegisterRequest) =>
  json('/api/v1/auth/register', meResponseSchema, post(input));

export async function logout(): Promise<void> {
  await request('/api/v1/auth/logout', { method: 'POST' });
}

// ---------------------------------------------------------------- discovery
export const listProjects = () => json('/api/v1/projects', projectListResponseSchema);

export const getProject = (id: string) => json(`/api/v1/projects/${id}`, projectSchema);

export const createProject = (input: CreateProjectRequest | Record<string, unknown>) =>
  json('/api/v1/projects', projectSchema, post(input));

export async function deleteProject(id: string): Promise<void> {
  await request(`/api/v1/projects/${id}`, { method: 'DELETE' });
}

export const listRuns = (projectId: string) =>
  json(`/api/v1/projects/${projectId}/runs`, runListResponseSchema);

export const startRun = (projectId: string) =>
  json(`/api/v1/projects/${projectId}/runs`, runSchema, post());

export const getRunProgress = (runId: string) =>
  json(`/api/v1/runs/${runId}/progress`, runProgressSchema);

export const cancelRun = (runId: string) => json(`/api/v1/runs/${runId}/cancel`, runSchema, post());

export const getRunResults = (runId: string, limit = 100) =>
  json(`/api/v1/runs/${runId}/results?limit=${limit}`, discoveryResultListResponseSchema);

export const getCompany = (id: string) => json(`/api/v1/companies/${id}`, companyDetailSchema);

export const listReviews = () => json('/api/v1/reviews?status=PENDING', reviewListResponseSchema);

export const mergeReview = (id: string) =>
  json(`/api/v1/reviews/${id}/merge`, companyDetailSchema, post());

export const dismissReview = (id: string) =>
  json(`/api/v1/reviews/${id}/dismiss`, matchReviewSchema, post());

export { createProjectRequestSchema };
