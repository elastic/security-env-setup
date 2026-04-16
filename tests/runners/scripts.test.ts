import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

jest.mock('fs');
jest.mock('child_process');
jest.mock('ora');

import ora from 'ora';
import { spawn } from 'child_process';
import {
  detectKibanaScriptPaths,
  ensureKibanaBootstrapped,
  extractIntegrityPackage,
  runGenerateEvents,
  runGenerateAttacks,
  runGenerateCases,
  runAllDataGeneration,
} from '@runners/scripts';
import type { ElasticCredentials } from '@types-local/index';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
let consoleLogSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  text: '',
};
(ora as jest.MockedFunction<typeof ora>).mockReturnValue(
  mockSpinner as unknown as ReturnType<typeof ora>,
);

const REPO_PATH = '/home/user/kibana';
const KIBANA_URL = 'https://kb.example.com:9243';
const CREDS: ElasticCredentials = {
  url: 'https://es.example.com:9243',
  username: 'elastic',
  password: 'secret',
};

const INTEGRITY_PKG = 'lodash';
const INTEGRITY_STDERR = `error https://registry.yarnpkg.com/${INTEGRITY_PKG}/-/${INTEGRITY_PKG}-4.17.21.tgz: Integrity check failed`;

const NEW_PLUGIN_DIR = path.join(
  REPO_PATH,
  'x-pack',
  'solutions',
  'security',
  'plugins',
  'security_solution',
);
const OLD_PLUGIN_DIR = path.join(REPO_PATH, 'x-pack', 'plugins', 'security_solution');

const NEW_CASES_SCRIPT = path.join(
  REPO_PATH,
  'x-pack', 'platform', 'plugins', 'shared', 'cases', 'scripts', 'generate_cases.js',
);
const OLD_CASES_SCRIPT = path.join(
  REPO_PATH,
  'x-pack', 'plugins', 'cases', 'scripts', 'generate_cases.js',
);

// Creates a mock child process with stdout/stderr streams and event emitter.
function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// Sets up spawn to return a mock child. Callers must emit close manually.
function mockSpawnSuccess() {
  const child = createMockChild();
  mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

// Sets up spawn to return a mock child. Callers must emit close manually.
function mockSpawnFailure(code = 1) {
  const child = createMockChild();
  mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return { child, code };
}

// Auto-close variant: close is scheduled via process.nextTick at the moment
// spawn() is *called* (inside mockImplementationOnce), so the event fires
// after spawnProcess attaches its 'close' listener but before the test needs
// to manually drive events.
function mockSpawnAutoClose(code = 0): void {
  const child = createMockChild();
  mockedSpawn.mockImplementationOnce(() => {
    // nextTick runs after the Promise constructor finishes attaching listeners.
    process.nextTick(() => child.emit('close', code, null));
    return child as unknown as ReturnType<typeof spawn>;
  });
}

// Emits stderr output followed by close, all via nextTick so listeners are
// attached before events fire.
function mockSpawnWithStderrAndClose(stderrText: string, code = 1): void {
  const child = createMockChild();
  mockedSpawn.mockImplementationOnce(() => {
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from(stderrText));
      child.emit('close', code, null);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

beforeAll(() => {
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
  mockedFs.existsSync.mockReturnValue(false);
});

afterAll(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// detectKibanaScriptPaths
// ---------------------------------------------------------------------------

describe('detectKibanaScriptPaths', () => {
  it('detects the new plugin path when it exists', () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR || p === NEW_CASES_SCRIPT;
    });
    const paths = detectKibanaScriptPaths(REPO_PATH);
    expect(paths.scriptDir).toBe(NEW_PLUGIN_DIR);
    expect(paths.generateCli).toContain('generate_cli.js');
    expect(paths.testGenerate).toBe(NEW_PLUGIN_DIR);
  });

  it('falls back to old plugin path when new does not exist', () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === OLD_PLUGIN_DIR || p === OLD_CASES_SCRIPT;
    });
    const paths = detectKibanaScriptPaths(REPO_PATH);
    expect(paths.scriptDir).toBe(OLD_PLUGIN_DIR);
  });

  it('returns the new cases script path when it exists', () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR || p === NEW_CASES_SCRIPT;
    });
    const paths = detectKibanaScriptPaths(REPO_PATH);
    expect(paths.generateCasesScript).toBe(NEW_CASES_SCRIPT);
  });

  it('falls back to old cases script path when new does not exist', () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR || p === OLD_CASES_SCRIPT;
    });
    const paths = detectKibanaScriptPaths(REPO_PATH);
    expect(paths.generateCasesScript).toBe(OLD_CASES_SCRIPT);
  });

  it('throws with both candidate paths when neither exists', () => {
    mockedFs.existsSync.mockImplementation((p) => p === REPO_PATH);
    expect(() => detectKibanaScriptPaths(REPO_PATH)).toThrow(
      'Could not find security_solution plugin',
    );
  });

  it('throws when kibanaRepoPath does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(() => detectKibanaScriptPaths('/nonexistent')).toThrow(
      'Kibana repository not found',
    );
  });

  it('includes both candidate paths in the error message', () => {
    mockedFs.existsSync.mockImplementation((p) => p === REPO_PATH || p === NEW_PLUGIN_DIR);
    expect(() => detectKibanaScriptPaths(REPO_PATH)).toThrow(/\(new\).*\(old\)/s);
  });
});

