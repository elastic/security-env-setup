import axios from 'axios';
import ora from 'ora';
import type { DeploymentConfig, DeploymentResult, ElasticCredentials, Environment } from '../types';
import { getApiKey } from '../config/store';
import { API_ENDPOINTS } from '../config/endpoints';
import { retry } from '../utils/retry';
import logger from '../utils/logger';
import { buildHeaders } from '../utils/http';
import { getErrorMessage } from '../utils/errors';
import { REGIONS } from '../regions';

// ---------------------------------------------------------------------------
// Internal API response types — never exported
// ---------------------------------------------------------------------------

interface ResourceMetadata {
  endpoint?: string;
  ports?: { http?: number; https?: number };
}

interface ResourceInfo {
  status?: string;
  healthy?: boolean;
  metadata?: ResourceMetadata;
}

/** Shared shape for both ES and Kibana resource entries in the API response. */
interface ApiResource {
  ref_id?: string;
  info?: ResourceInfo;
}

/** Shape returned by GET /api/v1/deployments/{id} */
interface DeploymentGetResponse {
  id: string;
  name?: string;
  resources?: {
    elasticsearch?: ApiResource[];
    kibana?: ApiResource[];
  };
}

/** One entry in the flat resources array returned by POST /api/v1/deployments */
interface CreateDeploymentApiResource {
  kind: string;
  ref_id?: string;
  credentials?: { username?: string; password?: string } | null;
}

/** Shape returned by POST /api/v1/deployments */
interface CreateDeploymentApiResponse {
  id: string;
  created?: boolean;
  name?: string;
  resources?: CreateDeploymentApiResource[];
}

/** Shape returned by GET /api/v1/deployments */
interface ListDeploymentsApiResponse {
  deployments?: DeploymentGetResponse[];
}

export { REGIONS } from '../regions';

/** Returns the list of available regions for the given environment. */
export function listAvailableRegions(env: Environment): Promise<string[]> {
  return Promise.resolve([...REGIONS[env]]);
}

// ---------------------------------------------------------------------------
// Instance configuration IDs — verified against the Elastic Cloud API
// ---------------------------------------------------------------------------

/** Deployment template ID that works across all providers. */
const DEPLOYMENT_TEMPLATE_ID = 'gcp-storage-optimized';

interface InstanceConfig {
  datahot: string;
  kibana: string;
  integrations: string;
}

const INSTANCE_CONFIGS: { gcp: InstanceConfig; aws: InstanceConfig; azure: InstanceConfig } = {
  gcp: {
    datahot: 'gcp.es.datahot.n2.68x10x45',
    kibana: 'gcp.kibana.n2.68x32x45',
    integrations: 'gcp.integrationsserver.n2.68x32x45',
  },
  aws: {
    datahot: 'aws.es.datahot.m6g.12xlarge',
    kibana: 'aws.kibana.r6gd.xlarge.x86_64',
    integrations: 'aws.integrationsserver.r6gd.xlarge.x86_64',
  },
  azure: {
    datahot: 'azure.es.datahot.ddv4.2xlarge',
    kibana: 'azure.kibana.e32sv3',
    integrations: 'azure.integrationsserver.e32sv3',
  },
};

function getInstanceConfigs(region: string): InstanceConfig {
  const provider = region.split('-')[0];
  if (provider === 'aws') return INSTANCE_CONFIGS.aws;
  if (provider === 'azure') return INSTANCE_CONFIGS.azure;
  return INSTANCE_CONFIGS.gcp;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Timeout for one-off operations (create/list/delete). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Timeout for individual poll requests — must be well below POLL_INTERVAL_MS. */
const POLL_REQUEST_TIMEOUT_MS = 10_000;

function requireApiKey(env: Environment): string {
  const apiKey = getApiKey(env);
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(
      `No API key configured for environment: ${env}. Run: security-env-setup auth login`,
    );
  }
  return apiKey;
}

/**
 * Translates an axios error (or any unknown error) into a human-readable
 * Error. Always throws — typed as `never` so callers can be used in
 * `.catch()` chains without breaking type narrowing.
 */
function handleApiError(err: unknown, context: string): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    switch (status) {
      case 401:
        throw new Error(
          `${context}: Invalid or expired API key. Run: security-env-setup auth login`,
        );
      case 404:
        throw new Error(`${context}: Resource not found (HTTP 404).`);
      case 429:
        throw new Error(`${context}: API rate limit exceeded — please wait before retrying.`);
      default: {
        const detail = err.message ? ` — ${err.message}` : '';
        throw new Error(
          `${context}: API request failed${status !== undefined ? ` with HTTP ${String(status)}` : ''}${detail}`,
        );
      }
    }
  }
  throw new Error(`${context}: ${getErrorMessage(err)}`);
}

