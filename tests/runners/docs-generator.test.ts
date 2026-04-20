import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

jest.mock('fs');
jest.mock('fs/promises');
jest.mock('child_process');
jest.mock('ora');

import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import {
  ensureRepoCloned,
  writeConfig,
  installDependencies,
  runDocsGeneratorCommand,
  runStandardSequence,
} from '@runners/docs-generator';
import { VOLUME_PRESETS } from '@config/volume-presets';
import type {
  DocsGeneratorConfigOptions,
  ElasticCredentials,
  StandardSequenceOptions,
} from '@types-local/index';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockedWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;

const DIR = '/home/user/security-documents-generator';
const NVM_DIR_PATH = '/test-nvm';
const NVM_SH = path.join(NVM_DIR_PATH, 'nvm.sh');
const REPO_URL = 'https://github.com/elastic/security-documents-generator.git';

const CREDS_PASSWORD: ElasticCredentials = {
  url: 'https://es.example.com:9243',
  username: 'elastic',
  password: 'secret',
};

const CREDS_API_KEY: ElasticCredentials = {
  url: 'https://es.example.com:9243',
  username: 'elastic',
  password: '',
  apiKey: 'my-api-key',
};

let consoleLogSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;
let stderrSpy: jest.SpyInstance;

// ---------------------------------------------------------------------------
// Child process helpers (same pattern as scripts.test.ts)
// ---------------------------------------------------------------------------

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function mockSpawnAutoClose(code = 0): void {
  const child = createMockChild();
  mockedSpawn.mockImplementationOnce(() => {
    process.nextTick(() => child.emit('close', code, null));
    return child as unknown as ReturnType<typeof spawn>;
  });
}

