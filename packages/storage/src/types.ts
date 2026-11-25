import type { Readable } from 'node:stream';

/**
 * Object storage: opaque keys, immutable blobs. Files never go through the database, and a
 * storage key is never handed to a user (downloads are streamed by the API after authorisation).
 */
export interface ObjectStorage {
  readonly driver: 'fs' | 's3';
  /** Stores the body under `key`, replacing anything there. */
  put(key: string, body: Readable, options: { contentType: string }): Promise<void>;
  /** Streams an object. Throws StorageNotFoundError when it does not exist. */
  get(key: string): Promise<{ stream: Readable; size: number | null }>;
  /** Deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/** Keys are short relative paths of safe characters: no traversal, no absolute paths. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.\-/]{0,254}$/;

export function assertSafeKey(key: string): void {
  if (
    !KEY.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Invalid storage key');
  }
}

export interface S3StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most S3-compatible servers need path-style addressing. */
  forcePathStyle: boolean;
}

export type StorageConfig =
  { driver: 'fs'; directory: string } | ({ driver: 's3' } & S3StorageConfig);
