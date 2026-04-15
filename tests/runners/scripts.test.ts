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

const NEW_PLUGIN_DIR = path.join(
  REPO_PATH,
  'x-pack',
  'solutions',
  'security',
  'plugins',
  'security_solution',
);
const OLD_PLUGIN_DIR = path.join(REPO_PATH, 'x-pack', 'plugins', 'security_solution');

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
      return p === REPO_PATH || p === NEW_PLUGIN_DIR;
    });
    const paths = detectKibanaScriptPaths(REPO_PATH);
    expect(paths.scriptDir).toBe(NEW_PLUGIN_DIR);
    expect(paths.generateCli).toContain('generate_cli.js');
    expect(paths.testGenerate).toBe(NEW_PLUGIN_DIR);
  });

  it('falls back to old plugin path when new does not exist', () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === OLD_PLUGIN_DIR;
    });
    const paths = detectKibanaScriptPaths(REPO_PATH);
    expect(paths.scriptDir).toBe(OLD_PLUGIN_DIR);
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
    mockedFs.existsSync.mockImplementation((p) => p === REPO_PATH);
    expect(() => detectKibanaScriptPaths(REPO_PATH)).toThrow(/\(new\).*\(old\)/s);
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
      return p === REPO_PATH || p === NEW_PLUGIN_DIR;
    });
  });

  it('spawns the correct yarn command in the plugin directory', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/yarn/),
      expect.arrayContaining(['test:generate', '--kibana', KIBANA_URL, '--username', 'elastic']),
      expect.objectContaining({ cwd: NEW_PLUGIN_DIR }),
    );
  });

  it('passes password via environment variable, not as CLI arg', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const spawnOptions = mockedSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env['ELASTICSEARCH_PASSWORD']).toBe('secret');
    const spawnArgs = [...mockedSpawn.mock.calls[0][1]];
    expect(spawnArgs).not.toContain('secret');
  });

  it('succeeds the spinner on exit code 0', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;
    expect(mockSpinner.succeed).toHaveBeenCalled();
  });

  it('rejects and fails spinner on non-zero exit code', async () => {
    const { child, code } = mockSpawnFailure(2);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', code, null);
    await expect(promise).rejects.toThrow('Process exited with code 2');
    expect(mockSpinner.fail).toHaveBeenCalled();
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

  it('updates spinner text with last stdout line', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    child.stdout.emit('data', Buffer.from('line 1\nline 2\n'));
    child.emit('close', 0, null);
    await promise;
    // After receiving data, spinner text should have been updated
    expect(mockSpinner.text).toBeDefined();
  });

  it('handles non-Buffer stdout chunk (string path)', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    // Emit a plain string instead of a Buffer to exercise String(chunk) branch
    child.stdout.emit('data', 'plain string output');
    child.emit('close', 0, null);
    await promise;
    expect(mockSpinner.text).toContain('plain string output');
  });

  it('does not update spinner text when chunk contains only empty lines', async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const initialText = mockSpinner.text;
    const promise = runGenerateEvents(REPO_PATH, KIBANA_URL, CREDS);
    // All whitespace — find() returns undefined, ?? '' gives '', if condition is false
    child.stdout.emit('data', Buffer.from('\n\n   \n'));
    child.emit('close', 0, null);
    await promise;
    // spinner.text should not have been updated from the empty chunk
    expect(mockSpinner.text).toBe(initialText);
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
        (typeof p === 'string' && p.includes('generate_cli.js'))
      );
    });
  });

  it('spawns node with --attacks flag', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--attacks');
    expect(args).toContain('--kibana');
    expect(args).toContain(KIBANA_URL);
  });

  it('appends --space flag when spaceId is provided', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, 'security');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--space');
    expect(args).toContain('security');
  });

  it('does not append --space when spaceId is empty string', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateAttacks(REPO_PATH, KIBANA_URL, CREDS, '');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).not.toContain('--space');
  });

  it('throws when generate_cli.js does not exist', async () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR;
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
        (typeof p === 'string' && p.includes('generate_cli.js'))
      );
    });
  });

  it('spawns node with --cases flag', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS);
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--cases');
  });

  it('appends --space flag when spaceId is provided', async () => {
    const child = mockSpawnSuccess();
    const promise = runGenerateCases(REPO_PATH, KIBANA_URL, CREDS, 'my-space');
    child.emit('close', 0, null);
    await promise;

    const args = [...mockedSpawn.mock.calls[0][1]];
    expect(args).toContain('--space');
    expect(args).toContain('my-space');
  });

  it('throws when generate_cli.js does not exist', async () => {
    mockedFs.existsSync.mockImplementation((p) => {
      return p === REPO_PATH || p === NEW_PLUGIN_DIR;
    });
    await expect(runGenerateCases(REPO_PATH, KIBANA_URL, CREDS)).rejects.toThrow(
      'generate_cli.js not found',
    );
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
    // events fails, alerts succeeds — both use auto-close for sequential safety
    mockSpawnAutoClose(1); // events exits with code 1
    mockSpawnAutoClose(0); // alerts exits with code 0

    const result = await runAllDataGeneration({
      ...baseOptions,
      generateEvents: true,
      generateAlerts: true,
    });

    expect(result.eventsRan).toBe(false);
    expect(result.alertsRan).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Events generation failed');
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
