export interface DeploymentConfig {
  name: string;
  region: string;
  version: string;
  spaces: KibanaSpace[];
  additionalDataSpaces?: string[];
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

export type Target = 'elastic-cloud' | 'local-stateful' | 'local-serverless';

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
  /** Absolute path to the cases plugin's generate_cases.js script. */
  generateCasesScript: string;
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

export interface PrebuiltRulesBootstrapPackage {
  name: string;
  version: string;
  status: string;
}

export interface PrebuiltRulesBootstrapResponse {
  packages: readonly PrebuiltRulesBootstrapPackage[];
}

export interface PrebuiltRulesInstallationSummary {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface PrebuiltRulesInstallationResponse {
  summary: PrebuiltRulesInstallationSummary;
}

/**
 * Aggregated result of the two-step prebuilt rules install flow
 * (bootstrap packages + perform installation).
 */
export interface InstallPrebuiltRulesResult {
  packages: readonly PrebuiltRulesBootstrapPackage[];
  summary: PrebuiltRulesInstallationSummary;
}

export interface BulkRuleActionResponse {
  success: boolean;
  rules_count: number;
}

export type DocsGeneratorMode = 'stateful' | 'serverless';

export type Volume = 'light' | 'medium' | 'heavy';

export interface DocsGeneratorConfigOptions {
  elasticsearchUrl: string;
  kibanaUrl: string;
  mode: DocsGeneratorMode;
  credentials: ElasticCredentials;
}

export interface StandardSequenceOptions {
  space: string;
  volume: Volume;
}

export interface LocalWizardAnswers {
  target: 'local-stateful' | 'local-serverless';
  kibanaDir: string;
  kibanaUrl: string;
  elasticsearchUrl: string;
  username: string;
  password: string;
  space: string;
  volume: Volume;
  docsGeneratorDir: string;
  installSampleData: boolean;
}

export type WizardResult =
  | { target: 'elastic-cloud'; config: DeploymentConfig; environment: Environment }
  | LocalWizardAnswers;
