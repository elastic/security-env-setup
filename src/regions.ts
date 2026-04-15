import type { Environment } from './types';

export const REGIONS: Readonly<Record<Environment, readonly string[]>> = Object.freeze({
  prod: Object.freeze([
    'gcp-us-central1',
    'gcp-us-east4',
    'gcp-us-west1',
    'gcp-us-west2',
    'gcp-europe-west1',
    'gcp-europe-west2',
    'gcp-europe-west3',
    'aws-us-east-1',
    'aws-us-west-2',
    'aws-eu-west-1',
    'aws-eu-central-1',
    'azure-eastus2',
    'azure-westeurope',
  ]),
  qa: Object.freeze(['gcp-us-central1', 'gcp-us-west2']),
  staging: Object.freeze(['gcp-us-central1', 'gcp-europe-west1']),
});
