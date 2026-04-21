import axios from 'axios';
import { writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import * as inquirer from 'inquirer';
import ora from 'ora';
import type { ElasticCredentials } from '../types';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for each service liveness ping. */
const DETECTION_TIMEOUT_MS = 3_000;

/** Polling timeout for Elasticsearch health check after auto-launch. */
const ES_HEALTH_TIMEOUT_MS = 5 * 60 * 1_000;

/** Polling timeout for Kibana health check after auto-launch. */
const KIBANA_HEALTH_TIMEOUT_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ServiceCommand {
  name: 'Elasticsearch' | 'Kibana';
  /** The yarn command to run inside kibanaDir, e.g. "yarn es snapshot --license trial" */
  command: string;
  /** Working directory — the Kibana checkout root. */
  kibanaDir: string;
}

export interface AutoStartResult {
  method: 'already-running' | 'osascript' | 'assisted';
  kibana: boolean;
  elasticsearch: boolean;
}

export interface WaitUntilHealthyOptions {
  pingFn: () => Promise<boolean>;
  name: string;
  timeoutMs: number;
  /** Milliseconds between polls (default 5 000). */
  intervalMs?: number;
}

/**
 * Discriminated union returned by {@link probeKibana}.
 * - `healthy`  — Kibana responded with 2xx.
 * - `down`     — Kibana is unreachable or returned a non-actionable status.
 * - `basepath` — Kibana is reachable but running with a random basePath (302 redirect);
 *                `basePath` is the path prefix, e.g. `"/fxz"`.
 */
export type KibanaProbeResult =
  | { kind: 'healthy' }
  | { kind: 'down' }
  | { kind: 'basepath'; basePath: string };

/**
 * Discriminated union returned by {@link detectServices}.
 * - `ok`              — normal result with per-service booleans.
 * - `kibana-basepath` — Kibana is running with a random basePath; caller must abort.
 */
export type ServiceDetectionResult =
  | { kind: 'ok'; kibana: boolean; elasticsearch: boolean }
  | { kind: 'kibana-basepath'; basePath: string };

// ---------------------------------------------------------------------------
// probeKibana
// ---------------------------------------------------------------------------

/**
 * Probes Kibana at `/api/status` with `maxRedirects: 0` so that a 302
 * redirect caused by Kibana's random basePath is captured rather than
 * followed.
 *
 * Returns:
 * - `{ kind: 'healthy' }` — 2xx response.
 * - `{ kind: 'basepath', basePath }` — 302 whose Location ends with
 *   `/api/status`, indicating a random basePath prefix (e.g. `/fxz`).
 * - `{ kind: 'down' }` — any other status, network error, or 302 with an
 *   unrecognised Location.
 *
 * Never throws.
 */
export async function probeKibana(
  kibanaUrl: string,
  credentials: ElasticCredentials,
): Promise<KibanaProbeResult> {
  const token = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString('base64');
  const headers = { Authorization: `Basic ${token}` };

  try {
    const response = await axios.get<unknown>(`${kibanaUrl}/api/status`, {
      headers,
      timeout: DETECTION_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 300) {
      return { kind: 'healthy' };
    }

    if (response.status === 302) {
      const location =
        (response.headers as Record<string, string | undefined>)['location'] ?? '';
      const suffix = '/api/status';
      if (location.endsWith(suffix)) {
        const basePath = location.slice(0, -suffix.length);
        return { kind: 'basepath', basePath };
      }
      return { kind: 'down' };
    }

    return { kind: 'down' };
  } catch {
    return { kind: 'down' };
  }
}

// ---------------------------------------------------------------------------
// detectServices
// ---------------------------------------------------------------------------

/**
 * Pings Kibana (via {@link probeKibana}) and Elasticsearch to check whether
 * both services are reachable.
 *
 * Returns a {@link ServiceDetectionResult}:
 * - `{ kind: 'ok', kibana, elasticsearch }` — normal result.
 * - `{ kind: 'kibana-basepath', basePath }` — Kibana is up but using a random
 *   basePath; the caller must abort with an actionable error.
 *
 * Never throws.
 */
export async function detectServices(
  kibanaUrl: string,
  elasticsearchUrl: string,
  credentials: ElasticCredentials,
): Promise<ServiceDetectionResult> {
  const token = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString('base64');
  const headers = { Authorization: `Basic ${token}` };

  const [kibanaProbe, elasticsearch] = await Promise.all([
    probeKibana(kibanaUrl, credentials),
    axios
      .get<unknown>(`${elasticsearchUrl}/`, {
        headers,
        timeout: DETECTION_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false),
  ]);

  if (kibanaProbe.kind === 'basepath') {
    return { kind: 'kibana-basepath', basePath: kibanaProbe.basePath };
  }

  return {
    kind: 'ok',
    kibana: kibanaProbe.kind === 'healthy',
    elasticsearch,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe embedding inside a single-quoted bash string.
 * Replaces every `'` with `'\''`.
 */
export function escapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Service command mapping
// ---------------------------------------------------------------------------

/**
 * Returns the yarn commands needed to start Elasticsearch and Kibana for the
 * given local target type.
 */
export function getServiceCommands(
  target: 'local-stateful' | 'local-serverless',
  kibanaDir: string,
): { es: ServiceCommand; kibana: ServiceCommand } {
  if (target === 'local-stateful') {
    return {
      es: {
        name: 'Elasticsearch',
        command: 'yarn es snapshot --license trial',
        kibanaDir,
      },
      kibana: {
        name: 'Kibana',
        // --no-base-path disables Kibana's random basePath so that all
        // POST /api/... calls reach Kibana without a path prefix rewrite.
        command: 'yarn start --no-base-path',
        kibanaDir,
      },
    };
  }
  return {
    es: {
      name: 'Elasticsearch',
      command: 'yarn es serverless --projectType=security',
      kibanaDir,
    },
    kibana: {
      name: 'Kibana',
      // Serverless Kibana does not use a random basePath; no flag needed.
      command: 'yarn serverless-security',
      kibanaDir,
    },
  };
}

// ---------------------------------------------------------------------------
// Startup script
// ---------------------------------------------------------------------------

/**
 * Builds the contents of a self-contained startup bash script for the given
 * service. Sources nvm when present, runs `nvm use`, then executes the
 * command. Keeps the window open after the process exits so errors are visible.
 */
function buildStartupScriptContent(cmd: ServiceCommand): string {
  const escapedDir = escapeSingleQuoted(cmd.kibanaDir);
  return [
    '#!/usr/bin/env bash',
    '# Auto-generated by security-env-setup. Safe to delete.',
    `cd '${escapedDir}' || { echo "Could not cd to kibanaDir"; exec bash; }`,
    'if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then',
    '  # shellcheck disable=SC1091',
    '  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"',
    '  nvm use 2>/dev/null || echo "[security-env-setup] nvm use failed; continuing with current Node"',
    'else',
    '  echo "[security-env-setup] nvm not found; using Node on PATH"',
    'fi',
    'echo ""',
    `echo "=== ${cmd.name} \u2014 starting ==="`,
    'echo "=== Close this window to stop the service. ==="',
    'echo ""',
    cmd.command,
    '# Keep the window open if the command exits (so the user can see errors)',
    'echo ""',
    'echo "=== Service exited. Press any key to close this window. ==="',
    'read -n 1',
    '',
  ].join('\n');
}

/**
 * Writes a self-contained startup script to /tmp. The script sources nvm if
 * present, runs `nvm use` (from kibanaDir's .nvmrc), then executes the command.
 * Returns the absolute path to the written script.
 */
export async function writeStartupScript(cmd: ServiceCommand): Promise<string> {
  const slug = cmd.name === 'Elasticsearch' ? 'es' : 'kibana';
  const scriptPath = `/tmp/security-env-setup-${slug}-${process.pid}.sh`;
  await writeFile(scriptPath, buildStartupScriptContent(cmd), { mode: 0o755 });
  return scriptPath;
}

// ---------------------------------------------------------------------------
// osascript launcher
// ---------------------------------------------------------------------------

/**
 * Launches the given startup script in a new Terminal.app window via
 * osascript. Returns true on success, false if osascript fails or we are not
 * on macOS.
 */
export async function openInNewTerminalTab(scriptPath: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false;
  }

  // Escape the script path for embedding in an AppleScript double-quoted string.
  const escaped = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const appleScript = [
    'tell application "Terminal"',
    '  activate',
    `  do script "bash '${escaped}'"`,
    'end tell',
  ].join('\n');

  return new Promise<boolean>((resolve) => {
    const child = spawn('osascript', ['-e', appleScript], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    child.on('error', () => {
      resolve(false);
    });

    child.on('close', (code: number | null) => {
      resolve(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

/**
 * Polls `pingFn` every `intervalMs` milliseconds (default 5 s) until it
 * returns `true`, updating an ora spinner with elapsed time. Throws if
 * `timeoutMs` elapses without the service becoming healthy.
 */
export async function waitUntilHealthy(opts: WaitUntilHealthyOptions): Promise<void> {
  const { pingFn, name, timeoutMs, intervalMs = 5_000 } = opts;
  const start = Date.now();
  const spinner = ora(`Waiting for ${name} to be healthy... (0s)`).start();

  for (;;) {
    const healthy = await pingFn();
    if (healthy) {
      spinner.succeed(`${name} is healthy.`);
      return;
    }

    const elapsedMs = Date.now() - start;
    const elapsed = Math.floor(elapsedMs / 1000);

    if (elapsedMs >= timeoutMs) {
      const timeoutSec = timeoutMs / 1000;
      spinner.fail(`${name} did not become healthy within ${timeoutSec}s.`);
      throw new Error(
        `${name} did not become healthy within ${timeoutSec}s. ` +
          `Check the ${name} terminal window for errors.`,
      );
    }

    const suffix = elapsed >= 30 ? ' \u2014 first boot can take a few minutes' : '';
    spinner.text = `Waiting for ${name} to be healthy... (${elapsed}s)${suffix}`;

    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Error builder
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable error message when Kibana is detected running
 * with a random basePath. Includes the basePath, the Kibana URL, and the
 * remediation command.
 */
function buildBasePathError(
  kibanaUrl: string,
  basePath: string,
  kibanaDir: string,
): string {
  return (
    `Kibana is running with a random basePath ("${basePath}") at ${kibanaUrl}.\n` +
    `POST requests to /api/... will 404 because Kibana rewrites them to ` +
    `${basePath}/api/...\n` +
    `Stop Kibana, then restart it with:\n` +
    `  yarn start --no-base-path\n` +
    `(kibanaDir: ${kibanaDir})`
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Ensures Kibana and Elasticsearch are running. If either is down it attempts
 * to auto-start via osascript (macOS only), falling back to an assisted
 * manual-start flow with health polling. Never returns until both services
 * are healthy (or until a timeout throws).
 *
 * Throws immediately if Kibana is reachable but running with a random
 * basePath (which would break all subsequent API calls).
 */
export async function ensureServicesRunning(
  target: 'local-stateful' | 'local-serverless',
  kibanaDir: string,
  kibanaUrl: string,
  elasticsearchUrl: string,
  credentials: ElasticCredentials,
): Promise<AutoStartResult> {
  // 1. Quick check — both already running (or fast-fail on basePath)
  const initial = await detectServices(kibanaUrl, elasticsearchUrl, credentials);
  if (initial.kind === 'kibana-basepath') {
    throw new Error(buildBasePathError(kibanaUrl, initial.basePath, kibanaDir));
  }
  if (initial.kibana && initial.elasticsearch) {
    return { method: 'already-running', kibana: true, elasticsearch: true };
  }

  const { es, kibana } = getServiceCommands(target, kibanaDir);
  const needEs = !initial.elasticsearch;
  const needKibana = !initial.kibana;

  const pingEs = async (): Promise<boolean> => {
    const s = await detectServices(kibanaUrl, elasticsearchUrl, credentials);
    return s.kind === 'ok' && s.elasticsearch;
  };
  const pingKibana = async (): Promise<boolean> => {
    const s = await detectServices(kibanaUrl, elasticsearchUrl, credentials);
    return s.kind === 'ok' && s.kibana;
  };

  // 2. Try to write startup scripts then launch via osascript
  let esScriptPath: string | undefined;
  let kibanaScriptPath: string | undefined;
  let scriptsWritten = false;

  try {
    if (needEs) {
      esScriptPath = await writeStartupScript(es);
    }
    if (needKibana) {
      kibanaScriptPath = await writeStartupScript(kibana);
    }
    scriptsWritten = true;
  } catch {
    // /tmp write failed — fall through to assisted mode
  }

  if (scriptsWritten) {
    // ES is launched before Kibana; first needed script follows that order.
    const firstScriptPath = esScriptPath ?? kibanaScriptPath;
    if (firstScriptPath !== undefined) {
      const firstOk = await openInNewTerminalTab(firstScriptPath);

      if (firstOk) {
        // Wait for ES to be healthy before starting Kibana
        if (needEs) {
          await waitUntilHealthy({
            pingFn: pingEs,
            name: 'Elasticsearch',
            timeoutMs: ES_HEALTH_TIMEOUT_MS,
          });
        }

        // Launch Kibana (if needed) only after ES is healthy
        if (needKibana && kibanaScriptPath !== undefined) {
          await openInNewTerminalTab(kibanaScriptPath);
          await waitUntilHealthy({
            pingFn: pingKibana,
            name: 'Kibana',
            timeoutMs: KIBANA_HEALTH_TIMEOUT_MS,
          });
        }

        return { method: 'osascript', kibana: true, elasticsearch: true };
      }
    }
  }

  // 3. Assisted fallback — print manual instructions, prompt, then poll
  const lines: string[] = [
    '',
    'Auto-start unavailable. Please run these commands in two terminals:',
  ];
  const quotedKibanaDir = `'${escapeSingleQuoted(kibanaDir)}'`;

  if (needEs) {
    lines.push('', 'Terminal 1 (Elasticsearch):');
    lines.push(`  cd ${quotedKibanaDir}`);
    lines.push(`  ${es.command}`);
  }

  if (needKibana) {
    const termNum = needEs ? 2 : 1;
    const suffix = needEs ? ' \u2014 start after ES is ready' : '';
    lines.push('', `Terminal ${termNum} (Kibana${suffix}):`);
    lines.push(`  cd ${quotedKibanaDir}`);
    lines.push(`  ${kibana.command}`);
  }

  lines.push('');
  for (const line of lines) {
    logger.print(line);
  }

  await inquirer.prompt([
    {
      type: 'input',
      name: 'proceed',
      message: 'Press Enter when both are running',
    },
  ]);

  if (needEs) {
    await waitUntilHealthy({
      pingFn: pingEs,
      name: 'Elasticsearch',
      timeoutMs: ES_HEALTH_TIMEOUT_MS,
    });
  }
  if (needKibana) {
    await waitUntilHealthy({
      pingFn: pingKibana,
      name: 'Kibana',
      timeoutMs: KIBANA_HEALTH_TIMEOUT_MS,
    });
  }

  return { method: 'assisted', kibana: true, elasticsearch: true };
}
