import fs from 'fs';

jest.mock('fs');
jest.mock('inquirer');

import * as inquirer from 'inquirer';
import { runWizard } from '@wizard/prompts';
import type { WizardResult } from '@types-local/index';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedInquirer = inquirer as jest.Mocked<typeof inquirer>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow the wizard result to the ECH branch, failing fast if not ECH. */
type EchResult = Extract<WizardResult, { target: 'elastic-cloud' }>;
async function runEchWizard(): Promise<EchResult> {
  const r = await runWizard();
  if (r.target !== 'elastic-cloud') throw new Error('Expected ECH result');
  return r;
}

// Build a minimal sequence of mock prompt responses for a happy-path ECH run.
function setupPrompts(overrides: {
  target?: string;
  name?: string;
  environment?: string;
  region?: string;
  version?: string;
  spaceCount?: number;
  spaceNames?: string[];
  dataChoices?: string[];
  repoPath?: string;
  additionalDataSpaces?: string[];
} = {}): void {
  const {
    target = 'elastic-cloud',
    name = 'my-test-deploy',
    environment = 'prod',
    region = 'gcp-us-central1',
    version = '8.17.1',
    spaceCount = 1,
    spaceNames = ['Security'],
    dataChoices = [],
    repoPath,
    additionalDataSpaces = [],
  } = overrides;

  // Call 0: target
  mockedInquirer.prompt.mockResolvedValueOnce({ target });
  // Call 1: name + environment
  mockedInquirer.prompt.mockResolvedValueOnce({ name, environment });
  // Call 2: region
  mockedInquirer.prompt.mockResolvedValueOnce({ region });
  // Call 3: version
  mockedInquirer.prompt.mockResolvedValueOnce({ version });
  // Call 4: spaceCount
  mockedInquirer.prompt.mockResolvedValueOnce({ spaceCount });
  // Calls 5..N: space names
  for (const spaceName of spaceNames.slice(0, spaceCount)) {
    mockedInquirer.prompt.mockResolvedValueOnce({ spaceName });
  }
  // Call after spaces: dataChoices
  mockedInquirer.prompt.mockResolvedValueOnce({ dataChoices });
  // Optional call: repoPath + additionalDataSpaces (combined prompt, only when dataChoices is non-empty)
  if (dataChoices.length > 0 && repoPath !== undefined) {
    mockedInquirer.prompt.mockResolvedValueOnce({ repoPath, additionalDataSpaces });
  } else if (dataChoices.length > 0) {
    mockedInquirer.prompt.mockResolvedValueOnce({ repoPath: '', additionalDataSpaces: [] });
  }
}

/**
 * Mock all prompt calls needed for a local-target wizard run.
 *
 * Prompt call structure after Stage 4.15:
 *   Call 0: target selector
 *   Call 1: main batch (kibanaDir … volume, 7 questions)
 *   Call 2: dataChoices checkbox
 *   Call 3: docsGeneratorDir input (only when dataChoices includes 'extended')
 *   Call 4 (or 3 when no extended): installSampleData confirm
 */
function setupLocalPrompts(
  target: 'local-stateful' | 'local-serverless',
  overrides: Record<string, unknown> = {},
): void {
  // Pull out fields that go into separate calls; the rest go into the batch.
  const {
    dataChoices: dataChoicesOverride,
    docsGeneratorDir: docsGenDirOverride,
    installSampleData: installSampleDataOverride,
    ...batchOverrides
  } = overrides;

  const dataChoices = (dataChoicesOverride as string[] | undefined) ?? [];
  const generateExtended = dataChoices.includes('extended');

  // Call 0: target
  mockedInquirer.prompt.mockResolvedValueOnce({ target });

  // Call 1: main batch (kibanaDir … volume)
  mockedInquirer.prompt.mockResolvedValueOnce({
    kibanaDir: '/home/user/kibana',
    kibanaUrl: 'http://localhost:5601',
    elasticsearchUrl: 'http://localhost:9200',
    username: target === 'local-stateful' ? 'elastic' : 'elastic_serverless',
    password: 'changeme',
    space: 'default',
    volume: 'medium',
    ...batchOverrides,
  });

  // Call 2: dataChoices
  mockedInquirer.prompt.mockResolvedValueOnce({ dataChoices });

  // Call 3: docsGeneratorDir (only when extended selected)
  if (generateExtended) {
    mockedInquirer.prompt.mockResolvedValueOnce({
      docsGeneratorDir:
        (docsGenDirOverride as string | undefined) ??
        '/home/user/security-documents-generator',
    });
  }

  // Last call: installSampleData
  mockedInquirer.prompt.mockResolvedValueOnce({
    installSampleData: (installSampleDataOverride as boolean | undefined) ?? false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(true);
  (mockedFs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });
});

