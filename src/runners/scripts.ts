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

/**
 * Cases plugin location changed in the Kibana monorepo restructure.
 * We try the new path first, then fall back to the old one.
 */
const NEW_CASES_SCRIPT_REL = path.join(
  'x-pack', 'platform', 'plugins', 'shared', 'cases', 'scripts', 'generate_cases.js',
);
const OLD_CASES_SCRIPT_REL = path.join(
  'x-pack', 'plugins', 'cases', 'scripts', 'generate_cases.js',
);

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

  const newCasesScript = path.join(resolvedRepoPath, NEW_CASES_SCRIPT_REL);
  const oldCasesScript = path.join(resolvedRepoPath, OLD_CASES_SCRIPT_REL);
  let generateCasesScript: string;
  if (fs.existsSync(newCasesScript)) {
    generateCasesScript = newCasesScript;
  } else if (fs.existsSync(oldCasesScript)) {
    generateCasesScript = oldCasesScript;
  } else {
    throw new Error(
      `Could not find generate cases script inside "${resolvedRepoPath}".\n` +
        `Looked for:\n  (new) ${newCasesScript}\n  (old) ${oldCasesScript}`,
    );
  }

  return {
    scriptDir,
    generateCli: path.join(scriptDir, GENERATE_CLI_REL),
    // testGenerate is the cwd from which `yarn test:generate` is invoked.
    testGenerate: scriptDir,
    generateCasesScript,
  };
}

/**
 * Extracts the package name from a yarn integrity-check error message.
 * Returns `null` if the message does not match the expected pattern.
 *
 * Matched pattern:
 *   error https://registry.yarnpkg.com/<pkg>/-/...: Integrity check failed
 */
