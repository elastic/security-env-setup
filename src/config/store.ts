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

function replaceFileSync(sourcePath: string, destinationPath: string): void {
  try {
    fs.renameSync(sourcePath, destinationPath);
    return;
  } catch (error) {
    const renameError = error as NodeJS.ErrnoException;
    const destinationExists =
      renameError.code === 'EEXIST' ||
      renameError.code === 'EPERM' ||
      renameError.code === 'EACCES';

    if (process.platform !== 'win32' || !destinationExists || !fs.existsSync(destinationPath)) {
      throw error;
    }
  }

  try {
    fs.unlinkSync(destinationPath);
  } catch (error) {
    const unlinkError = error as NodeJS.ErrnoException;
    if (unlinkError.code !== 'ENOENT') {
      throw new Error(
        `Failed to replace existing config file at ${destinationPath} on Windows: ${unlinkError.message}`,
      );
    }
  }

  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    const renameError = error as NodeJS.ErrnoException;
    try {
      fs.copyFileSync(sourcePath, destinationPath);
      fs.unlinkSync(sourcePath);
    } catch {
      throw new Error(
        `Failed to replace config file at ${destinationPath} on Windows after rename fallback: ${renameError.message}`,
      );
    }
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
    replaceFileSync(tempFile, CONFIG_FILE);
    renamed = true;

    // Explicitly enforce owner-only permissions even if the destination already existed.
    tryChmodSync(CONFIG_FILE, 0o600);
  } finally {
    if (!renamed && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

export function getAllApiKeys(): Partial<Record<Environment, string>> {
  return { ...readStore().apiKeys };
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

/**
 * Removes the API key for the given environment.
 * Returns `true` if a key was present and deleted, `false` if nothing was stored.
 */
export function clearApiKey(env: Environment): boolean {
  const store = readStore();
  if (store.apiKeys[env] === undefined) return false;

  const apiKeys = Object.fromEntries(
    Object.entries(store.apiKeys).filter(([key]) => key !== env),
  ) as Partial<Record<Environment, string>>;

  writeStore({ ...store, apiKeys });
  return true;
}
