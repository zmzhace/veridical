import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type ObjectStoreConfig = {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean;
};

/** S3-compatible immutable artifact store. Keys are content-addressed by callers. */
export class S3ObjectStore {
  private readonly client: S3Client;
  constructor(
    private readonly config: ObjectStoreConfig,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region ?? 'us-east-1',
        forcePathStyle: config.forcePathStyle ?? true,
        credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      });
  }
  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream') {
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('invalid_object_key');
    const digest = createHash('sha256').update(body).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256: digest },
      }),
    );
    return { key, sha256: digest, bytes: body.byteLength };
  }
  async get(key: string): Promise<Uint8Array> {
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('invalid_object_key');
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!response.Body) throw new Error('object_empty');
    const bytes = await response.Body.transformToByteArray();
    const expected = response.Metadata?.sha256;
    if (expected && expected !== createHash('sha256').update(bytes).digest('hex'))
      throw new Error('object_checksum_mismatch');
    return bytes;
  }
  async head(key: string) {
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('invalid_object_key');
    return this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
  async delete(key: string) {
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('invalid_object_key');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
