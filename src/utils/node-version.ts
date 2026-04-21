import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NvmNodeVersion {
  /** Full version string as stored by nvm, e.g. "v24.15.0". */
  raw: string;
  /** Major version number, e.g. 24. */
  major: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves the nvm versions/node directory from the environment. */
function nvmVersionsDir(): string {
  const homeDir = process.env.HOME || os.homedir();
  const nvmDir = process.env.NVM_DIR ?? path.join(homeDir, '.nvm');
  return path.join(nvmDir, 'versions', 'node');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the nvm `versions/node/` directory and returns all installed Node
 * versions sorted newest-first (by full semver, descending). Returns an empty
 * array on any error so callers never need to handle filesystem failures.
 */
export async function listNvmNodeVersions(): Promise<readonly NvmNodeVersion[]> {
  try {
    const entries = await fs.promises.readdir(nvmVersionsDir());
    const versions: NvmNodeVersion[] = entries
      .filter((e) => e.startsWith('v'))
      .map((raw) => {
        const major = parseInt(raw.slice(1).split('.')[0] ?? '0', 10);
        return { raw, major };
      })
      .sort((a, b) => {
        const aParts = a.raw.slice(1).split('.').map(Number);
        const bParts = b.raw.slice(1).split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    return versions;
  } catch {
    return [];
  }
}

/**
 * Returns the first entry in `versions` whose major version is >= 24,
 * or `undefined` if none exists. Pure / synchronous.
 */
export function findNode24OrNewer(
  versions: readonly NvmNodeVersion[],
): NvmNodeVersion | undefined {
  return versions.find((v) => v.major >= 24);
}
