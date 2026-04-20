import axios from 'axios';
import ora from 'ora';
import type {
  BulkEnableImmutableRulesResult,
  ElasticCredentials,
  InstallPrebuiltRulesResult,
  KibanaSpace,
  PrebuiltRulesBootstrapResponse,
  PrebuiltRulesInstallationResponse,
} from '../types';
import logger from '../utils/logger';
import { getErrorMessage } from '../utils/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for all Kibana API requests. */
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Internal API response / request types — never exported
// ---------------------------------------------------------------------------

/** One page of results from `GET /api/detection_engine/rules/_find`. */
interface FindRulesPage {
  total: number;
  data: Array<{ id: string }>;
}

/** Response from a single `POST /api/detection_engine/rules/_bulk_action` chunk. */
interface BulkActionChunkResponse {
  success: boolean;
  rules_count: number;
}

/** Shape of a single space object returned by the Kibana Spaces API. */
interface KibanaSpaceApiShape {
  id: string;
  name: string;
  color?: string;
  description?: string;
  initials?: string;
  imageUrl?: string;
  disabledFeatures?: string[];
}

/** Payload sent to POST /api/spaces/space. */
interface SpaceCreatePayload {
  id: string;
  name: string;
  color?: string;
}

/** Result returned by {@link createSpace}, indicating whether the space was newly created. */
export interface CreateSpaceResult {
  space: KibanaSpace;
  /** `true` when the space already existed (HTTP 409); `false` when it was just created. */
  alreadyExisted: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds Kibana API request headers using HTTP Basic Auth.
 *
 * Validates credentials eagerly so callers get a clear error before a network
 * round-trip that would only return a 401. The encoded token is placed
 * exclusively in the Authorization header and never written to logs.
 */
function buildKibanaHeaders(credentials: ElasticCredentials): Record<string, string> {
  const username = credentials.username.trim();
  const password = credentials.password.trim();
  if (!username || !password) {
    throw new Error(
      'Kibana credentials are incomplete — both username and password are required.',
    );
  }
  // Credentials are encoded here and must never appear in any log or error message.
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
    'kbn-xsrf': 'true',
  };
}

/**
 * Translates a Kibana API error into a human-readable Error.
 * Always throws — typed as `never` so it can be used in `.catch()` chains
 * without breaking type narrowing on the resolved value.
 *
 * Security: only the `kibanaUrl` (a non-secret) is embedded in messages.
 * Credentials are never included.
 */
function handleKibanaError(err: unknown, context: string, kibanaUrl: string): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    switch (status) {
      case 401:
        throw new Error(`${context}: Invalid credentials for Kibana at ${kibanaUrl}.`);
      case 404:
        throw new Error(
          `${context}: API route returned 404 at ${kibanaUrl} — the endpoint may be unavailable, the base path may be misconfigured, or the deployment may still be starting.`,
        );
      case 429:
        throw new Error(
          `${context}: Kibana API rate limit exceeded — please wait before retrying.`,
        );
      default: {
        const detail = err.message ? ` — ${err.message}` : '';
        throw new Error(
          `${context}: Kibana API request failed${status !== undefined ? ` with HTTP ${String(status)}` : ''}${detail}.`,
        );
      }
    }
  }
  throw new Error(`${context}: ${getErrorMessage(err)}`);
}

/**
 * Returns the Kibana URL path prefix for the given space.
 * The default space has no prefix; all other spaces use `/s/<id>`.
 */
function buildSpacePrefix(spaceId?: string): string {
  if (!spaceId || spaceId === 'default') return '';
  return `/s/${spaceId}`;
}

/** Maps a raw Kibana API space shape to the canonical `KibanaSpace` type. */
function mapSpaceResponse(data: KibanaSpaceApiShape): KibanaSpace {
  return {
    id: data.id,
    name: data.name,
    color: data.color,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a single Kibana space.
 * Returns `{ space, alreadyExisted: true }` on HTTP 409 instead of logging
 * directly, so callers with an active spinner can surface the message
 * through the spinner without CLI rendering artefacts.
 */
export async function createSpace(
  kibanaUrl: string,
  credentials: ElasticCredentials,
  space: KibanaSpace,
): Promise<CreateSpaceResult> {
  const headers = buildKibanaHeaders(credentials);

  const payload: SpaceCreatePayload = {
    id: space.id,
    name: space.name,
    ...(space.color !== undefined ? { color: space.color } : {}),
  };

  const response = await axios
    .post<KibanaSpaceApiShape>(`${kibanaUrl}/api/spaces/space`, payload, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    })
    .catch((err: unknown) => {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        return null; // already exists — handled below
      }
      handleKibanaError(err, 'createSpace', kibanaUrl);
    });

  if (response === null) {
    return { space, alreadyExisted: true };
  }

  return { space: mapSpaceResponse(response.data), alreadyExisted: false };
}

