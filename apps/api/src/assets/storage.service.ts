import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { del, get, head, put } from '@vercel/blob';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type StorageDriver = 'local' | 'blob';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly directory: string;
  private readonly driver: StorageDriver;
  private readonly prefix: string;

  constructor(config: ConfigService) {
    this.directory = resolve(config.get<string>('UPLOAD_DIR', '.data/uploads'));
    const configured = config.get<string>('STORAGE_DRIVER');
    this.driver = configured === 'blob' || (!configured && config.get<string>('BLOB_READ_WRITE_TOKEN')) ? 'blob' : 'local';
    if (process.env.NODE_ENV === 'production' && this.driver !== 'blob') {
      throw new Error('STORAGE_DRIVER=blob is required in production; local function storage is ephemeral.');
    }
    this.prefix = config.get<string>('BLOB_PREFIX', 'net-assets').replace(/^\/+|\/+$/g, '');
    if (this.driver === 'blob' && !config.get<string>('BLOB_READ_WRITE_TOKEN')) {
      throw new Error('BLOB_READ_WRITE_TOKEN is required when STORAGE_DRIVER=blob.');
    }
  }

  async onModuleInit() {
    if (this.driver === 'local') await mkdir(this.directory, { recursive: true });
  }

  async put(key: string, bytes: Buffer, contentType = 'application/octet-stream') {
    if (this.driver === 'blob') {
      await put(this.objectKey(key), bytes, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType,
        maximumSizeInBytes: 8 * 1024 * 1024,
      });
      return;
    }
    await writeFile(this.filePath(key), bytes, { flag: 'wx' });
  }

  async get(key: string) {
    if (this.driver === 'blob') {
      const result = await get(this.objectKey(key), { access: 'private' });
      if (!result || result.statusCode !== 200) throw new Error('Object body is empty.');
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    }
    return readFile(this.filePath(key));
  }

  async exists(key: string) {
    if (this.driver === 'blob') {
      try {
        await head(this.objectKey(key));
        return true;
      } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) return false;
        throw error;
      }
    }
    try { await access(this.filePath(key)); return true; } catch { return false; }
  }

  async delete(key: string) {
    if (this.driver === 'blob') {
      await del(this.objectKey(key));
      return;
    }
    await unlink(this.filePath(key)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  async deleteMany(keys: string[]) {
    if (this.driver === 'blob') {
      try {
        if (keys.length) await del(keys.map((key) => this.objectKey(key)));
        return { deleted: keys, failed: [] as string[] };
      } catch {
        const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
        return {
          deleted: keys.filter((_, index) => results[index].status === 'fulfilled'),
          failed: keys.filter((_, index) => results[index].status === 'rejected'),
        };
      }
    }
    const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
    return {
      deleted: keys.filter((_, index) => results[index].status === 'fulfilled'),
      failed: keys.filter((_, index) => results[index].status === 'rejected'),
    };
  }

  private filePath(key: string) { return resolve(this.directory, key); }
  private objectKey(key: string) { return this.prefix ? `${this.prefix}/${key}` : key; }
}
