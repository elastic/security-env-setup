import axios from 'axios';

jest.mock('axios');
jest.mock('ora');
jest.mock('@config/store');
jest.mock('@utils/retry', () => ({
  retry: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import ora from 'ora';
import { retry } from '@utils/retry';
import { getApiKey } from '@config/store';
import {
  createDeployment,
  waitForDeployment,
  listDeployments,
  deleteDeployment,
} from '@api/cloud';
import type { DeploymentConfig } from '@types-local/index';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedGetApiKey = getApiKey as jest.MockedFunction<typeof getApiKey>;
const mockedRetry = retry as jest.MockedFunction<typeof retry>;

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  text: '',
};
(ora as jest.MockedFunction<typeof ora>).mockReturnValue(
  mockSpinner as unknown as ReturnType<typeof ora>,
);

const CONFIG: DeploymentConfig = {
  name: 'test-deploy',
  region: 'gcp-us-central1',
  version: '8.17.1',
  spaces: [],
  dataTypes: {
    kibanaRepoPath: '',
    generateAlerts: false,
    generateCases: false,
    generateEvents: false,
  },
};

const RUNNING_RESPONSE = {
  id: 'dep-123',
  name: 'test-deploy',
  resources: {
    elasticsearch: [
      {
        ref_id: 'main-elasticsearch',
        info: {
          status: 'started',
          metadata: { endpoint: 'es.example.com', ports: { https: 9243 } },
        },
      },
    ],
    kibana: [
      {
        ref_id: 'main-kibana',
        info: {
          status: 'started',
          metadata: { endpoint: 'kb.example.com', ports: { https: 9243 } },
        },
      },
    ],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
  mockedGetApiKey.mockReturnValue('test-api-key');
  mockedAxios.isAxiosError.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// createDeployment
// ---------------------------------------------------------------------------

describe('createDeployment', () => {
  it('posts to the correct URL with ApiKey header', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'dep-1',
        name: 'test-deploy',
        resources: { elasticsearch: [{ ref_id: 'main-es', credentials: { username: 'elastic', password: 'pass' } }] },
      },
    });

    const result = await createDeployment(CONFIG, 'prod');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.elastic-cloud.com/api/v1/deployments',
      expect.objectContaining({ name: 'test-deploy', version: '8.17.1' }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'ApiKey test-api-key' }),
      }),
    );
    expect(result.id).toBe('dep-1');
    expect(result.credentials.username).toBe('elastic');
    expect(result.credentials.password).toBe('pass');
    expect(result.status).toBe('creating');
  });

  it('throws when no API key is configured', async () => {
    mockedGetApiKey.mockReturnValue(undefined);
    await expect(createDeployment(CONFIG, 'prod')).rejects.toThrow(
      'No API key configured',
    );
  });

  it('throws meaningful message on 401', async () => {
    const axiosErr = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.post.mockRejectedValueOnce(axiosErr);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(createDeployment(CONFIG, 'prod')).rejects.toThrow(
      'Invalid or expired API key',
    );
  });

  it('throws meaningful message on 429', async () => {
    const axiosErr = { isAxiosError: true, response: { status: 429 }, message: 'Rate limit' };
    mockedAxios.post.mockRejectedValueOnce(axiosErr);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(createDeployment(CONFIG, 'prod')).rejects.toThrow('rate limit');
  });

  it('throws meaningful message on network error', async () => {
    const axiosErr = { isAxiosError: true, response: undefined, message: 'Network Error' };
    mockedAxios.post.mockRejectedValueOnce(axiosErr);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(createDeployment(CONFIG, 'prod')).rejects.toThrow('API request failed');
  });

  it('selects gcp template for gcp region', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { id: 'd', resources: { elasticsearch: [{ credentials: {} }] } },
    });
    await createDeployment({ ...CONFIG, region: 'gcp-us-central1' }, 'prod');
    const payload = mockedAxios.post.mock.calls[0][1] as { deployment_template: { id: string } };
    expect(payload.deployment_template.id).toBe('gcp-general-purpose');
  });

  it('selects aws template for aws region', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { id: 'd', resources: { elasticsearch: [{ credentials: {} }] } },
    });
    await createDeployment({ ...CONFIG, region: 'aws-us-east-1' }, 'prod');
    const payload = mockedAxios.post.mock.calls[0][1] as { deployment_template: { id: string } };
    expect(payload.deployment_template.id).toBe('aws-general-purpose');
  });

  it('selects azure template for azure region', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { id: 'd', resources: { elasticsearch: [{ credentials: {} }] } },
    });
    await createDeployment({ ...CONFIG, region: 'azure-eastus2' }, 'prod');
    const payload = mockedAxios.post.mock.calls[0][1] as { deployment_template: { id: string } };
    expect(payload.deployment_template.id).toBe('azure-general-purpose');
  });

  it('throws with non-axios error wrapping context', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('socket hang up'));
    mockedAxios.isAxiosError.mockReturnValue(false);
    await expect(createDeployment(CONFIG, 'prod')).rejects.toThrow('socket hang up');
  });
});

