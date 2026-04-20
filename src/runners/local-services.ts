import axios from 'axios';
import type { ElasticCredentials } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for each service liveness ping. */
const DETECTION_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pings Kibana and Elasticsearch to check whether both services are reachable.
 *
 * Uses a {@link DETECTION_TIMEOUT_MS} timeout per request and treats any
 * network error or non-2xx response as "not running". Never throws.
 *
 * Designed to be extended in Stage 4b with a `startServices()` companion.
 */
export async function detectServices(
  kibanaUrl: string,
  elasticsearchUrl: string,
  credentials: ElasticCredentials,
): Promise<{ kibana: boolean; elasticsearch: boolean }> {
  const token = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString('base64');
  const headers = { Authorization: `Basic ${token}` };

  const [kibana, elasticsearch] = await Promise.all([
    axios
      .get<unknown>(`${kibanaUrl}/api/status`, {
        headers,
        timeout: DETECTION_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false),
    axios
      .get<unknown>(`${elasticsearchUrl}/`, {
        headers,
        timeout: DETECTION_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false),
  ]);

  return { kibana, elasticsearch };
}
