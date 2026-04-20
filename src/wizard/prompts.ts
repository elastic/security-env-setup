import fs from 'fs';
import os from 'os';
import path from 'path';
import * as inquirer from 'inquirer';
import type {
  Environment,
  KibanaSpace,
  LocalWizardAnswers,
  Target,
  Volume,
  WizardResult,
} from '../types';
import { REGIONS } from '../regions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VERSION = '8.17.1';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DEPLOYMENT_NAME_RE = /^[a-zA-Z0-9-]+$/;
const SPACE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Shell-unsafe characters that are forbidden in the docs-generator directory path. */
const UNSAFE_PATH_RE = /[ '"$`;&|<>]/;

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

// ---------------------------------------------------------------------------
// Local target prompts
// ---------------------------------------------------------------------------

async function runLocalPrompts(
  target: 'local-stateful' | 'local-serverless',
): Promise<LocalWizardAnswers> {
  const defaultUsername =
    target === 'local-stateful' ? 'elastic' : 'elastic_serverless';
  const defaultKibanaDir = path.join(
    os.homedir(),
    'Documents',
    'Kibana',
    'kibana',
  );
  const defaultDocsDir = path.join(
    os.homedir(),
    'Documents',
    'Kibana',
    'security-documents-generator',
  );

  const answers = await inquirer.prompt<{
    kibanaDir: string;
    kibanaUrl: string;
    elasticsearchUrl: string;
    username: string;
    password: string;
    space: string;
    volume: Volume;
    docsGeneratorDir: string;
    installSampleData: boolean;
  }>([
    {
      type: 'input',
      name: 'kibanaDir',
      message: 'Path to your Kibana checkout:',
      default: defaultKibanaDir,
      validate: (input: string): boolean | string => {
        const t = input.trim();
        if (!fs.existsSync(t)) return `Path does not exist: ${t}`;
        if (!fs.statSync(t).isDirectory()) return `Path is not a directory: ${t}`;
        if (!fs.existsSync(path.join(t, '.git')))
          return `Not a git repository (no .git directory): ${t}`;
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'input',
      name: 'kibanaUrl',
      message: 'Kibana URL:',
      default: 'http://localhost:5601',
      validate: (input: string): boolean | string => {
        const t = input.trim();
        if (t.length === 0) return 'Kibana URL is required.';
        if (!t.startsWith('http://') && !t.startsWith('https://'))
          return 'URL must start with http:// or https://.';
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'input',
      name: 'elasticsearchUrl',
      message: 'Elasticsearch URL:',
      default: 'http://localhost:9200',
      validate: (input: string): boolean | string => {
        const t = input.trim();
        if (t.length === 0) return 'Elasticsearch URL is required.';
        if (!t.startsWith('http://') && !t.startsWith('https://'))
          return 'URL must start with http:// or https://.';
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'input',
      name: 'username',
      message: 'Username:',
      default: defaultUsername,
      validate: (input: string): boolean | string => {
        if (input.trim().length === 0) return 'Username is required.';
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password:',
      default: 'changeme',
      mask: '*',
      validate: (input: string): boolean | string => {
        if (input.trim().length === 0) return 'Password is required.';
        return true;
      },
    },
    {
      type: 'input',
      name: 'space',
      message: 'Kibana space ID:',
      default: 'default',
      validate: (input: string): boolean | string => {
        const t = input.trim();
        if (!SPACE_ID_RE.test(t))
          return (
            'Space ID must start with a lowercase letter or digit, and contain ' +
            'only lowercase alphanumeric characters, underscores, or hyphens.'
          );
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'list',
      name: 'volume',
      message: 'Data volume:',
      default: 'medium',
      choices: [
        { name: 'light — ~1k alerts, 5 hosts, 5 users', value: 'light' },
        { name: 'medium — ~10k alerts, 10 hosts, 10 users (recommended)', value: 'medium' },
        { name: 'heavy — ~50k alerts, 25 hosts, 25 users', value: 'heavy' },
      ],
    },
    {
      type: 'input',
      name: 'docsGeneratorDir',
      message: 'Path for security-documents-generator:',
      default: defaultDocsDir,
      validate: (input: string): boolean | string => {
        const t = input.trim();
        if (!path.isAbsolute(t)) return 'Path must be absolute.';
        if (UNSAFE_PATH_RE.test(t))
          return (
            "Path must not contain shell-unsafe characters " +
            "(space, ', \", $, `, ;, &, |, <, >)."
          );
        return true;
      },
      filter: (input: string): string => input.trim(),
    },
    {
      type: 'confirm',
      name: 'installSampleData',
      message: 'Install Kibana sample data (flights, ecommerce, logs)?',
      default: false,
    },
  ]);

  return { target, ...answers };
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export async function runWizard(): Promise<WizardResult> {
  // ── Step 0: environment type selection ────────────────────────────────────
  const { target } = await inquirer.prompt<{ target: Target }>([
    {
      type: 'list',
      name: 'target',
      message: 'What kind of environment do you want to create?',
      choices: [
        { name: 'Elastic Cloud (ECH)', value: 'elastic-cloud' },
        { name: 'Local stateful (self-hosted)', value: 'local-stateful' },
        { name: 'Local serverless', value: 'local-serverless' },
        { name: 'Serverless in QA', disabled: '(coming soon)' },
      ],
    },
  ]);

  // Local targets collect their own question set and return early.
  if (target === 'local-stateful' || target === 'local-serverless') {
    return runLocalPrompts(target);
  }

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
  const ranPerSpaceDataGeneration = generateAlerts || generateCases;

  // ── Step 6: Kibana repo path + additional spaces (only when data gen requested) ──
  let kibanaRepoPath = '';
  let additionalDataSpaces: string[] = [];

  if (dataGenRequested) {
    const nonDefaultSpaces = spaces.filter((s) => s.id !== 'default');
    const { repoPath, additionalDataSpaces: selectedSpaces } = await inquirer.prompt<{
      repoPath: string;
      additionalDataSpaces?: string[];
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
          Boolean(answers['repoPath']) && nonDefaultSpaces.length > 0 && ranPerSpaceDataGeneration,
        default: [],
      },
    ]);
    kibanaRepoPath = repoPath;
    additionalDataSpaces = ranPerSpaceDataGeneration ? (selectedSpaces ?? []) : [];
  }

  return {
    target,
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
