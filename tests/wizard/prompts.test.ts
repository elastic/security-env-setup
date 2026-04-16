import fs from 'fs';

jest.mock('fs');
jest.mock('inquirer');

import * as inquirer from 'inquirer';
import { runWizard } from '@wizard/prompts';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedInquirer = inquirer as jest.Mocked<typeof inquirer>;

// Build a minimal sequence of mock prompt responses for a happy-path run.
// Each call to inquirer.prompt() in runWizard is mocked in order.
function setupPrompts(overrides: {
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

beforeEach(() => {
  jest.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Validator / filter tests
// These functions are passed as callbacks to inquirer but never invoked by the
// mock. We extract them from the captured call arguments and test them directly.
// ---------------------------------------------------------------------------

describe('prompt validator and filter functions', () => {
  // Run the wizard once with data-gen selected so ALL prompt calls fire,
  // giving us access to every question's validate/filter functions.
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

  // ── Call 0, question 0: deployment name ──────────────────────────────────

  it('name validate — rejects empty input', () => {
    const { validate } = getQuestion(0, 0);
    expect(validate?.('')).toContain('required');
  });

  it('name validate — rejects name with special chars', () => {
    const { validate } = getQuestion(0, 0);
    expect(validate?.('bad name!')).toContain('alphanumeric');
  });

  it('name validate — accepts alphanumeric-hyphen name', () => {
    const { validate } = getQuestion(0, 0);
    expect(validate?.('my-deploy-1')).toBe(true);
  });

  it('name filter — trims whitespace', () => {
    const { filter } = getQuestion(0, 0);
    expect(filter?.('  trimmed  ')).toBe('trimmed');
  });

  // ── Call 2, question 0: version ──────────────────────────────────────────

  it('version validate — rejects non-semver string', () => {
    const { validate } = getQuestion(2, 0);
    expect(validate?.('not-semver')).toContain('semver');
  });

  it('version validate — accepts valid semver', () => {
    const { validate } = getQuestion(2, 0);
    expect(validate?.('8.17.1')).toBe(true);
  });

  it('version filter — trims whitespace', () => {
    const { filter } = getQuestion(2, 0);
    expect(filter?.('  8.17.1  ')).toBe('8.17.1');
  });

  // ── Call 3, question 0: spaceCount ───────────────────────────────────────

  it('spaceCount validate — rejects 0', () => {
    const { validate } = getQuestion(3, 0);
    expect(validate?.('0')).toContain('whole number');
  });

  it('spaceCount validate — rejects 11', () => {
    const { validate } = getQuestion(3, 0);
    expect(validate?.('11')).toContain('whole number');
  });

  it('spaceCount validate — rejects non-integer', () => {
    const { validate } = getQuestion(3, 0);
    expect(validate?.('1.5')).toContain('whole number');
  });

  it('spaceCount validate — accepts 1 through 10', () => {
    const { validate } = getQuestion(3, 0);
    expect(validate?.('1')).toBe(true);
    expect(validate?.('10')).toBe(true);
  });

  it('spaceCount filter — parses string to number', () => {
    const { filter } = getQuestion(3, 0);
    expect(filter?.('3')).toBe(3);
  });

  // ── Call 4, question 0: spaceName ────────────────────────────────────────

  it('spaceName validate — rejects empty string', () => {
    const { validate } = getQuestion(4, 0);
    expect(validate?.('')).toContain('required');
  });

  it('spaceName validate — accepts a name not already in the spaces list', () => {
    const { validate } = getQuestion(4, 0);
    // 'Security' is already in the closed-over spaces array from the beforeAll run,
    // so use a different name to test the happy path.
    expect(validate?.('Unique Space Name')).toBe(true);
  });

  it('spaceName validate — rejects name that produces a duplicate ID', () => {
    const { validate } = getQuestion(4, 0);
    // 'SECURITY' → nameToId → 'security', which already exists from the beforeAll run
    expect(validate?.('SECURITY')).toContain('already exists');
  });

  it('spaceName filter — trims whitespace', () => {
    const { filter } = getQuestion(4, 0);
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

describe('runWizard', () => {
  it('returns the deployment config from happy-path answers', async () => {
    setupPrompts();
    const result = await runWizard();

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
    const result = await runWizard();
    expect(result.config.spaces[0].id).toBe('my-cool-space');
  });

  it('creates multiple spaces when spaceCount > 1', async () => {
    setupPrompts({
      spaceCount: 2,
      spaceNames: ['Security', 'DevOps'],
    });
    const result = await runWizard();
    expect(result.config.spaces).toHaveLength(2);
    expect(result.config.spaces[0].name).toBe('Security');
    expect(result.config.spaces[1].name).toBe('DevOps');
  });

  it('does not prompt for repo path when no data types selected', async () => {
    setupPrompts({ dataChoices: [] });
    const result = await runWizard();
    expect(result.config.dataTypes.kibanaRepoPath).toBe('');
    expect(result.config.dataTypes.generateAlerts).toBe(false);
    expect(result.config.dataTypes.generateCases).toBe(false);
    expect(result.config.dataTypes.generateEvents).toBe(false);
  });

  it('prompts for repo path when alerts are selected', async () => {
    setupPrompts({
      dataChoices: ['alerts'],
      repoPath: '/home/user/kibana',
    });
    const result = await runWizard();
    expect(result.config.dataTypes.generateAlerts).toBe(true);
    expect(result.config.dataTypes.kibanaRepoPath).toBe('/home/user/kibana');
  });

  it('sets generateCases when cases selected', async () => {
    setupPrompts({ dataChoices: ['cases'], repoPath: '/repo' });
    const result = await runWizard();
    expect(result.config.dataTypes.generateCases).toBe(true);
    expect(result.config.dataTypes.generateAlerts).toBe(false);
  });

  it('sets generateEvents when events selected', async () => {
    setupPrompts({ dataChoices: ['events'], repoPath: '/repo' });
    const result = await runWizard();
    expect(result.config.dataTypes.generateEvents).toBe(true);
    expect(result.config.additionalDataSpaces).toEqual([]);
  });

  it('sets all three data types when all selected', async () => {
    setupPrompts({ dataChoices: ['alerts', 'cases', 'events'], repoPath: '/repo' });
    const result = await runWizard();
    const { generateAlerts, generateCases, generateEvents } = result.config.dataTypes;
    expect(generateAlerts).toBe(true);
    expect(generateCases).toBe(true);
    expect(generateEvents).toBe(true);
  });

  it('returns empty kibanaRepoPath when user skips the repo prompt', async () => {
    setupPrompts({ dataChoices: ['alerts'], repoPath: '' });
    const result = await runWizard();
    expect(result.config.dataTypes.kibanaRepoPath).toBe('');
  });

  it('works with qa environment and qa-specific region', async () => {
    setupPrompts({ environment: 'qa', region: 'gcp-us-west2' });
    const result = await runWizard();
    expect(result.environment).toBe('qa');
    expect(result.config.region).toBe('gcp-us-west2');
  });

  it('works with staging environment', async () => {
    setupPrompts({ environment: 'staging', region: 'gcp-europe-west1' });
    const result = await runWizard();
    expect(result.environment).toBe('staging');
  });

  it('preserves the custom version string', async () => {
    setupPrompts({ version: '8.18.0' });
    const result = await runWizard();
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
    const result = await runWizard();
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
    const result = await runWizard();
    expect(result.config.additionalDataSpaces).toEqual([]);
  });

  it('returns empty additionalDataSpaces when no data types selected', async () => {
    setupPrompts({ dataChoices: [] });
    const result = await runWizard();
    expect(result.config.additionalDataSpaces).toEqual([]);
  });
});
