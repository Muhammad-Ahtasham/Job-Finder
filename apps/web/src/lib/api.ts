import {
  companyContactsResponseSchema,
  companyDetailSchema,
  companyDirectoryResponseSchema,
  companyReviewListResponseSchema,
  companyReviewSchema,
  companySourcesResponseSchema,
  dashboardSummarySchema,
  directoryFacetsSchema,
  enrichResponseSchema,
  jobDetailSchema,
  jobDirectoryResponseSchema,
  jobHistoryResponseSchema,
  jobRefreshResponseSchema,
  jobSourcesResponseSchema,
  matchListResponseSchema,
  matchPreferencesSchema,
  type UpdateMatchPreferencesRequest,
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
import { z, type ZodType } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';

const matchRefreshSchema = z.object({ queued: z.boolean() });

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
  // Every data call is scoped to the active workspace (default: the personal one).
  const workspaceId = getActiveWorkspaceId();
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      ...init.headers,
    },
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

// ---------------------------------------------------------------- directory (server-side tables)
export type Params = Record<string, string | number | boolean | undefined | null>;

/** Query string without empty values. */
export function qs(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const getDashboardSummary = () => json('/api/v1/dashboard/summary', dashboardSummarySchema);
export const getFacets = () => json('/api/v1/directory/facets', directoryFacetsSchema);

export const listCompanyDirectory = (query: Params) =>
  json(`/api/v1/directory/companies${qs(query)}`, companyDirectoryResponseSchema);

export const listJobDirectory = (query: Params) =>
  json(`/api/v1/directory/jobs${qs(query)}`, jobDirectoryResponseSchema);

/** Same-origin download link: the session cookie and workspace come with the browser request. */
export const exportUrl = (dataset: 'companies' | 'jobs', query: Params) =>
  `/api/v1/exports/${dataset}.csv${qs(query)}`;

// ---------------------------------------------------------------- company profile
export const getCompanySources = (id: string) =>
  json(`/api/v1/companies/${id}/sources`, companySourcesResponseSchema);
export const getCompanyContacts = (id: string) =>
  json(`/api/v1/companies/${id}/contacts`, companyContactsResponseSchema);
export const getCompanyJobSources = (id: string) =>
  json(`/api/v1/companies/${id}/job-sources`, jobSourcesResponseSchema);
export const listWebsiteReviews = (id: string) =>
  json(`/api/v1/companies/${id}/website-reviews`, companyReviewListResponseSchema);
export const approveWebsiteReview = (id: string) =>
  json(`/api/v1/website-reviews/${id}/approve`, companyReviewSchema, post());
export const rejectWebsiteReview = (id: string) =>
  json(`/api/v1/website-reviews/${id}/reject`, companyReviewSchema, post());
export const enrichCompany = (id: string) =>
  json(`/api/v1/companies/${id}/enrich`, enrichResponseSchema, post());
export const refreshCompanyJobs = (id: string) =>
  json(`/api/v1/companies/${id}/jobs/refresh`, jobRefreshResponseSchema, post());

// ---------------------------------------------------------------- jobs and matches
export const getJob = (id: string) => json(`/api/v1/jobs/${id}`, jobDetailSchema);
export const getJobHistory = (id: string) =>
  json(`/api/v1/jobs/${id}/history?limit=100`, jobHistoryResponseSchema);
export const listMatches = (projectId: string, query: Params) =>
  json(`/api/v1/projects/${projectId}/matches${qs(query)}`, matchListResponseSchema);
export const getMatchPreferences = (projectId: string) =>
  json(`/api/v1/projects/${projectId}/matching-preferences`, matchPreferencesSchema);
export const updateMatchPreferences = (projectId: string, input: UpdateMatchPreferencesRequest) =>
  json(`/api/v1/projects/${projectId}/matching-preferences`, matchPreferencesSchema, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
export const refreshMatches = (projectId: string) =>
  json(`/api/v1/projects/${projectId}/matches/refresh`, matchRefreshSchema, post());

export { createProjectRequestSchema };
