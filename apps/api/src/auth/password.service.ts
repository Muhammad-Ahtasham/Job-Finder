import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id with the OWASP-recommended minimum profile (19 MiB, t=2, p=1).
 * Parameters are encoded in the hash, so they can be raised later; `needsRehash`
 * lets login transparently upgrade old hashes.
 */
const OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // Malformed hash etc. — treat as a failed verification, never as a crash.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, OPTIONS);
  }

  /**
   * Burn the same CPU as a real verification when the account does not exist, so
   * response time does not reveal which emails are registered.
   */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('jobfinder-dummy-password');
    await this.verify(await this.dummyHash, password);
  }
}
