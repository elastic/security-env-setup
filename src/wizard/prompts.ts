import fs from 'fs';
import * as inquirer from 'inquirer';
import type { DeploymentConfig, Environment, KibanaSpace } from '../types';
import { REGIONS } from '../regions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

export async function runWizard(): Promise<{ config: DeploymentConfig; environment: Environment }> {
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
      choices: REGIONS[environment],
    },
  ]);

  // ── Step 3: stack version ──────────────────────────────────────────────────
  // filter returns DEFAULT_VERSION when the user presses Enter without typing,
  // ensuring that accepting the default always produces a valid semver string.
  const { version } = await inquirer.prompt<{ version: string }>([
    {
      type: 'input',
      name: 'version',
      message: 'Stack version:',
      default: DEFAULT_VERSION,
      validate: (input: string): boolean | string => {
        if (!SEMVER_RE.test(input.trim()))
          return 'Version must be a valid semver (e.g. 8.17.1).';
        return true;
      },
      filter: (input: string): string => input.trim() || DEFAULT_VERSION,
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
          const trimmed = input.trim();
          if (trimmed.length === 0) return 'Space name is required.';
          const id = nameToId(trimmed);
          if (id.length === 0) return 'Space name must produce a valid ID (alphanumeric + hyphens).';
          if (spaces.some((s) => s.id === id))
            return `A space with ID "${id}" already exists. Choose a different name.`;
          if (spaces.some((s) => s.name.toLowerCase() === trimmed.toLowerCase()))
            return `A space named "${trimmed}" already exists.`;
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

  // ── Step 6: Kibana repo path + additional spaces (only when data gen requested) ──
  let kibanaRepoPath = '';
  let additionalDataSpaces: string[] = [];

  if (dataGenRequested) {
    const nonDefaultSpaces = spaces.filter((s) => s.id !== 'default');
    const { repoPath, additionalDataSpaces: selectedSpaces } = await inquirer.prompt<{
      repoPath: string;
      additionalDataSpaces: string[];
    }>([
      {
        type: 'input',
        name: 'repoPath',
        message: 'Path to local kibana repository (leave empty to skip data generation):',
        default: '',
        validate: (input: string): boolean | string => {
          const trimmed = input.trim();
          if (trimmed.length === 0) return true; // skip is valid
          if (!fs.existsSync(trimmed)) return `Path does not exist: ${trimmed}`;
          return true;
        },
        filter: (input: string): string => input.trim(),
      },
      {
        type: 'checkbox',
        name: 'additionalDataSpaces',
        message: 'Also generate data in additional spaces? (select any)',
        choices: nonDefaultSpaces.map((s) => ({ name: s.name, value: s.id })),
        when: (answers: Record<string, unknown>): boolean =>
          Boolean(answers['repoPath']) && nonDefaultSpaces.length > 0,
        default: [],
      },
    ]);
    kibanaRepoPath = repoPath;
    additionalDataSpaces = selectedSpaces ?? [];
  }

  return {
    config: {
      name,
      region,
      version,
      spaces,
      additionalDataSpaces,
      dataTypes: {
        kibanaRepoPath,
        generateAlerts,
        generateCases,
        generateEvents,
      },
    },
    environment,
  };
}
