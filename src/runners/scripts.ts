import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ora from 'ora';
import type {
  ElasticCredentials,
  DataGenerationRunOptions,
  DataGenerationResult,
  KibanaScriptPaths,
} from '../types';
import { getErrorMessage } from '../utils/errors';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Newer Kibana versions (post-restructure) moved the security_solution plugin
 * into the "solutions" sub-tree. We try the new path first, then fall back.
 */
const NEW_PLUGIN_REL = path.join(
  'x-pack',
  'solutions',
  'security',
  'plugins',
  'security_solution',
);
const OLD_PLUGIN_REL = path.join('x-pack', 'plugins', 'security_solution');

/** Path to the shared data-generation entry point, relative to the plugin root. */
const GENERATE_CLI_REL = path.join('scripts', 'data', 'generate_cli.js');

/** Resolve the correct yarn binary name for the host platform. */
const YARN_CMD = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the child process environment.
 * Credentials are injected as environment variables — never as CLI flags —
 * to avoid exposing sensitive values in `ps aux` output.
 */
function buildScriptEnv(kibanaUrl: string, credentials: ElasticCredentials): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIBANA_URL: kibanaUrl,
    ELASTICSEARCH_URL: credentials.url,
    ELASTICSEARCH_USERNAME: credentials.username,
    ELASTICSEARCH_PASSWORD: credentials.password,
  };
}

/**
 * Wraps a spawned child process in a Promise.
 *
 * - stdin is ignored (scripts are non-interactive).
 * - stdout/stderr are piped; the last non-empty line updates the spinner text
 *   so the user sees real-time progress without raw scrolling output.
 * - stderr is captured in full and appended to the rejection error message so
 *   failures are easy to debug.
 * - Resolves on exit code 0; rejects with a descriptive error otherwise.
 */
function spawnProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  spinnerLabel: string,
  options?: { passthroughOutput?: boolean },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const passthroughOutput = options?.passthroughOutput === true;
    const spinner = passthroughOutput ? undefined : ora(spinnerLabel).start();
    const stderrChunks: string[] = [];

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const updateSpinner = (chunk: unknown): void => {
      if (spinner === undefined) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      // Show only the last non-empty line to keep the spinner tidy.
      const lastLine = text.split('\n').reverse().find((l) => l.trim().length > 0) ?? '';
      if (lastLine.length > 0) {
        spinner.text = `${spinnerLabel} — ${lastLine.trim().slice(0, 80)}`;
      }
    };

    child.stdout?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      if (passthroughOutput) {
        process.stdout.write(text);
      } else {
        updateSpinner(text);
      }
    });

    child.stderr?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      stderrChunks.push(text);
      if (passthroughOutput) {
        process.stderr.write(text);
      } else {
        updateSpinner(chunk);
      }
    });

    child.on('error', (err: Error) => {
      if (spinner !== undefined) {
        spinner.fail(`${spinnerLabel} — failed to start`);
      }
      const message =
        'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Command not found: "${command}". Make sure it is installed and on PATH.`
          : err.message;
      reject(new Error(message));
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        if (spinner !== undefined) {
          spinner.succeed(`${spinnerLabel} — done`);
        } else {
          logger.success(`${spinnerLabel} — done`);
        }
        resolve();
      } else {
        const codeStr = code !== null ? String(code) : 'unknown';
        const stderr = stderrChunks.join('').trim();
        const detail = stderr.length > 0 ? `\nstderr:\n${stderr}` : '';
        if (spinner !== undefined) {
          spinner.fail(`${spinnerLabel} — exited with code ${codeStr}`);
        } else {
          logger.error(`${spinnerLabel} — exited with code ${codeStr}`);
        }
        reject(new Error(`Process exited with code ${codeStr}${detail}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects whether the Kibana repo uses the new or the old plugin directory
 * layout, and returns fully-resolved paths for all scripts used by the data
 * generation commands.
 *
 * @throws if `kibanaRepoPath` does not exist or neither plugin path is found.
 */
export function detectKibanaScriptPaths(kibanaRepoPath: string): KibanaScriptPaths {
  const resolvedRepoPath = path.resolve(kibanaRepoPath);

  if (!fs.existsSync(resolvedRepoPath)) {
    throw new Error(`Kibana repository not found at: ${resolvedRepoPath}`);
  }

  const newScriptDir = path.join(resolvedRepoPath, NEW_PLUGIN_REL);
  const oldScriptDir = path.join(resolvedRepoPath, OLD_PLUGIN_REL);

  let scriptDir: string;

  if (fs.existsSync(newScriptDir)) {
    scriptDir = newScriptDir;
  } else if (fs.existsSync(oldScriptDir)) {
    scriptDir = oldScriptDir;
  } else {
    throw new Error(
      `Could not find security_solution plugin inside "${resolvedRepoPath}".\n` +
        `Looked for:\n  (new) ${newScriptDir}\n  (old) ${oldScriptDir}`,
    );
  }

  return {
    scriptDir,
    generateCli: path.join(scriptDir, GENERATE_CLI_REL),
    // testGenerate is the cwd from which `yarn test:generate` is invoked.
    testGenerate: scriptDir,
  };
}

/**
 * Checks whether Kibana's Node dependencies are installed and, if not, runs
 * `yarn kbn bootstrap` in the repo root before any data-generation scripts.
 *
 * Bootstrap is detected by the presence of `node_modules/@kbn/test-es-server`,
 * a package that is only written during bootstrap and is required by the
 * data-generation scripts. If it is absent bootstrap is triggered and full
 * process output is streamed to the terminal.
 *
 * Throws a clear, actionable error if bootstrap fails so the caller can
 * surface it rather than receiving a cryptic "Cannot find module" from a
 * downstream script.
 */
export async function ensureKibanaBootstrapped(kibanaRepoPath: string): Promise<void> {
  const resolvedRepoPath = path.resolve(kibanaRepoPath);

  if (!fs.existsSync(resolvedRepoPath)) {
    throw new Error(`Kibana repository not found at: ${resolvedRepoPath}`);
  }

  const markerPath = path.join(resolvedRepoPath, 'node_modules', '@kbn', 'test-es-server');

  if (fs.existsSync(markerPath)) {
    logger.success('Kibana dependencies ready.');
    return;
  }

  logger.warn(
    "Kibana dependencies not found. Running yarn kbn bootstrap — this may take 20-40 minutes...",
  );

  try {
    await spawnProcess(
      YARN_CMD,
      ['kbn', 'bootstrap'],
      resolvedRepoPath,
      process.env,
      'Bootstrapping Kibana',
      { passthroughOutput: true },
    );
  } catch (err) {
    throw new Error(
      `Bootstrap failed. Please run 'yarn kbn bootstrap' manually in your Kibana repo and try again. Underlying error: ${getErrorMessage(
        err,
      )}`,
      { cause: err as Error },
    );
  }
}

/**
 * Runs `yarn test:generate` inside the security_solution plugin directory to
 * populate resolver / event data. Credentials are passed via environment
 * variables rather than CLI args.
 */
export async function runGenerateEvents(
  kibanaRepoPath: string,
  kibanaUrl: string,
  credentials: ElasticCredentials,
): Promise<void> {
  const { testGenerate } = detectKibanaScriptPaths(kibanaRepoPath);
  const env = buildScriptEnv(kibanaUrl, credentials);

  // Non-sensitive flags are passed as CLI args; the password is in the env.
  await spawnProcess(
    YARN_CMD,
    ['test:generate', '--kibana', kibanaUrl, '--username', credentials.username],
    testGenerate,
    env,
    'Generating events',
  );
}

/**
 * Runs `node generate_cli.js --attacks` to create alert and attack-discovery
 * data. Optionally scopes the run to a specific Kibana space.
 */
export async function runGenerateAttacks(
  kibanaRepoPath: string,
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaceId?: string,
): Promise<void> {
  const { generateCli, scriptDir } = detectKibanaScriptPaths(kibanaRepoPath);

  if (!fs.existsSync(generateCli)) {
    throw new Error(`generate_cli.js not found at: ${generateCli}`);
  }

  const args = ['--attacks', '--kibana', kibanaUrl, '--username', credentials.username];
  if (spaceId !== undefined && spaceId.trim().length > 0) {
    args.push('--space', spaceId.trim());
  }

  await spawnProcess(
    'node',
    [generateCli, ...args],
    scriptDir,
    buildScriptEnv(kibanaUrl, credentials),
    'Generating alerts & attack discoveries',
  );
}

/**
 * Runs `node generate_cli.js --cases` to create sample case data.
 * Optionally scopes the run to a specific Kibana space.
 */
export async function runGenerateCases(
  kibanaRepoPath: string,
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaceId?: string,
): Promise<void> {
  const { generateCli, scriptDir } = detectKibanaScriptPaths(kibanaRepoPath);

  if (!fs.existsSync(generateCli)) {
    throw new Error(`generate_cli.js not found at: ${generateCli}`);
  }

  const args = ['--cases', '--kibana', kibanaUrl, '--username', credentials.username];
  if (spaceId !== undefined && spaceId.trim().length > 0) {
    args.push('--space', spaceId.trim());
  }

  await spawnProcess(
    'node',
    [generateCli, ...args],
    scriptDir,
    buildScriptEnv(kibanaUrl, credentials),
    'Generating cases',
  );
}

/**
 * If `msg` contains "Cannot find module" it appends a bootstrap hint so the
 * error surfaced to the user is immediately actionable.
 */
function enhanceModuleError(msg: string): string {
  if (!msg.includes('Cannot find module')) return msg;
  return `${msg}\nHint: Run 'yarn kbn bootstrap' in your Kibana repo and try again.`;
}

/**
 * Orchestrates all selected data-generation scripts sequentially.
 * Individual script failures are captured in `result.errors` and do not abort
 * the remaining scripts.
 *
 * @throws only if `kibanaRepoPath` does not exist — all script-level errors
 *   are captured in `DataGenerationResult.errors`.
 */
export async function runAllDataGeneration(
  options: DataGenerationRunOptions,
): Promise<DataGenerationResult> {
  const result: DataGenerationResult = {
    eventsRan: false,
    alertsRan: false,
    casesRan: false,
    errors: [],
  };

  // Validate the repo path once — fail early before touching any scripts.
  const resolvedRepoPath = path.resolve(options.kibanaRepoPath);
  if (!fs.existsSync(resolvedRepoPath)) {
    throw new Error(`Kibana repository not found at: ${resolvedRepoPath}`);
  }

  const hasRequestedGeneration =
    options.generateEvents || options.generateAlerts || options.generateCases;

  // Ensure dependencies are present before running any selected script.
  // Individual runGenerate* functions already validate their required script paths.
  if (hasRequestedGeneration) {
    await ensureKibanaBootstrapped(options.kibanaRepoPath);
  }

  if (options.generateEvents) {
    try {
      await runGenerateEvents(options.kibanaRepoPath, options.kibanaUrl, options.credentials);
      result.eventsRan = true;
    } catch (err) {
      result.errors.push(`Events generation failed: ${enhanceModuleError(getErrorMessage(err))}`);
    }
  }

  if (options.generateAlerts) {
    try {
      await runGenerateAttacks(
        options.kibanaRepoPath,
        options.kibanaUrl,
        options.credentials,
        options.spaceId,
      );
      result.alertsRan = true;
    } catch (err) {
      result.errors.push(`Alerts generation failed: ${enhanceModuleError(getErrorMessage(err))}`);
    }
  }

  if (options.generateCases) {
    try {
      await runGenerateCases(
        options.kibanaRepoPath,
        options.kibanaUrl,
        options.credentials,
        options.spaceId,
      );
      result.casesRan = true;
    } catch (err) {
      result.errors.push(`Cases generation failed: ${enhanceModuleError(getErrorMessage(err))}`);
    }
  }

  return result;
}
