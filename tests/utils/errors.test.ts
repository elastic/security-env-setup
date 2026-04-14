import { getErrorMessage } from '@utils/errors';

describe('getErrorMessage', () => {
  it('returns message from Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns empty string from Error with empty message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });

  it('returns plain string as-is', () => {
    expect(getErrorMessage('something went wrong')).toBe('something went wrong');
  });

  it('returns JSON for a non-empty plain object', () => {
    const result = getErrorMessage({ code: 42, reason: 'oops' });
    expect(result).toBe('{"code":42,"reason":"oops"}');
  });

  it('falls back to unknown error for an object that serializes to {}', () => {
    // Object.create(null) has no prototype — JSON.stringify returns '{}'
    const emptyProto = Object.create(null) as Record<string, unknown>;
    expect(getErrorMessage(emptyProto)).toBe('Unknown error');
  });

  it('falls back to unknown error for a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(getErrorMessage(circular)).toBe('Unknown error');
  });

  it('falls back to unknown error for null', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
  });

  it('falls back to unknown error for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });

  it('falls back to unknown error for a number', () => {
    expect(getErrorMessage(42)).toBe('Unknown error');
  });

  it('falls back to unknown error for a boolean', () => {
    expect(getErrorMessage(false)).toBe('Unknown error');
  });
});
