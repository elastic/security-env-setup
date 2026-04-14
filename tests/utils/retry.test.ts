import { retry } from '@utils/retry';

describe('retry', () => {
  it('resolves immediately when fn succeeds on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retry(fn, { maxAttempts: 3, delayMs: 0, backoff: false })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resolves after N-1 failures then one success', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValueOnce('success');
    await expect(retry(fn, { maxAttempts: 5, delayMs: 0, backoff: false })).resolves.toBe(
      'success',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after maxAttempts exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, { maxAttempts: 3, delayMs: 0, backoff: false })).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps a non-Error thrown value when maxAttempts exhausted', async () => {
    const fn = jest.fn().mockImplementation(() => Promise.reject('a raw string'));
    await expect(retry(fn, { maxAttempts: 2, delayMs: 0, backoff: false })).rejects.toThrow(
      'Retry failed with non-Error value: a raw string',
    );
  });

  it('aborts immediately when shouldRetry returns false', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('terminal'))
      .mockResolvedValue('never reached');
    const shouldRetry = jest.fn().mockReturnValue(false);
    await expect(
      retry(fn, { maxAttempts: 5, delayMs: 0, backoff: false, shouldRetry }),
    ).rejects.toThrow('terminal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('continues retrying when shouldRetry returns true', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    const shouldRetry = jest.fn().mockReturnValue(true);
    await expect(
      retry(fn, { maxAttempts: 3, delayMs: 0, backoff: false, shouldRetry }),
    ).resolves.toBe('ok');
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('uses flat delay when backoff is false', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('f1'))
        .mockRejectedValueOnce(new Error('f2'))
        .mockResolvedValueOnce('ok');
      const retryPromise = retry(fn, { maxAttempts: 3, delayMs: 50, backoff: false });
      await jest.runAllTimersAsync();
      await expect(retryPromise).resolves.toBe('ok');
      const delays = setTimeoutSpy.mock.calls
        .filter(([, ms]) => (ms as number) === 50)
        .map(([, ms]) => ms);
      expect(delays).toEqual([50, 50]);
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('uses exponentially increasing delays when backoff is true', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('f1'))
        .mockRejectedValueOnce(new Error('f2'))
        .mockResolvedValueOnce('ok');
      const retryPromise = retry(fn, { maxAttempts: 3, delayMs: 50, backoff: true });
      await jest.runAllTimersAsync();
      // attempt 1 fail → sleep(50 * 2^0 = 50); attempt 2 fail → sleep(50 * 2^1 = 100)
      await expect(retryPromise).resolves.toBe('ok');
      const delays = setTimeoutSpy.mock.calls
        .filter(([, ms]) => (ms as number) === 50 || (ms as number) === 100)
        .map(([, ms]) => ms);
      expect(delays).toEqual([50, 100]);
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('throws when maxAttempts is less than 1', async () => {
    await expect(
      retry(jest.fn(), { maxAttempts: 0, delayMs: 0, backoff: false }),
    ).rejects.toThrow('maxAttempts must be an integer greater than or equal to 1');
  });

  it('throws when maxAttempts is not an integer', async () => {
    await expect(
      retry(jest.fn(), { maxAttempts: 1.5, delayMs: 0, backoff: false }),
    ).rejects.toThrow('maxAttempts must be an integer greater than or equal to 1');
  });

  it('throws when delayMs is negative', async () => {
    await expect(
      retry(jest.fn(), { maxAttempts: 1, delayMs: -1, backoff: false }),
    ).rejects.toThrow('delayMs must be a finite number greater than or equal to 0');
  });

  it('resolves correctly with delayMs of 0', async () => {
    const fn = jest.fn().mockResolvedValue('zero');
    await expect(retry(fn, { maxAttempts: 1, delayMs: 0, backoff: false })).resolves.toBe('zero');
  });
});
