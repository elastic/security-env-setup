jest.mock('ora');
jest.mock('inquirer');
jest.mock('@api/kibana');
jest.mock('@wizard/prompts');

import ora from 'ora';
import * as inquirer from 'inquirer';
import {
  findCustomRules,
  findCasesByTag,
  listSpaces,
  bulkDeleteRules,
  bulkDeleteCases,
  deleteSpace,
} from '@api/kibana';
import { runCleanPrompts } from '@wizard/prompts';
import { runClean, runCleanCore } from '@commands/clean';
import type { CleanAnswers } from '@types-local/index';

// ---------------------------------------------------------------------------
// Spinner mock
// ---------------------------------------------------------------------------

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  stop: jest.fn().mockReturnThis(),
  text: '',
};
(ora as jest.MockedFunction<typeof ora>).mockReturnValue(
  mockSpinner as unknown as ReturnType<typeof ora>,
);

// ---------------------------------------------------------------------------
// Mock typed helpers
// ---------------------------------------------------------------------------

const mockedFindCustomRules = findCustomRules as jest.MockedFunction<typeof findCustomRules>;
const mockedFindCasesByTag = findCasesByTag as jest.MockedFunction<typeof findCasesByTag>;
const mockedListSpaces = listSpaces as jest.MockedFunction<typeof listSpaces>;
const mockedBulkDeleteRules = bulkDeleteRules as jest.MockedFunction<typeof bulkDeleteRules>;
const mockedBulkDeleteCases = bulkDeleteCases as jest.MockedFunction<typeof bulkDeleteCases>;
const mockedDeleteSpace = deleteSpace as jest.MockedFunction<typeof deleteSpace>;
const mockedRunCleanPrompts = runCleanPrompts as jest.MockedFunction<typeof runCleanPrompts>;
const mockedInquirer = inquirer as jest.Mocked<typeof inquirer>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ANSWERS: CleanAnswers = {
  target: 'local-stateful',
  kibanaUrl: 'http://localhost:5601',
  elasticsearchUrl: 'http://localhost:9200',
  username: 'elastic',
  password: 'changeme',
  space: 'default',
};

const SAMPLE_RULES = [
  { id: 'rule-1', name: 'My Rule 1' },
  { id: 'rule-2', name: 'My Rule 2' },
];
const SAMPLE_CASES = [
  { id: 'case-1', title: 'Case 1' },
  { id: 'case-2', title: 'Case 2' },
];
const SAMPLE_SPACES = [
  { id: 'default', name: 'Default' },
  { id: 'my-space', name: 'My Space' },
];

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
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
  mockSpinner.stop.mockReturnThis();

  // Default: environment is empty
  mockedFindCustomRules.mockResolvedValue([]);
  mockedFindCasesByTag.mockResolvedValue([]);
  mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
  mockedBulkDeleteRules.mockResolvedValue({ deleted: 0, skipped: 0 });
  mockedBulkDeleteCases.mockResolvedValue({ deleted: 0, skipped: 0 });
  mockedDeleteSpace.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Empty environment
// ---------------------------------------------------------------------------

describe('runCleanCore — empty environment', () => {
  it('returns a zero CleanResult without calling any delete functions', async () => {
    const result = await runCleanCore(BASE_ANSWERS, {});
    expect(result).toEqual({
      rulesDeleted: 0, rulesSkipped: 0,
      casesDeleted: 0, casesSkipped: 0,
      spacesDeleted: 0, spacesSkipped: 0,
    });
    expect(mockedBulkDeleteRules).not.toHaveBeenCalled();
    expect(mockedBulkDeleteCases).not.toHaveBeenCalled();
    expect(mockedDeleteSpace).not.toHaveBeenCalled();
  });

  it('does not prompt the user when environment is empty', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedInquirer.prompt).not.toHaveBeenCalled();
  });

  it('prints "Nothing to clean" message', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Nothing to clean');
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('runCleanCore — dry run', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue(SAMPLE_SPACES);
  });

  it('prints plan and dry-run message without calling any delete functions', async () => {
    const result = await runCleanCore(BASE_ANSWERS, { dryRun: true });
    expect(result).toEqual({
      rulesDeleted: 0, rulesSkipped: 0,
      casesDeleted: 0, casesSkipped: 0,
      spacesDeleted: 0, spacesSkipped: 0,
    });
    expect(mockedBulkDeleteRules).not.toHaveBeenCalled();
    expect(mockedBulkDeleteCases).not.toHaveBeenCalled();
    expect(mockedDeleteSpace).not.toHaveBeenCalled();
  });

  it('does not prompt when dryRun is true', async () => {
    await runCleanCore(BASE_ANSWERS, { dryRun: true });
    expect(mockedInquirer.prompt).not.toHaveBeenCalled();
  });

  it('prints "Dry run — nothing will be deleted"', async () => {
    await runCleanCore(BASE_ANSWERS, { dryRun: true });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Dry run');
    expect(output).toContain('nothing will be deleted');
  });
});