export function extractIntegrityPackage(stderr: string): string | null {
  const match =
    /error https?:\/\/registry\.yarnpkg\.com\/((?:@[^/]+\/)?[^/]+)\/-\/.*: Integrity check failed/.exec(
      stderr,
    );
  if (match?.[1] === undefined) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Runs `yarn cache clean [packageName]` in the Kibana repo directory.
 * Omit `packageName` to wipe the entire yarn cache.
 * Full output is streamed to the terminal.
 */
async function runYarnCacheClean(kibanaRepoPath: string, packageName?: string): Promise<void> {
  const args =
    packageName !== undefined ? ['cache', 'clean', packageName] : ['cache', 'clean'];
  const label =
    packageName !== undefined
      ? `Cleaning yarn cache for ${packageName}`
      : 'Cleaning full yarn cache';
  await spawnProcess(YARN_CMD, args, kibanaRepoPath, process.env, label, {
    passthroughOutput: true,
  });
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
 * When bootstrap fails due to a yarn integrity-check error the function
 * automatically cleans the affected package cache and retries. If a second
 * integrity error is encountered the entire yarn cache is wiped before a
 * final (third) attempt. Any non-integrity failure throws immediately without
 * retrying. A maximum of three bootstrap attempts is ever made.
 *
 * Throws a clear, actionable error if all attempts fail so the caller can
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

  const runBootstrap = (): Promise<void> =>
    spawnProcess(YARN_CMD, ['kbn', 'bootstrap'], resolvedRepoPath, process.env, 'Bootstrapping Kibana', {
      passthroughOutput: true,
    });

  // Attempt 1
  let bootstrapError: unknown;
  try {
    await runBootstrap();
    return;
  } catch (err) {
    bootstrapError = err;
  }

  const firstMessage = getErrorMessage(bootstrapError);
  const firstPackage = extractIntegrityPackage(firstMessage);

  if (firstPackage === null) {
    throw new Error(
      `Bootstrap failed. Please run 'yarn kbn bootstrap' manually in your Kibana repo and try again. Underlying error: ${firstMessage}`,
      { cause: bootstrapError },
    );
  }

  // Integrity error on attempt 1 — clean the specific package cache and retry.
  logger.info(`Yarn integrity error for ${firstPackage}. Cleaning package cache...`);
  await runYarnCacheClean(resolvedRepoPath, firstPackage);

  // Attempt 2
  try {
    await runBootstrap();
    return;
  } catch (err) {
    bootstrapError = err;
  }

  const secondMessage = getErrorMessage(bootstrapError);
  const secondPackage = extractIntegrityPackage(secondMessage);

  if (secondPackage === null) {
    throw new Error(
      `Bootstrap failed. Please run 'yarn kbn bootstrap' manually in your Kibana repo and try again. Underlying error: ${secondMessage}`,
      { cause: bootstrapError as Error },
    );
  }

  // Integrity error on attempt 2 — wipe the entire yarn cache and make a
  // final attempt. Warn clearly because this affects all projects on the host.
  logger.warn('Multiple integrity errors. Cleaning full yarn cache...');
  logger.warn('Warning: clearing full yarn cache — this affects all projects on this machine');
  await runYarnCacheClean(resolvedRepoPath);

  // Attempt 3 (final)
  try {
    await runBootstrap();
    return;
  } catch (err) {
    bootstrapError = err;
  }

  const finalMessage = getErrorMessage(bootstrapError);
  throw new Error(
    `Bootstrap failed. Please run 'yarn kbn bootstrap' manually in your Kibana repo and try again. Underlying error: ${finalMessage}`,
    { cause: bootstrapError as Error },
  );
}

/**
 * Normalises a Cloud endpoint URL for yarn test:generate:
 * - Replaces port :443 (with optional trailing slash) with :9243.
 * - Strips any remaining trailing slash.
 * Elastic Cloud uses valid SSL certificates, so this tool does not need to
 * force-set NODE_TLS_REJECT_UNAUTHORIZED for the downstream script.
 */
function normalizeUrl(url: string): string {
  return url.replace(/:443(\/?)$/, ':9243').replace(/\/$/, '');
}

/**
 * Embeds `username:password` into a URL's authority component so it can be
 * passed to scripts that require credentials in the URL rather than as
 * separate flags. Existing embedded credentials are overwritten safely.
 */
function embedCredentialsInUrl(url: string, username: string, password: string): string {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }
    parsedUrl.username = username;
    parsedUrl.password = password;
    return parsedUrl.toString();
  } catch (error) {
    throw new Error(
      `Invalid HTTP(S) URL for embedding credentials: ${url}. ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Runs `yarn test:generate` inside the security_solution plugin directory to
 * populate resolver / event data.
 *
 * The script's interface requires credentials to be embedded directly in the
 * `--node` and `--kibana` URL flags (e.g. `https://user:pass@host`).  There is
 * no environment-variable alternative, so this is the only way to pass auth.
 */
export async function runGenerateEvents(
  kibanaRepoPath: string,
  kibanaUrl: string,
  credentials: ElasticCredentials,
): Promise<void> {
  const { scriptDir } = detectKibanaScriptPaths(kibanaRepoPath);

  // Warn once so the operator is aware credentials will appear in the process
  // argument list for the duration of the script run.
  logger.warn(
    'Passing Elasticsearch/Kibana credentials embedded in URLs for yarn test:generate; ' +
      'they may be visible in process listings while the script runs.',
  );

  // normalizeUrl is applied before embedding so the URL parser sees the correct
  // port, and again after because new URL().toString() re-adds a trailing slash
  // for root-path URLs.
  const esUrlWithCreds = normalizeUrl(
    embedCredentialsInUrl(normalizeUrl(credentials.url), credentials.username, credentials.password),
  );
  const kibanaUrlWithCreds = normalizeUrl(
    embedCredentialsInUrl(normalizeUrl(kibanaUrl), credentials.username, credentials.password),
  );

  const args = ['test:generate', '--node', esUrlWithCreds, '--kibana', kibanaUrlWithCreds];
  const env = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;

  await spawnProcess(YARN_CMD, args, scriptDir, env, 'Generating events', {
    passthroughOutput: true,
  });
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

  // generate_cli.js reads --password from CLI flags, not from environment variables.
  if (credentials.password.trim().length > 0) {
    logger.warn(
      'Passing Elasticsearch password via --password to generate_cli.js; this may be visible in process listings while the script runs.',
    );
  }

  const args = [
    '--attacks',
    '--kibanaUrl', kibanaUrl,
    '--elasticsearchUrl', credentials.url,
    '--username', credentials.username,
    '--password', credentials.password,
  ];
  const trimmedSpaceId = spaceId?.trim();
  // Skip --spaceId for the default space — the script already targets it by default.
  if (trimmedSpaceId && trimmedSpaceId !== 'default') {
    args.push('--spaceId', trimmedSpaceId);
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
 * Runs `node generate_cases.js` from the cases plugin to create sample case
 * data. This script uses `--kibana` and `--space` (not the generate_cli.js
 * convention).
 */
export async function runGenerateCases(
  kibanaRepoPath: string,
  kibanaUrl: string,
  credentials: ElasticCredentials,
  spaceId?: string,
): Promise<void> {
  const { generateCasesScript, scriptDir } = detectKibanaScriptPaths(kibanaRepoPath);

  if (typeof credentials.password === 'string' && credentials.password.trim().length > 0) {
    logger.warn(
      'Passing Elasticsearch password via --password to generate_cases.js; this may be visible in process listings while the script runs.',
    );
  }

  const args = [
    '--kibana', kibanaUrl,
    '--username', credentials.username,
    '--password', credentials.password,
  ];
  // Skip --space for the default space — the script already targets it by default.
  if (spaceId !== undefined && spaceId.trim().length > 0 && spaceId.trim() !== 'default') {
    args.push('--space', spaceId.trim());
  }

  await spawnProcess(
    'node',
    [generateCasesScript, ...args],
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
 * Execution order: alerts → events → cases.
 * Alerts run first because they are the most reliable; events (which contacts
 * a local Elasticsearch proxy) is run second so a connection failure there
 * does not block or obscure alert generation output.
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

  // 1. Alerts — most reliable, run first.
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

  // 2. Events — run after alerts so a local-proxy failure does not obscure alert output.
  if (options.generateEvents) {
    try {
      await runGenerateEvents(options.kibanaRepoPath, options.kibanaUrl, options.credentials);
      result.eventsRan = true;
    } catch (err) {
      result.errors.push(`Events generation failed: ${enhanceModuleError(getErrorMessage(err))}`);
    }
  }

  // 3. Cases.
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