function mockSpawnSuccess() {
  const child = createMockChild();
  mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

/** Extracts the bash -c script string from a spawn call (index 1 of args array). */
function getBashScript(callIndex: number): string {
  const args = mockedSpawn.mock.calls[callIndex]?.[1] as string[];
  return args?.[1] ?? '';
}

/** Extracts spawn args array from a call. */
function getSpawnArgs(callIndex: number): string[] {
  return [...(mockedSpawn.mock.calls[callIndex]?.[1] as string[] ?? [])];
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIG_NVM_DIR = process.env.NVM_DIR;
const ORIG_HOME = process.env.HOME;

beforeAll(() => {
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedWriteFile.mockResolvedValue(undefined);
  // Set a predictable NVM_DIR so resolveNvmDir() checks a known path
  process.env.NVM_DIR = NVM_DIR_PATH;
});

afterEach(() => {
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

afterAll(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// VOLUME_PRESETS
// ---------------------------------------------------------------------------

describe('VOLUME_PRESETS', () => {
  it('has entries for all three volume levels', () => {
    expect(VOLUME_PRESETS).toHaveProperty('light');
    expect(VOLUME_PRESETS).toHaveProperty('medium');
    expect(VOLUME_PRESETS).toHaveProperty('heavy');
  });

  it('light preset has the correct values', () => {
    expect(VOLUME_PRESETS.light).toEqual({
      events: 200,
      hosts: 5,
      users: 5,
      extraAlerts: 1000,
      orgSize: 'small',
    });
  });

  it('medium preset has the correct values', () => {
    expect(VOLUME_PRESETS.medium).toEqual({
      events: 500,
      hosts: 10,
      users: 10,
      extraAlerts: 10000,
      orgSize: 'medium',
    });
  });

  it('heavy preset has the correct values', () => {
    expect(VOLUME_PRESETS.heavy).toEqual({
      events: 2000,
      hosts: 25,
      users: 25,
      extraAlerts: 50000,
      orgSize: 'enterprise',
    });
  });
});

// ---------------------------------------------------------------------------
// ensureRepoCloned
// ---------------------------------------------------------------------------

describe('ensureRepoCloned', () => {
  it('runs git clone when .git does not exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(0);
    await ensureRepoCloned(DIR);
    expect(mockedSpawn).toHaveBeenCalledWith(
      'git',
      ['clone', REPO_URL, DIR],
      expect.objectContaining({ cwd: path.dirname(DIR) }),
    );
  });

  it('runs git fetch then pull when .git exists', async () => {
    const gitDir = path.join(DIR, '.git');
    mockedFs.existsSync.mockImplementation((p) => p === gitDir);
    mockSpawnAutoClose(0); // fetch
    mockSpawnAutoClose(0); // pull
    await ensureRepoCloned(DIR);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(getSpawnArgs(0)).toEqual(['-C', DIR, 'fetch', '--all', '--tags', '--prune']);
    expect(getSpawnArgs(1)).toEqual(['-C', DIR, 'pull', '--ff-only']);
  });

  it('logs a warning but resolves when pull fails', async () => {
    const gitDir = path.join(DIR, '.git');
    mockedFs.existsSync.mockImplementation((p) => p === gitDir);
    mockSpawnAutoClose(0); // fetch succeeds
    mockSpawnAutoClose(1); // pull fails
    await expect(ensureRepoCloned(DIR)).resolves.toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fast-forward pull'),
    );
  });

  it('propagates when git clone fails', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(1);
    await expect(ensureRepoCloned(DIR)).rejects.toThrow('Process exited with code 1');
  });

  it('propagates when git fetch fails', async () => {
    const gitDir = path.join(DIR, '.git');
    mockedFs.existsSync.mockImplementation((p) => p === gitDir);
    mockSpawnAutoClose(1); // fetch fails
    await expect(ensureRepoCloned(DIR)).rejects.toThrow('Process exited with code 1');
  });
});

// ---------------------------------------------------------------------------
// writeConfig
// ---------------------------------------------------------------------------

describe('writeConfig', () => {
  const BASE_OPTIONS: DocsGeneratorConfigOptions = {
    elasticsearchUrl: 'https://es.example.com:9243',
    kibanaUrl: 'https://kb.example.com:9243',
    mode: 'stateful',
    credentials: CREDS_PASSWORD,
  };

  it('writes to <dir>/config.json', async () => {
    await writeConfig(DIR, BASE_OPTIONS);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(DIR, 'config.json'),
      expect.any(String),
      'utf8',
    );
  });

  it('produces username/password shape when apiKey is absent', async () => {
    await writeConfig(DIR, BASE_OPTIONS);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    const elastic = json['elastic'] as Record<string, string>;
    expect(elastic['node']).toBe('https://es.example.com:9243');
    expect(elastic['username']).toBe('elastic');
    expect(elastic['password']).toBe('secret');
    expect(elastic['apiKey']).toBeUndefined();
  });

  it('produces apiKey shape when credentials.apiKey is set', async () => {
    await writeConfig(DIR, { ...BASE_OPTIONS, credentials: CREDS_API_KEY });
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    const elastic = json['elastic'] as Record<string, string>;
    expect(elastic['apiKey']).toBe('my-api-key');
    expect(elastic['username']).toBeUndefined();
    expect(elastic['password']).toBeUndefined();
  });

  it('kibana.node uses kibanaUrl not elasticsearchUrl', async () => {
    await writeConfig(DIR, BASE_OPTIONS);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    const kibana = json['kibana'] as Record<string, string>;
    expect(kibana['node']).toBe('https://kb.example.com:9243');
  });

  it('sets serverless: false for stateful mode', async () => {
    await writeConfig(DIR, { ...BASE_OPTIONS, mode: 'stateful' });
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    expect(json['serverless']).toBe(false);
  });

  it('sets serverless: true for serverless mode', async () => {
    await writeConfig(DIR, { ...BASE_OPTIONS, mode: 'serverless' });
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    expect(json['serverless']).toBe(true);
  });

  it('always includes eventIndex: logs-testlogs-default', async () => {
    await writeConfig(DIR, BASE_OPTIONS);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    expect(json['eventIndex']).toBe('logs-testlogs-default');
  });

  it('propagates writeFile errors', async () => {
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(writeConfig(DIR, BASE_OPTIONS)).rejects.toThrow('disk full');
  });
});

// ---------------------------------------------------------------------------
// installDependencies
// ---------------------------------------------------------------------------

describe('installDependencies', () => {
  it('runs yarn install via nvm wrapper when nvm is present', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    // nvm path → bash -c
    expect(mockedSpawn.mock.calls[0]?.[0]).toBe('bash');
    const script = getBashScript(0);
    expect(script).toContain('nvm.sh');
    expect(script).toContain('install');
    expect(script).toContain('--silent');
  });

  it('runs yarn directly when nvm is not found', async () => {
    mockedFs.existsSync.mockReturnValue(false); // nvm.sh absent
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    expect(mockedSpawn).toHaveBeenCalledWith(
      'yarn',
      expect.arrayContaining(['install', '--silent']),
      expect.objectContaining({ cwd: DIR }),
    );
  });

  it('logs a warning when nvm is not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('nvm not found'),
    );
  });

  it('does not include nvm prelude in spawn command when nvm is absent', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    expect(mockedSpawn.mock.calls[0]?.[0]).toBe('yarn');
  });

  it('throws when yarn install fails', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(1);
    await expect(installDependencies(DIR)).rejects.toThrow('Process exited with code 1');
  });

  it('sets NVM_DIR in env when nvm is present', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    const opts = mockedSpawn.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env['NVM_DIR']).toBe(NVM_DIR_PATH);
  });
});