// ---------------------------------------------------------------------------
// ECH Validator / filter tests
// ---------------------------------------------------------------------------

describe('ECH prompt validator and filter functions', () => {
  let promptCalls: Array<Array<Record<string, unknown>>>;

  beforeAll(async () => {
    jest.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
    setupPrompts({ dataChoices: ['alerts'], repoPath: '/repo', spaceCount: 1 });
    await runWizard();
    promptCalls = mockedInquirer.prompt.mock.calls.map(
      (call) => call[0] as Array<Record<string, unknown>>,
    );
  });

  function getQuestion(callIndex: number, questionIndex = 0) {
    return promptCalls[callIndex][questionIndex] as {
      validate?: (v: string) => boolean | string;
      filter?: (v: string) => unknown;
    };
  }

  // ── Call 1, question 0: deployment name ──────────────────────────────────

  it('name validate — rejects empty input', () => {
    const { validate } = getQuestion(1, 0);
    expect(validate?.('')).toContain('required');
  });

  it('name validate — rejects name with special chars', () => {
    const { validate } = getQuestion(1, 0);
    expect(validate?.('bad name!')).toContain('alphanumeric');
  });

  it('name validate — accepts alphanumeric-hyphen name', () => {
    const { validate } = getQuestion(1, 0);
    expect(validate?.('my-deploy-1')).toBe(true);
  });

  it('name filter — trims whitespace', () => {
    const { filter } = getQuestion(1, 0);
    expect(filter?.('  trimmed  ')).toBe('trimmed');
  });

  // ── Call 3, question 0: version ──────────────────────────────────────────

  it('version validate — rejects non-semver string', () => {
    const { validate } = getQuestion(3, 0);
    expect(validate?.('not-semver')).toContain('semver');
  });

  it('version validate — accepts valid semver', () => {
    const { validate } = getQuestion(3, 0);
    expect(validate?.('8.17.1')).toBe(true);
  });

  it('version filter — trims whitespace', () => {
    const { filter } = getQuestion(3, 0);
    expect(filter?.('  8.17.1  ')).toBe('8.17.1');
  });

  // ── Call 4, question 0: spaceCount ───────────────────────────────────────

  it('spaceCount validate — rejects 0', () => {
    const { validate } = getQuestion(4, 0);
    expect(validate?.('0')).toContain('whole number');
  });

  it('spaceCount validate — rejects 11', () => {
    const { validate } = getQuestion(4, 0);
    expect(validate?.('11')).toContain('whole number');
  });

  it('spaceCount validate — rejects non-integer', () => {
    const { validate } = getQuestion(4, 0);
    expect(validate?.('1.5')).toContain('whole number');
  });

  it('spaceCount validate — accepts 1 through 10', () => {
    const { validate } = getQuestion(4, 0);
    expect(validate?.('1')).toBe(true);
    expect(validate?.('10')).toBe(true);
  });

  it('spaceCount filter — parses string to number', () => {
    const { filter } = getQuestion(4, 0);
    expect(filter?.('3')).toBe(3);
  });

  // ── Call 5, question 0: spaceName ────────────────────────────────────────

  it('spaceName validate — rejects empty string', () => {
    const { validate } = getQuestion(5, 0);
    expect(validate?.('')).toContain('required');
  });

  it('spaceName validate — accepts a name not already in the spaces list', () => {
    const { validate } = getQuestion(5, 0);
    expect(validate?.('Unique Space Name')).toBe(true);
  });

  it('spaceName validate — rejects name that produces a duplicate ID', () => {
    const { validate } = getQuestion(5, 0);
    expect(validate?.('SECURITY')).toContain('already exists');
  });

  it('spaceName filter — trims whitespace', () => {
    const { filter } = getQuestion(5, 0);
    expect(filter?.('  Security  ')).toBe('Security');
  });

  // ── Last call (with data gen): repoPath ──────────────────────────────────

  it('repoPath validate — accepts empty string (skip)', () => {
    const lastCallIndex = promptCalls.length - 1;
    const { validate } = getQuestion(lastCallIndex, 0);
    expect(validate?.('')).toBe(true);
  });

  it('repoPath validate — rejects non-existent path', () => {
    const lastCallIndex = promptCalls.length - 1;
    const { validate } = getQuestion(lastCallIndex, 0);
    mockedFs.existsSync.mockReturnValueOnce(false);
    expect(validate?.('/nonexistent')).toContain('Path does not exist');
  });

  it('repoPath validate — accepts existing path', () => {
    const lastCallIndex = promptCalls.length - 1;
    const { validate } = getQuestion(lastCallIndex, 0);
    mockedFs.existsSync.mockReturnValueOnce(true);
    expect(validate?.('/home/user/kibana')).toBe(true);
  });

  it('repoPath filter — trims whitespace', () => {
    const lastCallIndex = promptCalls.length - 1;
    const { filter } = getQuestion(lastCallIndex, 0);
    expect(filter?.('  /repo  ')).toBe('/repo');
  });

  // ── Last call, question 1: additionalDataSpaces ──────────────────────────

  it('additionalDataSpaces when — shown when repoPath is set, non-default spaces exist, and alerts/cases are selected', () => {
    const lastCallIndex = promptCalls.length - 1;
    const q = promptCalls[lastCallIndex][1] as { when?: (a: Record<string, unknown>) => boolean };
    expect(q.when?.({ repoPath: '/repo' })).toBe(true);
  });

  it('additionalDataSpaces when — hidden when repoPath is empty', () => {
    const lastCallIndex = promptCalls.length - 1;
    const q = promptCalls[lastCallIndex][1] as { when?: (a: Record<string, unknown>) => boolean };
    expect(q.when?.({ repoPath: '' })).toBe(false);
  });

  it('additionalDataSpaces when — hidden for events-only data generation', async () => {
    jest.clearAllMocks();
    setupPrompts({ dataChoices: ['events'], repoPath: '/repo' });
    await runWizard();

    const eventsOnlyCalls = mockedInquirer.prompt.mock.calls.map(
      (call) => call[0] as Array<Record<string, unknown>>,
    );
    const lastCallIndex = eventsOnlyCalls.length - 1;
    const q = eventsOnlyCalls[lastCallIndex][1] as { when?: (a: Record<string, unknown>) => boolean };
    expect(q.when?.({ repoPath: '/repo' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ECH runWizard happy-path tests
// ---------------------------------------------------------------------------

describe('runWizard — ECH target', () => {
  it('returns target: elastic-cloud in the happy-path result', async () => {
    setupPrompts();
    const result = await runWizard();
    expect(result.target).toBe('elastic-cloud');
  });

  it('returns the deployment config from happy-path answers', async () => {
    setupPrompts();
    const result = await runEchWizard();

    expect(result.config.name).toBe('my-test-deploy');
    expect(result.environment).toBe('prod');
    expect(result.config.region).toBe('gcp-us-central1');
    expect(result.config.version).toBe('8.17.1');
    expect(result.config.spaces).toHaveLength(1);
    expect(result.config.spaces[0].id).toBe('security');
    expect(result.config.spaces[0].name).toBe('Security');
  });

  it('converts space name to lowercase hyphenated id', async () => {
    setupPrompts({ spaceNames: ['My Cool Space'], spaceCount: 1 });
    const result = await runEchWizard();
    expect(result.config.spaces[0].id).toBe('my-cool-space');
  });

  it('creates multiple spaces when spaceCount > 1', async () => {
    setupPrompts({ spaceCount: 2, spaceNames: ['Security', 'DevOps'] });
    const result = await runEchWizard();
    expect(result.config.spaces).toHaveLength(2);
    expect(result.config.spaces[0].name).toBe('Security');
    expect(result.config.spaces[1].name).toBe('DevOps');
  });

  it('does not prompt for repo path when no data types selected', async () => {
    setupPrompts({ dataChoices: [] });
    const result = await runEchWizard();
    expect(result.config.dataTypes.kibanaRepoPath).toBe('');
    expect(result.config.dataTypes.generateAlerts).toBe(false);
    expect(result.config.dataTypes.generateCases).toBe(false);
    expect(result.config.dataTypes.generateEvents).toBe(false);
  });

  it('prompts for repo path when alerts are selected', async () => {
    setupPrompts({ dataChoices: ['alerts'], repoPath: '/home/user/kibana' });
    const result = await runEchWizard();
    expect(result.config.dataTypes.generateAlerts).toBe(true);
    expect(result.config.dataTypes.kibanaRepoPath).toBe('/home/user/kibana');
  });

  it('sets generateCases when cases selected', async () => {
    setupPrompts({ dataChoices: ['cases'], repoPath: '/repo' });
    const result = await runEchWizard();
    expect(result.config.dataTypes.generateCases).toBe(true);
    expect(result.config.dataTypes.generateAlerts).toBe(false);
  });

  it('sets generateEvents when events selected', async () => {
    setupPrompts({ dataChoices: ['events'], repoPath: '/repo' });
    const result = await runEchWizard();
    expect(result.config.dataTypes.generateEvents).toBe(true);
    expect(result.config.additionalDataSpaces).toEqual([]);
  });

  it('sets all three data types when all selected', async () => {
    setupPrompts({ dataChoices: ['alerts', 'cases', 'events'], repoPath: '/repo' });
    const result = await runEchWizard();
    const { generateAlerts, generateCases, generateEvents } = result.config.dataTypes;
    expect(generateAlerts).toBe(true);
    expect(generateCases).toBe(true);
    expect(generateEvents).toBe(true);
  });

  it('returns empty kibanaRepoPath when user skips the repo prompt', async () => {
    setupPrompts({ dataChoices: ['alerts'], repoPath: '' });
    const result = await runEchWizard();
    expect(result.config.dataTypes.kibanaRepoPath).toBe('');
  });

  it('works with qa environment and qa-specific region', async () => {
    setupPrompts({ environment: 'qa', region: 'gcp-us-west2' });
    const result = await runEchWizard();
    expect(result.environment).toBe('qa');
    expect(result.config.region).toBe('gcp-us-west2');
  });

  it('works with staging environment', async () => {
    setupPrompts({ environment: 'staging', region: 'gcp-europe-west1' });
    const result = await runEchWizard();
    expect(result.environment).toBe('staging');
  });

  it('preserves the custom version string', async () => {
    setupPrompts({ version: '8.18.0' });
    const result = await runEchWizard();
    expect(result.config.version).toBe('8.18.0');
  });

  it('returns selected additionalDataSpaces from wizard answers', async () => {
    setupPrompts({
      dataChoices: ['alerts'],
      repoPath: '/repo',
      spaceCount: 2,
      spaceNames: ['Security', 'DevOps'],
      additionalDataSpaces: ['devops'],
    });
    const result = await runEchWizard();
    expect(result.config.additionalDataSpaces).toEqual(['devops']);
  });

  it('returns empty additionalDataSpaces when repoPath is empty', async () => {
    setupPrompts({
      dataChoices: ['alerts'],
      repoPath: '',
      spaceCount: 2,
      spaceNames: ['Security', 'DevOps'],
      additionalDataSpaces: [],
    });
    const result = await runEchWizard();
    expect(result.config.additionalDataSpaces).toEqual([]);
  });

  it('returns empty additionalDataSpaces when no data types selected', async () => {
    setupPrompts({ dataChoices: [] });
    const result = await runEchWizard();
    expect(result.config.additionalDataSpaces).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Local prompt validator tests
// ---------------------------------------------------------------------------

describe('local prompt validators and filter functions', () => {
  let localPromptCalls: Array<Array<Record<string, unknown>>>;

  // Run the wizard with extended selected so ALL local prompt calls fire,
  // giving us access to every question's validate/filter including docsGeneratorDir.
  beforeAll(async () => {
    jest.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });
    setupLocalPrompts('local-stateful', { dataChoices: ['extended'] });
    await runWizard();
    localPromptCalls = mockedInquirer.prompt.mock.calls.map(
      (call) => call[0] as Array<Record<string, unknown>>,
    );
  });

  function getLocalQ(questionIndex: number) {
    // Call 0 = target selector, call 1 = 7 batch questions (kibanaDir…volume)
    return localPromptCalls[1]?.[questionIndex] as {
      validate?: (v: string) => boolean | string;
      filter?: (v: string) => string;
      default?: unknown;
    };
  }

  function getDocsGenQ() {
    // Call 3 = docsGeneratorDir (only present when extended is selected)
    return localPromptCalls[3]?.[0] as {
      validate?: (v: string) => boolean | string;
      filter?: (v: string) => string;
      default?: unknown;
    };
  }

  // ── index 0: kibanaDir ───────────────────────────────────────────────────

  it('kibanaDir validate — rejects non-existent path', () => {
    const { validate } = getLocalQ(0);
    mockedFs.existsSync.mockReturnValueOnce(false);
    expect(validate?.('/nonexistent')).toContain('does not exist');
  });

  it('kibanaDir validate — rejects path that is not a directory', () => {
    const { validate } = getLocalQ(0);
    mockedFs.existsSync.mockReturnValueOnce(true);
    (mockedFs.statSync as jest.Mock).mockReturnValueOnce({ isDirectory: () => false });
    expect(validate?.('/some-file')).toContain('not a directory');
  });

  it('kibanaDir validate — rejects path without .git', () => {
    const { validate } = getLocalQ(0);
    mockedFs.existsSync.mockReturnValueOnce(true);   // path exists
    (mockedFs.statSync as jest.Mock).mockReturnValueOnce({ isDirectory: () => true });
    mockedFs.existsSync.mockReturnValueOnce(false);  // .git absent
    expect(validate?.('/home/user/not-a-repo')).toContain('.git');
  });

  it('kibanaDir validate — accepts valid kibana checkout', () => {
    const { validate } = getLocalQ(0);
    mockedFs.existsSync.mockReturnValueOnce(true);  // path exists
    (mockedFs.statSync as jest.Mock).mockReturnValueOnce({ isDirectory: () => true });
    mockedFs.existsSync.mockReturnValueOnce(true);  // .git present
    expect(validate?.('/home/user/kibana')).toBe(true);
  });

  it('kibanaDir validate — accepts valid path even without @kbn/test-es-server (not checked here)', () => {
    const { validate } = getLocalQ(0);
    mockedFs.existsSync.mockReturnValueOnce(true);
    (mockedFs.statSync as jest.Mock).mockReturnValueOnce({ isDirectory: () => true });
    mockedFs.existsSync.mockReturnValueOnce(true);
    expect(validate?.('/home/user/kibana')).toBe(true);
  });

  it('kibanaDir filter — trims whitespace', () => {
    const { filter } = getLocalQ(0);
    expect(filter?.('  /home/user/kibana  ')).toBe('/home/user/kibana');
  });

  // ── index 1: kibanaUrl ───────────────────────────────────────────────────

  it('kibanaUrl validate — rejects empty string', () => {
    const { validate } = getLocalQ(1);
    expect(validate?.('')).toContain('required');
  });

  it('kibanaUrl validate — rejects non-http URL', () => {
    const { validate } = getLocalQ(1);
    expect(validate?.('ftp://localhost')).toContain('http');
  });

  it('kibanaUrl validate — accepts http URL', () => {
    const { validate } = getLocalQ(1);
    expect(validate?.('http://localhost:5601')).toBe(true);
  });

  it('kibanaUrl validate — accepts https URL', () => {
    const { validate } = getLocalQ(1);
    expect(validate?.('https://localhost:5601')).toBe(true);
  });

  // ── index 2: elasticsearchUrl ────────────────────────────────────────────

  it('elasticsearchUrl validate — rejects empty string', () => {
    const { validate } = getLocalQ(2);
    expect(validate?.('')).toContain('required');
  });

  it('elasticsearchUrl validate — rejects non-http URL', () => {
    const { validate } = getLocalQ(2);
    expect(validate?.('amqp://localhost')).toContain('http');
  });

  it('elasticsearchUrl validate — accepts http URL', () => {
    const { validate } = getLocalQ(2);
    expect(validate?.('http://localhost:9200')).toBe(true);
  });

  // ── index 3: username ────────────────────────────────────────────────────

  it('username validate — rejects empty string', () => {
    const { validate } = getLocalQ(3);
    expect(validate?.('')).toContain('required');
  });

  it('username validate — accepts non-empty string', () => {
    const { validate } = getLocalQ(3);
    expect(validate?.('elastic')).toBe(true);
  });

  // ── index 4: password ────────────────────────────────────────────────────

  it('password validate — rejects empty string', () => {
    const { validate } = getLocalQ(4);
    expect(validate?.('')).toContain('required');
  });

  it('password validate — accepts non-empty string', () => {
    const { validate } = getLocalQ(4);
    expect(validate?.('changeme')).toBe(true);
  });

  // ── index 5: space ───────────────────────────────────────────────────────

  it('space validate — rejects ID starting with a hyphen', () => {
    const { validate } = getLocalQ(5);
    const result = validate?.('-bad');
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });

  it('space validate — rejects ID with uppercase letters', () => {
    const { validate } = getLocalQ(5);
    expect(validate?.('MySpace')).not.toBe(true);
  });

  it('space validate — accepts "default"', () => {
    const { validate } = getLocalQ(5);
    expect(validate?.('default')).toBe(true);
  });

  it('space validate — accepts ID with hyphens and underscores', () => {
    const { validate } = getLocalQ(5);
    expect(validate?.('my-space_1')).toBe(true);
  });

  // ── docsGeneratorDir (call 3 when extended selected) ──────────────────────

  it('docsGeneratorDir validate — rejects relative path', () => {
    const { validate } = getDocsGenQ();
    expect(validate?.('relative/path')).toContain('absolute');
  });

  it('docsGeneratorDir validate — rejects path with space', () => {
    const { validate } = getDocsGenQ();
    expect(validate?.('/home/user/my docs')).toContain('unsafe');
  });

  it("docsGeneratorDir validate — rejects path with single quote", () => {
    const { validate } = getDocsGenQ();
    expect(validate?.("/home/user/user's-dir")).toContain('unsafe');
  });

  it('docsGeneratorDir validate — rejects path with dollar sign', () => {
    const { validate } = getDocsGenQ();
    expect(validate?.('/home/user/$HOME')).toContain('unsafe');
  });

  it('docsGeneratorDir validate — accepts valid absolute path', () => {
    const { validate } = getDocsGenQ();
    expect(validate?.('/home/user/security-docs')).toBe(true);
  });

  it('docsGeneratorDir filter — trims whitespace', () => {
    const { filter } = getDocsGenQ();
    expect(filter?.('  /home/user/docs  ')).toBe('/home/user/docs');
  });
});

// ---------------------------------------------------------------------------
// Local prompt defaults
// ---------------------------------------------------------------------------

describe('local prompt defaults', () => {
  /** Access a question in the main batch (call 1, indices 0–6). */
  function getBatchQ(
    calls: Array<Array<Record<string, unknown>>>,
    questionIndex: number,
  ) {
    return calls[1]?.[questionIndex] as { default?: unknown };
  }

  /** installSampleData is the last call (call 3 when no extended, question 0). */
  function getInstallSampleDataQ(calls: Array<Array<Record<string, unknown>>>) {
    // Without extended, prompt calls are: target(0), batch(1), dataChoices(2), installSampleData(3)
    return calls[3]?.[0] as { default?: unknown };
  }

  it('username default is "elastic" for local-stateful', async () => {
    setupLocalPrompts('local-stateful');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getBatchQ(calls, 3).default).toBe('elastic');
  });

  it('username default is "elastic_serverless" for local-serverless', async () => {
    setupLocalPrompts('local-serverless');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getBatchQ(calls, 3).default).toBe('elastic_serverless');
  });

  it('volume default is "medium"', async () => {
    setupLocalPrompts('local-stateful');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getBatchQ(calls, 6).default).toBe('medium');
  });

  it('sample data default is false', async () => {
    setupLocalPrompts('local-stateful');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getInstallSampleDataQ(calls).default).toBe(false);
  });

  it('kibanaUrl default is http://localhost:5601', async () => {
    setupLocalPrompts('local-stateful');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getBatchQ(calls, 1).default).toBe('http://localhost:5601');
  });

  it('elasticsearchUrl default is http://localhost:9200', async () => {
    setupLocalPrompts('local-stateful');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getBatchQ(calls, 2).default).toBe('http://localhost:9200');
  });

  it('space default is "default"', async () => {
    setupLocalPrompts('local-stateful');
    await runWizard();
    const calls = mockedInquirer.prompt.mock.calls.map(
      (c) => c[0] as Array<Record<string, unknown>>,
    );
    expect(getBatchQ(calls, 5).default).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// runWizard — local targets return shape
// ---------------------------------------------------------------------------

describe('runWizard — local targets', () => {
  it('returns LocalWizardAnswers for local-stateful', async () => {
    setupLocalPrompts('local-stateful');
    const result = await runWizard();
    expect(result.target).toBe('local-stateful');
    // LocalWizardAnswers-specific fields must be present at the top level
    if (result.target !== 'local-stateful' && result.target !== 'local-serverless') {
      throw new Error('Expected local result');
    }
    expect(result.kibanaDir).toBe('/home/user/kibana');
    expect(result.kibanaUrl).toBe('http://localhost:5601');
    expect(result.username).toBe('elastic');
  });

  it('returns LocalWizardAnswers for local-serverless', async () => {
    setupLocalPrompts('local-serverless');
    const result = await runWizard();
    expect(result.target).toBe('local-serverless');
    if (result.target !== 'local-stateful' && result.target !== 'local-serverless') {
      throw new Error('Expected local result');
    }
    expect(result.username).toBe('elastic_serverless');
  });

  it('fires exactly 4 prompt calls for local targets without extended (target + batch + dataChoices + installSampleData)', async () => {
    setupLocalPrompts('local-stateful'); // dataChoices defaults to []
    await runWizard();
    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(4);
  });

  it('fires exactly 5 prompt calls when extended is selected (adds docsGeneratorDir call)', async () => {
    setupLocalPrompts('local-stateful', { dataChoices: ['extended'] });
    await runWizard();
    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(5);
  });

  it('passes through all local answer fields to the returned object', async () => {
    setupLocalPrompts('local-stateful', { space: 'my-space', volume: 'heavy' });
    const result = await runWizard();
    if (result.target !== 'local-stateful' && result.target !== 'local-serverless') {
      throw new Error('Expected local result');
    }
    expect(result.space).toBe('my-space');
    expect(result.volume).toBe('heavy');
  });
});

// ---------------------------------------------------------------------------
// runLocalPrompts — dataChoices checkbox (Stage 4.15)
// ---------------------------------------------------------------------------

describe('runLocalPrompts — dataChoices checkbox', () => {
  /** Helper: run the wizard and narrow to a local result. */
  async function runLocal() {
    const result = await runWizard();
    if (result.target !== 'local-stateful' && result.target !== 'local-serverless') {
      throw new Error('Expected local result');
    }
    return result;
  }

  /** Collect all prompt names across every mock call. */
  function allPromptNames(): string[] {
    return (mockedInquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>).mock.calls
      .flatMap((call) => (call[0] as Array<{ name: string }>).map((p) => p.name));
  }

  it('all four choices selected → all three flags true and docsGeneratorDir prompt called', async () => {
    setupLocalPrompts('local-stateful', {
      dataChoices: ['alerts', 'cases', 'events', 'extended'],
    });
    const result = await runLocal();
    expect(result.generateAlertsAndCases).toBe(true);
    expect(result.generateEvents).toBe(true);
    expect(result.generateExtended).toBe(true);
    expect(result.docsGeneratorDir).toBe('/home/user/security-documents-generator');
    expect(allPromptNames()).toContain('docsGeneratorDir');
  });

  it('only events selected → generateAlertsAndCases false, generateEvents true, generateExtended false, docsGeneratorDir empty', async () => {
    setupLocalPrompts('local-stateful', { dataChoices: ['events'] });
    const result = await runLocal();
    expect(result.generateAlertsAndCases).toBe(false);
    expect(result.generateEvents).toBe(true);
    expect(result.generateExtended).toBe(false);
    expect(result.docsGeneratorDir).toBe('');
    expect(allPromptNames()).not.toContain('docsGeneratorDir');
  });

  it('only extended selected → flags are false/false/true and docsGeneratorDir prompt called', async () => {
    setupLocalPrompts('local-stateful', {
      dataChoices: ['extended'],
      docsGeneratorDir: '/custom/docs-gen',
    });
    const result = await runLocal();
    expect(result.generateAlertsAndCases).toBe(false);
    expect(result.generateEvents).toBe(false);
    expect(result.generateExtended).toBe(true);
    expect(result.docsGeneratorDir).toBe('/custom/docs-gen');
    expect(allPromptNames()).toContain('docsGeneratorDir');
  });

  it('only alerts selected → generateAlertsAndCases true (OR logic with cases)', async () => {
    setupLocalPrompts('local-stateful', { dataChoices: ['alerts'] });
    const result = await runLocal();
    expect(result.generateAlertsAndCases).toBe(true);
    expect(result.generateEvents).toBe(false);
    expect(result.generateExtended).toBe(false);
  });

  it('only cases selected → generateAlertsAndCases true (OR logic with alerts)', async () => {
    setupLocalPrompts('local-stateful', { dataChoices: ['cases'] });
    const result = await runLocal();
    expect(result.generateAlertsAndCases).toBe(true);
    expect(result.generateEvents).toBe(false);
    expect(result.generateExtended).toBe(false);
  });

  it('nothing selected → all three flags false, docsGeneratorDir empty, prompt not called', async () => {
    setupLocalPrompts('local-stateful', { dataChoices: [] });
    const result = await runLocal();
    expect(result.generateAlertsAndCases).toBe(false);
    expect(result.generateEvents).toBe(false);
    expect(result.generateExtended).toBe(false);
    expect(result.docsGeneratorDir).toBe('');
    expect(allPromptNames()).not.toContain('docsGeneratorDir');
  });
});
