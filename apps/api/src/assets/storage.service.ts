import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly directory: string;
  private readonly driver: 'local' | 's3';
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: ConfigService) {
    this.directory = resolve(config.get<string>('UPLOAD_DIR', '.data/uploads'));
    this.driver = config.get<string>('STORAGE_DRIVER', 'local') === 's3' ? 's3' : 'local';
    this.bucket = config.get<string>('S3_BUCKET', '');
    this.prefix = config.get<string>('S3_PREFIX', 'net-assets').replace(/^\/+|\/+$/g, '');
    if (this.driver === 's3' && !this.bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3.');
    this.s3 = this.driver === 's3' ? new S3Client({
      region: config.get<string>('S3_REGION', 'us-east-1'),
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE', 'false') === 'true',
    }) : null;
  }

  async onModuleInit() { if (this.driver === 'local') await mkdir(this.directory, { recursive: true }); }

  async put(key: string, bytes: Buffer) {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: bytes }));
      return;
    }
    await writeFile(this.filePath(key), bytes, { flag: 'wx' });
  }

  async get(key: string) {
    if (this.s3) {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      if (!response.Body) throw new Error('Object body is empty.');
      return Buffer.from(await response.Body.transformToByteArray());
    }
    return readFile(this.filePath(key));
  }

  async exists(key: string) {
    if (this.s3) {
      try {
        await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
        return true;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return false;
        throw error;
      }
    }
    try { await access(this.filePath(key)); return true; } catch { return false; }
  }

  async delete(key: string) {
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return;
    }
    await unlink(this.filePath(key)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  async deleteMany(keys: string[]) {
    const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
    return {
      deleted: keys.filter((_, index) => results[index].status === 'fulfilled'),
      failed: keys.filter((_, index) => results[index].status === 'rejected'),
    };
  }

  private filePath(key: string) { return resolve(this.directory, key); }
  private objectKey(key: string) { return this.prefix ? `${this.prefix}/${key}` : key; }
}