// ---------------------------------------------------------------------------
// extractIntegrityPackage
// ---------------------------------------------------------------------------

describe('extractIntegrityPackage', () => {
  it('extracts an unscoped package name from an integrity error', () => {
    const stderr =
      'error https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz: Integrity check failed';
    expect(extractIntegrityPackage(stderr)).toBe('lodash');
  });

  it('extracts a scoped package name from an integrity error', () => {
    const stderr =
      'error https://registry.yarnpkg.com/@kbn/test/-/@kbn/test-1.0.0.tgz: Integrity check failed';
    expect(extractIntegrityPackage(stderr)).toBe('@kbn/test');
  });

  it('normalizes an encoded scoped package name from an integrity error', () => {
    const stderr =
      'error https://registry.yarnpkg.com/@kbn%2ftest/-/@kbn%2ftest-1.0.0.tgz: Integrity check failed';
    expect(extractIntegrityPackage(stderr)).toBe('@kbn/test');
  });

  it('returns null for a non-integrity error message', () => {
    expect(extractIntegrityPackage('error Command failed with exit code 1')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractIntegrityPackage('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensureKibanaBootstrapped
// ---------------------------------------------------------------------------

describe('ensureKibanaBootstrapped', () => {
  const RESOLVED_REPO_PATH = path.resolve(REPO_PATH);
  const BOOTSTRAP_MARKER = path.join(RESOLVED_REPO_PATH, 'node_modules', '@kbn', 'test-es-server');

  it('logs ready and does not spawn when marker directory exists', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH || p === BOOTSTRAP_MARKER);
    await ensureKibanaBootstrapped(REPO_PATH);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('spawns yarn kbn bootstrap at the repo root when marker is absent', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    mockSpawnAutoClose(0);
    await ensureKibanaBootstrapped(REPO_PATH);
    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/yarn/),
      expect.arrayContaining(['kbn', 'bootstrap']),
      expect.objectContaining({ cwd: path.resolve(REPO_PATH) }),
    );
  });

  it('throws bootstrap-failed error when bootstrap process exits non-zero', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    mockSpawnAutoClose(1);
    await expect(ensureKibanaBootstrapped(REPO_PATH)).rejects.toThrow('Bootstrap failed');
  });

  it('throws bootstrap-failed error when yarn is not found (ENOENT)', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = ensureKibanaBootstrapped(REPO_PATH);
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoentErr);
    await expect(promise).rejects.toThrow('Bootstrap failed');
  });

  it('bootstrap-failed error includes actionable instructions', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    mockSpawnAutoClose(1);
    await expect(ensureKibanaBootstrapped(REPO_PATH)).rejects.toThrow(
      "run 'yarn kbn bootstrap' manually",
    );
  });

  it('throws when kibanaRepoPath does not exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    await expect(ensureKibanaBootstrapped('/nonexistent')).rejects.toThrow(
      'Kibana repository not found',
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('bootstrap-failed error includes underlying error details', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    mockSpawnAutoClose(1);
    await expect(ensureKibanaBootstrapped(REPO_PATH)).rejects.toThrow(
      'Underlying error: Process exited with code 1',
    );
  });

  it('cleans package cache and retries when an integrity error occurs', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    // Attempt 1: integrity error
    mockSpawnWithStderrAndClose(INTEGRITY_STDERR, 1);
    // yarn cache clean (package): success
    mockSpawnAutoClose(0);
    // Attempt 2: success
    mockSpawnAutoClose(0);

    await ensureKibanaBootstrapped(REPO_PATH);

    expect(mockedSpawn).toHaveBeenCalledTimes(3);
    // Second spawn must be yarn cache clean with the extracted package name
    expect(mockedSpawn.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['cache', 'clean', INTEGRITY_PKG]),
    );
  });

  it('cleans full cache after two integrity errors and succeeds on final attempt', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    // Attempt 1: integrity error
    mockSpawnWithStderrAndClose(INTEGRITY_STDERR, 1);
    // yarn cache clean (package): success
    mockSpawnAutoClose(0);
    // Attempt 2: integrity error again
    mockSpawnWithStderrAndClose(INTEGRITY_STDERR, 1);
    // yarn cache clean (full): success
    mockSpawnAutoClose(0);
    // Attempt 3: success
    mockSpawnAutoClose(0);

    await ensureKibanaBootstrapped(REPO_PATH);

    expect(mockedSpawn).toHaveBeenCalledTimes(5);
    // Fourth spawn must be a full cache clean (no extra package arg)
    expect(mockedSpawn.mock.calls[3]?.[1]).toEqual(['cache', 'clean']);
  });

  it('throws Bootstrap failed after all three attempts are exhausted', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    // Attempt 1: integrity error
    mockSpawnWithStderrAndClose(INTEGRITY_STDERR, 1);
    // yarn cache clean (package): success
    mockSpawnAutoClose(0);
    // Attempt 2: integrity error
    mockSpawnWithStderrAndClose(INTEGRITY_STDERR, 1);
    // yarn cache clean (full): success
    mockSpawnAutoClose(0);
    // Attempt 3: fails
    mockSpawnAutoClose(1);

    await expect(ensureKibanaBootstrapped(REPO_PATH)).rejects.toThrow('Bootstrap failed');
    expect(mockedSpawn).toHaveBeenCalledTimes(5);
  });

  it('throws immediately on non-integrity failure without retrying', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    mockSpawnWithStderrAndClose('Connection refused to registry', 1);

    await expect(ensureKibanaBootstrapped(REPO_PATH)).rejects.toThrow('Bootstrap failed');
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it('streams bootstrap stdout/stderr to terminal output', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === RESOLVED_REPO_PATH);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const promise = ensureKibanaBootstrapped(REPO_PATH);
      child.stdout.emit('data', Buffer.from('bootstrap stdout\n'));
      child.stderr.emit('data', Buffer.from('bootstrap stderr\n'));
      child.emit('close', 0, null);
      await promise;

      expect(stdoutSpy).toHaveBeenCalledWith('bootstrap stdout\n');
      expect(stderrSpy).toHaveBeenCalledWith('bootstrap stderr\n');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// runGenerateEvents
// ---------------------------------------------------------------------------

describe('runGenerateEvents', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR || p === NEW_CASES_SCRIPT;
    });
  });

  it('spawns yarn test:generate in the plugin directory with --node and --kibana', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/yarn/),
      expect.arrayContaining(['test:generate', '--node', '--kibana']),
      expect.objectContaining({ cwd: NEW_PLUGIN_DIR }),
    );
  });

  it('embeds credentials in --node and --kibana URLs', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    const nodeArg = spawnArgs[spawnArgs.indexOf('--node') + 1] ?? '';
    const kibanaArg = spawnArgs[spawnArgs.indexOf('--kibana') + 1] ?? '';

    expect(nodeArg).toContain('elastic:secret@');
    expect(nodeArg).toContain('es.example.com');
    expect(kibanaArg).toContain('elastic:secret@');
    expect(kibanaArg).toContain('kb.example.com');
  });

  it('overwrites existing credentials in --node and --kibana URLs', async () => {
    const child = mockSpawnSuccess();
    const credsWithEmbeddedAuth: ElasticCredentials = {
      ...CREDS,
      url: 'https://old-user:old-pass@es.example.com:9243',
    };
    const promise = runGenerateEvents(
      REPO_PATH,
      'https://old-user:old-pass@kb.example.com:9243',
      credsWithEmbeddedAuth,
    );
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    const nodeArg = spawnArgs[spawnArgs.indexOf('--node') + 1] ?? '';
    const kibanaArg = spawnArgs[spawnArgs.indexOf('--kibana') + 1] ?? '';

    expect(nodeArg).toContain('elastic:secret@');
    expect(nodeArg).not.toContain('old-user:old-pass@');
    expect(kibanaArg).toContain('elastic:secret@');
    expect(kibanaArg).not.toContain('old-user:old-pass@');
  });

  it('throws a clear error when the input URL is invalid', async () => {
    await expect(runGenerateEvents(REPO_PATH, 'not-a-url', CREDS)).rejects.toThrow(
      'Invalid HTTP(S) URL for embedding credentials',
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('does not set NODE_TLS_REJECT_UNAUTHORIZED in the environment', async () => {
    const originalNodeTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';

    try {
      const child = mockSpawnSuccess();
      const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
      child.emit('close', 0, null);
      await promise;

      const spawnOptions = mockedSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
    } finally {
      if (originalNodeTls === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalNodeTls;
      }
    }
  });

  it('normalizes port :443 to :9243 in the --node URL', async () => {
    const child = mockSpawnSuccess();
    const credsWith443 = { ...CREDS, url: 'https://es.example.com:443' };
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, credsWith443);
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    const nodeArg = spawnArgs[spawnArgs.indexOf('--node') + 1] ?? '';
    expect(nodeArg).toContain(':9243');
    expect(nodeArg).not.toContain(':443');
  });

  it('normalizes port :443 to :9243 in the --kibana URL', async () => {
    const child = mockSpawnSuccess();
    const kibanaWith443 = 'https://kb.example.com:443';
    const promise = runGenerateEvents(REPO_PATH, kibanaWith443, CREDS);
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    const kibanaArg = spawnArgs[spawnArgs.indexOf('--kibana') + 1] ?? '';
    expect(kibanaArg).toContain(':9243');
    expect(kibanaArg).not.toContain(':443');
  });

  it('removes trailing slash from both URLs', async () => {
    const child = mockSpawnSuccess();
    const credsWith443Slash = { ...CREDS, url: 'https://es.example.com:9243/' };
    const promise = runGenerateEvents(REPO_PATH, 'https://kb.example.com:9243/', credsWith443Slash);
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    const nodeArg = spawnArgs[spawnArgs.indexOf('--node') + 1] ?? '';
    const kibanaArg = spawnArgs[spawnArgs.indexOf('--kibana') + 1] ?? '';

    expect(nodeArg).not.toMatch(/\/$/);
    expect(kibanaArg).not.toMatch(/\/$/);
  });

  it('leaves port :9243 unchanged in both URLs', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    const nodeArg = spawnArgs[spawnArgs.indexOf('--node') + 1] ?? '';
    const kibanaArg = spawnArgs[spawnArgs.indexOf('--kibana') + 1] ?? '';
    expect(nodeArg).toContain(':9243');
    expect(kibanaArg).toContain(':9243');
  });

  it('passes optimized generation parameters', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const spawnArgs = [...mockedSpawn.mock.calls[0][1]] as string[];
    expect(spawnArgs).toContain('--numHosts');
    expect(spawnArgs[spawnArgs.indexOf('--numHosts') + 1]).toBe('50');
    expect(spawnArgs).toContain('--numDocs');
    expect(spawnArgs[spawnArgs.indexOf('--numDocs') + 1]).toBe('20');
    expect(spawnArgs).toContain('--alertsPerHost');
    expect(spawnArgs[spawnArgs.indexOf('--alertsPerHost') + 1]).toBe('10');
    expect(spawnArgs).toContain('--generations');
    expect(spawnArgs[spawnArgs.indexOf('--generations') + 1]).toBe('5');
    expect(spawnArgs).toContain('--children');
    expect(spawnArgs[spawnArgs.indexOf('--children') + 1]).toBe('5');
    expect(spawnArgs).toContain('--relatedEvents');
    expect(spawnArgs[spawnArgs.indexOf('--relatedEvents') + 1]).toBe('10');
    expect(spawnArgs).toContain('--relatedAlerts');
    expect(spawnArgs[spawnArgs.indexOf('--relatedAlerts') + 1]).toBe('10');
    expect(spawnArgs).toContain('--percentWithRelated');
    expect(spawnArgs[spawnArgs.indexOf('--percentWithRelated') + 1]).toBe('70');
    expect(spawnArgs).toContain('--percentTerminated');
    expect(spawnArgs[spawnArgs.indexOf('--percentTerminated') + 1]).toBe('50');
  });

  it('warns that credentials will be visible in process listings', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('credentials embedded in URLs'),
    );
  });

  it('resolves on exit code 0', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await expect(promise).resolves.toBeUndefined();
    // passthroughOutput mode: spinner is never used
    expect(mockSpinner.succeed).not.toHaveBeenCalled();
  });

  it('rejects on non-zero exit code', async () => {
    const { child, code } = mockSpawnFailure(2);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', code, null);
    await expect(promise).rejects.toThrow('Process exited with code 2');
    expect(mockSpinner.fail).not.toHaveBeenCalled();
  });

  it('rejects with ENOENT message when command is not found', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoentErr);
    await expect(promise).rejects.toThrow('Command not found');
  });

  it('includes stderr output in rejection error message', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.stderr.emit('data', Buffer.from('something went wrong'));
    child.emit('close', 1, null);
    await expect(promise).rejects.toThrow('stderr');
  });

  it('streams stdout to the terminal (passthroughOutput)', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
      child.stdout.emit('data', Buffer.from('line 1\nline 2\n'));
      child.emit('close', 0, null);
      await promise;
      expect(stdoutSpy).toHaveBeenCalledWith('line 1\nline 2\n');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('streams non-Buffer stdout chunks to the terminal', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
      child.stdout.emit('data', 'plain string output');
      child.emit('close', 0, null);
      await promise;
      expect(stdoutSpy).toHaveBeenCalledWith('plain string output');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('rejects with "unknown" when close event fires with null exit code', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', null, null);
    await expect(promise).rejects.toThrow('Process exited with code unknown');
  });

  it('rejects with raw error message for non-ENOENT spawn errors', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    const permErr = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    child.emit('error', permErr);
    await expect(promise).rejects.toThrow('Permission denied');
  });
});