/**
 * Creates multiple Kibana spaces sequentially to avoid rate limiting.
 * Logs success or failure per space and continues even if individual
 * creations fail — returns all spaces that were successfully created
 * or that already existed (409).
 */
export async function createSpaces(
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaces: KibanaSpace[],
): Promise<KibanaSpace[]> {
  const results: KibanaSpace[] = [];

  for (const space of spaces) {
    const spinner = ora(`Creating space "${space.name}"…`).start();
    try {
      const { space: result, alreadyExisted } = await createSpace(kibanaUrl, credentials, space);
      if (alreadyExisted) {
        spinner.succeed(`Space "${space.name}" already exists — skipping.`);
      } else {
        spinner.succeed(`Space "${space.name}" created successfully.`);
      }
      results.push(result);
    } catch (err) {
      spinner.fail(`Failed to create space "${space.name}": ${getErrorMessage(err)}`);
      logger.warn(`Skipping space "${space.name}" — continuing with remaining spaces.`);
    }
  }

  return results;
}

/**
 * Lists all Kibana spaces.
 * Returns an empty array instead of throwing if Kibana returns 404 —
 * the deployment may still be initialising at the time of the call.
 */
export async function listSpaces(
  kibanaUrl: string,
  credentials: ElasticCredentials,
): Promise<KibanaSpace[]> {
  const headers = buildKibanaHeaders(credentials);

  const response = await axios
    .get<KibanaSpaceApiShape[]>(`${kibanaUrl}/api/spaces/space`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    })
    .catch((err: unknown) => {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        logger.warn(
          `listSpaces: Spaces API returned 404 at ${kibanaUrl} — the endpoint may be unavailable or the base path may be misconfigured. Returning empty list.`,
        );
        return null;
      }
      handleKibanaError(err, 'listSpaces', kibanaUrl);
    });

  if (response === null) return [];
  return response.data.map(mapSpaceResponse);
}

/**
 * Deletes a Kibana space by ID.
 * Handles 404 gracefully — the space may have already been deleted.
 */
export async function deleteSpace(
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaceId: string,
): Promise<void> {
  const headers = buildKibanaHeaders(credentials);

  await axios
    .delete<unknown>(`${kibanaUrl}/api/spaces/space/${encodeURIComponent(spaceId)}`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    })
    .catch((err: unknown) => {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        logger.warn(`Space "${spaceId}" not found — it may have already been deleted.`);
        return;
      }
      handleKibanaError(err, 'deleteSpace', kibanaUrl);
    });
}

/**
 * Installs all Elastic prebuilt detection rules for the given space using the
 * two-step internal API introduced in Kibana 8.14+ (the legacy
 * `/api/detection_engine/rules/prepackaged` endpoint was removed in 9.x).
 *
 * Step 1 — `_bootstrap`: syncs Fleet packages into Kibana.
 * Step 2 — `_perform_installation`: installs all available prebuilt rules.
 *
 * Both endpoints require `elastic-api-version: '1'` (internal versioning —
 * distinct from the public `2023-10-31` version used by other endpoints).
 */
export async function installPrebuiltRules(
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaceId?: string,
): Promise<InstallPrebuiltRulesResult> {
  const headers = {
    ...buildKibanaHeaders(credentials),
    'x-elastic-internal-origin': 'Kibana',
    'elastic-api-version': '1',
  };
  const prefix = buildSpacePrefix(spaceId);

  // Step 1: bootstrap — syncs Fleet packages into Kibana.
  // 5-minute timeout: on a fresh Kibana boot this endpoint can legitimately
  // take ~28 s while Kibana finishes warming up internally.
  const bootstrapResponse = await axios
    .post<PrebuiltRulesBootstrapResponse>(
      `${kibanaUrl}${prefix}/internal/detection_engine/prebuilt_rules/_bootstrap`,
      {},
      { headers, timeout: 5 * 60 * 1_000 },
    )
    .catch((err: unknown) =>
      handleKibanaError(err, 'installPrebuiltRules (bootstrap)', kibanaUrl),
    );

  // Step 2: perform installation — installs all available prebuilt rules.
  // Same extended timeout: rule installation on a large rule set can be slow.
  const installResponse = await axios
    .post<PrebuiltRulesInstallationResponse>(
      `${kibanaUrl}${prefix}/internal/detection_engine/prebuilt_rules/installation/_perform`,
      { mode: 'ALL_RULES' },
      { headers, timeout: 5 * 60 * 1_000 },
    )
    .catch((err: unknown) =>
      handleKibanaError(err, 'installPrebuiltRules (perform)', kibanaUrl),
    );

  return {
    packages: [...bootstrapResponse.data.packages],
    summary: installResponse.data.summary,
  };
}

