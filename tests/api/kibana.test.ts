import axios from 'axios';

jest.mock('axios');
jest.mock('ora');

import ora from 'ora';
import {
  createSpace,
  createSpaces,
  listSpaces,
  deleteSpace,
  initializeSecurityApp,
  installPrebuiltRules,
  bulkEnableImmutableRules,
  installSampleData,
} from '@api/kibana';
import type {
  BulkRuleActionResponse,
  ElasticCredentials,
  InstallPrebuiltRulesResponse,
  KibanaSpace,
} from '@types-local/index';

const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  text: '',
};
(ora as jest.MockedFunction<typeof ora>).mockReturnValue(
  mockSpinner as unknown as ReturnType<typeof ora>,
);

const KIBANA_URL = 'https://kb.example.com:9243';
const CREDS: ElasticCredentials = {
  url: 'https://es.example.com:9243',
  username: 'elastic',
  password: 'changeme',
};
const SPACE: KibanaSpace = { id: 'security', name: 'Security' };

function expectedBasicAuth(): string {
  return `Basic ${Buffer.from('elastic:changeme').toString('base64')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpinner.start.mockReturnThis();
  mockSpinner.succeed.mockReturnThis();
  mockSpinner.fail.mockReturnThis();
  mockedAxios.isAxiosError.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// createSpace
// ---------------------------------------------------------------------------

describe('createSpace', () => {
  it('posts to the correct URL with Basic Auth and kbn-xsrf headers', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { id: 'security', name: 'Security' },
    });

    const result = await createSpace(KIBANA_URL, CREDS, SPACE);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/spaces/space`,
      expect.objectContaining({ id: 'security', name: 'Security' }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expectedBasicAuth(),
          'kbn-xsrf': 'true',
        }),
      }),
    );
    expect(result.alreadyExisted).toBe(false);
    expect(result.space.id).toBe('security');
  });

  it('returns alreadyExisted: true on HTTP 409', async () => {
    const conflict = { isAxiosError: true, response: { status: 409 }, message: 'Conflict' };
    mockedAxios.post.mockRejectedValueOnce(conflict);
    mockedAxios.isAxiosError.mockReturnValue(true);

    const result = await createSpace(KIBANA_URL, CREDS, SPACE);
    expect(result.alreadyExisted).toBe(true);
    expect(result.space).toEqual(SPACE);
  });

  it('throws meaningful message on 401', async () => {
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(createSpace(KIBANA_URL, CREDS, SPACE)).rejects.toThrow('Invalid credentials');
  });

  it('throws when credentials have empty username', async () => {
    await expect(
      createSpace(KIBANA_URL, { ...CREDS, username: '' }, SPACE),
    ).rejects.toThrow('Kibana credentials are incomplete');
  });

  it('throws when credentials have empty password', async () => {
    await expect(
      createSpace(KIBANA_URL, { ...CREDS, password: '' }, SPACE),
    ).rejects.toThrow('Kibana credentials are incomplete');
  });

  it('includes color in payload when space has a color', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { id: 'colored', name: 'Colored', color: '#AA1B1B' },
    });
    const spaceWithColor: KibanaSpace = { id: 'colored', name: 'Colored', color: '#AA1B1B' };
    await createSpace(KIBANA_URL, CREDS, spaceWithColor);
    const payload = mockedAxios.post.mock.calls[0][1] as { color?: string };
    expect(payload.color).toBe('#AA1B1B');
  });
});

// ---------------------------------------------------------------------------
// createSpaces
// ---------------------------------------------------------------------------

