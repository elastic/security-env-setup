import axios from 'axios';
import ora from 'ora';
import type { DeploymentConfig, DeploymentResult, ElasticCredentials, Environment } from '../types';
import { getApiKey } from '../config/store';
import { retry } from '../utils/retry';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const API_ENDPOINTS: Record<Environment, string> = {
  prod: 'https://api.elastic-cloud.com',
  staging: 'https://api.staging.foundit.no',
  qa: 'https://api.qa.cld.elstc.co',
};

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

interface ApiEsResource {
  ref_id?: string;
  info?: ResourceInfo;
}

interface ApiKibanaResource {
  ref_id?: string;
  info?: ResourceInfo;
}

/** Shape returned by GET /api/v1/deployments/{id} */
interface DeploymentGetResponse {
  id: string;
  name?: string;
  resources?: {
    elasticsearch?: ApiEsResource[];
    kibana?: ApiKibanaResource[];
  };
}

/** Shape returned by POST /api/v1/deployments */
interface CreateDeploymentApiResponse {
  id: string;
  created?: boolean;
  name?: string;
  resources?: {
    elasticsearch?: Array<{
      ref_id?: string;
      credentials?: { username?: string; password?: string };
    }>;
  };
}

/** Shape returned by GET /api/v1/deployments */
interface ListDeploymentsApiResponse {
  deployments?: DeploymentGetResponse[];
}

// ---------------------------------------------------------------------------
// Internal payload types for deployment creation
// ---------------------------------------------------------------------------

interface ClusterSize {
  value: number;
  resource: string;
}

interface EsTopologyItem {
  node_type: { master: boolean; data: boolean; ingest: boolean };
  zone_count: number;
  size: ClusterSize;
}

interface KibanaTopologyItem {
  instance_configuration_id: string;
  zone_count: number;
  size: ClusterSize;
}

interface CreateDeploymentPayload {
  name: string;
  version: string;
  region: string;
  deployment_template: { id: string };
  resources: {
    elasticsearch: Array<{
      ref_id: string;
      region: string;
      plan: {
        cluster_topology: EsTopologyItem[];
        elasticsearch: { version: string };
      };
    }>;
    kibana: Array<{
      ref_id: string;
      elasticsearch_cluster_ref_id: string;
      region: string;
      plan: {
        cluster_topology: KibanaTopologyItem[];
        kibana: { version: string };
      };
    }>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApiKey(env: Environment): string {
  const apiKey = getApiKey(env);
  if (apiKey === undefined) {
    throw new Error(
      `No API key configured for environment: ${env}. Run: security-env-setup auth login`,
    );
  }
  return apiKey;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `ApiKey ${apiKey}`,
    'Content-Type': 'application/json',
  };
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
      default:
        throw new Error(
          `${context}: API request failed${status !== undefined ? ` with HTTP ${String(status)}` : ''}.`,
        );
    }
  }
  throw new Error(`${context}: ${err instanceof Error ? err.message : 'Unexpected error'}`);
}

function buildEsUrl(endpoint: string): string {
  return `https://${endpoint}:9243`;
}

function buildKibanaUrl(endpoint: string): string {
  return `https://${endpoint}:9243`;
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

function extractResultFromGet(data: DeploymentGetResponse): DeploymentResult {
  const esEndpoint = data.resources?.elasticsearch?.[0]?.info?.metadata?.endpoint ?? '';
  const kbEndpoint = data.resources?.kibana?.[0]?.info?.metadata?.endpoint ?? '';

  const credentials: ElasticCredentials = {
    url: esEndpoint ? buildEsUrl(esEndpoint) : '',
    username: 'elastic',
    password: '',
  };

  return {
    id: data.id,
    status: allResourcesStarted(data) ? 'running' : 'creating',
    esUrl: esEndpoint ? buildEsUrl(esEndpoint) : '',
    kibanaUrl: kbEndpoint ? buildKibanaUrl(kbEndpoint) : '',
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
  const region = config.region.length > 0 ? config.region : 'gcp-us-central1';

  const payload: CreateDeploymentPayload = {
    name: config.name,
    version: config.version,
    region,
    deployment_template: { id: 'gcp-general-purpose' },
    resources: {
      elasticsearch: [
        {
          ref_id: 'main-elasticsearch',
          region,
          plan: {
            cluster_topology: [
              {
                node_type: { master: true, data: true, ingest: true },
                zone_count: 1,
                size: { value: 4096, resource: 'memory' },
              },
            ],
            elasticsearch: { version: config.version },
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
                instance_configuration_id: 'gcp.kibana.1',
                zone_count: 1,
                size: { value: 1024, resource: 'memory' },
              },
            ],
            kibana: { version: config.version },
          },
        },
      ],
    },
  };

  logger.step(1, 3, `Creating deployment "${config.name}" on ${env}…`);

  const response = await axios
    .post<CreateDeploymentApiResponse>(
      `${API_ENDPOINTS[env]}/api/v1/deployments`,
      payload,
      { headers: buildHeaders(apiKey) },
    )
    .catch((err: unknown) => handleApiError(err, 'createDeployment'));

  const creds = response.data.resources?.elasticsearch?.[0]?.credentials;

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

        const response = await axios
          .get<DeploymentGetResponse>(url, { headers })
          .catch((err: unknown) => handleApiError(err, 'waitForDeployment'));

        if (!allResourcesStarted(response.data)) {
          throw new Error('Deployment resources not yet started');
        }

        return extractResultFromGet(response.data);
      },
      { maxAttempts: MAX_ATTEMPTS, delayMs: POLL_INTERVAL_MS, backoff: false },
    );

    spinner.succeed('Deployment is healthy and running.');
    logger.step(2, 3, `Kibana: ${result.kibanaUrl}`);
    logger.step(3, 3, `Elasticsearch: ${result.esUrl}`);

    return result;
  } catch (err) {
    spinner.fail('Deployment did not become healthy within the timeout window.');
    throw err instanceof Error ? err : new Error('Deployment polling failed unexpectedly');
  }
}

export async function listDeployments(env: Environment): Promise<DeploymentResult[]> {
  const apiKey = requireApiKey(env);

  const response = await axios
    .get<ListDeploymentsApiResponse>(
      `${API_ENDPOINTS[env]}/api/v1/deployments`,
      { headers: buildHeaders(apiKey) },
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
      { headers: buildHeaders(apiKey) },
    )
    .catch((err: unknown) => handleApiError(err, 'deleteDeployment'));

  logger.success(`Deployment ${deploymentId} shut down successfully.`);
}
