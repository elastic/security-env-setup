import { EventEmitter } from 'events';

jest.mock('axios');
jest.mock('fs/promises');
jest.mock('child_process');
jest.mock('ora');
jest.mock('inquirer');

import axios from 'axios';
import { writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import ora from 'ora';
import * as inquirer from 'inquirer';

import {
  detectServices,
  getServiceCommands,
  escapeSingleQuoted,
  writeStartupScript,
  openInNewTerminalTab,
  waitUntilHealthy,
  ensureServicesRunning,
} from '@runners/local-services';
import type { ElasticCredentials, } from '@types-local/index';
import type { ServiceCommand } from '@runners/local-services';

// ---------------------------------------------------------------------------
// Mocked references
// ---------------------------------------------------------------------------

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockedInquirer = inquirer as jest.Mocked<typeof inquirer>;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const KIBANA_URL = 'http://localhost:5601';
const ES_URL = 'http://localhost:9200';

const CREDS: ElasticCredentials = {
  url: ES_URL,
  username: 'elastic',
  password: 'changeme',
};

// ---------------------------------------------------------------------------
// ora spinner mock (shared across describes that use it)
// ---------------------------------------------------------------------------

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  text: '',
};

// ---------------------------------------------------------------------------
// Child process helpers
// ---------------------------------------------------------------------------

function createMockChild(): EventEmitter {
  return new EventEmitter();
}

function mockSpawnClose(code = 0): void {
  const child = createMockChild();
  mockedSpawn.mockImplementationOnce(() => {
    process.nextTick(() => child.emit('close', code, null));
    return child as unknown as ReturnType<typeof spawn>;
  });
}

function mockSpawnError(message = 'spawn ENOENT'): void {
  const child = createMockChild();
  mockedSpawn.mockImplementationOnce(() => {
    process.nextTick(() => child.emit('error', new Error(message)));
    return child as unknown as ReturnType<typeof spawn>;
  });
}

// ---------------------------------------------------------------------------
// Console suppression
// ---------------------------------------------------------------------------

let consoleSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (ora as jest.MockedFunction<typeof ora>).mockReturnValue(
    mockSpinner as unknown as ReturnType<typeof ora>,
  );
});

afterAll(() => {
  consoleSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.isAxiosError.mockReturnValue(false);
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
  mockSpinner.text = '';
  mockedWriteFile.mockResolvedValue(undefined);
  mockedInquirer.prompt.mockResolvedValue({ proceed: '' });
  (ora as jest.MockedFunction<typeof ora>).mockReturnValue(
    mockSpinner as unknown as ReturnType<typeof ora>,
  );
});

// ===========================================================================
// detectServices
// ===========================================================================

describe('detectServices', () => {
  it('returns { kibana: true, elasticsearch: true } when both respond 2xx', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: {} }) // kibana /api/status
      .mockResolvedValueOnce({ status: 200, data: {} }); // es /

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: true, elasticsearch: true });
  });

  it('returns { kibana: false, elasticsearch: false } when both are unreachable', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: false, elasticsearch: false });
  });

  it('returns { kibana: false, elasticsearch: true } when only Kibana is down', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // kibana fails
      .mockResolvedValueOnce({ status: 200, data: {} }); // es ok

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: false, elasticsearch: true });
  });

  it('returns { kibana: true, elasticsearch: false } when only ES is down', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: {} }) // kibana ok
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // es fails

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: true, elasticsearch: false });
  });

  it('never throws — axios rejection becomes false', async () => {
    mockedAxios.get.mockRejectedValue(new Error('network timeout'));

    await expect(detectServices(KIBANA_URL, ES_URL, CREDS)).resolves.toEqual({
      kibana: false,
      elasticsearch: false,
    });
  });

  it('pings Kibana /api/status endpoint', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/status`,
      expect.any(Object),
    );
  });

  it('pings Elasticsearch / endpoint', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${ES_URL}/`,
      expect.any(Object),
    );
  });

  it('sends Basic Auth header with correct credentials', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    const expectedAuth = `Basic ${Buffer.from('elastic:changeme').toString('base64')}`;
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expectedAuth }),
      }),
    );
  });

  it('uses a 3-second timeout for each ping', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 3_000 }),
    );
  });
});

// ===========================================================================
// getServiceCommands
// ===========================================================================