// ---------------------------------------------------------------------------
// runGenerateAttacks
// ---------------------------------------------------------------------------

describe('runGenerateAttacks', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockImplementation((p) => {
      return (
        p === REPO_PATH ||
        p === NEW_PLUGIN_DIR ||
        p === NEW_CASES_SCRIPT ||
        (typeof p === 'string' && p.includes('generate_cli.js'))
      );
    });
  });

  it('spawns node with --attacks flag and passes --password as CLI arg', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--attacks');
    expect(args).toContain('--kibanaUrl');
    expect(args).toContain(KIBANA_URL);
    expect(args).toContain('--elasticsearchUrl');
    expect(args).toContain(CREDS.url);
    expect(args).toContain('--password');
    expect(args).toContain(CREDS.password);
  });

  it('passes optimized generation parameters', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--events');
    expect(args[args.indexOf('--events') + 1]).toBe('500');
    expect(args).toContain('--hosts');
    expect(args[args.indexOf('--hosts') + 1]).toBe('10');
    expect(args).toContain('--users');
    expect(args[args.indexOf('--users') + 1]).toBe('10');
    expect(args).toContain('--start-date');
    expect(args[args.indexOf('--start-date') + 1]).toBe('30d');
    expect(args).toContain('--max-preview-invocations');
    expect(args[args.indexOf('--max-preview-invocations') + 1]).toBe('15');
  });

  it('warns that --password can be visible in process listings', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('--password to generate_cli.js'),
    );
  });

  it('appends --spaceId flag when spaceId is a non-default ID', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, 'security');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--spaceId');
    expect(args).toContain('security');
  });

  it('appends --spaceId with a trimmed value when spaceId includes surrounding spaces', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, '  security  ');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--spaceId');
    expect(args).toContain('security');
    expect(args).not.toContain('  security  ');
  });

  it('does not append --spaceId when spaceId is empty string', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, '');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--spaceId');
  });

  it('does not append --spaceId when spaceId is whitespace only', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, '   ');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--spaceId');
  });

  it('does not append --spaceId when spaceId is "default"', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, 'default');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--spaceId');
    expect(args).not.toContain('default');
  });

  it('does not append --spaceId when trimmed spaceId is "default"', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, '  default  ');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--spaceId');
    expect(args).not.toContain('default');
  });

  it('throws when generate_cli.js does not exist', async () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR || p === NEW_CASES_SCRIPT;
    });
    await expect(runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS)).rejects.toThrow(
      'generate_cli.js not found',
    );
  });
});

