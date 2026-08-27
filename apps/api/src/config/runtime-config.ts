import type { ConfigService } from '@nestjs/config';

export function configInteger(
  config: ConfigService,
  key: string,
  fallback: number,
  range: { min: number; max: number },
) {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${key} must be an integer from ${range.min} to ${range.max}.`);
  }
  return value;
}

export function configBoolean(config: ConfigService, key: string, fallback: boolean) {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new Error(`${key} must be true or false.`);
}
