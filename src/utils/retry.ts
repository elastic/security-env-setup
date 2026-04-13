export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoff: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, delayMs, backoff } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const wait = backoff ? delayMs * Math.pow(2, attempt - 1) : delayMs;
        await sleep(wait);
      }
    }
  }

  throw lastError;
}