// ---------------------------------------------------------------------------
// runGenerateCases
// ---------------------------------------------------------------------------

describe('runGenerateCases', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockImplementation((p) => {
      return (
        p === REPO_PATH ||
        p === NEW_PLUGIN_DIR ||
        (typeof p === 'string' && p.includes('generate_cases.js'))
      );
    });
  });

  it('spawns node with generate_cases.js and --kibana flag', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    // First arg is the script path
    expect(args[0]).toContain('generate_cases.js');
    expect(args).toContain('--kibana');
    expect(args).toContain(KIBANA_URL);
    expect(args).toContain('--username');
    expect(args).toContain('elastic');
  });

  it('passes --password as a CLI arg', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--password');
    expect(args).toContain(CREDS.password);
    // Must NOT use --kibanaUrl or --elasticsearchUrl
    expect(args).not.toContain('--kibanaUrl');
    expect(args).not.toContain('--elasticsearchUrl');
  });

  it('warns that --password can be visible in process listings', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Passing Elasticsearch password via --password to generate_cases.js; this may be visible in process listings while the script runs.',
      ),
    );
  });

  it('does not warn when password is empty/whitespace', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, { ...CREDS, password: '   ' });
    child.emit('close', 0, null);
    await promise;

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('appends --space flag when spaceId is a non-default ID', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS, 'my-space');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--space');
    expect(args).toContain('my-space');
    expect(args).not.toContain('--spaceId');
  });

  it('does not append --space when spaceId is "default"', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS, 'default');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--space');
    expect(args).not.toContain('default');
  });

  it('does not append --space when spaceId is empty string', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS, '');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--space');
  });

  it('passes --count 1000 by default', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--count');
    expect(args[args.indexOf('--count') + 1]).toBe('1000');
  });

  it('passes custom count when specified', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS, undefined, 300);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--count');
    expect(args[args.indexOf('--count') + 1]).toBe('300');
  });

  it('throws when neither generate_cases.js candidate path exists', async () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR;
    });
    await expect(runGenerateCases(REPO_PATH, KIBANA_URL, CREDS)).rejects.toThrow(
      'Could not find generate cases script inside',
    );
    await expect(runGenerateCases(REPO_PATH, KIBANA_URL, CREDS)).rejects.toThrow(/\(new\).*\(old\)/s);
  });
});

