function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Prisma P2002: unique constraint violation. */
export const isUniqueViolation = (error: unknown): boolean => code(error) === 'P2002';
