import { FsObjectStorage } from './fs-storage';
import { S3ObjectStorage } from './s3-storage';
import type { ObjectStorage, StorageConfig } from './types';

export * from './types';
export { FsObjectStorage } from './fs-storage';
export { S3ObjectStorage } from './s3-storage';

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  return config.driver === 's3'
    ? new S3ObjectStorage(config)
    : new FsObjectStorage(config.directory);
}
