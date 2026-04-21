import fs from 'fs';
import os from 'os';

// Do NOT jest.mock('fs') — the auto-mocker leaves fs.promises as undefined.
// Instead spy on fs.promises.readdir directly so the real object is available.

import { listNvmNodeVersions, findNode24OrNewer } from '@utils/node-version';
import type { NvmNodeVersion } from '@utils/node-version';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIG_NVM_DIR = process.env.NVM_DIR;
const ORIG_HOME = process.env.HOME;

let readdirSpy: jest.SpyInstance;
let homedirSpy: jest.SpyInstance;

beforeEach(() => {
  readdirSpy = jest.spyOn(fs.promises, 'readdir');
  homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue('/home/os-user');
  process.env.NVM_DIR = '/test-nvm';
  process.env.HOME = '/home/testuser';
});

afterEach(() => {
  readdirSpy.mockRestore();
  homedirSpy.mockRestore();
  if (ORIG_NVM_DIR === undefined) {
    delete process.env.NVM_DIR;
  } else {
    process.env.NVM_DIR = ORIG_NVM_DIR;
  }
  if (ORIG_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIG_HOME;
  }
});

// ---------------------------------------------------------------------------
// listNvmNodeVersions
// ---------------------------------------------------------------------------

describe('listNvmNodeVersions', () => {
  it('returns parsed versions from the nvm versions/node directory', async () => {
    readdirSpy.mockResolvedValue(['v22.0.0', 'v24.0.0', 'v20.1.0'] as unknown as fs.Dirent[]);

    const result = await listNvmNodeVersions();

    expect(result).toHaveLength(3);
    expect(result.map((v) => v.raw)).toContain('v24.0.0');
  });

  it('filters out non-version entries (those not starting with v)', async () => {
    readdirSpy.mockResolvedValue(
      ['v22.0.0', 'README', '.DS_Store', 'v24.1.0'] as unknown as fs.Dirent[],
    );

    const result = await listNvmNodeVersions();

    expect(result).toHaveLength(2);
    expect(result.map((v) => v.raw)).toEqual(
      expect.arrayContaining(['v22.0.0', 'v24.1.0']),
    );
  });

  it('parses the major version correctly', async () => {
    readdirSpy.mockResolvedValue(['v24.15.3'] as unknown as fs.Dirent[]);

    const result = await listNvmNodeVersions();

    expect(result[0]?.major).toBe(24);
    expect(result[0]?.raw).toBe('v24.15.3');
  });

  it('sorts versions newest-first', async () => {
    readdirSpy.mockResolvedValue(
      ['v20.0.0', 'v24.2.0', 'v22.10.0', 'v24.1.0'] as unknown as fs.Dirent[],
    );

    const result = await listNvmNodeVersions();

    expect(result[0]?.raw).toBe('v24.2.0');
    expect(result[1]?.raw).toBe('v24.1.0');
    expect(result[2]?.raw).toBe('v22.10.0');
    expect(result[3]?.raw).toBe('v20.0.0');
  });

  it('returns an empty array when readdir throws', async () => {
    readdirSpy.mockRejectedValue(new Error('ENOENT'));

    const result = await listNvmNodeVersions();

    expect(result).toEqual([]);
  });

  it('returns an empty array when the directory is empty', async () => {
    readdirSpy.mockResolvedValue([] as unknown as fs.Dirent[]);

    const result = await listNvmNodeVersions();

    expect(result).toEqual([]);
  });

  it('uses NVM_DIR env var to build the versions path', async () => {
    process.env.NVM_DIR = '/custom-nvm';
    readdirSpy.mockResolvedValue(['v24.0.0'] as unknown as fs.Dirent[]);

    await listNvmNodeVersions();

    expect(readdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('/custom-nvm'),
    );
  });

  it('falls back to HOME/.nvm when NVM_DIR is not set', async () => {
    delete process.env.NVM_DIR;
    process.env.HOME = '/home/fallbackuser';
    readdirSpy.mockResolvedValue(['v22.0.0'] as unknown as fs.Dirent[]);

    await listNvmNodeVersions();

    expect(readdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('/home/fallbackuser/.nvm'),
    );
  });

  it('falls back to os.homedir()/.nvm when both NVM_DIR and HOME are not set', async () => {
    delete process.env.NVM_DIR;
    delete process.env.HOME;
    readdirSpy.mockRejectedValue(new Error('ENOENT'));

    const result = await listNvmNodeVersions();

    expect(result).toEqual([]);
    expect(readdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('/home/os-user/.nvm'),
    );
  });

  it('sorts correctly when minor and patch versions differ within same major', async () => {
    readdirSpy.mockResolvedValue(
      ['v24.1.0', 'v24.2.1', 'v24.2.0'] as unknown as fs.Dirent[],
    );

    const result = await listNvmNodeVersions();

    expect(result[0]?.raw).toBe('v24.2.1');
    expect(result[1]?.raw).toBe('v24.2.0');
    expect(result[2]?.raw).toBe('v24.1.0');
  });
});

// ---------------------------------------------------------------------------
// findNode24OrNewer
// ---------------------------------------------------------------------------

describe('findNode24OrNewer', () => {
  it('returns the first version with major >= 24', () => {
    const versions: NvmNodeVersion[] = [
      { raw: 'v24.0.0', major: 24 },
      { raw: 'v22.0.0', major: 22 },
    ];
    expect(findNode24OrNewer(versions)).toEqual({ raw: 'v24.0.0', major: 24 });
  });

  it('returns undefined when no version is >= 24', () => {
    const versions: NvmNodeVersion[] = [
      { raw: 'v22.0.0', major: 22 },
      { raw: 'v20.0.0', major: 20 },
    ];
    expect(findNode24OrNewer(versions)).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(findNode24OrNewer([])).toBeUndefined();
  });

  it('accepts Node 25+ as satisfying the requirement', () => {
    const versions: NvmNodeVersion[] = [
      { raw: 'v25.0.0', major: 25 },
      { raw: 'v22.0.0', major: 22 },
    ];
    expect(findNode24OrNewer(versions)).toEqual({ raw: 'v25.0.0', major: 25 });
  });

  it('returns the first match (newest) when multiple >=24 versions exist', () => {
    const versions: NvmNodeVersion[] = [
      { raw: 'v26.0.0', major: 26 },
      { raw: 'v24.1.0', major: 24 },
      { raw: 'v22.0.0', major: 22 },
    ];
    expect(findNode24OrNewer(versions)).toEqual({ raw: 'v26.0.0', major: 26 });
  });

  it('does not mutate the input array', () => {
    const versions: NvmNodeVersion[] = [
      { raw: 'v24.0.0', major: 24 },
    ];
    const copy = [...versions];
    findNode24OrNewer(versions);
    expect(versions).toEqual(copy);
  });
});
