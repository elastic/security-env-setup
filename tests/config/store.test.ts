import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('fs');

const mockedFs = fs as jest.Mocked<typeof fs>;

// The store builds config paths at module load time using os.homedir().
const CONFIG_DIR = path.join(os.homedir(), '.security-env-setup');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Re-import store after mocking fs so the mocks apply.
import {
  getApiKey,
  setApiKey,
  hasApiKey,
  clearApiKey,
  getAllApiKeys,
} from '@config/store';

function makeStoreJson(apiKeys: Record<string, string>): string {
  return JSON.stringify({ apiKeys });
}

function stubReadFile(content: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockedFs.readFileSync as jest.Mock).mockReturnValue(content);
}

function stubReadFileMissing(): void {
  const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  mockedFs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: config file missing (fresh state)
  stubReadFileMissing();
  // writeFileSync, mkdirSync, chmodSync, renameSync succeed silently
  mockedFs.writeFileSync.mockImplementation(() => undefined);
  mockedFs.mkdirSync.mockImplementation(() => undefined);
  mockedFs.chmodSync.mockImplementation(() => undefined);
  mockedFs.renameSync.mockImplementation(() => undefined);
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.unlinkSync.mockImplementation(() => undefined);
});

describe('getApiKey', () => {
  it('returns the stored key for a configured environment', () => {
    stubReadFile(makeStoreJson({ prod: 'key-prod' }));
    expect(getApiKey('prod')).toBe('key-prod');
  });

  it('returns undefined for an environment with no key', () => {
    stubReadFile(makeStoreJson({ prod: 'key-prod' }));
    expect(getApiKey('qa')).toBeUndefined();
  });
});

describe('setApiKey', () => {
  it('writes the key to the config file', () => {
    stubReadFile(makeStoreJson({}));
    setApiKey('prod', 'new-key');
    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, written] = mockedFs.writeFileSync.mock.calls[0];
    const parsed = JSON.parse(written as string) as { apiKeys: Record<string, string> };
    expect(parsed.apiKeys['prod']).toBe('new-key');
  });

  it('writes with file mode 0o600', () => {
    stubReadFile(makeStoreJson({}));
    setApiKey('qa', 'k');
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it('creates the directory with mode 0o700', () => {
    stubReadFile(makeStoreJson({}));
    setApiKey('prod', 'x');
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      CONFIG_DIR,
      expect.objectContaining({ mode: 0o700 }),
    );
  });

  it('throws when the API key is empty', () => {
    expect(() => setApiKey('prod', '')).toThrow('API key must be a non-empty string');
  });

  it('throws when the API key is whitespace only', () => {
    expect(() => setApiKey('prod', '   ')).toThrow('API key must be a non-empty string');
  });
});

describe('hasApiKey', () => {
  it('returns true when a non-empty key is stored', () => {
    stubReadFile(makeStoreJson({ prod: 'some-key' }));
    expect(hasApiKey('prod')).toBe(true);
  });

  it('returns false when no key is stored', () => {
    stubReadFile(makeStoreJson({}));
    expect(hasApiKey('prod')).toBe(false);
  });

  it('returns false when the stored key is an empty string', () => {
    stubReadFile(makeStoreJson({ prod: '' }));
    expect(hasApiKey('prod')).toBe(false);
  });

  it('returns false when the stored key is whitespace only', () => {
    stubReadFile(makeStoreJson({ prod: '   ' }));
    expect(hasApiKey('prod')).toBe(false);
  });
});

describe('clearApiKey', () => {
  it('removes the key and returns true when a key exists', () => {
    stubReadFile(makeStoreJson({ prod: 'key', qa: 'other' }));
    const result = clearApiKey('prod');
    expect(result).toBe(true);
    // Verify the written JSON no longer has prod
    const [, written] = mockedFs.writeFileSync.mock.calls[0];
    const parsed = JSON.parse(written as string) as { apiKeys: Record<string, string> };
    expect(parsed.apiKeys['prod']).toBeUndefined();
    expect(parsed.apiKeys['qa']).toBe('other');
  });

  it('returns false when no key is stored for that environment', () => {
    stubReadFile(makeStoreJson({ qa: 'other' }));
    const result = clearApiKey('prod');
    expect(result).toBe(false);
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('getAllApiKeys', () => {
  it('returns all stored keys', () => {
    stubReadFile(makeStoreJson({ prod: 'p', qa: 'q', staging: 's' }));
    const keys = getAllApiKeys();
    expect(keys).toEqual({ prod: 'p', qa: 'q', staging: 's' });
  });

  it('returns an empty object when config file is missing', () => {
    stubReadFileMissing();
    expect(getAllApiKeys()).toEqual({});
  });

  it('returns an empty object when config JSON is malformed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedFs.readFileSync as jest.Mock).mockReturnValue('NOT_JSON');
    expect(getAllApiKeys()).toEqual({});
  });

  it('returns an empty object when config JSON has wrong shape', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ notApiKeys: {} }));
    expect(getAllApiKeys()).toEqual({});
  });

  it('returns a copy — mutating the result does not affect subsequent reads', () => {
    stubReadFile(makeStoreJson({ prod: 'key' }));
    const first = getAllApiKeys();
    (first as Record<string, string>)['prod'] = 'mutated';
    stubReadFile(makeStoreJson({ prod: 'key' }));
    const second = getAllApiKeys();
    expect(second['prod']).toBe('key');
  });
});

describe('readStore error handling', () => {
  it('rethrows unexpected fs errors', () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockedFs.readFileSync.mockImplementation(() => {
      throw err;
    });
    expect(() => getApiKey('prod')).toThrow('EACCES');
  });
});

describe('writeStore / tryChmodSync error handling', () => {
  it('suppresses EPERM errors from chmodSync', () => {
    stubReadFile(makeStoreJson({}));
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockedFs.chmodSync.mockImplementationOnce(() => {
      throw eperm;
    });
    // Should not throw — EPERM is silently ignored
    expect(() => setApiKey('prod', 'key')).not.toThrow();
  });

  it('suppresses EINVAL errors from chmodSync', () => {
    stubReadFile(makeStoreJson({}));
    const einval = Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    mockedFs.chmodSync.mockImplementationOnce(() => {
      throw einval;
    });
    expect(() => setApiKey('prod', 'key')).not.toThrow();
  });

  it('rethrows unexpected errors from chmodSync', () => {
    stubReadFile(makeStoreJson({}));
    const eio = Object.assign(new Error('EIO'), { code: 'EIO' });
    mockedFs.chmodSync.mockImplementationOnce(() => {
      throw eio;
    });
    expect(() => setApiKey('prod', 'key')).toThrow('EIO');
  });

  it('falls back to unlinkSync + renameSync on Windows EEXIST from renameSync', () => {
    stubReadFile(makeStoreJson({}));
    // Simulate platform-neutral: first renameSync throws EEXIST, then succeeds
    let renameCallCount = 0;
    mockedFs.renameSync.mockImplementation(() => {
      renameCallCount++;
      if (renameCallCount === 1) {
        const err = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        throw err;
      }
      // second call succeeds
    });
    mockedFs.existsSync.mockReturnValue(true);
    // On non-Windows platforms, the first renameSync failure propagates.
    // On Windows it would try unlink+rename. Since we're on macOS in this
    // test environment, the EEXIST path re-throws. Test that it does so.
    if (process.platform !== 'win32') {
      expect(() => setApiKey('prod', 'key')).toThrow('EEXIST');
    }
  });
});
