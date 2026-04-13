/**
 * Persistent config store backed by ~/.security-env-setup/config.json.
 * conf@12 is ESM-only and incompatible with "module": "commonjs", so we
 * implement equivalent functionality directly with fs primitives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Environment } from '../types';

interface StoreData {
  apiKeys: Partial<Record<Environment, string>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoreData(value: unknown): value is StoreData {
  if (!isPlainObject(value) || !('apiKeys' in value) || !isPlainObject(value.apiKeys)) {
    return false;
  }

  return Object.values(value.apiKeys).every((apiKey) => typeof apiKey === 'string');
}

function tryChmodSync(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EINVAL' || code === 'ENOSYS') {
      return;
    }
    throw error;
  }
}

const CONFIG_DIR = path.join(os.homedir(), '.security-env-setup');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function readStore(): StoreData {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (isStoreData(raw)) {
      return raw;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || error instanceof SyntaxError) {
      // file missing or malformed JSON — start fresh
      return { apiKeys: {} };
    }
    throw error;
  }
  return { apiKeys: {} };
}

function writeStore(data: StoreData): void {
  // Ensure the config directory exists and is not accessible to other users.
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  tryChmodSync(CONFIG_DIR, 0o700);

  // Write to a temporary file in the same directory and atomically replace the
  // destination to avoid leaving a truncated/corrupt config if interrupted.
  const serialized = JSON.stringify(data, null, 2);
  const tempFile = path.join(
    CONFIG_DIR,
    `config.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let renamed = false;

  try {
    fs.writeFileSync(tempFile, serialized, { mode: 0o600 });
    tryChmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, CONFIG_FILE);
    renamed = true;

    // Explicitly enforce owner-only permissions even if the destination already existed.
    tryChmodSync(CONFIG_FILE, 0o600);
  } finally {
    if (!renamed && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

export function getApiKey(env: Environment): string | undefined {
  return readStore().apiKeys[env];
}

export function setApiKey(env: Environment, key: string): void {
  if (key.trim().length === 0) {
    throw new Error('API key must be a non-empty string.');
  }

  const store = readStore();
  store.apiKeys[env] = key;
  writeStore(store);
}

export function hasApiKey(env: Environment): boolean {
  const apiKey = readStore().apiKeys[env];
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

export function clearApiKey(env: Environment): void {
  const store = readStore();
  const apiKeys = Object.fromEntries(
    Object.entries(store.apiKeys).filter(([key]) => key !== env),
  ) as Partial<Record<Environment, string>>;

  writeStore({ ...store, apiKeys });
}
