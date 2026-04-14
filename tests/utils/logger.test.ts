import logger from '@utils/logger';

describe('logger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls console.log with a string containing the message for info', () => {
    logger.info('hello info');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toEqual(expect.stringContaining('hello info'));
  });

  it('calls console.log with a string containing the message for success', () => {
    logger.success('all good');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toEqual(expect.stringContaining('all good'));
  });

  it('calls console.warn with a string containing the message for warn', () => {
    logger.warn('careful now');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('careful now'));
  });

  it('calls console.error with a string containing the message for error', () => {
    logger.error('something broke');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toEqual(expect.stringContaining('something broke'));
  });

  it('formats step as [n/total] msg', () => {
    logger.step(2, 5, 'doing work');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output: string = logSpy.mock.calls[0][0];
    expect(output).toContain('[2/5]');
    expect(output).toContain('doing work');
  });

  it('passes the raw string through for print without transformation', () => {
    const raw = '\u001b[32mAlready colored\u001b[0m';
    logger.print(raw);
    expect(logSpy).toHaveBeenCalledWith(raw);
  });
});
