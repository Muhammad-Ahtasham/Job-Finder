/** DI tokens for the discovery module (tests override these with fakes). */
export const DISCOVERY_PROVIDERS = Symbol('DISCOVERY_PROVIDERS');
export const NORMALIZER = Symbol('COMPANY_NORMALIZER');
export const DEDUPLICATOR = Symbol('COMPANY_DEDUPLICATOR');

/** Postgres advisory-lock key serializing all discovery/merge writes within one workspace. */
export const workspaceLockKey = (workspaceId: string) => `ws:${workspaceId}`;
export const runLockKey = (runId: string) => `run:${runId}`;
