import { buildHeaders } from '@utils/http';

describe('buildHeaders', () => {
  it('returns correct Authorization and Content-Type headers', () => {
    const headers = buildHeaders('my-api-key');
    expect(headers).toEqual({
      Authorization: 'ApiKey my-api-key',
      'Content-Type': 'application/json',
    });
  });

  it('embeds the exact api key string in the Authorization header', () => {
    const key = 'abc123-XYZ.special';
    const headers = buildHeaders(key);
    expect(headers['Authorization']).toBe(`ApiKey ${key}`);
  });

  it('returns a new object per call', () => {
    const h1 = buildHeaders('k1');
    const h2 = buildHeaders('k2');
    expect(h1).not.toBe(h2);
    expect(h1['Authorization']).toBe('ApiKey k1');
    expect(h2['Authorization']).toBe('ApiKey k2');
  });
});
