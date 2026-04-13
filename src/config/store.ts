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

const CONFIG_DIR = path.join(os.homedir(), '.security-env-setup');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function readStore(): StoreData {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (isStoreData(raw)) {
      return raw;
    }
  } catch {
    // file missing or malformed — start fresh
  }
  return { apiKeys: {} };
}

function writeStore(data: StoreData): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // mode 0o600: owner read/write only — never expose keys to other users
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getApiKey(env: Environment): string | undefined {
  return readStore().apiKeys[env];
}

export function setApiKey(env: Environment, key: string): void {
  const store = readStore();
  store.apiKeys[env] = key;
  writeStore(store);
}

export function hasApiKey(env: Environment): boolean {
  return readStore().apiKeys[env] !== undefined;
}

export function clearApiKey(env: Environment): void {
  const store = readStore();
  store.apiKeys = { ...store.apiKeys, [env]: undefined };
  writeStore(store);
}
