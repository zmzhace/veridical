import { describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../src/production/object-store';

describe('S3ObjectStore', () => {
  it('stores content hash metadata and verifies reads', async () => {
    const objects = new Map<string, { body: Uint8Array; metadata?: Record<string, string> }>();
    const fake = {
      send: async (command: any) => {
        const input = command.input;
        if (command.constructor.name === 'PutObjectCommand') {
          objects.set(input.Key, { body: input.Body, metadata: input.Metadata });
          return {};
        }
        if (command.constructor.name === 'GetObjectCommand') {
          const item = objects.get(input.Key)!;
          return { Metadata: item.metadata, Body: { transformToByteArray: async () => item.body } };
        }
        if (command.constructor.name === 'HeadObjectCommand')
          return { Metadata: objects.get(input.Key)?.metadata };
        if (command.constructor.name === 'HeadBucketCommand') return {};
        objects.delete(input.Key);
        return {};
      },
    } as any;
    const store = new S3ObjectStore(
      { endpoint: 'http://s3.local', bucket: 'test', accessKey: 'a', secretKey: 'b' },
      fake,
    );
    const body = new TextEncoder().encode('artifact');
    await expect(store.put('release/a', body, 'text/plain')).resolves.toMatchObject({
      key: 'release/a',
      bytes: 8,
    });
    await expect(store.get('release/a')).resolves.toEqual(body);
    await expect(store.head('release/a')).resolves.toHaveProperty('Metadata.sha256');
    await expect(store.health()).resolves.toBe(true);
    await store.delete('release/a');
    await expect(store.get('release/a')).rejects.toThrow();
  });
  it('rejects unsafe object keys before making a request', async () => {
    const fake = {
      send: async () => {
        throw new Error('must_not_call');
      },
    } as any;
    const store = new S3ObjectStore(
      { endpoint: 'http://s3.local', bucket: 'test', accessKey: 'a', secretKey: 'b' },
      fake,
    );
    await expect(store.put('../escape', new Uint8Array())).rejects.toThrow('invalid_object_key');
    await expect(store.get('/absolute')).rejects.toThrow('invalid_object_key');
  });
});
