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
  findCustomRules,
  bulkDeleteRules,
  findCasesByTag,
  bulkDeleteCases,
} from '@api/kibana';
import type {
  BulkEnableImmutableRulesResult,
  ElasticCredentials,
  InstallPrebuiltRulesResult,
  KibanaSpace,
  PrebuiltRulesBootstrapResponse,
  PrebuiltRulesInstallationResponse,
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
  const BOOTSTRAP_RESPONSE: PrebuiltRulesBootstrapResponse = {
    packages: [
      { name: 'security_detection_engine', version: '9.3.8', status: 'installed' },
      { name: 'endpoint', version: '9.4.0', status: 'installed' },
      { name: 'security_ai_prompts', version: '1.0.13', status: 'installed' },
    ],
  };

  const INSTALL_RESPONSE: PrebuiltRulesInstallationResponse = {
    summary: { total: 1779, succeeded: 1779, skipped: 0, failed: 0 },
  };

  const EXPECTED_RESULT: InstallPrebuiltRulesResult = {
    packages: [...BOOTSTRAP_RESPONSE.packages],
    summary: INSTALL_RESPONSE.summary,
  };

  /** Prime the mock for both sequential POST calls. */
  function mockBothCalls(): void {
    mockedAxios.post
      .mockResolvedValueOnce({ data: BOOTSTRAP_RESPONSE })
      .mockResolvedValueOnce({ data: INSTALL_RESPONSE });
  }

  it('returns the aggregated InstallPrebuiltRulesResult on success', async () => {
    mockBothCalls();
    const result = await installPrebuiltRules(KIBANA_URL, CREDS);
    expect(result).toEqual(EXPECTED_RESULT);
  });

  it('makes exactly two POST calls', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('first call posts to _bootstrap with empty body', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    const [url, body] = mockedAxios.post.mock.calls[0] as [string, unknown];
    expect(url).toContain('/internal/detection_engine/prebuilt_rules/_bootstrap');
    expect(body).toEqual({});
  });

  it('second call posts to installation/_perform with mode ALL_RULES', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    const [url, body] = mockedAxios.post.mock.calls[1] as [string, unknown];
    expect(url).toContain('/internal/detection_engine/prebuilt_rules/installation/_perform');
    expect(body).toEqual({ mode: 'ALL_RULES' });
  });

  it('uses elastic-api-version: "1" (not "2023-10-31") on both calls', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    for (const call of mockedAxios.post.mock.calls) {
      const [, , config] = call as [string, unknown, { headers: Record<string, string> }];
      expect(config.headers['elastic-api-version']).toBe('1');
      expect(config.headers['elastic-api-version']).not.toBe('2023-10-31');
    }
  });

  it('sends all required headers on both calls', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    for (const call of mockedAxios.post.mock.calls) {
      const [, , config] = call as [string, unknown, { headers: Record<string, string> }];
      expect(config.headers).toMatchObject({
        Authorization: expectedBasicAuth(),
        'Content-Type': 'application/json',
        'kbn-xsrf': 'true',
        'x-elastic-internal-origin': 'Kibana',
        'elastic-api-version': '1',
      });
    }
  });

  it('default space — both URLs have no space prefix', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS, 'default');
    const [bootstrapUrl] = mockedAxios.post.mock.calls[0] as [string];
    const [performUrl] = mockedAxios.post.mock.calls[1] as [string];
    expect(bootstrapUrl).toBe(
      `${KIBANA_URL}/internal/detection_engine/prebuilt_rules/_bootstrap`,
    );
    expect(performUrl).toBe(
      `${KIBANA_URL}/internal/detection_engine/prebuilt_rules/installation/_perform`,
    );
  });

  it('custom space — both URLs include the /s/<id> prefix', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS, 'security');
    const [bootstrapUrl] = mockedAxios.post.mock.calls[0] as [string];
    const [performUrl] = mockedAxios.post.mock.calls[1] as [string];
    expect(bootstrapUrl).toBe(
      `${KIBANA_URL}/s/security/internal/detection_engine/prebuilt_rules/_bootstrap`,
    );
    expect(performUrl).toBe(
      `${KIBANA_URL}/s/security/internal/detection_engine/prebuilt_rules/installation/_perform`,
    );
  });

  it('omitted spaceId — URLs have no space prefix', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    const [bootstrapUrl] = mockedAxios.post.mock.calls[0] as [string];
    expect(bootstrapUrl).toContain(`${KIBANA_URL}/internal/`);
    expect(bootstrapUrl).not.toContain('/s/');
  });

  it('both calls use a 5-minute (300 000 ms) timeout', async () => {
    mockBothCalls();
    await installPrebuiltRules(KIBANA_URL, CREDS);
    for (const call of mockedAxios.post.mock.calls) {
      const [, , config] = call as [string, unknown, { timeout: number }];
      expect(config.timeout).toBe(5 * 60 * 1_000);
    }
  });

  it('bootstrap failure — throws with bootstrap context and does NOT call perform', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Fleet error' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await expect(installPrebuiltRules(KIBANA_URL, CREDS)).rejects.toThrow(
      'installPrebuiltRules (bootstrap)',
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('bootstrap 401 — throws Invalid credentials', async () => {
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(installPrebuiltRules(KIBANA_URL, CREDS)).rejects.toThrow('Invalid credentials');
  });

  it('bootstrap succeeds but perform fails — throws with perform context', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'Install error' };
    mockedAxios.post
      .mockResolvedValueOnce({ data: BOOTSTRAP_RESPONSE })
      .mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await expect(installPrebuiltRules(KIBANA_URL, CREDS)).rejects.toThrow(
      'installPrebuiltRules (perform)',
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// bulkEnableImmutableRules
// ---------------------------------------------------------------------------

describe('bulkEnableImmutableRules', () => {
  /** Build an array of fake { id } rule objects for mock responses. */
  function makeRules(n: number, offset = 0): Array<{ id: string }> {
    return Array.from({ length: n }, (_, i) => ({ id: `rule-${String(offset + i)}` }));
  }

  /** Prime GET (find pages) and POST (bulk chunks) mocks for a single-chunk scenario. */
  function mockSingleChunk(count: number): void {
    mockedAxios.get.mockResolvedValueOnce({
      data: { total: count, data: makeRules(count) },
    });
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, rules_count: count },
    });
  }

  // ── Happy path: single chunk ──────────────────────────────────────────────

  it('returns { total, enabled, chunks: 1 } for a single page under 1000 rules', async () => {
    mockSingleChunk(500);
    const result: BulkEnableImmutableRulesResult = await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    expect(result).toEqual({ total: 500, enabled: 500, chunks: 1 });
  });

  it('makes exactly one GET and one POST for a single chunk', async () => {
    mockSingleChunk(500);
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  // ── Happy path: multiple pages + multiple chunks (2038 rules) ────────────

  it('paginates _find across 3 pages and issues 3 bulk-action chunks for 2038 rules', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(1000, 0) } })
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(1000, 1000) } })
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(38, 2000) } });
    mockedAxios.post
      .mockResolvedValueOnce({ data: { success: true, rules_count: 1000 } })
      .mockResolvedValueOnce({ data: { success: true, rules_count: 1000 } })
      .mockResolvedValueOnce({ data: { success: true, rules_count: 38 } });

    const result = await bulkEnableImmutableRules(KIBANA_URL, CREDS);

    expect(result).toEqual({ total: 2038, enabled: 2038, chunks: 3 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  // ── Zero rules ────────────────────────────────────────────────────────────

  it('returns { total: 0, enabled: 0, chunks: 0 } and never calls POST when no rules found', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { total: 0, data: [] } });
    const result = await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    expect(result).toEqual({ total: 0, enabled: 0, chunks: 0 });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('stops pagination when first page data is unexpectedly empty even if total > 0', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { total: 100, data: [] } });
    const result = await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    expect(result).toEqual({ total: 0, enabled: 0, chunks: 0 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  // ── Pagination URL assertions ─────────────────────────────────────────────

  it('_find GETs include page=1, page=2, page=3 in order for 3-page result', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(1000) } })
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(1000, 1000) } })
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(38, 2000) } });
    mockedAxios.post
      .mockResolvedValue({ data: { success: true, rules_count: 1 } });

    await bulkEnableImmutableRules(KIBANA_URL, CREDS);

    const getUrls = mockedAxios.get.mock.calls.map((c) => c[0] as string);
    expect(getUrls[0]).toContain('page=1');
    expect(getUrls[1]).toContain('page=2');
    expect(getUrls[2]).toContain('page=3');
  });

  it('_find URLs include the URL-encoded immutability filter', async () => {
    mockSingleChunk(10);
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    const [getUrl] = mockedAxios.get.mock.calls[0] as [string];
    expect(getUrl).toContain('filter=');
    expect(getUrl).toContain(encodeURIComponent('alert.attributes.params.immutable: true'));
  });

  // ── Bulk-action body ──────────────────────────────────────────────────────

  it('each _bulk_action POST body contains action: "enable" and an ids array', async () => {
    mockSingleChunk(3);
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    const [, body] = mockedAxios.post.mock.calls[0] as [string, { action: string; ids: string[] }];
    expect(body.action).toBe('enable');
    expect(Array.isArray(body.ids)).toBe(true);
    expect(body.ids).toHaveLength(3);
  });

  // ── Headers ───────────────────────────────────────────────────────────────

  it('_find GET uses all required headers including elastic-api-version 2023-10-31', async () => {
    mockSingleChunk(10);
    await bulkEnableImmutableRules(KIBANA_URL, CREDS);
    const [, config] = mockedAxios.get.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(config.headers).toMatchObject({
      Authorization: expectedBasicAuth(),
      'Content-Type': 'application/json',
      'kbn-xsrf': 'true',
      'x-elastic-internal-origin': 'Kibana',
      'elastic-api-version': '2023-10-31',
    });
  });

  it('_bulk_action POST uses all required headers including elastic-api-version 2023-10-31', async () => {
    mockSingleChunk(10);
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

  // ── Space prefix ──────────────────────────────────────────────────────────

  it('default space — both _find and _bulk_action URLs have no space prefix', async () => {
    mockSingleChunk(5);
    await bulkEnableImmutableRules(KIBANA_URL, CREDS, 'default');
    const [findUrl] = mockedAxios.get.mock.calls[0] as [string];
    const [bulkUrl] = mockedAxios.post.mock.calls[0] as [string];
    expect(findUrl).toContain(`${KIBANA_URL}/api/`);
    expect(findUrl).not.toContain('/s/');
    expect(bulkUrl).toBe(`${KIBANA_URL}/api/detection_engine/rules/_bulk_action`);
  });

  it('custom space — both _find and _bulk_action URLs include the /s/<id> prefix', async () => {
    mockSingleChunk(5);
    await bulkEnableImmutableRules(KIBANA_URL, CREDS, 'security');
    const [findUrl] = mockedAxios.get.mock.calls[0] as [string];
    const [bulkUrl] = mockedAxios.post.mock.calls[0] as [string];
    expect(findUrl).toContain(`${KIBANA_URL}/s/security/api/`);
    expect(bulkUrl).toBe(`${KIBANA_URL}/s/security/api/detection_engine/rules/_bulk_action`);
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('_find failure — throws with (find) context and never calls _bulk_action', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: 'ES down' };
    mockedAxios.get.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await expect(bulkEnableImmutableRules(KIBANA_URL, CREDS)).rejects.toThrow(
      'bulkEnableImmutableRules (find)',
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('_find 401 — throws Invalid credentials', async () => {
    const err = { isAxiosError: true, response: { status: 401 }, message: 'Unauthorized' };
    mockedAxios.get.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(bulkEnableImmutableRules(KIBANA_URL, CREDS)).rejects.toThrow('Invalid credentials');
  });

  it('_bulk_action failure on 2nd chunk — throws with (bulk_action) context', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(1000) } })
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(1000, 1000) } })
      .mockResolvedValueOnce({ data: { total: 2038, data: makeRules(38, 2000) } });

    const err = { isAxiosError: true, response: { status: 500 }, message: 'Rule conflict' };
    mockedAxios.post
      .mockResolvedValueOnce({ data: { success: true, rules_count: 1000 } }) // chunk 1 ok
      .mockRejectedValueOnce(err); // chunk 2 fails
    mockedAxios.isAxiosError.mockReturnValue(true);

    await expect(bulkEnableImmutableRules(KIBANA_URL, CREDS)).rejects.toThrow(
      'bulkEnableImmutableRules (bulk_action)',
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
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

// ---------------------------------------------------------------------------
// findCustomRules
// ---------------------------------------------------------------------------

describe('findCustomRules', () => {
  const FILTER_ENCODED = encodeURIComponent('alert.attributes.params.immutable: false');

  it('returns all items from a single page when total <= page size', async () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({ id: `rule-${i}`, name: `Rule ${i}` }));
    mockedAxios.get.mockResolvedValueOnce({ data: { total: 5, data: rules } });

    const result = await findCustomRules(KIBANA_URL, CREDS);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ id: 'rule-0', name: 'Rule 0' });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('paginates when total exceeds page size', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `rule-${i}`, name: `Rule ${i}` }));
    const page2 = Array.from({ length: 500 }, (_, i) => ({ id: `rule-${1000 + i}`, name: `Rule ${1000 + i}` }));

    mockedAxios.get
      .mockResolvedValueOnce({ data: { total: 1500, data: page1 } })
      .mockResolvedValueOnce({ data: { total: 1500, data: page2 } });

    const result = await findCustomRules(KIBANA_URL, CREDS);

    expect(result).toHaveLength(1500);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    const [url1] = mockedAxios.get.mock.calls[0] as [string];
    const [url2] = mockedAxios.get.mock.calls[1] as [string];
    expect(url1).toContain('page=1');
    expect(url2).toContain('page=2');
  });

  it('includes the URL-encoded immutable filter in the request URL', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { total: 0, data: [] } });
    await findCustomRules(KIBANA_URL, CREDS);
    const [url] = mockedAxios.get.mock.calls[0] as [string];
    expect(url).toContain(`filter=${FILTER_ENCODED}`);
  });

  it('throws via handleKibanaError on 4xx', async () => {
    const err = { isAxiosError: true, response: { status: 403 }, message: 'Forbidden' };
    mockedAxios.get.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(findCustomRules(KIBANA_URL, CREDS)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bulkDeleteRules
// ---------------------------------------------------------------------------

describe('bulkDeleteRules', () => {
  let consoleWarnSpy: jest.SpyInstance;
  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { consoleWarnSpy.mockRestore(); });

  it('returns zero counts and makes NO axios call when ids is empty', async () => {
    const result = await bulkDeleteRules(KIBANA_URL, CREDS, []);
    expect(result).toEqual({ deleted: 0, skipped: 0 });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('issues one POST for 500 ids and returns deleted count from rules_count', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { rules_count: 500 } });
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const result = await bulkDeleteRules(KIBANA_URL, CREDS, ids);
    expect(result).toEqual({ deleted: 500, skipped: 0 });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('chunks 2500 ids into 3 POST calls (1000, 1000, 500)', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { rules_count: 1000 } })
      .mockResolvedValueOnce({ data: { rules_count: 1000 } })
      .mockResolvedValueOnce({ data: { rules_count: 500 } });
    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`);
    const result = await bulkDeleteRules(KIBANA_URL, CREDS, ids);
    expect(result).toEqual({ deleted: 2500, skipped: 0 });
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    const chunk1 = (mockedAxios.post.mock.calls[0][1] as { ids: string[] }).ids;
    const chunk2 = (mockedAxios.post.mock.calls[1][1] as { ids: string[] }).ids;
    const chunk3 = (mockedAxios.post.mock.calls[2][1] as { ids: string[] }).ids;
    expect(chunk1).toHaveLength(1000);
    expect(chunk2).toHaveLength(1000);
    expect(chunk3).toHaveLength(500);
  });

  it('logs warn and counts chunk as skipped when first chunk returns 4xx; continues remaining chunks', async () => {
    const err = { isAxiosError: true, response: { status: 422 }, message: 'Unprocessable' };
    mockedAxios.post
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { rules_count: 500 } });
    mockedAxios.isAxiosError.mockReturnValue(true);

    const ids = Array.from({ length: 1500 }, (_, i) => `id-${i}`);
    const result = await bulkDeleteRules(KIBANA_URL, CREDS, ids);

    expect(result.skipped).toBe(1000); // first chunk
    expect(result.deleted).toBe(500);  // second chunk
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('422'));
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('propagates network errors via handleKibanaError', async () => {
    const err = new Error('Network Error');
    mockedAxios.post.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(false);
    await expect(bulkDeleteRules(KIBANA_URL, CREDS, ['id-1'])).rejects.toThrow('Network Error');
  });
});

// ---------------------------------------------------------------------------
// findCasesByTag
// ---------------------------------------------------------------------------

describe('findCasesByTag', () => {
  it('returns all cases from a single page', async () => {
    const cases = Array.from({ length: 10 }, (_, i) => ({ id: `case-${i}`, title: `Case ${i}` }));
    mockedAxios.get.mockResolvedValueOnce({
      data: { total: 10, cases, page: 1, perPage: 100 },
    });

    const result = await findCasesByTag(KIBANA_URL, CREDS, 'data-generator');

    expect(result).toHaveLength(10);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('paginates across two pages when total is 150', async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://x').searchParams;
      const page = Number(params.get('page'));
      if (page === 1) {
        return {
          data: {
            total: 150,
            cases: Array.from({ length: 100 }, (_, i) => ({ id: `case-${i}`, title: `Case ${i}` })),
            page: 1,
            perPage: 100,
          },
        };
      }
      return {
        data: {
          total: 150,
          cases: Array.from({ length: 50 }, (_, i) => ({ id: `case-${100 + i}`, title: `Case ${100 + i}` })),
          page: 2,
          perPage: 100,
        },
      };
    });

    const result = await findCasesByTag(KIBANA_URL, CREDS, 'data-generator');
    expect(result).toHaveLength(150);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('URL-encodes the tag (tag with space is percent-encoded)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { total: 0, cases: [], page: 1, perPage: 100 },
    });
    await findCasesByTag(KIBANA_URL, CREDS, 'data generator');
    const [url] = mockedAxios.get.mock.calls[0] as [string];
    expect(url).toMatch(/data(%20|\+)generator/);
  });

  it('throws via handleKibanaError on 4xx', async () => {
    const err = { isAxiosError: true, response: { status: 404 }, message: 'Not Found' };
    mockedAxios.get.mockRejectedValueOnce(err);
    mockedAxios.isAxiosError.mockReturnValue(true);
    await expect(findCasesByTag(KIBANA_URL, CREDS, 'data-generator')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bulkDeleteCases
// ---------------------------------------------------------------------------

describe('bulkDeleteCases', () => {
  let consoleWarnSpy: jest.SpyInstance;
  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { consoleWarnSpy.mockRestore(); });

  it('returns zero counts and makes NO axios call when ids is empty', async () => {
    const result = await bulkDeleteCases(KIBANA_URL, CREDS, []);
    expect(result).toEqual({ deleted: 0, skipped: 0 });
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });

  it('issues one DELETE for 50 ids and returns deleted: 50 on HTTP 204', async () => {
    mockedAxios.delete.mockResolvedValueOnce({ status: 204, data: undefined });
    const ids = Array.from({ length: 50 }, (_, i) => `case-${i}`);
    const result = await bulkDeleteCases(KIBANA_URL, CREDS, ids);
    expect(result).toEqual({ deleted: 50, skipped: 0 });
    expect(mockedAxios.delete).toHaveBeenCalledTimes(1);
  });

  it('chunks 250 ids into 3 DELETE calls (100, 100, 50)', async () => {
    mockedAxios.delete.mockResolvedValue({ status: 204, data: undefined });
    const ids = Array.from({ length: 250 }, (_, i) => `case-${i}`);
    await bulkDeleteCases(KIBANA_URL, CREDS, ids);
    expect(mockedAxios.delete).toHaveBeenCalledTimes(3);
  });

  it('URL-encodes ids param as JSON array in the DELETE URL', async () => {
    mockedAxios.delete.mockResolvedValueOnce({ status: 204, data: undefined });
    await bulkDeleteCases(KIBANA_URL, CREDS, ['id-1', 'id-2']);
    const [url] = mockedAxios.delete.mock.calls[0] as [string];
    // JSON array opening bracket URL-encoded is %5B
    expect(url).toContain('ids=%5B');
  });

  it('logs warn and counts chunk as skipped when first chunk returns 404; continues remaining chunks', async () => {
    const err = { isAxiosError: true, response: { status: 404 }, message: 'Not Found' };
    mockedAxios.delete
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ status: 204, data: undefined });
    mockedAxios.isAxiosError.mockReturnValue(true);

    const ids = Array.from({ length: 150 }, (_, i) => `case-${i}`);
    const result = await bulkDeleteCases(KIBANA_URL, CREDS, ids);

    expect(result.skipped).toBe(100); // first chunk
    expect(result.deleted).toBe(50);  // second chunk
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('404'));
    expect(mockedAxios.delete).toHaveBeenCalledTimes(2);
  });
});
