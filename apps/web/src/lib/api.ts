import {
  meResponseSchema,
  problemSchema,
  type LoginRequest,
  type MeResponse,
  type RegisterRequest,
} from '@jobfinder/contracts';

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

export async function fetchMe(): Promise<MeResponse | null> {
  try {
    const response = await request('/api/v1/auth/me');
    return meResponseSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function login(input: LoginRequest): Promise<MeResponse> {
  const response = await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return meResponseSchema.parse(await response.json());
}

export async function register(input: RegisterRequest): Promise<MeResponse> {
  const response = await request('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return meResponseSchema.parse(await response.json());
}

export async function logout(): Promise<void> {
  await request('/api/v1/auth/logout', { method: 'POST' });
}