/**
 * Builds an HTTPS URL for an Elastic cluster resource, using the API-provided
 * HTTPS port when available (falls back to the standard Cloud port 9243).
 */
function buildEndpointUrl(metadata: ResourceMetadata | undefined): string {
  const endpoint = metadata?.endpoint;
  if (!endpoint) {
    throw new Error('Missing resource endpoint in deployment metadata.');
  }
  const httpsPort = metadata?.ports?.https ?? 9243;
  return `https://${endpoint}:${httpsPort}`;
}

/**
 * Selects a resource from a list by a preferred `ref_id`, falling back to the
 * first resource that has a populated endpoint. This avoids blindly taking
 * index `[0]` when the Cloud API may return resources in arbitrary order.
 */
function findResource(
  resources: ApiResource[] | undefined,
  preferredRefId: string,
): ApiResource | undefined {
  return (
    resources?.find((r) => r.ref_id === preferredRefId) ??
    resources?.find((r) => r.info?.metadata?.endpoint)
  );
}

function allResourcesStarted(data: DeploymentGetResponse): boolean {
  const es = data.resources?.elasticsearch ?? [];
  const kb = data.resources?.kibana ?? [];
  if (es.length === 0 || kb.length === 0) return false;
  return (
    es.every((r) => r.info?.status === 'started') &&
    kb.every((r) => r.info?.status === 'started')
  );
}

/**
 * Maps a raw API deployment response to a `DeploymentResult`.
 *
 * @param knownStatus - Pass when the caller has already established the status
 *   (e.g., the polling loop that throws until all resources are started) to
 *   avoid a redundant traversal of the resource arrays.
 */
