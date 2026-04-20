import axios from 'axios';

jest.mock('axios');

import { detectServices } from '@runners/local-services';
import type { ElasticCredentials } from '@types-local/index';

const mockedAxios = axios as jest.Mocked<typeof axios>;

const KIBANA_URL = 'http://localhost:5601';
const ES_URL = 'http://localhost:9200';

const CREDS: ElasticCredentials = {
  url: ES_URL,
  username: 'elastic',
  password: 'changeme',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.isAxiosError.mockReturnValue(false);
});

describe('detectServices', () => {
  it('returns { kibana: true, elasticsearch: true } when both respond 2xx', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: {} }) // kibana /api/status
      .mockResolvedValueOnce({ status: 200, data: {} }); // es /

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: true, elasticsearch: true });
  });

  it('returns { kibana: false, elasticsearch: false } when both are unreachable', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: false, elasticsearch: false });
  });

  it('returns { kibana: false, elasticsearch: true } when only Kibana is down', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // kibana fails
      .mockResolvedValueOnce({ status: 200, data: {} }); // es ok

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: false, elasticsearch: true });
  });

  it('returns { kibana: true, elasticsearch: false } when only ES is down', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: {} }) // kibana ok
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // es fails

    const result = await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(result).toEqual({ kibana: true, elasticsearch: false });
  });

  it('never throws — axios rejection becomes false', async () => {
    mockedAxios.get.mockRejectedValue(new Error('network timeout'));

    await expect(detectServices(KIBANA_URL, ES_URL, CREDS)).resolves.toEqual({
      kibana: false,
      elasticsearch: false,
    });
  });

  it('pings Kibana /api/status endpoint', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${KIBANA_URL}/api/status`,
      expect.any(Object),
    );
  });

  it('pings Elasticsearch / endpoint', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${ES_URL}/`,
      expect.any(Object),
    );
  });

  it('sends Basic Auth header with correct credentials', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    const expectedAuth = `Basic ${Buffer.from('elastic:changeme').toString('base64')}`;
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expectedAuth }),
      }),
    );
  });

  it('uses a 3-second timeout for each ping', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: {} });

    await detectServices(KIBANA_URL, ES_URL, CREDS);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 3_000 }),
    );
  });
});
