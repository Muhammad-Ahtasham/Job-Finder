import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { PasswordService } from '../src/auth/password.service';
import { SessionService } from '../src/auth/session.service';
import { slugify } from '../src/workspaces/workspaces.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('correct-horse-battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await service.verify(hash, 'correct-horse-battery')).toBe(true);
    expect(await service.verify(hash, 'wrong')).toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password-1'),
      service.hash('same-password-1'),
    ]);
    expect(a).not.toBe(b);
  });

  it('treats malformed hashes as a failed verification', async () => {
    expect(await service.verify('not-a-hash', 'x')).toBe(false);
  });

  it('flags weaker hashes for rehash', async () => {
    const strong = await service.hash('some-password-123');
    const weak = await argon2.hash('some-password-123', {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 2,
      parallelism: 1,
    });
    expect(service.needsRehash(strong)).toBe(false);
    expect(service.needsRehash(weak)).toBe(true);
  });

  it('dummy verification completes without throwing', async () => {
    await expect(service.verifyAgainstDummy('anything')).resolves.toBeUndefined();
  });
});

describe('SessionService.hashToken', () => {
  it('is deterministic, hex, and not the token', () => {
    const hash = SessionService.hashToken('abc');
    expect(hash).toBe(SessionService.hashToken('abc'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('abc');
  });
});

describe('slugify', () => {
  it('produces url-safe slugs', () => {
    expect(slugify('Ahtasham Khan')).toBe('ahtasham-khan');
    expect(slugify('  Zoë  O’Neil!! ')).toBe('zoe-o-neil');
    expect(slugify('日本語')).toBe('workspace');
  });
});
