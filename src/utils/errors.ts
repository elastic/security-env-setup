/**
 * Safely extracts a human-readable message from any thrown value.
 * Use instead of `err instanceof Error ? err.message : '...'` inline patterns.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    try {
      const serialized = JSON.stringify(err);
      if (serialized) return serialized;
    } catch {
      // Ignore serialization errors and fall back to the generic message below.
    }
  }
  return 'Unknown error';
}