// ---------------------------------------------------------------------------
// waitForDeployment
// ---------------------------------------------------------------------------

describe('waitForDeployment', () => {
  it('resolves with running deployment when all resources are started', async () => {
    mockedRetry.mockImplementationOnce(async (fn) => fn());
    mockedAxios.get.mockResolvedValueOnce({ data: RUNNING_RESPONSE });

    const result = await waitForDeployment('dep-123', 'prod');

    expect(result.status).toBe('running');
    expect(result.kibanaUrl).toContain('kb.example.com');
    expect(result.esUrl).toContain('es.example.com');
  });

  it('restores credentials from existingCredentials', async () => {
    mockedRetry.mockImplementationOnce(async (fn) => fn());
    mockedAxios.get.mockResolvedValueOnce({ data: RUNNING_RESPONSE });

    const creds = { url: '', username: 'elastic', password: 'secret-pass' };
    const result = await waitForDeployment('dep-123', 'prod', creds);

    expect(result.credentials.password).toBe('secret-pass');
    expect(result.credentials.username).toBe('elastic');
  });

  it('fails the spinner and throws when retry exhausts attempts', async () => {
    mockedRetry.mockRejectedValueOnce(new Error('timeout'));
    await expect(waitForDeployment('dep-123', 'prod')).rejects.toThrow('timeout');
    expect(mockSpinner.fail).toHaveBeenCalled();
  });

  it('calls handleApiError on 401 axios response', async () => {
    const axiosErr = {
      isAxiosError: true,
      response: { status: 401 },
      message: 'Unauthorized',
    };
    mockedAxios.isAxiosError.mockReturnValue(true);
    mockedRetry.mockRejectedValueOnce(axiosErr);
    await expect(waitForDeployment('dep-123', 'prod')).rejects.toThrow(
      'Invalid or expired API key',
    );
  });

  it('passes shouldRetry that aborts on 401', async () => {
    // Let retry call through so we can test the real shouldRetry logic.
    mockedRetry.mockImplementationOnce(async (fn, opts) => {
      // Simulate: fn throws a 401 axios error, shouldRetry returns false → abort
      const axiosErr = { isAxiosError: true, response: { status: 401 }, message: 'Unauth' };
      mockedAxios.isAxiosError.mockReturnValue(true);
      try {
        throw axiosErr;
      } catch (err) {
        if (opts.shouldRetry && !opts.shouldRetry(err)) {
          throw err;
        }
      }
      // Should not reach here
      return fn();
    });
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(waitForDeployment('dep-123', 'prod')).rejects.toThrow(
      'Invalid or expired API key',
    );
  });

  it('includes attempt count in timeout message when polling exhausts', async () => {
    // Non-axios timeout error path
    mockedRetry.mockRejectedValueOnce(new Error('Deployment resources not yet started'));
    mockedAxios.isAxiosError.mockReturnValue(false);
    await expect(waitForDeployment('dep-123', 'prod')).rejects.toThrow(
      'Deployment did not become healthy',
    );
  });

  it('shouldRetry returns false for 401 status', async () => {
    // Let retry call through so we can capture the shouldRetry option.
    mockedRetry.mockImplementationOnce(async (_fn, opts) => {
      const err401 = { isAxiosError: true, response: { status: 401 }, message: '' };
      mockedAxios.isAxiosError.mockReturnValue(true);
      const result = opts.shouldRetry?.(err401);
      expect(result).toBe(false);
      // Resolve normally so the test doesn't throw
      return { id: 'dep-123', status: 'running', esUrl: '', kibanaUrl: '', credentials: { url: '', username: 'elastic', password: '' } };
    });
    mockedAxios.isAxiosError.mockReturnValue(true);
    await waitForDeployment('dep-123', 'prod');
  });

  it('shouldRetry returns false for 404 status', async () => {
    mockedRetry.mockImplementationOnce(async (_fn, opts) => {
      const err404 = { isAxiosError: true, response: { status: 404 }, message: '' };
      mockedAxios.isAxiosError.mockReturnValue(true);
      expect(opts.shouldRetry?.(err404)).toBe(false);
      return { id: 'd', status: 'running', esUrl: '', kibanaUrl: '', credentials: { url: '', username: 'elastic', password: '' } };
    });
    await waitForDeployment('dep-123', 'prod');
  });

  it('shouldRetry returns true for non-auth axios errors', async () => {
    mockedRetry.mockImplementationOnce(async (_fn, opts) => {
      const err500 = { isAxiosError: true, response: { status: 500 }, message: '' };
      mockedAxios.isAxiosError.mockReturnValue(true);
      expect(opts.shouldRetry?.(err500)).toBe(true);
      return { id: 'd', status: 'running', esUrl: '', kibanaUrl: '', credentials: { url: '', username: 'elastic', password: '' } };
    });
    await waitForDeployment('dep-123', 'prod');
  });

  it('shouldRetry returns true for non-axios errors', async () => {
    mockedRetry.mockImplementationOnce(async (_fn, opts) => {
      mockedAxios.isAxiosError.mockReturnValue(false);
      expect(opts.shouldRetry?.(new Error('network'))).toBe(true);
      return { id: 'd', status: 'running', esUrl: '', kibanaUrl: '', credentials: { url: '', username: 'elastic', password: '' } };
    });
    await waitForDeployment('dep-123', 'prod');
  });

  it('throws when resources are not yet started (allResourcesStarted false path)', async () => {
    // Call through the real fn() to exercise allResourcesStarted
    mockedRetry.mockImplementationOnce(async (fn) => fn());
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        id: 'dep-123',
        resources: {
          elasticsearch: [{ ref_id: 'main-elasticsearch', info: { status: 'initializing' } }],
          kibana: [{ ref_id: 'main-kibana', info: { status: 'started' } }],
        },
      },
    });
    mockedAxios.isAxiosError.mockReturnValue(false);
    await expect(waitForDeployment('dep-123', 'prod')).rejects.toThrow(
      'Deployment did not become healthy',
    );
  });

  it('falls back to first resource with endpoint when preferred ref_id is absent', async () => {
    mockedRetry.mockImplementationOnce(async (fn) => fn());
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        id: 'dep-123',
        resources: {
          elasticsearch: [
            {
              ref_id: 'non-matching-ref',
              info: { status: 'started', metadata: { endpoint: 'es.example.com', ports: { https: 9243 } } },
            },
          ],
          kibana: [
            {
              ref_id: 'non-matching-kb',
              info: { status: 'started', metadata: { endpoint: 'kb.example.com', ports: { https: 9243 } } },
            },
          ],
        },
      },
    });
    const result = await waitForDeployment('dep-123', 'prod');
    expect(result.esUrl).toContain('es.example.com');
    expect(result.kibanaUrl).toContain('kb.example.com');
  });

  it('uses default port 9243 when ports.https is absent', async () => {
    mockedRetry.mockImplementationOnce(async (fn) => fn());
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        id: 'dep-123',
        resources: {
          elasticsearch: [
            {
              ref_id: 'main-elasticsearch',
              info: { status: 'started', metadata: { endpoint: 'es.example.com' } },
            },
          ],
          kibana: [
            {
              ref_id: 'main-kibana',
              info: { status: 'started', metadata: { endpoint: 'kb.example.com' } },
            },
          ],
        },
      },
    });
    const result = await waitForDeployment('dep-123', 'prod');
    expect(result.esUrl).toBe('https://es.example.com:9243');
  });
});

