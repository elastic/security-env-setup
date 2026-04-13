/**
 * Safely extracts a human-readable message from any thrown value.
 * Use instead of `err instanceof Error ? err.message : '...'` inline patterns.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
