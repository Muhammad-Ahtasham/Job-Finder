import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsObjectStorage, StorageNotFoundError, assertSafeKey } from '../src';

let dir: string;
let storage: FsObjectStorage;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jf-storage-'));
  storage = new FsObjectStorage(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const read = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
};

describe('FsObjectStorage', () => {
  it('stores, streams and deletes objects', async () => {
    await storage.put('exports/ws/1.csv', Readable.from(['a,b\n', '1,2\n']), {
      contentType: 'text/csv',
    });
    const { stream, size } = await storage.get('exports/ws/1.csv');
    expect(await read(stream)).toBe('a,b\n1,2\n');
    expect(size).toBe(8);
    await storage.delete('exports/ws/1.csv');
    await expect(storage.get('exports/ws/1.csv')).rejects.toBeInstanceOf(StorageNotFoundError);
    await storage.delete('exports/ws/1.csv'); // deleting twice is fine
  });

  it('replaces an object atomically and leaves no partial files', async () => {
    await storage.put('x/a.txt', Readable.from(['one']), { contentType: 'text/plain' });
    await storage.put('x/a.txt', Readable.from(['two']), { contentType: 'text/plain' });
    expect(await readFile(join(dir, 'x/a.txt'), 'utf8')).toBe('two');
  });

  it('refuses keys that could escape the storage root', async () => {
    for (const key of [
      '../evil',
      'a/../../evil',
      '/etc/passwd',
      'a//b',
      'C:/x',
      '',
      '.hidden/../x',
      'a b',
    ]) {
      expect(() => assertSafeKey(key), key).toThrow();
      await expect(storage.get(key)).rejects.toThrow();
    }
  });
});
