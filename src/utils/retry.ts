export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoff: boolean;
}

const MAX_SET_TIMEOUT_MS = 2 ** 31 - 1;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, delayMs, backoff } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be an integer greater than or equal to 1');
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('delayMs must be a finite number greater than or equal to 0');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const computedWait = backoff ? delayMs * Math.pow(2, attempt - 1) : delayMs;
        const wait = Math.min(computedWait, MAX_SET_TIMEOUT_MS);
        await sleep(wait);
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error(`Retry failed with non-Error value: ${String(lastError)}`);
}
