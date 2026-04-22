import fs from 'fs';
import path from 'path';

jest.mock('fs');
jest.mock('@api/kibana');
jest.mock('@runners/local-services');
jest.mock('@runners/docs-generator');
jest.mock('@runners/scripts');

import {
  createSpace,
  initializeSecurityApp,
  installPrebuiltRules,
  bulkEnableImmutableRules,
  installSampleData,
} from '@api/kibana';
import { ensureServicesRunning } from '@runners/local-services';
import type { AutoStartResult } from '@runners/local-services';
import {
  ensureNode24Installed,
  ensureRepoCloned,
  writeConfig,
  installDependencies,
  runStandardSequence,
} from '@runners/docs-generator';
import { runKibanaLocalGenerator, runGenerateEvents } from '@runners/scripts';
import { runLocalFlow } from '@commands/create-local';
import type { LocalWizardAnswers } from '@types-local/index';
import type { NvmNodeVersion } from '@utils/node-version';

const mockedFs = fs as jest.Mocked<typeof fs>;

const mockedCreateSpace = createSpace as jest.MockedFunction<typeof createSpace>;
const mockedInitializeSecurityApp = initializeSecurityApp as jest.MockedFunction<typeof initializeSecurityApp>;
const mockedInstallPrebuiltRules = installPrebuiltRules as jest.MockedFunction<typeof installPrebuiltRules>;
const mockedBulkEnableImmutableRules = bulkEnableImmutableRules as jest.MockedFunction<typeof bulkEnableImmutableRules>;
const mockedInstallSampleData = installSampleData as jest.MockedFunction<typeof installSampleData>;
const mockedEnsureServicesRunning = ensureServicesRunning as jest.MockedFunction<typeof ensureServicesRunning>;
const mockedEnsureNode24Installed = ensureNode24Installed as jest.MockedFunction<typeof ensureNode24Installed>;
const mockedEnsureRepoCloned = ensureRepoCloned as jest.MockedFunction<typeof ensureRepoCloned>;
const mockedWriteConfig = writeConfig as jest.MockedFunction<typeof writeConfig>;
const mockedInstallDependencies = installDependencies as jest.MockedFunction<typeof installDependencies>;
const mockedRunStandardSequence = runStandardSequence as jest.MockedFunction<typeof runStandardSequence>;
const mockedRunKibanaLocalGenerator = runKibanaLocalGenerator as jest.MockedFunction<typeof runKibanaLocalGenerator>;
const mockedRunGenerateEvents = runGenerateEvents as jest.MockedFunction<typeof runGenerateEvents>;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_V24: NvmNodeVersion = { raw: 'v24.0.0', major: 24 };

const BASE_ANSWERS: LocalWizardAnswers = {
  target: 'local-stateful',
  kibanaDir: '/home/user/kibana',
  kibanaUrl: 'http://localhost:5601',
  elasticsearchUrl: 'http://localhost:9200',
  username: 'elastic',
  password: 'changeme',
  space: 'default',
  volume: 'medium',
  generateAlertsAndCases: true,
  generateEvents: true,
  generateExtended: true,
  docsGeneratorDir: '/home/user/security-documents-generator',
  installSampleData: false,
};

// ---------------------------------------------------------------------------
// Console / logger suppression
// ---------------------------------------------------------------------------

let consoleSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Default mock setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  // bootstrap marker exists by default
  mockedFs.existsSync.mockReturnValue(true);

  mockedEnsureNode24Installed.mockResolvedValue(MOCK_V24);
  mockedEnsureServicesRunning.mockResolvedValue({
    method: 'already-running',
    kibana: true,
    elasticsearch: true,
  });

  mockedInstallSampleData.mockResolvedValue(undefined);
  mockedCreateSpace.mockResolvedValue({
    space: { id: 'custom', name: 'custom' },
    alreadyExisted: false,
  });
  mockedInitializeSecurityApp.mockResolvedValue(undefined);
  mockedInstallPrebuiltRules.mockResolvedValue({
    packages: [{ name: 'security_detection_engine', version: '9.3.8', status: 'installed' }],
    summary: { total: 1779, succeeded: 1779, skipped: 0, failed: 0 },
  });
  // bulkEnableImmutableRules is no longer called by the local flow;
  // no default mock value needed — asserting it is never called.
  mockedRunKibanaLocalGenerator.mockResolvedValue(undefined);
  mockedRunGenerateEvents.mockResolvedValue(undefined);
  mockedEnsureRepoCloned.mockResolvedValue(undefined);
  mockedWriteConfig.mockResolvedValue(undefined);
  mockedInstallDependencies.mockResolvedValue(undefined);
  mockedRunStandardSequence.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path (space: default, installSampleData: false)