describe('createSpaces', () => {
  it('creates all spaces sequentially and returns results', async () => {
    const s1: KibanaSpace = { id: 's1', name: 'S1' };
    const s2: KibanaSpace = { id: 's2', name: 'S2' };
    mockedAxios.post
      .mockResolvedValueOnce({ data: { id: 's1', name: 'S1' } })
      .mockResolvedValueOnce({ data: { id: 's2', name: 'S2' } });

    const results = await createSpaces(KIBANA_URL, CREDS, [s1, s2]);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('s1');
    expect(results[1].id).toBe('s2');
  });

  it('continues after an individual failure and returns successfully created spaces', async () => {
    const s1: KibanaSpace = { id: 's1', name: 'S1' };
    const s2: KibanaSpace = { id: 's2', name: 'S2' };
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.post
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { id: 's2', name: 'S2' } });
    mockedAxios.isAxiosError.mockReturnValue(true);

    const results = await createSpaces(KIBANA_URL, CREDS, [s1, s2]);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('s2');
  });

  it('returns empty array for empty input', async () => {
    const results = await createSpaces(KIBANA_URL, CREDS, []);
    expect(results).toEqual([]);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('shows already-exists message on 409', async () => {
    const conflict = { isAxiosError: true, response: { status: 409 }, message: 'Conflict' };
    mockedAxios.post.mockRejectedValueOnce(conflict);
    mockedAxios.isAxiosError.mockReturnValue(true);
    const results = await createSpaces(KIBANA_URL, CREDS, [SPACE]);
    expect(results).toHaveLength(1);
    expect(mockSpinner.succeed).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    );
  });
});

// ---------------------------------------------------------------------------
// listSpaces
// ---------------------------------------------------------------------------

describe('listSpaces', () => {
  it('returns mapped spaces', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { id: 'default', name: 'Default' },
        { id: 'security', name: 'Security', color: '#AA1B1B' },
      ],
    });
    const spaces = await listSpaces(KIBANA_URL, CREDS);
    expect(spaces).toHaveLength(2);
    expect(spaces[1].color).toBe('#AA1B1B');
  });

  it('returns empty array on 404', async () => {
    const err = { isAxiosError: true, response: { status: 404 }, message: 'Not found' };
    mockedAxios.get.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    const spaces = await listSpaces(KIBANA_URL, CREDS);
    expect(spaces).toEqual([]);
  });

  it('throws on non-404 errors', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Server error' };
    mockedAxios.get.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(listSpaces(KIBANA_URL, CREDS)).rejects.toThrow('Kibana API request failed');
  });
});

// ---------------------------------------------------------------------------
// deleteSpace
// ---------------------------------------------------------------------------