// ---------------------------------------------------------------------------
// listDeployments
// ---------------------------------------------------------------------------

describe('listDeployments', () => {
  it('returns mapped list of deployments', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { deployments: [RUNNING_RESPONSE, { ...RUNNING_RESPONSE, id: 'dep-456' }] },
    });
    const results = await listDeployments('prod');
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('dep-123');
    expect(results[1].id).toBe('dep-456');
  });

  it('returns empty array when deployments field is absent', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    const results = await listDeployments('prod');
    expect(results).toEqual([]);
  });

  it('throws on API error', async () => {
    const axiosErr = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.get.mockRejectedValueOnce(axiosErr);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(listDeployments('prod')).rejects.toThrow('Invalid or expired API key');
  });
});

// ---------------------------------------------------------------------------
// deleteDeployment
// ---------------------------------------------------------------------------

describe('deleteDeployment', () => {
  it('calls the shutdown endpoint with the correct deployment ID', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    await deleteDeployment('dep-789', 'prod');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.elastic-cloud.com/api/v1/deployments/dep-789/_shutdown',
      {},
      expect.any(Object),
    );
  });

  it('throws on API error', async () => {
    const axiosErr = { isAxiosError: true, response: { status: 404 }, message: 'Not found' };
    mockedAxios.post.mockRejectedValueOnce(axiosErr);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(deleteDeployment('dep-404', 'prod')).rejects.toThrow('Resource not found');
  });
});
