import fs from 'fs';
import * as inquirer from 'inquirer';
import type { DeploymentConfig, Environment, KibanaSpace } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGIONS_BY_ENV: Record<Environment, string[]> = {
  prod: ['gcp-us-central1', 'gcp-europe-west1', 'aws-us-east-1', 'azure-eastus2'],
  staging: ['gcp-us-central1', 'gcp-europe-west1', 'aws-us-east-1', 'azure-eastus2'],
  qa: ['gcp-us-central1', 'gcp-us-west2'],
};

const DEFAULT_VERSION = '8.17.1';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DEPLOYMENT_NAME_RE = /^[a-zA-Z0-9-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Converts a space display name to a valid Kibana space ID. */
function nameToId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export async function runWizard(): Promise<DeploymentConfig> {
  // ── Step 1: core deployment settings ──────────────────────────────────────
  const { name, environment } = await inquirer.prompt<{
    name: string;
    environment: Environment;
  }>([
    {
      type: 'input',
      name: 'name',
      message: 'Deployment name:',
      default: `security-test-${Date.now()}`,
      validate: (input: string): boolean | string => {
        const trimmed = input.trim();
        if (trimmed.length === 0) return 'Deployment name is required.';
        if (!DEPLOYMENT_NAME_RE.test(trimmed))
          return 'Only alphanumeric characters and hyphens are allowed.';
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'list',
      name: 'environment',
      message: 'Target environment:',
      choices: ['prod', 'qa', 'staging'] as Environment[],
    },
  ]);

  // ── Step 2: region (depends on environment) ────────────────────────────────
  const { region } = await inquirer.prompt<{ region: string }>([
    {
      type: 'list',
      name: 'region',
      message: 'Region:',
      choices: REGIONS_BY_ENV[environment],
    },
  ]);

  // ── Step 3: stack version ──────────────────────────────────────────────────
  const { version } = await inquirer.prompt<{ version: string }>([
    {
      type: 'input',
      name: 'version',
      message: 'Stack version:',
      default: DEFAULT_VERSION,
      validate: (input: string): boolean | string => {
        if (!SEMVER_RE.test(input.trim())) return 'Version must be a valid semver (e.g. 8.17.1).';
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
  ]);

  // ── Step 4: spaces ─────────────────────────────────────────────────────────
  const { spaceCount } = await inquirer.prompt<{ spaceCount: number }>([
    {
      type: 'input',
      name: 'spaceCount',
      message: 'How many Kibana spaces do you want to create? (1–10):',
      default: '1',
      validate: (input: string): boolean | string => {
        const n = Number(input);
        if (!Number.isInteger(n) || n < 1 || n > 10)
          return 'Please enter a whole number between 1 and 10.';
        return true;
      },
      filter: (input: string): number => parseInt(input, 10),
    },
  ]);

  const spaces: KibanaSpace[] = [];
  for (let i = 0; i < spaceCount; i++) {
    const { spaceName } = await inquirer.prompt<{ spaceName: string }>([
      {
        type: 'input',
        name: 'spaceName',
        message: `Space ${i + 1} name:`,
        default: i === 0 ? 'Security' : `Space ${i + 1}`,
        validate: (input: string): boolean | string => {
          if (input.trim().length === 0) return 'Space name is required.';
          const id = nameToId(input);
          if (id.length === 0) return 'Space name must produce a valid ID (alphanumeric + hyphens).';
          return true;
        },
        filter: (input: string): string => input.trim(),
      },
    ]);
    spaces.push({ id: nameToId(spaceName), name: spaceName });
  }

  // ── Step 5: data generation ────────────────────────────────────────────────
  const { dataChoices } = await inquirer.prompt<{ dataChoices: string[] }>([
    {
      type: 'checkbox',
      name: 'dataChoices',
      message: 'Generate sample data (select any):',
      choices: [
        { name: 'Alerts + Attack Discoveries', value: 'alerts' },
        { name: 'Cases', value: 'cases' },
        { name: 'Events', value: 'events' },
      ],
    },
  ]);

  const generateAlerts = dataChoices.includes('alerts');
  const generateCases = dataChoices.includes('cases');
  const generateEvents = dataChoices.includes('events');
  const dataGenRequested = generateAlerts || generateCases || generateEvents;

  // ── Step 6: Kibana repo path (only when data gen is requested) ─────────────
  let kibanaRepoPath = '';

  if (dataGenRequested) {
    const { repoPath } = await inquirer.prompt<{ repoPath: string }>([
      {
        type: 'input',
        name: 'repoPath',
        message: 'Path to local kibana repository (leave empty to skip data generation):',
        default: '',
        validate: (input: string): boolean | string => {
          const trimmed = input.trim();
          if (trimmed.length === 0) return true; // skip is valid
          if (!fs.existsSync(trimmed))
            return `Path does not exist: ${trimmed}`;
          return true;
        },
        filter: (input: string): string => input.trim(),
      },
    ]);
    kibanaRepoPath = repoPath;
  }

  return {
    name,
    region,
    version,
    spaces,
    dataTypes: {
      kibanaRepoPath,
      generateAlerts,
      generateCases,
      generateEvents,
    },
  };
}