describe('getServiceCommands', () => {
  const DIR = '/home/user/kibana';

  it('returns stateful ES command for local-stateful', () => {
    const { es } = getServiceCommands('local-stateful', DIR);
    expect(es.name).toBe('Elasticsearch');
    expect(es.command).toBe('yarn es snapshot --license trial');
    expect(es.kibanaDir).toBe(DIR);
  });

  it('returns stateful Kibana command for local-stateful', () => {
    const { kibana } = getServiceCommands('local-stateful', DIR);
    expect(kibana.name).toBe('Kibana');
    expect(kibana.command).toBe('yarn start');
    expect(kibana.kibanaDir).toBe(DIR);
  });

  it('returns serverless ES command for local-serverless', () => {
    const { es } = getServiceCommands('local-serverless', DIR);
    expect(es.name).toBe('Elasticsearch');
    expect(es.command).toBe('yarn es serverless --projectType=security');
  });

  it('returns serverless Kibana command for local-serverless', () => {
    const { kibana } = getServiceCommands('local-serverless', DIR);
    expect(kibana.name).toBe('Kibana');
    expect(kibana.command).toBe('yarn serverless-security');
  });
});

// ===========================================================================
// escapeSingleQuoted
// ===========================================================================

describe('escapeSingleQuoted', () => {
  it('returns empty string unchanged', () => {
    expect(escapeSingleQuoted('')).toBe('');
  });

  it('returns a string with no quotes unchanged', () => {
    expect(escapeSingleQuoted('/home/user/kibana')).toBe('/home/user/kibana');
  });

  it('escapes a single quote', () => {
    expect(escapeSingleQuoted("it's")).toBe("it'\\''s");
  });

  it('escapes multiple single quotes', () => {
    expect(escapeSingleQuoted("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it('handles a string that is only a single quote', () => {
    expect(escapeSingleQuoted("'")).toBe("'\\''");
  });

  it('handles mixed special and ordinary characters', () => {
    const input = "/home/user's dir/ki'bana";
    const result = escapeSingleQuoted(input);
    expect(result).toBe("/home/user'\\''s dir/ki'\\''bana");
  });
});

// ===========================================================================
// writeStartupScript
// ===========================================================================

describe('writeStartupScript', () => {
  const ES_CMD: ServiceCommand = {
    name: 'Elasticsearch',
    command: 'yarn es snapshot --license trial',
    kibanaDir: '/home/user/kibana',
  };

  const KIBANA_CMD: ServiceCommand = {
    name: 'Kibana',
    command: 'yarn start',
    kibanaDir: '/home/user/kibana',
  };

  it('returns a path with the es slug and process pid for Elasticsearch', async () => {
    const result = await writeStartupScript(ES_CMD);
    expect(result).toBe(`/tmp/security-env-setup-es-${process.pid}.sh`);
  });

  it('returns a path with the kibana slug and process pid for Kibana', async () => {
    const result = await writeStartupScript(KIBANA_CMD);
    expect(result).toBe(`/tmp/security-env-setup-kibana-${process.pid}.sh`);
  });

  it('calls writeFile with the correct path', async () => {
    await writeStartupScript(ES_CMD);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      `/tmp/security-env-setup-es-${process.pid}.sh`,
      expect.any(String),
      { mode: 0o755 },
    );
  });

  it('writes the script with mode 0o755', async () => {
    await writeStartupScript(ES_CMD);
    const options = mockedWriteFile.mock.calls[0]?.[2];
    expect(options).toEqual({ mode: 0o755 });
  });

  it('embeds the kibanaDir in the cd command', async () => {
    await writeStartupScript(ES_CMD);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    expect(content).toContain("cd '/home/user/kibana'");
  });

  it('embeds the command in the script', async () => {
    await writeStartupScript(ES_CMD);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    expect(content).toContain('yarn es snapshot --license trial');
  });

  it('includes the service name in the script header', async () => {
    await writeStartupScript(ES_CMD);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    expect(content).toContain('=== Elasticsearch');
  });

  it('single-quote-escapes a kibanaDir that contains a single quote', async () => {
    const cmd: ServiceCommand = {
      name: 'Kibana',
      command: 'yarn start',
      kibanaDir: "/home/user's/kibana",
    };
    await writeStartupScript(cmd);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    expect(content).toContain("cd '/home/user'\\''s/kibana'");
  });

  it('includes the shebang line', async () => {
    await writeStartupScript(ES_CMD);
    const content = mockedWriteFile.mock.calls[0]?.[1] as string;
    expect(content).toMatch(/^#!/);
  });
});

// ===========================================================================
// openInNewTerminalTab
// ===========================================================================

/** Helper: temporarily set process.platform for a single describe scope. */
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const REAL_PLATFORM = process.platform;

describe('openInNewTerminalTab', () => {
  afterEach(() => {
    // Restore the actual platform after each test in this describe block
    Object.defineProperty(process, 'platform', {
      value: REAL_PLATFORM,
      configurable: true,
    });
  });

  it('returns false without spawning on non-darwin platforms', async () => {
    setPlatform('linux');

    const result = await openInNewTerminalTab('/tmp/test.sh');

    expect(result).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('returns true when osascript exits with code 0 on darwin', async () => {
    setPlatform('darwin');
    mockSpawnClose(0);

    const result = await openInNewTerminalTab('/tmp/security-env-setup-es-123.sh');

    expect(result).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e']),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'ignore'] }),
    );
  });

  it('returns false when osascript exits with a non-zero code on darwin', async () => {
    setPlatform('darwin');
    mockSpawnClose(1);

    const result = await openInNewTerminalTab('/tmp/test.sh');

    expect(result).toBe(false);
  });

  it('returns false when osascript emits an error event on darwin', async () => {
    setPlatform('darwin');
    mockSpawnError('spawn ENOENT');

    const result = await openInNewTerminalTab('/tmp/test.sh');

    expect(result).toBe(false);
  });

  it('passes the script path inside the AppleScript do script command', async () => {
    setPlatform('darwin');
    mockSpawnClose(0);

    await openInNewTerminalTab('/tmp/security-env-setup-es-9999.sh');

    const spawnArgs = mockedSpawn.mock.calls[0]?.[1] as string[];
    const appleScript = spawnArgs[1] ?? '';
    expect(appleScript).toContain('security-env-setup-es-9999.sh');
    expect(appleScript).toContain('Terminal');
  });
});

// ===========================================================================
// waitUntilHealthy
// ===========================================================================

describe('waitUntilHealthy', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves immediately when pingFn returns true on first try', async () => {
    const pingFn = jest.fn().mockResolvedValue(true);

    await expect(
      waitUntilHealthy({ pingFn, name: 'Elasticsearch', timeoutMs: 30_000 }),
    ).resolves.toBeUndefined();

    expect(pingFn).toHaveBeenCalledTimes(1);
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Elasticsearch is healthy.');
  });

  it('resolves after N failed pings when pingFn eventually returns true', async () => {
    jest.useFakeTimers();

    const pingFn = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const promise = waitUntilHealthy({
      pingFn,
      name: 'Kibana',
      timeoutMs: 60_000,
      intervalMs: 1_000,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toBeUndefined();
    expect(pingFn).toHaveBeenCalledTimes(3);
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Kibana is healthy.');
  });

  it('throws with an actionable message when the timeout elapses', async () => {
    jest.useFakeTimers();

    const pingFn = jest.fn().mockResolvedValue(false);

    const promise = waitUntilHealthy({
      pingFn,
      name: 'Elasticsearch',
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });

    // Attach a silent handler immediately so the rejection is never "unhandled"
    // while Jest advances timers.  The original `promise` ref still rejects.
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(6_000);

    await expect(promise).rejects.toThrow(
      'Elasticsearch did not become healthy within 5s. ' +
        'Check the Elasticsearch terminal window for errors.',
    );
    expect(mockSpinner.fail).toHaveBeenCalledWith(
      'Elasticsearch did not become healthy within 5s.',
    );
  });

  it('includes the first-boot hint in spinner text after 30 elapsed seconds', async () => {
    jest.useFakeTimers();

    // false 31 times (iterations 0-30), then true (iteration 31)
    const pingFn = jest.fn();
    for (let i = 0; i < 31; i++) {
      pingFn.mockResolvedValueOnce(false);
    }
    pingFn.mockResolvedValueOnce(true);

    const promise = waitUntilHealthy({
      pingFn,
      name: 'ES',
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });

    // Advance 31 seconds — each second fires one sleep and one loop iteration
    await jest.advanceTimersByTimeAsync(31_000);

    await expect(promise).resolves.toBeUndefined();

    // The spinner text was last set at the 30-second iteration (elapsed=30)
    expect(mockSpinner.text).toContain('first boot');
  });

  it('polls pingFn at the configured intervalMs', async () => {
    jest.useFakeTimers();

    const pingFn = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const promise = waitUntilHealthy({
      pingFn,
      name: 'ES',
      timeoutMs: 60_000,
      intervalMs: 500,
    });

    // Advance twice to fire two sleeps; third ping should return true
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(500);

    await promise;
    expect(pingFn).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// ensureServicesRunning
// ===========================================================================

describe('ensureServicesRunning', () => {
  beforeEach(() => {
    // Default: macOS so the osascript path is reachable
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
  });

  it('returns already-running without writing scripts when both services are up', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result).toEqual({ method: 'already-running', kibana: true, elasticsearch: true });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('ES down only — writes ES script, calls osascript once, waits for ES', async () => {
    // Initial check: Kibana up, ES down; then ES becomes healthy on first ping
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200 })        // Kibana up
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // ES down
      .mockResolvedValue({ status: 200 });            // all further calls: both up

    mockSpawnClose(0); // osascript succeeds

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result).toEqual({ method: 'osascript', kibana: true, elasticsearch: true });

    // Only the ES script was written (Kibana was already running)
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('security-env-setup-es'),
      expect.any(String),
      { mode: 0o755 },
    );

    // Only one osascript call
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Elasticsearch is healthy.');
  });

  it('both down, osascript succeeds for both — writes two scripts, two spawns in ES→Kibana order', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // Kibana down
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // ES down
      .mockResolvedValue({ status: 200 });              // all further: both up

    mockSpawnClose(0); // ES osascript
    mockSpawnClose(0); // Kibana osascript

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result).toEqual({ method: 'osascript', kibana: true, elasticsearch: true });
    expect(mockedWriteFile).toHaveBeenCalledTimes(2);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);

    // Verify ES spawned first
    const firstAppleScript = (mockedSpawn.mock.calls[0]?.[1] as string[])[1] ?? '';
    expect(firstAppleScript).toContain('security-env-setup-es');

    // Kibana spawned second
    const secondAppleScript = (mockedSpawn.mock.calls[1]?.[1] as string[])[1] ?? '';
    expect(secondAppleScript).toContain('security-env-setup-kibana');

    expect(mockSpinner.succeed).toHaveBeenCalledWith('Elasticsearch is healthy.');
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Kibana is healthy.');
  });

  it('both down, osascript fails on first call — no further spawns, shows assisted mode', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // Kibana down
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // ES down
      .mockResolvedValue({ status: 200 });              // all further: both up

    mockSpawnClose(1); // first osascript fails (non-zero exit)

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result).toEqual({ method: 'assisted', kibana: true, elasticsearch: true });

    // Only one spawn attempt (the failed first one)
    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    // Inquirer prompt was shown
    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(1);

    // Health polling ran for both services
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Elasticsearch is healthy.');
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Kibana is healthy.');
  });

  it('non-darwin — skips osascript entirely and uses assisted mode', async () => {
    setPlatform('linux');

    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // Kibana down
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // ES down
      .mockResolvedValue({ status: 200 });

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result.method).toBe('assisted');
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(1);
  });

  it('/tmp write fails — falls back to assisted mode', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // Kibana down
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // ES down
      .mockResolvedValue({ status: 200 });

    mockedWriteFile.mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result.method).toBe('assisted');
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(1);
  });

  it('Kibana only down — uses kibanaScriptPath as first script, assisted shows single terminal', async () => {
    // ES is up, only Kibana is down; osascript fails → assisted
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // Kibana down
      .mockResolvedValueOnce({ status: 200 })           // ES up
      .mockResolvedValue({ status: 200 });              // Kibana up after prompt

    mockSpawnClose(1); // osascript fails → fall through to assisted

    const result = await ensureServicesRunning(
      'local-stateful', '/kb', KIBANA_URL, ES_URL, CREDS,
    );

    expect(result.method).toBe('assisted');

    // Only the Kibana script was written (ES was already running)
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('security-env-setup-kibana'),
      expect.any(String),
      { mode: 0o755 },
    );

    // The printed instructions should NOT include "Terminal 2" (only one terminal needed)
    const printedLines = consoleSpy.mock.calls.flat().join('\n');
    expect(printedLines).toContain('Terminal 1 (Kibana');
    expect(printedLines).not.toContain('Terminal 2');

    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(1);
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Kibana is healthy.');
  });
});