// ---------------------------------------------------------------------------

describe('runLocalFlow — happy path (default space, no sample data)', () => {
  it('resolves without throwing', async () => {
    await expect(runLocalFlow(BASE_ANSWERS)).resolves.toBeUndefined();
  });

  it('calls ensureNode24Installed', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedEnsureNode24Installed).toHaveBeenCalledTimes(1);
  });

  it('checks the bootstrap marker path', async () => {
    await runLocalFlow(BASE_ANSWERS);
    const expectedMarker = path.join(
      BASE_ANSWERS.kibanaDir,
      'node_modules',
      '@kbn',
      'test-es-server',
    );
    expect(mockedFs.existsSync).toHaveBeenCalledWith(expectedMarker);
  });

  it('calls ensureServicesRunning with the correct args', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedEnsureServicesRunning).toHaveBeenCalledWith(
      BASE_ANSWERS.target,
      BASE_ANSWERS.kibanaDir,
      BASE_ANSWERS.kibanaUrl,
      BASE_ANSWERS.elasticsearchUrl,
      expect.objectContaining({ username: 'elastic' }),
    );
  });

  it('does NOT call installSampleData when installSampleData is false', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedInstallSampleData).not.toHaveBeenCalled();
  });

  it('does NOT call createSpace when space is "default"', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedCreateSpace).not.toHaveBeenCalled();
  });

  it('calls initializeSecurityApp with Kibana URL', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedInitializeSecurityApp).toHaveBeenCalledWith(
      BASE_ANSWERS.kibanaUrl,
      expect.objectContaining({ username: 'elastic' }),
    );
  });

  it('calls installPrebuiltRules but NOT bulkEnableImmutableRules', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedInstallPrebuiltRules).toHaveBeenCalledTimes(1);
    expect(mockedBulkEnableImmutableRules).not.toHaveBeenCalled();
  });

  it('logs the succeeded/total rule count and Fleet package count after install', async () => {
    await runLocalFlow(BASE_ANSWERS);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('1779/1779');
    expect(output).toContain('1 Fleet packages synced');
  });

  it('logs the "Rules are installed but NOT enabled" notice', async () => {
    await runLocalFlow(BASE_ANSWERS);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('NOT enabled');
    expect(output).toContain('Rules');
  });

  it('includes the installed rule count in the final summary', async () => {
    await runLocalFlow(BASE_ANSWERS);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('1779');
    expect(output).toContain('enable from Rules UI');
  });

  it('calls runKibanaLocalGenerator with volume data', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedRunKibanaLocalGenerator).toHaveBeenCalledWith(
      BASE_ANSWERS.kibanaDir,
      BASE_ANSWERS.kibanaUrl,
      expect.any(Object),
      expect.objectContaining({
        spaceId: 'default',
        events: 500,   // medium preset
        hosts: 10,
        users: 10,
      }),
    );
  });

  it('calls ensureRepoCloned then writeConfig then installDependencies then runStandardSequence', async () => {
    const order: string[] = [];
    mockedEnsureRepoCloned.mockImplementation(async () => { order.push('clone'); });
    mockedWriteConfig.mockImplementation(async () => { order.push('config'); });
    mockedInstallDependencies.mockImplementation(async () => { order.push('install'); });
    mockedRunStandardSequence.mockImplementation(async () => { order.push('sequence'); });

    await runLocalFlow(BASE_ANSWERS);

    expect(order).toEqual(['clone', 'config', 'install', 'sequence']);
  });

  it('passes stateful mode to writeConfig for local-stateful target', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedWriteConfig).toHaveBeenCalledWith(
      BASE_ANSWERS.docsGeneratorDir,
      expect.objectContaining({ mode: 'stateful' }),
    );
  });

  it('passes serverless mode to writeConfig for local-serverless target', async () => {
    await runLocalFlow({ ...BASE_ANSWERS, target: 'local-serverless' });
    expect(mockedWriteConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: 'serverless' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Space creation
// ---------------------------------------------------------------------------

describe('runLocalFlow — custom space', () => {
  const CUSTOM_ANSWERS = { ...BASE_ANSWERS, space: 'my-space' };

  it('calls createSpace with the custom space id', async () => {
    await runLocalFlow(CUSTOM_ANSWERS);
    expect(mockedCreateSpace).toHaveBeenCalledWith(
      CUSTOM_ANSWERS.kibanaUrl,
      expect.any(Object),
      expect.objectContaining({ id: 'my-space' }),
    );
  });

  it('logs a warning when the space already exists (409)', async () => {
    mockedCreateSpace.mockResolvedValueOnce({
      space: { id: 'my-space', name: 'my-space' },
      alreadyExisted: true,
    });
    await runLocalFlow(CUSTOM_ANSWERS);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    );
  });

  it('continues the flow after a 409 conflict on space creation', async () => {
    mockedCreateSpace.mockResolvedValueOnce({
      space: { id: 'my-space', name: 'my-space' },
      alreadyExisted: true,
    });
    await runLocalFlow(CUSTOM_ANSWERS);
    // flow must have continued past space creation
    expect(mockedInitializeSecurityApp).toHaveBeenCalledTimes(1);
  });

  it('passes the custom space to installPrebuiltRules', async () => {
    await runLocalFlow(CUSTOM_ANSWERS);
    expect(mockedInstallPrebuiltRules).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'my-space',
    );
  });
});

// ---------------------------------------------------------------------------
// Sample data installation
// ---------------------------------------------------------------------------

describe('runLocalFlow — installSampleData: true', () => {
  const SD_ANSWERS = { ...BASE_ANSWERS, installSampleData: true };

  it('calls installSampleData for flights, ecommerce, logs in that order', async () => {
    const order: string[] = [];
    mockedInstallSampleData.mockImplementation(
      async (_url, _creds, dataset) => { order.push(dataset); },
    );
    await runLocalFlow(SD_ANSWERS);
    expect(order).toEqual(['flights', 'ecommerce', 'logs']);
  });

  it('logs a warning but continues when one dataset fails', async () => {
    mockedInstallSampleData
      .mockRejectedValueOnce(new Error('timeout')) // flights fails
      .mockResolvedValueOnce(undefined)             // ecommerce ok
      .mockResolvedValueOnce(undefined);            // logs ok

    await expect(runLocalFlow(SD_ANSWERS)).resolves.toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('flights'),
    );
    expect(mockedInstallSampleData).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// ensureNode24Installed failure
// ---------------------------------------------------------------------------

describe('runLocalFlow — Node 24 preflight failure', () => {
  it('logs the error and returns early (does not re-throw)', async () => {
    mockedEnsureNode24Installed.mockRejectedValueOnce(
      new Error('Node 24 is required'),
    );
    await expect(runLocalFlow(BASE_ANSWERS)).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Node 24 is required'),
    );
  });

  it('does not call ensureServicesRunning when Node 24 preflight fails', async () => {
    mockedEnsureNode24Installed.mockRejectedValueOnce(new Error('Node 24 missing'));
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedEnsureServicesRunning).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap check failure
// ---------------------------------------------------------------------------

describe('runLocalFlow — bootstrap check fails', () => {
  it('throws with the expected message when marker is absent', async () => {
    mockedFs.existsSync.mockReturnValueOnce(false); // marker absent
    await expect(runLocalFlow(BASE_ANSWERS)).rejects.toThrow(
      "Kibana bootstrap not found. Run 'yarn kbn bootstrap' in",
    );
  });

  it('includes the kibanaDir in the error message', async () => {
    mockedFs.existsSync.mockReturnValueOnce(false);
    await expect(runLocalFlow(BASE_ANSWERS)).rejects.toThrow(
      BASE_ANSWERS.kibanaDir,
    );
  });

  it('does not call ensureServicesRunning when bootstrap check fails', async () => {
    mockedFs.existsSync.mockReturnValueOnce(false);
    await expect(runLocalFlow(BASE_ANSWERS)).rejects.toThrow();
    expect(mockedEnsureServicesRunning).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ensureServicesRunning integration (Stage 4b)
// ---------------------------------------------------------------------------

describe('runLocalFlow — ensureServicesRunning integration', () => {
  const alreadyRunning: AutoStartResult = {
    method: 'already-running',
    kibana: true,
    elasticsearch: true,
  };
  const osascriptResult: AutoStartResult = {
    method: 'osascript',
    kibana: true,
    elasticsearch: true,
  };
  const assistedResult: AutoStartResult = {
    method: 'assisted',
    kibana: true,
    elasticsearch: true,
  };

  it('already-running → proceeds normally through step 4+', async () => {
    mockedEnsureServicesRunning.mockResolvedValueOnce(alreadyRunning);
    await expect(runLocalFlow(BASE_ANSWERS)).resolves.toBeUndefined();
    expect(mockedInitializeSecurityApp).toHaveBeenCalledTimes(1);
  });

  it('osascript → flow proceeds and summary includes method', async () => {
    mockedEnsureServicesRunning.mockResolvedValueOnce(osascriptResult);
    await expect(runLocalFlow(BASE_ANSWERS)).resolves.toBeUndefined();
    expect(mockedInitializeSecurityApp).toHaveBeenCalledTimes(1);
    // Summary is printed to console; verify the method value appears
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('osascript');
  });

  it('assisted → flow proceeds and summary includes method', async () => {
    mockedEnsureServicesRunning.mockResolvedValueOnce(assistedResult);
    await expect(runLocalFlow(BASE_ANSWERS)).resolves.toBeUndefined();
    expect(mockedInitializeSecurityApp).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('assisted');
  });

  it('propagates timeout error from ensureServicesRunning and does not call step 4+', async () => {
    mockedEnsureServicesRunning.mockRejectedValueOnce(
      new Error('Elasticsearch did not become healthy within 300s.'),
    );
    await expect(runLocalFlow(BASE_ANSWERS)).rejects.toThrow(
      'did not become healthy',
    );
    expect(mockedInitializeSecurityApp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Internal generator failure (non-fatal)
// ---------------------------------------------------------------------------

describe('runLocalFlow — internal generator fails', () => {
  it('logs a warning when runKibanaLocalGenerator rejects', async () => {
    mockedRunKibanaLocalGenerator.mockRejectedValueOnce(new Error('script crash'));
    await runLocalFlow(BASE_ANSWERS);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Kibana internal generator failed'),
    );
  });

  it('continues to run docs-generator when the internal generator fails', async () => {
    mockedRunKibanaLocalGenerator.mockRejectedValueOnce(new Error('script crash'));
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedEnsureRepoCloned).toHaveBeenCalledTimes(1);
    expect(mockedRunStandardSequence).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ensureRepoCloned failure (fatal for docs-generator)
// ---------------------------------------------------------------------------

describe('runLocalFlow — ensureRepoCloned fails', () => {
  it('propagates the clone error', async () => {
    mockedEnsureRepoCloned.mockRejectedValueOnce(new Error('git clone failed'));
    await expect(runLocalFlow(BASE_ANSWERS)).rejects.toThrow('git clone failed');
  });

  it('does not call runStandardSequence when clone fails', async () => {
    mockedEnsureRepoCloned.mockRejectedValueOnce(new Error('git clone failed'));
    await expect(runLocalFlow(BASE_ANSWERS)).rejects.toThrow();
    expect(mockedRunStandardSequence).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runGenerateEvents (step 9 — endpoint resolver trees)
// ---------------------------------------------------------------------------

describe('runLocalFlow — runGenerateEvents (endpoint event generator)', () => {
  it('calls runGenerateEvents exactly once on the happy path', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedRunGenerateEvents).toHaveBeenCalledTimes(1);
  });

  it('passes kibanaDir, kibanaUrl, and credentials to runGenerateEvents', async () => {
    await runLocalFlow(BASE_ANSWERS);
    expect(mockedRunGenerateEvents).toHaveBeenCalledWith(
      BASE_ANSWERS.kibanaDir,
      BASE_ANSWERS.kibanaUrl,
      expect.objectContaining({
        url: BASE_ANSWERS.elasticsearchUrl,
        username: BASE_ANSWERS.username,
        password: BASE_ANSWERS.password,
      }),
    );
  });

  it('runs AFTER runKibanaLocalGenerator and BEFORE ensureRepoCloned', async () => {
    const order: string[] = [];
    mockedRunKibanaLocalGenerator.mockImplementation(async () => { order.push('localGen'); });
    mockedRunGenerateEvents.mockImplementation(async () => { order.push('genEvents'); });
    mockedEnsureRepoCloned.mockImplementation(async () => { order.push('clone'); });
    mockedRunStandardSequence.mockImplementation(async () => { order.push('sequence'); });

    await runLocalFlow(BASE_ANSWERS);

    const iLocal = order.indexOf('localGen');
    const iEvents = order.indexOf('genEvents');
    const iClone = order.indexOf('clone');
    const iSeq = order.indexOf('sequence');

    expect(iLocal).toBeLessThan(iEvents);
    expect(iEvents).toBeLessThan(iClone);
    expect(iClone).toBeLessThan(iSeq);
  });

  it('logs a warning and continues to docs-generator when runGenerateEvents rejects', async () => {
    mockedRunGenerateEvents.mockRejectedValueOnce(new Error('test:generate crash'));
    await runLocalFlow(BASE_ANSWERS);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Endpoint event generator failed'),
    );
    expect(mockedEnsureRepoCloned).toHaveBeenCalledTimes(1);
    expect(mockedRunStandardSequence).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Data generation conditional execution (Stage 4.15)
// ---------------------------------------------------------------------------

describe('runLocalFlow — data generation conditional execution', () => {
  const NO_GEN: LocalWizardAnswers = {
    ...BASE_ANSWERS,
    generateAlertsAndCases: false,
    generateEvents: false,
    generateExtended: false,
  };

  it('all flags true → all generator functions called', async () => {
    await runLocalFlow(BASE_ANSWERS); // BASE_ANSWERS has all three flags true
    expect(mockedRunKibanaLocalGenerator).toHaveBeenCalledTimes(1);
    expect(mockedRunGenerateEvents).toHaveBeenCalledTimes(1);
    expect(mockedEnsureRepoCloned).toHaveBeenCalledTimes(1);
    expect(mockedRunStandardSequence).toHaveBeenCalledTimes(1);
  });

  it('all flags false → no generator functions called; flow still reaches summary', async () => {
    await runLocalFlow(NO_GEN);
    expect(mockedRunKibanaLocalGenerator).not.toHaveBeenCalled();
    expect(mockedRunGenerateEvents).not.toHaveBeenCalled();
    expect(mockedEnsureRepoCloned).not.toHaveBeenCalled();
    expect(mockedRunStandardSequence).not.toHaveBeenCalled();
    // Summary still printed
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Local Environment Ready');
  });

  it('only generateAlertsAndCases true → only runKibanaLocalGenerator called', async () => {
    await runLocalFlow({ ...NO_GEN, generateAlertsAndCases: true });
    expect(mockedRunKibanaLocalGenerator).toHaveBeenCalledTimes(1);
    expect(mockedRunGenerateEvents).not.toHaveBeenCalled();
    expect(mockedEnsureRepoCloned).not.toHaveBeenCalled();
    expect(mockedRunStandardSequence).not.toHaveBeenCalled();
  });

  it('only generateEvents true → only runGenerateEvents called', async () => {
    await runLocalFlow({ ...NO_GEN, generateEvents: true });
    expect(mockedRunKibanaLocalGenerator).not.toHaveBeenCalled();
    expect(mockedRunGenerateEvents).toHaveBeenCalledTimes(1);
    expect(mockedEnsureRepoCloned).not.toHaveBeenCalled();
    expect(mockedRunStandardSequence).not.toHaveBeenCalled();
  });

  it('only generateExtended true → only docs-generator chain called', async () => {
    await runLocalFlow({ ...NO_GEN, generateExtended: true });
    expect(mockedRunKibanaLocalGenerator).not.toHaveBeenCalled();
    expect(mockedRunGenerateEvents).not.toHaveBeenCalled();
    expect(mockedEnsureRepoCloned).toHaveBeenCalledTimes(1);
    expect(mockedWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockedInstallDependencies).toHaveBeenCalledTimes(1);
    expect(mockedRunStandardSequence).toHaveBeenCalledTimes(1);
  });
});
