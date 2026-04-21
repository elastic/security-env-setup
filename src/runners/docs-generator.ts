import fs from 'fs';
import { writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import * as inquirer from 'inquirer';
import type {
  DocsGeneratorConfigOptions,
  ElasticCredentials,
  StandardSequenceOptions,
} from '../types';
import { VOLUME_PRESETS } from '../config/volume-presets';
import { getErrorMessage } from '../utils/errors';
import logger from '../utils/logger';
import {
  listNvmNodeVersions,
  findNode24OrNewer,
  type NvmNodeVersion,
} from '../utils/node-version';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_URL = 'https://github.com/elastic/security-documents-generator.git';
const EVENT_INDEX = 'logs-testlogs-default';

/** Maximum wall-clock time allowed for a single `yarn start <cmd>` invocation. */
const DOCS_GENERATOR_COMMAND_TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes per command

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
  const nvmDir = process.env.NVM_DIR ?? path.join(process.env.HOME || os.homedir(), '.nvm');
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
 * Builds the bash `-c` script that sources nvm, switches to the repo's
 * required Node version, then runs yarn with the given args. Extracted so
 * both {@link runWithNvm} and {@link ensureNode24Installed} can reuse it.
 */
function buildNvmBashCommand(nvmDir: string, yarnArgs: string[]): string {
  const argsEscaped = yarnArgs.map(shellQuote).join(' ');
  return `source "${nvmDir}/nvm.sh" && nvm use >/dev/null 2>&1 && yarn ${argsEscaped}`;
}

/**
 * Runs a yarn command inside `dir` using nvm to switch to the repo's required
 * Node version. Falls back to the Node currently on PATH when nvm is absent,
 * logging a warning so the operator knows which Node version is being used.
 */
async function runWithNvm(dir: string, yarnArgs: string[]): Promise<void> {
  const nvmDir = resolveNvmDir();

  if (nvmDir !== undefined) {
    const cmd = buildNvmBashCommand(nvmDir, yarnArgs);
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
 *
 * A per-command wall-clock timeout of {@link DOCS_GENERATOR_COMMAND_TIMEOUT_MS}
 * is enforced:
 *   1. On expiry the process group receives SIGTERM.
 *   2. After a 5-second grace period, SIGKILL is sent if the group is still
 *      alive (the inner timer is `.unref()`-ed so it does not block the
 *      Node event loop).
 *
 * Neither a non-zero exit nor a timeout throws — both are logged as warnings
 * so the caller's sequence always continues.
 */
export async function runDocsGeneratorCommand(
  dir: string,
  args: readonly string[],
  description: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    // ── Resolve command / env based on nvm availability ────────────────────
    const nvmDir = resolveNvmDir();
    let command: string;
    let spawnArgs: string[];
    let env: NodeJS.ProcessEnv;

    if (nvmDir !== undefined) {
      command = 'bash';
      spawnArgs = ['-c', buildNvmBashCommand(nvmDir, ['start', ...args])];
      env = { ...process.env, NVM_DIR: nvmDir };
    } else {
      logger.warn('nvm not found; using the Node on PATH');
      command = 'yarn';
      spawnArgs = ['start', ...args];
      env = process.env;
    }

    // ── Spawn with detached:true so we can kill the whole process group ────
    const child = spawn(command, spawnArgs, {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      process.stderr.write(text);
    });

    // ── Timeout: SIGTERM → 5 s grace → SIGKILL ────────────────────────────
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // process group may have already exited
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, 5_000).unref();
    }, DOCS_GENERATOR_COMMAND_TIMEOUT_MS);

    // ── Process exit ──────────────────────────────────────────────────────
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutHandle);

      if (timedOut) {
        logger.warn(
          `Command exceeded ${DOCS_GENERATOR_COMMAND_TIMEOUT_MS / 1_000}s and was terminated (continuing): yarn start ${description}`,
        );
        resolve();
        return;
      }

      if (code === 0) {
        resolve();
      } else {
        const codeStr = code !== null ? String(code) : 'unknown';
        logger.warn(
          `Command failed (continuing): yarn start ${description}: exit code ${codeStr}`,
        );
        resolve();
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutHandle);
      logger.warn(
        `Command failed (continuing): yarn start ${description}: ${getErrorMessage(err)}`,
      );
      resolve();
    });
  });
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

  const commands: ReadonlyArray<[string, ...string[]]> = [
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
    await runDocsGeneratorCommand(dir, cmd, cmd[0]);
  }
}

// ---------------------------------------------------------------------------
// Node 24 preflight check
// ---------------------------------------------------------------------------

const NODE24_REQUIRED_MSG =
  "Node 24 is required for security-documents-generator. " +
  "Run 'nvm install 24' manually and re-launch the CLI. " +
  "Aborting local setup.";

/**
 * Verifies that Node 24 (or newer) is available through nvm.
 *
 * - If already installed: logs at info level and returns the version.
 * - If absent: lists installed versions, asks the operator whether to install
 *   via `nvm install 24`, runs the install if confirmed, then re-checks.
 * - Throws with a descriptive message if the operator declines or if the
 *   re-check still finds no Node 24+.
 */
export async function ensureNode24Installed(): Promise<NvmNodeVersion> {
  const versions = await listNvmNodeVersions();
  const found = findNode24OrNewer(versions);

  if (found !== undefined) {
    logger.info(`Node ${found.raw} found via nvm — preflight check passed.`);
    return found;
  }

  const installedList =
    versions.length > 0 ? versions.map((v) => v.raw).join(', ') : '(none)';
  logger.warn(`Node 24+ not found. nvm-managed versions: ${installedList}`);

  const answer = await inquirer.prompt<{ install: boolean }>([
    {
      type: 'confirm',
      name: 'install',
      message: 'Node 24 is required. Install it now via nvm?',
      default: true,
    },
  ]);

  if (!answer.install) {
    throw new Error(NODE24_REQUIRED_MSG);
  }

  const nvmDir = process.env.NVM_DIR ?? path.join(process.env.HOME || os.homedir(), '.nvm');
  const installCmd = `source "${nvmDir}/nvm.sh" && nvm install 24`;
  await runCommand('bash', ['-c', installCmd], process.cwd(), {
    ...process.env,
    NVM_DIR: nvmDir,
  });

  const versionsAfter = await listNvmNodeVersions();
  const foundAfter = findNode24OrNewer(versionsAfter);

  if (foundAfter === undefined) {
    throw new Error(NODE24_REQUIRED_MSG);
  }

  return foundAfter;
}