function extractResultFromGet(
  data: DeploymentGetResponse,
  knownStatus?: DeploymentResult['status'],
): DeploymentResult {
  const esResource = findResource(data.resources?.elasticsearch, 'main-elasticsearch');
  const kbResource = findResource(data.resources?.kibana, 'main-kibana');

  const esMetadata = esResource?.info?.metadata;
  const kbMetadata = kbResource?.info?.metadata;

  const esUrl = esMetadata?.endpoint ? buildEndpointUrl(esMetadata) : '';
  const kibanaUrl = kbMetadata?.endpoint ? buildEndpointUrl(kbMetadata) : '';

  const credentials: ElasticCredentials = {
    url: esUrl,
    username: 'elastic',
    password: '',
  };

  return {
    id: data.id,
    status: knownStatus ?? (allResourcesStarted(data) ? 'running' : 'creating'),
    esUrl,
    kibanaUrl,
    credentials,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createDeployment(
  config: DeploymentConfig,
  env: Environment,
): Promise<DeploymentResult> {
  const apiKey = requireApiKey(env);
  const trimmedRegion = config.region.trim();
  const region = trimmedRegion.length > 0 ? trimmedRegion : 'gcp-us-central1';
  const configs = getInstanceConfigs(region);

  const payload = {
    name: config.name,
    resources: {
      elasticsearch: [
        {
          ref_id: 'main-elasticsearch',
          region,
          plan: {
            cluster_topology: [
              {
                id: 'hot_content',
                node_roles: [
                  'master', 'ingest', 'transform', 'data_hot',
                  'remote_cluster_client', 'data_content',
                ],
                zone_count: 1,
                elasticsearch: { node_attributes: { data: 'hot' } },
                instance_configuration_id: configs.datahot,
                size: { value: 4096, resource: 'memory' },
              },
            ],
            elasticsearch: { version: config.version },
            deployment_template: { id: DEPLOYMENT_TEMPLATE_ID },
          },
        },
      ],
      kibana: [
        {
          ref_id: 'main-kibana',
          elasticsearch_cluster_ref_id: 'main-elasticsearch',
          region,
          plan: {
            cluster_topology: [
              {
                instance_configuration_id: configs.kibana,
                size: { value: 1024, resource: 'memory' },
                zone_count: 1,
              },
            ],
            kibana: { version: config.version },
          },
        },
      ],
    },
    settings: {
      autoscaling_enabled: false,
      solution_type: 'security',
    },
  };

  logger.info(`Creating deployment "${config.name}" on ${env}…`);

  const response = await axios
    .post<CreateDeploymentApiResponse>(
      `${API_ENDPOINTS[env]}/api/v1/deployments`,
      payload,
      { headers: buildHeaders(apiKey), timeout: REQUEST_TIMEOUT_MS },
    )
    .catch((err: unknown) => handleApiError(err, 'createDeployment'));

  const creds = response.data.resources?.find((r) => r.kind === 'elasticsearch')?.credentials;

  // URLs are not available at creation time; call waitForDeployment to populate them.
  const credentials: ElasticCredentials = {
    url: '',
    username: creds?.username ?? 'elastic',
    password: creds?.password ?? '',
  };

  logger.success(
    `Deployment "${response.data.name ?? config.name}" created (id: ${response.data.id}).`,
  );

  return {
    id: response.data.id,
    status: 'creating',
    esUrl: '',
    kibanaUrl: '',
    credentials,
  };
}

export async function waitForDeployment(
  deploymentId: string,
  env: Environment,
  existingCredentials?: ElasticCredentials,
): Promise<DeploymentResult> {
  const apiKey = requireApiKey(env);
  const url = `${API_ENDPOINTS[env]}/api/v1/deployments/${deploymentId}`;
  const headers = buildHeaders(apiKey);

  const MAX_ATTEMPTS = 40;
  const POLL_INTERVAL_MS = 15_000;

  const spinner = ora('Waiting for deployment…').start();
  let attempt = 0;

  try {
    const result = await retry<DeploymentResult>(
      async () => {
        attempt += 1;
        spinner.text = `Waiting for deployment… (attempt ${attempt}/${MAX_ATTEMPTS})`;

        const response = await axios.get<DeploymentGetResponse>(url, {
          headers,
          timeout: POLL_REQUEST_TIMEOUT_MS,
        });

        if (!allResourcesStarted(response.data)) {
          throw new Error('Deployment resources not yet started');
        }

        // Pass knownStatus to skip the redundant allResourcesStarted traversal.
        const deploymentResult = extractResultFromGet(response.data, 'running');

        // GET responses do not include the Elasticsearch password; restore it
        // from the credentials obtained at creation time if they were provided.
        if (existingCredentials !== undefined) {
          deploymentResult.credentials = {
            ...deploymentResult.credentials,
            username: existingCredentials.username ?? deploymentResult.credentials.username,
            password: existingCredentials.password ?? deploymentResult.credentials.password,
          };
        }

        return deploymentResult;
      },
      {
        maxAttempts: MAX_ATTEMPTS,
        delayMs: POLL_INTERVAL_MS,
        backoff: false,
        shouldRetry: (err: unknown) => {
          if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            // Abort immediately only on clearly terminal API errors such as
            // auth failures or missing deployments. Rate limiting (429) is
            // typically transient and should continue polling.
            return status !== 401 && status !== 404;
          }
          return true;
        },
      },
    );

    spinner.succeed('Deployment is healthy and running.');
    logger.info(`Kibana:        ${result.kibanaUrl}`);
    logger.info(`Elasticsearch: ${result.esUrl}`);

    return result;
  } catch (err) {
    const errorMessage = getErrorMessage(err);

    if (axios.isAxiosError(err)) {
      spinner.fail(
        errorMessage
          ? `Deployment polling failed due to an API error: ${errorMessage}`
          : 'Deployment polling failed due to an API error.',
      );
      // handleApiError always throws — typed as never.
      handleApiError(err, 'waitForDeployment');
    }

    const attemptSummary =
      attempt > 0 ? ` after ${attempt} attempt${attempt === 1 ? '' : 's'}` : '';
    const timeoutMessage = errorMessage
      ? `Deployment did not become healthy within the timeout window${attemptSummary}. Last error: ${errorMessage}`
      : `Deployment did not become healthy within the timeout window${attemptSummary}.`;

    spinner.fail(timeoutMessage);
    throw new Error(timeoutMessage);
  }
}

export async function listDeployments(env: Environment): Promise<DeploymentResult[]> {
  const apiKey = requireApiKey(env);

  const response = await axios
    .get<ListDeploymentsApiResponse>(
      `${API_ENDPOINTS[env]}/api/v1/deployments`,
      { headers: buildHeaders(apiKey), timeout: REQUEST_TIMEOUT_MS },
    )
    .catch((err: unknown) => handleApiError(err, 'listDeployments'));

  return (response.data.deployments ?? []).map((d) => extractResultFromGet(d));
}

export async function deleteDeployment(deploymentId: string, env: Environment): Promise<void> {
  const apiKey = requireApiKey(env);

  await axios
    .post<unknown>(
      `${API_ENDPOINTS[env]}/api/v1/deployments/${deploymentId}/_shutdown`,
      {},
      { headers: buildHeaders(apiKey), timeout: REQUEST_TIMEOUT_MS },
    )
    .catch((err: unknown) => handleApiError(err, 'deleteDeployment'));

  logger.success(`Deployment ${deploymentId} shut down successfully.`);
}