// ---------------------------------------------------------------------------
// All scans fail
// ---------------------------------------------------------------------------

describe('runCleanCore — all scans fail', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockRejectedValue(new Error('rules fetch error'));
    mockedFindCasesByTag.mockRejectedValue(new Error('cases fetch error'));
    mockedListSpaces.mockRejectedValue(new Error('spaces fetch error'));
  });

  it('throws with "all three queries failed" message', async () => {
    await expect(runCleanCore(BASE_ANSWERS, {})).rejects.toThrow(
      'All three queries failed',
    );
  });

  it('logs three warnings before throwing', async () => {
    await expect(runCleanCore(BASE_ANSWERS, {})).rejects.toThrow();
    expect(consoleWarnSpy).toHaveBeenCalledTimes(3);
  });

  it('makes no delete calls', async () => {
    await expect(runCleanCore(BASE_ANSWERS, {})).rejects.toThrow();
    expect(mockedBulkDeleteRules).not.toHaveBeenCalled();
    expect(mockedBulkDeleteCases).not.toHaveBeenCalled();
    expect(mockedDeleteSpace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One scan fails, others succeed
// ---------------------------------------------------------------------------

describe('runCleanCore — cases scan fails, others succeed', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockRejectedValue(new Error('cases API down'));
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
    // all selected, confirm yes, no spaces
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1', 'rule-2'] }) // rules
      .mockResolvedValueOnce({ proceed: true }); // final confirm
    mockedBulkDeleteRules.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('logs a warning for the failed scan', async () => {
    await runCleanCore(BASE_ANSWERS, { yes: false });
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('cases API down'));
  });

  it('continues with the rest of the flow (rules are still deleted)', async () => {
    const result = await runCleanCore(BASE_ANSWERS, { yes: false });
    expect(mockedBulkDeleteRules).toHaveBeenCalledTimes(1);
    expect(result.rulesDeleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Happy path with yes: true
// ---------------------------------------------------------------------------

describe('runCleanCore — happy path (yes: true)', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue(SAMPLE_SPACES);
    // Selection prompts: select all rules, confirm cases, select my-space
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1', 'rule-2'] })
      .mockResolvedValueOnce({ deleteCases: true })
      .mockResolvedValueOnce({ selectedSpaces: ['my-space'] });
    mockedBulkDeleteRules.mockResolvedValue({ deleted: 2, skipped: 0 });
    mockedBulkDeleteCases.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('calls all three delete functions', async () => {
    await runCleanCore(BASE_ANSWERS, { yes: true });
    expect(mockedBulkDeleteRules).toHaveBeenCalledTimes(1);
    expect(mockedBulkDeleteCases).toHaveBeenCalledTimes(1);
    expect(mockedDeleteSpace).toHaveBeenCalledTimes(1);
  });

  it('returns correct counts in CleanResult', async () => {
    const result = await runCleanCore(BASE_ANSWERS, { yes: true });
    expect(result.rulesDeleted).toBe(2);
    expect(result.casesDeleted).toBe(2);
    expect(result.spacesDeleted).toBe(1);
  });

  it('does NOT prompt for final confirmation when yes: true', async () => {
    await runCleanCore(BASE_ANSWERS, { yes: true });
    // Only 3 prompts: rules checkbox, cases confirm, spaces checkbox
    expect(mockedInquirer.prompt).toHaveBeenCalledTimes(3);
  });

  it('passes selected rule ids to bulkDeleteRules', async () => {
    await runCleanCore(BASE_ANSWERS, { yes: true });
    const [, , ids] = mockedBulkDeleteRules.mock.calls[0] as [string, unknown, string[]];
    expect(ids).toEqual(['rule-1', 'rule-2']);
  });
});

// ---------------------------------------------------------------------------
// Rules checkbox empty
// ---------------------------------------------------------------------------

describe('runCleanCore — rules checkbox returns empty', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: [] })       // no rules selected
      .mockResolvedValueOnce({ deleteCases: true })        // cases confirmed
      .mockResolvedValueOnce({ proceed: true });           // final confirm
    mockedBulkDeleteCases.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('does NOT call bulkDeleteRules', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteRules).not.toHaveBeenCalled();
  });

  it('still processes cases', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteCases).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Cases confirm declined
// ---------------------------------------------------------------------------

describe('runCleanCore — cases confirm declined', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1', 'rule-2'] }) // rules selected
      .mockResolvedValueOnce({ deleteCases: false })                   // cases declined
      .mockResolvedValueOnce({ proceed: true });                       // final confirm
    mockedBulkDeleteRules.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('does NOT call bulkDeleteCases', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteCases).not.toHaveBeenCalled();
  });

  it('still processes rules', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteRules).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Spaces checkbox empty
// ---------------------------------------------------------------------------

describe('runCleanCore — spaces checkbox returns empty', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue(SAMPLE_SPACES);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1'] })
      .mockResolvedValueOnce({ deleteCases: true })
      .mockResolvedValueOnce({ selectedSpaces: [] }) // no spaces selected
      .mockResolvedValueOnce({ proceed: true });
    mockedBulkDeleteRules.mockResolvedValue({ deleted: 1, skipped: 0 });
    mockedBulkDeleteCases.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('does NOT call deleteSpace', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedDeleteSpace).not.toHaveBeenCalled();
  });

  it('still processes rules and cases', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteRules).toHaveBeenCalledTimes(1);
    expect(mockedBulkDeleteCases).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// All three categories declined → nothing selected