// ---------------------------------------------------------------------------
// runAllDataGeneration
// ---------------------------------------------------------------------------

describe('runAllDataGeneration', () => {
  const baseOptions = {
    kibanaRepoPath: REPO_PATH,
    kibanaUrl: KIBANA_URL,
    credentials: CREDS,
    generateAlerts: false,
    generateCases: false,
    generateEvents: false,
  };
  const BOOTSTRAP_MARKER = path.join(path.resolve(REPO_PATH), 'node_modules', '@kbn', 'test-es-server');

  beforeEach(() => {
    mockedFs.existsSync.mockImplementation((p) => {
      return (
        p === REPO_PATH ||
        p === path.resolve(REPO_PATH) ||
        p === NEW_PLUGIN_DIR ||
        (typeof p === 'string' && p.includes('generate_cli.js')) ||
        (typeof p === 'string' && p.includes('generate_cases.js')) ||
        // Bootstrap marker — present so ensureKibanaBootstrapped skips bootstrap
        // unless a test overrides this mock behavior.
        p === BOOTSTRAP_MARKER
      );
    });
  });

  it('runs all three scripts when all selected', async () => {
    // Auto-close so each sequential step resolves without manual emit timing.
    mockSpawnAutoClose(0);
    mockSpawnAutoClose(0);
    mockSpawnAutoClose(0);

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateEvents: true,
      generateAlerts: true,
      generateCases: true,
    });

    expect(result.eventsRan).toBe(true);
    expect(result.alertsRan).toBe(true);
    expect(result.casesRan).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('skips unselected scripts', async () => {
    const result = await runAllDataGeneration({
      ...baseOptions,
      generateEvents: false,
      generateAlerts: false,
      generateCases: false,
    });
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(mockedFs.existsSync).not.toHaveBeenCalledWith(BOOTSTRAP_MARKER);
    expect(result.eventsRan).toBe(false);
    expect(result.alertsRan).toBe(false);
    expect(result.casesRan).toBe(false);
  });

  it('collects errors without aborting remaining scripts', async () => {
    // alerts runs first (new order), events second
    mockSpawnAutoClose(1); // alerts exits with code 1
    mockSpawnAutoClose(0); // events exits with code 0

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateEvents: true,
      generateAlerts: true,
    });

    expect(result.alertsRan).toBe(false);
    expect(result.eventsRan).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Alerts generation failed');
  });

  it('throws when kibanaRepoPath does not exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    await expect(
      runAllDataGeneration({ ...baseOptions, generateEvents: true }),
    ).rejects.toThrow('Kibana repository not found');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('records script error when security_solution plugin path cannot be detected', async () => {
    mockedFs.existsSync.mockImplementation(
      (p) => p === REPO_PATH || p === path.resolve(REPO_PATH) || p === BOOTSTRAP_MARKER,
    );
    const result = await runAllDataGeneration({ ...baseOptions, generateEvents: true });
    expect(result.eventsRan).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Could not find security_solution plugin');
  });

  it('collects alerts error without aborting remaining scripts', async () => {
    mockSpawnAutoClose(1); // alerts fails
    mockSpawnAutoClose(0); // cases succeeds

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateAlerts: true,
      generateCases: true,
    });

    expect(result.alertsRan).toBe(false);
    expect(result.casesRan).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Alerts generation failed');
  });

  it('collects cases error without aborting remaining scripts', async () => {
    mockSpawnAutoClose(1); // cases fails

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateCases: true,
    });

    expect(result.casesRan).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Cases generation failed');
  });

  it('appends bootstrap hint when a script fails with Cannot find module', async () => {
    mockSpawnWithStderrAndClose('Cannot find module @kbn/some-package');

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateEvents: true,
    });

    expect(result.eventsRan).toBe(false);
    expect(result.errors[0]).toContain('yarn kbn bootstrap');
  });

  it('does not append bootstrap hint for unrelated script errors', async () => {
    mockSpawnWithStderrAndClose('network timeout');

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateEvents: true,
    });

    expect(result.errors[0]).not.toContain('yarn kbn bootstrap');
  });
});
