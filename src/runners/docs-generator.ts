import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import type {
  DocsGeneratorConfigOptions,
  ElasticCredentials,
  StandardSequenceOptions,
} from '../types';
import { VOLUME_PRESETS } from '../config/volume-presets';
import { getErrorMessage } from '../utils/errors';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_URL = 'https://github.com/elastic/security-documents-generator.git';
const EVENT_INDEX = 'logs-testlogs-default';

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote-escapes a string so it is safe to embed inside a bash -c
 * command. Replaces every `'` with `'\''`.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// nvm detection
// ---------------------------------------------------------------------------

/**
 * Returns the resolved `NVM_DIR` path if `nvm.sh` exists at that location,
 * or `undefined` if nvm is not present on this machine.
 */
function resolveNvmDir(): string | undefined {
  const nvmDir =
    process.env.NVM_DIR ?? path.join(process.env.HOME ?? '~', '.nvm');
  return fs.existsSync(path.join(nvmDir, 'nvm.sh')) ? nvmDir : undefined;
}

// ---------------------------------------------------------------------------
// Low-level process helper
// ---------------------------------------------------------------------------

/**
 * Spawns a child process, streams stdout/stderr to the terminal, and
 * resolves on exit code 0. Rejects with a descriptive error otherwise.
 */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks: string[] = [];

    child.stdout?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      stderrChunks.push(text);
      process.stderr.write(text);
    });

    child.on('error', (err: Error) => {
      reject(new Error(getErrorMessage(err)));
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        const codeStr = code !== null ? String(code) : 'unknown';
        const stderr = stderrChunks.join('').trim();
        const detail = stderr.length > 0 ? `\nstderr:\n${stderr}` : '';
        reject(new Error(`Process exited with code ${codeStr}${detail}`));
      }
    });
  });
}

/**
 * Runs a yarn command inside `dir` using nvm to switch to the repo's required
 * Node version. Falls back to the Node currently on PATH when nvm is absent,
 * logging a warning so the operator knows which Node version is being used.
 */
async function runWithNvm(dir: string, yarnArgs: string[]): Promise<void> {
  const nvmDir = resolveNvmDir();

  if (nvmDir !== undefined) {
    const argsEscaped = yarnArgs.map(shellQuote).join(' ');
    const cmd =
      `source "${nvmDir}/nvm.sh" && nvm use >/dev/null 2>&1 && yarn ${argsEscaped}`;
    const env: NodeJS.ProcessEnv = { ...process.env, NVM_DIR: nvmDir };
    await runCommand('bash', ['-c', cmd], dir, env);
  } else {
    logger.warn('nvm not found; using the Node on PATH');
    await runCommand('yarn', yarnArgs, dir, process.env);
  }
}

// ---------------------------------------------------------------------------
// config.json shape (internal)
// ---------------------------------------------------------------------------

interface NodeAuthConfig {
  node: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

interface DocsGeneratorConfig {
  elastic: NodeAuthConfig;
  kibana: NodeAuthConfig;
  serverless: boolean;
  eventIndex: string;
}

function buildNodeAuthConfig(
  nodeUrl: string,
  credentials: ElasticCredentials,
): NodeAuthConfig {
  if (credentials.apiKey !== undefined && credentials.apiKey.length > 0) {
    return { node: nodeUrl, apiKey: credentials.apiKey };
  }
  return {
    node: nodeUrl,
    username: credentials.username,
    password: credentials.password,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensures the `security-documents-generator` repository is present at `dir`.
 *
 * - If `<dir>/.git` already exists: fetches all remotes and attempts a
 *   fast-forward pull. A pull failure is logged as a warning and does NOT
 *   throw — the existing checkout is still usable.
 * - Otherwise: clones the repository from GitHub into `dir`.
 */
export async function ensureRepoCloned(dir: string): Promise<void> {
  const gitDir = path.join(dir, '.git');

  if (fs.existsSync(gitDir)) {
    logger.info(`Updating security-documents-generator in ${dir}…`);
    await runCommand(
      'git',
      ['-C', dir, 'fetch', '--all', '--tags', '--prune'],
      path.dirname(dir),
    );
    try {
      await runCommand('git', ['-C', dir, 'pull', '--ff-only'], path.dirname(dir));
    } catch (err) {
      logger.warn(
        `Could not fast-forward pull in ${dir}: ${getErrorMessage(err)}`,
      );
    }
  } else {
    logger.info(`Cloning security-documents-generator into ${dir}…`);
    await runCommand('git', ['clone', REPO_URL, dir], path.dirname(dir));
  }
}

/**
 * Writes `<dir>/config.json` with the credentials and mode required by the
 * docs-generator. Always overwrites so the call is idempotent.
 *
 * Uses `apiKey` authentication when `options.credentials.apiKey` is set;
 * falls back to `username`/`password` otherwise.
 */
export async function writeConfig(
  dir: string,
  options: DocsGeneratorConfigOptions,
): Promise<void> {
  const config: DocsGeneratorConfig = {
    elastic: buildNodeAuthConfig(options.elasticsearchUrl, options.credentials),
    kibana: buildNodeAuthConfig(options.kibanaUrl, options.credentials),
    serverless: options.mode === 'serverless',
    eventIndex: EVENT_INDEX,
  };
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Runs `yarn install --silent` inside `dir` using the Node version managed
 * by nvm. Throws on failure so the caller knows dependencies are broken
 * before attempting to run any generator commands.
 */
export async function installDependencies(dir: string): Promise<void> {
  logger.info('Installing security-documents-generator dependencies…');
  await runWithNvm(dir, ['install', '--silent']);
}

/**
 * Runs `yarn start <args...>` inside `dir` using the correct Node version.
 * A non-zero exit is logged as a warning but does NOT throw — the caller's
 * sequence continues regardless. This mirrors the bash `|| warn` fallback.
 */
export async function runDocsGeneratorCommand(
  dir: string,
  args: readonly string[],
  description: string,
): Promise<void> {
  try {
    await runWithNvm(dir, ['start', ...args]);
  } catch (err) {
    logger.warn(
      `Comando falló (seguimos): yarn start ${description}: ${getErrorMessage(err)}`,
    );
  }
}

/**
 * Runs the full nine-command standard data-generation sequence for the given
 * space and volume preset. Individual command failures are swallowed as
 * warnings (via {@link runDocsGeneratorCommand}) so the sequence always
 * completes.
 */
export async function runStandardSequence(
  dir: string,
  options: StandardSequenceOptions,
): Promise<void> {
  const preset = VOLUME_PRESETS[options.volume];

  const commands: ReadonlyArray<string[]> = [
    [
      'org-data',
      '--size', preset.orgSize,
      '--productivity-suite', 'microsoft',
      '--detection-rules',
      '--space', options.space,
    ],
    ['rules'],
    [
      'generate-alerts',
      '-n', String(preset.extraAlerts),
      '-h', String(preset.hosts),
      '-u', String(preset.users),
    ],
    ['quick-entity-store'],
    ['generate-asset-criticality'],
    ['test-risk-score'],
    ['generate-entity-ai-insights'],
    ['privmon-quick', '--space', options.space],
    ['csp', '--data-sources', 'all', '--findings-count', '500'],
  ];

  for (const cmd of commands) {
    const name = cmd[0] ?? 'unknown';
    await runDocsGeneratorCommand(dir, cmd, name);
  }
}
