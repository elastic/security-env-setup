import { API_ENDPOINTS } from '@config/endpoints';

describe('API_ENDPOINTS', () => {
  it('contains the correct prod URL', () => {
    expect(API_ENDPOINTS.prod).toBe('https://api.elastic-cloud.com');
  });

  it('contains the correct staging URL', () => {
    expect(API_ENDPOINTS.staging).toBe('https://api.staging.foundit.no');
  });

  it('contains the correct qa URL', () => {
    expect(API_ENDPOINTS.qa).toBe('https://api.qa.cld.elstc.co');
  });

  it('covers all three environments', () => {
    expect(Object.keys(API_ENDPOINTS)).toEqual(expect.arrayContaining(['prod', 'qa', 'staging']));
  });
});