// ---------------------------------------------------------------------------

describe('runCleanCore — all categories declined', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue(SAMPLE_SPACES);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: [] })
      .mockResolvedValueOnce({ deleteCases: false })
      .mockResolvedValueOnce({ selectedSpaces: [] });
  });

  it('prints "Nothing selected to delete" and returns zero result', async () => {
    const result = await runCleanCore(BASE_ANSWERS, {});
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Nothing selected to delete');
    expect(result).toEqual({
      rulesDeleted: 0, rulesSkipped: 0,
      casesDeleted: 0, casesSkipped: 0,
      spacesDeleted: 0, spacesSkipped: 0,
    });
  });

  it('does not call any delete function', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteRules).not.toHaveBeenCalled();
    expect(mockedBulkDeleteCases).not.toHaveBeenCalled();
    expect(mockedDeleteSpace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Final confirm declined
// ---------------------------------------------------------------------------

describe('runCleanCore — final confirm declined', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue([]);
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1', 'rule-2'] })
      .mockResolvedValueOnce({ proceed: false }); // declined
  });

  it('makes no delete calls', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteRules).not.toHaveBeenCalled();
  });

  it('prints "Aborted by user" and returns zero result', async () => {
    const result = await runCleanCore(BASE_ANSWERS, {});
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Aborted by user');
    expect(result).toEqual({
      rulesDeleted: 0, rulesSkipped: 0,
      casesDeleted: 0, casesSkipped: 0,
      spacesDeleted: 0, spacesSkipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Final confirm accepted
// ---------------------------------------------------------------------------

describe('runCleanCore — final confirm accepted', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue([]);
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1', 'rule-2'] })
      .mockResolvedValueOnce({ proceed: true });
    mockedBulkDeleteRules.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('calls bulkDeleteRules after confirmation', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteRules).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// bulkDeleteRules throws catastrophically
// ---------------------------------------------------------------------------

describe('runCleanCore — bulkDeleteRules throws', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue(SAMPLE_RULES);
    mockedFindCasesByTag.mockResolvedValue(SAMPLE_CASES);
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedRules: ['rule-1', 'rule-2'] })
      .mockResolvedValueOnce({ deleteCases: true })
      .mockResolvedValueOnce({ proceed: true });
    mockedBulkDeleteRules.mockRejectedValue(new Error('network failure'));
    mockedBulkDeleteCases.mockResolvedValue({ deleted: 2, skipped: 0 });
  });

  it('logs a warning for the failed rules deletion', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('network failure'),
    );
  });

  it('sets rulesDeleted: 0 and rulesSkipped to the selected count', async () => {
    const result = await runCleanCore(BASE_ANSWERS, {});
    expect(result.rulesDeleted).toBe(0);
    expect(result.rulesSkipped).toBe(2);
  });

  it('still processes cases after rules failure', async () => {
    const result = await runCleanCore(BASE_ANSWERS, {});
    expect(mockedBulkDeleteCases).toHaveBeenCalledTimes(1);
    expect(result.casesDeleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// One deleteSpace call throws
// ---------------------------------------------------------------------------

describe('runCleanCore — one deleteSpace throws', () => {
  beforeEach(() => {
    mockedFindCustomRules.mockResolvedValue([]);
    mockedFindCasesByTag.mockResolvedValue([]);
    mockedListSpaces.mockResolvedValue([
      { id: 'default', name: 'Default' },
      { id: 'space-a', name: 'Space A' },
      { id: 'space-b', name: 'Space B' },
    ]);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ selectedSpaces: ['space-a', 'space-b'] })
      .mockResolvedValueOnce({ proceed: true });
    mockedDeleteSpace
      .mockRejectedValueOnce(new Error('space-a gone'))
      .mockResolvedValueOnce(undefined);
  });

  it('continues to the next space after a failure', async () => {
    const result = await runCleanCore(BASE_ANSWERS, {});
    expect(mockedDeleteSpace).toHaveBeenCalledTimes(2);
    expect(result.spacesDeleted).toBe(1);
    expect(result.spacesSkipped).toBe(1);
  });

  it('logs a warning for the failed space', async () => {
    await runCleanCore(BASE_ANSWERS, {});
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('space-a gone'),
    );
  });
});