describe('deleteSpace', () => {
  it('calls the correct URL with encoded space ID', async () => {
    mockedAxios.delete.mockResolvedValueOnce({ data: {} });
    await deleteSpace(KIBANA_URL, CREDS, 'my space');
    expect(mockedAxios.delete).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/spaces/space/my%20space`,
      expect.any(Object),
    );
  });

  it('handles 404 gracefully without throwing', async () => {
    const err = { isAxiosError: true, response: { status: 404 }, message: 'Not found' };
    mockedAxios.delete.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(deleteSpace(KIBANA_URL, CREDS, 'gone')).resolves.toBeUndefined();
  });

  it('throws on other delete errors', async () => {
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.delete.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(deleteSpace(KIBANA_URL, CREDS, 'sec')).rejects.toThrow('Invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// initializeSecurityApp
// ---------------------------------------------------------------------------

describe('initializeSecurityApp', () => {
  it('posts to the detection engine index endpoint', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    await initializeSecurityApp(KIBANA_URL, CREDS);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/detection_engine/index`,
      {},
      expect.any(Object),
    );
    expect(mockSpinner.succeed).toHaveBeenCalled();
  });

  it('handles 409 gracefully — already initialized', async () => {
    const err = { isAxiosError: true, response: { status: 409 }, message: 'Conflict' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(initializeSecurityApp(KIBANA_URL, CREDS)).resolves.toBeUndefined();
    expect(mockSpinner.succeed).toHaveBeenCalledWith(
      expect.stringContaining('already initialized'),
    );
  });

  it('fails the spinner and throws on other errors', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Internal error' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(initializeSecurityApp(KIBANA_URL, CREDS)).rejects.toThrow(
      'Kibana API request failed',
    );
    expect(mockSpinner.fail).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// installPrebuiltRules
// ---------------------------------------------------------------------------

describe('installPrebuiltRules', () => {
  const INSTALL_RESPONSE: InstallPrebuiltRulesResponse = {
    rules_installed: 750,
    rules_updated: 0,
    timelines_installed: 12,
    timelines_updated: 0,
  };

  it('returns the parsed response on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: INSTALL_RESPONSE });
    const result = await installPrebuiltRules(KIBANA_URL, CREDS);
    expect(result).toEqual(INSTALL_RESPONSE);
  });

  it('posts to the base path with no space prefix for the default space', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: INSTALL_RESPONSE });
    await installPrebuiltRules(KIBANA_URL, CREDS, 'default');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/detection_engine/rules/prepackaged`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('posts to /s/<id>/api/... for a non-default space', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: INSTALL_RESPONSE });
    await installPrebuiltRules(KIBANA_URL, CREDS, 'security');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/s/security/api/detection_engine/rules/prepackaged`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('posts to the base path with no space prefix when spaceId is omitted', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: INSTALL_RESPONSE });
    await installPrebuiltRules(KIBANA_URL, CREDS);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/detection_engine/rules/prepackaged`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('sends all four required headers', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: INSTALL_RESPONSE });
    await installPrebuiltRules(KIBANA_URL, CREDS);
    const [, , config] = mockedAxios.post.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];
    expect(config.headers).toMatchObject({
      Authorization: expectedBasicAuth(),
      'Content-Type': 'application/json',
      'kbn-xsrf': 'true',
      'x-elastic-internal-origin': 'Kibana',
      'elastic-api-version': '2023-10-31',
    });
  });

  it('throws via handleKibanaError when the request fails', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Server error' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(installPrebuiltRules(KIBANA_URL, CREDS)).rejects.toThrow(
      'Kibana API request failed',
    );
  });

  it('throws Invalid credentials on 401', async () => {
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(installPrebuiltRules(KIBANA_URL, CREDS)).rejects.toThrow('Invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// bulkEnableImmutableRules
// ---------------------------------------------------------------------------

describe('bulkEnableImmutableRules', () => {
  const BULK_RESPONSE: BulkRuleActionResponse = {
    success: true,
    rules_count: 750,
  };

  it('returns the parsed response on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: BULK_RESPONSE });
    const result = await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    expect(result).toEqual(BULK_RESPONSE);
  });

  it('posts to the base path with no space prefix for the default space', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: BULK_RESPONSE });
    await bulkEnableImmutableRules(KIBANA_URL, CREDS, 'default');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/detection_engine/rules/_bulk_action`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('posts to /s/<id>/api/... for a non-default space', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: BULK_RESPONSE });
    await bulkEnableImmutableRules(KIBANA_URL, CREDS, 'security');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/s/security/api/detection_engine/rules/_bulk_action`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('posts to the base path with no space prefix when spaceId is omitted', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: BULK_RESPONSE });
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/detection_engine/rules/_bulk_action`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('sends the correct query and action in the request body', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: BULK_RESPONSE });
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    const [, body] = mockedAxios.post.mock.calls[0] as [string, Record<string, string>];
    expect(body).toEqual({
      query: 'alert.attributes.params.immutable: true',
      action: 'enable',
    });
  });

  it('sends all four required headers', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: BULK_RESPONSE });
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    const [, , config] = mockedAxios.post.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];
    expect(config.headers).toMatchObject({
      Authorization: expectedBasicAuth(),
      'Content-Type': 'application/json',
      'kbn-xsrf': 'true',
      'x-elastic-internal-origin': 'Kibana',
      'elastic-api-version': '2023-10-31',
    });
  });

  it('throws via handleKibanaError when the request fails', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Server error' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(bulkEnableImmutableRules(KIBANA_URL, CREDS)).rejects.toThrow(
      'Kibana API request failed',
    );
  });

  it('throws Invalid credentials on 401', async () => {
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(bulkEnableImmutableRules(KIBANA_URL, CREDS)).rejects.toThrow('Invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// installSampleData
// ---------------------------------------------------------------------------

describe('installSampleData', () => {
  it('POSTs to the correct URL and resolves on 2xx', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    await expect(
      installSampleData(KIBANA_URL, CREDS, 'flights'),
    ).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/sample_data/flights`,
      {},
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('uses space prefix in URL when spaceId is provided', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    await installSampleData(KIBANA_URL, CREDS, 'ecommerce', 'my-space');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${KIBANA_URL}/s/my-space/api/sample_data/ecommerce`,
      {},
      expect.any(Object),
    );
  });

  it('treats HTTP 400 ("already installed") as success', async () => {
    const err = { isAxiosError: true, response: { status: 400 }, message: 'Bad request' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(installSampleData(KIBANA_URL, CREDS, 'logs')).resolves.toBeUndefined();
  });

  it('propagates non-400 errors via handleKibanaError', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Server error' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(
      installSampleData(KIBANA_URL, CREDS, 'flights'),
    ).rejects.toThrow('Kibana API request failed');
  });
});
