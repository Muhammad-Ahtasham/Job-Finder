/**
 * The active workspace is a client preference: it is sent as `X-Workspace-Id` and the API
 * authorises it on every request (a workspace you do not belong to is refused). Without a
 * choice the API uses the personal workspace.
 */
const KEY = 'jf.workspace';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getActiveWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(KEY);
    return value && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function setActiveWorkspaceId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the personal workspace stays active */
  }
}
