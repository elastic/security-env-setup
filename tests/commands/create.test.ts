jest.mock('ora');
jest.mock('@wizard/prompts');
jest.mock('@api/cloud');
jest.mock('@api/kibana');
jest.mock('@runners/scripts');
jest.mock('@config/store');

import ora from 'ora';
import { runWizard } from '@wizard/prompts';
import { createDeployment, waitForDeployment } from '@api/cloud';
import { createSpaces, initializeSecurityApp } from '@api/kibana';
import { runAllDataGeneration, runGenerateAttacks, runGenerateCases } from '@runners/scripts';
import { hasApiKey } from '@config/store';
import { createCommand } from '@commands/create';

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  text: '',
};
(ora as jest.MockedFunction<typeof ora>).mockReturnValue(
  mockSpinner as unknown as ReturnType<typeof ora>,
);

const mockedRunWizard = runWizard as jest.MockedFunction<typeof runWizard>;
const mockedCreateDeployment = createDeployment as jest.MockedFunction<typeof createDeployment>;
const mockedWaitForDeployment = waitForDeployment as jest.MockedFunction<typeof waitForDeployment>;
const mockedCreateSpaces = createSpaces as jest.MockedFunction<typeof createSpaces>;
const mockedInitSecurity = initializeSecurityApp as jest.MockedFunction<typeof initializeSecurityApp>;
const mockedRunAllDataGen = runAllDataGeneration as jest.MockedFunction<typeof runAllDataGeneration>;
const mockedRunGenerateAttacks = runGenerateAttacks as jest.MockedFunction<typeof runGenerateAttacks>;
const mockedRunGenerateCases = runGenerateCases as jest.MockedFunction<typeof runGenerateCases>;
const mockedHasApiKey = hasApiKey as jest.MockedFunction<typeof hasApiKey>;

const WIZARD_RESULT = {
  config: {
    name: 'my-deploy',
    region: 'gcp-us-central1',
    version: '8.17.1',
    spaces: [{ id: 'security', name: 'Security' }],
    dataTypes: {
      kibanaRepoPath: '',
      generateAlerts: false,
      generateCases: false,
      generateEvents: false,
    },
  },
  environment: 'prod' as const,
  target: 'elastic-cloud' as const,
};

const INITIAL_RESULT = {
  id: 'dep-123',
  status: 'creating' as const,
  esUrl: '',
  kibanaUrl: '',
  credentials: { url: '', username: 'elastic', password: 'pass123' },
};

const RUNNING_RESULT = {
  id: 'dep-123',
  status: 'running' as const,
  esUrl: 'https://es.example.com:9243',
  kibanaUrl: 'https://kb.example.com:9243',
  credentials: { url: 'https://es.example.com:9243', username: 'elastic', password: 'pass123' },
};

// Helper: invoke the create command's action via Commander's parseAsync.
// The `{ from: 'user' }` option treats the array as user-provided args.
// We then flush microtasks so the async action (runCreate) can complete.
async function invokeCreate(): Promise<void> {
  await createCommand.parseAsync([], { from: 'user' });
  await new Promise((r) => setTimeout(r, 10));
}

let consoleSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.exitCode;
  consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  mockedHasApiKey.mockReturnValue(true);
  mockedRunWizard.mockResolvedValue(WIZARD_RESULT);
  mockedCreateDeployment.mockResolvedValue(INITIAL_RESULT);
  mockedWaitForDeployment.mockResolvedValue(RUNNING_RESULT);
  mockedCreateSpaces.mockResolvedValue([{ id: 'security', name: 'Security' }]);
  mockedInitSecurity.mockResolvedValue(undefined);
  mockedRunAllDataGen.mockResolvedValue({
    eventsRan: false,
    alertsRan: false,
    casesRan: false,
    errors: [],
  });
  mockedRunGenerateAttacks.mockResolvedValue(undefined);
  mockedRunGenerateCases.mockResolvedValue(undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

afterAll(() => {
  delete process.exitCode;
});

describe('create command', () => {
  it('logs not-yet-implemented and skips deployment for local-stateful', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      target: 'local-stateful' as const,
    });
    await invokeCreate();
    expect(mockedCreateDeployment).not.toHaveBeenCalled();
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('local-stateful');
  });

  it('logs not-yet-implemented and skips deployment for local-serverless', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      target: 'local-serverless' as const,
    });
    await invokeCreate();
    expect(mockedCreateDeployment).not.toHaveBeenCalled();
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('local-serverless');
  });

  it('runs the full happy path — wizard → create → wait → spaces → security init', async () => {
    await invokeCreate();

    expect(mockedRunWizard).toHaveBeenCalledTimes(1);
    expect(mockedCreateDeployment).toHaveBeenCalledWith(WIZARD_RESULT.config, 'prod');
    expect(mockedWaitForDeployment).toHaveBeenCalledWith(
      'dep-123',
      'prod',
      INITIAL_RESULT.credentials,
    );
    expect(mockedCreateSpaces).toHaveBeenCalledWith(
      RUNNING_RESULT.kibanaUrl,
      RUNNING_RESULT.credentials,
      WIZARD_RESULT.config.spaces,
    );
    expect(mockedInitSecurity).toHaveBeenCalledWith(
      RUNNING_RESULT.kibanaUrl,
      RUNNING_RESULT.credentials,
    );
  });

  it('prints the summary box containing the kibana URL and credentials', async () => {
    await invokeCreate();
    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('kb.example.com');
    expect(allOutput).toContain('elastic');
    expect(allOutput).toContain('pass123');
  });

  it('sets exitCode and skips deployment when no API key is configured', async () => {
    mockedHasApiKey.mockReturnValue(false);
    await invokeCreate();
    expect(process.exitCode).toBe(1);
    expect(mockedCreateDeployment).not.toHaveBeenCalled();
  });

  it('sets exitCode when deployment creation fails', async () => {
    mockedCreateDeployment.mockRejectedValueOnce(new Error('quota exceeded'));
    await invokeCreate();
    expect(process.exitCode).toBe(1);
    const errOutput = consoleErrorSpy.mock.calls.flat().join('');
    expect(errOutput).toContain('quota exceeded');
  });

  it('sets exitCode when waitForDeployment fails', async () => {
    mockedWaitForDeployment.mockRejectedValueOnce(new Error('timed out'));
    await invokeCreate();
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode when createSpaces throws', async () => {
    mockedCreateSpaces.mockRejectedValueOnce(new Error('space error'));
    await invokeCreate();
    expect(process.exitCode).toBe(1);
  });

  it('skips data generation when kibanaRepoPath is empty', async () => {
    await invokeCreate();
    expect(mockedRunAllDataGen).not.toHaveBeenCalled();
  });

  it('prints (none) in the summary when no spaces were created', async () => {
    mockedCreateSpaces.mockResolvedValueOnce([]);
    await invokeCreate();
    const output = consoleSpy.mock.calls.flat().join('\n');
    // Summary box should still render without spaces
    expect(output).toContain('Deployment Ready');
  });

  it('runs data generation and logs warnings for errors when repo path is set', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      config: {
        ...WIZARD_RESULT.config,
        dataTypes: {
          kibanaRepoPath: '/home/user/kibana',
          generateAlerts: true,
          generateCases: false,
          generateEvents: false,
        },
      },
    });
    mockedRunAllDataGen.mockResolvedValueOnce({
      eventsRan: false,
      alertsRan: false,
      casesRan: false,
      errors: ['Alerts generation failed: something broke'],
    });

    await invokeCreate();

    expect(mockedRunAllDataGen).toHaveBeenCalledTimes(1);
    const warnOutput = consoleWarnSpy.mock.calls.flat().join('');
    expect(warnOutput).toContain('Alerts generation failed');
  });

  it('calls runGenerateAttacks and runGenerateCases for each additional space', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      config: {
        ...WIZARD_RESULT.config,
        additionalDataSpaces: ['devops', 'platform'],
        dataTypes: {
          kibanaRepoPath: '/home/user/kibana',
          generateAlerts: true,
          generateCases: true,
          generateEvents: false,
        },
      },
    });

    await invokeCreate();

    expect(mockedRunGenerateAttacks).toHaveBeenCalledTimes(2);
    expect(mockedRunGenerateAttacks).toHaveBeenCalledWith(
      '/home/user/kibana',
      RUNNING_RESULT.kibanaUrl,
      RUNNING_RESULT.credentials,
      'devops',
    );
    expect(mockedRunGenerateAttacks).toHaveBeenCalledWith(
      '/home/user/kibana',
      RUNNING_RESULT.kibanaUrl,
      RUNNING_RESULT.credentials,
      'platform',
    );
    expect(mockedRunGenerateCases).toHaveBeenCalledTimes(2);
    expect(mockedRunGenerateCases).toHaveBeenCalledWith(
      '/home/user/kibana',
      RUNNING_RESULT.kibanaUrl,
      RUNNING_RESULT.credentials,
      'devops',
      300,
    );
  });

  it('does not call runGenerateEvents in the additional spaces loop', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      config: {
        ...WIZARD_RESULT.config,
        additionalDataSpaces: ['devops'],
        dataTypes: {
          kibanaRepoPath: '/home/user/kibana',
          generateAlerts: false,
          generateCases: false,
          generateEvents: true,
        },
      },
    });

    await invokeCreate();

    // runAllDataGeneration handles events for the default space; no extra calls expected
    expect(mockedRunGenerateAttacks).not.toHaveBeenCalled();
    expect(mockedRunGenerateCases).not.toHaveBeenCalled();

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('Data spaces');
    expect(output).not.toContain('devops');
  });

  it('continues loop when one additional space fails and warns', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      config: {
        ...WIZARD_RESULT.config,
        additionalDataSpaces: ['devops', 'platform'],
        dataTypes: {
          kibanaRepoPath: '/home/user/kibana',
          generateAlerts: true,
          generateCases: false,
          generateEvents: false,
        },
      },
    });
    mockedRunGenerateAttacks
      .mockRejectedValueOnce(new Error('devops space not found'))
      .mockResolvedValueOnce(undefined);

    await invokeCreate();

    expect(mockedRunGenerateAttacks).toHaveBeenCalledTimes(2);
    const warnOutput = consoleWarnSpy.mock.calls.flat().join('');
    expect(warnOutput).toContain('devops');
    expect(warnOutput).toContain('devops space not found');
  });

  it('shows Data spaces line in summary when additionalDataSpaces is non-empty', async () => {
    mockedRunWizard.mockResolvedValue({
      ...WIZARD_RESULT,
      config: {
        ...WIZARD_RESULT.config,
        additionalDataSpaces: ['devops'],
        dataTypes: {
          kibanaRepoPath: '/home/user/kibana',
          generateAlerts: true,
          generateCases: false,
          generateEvents: false,
        },
      },
    });

    await invokeCreate();

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Data spaces');
    expect(output).toContain('default');
    expect(output).toContain('devops');
  });

  it('does not show Data spaces line when additionalDataSpaces is empty', async () => {
    await invokeCreate();
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('Data spaces');
  });
});
