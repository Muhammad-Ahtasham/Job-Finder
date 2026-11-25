import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { assertSafeKey, StorageNotFoundError, type ObjectStorage } from './types';

/** Local-disk driver for development and single-host installs. */
export class FsObjectStorage implements ObjectStorage {
  readonly driver = 'fs' as const;
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  /** The absolute path of a key, guaranteed to stay inside the root. */
  private path(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.root, key);
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Readable, _options?: { contentType: string }): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Write beside the target and rename: a reader never sees a half-written file.
    const temp = join(dirname(target), `.${randomUUID()}.part`);
    try {
      await pipeline(body, createWriteStream(temp, { mode: 0o600 }));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<{ stream: Readable; size: number | null }> {
    const target = this.path(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new StorageNotFoundError(key);
      return { stream: createReadStream(target), size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
