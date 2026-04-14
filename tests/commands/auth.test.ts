import axios from 'axios';

jest.mock('axios');
jest.mock('ora');
jest.mock('inquirer');
jest.mock('@config/store');

import ora from 'ora';
import * as inquirer from 'inquirer';
import { setApiKey, getAllApiKeys, clearApiKey } from '@config/store';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedInquirer = inquirer as jest.Mocked<typeof inquirer>;
const mockedSetApiKey = setApiKey as jest.MockedFunction<typeof setApiKey>;
const mockedGetAllApiKeys = getAllApiKeys as jest.MockedFunction<typeof getAllApiKeys>;
const mockedClearApiKey = clearApiKey as jest.MockedFunction<typeof clearApiKey>;

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  text: '',
};
(ora as jest.MockedFunction<typeof ora>).mockReturnValue(
  mockSpinner as unknown as ReturnType<typeof ora>,
);

// Import the command after all mocks are set up to ensure mocks are applied.
import { authCommand } from '@commands/auth';

// Helper to invoke a sub-command by parsing it through Commander.
// The `{ from: 'user' }` option tells Commander to treat the array as
// user-provided arguments (no executable/script entries to strip).
async function invokeSubcommand(subcommandName: string): Promise<void> {
  await authCommand.parseAsync([subcommandName], { from: 'user' });
  // Allow async action callbacks (login/logout) to complete.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
  mockedAxios.isAxiosError.mockReturnValue(false);
  // Default: exitCode not set
  delete process.exitCode;
});

afterAll(() => {
  delete process.exitCode;
});

// ---------------------------------------------------------------------------
// auth login
// ---------------------------------------------------------------------------

describe('auth login', () => {
  it('stores the API key after successful validation', async () => {
    mockedInquirer.prompt
      .mockResolvedValueOnce({ environment: 'prod' })
      .mockResolvedValueOnce({ apiKey: 'valid-api-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    mockedSetApiKey.mockImplementation(() => undefined);

    await invokeSubcommand('login');
    // wait for the async action to complete
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedSetApiKey).toHaveBeenCalledWith('prod', 'valid-api-key');
    expect(mockSpinner.succeed).toHaveBeenCalled();
  });

  it('sets exitCode and fails spinner on 401', async () => {
    mockedInquirer.prompt
      .mockResolvedValueOnce({ environment: 'prod' })
      .mockResolvedValueOnce({ apiKey: 'bad-key' });
    const axiosErr = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.get.mockRejectedValueOnce(axiosErr);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await invokeSubcommand('login');
    await new Promise((r) => setTimeout(r, 0));

    expect(process.exitCode).toBe(1);
    expect(mockSpinner.fail).toHaveBeenCalled();
  });

  it('sets exitCode on network failure', async () => {
    mockedInquirer.prompt
      .mockResolvedValueOnce({ environment: 'qa' })
      .mockResolvedValueOnce({ apiKey: 'some-key' });
    const netErr = { isAxiosError: true, response: undefined, message: 'Network Error' };
    mockedAxios.get.mockRejectedValueOnce(netErr);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await invokeSubcommand('login');
    await new Promise((r) => setTimeout(r, 0));

    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode when saving the API key throws', async () => {
    mockedInquirer.prompt
      .mockResolvedValueOnce({ environment: 'prod' })
      .mockResolvedValueOnce({ apiKey: 'valid-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    mockedSetApiKey.mockImplementation(() => {
      throw new Error('disk full');
    });

    await invokeSubcommand('login');
    await new Promise((r) => setTimeout(r, 0));

    expect(process.exitCode).toBe(1);
  });

  it('throws non-axios error message directly', async () => {
    mockedInquirer.prompt
      .mockResolvedValueOnce({ environment: 'prod' })
      .mockResolvedValueOnce({ apiKey: 'some-key' });
    mockedAxios.get.mockRejectedValueOnce(new Error('socket hang up'));
    mockedAxios.isAxiosError.mockReturnValue(false);

    await invokeSubcommand('login');
    await new Promise((r) => setTimeout(r, 0));

    expect(process.exitCode).toBe(1);
  });
});

describe('auth login prompt callbacks', () => {
  let apiKeyPromptQuestions: Array<Record<string, unknown>>;

  beforeAll(async () => {
    jest.clearAllMocks();
    mockedAxios.isAxiosError.mockReturnValue(false);
    mockedInquirer.prompt
      .mockResolvedValueOnce({ environment: 'prod' })
      .mockResolvedValueOnce({ apiKey: 'test-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    mockedSetApiKey.mockImplementation(() => undefined);
    await invokeSubcommand('login');
    await new Promise((r) => setTimeout(r, 0));
    // The second prompt call is the API key prompt
    apiKeyPromptQuestions = mockedInquirer.prompt.mock.calls[1][0] as Array<Record<string, unknown>>;
  });

  it('apiKey validate — rejects empty input', () => {
    const q = apiKeyPromptQuestions[0] as { validate?: (v: string) => boolean | string };
    expect(q.validate?.('')).toContain('cannot be empty');
  });

  it('apiKey validate — accepts non-empty input', () => {
    const q = apiKeyPromptQuestions[0] as { validate?: (v: string) => boolean | string };
    expect(q.validate?.('valid-key')).toBe(true);
  });

  it('apiKey filter — trims whitespace', () => {
    const q = apiKeyPromptQuestions[0] as { filter?: (v: string) => unknown };
    expect(q.filter?.('  trimmed  ')).toBe('trimmed');
  });
});

// ---------------------------------------------------------------------------
// auth status
// ---------------------------------------------------------------------------

describe('auth status', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints configured indicator for environments with a key', async () => {
    mockedGetAllApiKeys.mockReturnValue({ prod: 'key', qa: undefined, staging: undefined });
    await invokeSubcommand('status');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('prod');
  });

  it('prints not-configured indicator for environments without a key', async () => {
    mockedGetAllApiKeys.mockReturnValue({});
    await invokeSubcommand('status');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('prod');
    expect(output).toContain('qa');
    expect(output).toContain('staging');
  });
});

// ---------------------------------------------------------------------------
// auth logout
// ---------------------------------------------------------------------------

describe('auth logout', () => {
  it('removes the key and prints success when key exists', async () => {
    mockedInquirer.prompt.mockResolvedValueOnce({ environment: 'prod' });
    mockedClearApiKey.mockReturnValue(true);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await invokeSubcommand('logout');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedClearApiKey).toHaveBeenCalledWith('prod');
    warnSpy.mockRestore();
  });

  it('prints warning when no key is configured for that environment', async () => {
    mockedInquirer.prompt.mockResolvedValueOnce({ environment: 'staging' });
    mockedClearApiKey.mockReturnValue(false);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await invokeSubcommand('logout');
    await new Promise((r) => setTimeout(r, 0));

    const warnOutput = warnSpy.mock.calls.flat().join('');
    expect(warnOutput).toContain('staging');
    warnSpy.mockRestore();
  });

  it('sets exitCode when logout throws', async () => {
    mockedInquirer.prompt.mockRejectedValueOnce(new Error('prompt interrupted'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await invokeSubcommand('logout');
    await new Promise((r) => setTimeout(r, 0));

    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
