import { z } from 'zod';

/**
 * Mirror of the Prisma `WorkspaceRole` enum. The frontend cannot import the database
 * package, so the contract lives here; the API test-suite asserts the two stay in sync.
 */
export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspaceMembershipSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  isPersonal: z.boolean(),
  role: workspaceRoleSchema,
});
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceMembershipSchema),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
