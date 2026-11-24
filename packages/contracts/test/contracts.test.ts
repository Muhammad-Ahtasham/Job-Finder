import { describe, expect, it } from 'vitest';
import { loginRequestSchema, registerRequestSchema, WORKSPACE_ROLES } from '../src';

describe('registerRequestSchema', () => {
  it('normalizes email and accepts a valid payload', () => {
    const parsed = registerRequestSchema.parse({
      email: '  Alice@Example.COM ',
      password: 'correct horse battery',
      name: ' Alice ',
    });
    expect(parsed.email).toBe('alice@example.com');
    expect(parsed.name).toBe('Alice');
  });

  it('rejects short passwords, bad emails and unknown fields', () => {
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.co', password: 'short', name: 'A' }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ email: 'nope', password: 'x'.repeat(20), name: 'A' })
        .success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({
        email: 'a@b.co',
        password: 'x'.repeat(20),
        name: 'A',
        role: 'OWNER',
      }).success,
    ).toBe(false);
  });

  it('rejects oversized passwords', () => {
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(129), name: 'A' })
        .success,
    ).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('does not enforce a minimum length', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });
});

describe('WORKSPACE_ROLES', () => {
  it('lists the four roles', () => {
    expect([...WORKSPACE_ROLES]).toEqual(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
  });
});