// ---------------------------------------------------------------------------
// runDocsGeneratorCommand
// ---------------------------------------------------------------------------

describe('runDocsGeneratorCommand', () => {
  it('runs via nvm wrapper when nvm is present', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(0);
    await runDocsGeneratorCommand(DIR, ['generate-alerts', '-n', '1000'], 'generate-alerts');
    expect(mockedSpawn.mock.calls[0]?.[0]).toBe('bash');
    const script = getBashScript(0);
    expect(script).toContain('nvm.sh');
    expect(script).toContain('start');
    expect(script).toContain('generate-alerts');
  });

  it('runs yarn start directly when nvm is absent', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(0);
    await runDocsGeneratorCommand(DIR, ['rules'], 'rules');
    expect(mockedSpawn).toHaveBeenCalledWith(
      'yarn',
      expect.arrayContaining(['start', 'rules']),
      expect.any(Object),
    );
  });

  it('resolves without throwing when yarn start exits non-zero', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(1);
    await expect(
      runDocsGeneratorCommand(DIR, ['generate-alerts'], 'generate-alerts'),
    ).resolves.toBeUndefined();
  });

  it('logs a warning with description when the command fails', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(1);
    await runDocsGeneratorCommand(DIR, ['generate-alerts'], 'generate-alerts');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('generate-alerts'),
    );
  });

  it('resolves without throwing when spawn emits an error event', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = runDocsGeneratorCommand(DIR, ['rules'], 'rules');
    child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(promise).resolves.toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('rules'));
  });

  it('shell-quotes args so single-quotes in values are safe', async () => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    mockSpawnAutoClose(0);
    await runDocsGeneratorCommand(DIR, ['cmd', "it's a test"], 'cmd');
    const script = getBashScript(0);
    // Single-quote escaped: it'\''s a test
    expect(script).toContain("it'\\''s a test");
  });
});

// ---------------------------------------------------------------------------
// runStandardSequence
// ---------------------------------------------------------------------------

describe('runStandardSequence', () => {
  const SEQ_OPTIONS: StandardSequenceOptions = { space: 'security', volume: 'medium' };

  beforeEach(() => {
    mockedFs.existsSync.mockImplementation((p) => p === NVM_SH);
    for (let i = 0; i < 9; i++) {
      mockSpawnAutoClose(0);
    }
  });

  it('spawns exactly 9 commands for the full sequence', async () => {
    await runStandardSequence(DIR, SEQ_OPTIONS);
    expect(mockedSpawn).toHaveBeenCalledTimes(9);
  });

  it('passes the correct space to org-data (1st command)', async () => {
    await runStandardSequence(DIR, SEQ_OPTIONS);
    const script = getBashScript(0);
    expect(script).toContain('org-data');
    expect(script).toContain('--space');
    expect(script).toContain('security');
  });

  it('uses medium volume orgSize in org-data', async () => {
    await runStandardSequence(DIR, SEQ_OPTIONS);
    const script = getBashScript(0);
    expect(script).toContain(VOLUME_PRESETS.medium.orgSize); // 'medium'
  });

  it('passes medium extraAlerts/hosts/users to generate-alerts (3rd command)', async () => {
    await runStandardSequence(DIR, SEQ_OPTIONS);
    const script = getBashScript(2);
    expect(script).toContain('generate-alerts');
    expect(script).toContain(String(VOLUME_PRESETS.medium.extraAlerts)); // 10000
    expect(script).toContain(String(VOLUME_PRESETS.medium.hosts));       // 10
    expect(script).toContain(String(VOLUME_PRESETS.medium.users));       // 10
  });

  it('passes the correct space to privmon-quick (8th command)', async () => {
    await runStandardSequence(DIR, SEQ_OPTIONS);
    const script = getBashScript(7);
    expect(script).toContain('privmon-quick');
    expect(script).toContain('--space');
    expect(script).toContain('security');
  });

  it('passes correct args to csp (9th command)', async () => {
    await runStandardSequence(DIR, SEQ_OPTIONS);
    const script = getBashScript(8);
    expect(script).toContain('csp');
    expect(script).toContain('--data-sources');
    expect(script).toContain('all');
    expect(script).toContain('--findings-count');
    expect(script).toContain('500');
  });

  it('uses light volume preset when volume is light', async () => {
    mockedSpawn.mockReset();
    for (let i = 0; i < 9; i++) mockSpawnAutoClose(0);
    await runStandardSequence(DIR, { space: 'default', volume: 'light' });
    const orgScript = getBashScript(0);
    expect(orgScript).toContain(VOLUME_PRESETS.light.orgSize); // 'small'
    const alertScript = getBashScript(2);
    expect(alertScript).toContain(String(VOLUME_PRESETS.light.extraAlerts)); // 1000
  });

  it('continues the sequence when one command fails', async () => {
    mockedSpawn.mockReset();
    mockSpawnAutoClose(1); // org-data fails
    for (let i = 0; i < 8; i++) mockSpawnAutoClose(0);
    await expect(runStandardSequence(DIR, SEQ_OPTIONS)).resolves.toBeUndefined();
    expect(mockedSpawn).toHaveBeenCalledTimes(9);
  });

  it('streams stdout from commands to process.stdout', async () => {
    // mockedSpawn.mockReset() drains the 9 once-mocks queued by this describe's
    // beforeEach (clearAllMocks only clears call history, not the once-queue).
    mockedSpawn.mockReset();
    const child = mockSpawnSuccess();
    for (let i = 0; i < 8; i++) mockSpawnAutoClose(0);
    const promise = runStandardSequence(DIR, { space: 'default', volume: 'light' });
    child.stdout.emit('data', Buffer.from('generator output\n'));
    child.emit('close', 0, null);
    await promise;
    expect(stdoutSpy).toHaveBeenCalledWith('generator output\n');
  });
});