// ---------------------------------------------------------------------------
// Serverless target guard
// ---------------------------------------------------------------------------

describe('runCleanCore — serverless guard', () => {
  it('throws with "not supported" message for local-serverless target', async () => {
    const serverlessAnswers = {
      ...BASE_ANSWERS,
      target: 'local-serverless' as unknown as CleanAnswers['target'],
    };
    await expect(runCleanCore(serverlessAnswers, {})).rejects.toThrow(
      'not supported in this version',
    );
  });

  it('makes no API calls for serverless target', async () => {
    const serverlessAnswers = {
      ...BASE_ANSWERS,
      target: 'local-serverless' as unknown as CleanAnswers['target'],
    };
    await expect(runCleanCore(serverlessAnswers, {})).rejects.toThrow();
    expect(mockedFindCustomRules).not.toHaveBeenCalled();
    expect(mockedFindCasesByTag).not.toHaveBeenCalled();
    expect(mockedListSpaces).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runClean (wizard wrapper)
// ---------------------------------------------------------------------------

describe('runClean', () => {
  it('calls runCleanPrompts and then runCleanCore with the returned answers', async () => {
    mockedRunCleanPrompts.mockResolvedValueOnce(BASE_ANSWERS);
    // Empty env so runCleanCore exits early
    mockedFindCustomRules.mockResolvedValue([]);
    mockedFindCasesByTag.mockResolvedValue([]);
    mockedListSpaces.mockResolvedValue([{ id: 'default', name: 'Default' }]);

    const result = await runClean({});
    expect(mockedRunCleanPrompts).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      rulesDeleted: 0, rulesSkipped: 0,
      casesDeleted: 0, casesSkipped: 0,
      spacesDeleted: 0, spacesSkipped: 0,
    });
  });
});
