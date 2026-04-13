import type { Environment } from '../types';

export const API_ENDPOINTS: Record<Environment, string> = {
  prod: 'https://api.elastic-cloud.com',
  staging: 'https://api.staging.foundit.no',
  qa: 'https://api.qa.cld.elstc.co',
};