// ---------------------------------------------------------------------------
// runCommand branch coverage — low-level behavior exercised through
// installDependencies (simplest public entry point that uses runCommand)
// ---------------------------------------------------------------------------

describe('runCommand branch coverage', () => {
  it('streams non-Buffer stdout chunks to process.stdout', async () => {
    mockedFs.existsSync.mockReturnValue(false); // nvm absent → yarn path
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = installDependencies(DIR);
    // Emit a plain string (not a Buffer) to exercise the String(chunk) branch
    child.stdout.emit('data', 'plain string output');
    child.emit('close', 0, null);
    await promise;
    expect(stdoutSpy).toHaveBeenCalledWith('plain string output');
  });

  it('streams Buffer stderr chunks to process.stderr', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = installDependencies(DIR);
    child.stderr.emit('data', Buffer.from('stderr line\n'));
    child.emit('close', 0, null);
    await promise;
    expect(stderrSpy).toHaveBeenCalledWith('stderr line\n');
  });

  it('streams non-Buffer stderr chunks to process.stderr', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = installDependencies(DIR);
    child.stderr.emit('data', 'plain stderr string');
    child.emit('close', 0, null);
    await promise;
    expect(stderrSpy).toHaveBeenCalledWith('plain stderr string');
  });

  it('includes captured stderr in the rejection message when exit is non-zero', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = installDependencies(DIR);
    child.stderr.emit('data', Buffer.from('dependency error'));
    child.emit('close', 1, null);
    await expect(promise).rejects.toThrow('dependency error');
  });

  it('uses "unknown" exit code string when close fires with null code', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const child = createMockChild();
    mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const promise = installDependencies(DIR);
    child.emit('close', null, null);
    await expect(promise).rejects.toThrow('Process exited with code unknown');
  });

  it('resolveNvmDir falls back to HOME/.nvm when NVM_DIR is not set', async () => {
    delete process.env.NVM_DIR;
    process.env.HOME = '/home/testuser';
    // nvm.sh absent at fallback location → yarn path
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    // Spawned via yarn (not bash) because nvm.sh was not found
    expect(mockedSpawn.mock.calls[0]?.[0]).toBe('yarn');
  });

  it('falls back to ~ when both NVM_DIR and HOME are not set', async () => {
    delete process.env.NVM_DIR;
    delete process.env.HOME;
    mockedFs.existsSync.mockReturnValue(false);
    mockSpawnAutoClose(0);
    await installDependencies(DIR);
    expect(mockedSpawn.mock.calls[0]?.[0]).toBe('yarn');
  });
});

// ---------------------------------------------------------------------------
// writeConfig — empty apiKey falls back to username/password
// ---------------------------------------------------------------------------

describe('writeConfig apiKey edge cases', () => {
  const BASE_OPTIONS: DocsGeneratorConfigOptions = {
    elasticsearchUrl: 'https://es.example.com:9243',
    kibanaUrl: 'https://kb.example.com:9243',
    mode: 'stateful',
    credentials: { url: 'https://es.example.com:9243', username: 'u', password: 'p', apiKey: '' },
  };

  it('falls back to username/password when apiKey is empty string', async () => {
    await writeConfig(DIR, BASE_OPTIONS);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    const json = JSON.parse(content) as Record<string, unknown>;
    const elastic = json['elastic'] as Record<string, string>;
    expect(elastic['username']).toBe('u');
    expect(elastic['password']).toBe('p');
    expect(elastic['apiKey']).toBeUndefined();
  });
});
