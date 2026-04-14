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
  apiKeys: Partial<Record<Environment, string>>;
  environment: Environment;
}

export interface KibanaScriptPaths {
  /** Absolute path to the security_solution plugin root. */
  scriptDir: string;
  /** Absolute path to scripts/data/generate_cli.js. */
  generateCli: string;
  /** Absolute path used as the working directory for `yarn test:generate` (same as scriptDir). */
  testGenerate: string;
}

export interface DataGenerationRunOptions {
  kibanaRepoPath: string;
  kibanaUrl: string;
  credentials: ElasticCredentials;
  /** Optional Kibana space ID to scope alert/case generation. */
  spaceId?: string;
  generateAlerts: boolean;
  generateCases: boolean;
  generateEvents: boolean;
}

export interface DataGenerationResult {
  eventsRan: boolean;
  alertsRan: boolean;
  casesRan: boolean;
  errors: string[];
}