/**
 * Bulk-enables all immutable (prebuilt) detection rules for the given space.
 *
 * Kibana's `_bulk_action` endpoint rejects arrays larger than 1 000 entries,
 * so this function:
 *   1. Pages through `GET /api/detection_engine/rules/_find` (page size 1 000)
 *      to collect every immutable rule ID.
 *   2. Splits the ID list into chunks of 1 000 and issues one
 *      `POST /api/detection_engine/rules/_bulk_action` per chunk.
 *
 * Returns an aggregated {@link BulkEnableImmutableRulesResult} describing
 * how many rules were found, enabled, and in how many batches.
 */
export async function bulkEnableImmutableRules(
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaceId?: string,
): Promise<BulkEnableImmutableRulesResult> {
  const headers = {
    ...buildKibanaHeaders(credentials),
    'x-elastic-internal-origin': 'Kibana',
    'elastic-api-version': '2023-10-31',
  };
  const prefix = buildSpacePrefix(spaceId);

  const PAGE_SIZE = 1000;
  const CHUNK_SIZE = 1000;
  const filterEncoded = encodeURIComponent('alert.attributes.params.immutable: true');

  // ── Step 1: Paginate _find to collect all immutable rule IDs ───────────────
  const ids: string[] = [];
  let page = 1;
  for (;;) {
    const findUrl =
      `${kibanaUrl}${prefix}/api/detection_engine/rules/_find` +
      `?per_page=${PAGE_SIZE}&page=${page}&filter=${filterEncoded}`;

    const findRes = await axios
      .get<FindRulesPage>(findUrl, { headers, timeout: REQUEST_TIMEOUT_MS })
      .catch((err: unknown) =>
        handleKibanaError(err, 'bulkEnableImmutableRules (find)', kibanaUrl),
      );

    ids.push(...findRes.data.data.map((r) => r.id));

    if (ids.length >= findRes.data.total || findRes.data.data.length === 0) break;
    page += 1;
  }

  if (ids.length === 0) {
    return { total: 0, enabled: 0, chunks: 0 };
  }

  // ── Step 2: Enable in chunks of 1 000 ─────────────────────────────────────
  const bulkUrl = `${kibanaUrl}${prefix}/api/detection_engine/rules/_bulk_action`;
  let enabled = 0;
  let chunks = 0;

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);

    const bulkRes = await axios
      .post<BulkActionChunkResponse>(
        bulkUrl,
        { action: 'enable', ids: chunk },
        { headers, timeout: REQUEST_TIMEOUT_MS },
      )
      .catch((err: unknown) =>
        handleKibanaError(err, 'bulkEnableImmutableRules (bulk_action)', kibanaUrl),
      );

    enabled += bulkRes.data.rules_count;
    chunks += 1;
  }

  return { total: ids.length, enabled, chunks };
}

/**
 * Installs a Kibana built-in sample dataset (flights, ecommerce, or logs).
 *
 * POSTs to `{spacePrefix}/api/sample_data/{dataset}` with an empty body.
 * HTTP 400 ("already installed") is silently accepted so callers can safely
 * call this function regardless of the current installation state.
 */
export async function installSampleData(
  kibanaUrl: string,
  credentials: ElasticCredentials,
  dataset: 'ecommerce' | 'flights' | 'logs',
  spaceId?: string,
): Promise<void> {
  const headers = buildKibanaHeaders(credentials);
  const prefix = buildSpacePrefix(spaceId);

  try {
    await axios.post<unknown>(
      `${kibanaUrl}${prefix}/api/sample_data/${dataset}`,
      {},
      { headers, timeout: REQUEST_TIMEOUT_MS },
    );
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 400) {
      return; // already installed — acceptable
    }
    handleKibanaError(err, 'installSampleData', kibanaUrl);
  }
}

/**
 * Initialises the Security Solution detection-engine index.
 * Must be called once before data-generation scripts can run.
 * Handles 409 gracefully — the index is already initialised, which is fine.
 */
export async function initializeSecurityApp(
  kibanaUrl: string,
  credentials: ElasticCredentials,
): Promise<void> {
  const headers = buildKibanaHeaders(credentials);
  const spinner = ora('Initializing Security Solution…').start();

  try {
    await axios.post<unknown>(
      `${kibanaUrl}/api/detection_engine/index`,
      {},
      { headers, timeout: REQUEST_TIMEOUT_MS },
    );
    spinner.succeed('Security Solution index initialized successfully.');
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      spinner.succeed('Security Solution index already initialized.');
      return;
    }
    spinner.fail('Failed to initialize Security Solution index.');
    handleKibanaError(err, 'initializeSecurityApp', kibanaUrl);
  }
}
