/**
 * Builds the standard Elastic Cloud API request headers for a given API key.
 * Single source of truth for the `ApiKey` auth scheme used across all modules.
 */
export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `ApiKey ${apiKey}`,
    'Content-Type': 'application/json',
  };
}
