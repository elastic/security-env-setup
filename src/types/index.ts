export interface DeploymentConfig {
  name: string;
  region: string;
  version: string;
  spaces: KibanaSpace[];
  dataTypes: DataGenerationOptions;
}

export interface ElasticCredentials {
  url: string;
  username: string;
  password: string;
  apiKey?: string;
}

export interface DeploymentResult {
  id: string;
  status: 'creating' | 'running' | 'failed' | 'stopped';
  kibanaUrl: string;
  esUrl: string;
  credentials: ElasticCredentials;
}

export interface KibanaSpace {
  id: string;
  name: string;
  color?: string;
}

export interface DataGenerationOptions {
  kibanaRepoPath: string;
  generateAlerts: boolean;
  generateCases: boolean;
  generateEvents: boolean;
}

export type Environment = 'prod' | 'qa' | 'staging';

export interface AppConfig {
  apiKey: string;
  environment: Environment;
}
