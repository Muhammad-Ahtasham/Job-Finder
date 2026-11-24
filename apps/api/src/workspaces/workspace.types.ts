import type { WorkspaceRole } from '@jobfinder/contracts';

/** The workspace a request operates in, resolved (and membership-checked) by WorkspaceGuard. */
export interface WorkspaceContext {
  id: string;
  role: WorkspaceRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspace?: WorkspaceContext;
    }
  }
}

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};
