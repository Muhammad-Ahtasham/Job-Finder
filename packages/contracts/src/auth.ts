import { z } from 'zod';
import { workspaceMembershipSchema } from './workspaces';

export const PASSWORD_MIN_LENGTH = 12;
// Upper bound protects the hasher from oversized-input DoS; 128 is generous for passphrases.
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1, 'Name is required').max(100),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  // No length policy on login: never leak the policy or reject legacy passwords.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

/** Returned by register, login and GET /auth/me. */
export const meResponseSchema = z.object({
  user: userSchema,
  workspaces: z.array(workspaceMembershipSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const problemSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.union([z.string(), z.array(z.string())]),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof problemSchema>;
