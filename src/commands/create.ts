import { execFileSync } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import { Command } from 'commander';
import type { Environment } from '../types';
import { getApiKey } from '../config/store';
import { createDeployment, waitForDeployment } from '../api/cloud';
import { createSpaces, initializeSecurityApp } from '../api/kibana';
import { runWizard } from '../wizard/prompts';
import logger from '../utils/logger';
import { getErrorMessage } from '../utils/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prints a formatted summary box after a successful deployment. */
function printSummary(params: {
  name: string;
  kibanaUrl: string;
  esUrl: string;
  username: string;
  password: string;
  spaceNames: string[];
  environment: Environment;
}): void {
  const { name, kibanaUrl, esUrl, username, password, spaceNames, environment } = params;

  const line = chalk.cyan('─'.repeat(60));
  const header = chalk.bold.cyan('  Deployment Ready');
  const label = (l: string): string => chalk.bold.white(l.padEnd(14));
  const value = (v: string): string => chalk.green(v);
  const warn = (v: string): string => chalk.yellow(v);

  const spacesLine =
    spaceNames.length > 0 ? spaceNames.join(', ') : chalk.dim('(none)');

  logger.print('');
  logger.print(line);
  logger.print(header);
  logger.print(line);
  logger.print(`  ${label('Name')}${value(name)}`);
  logger.print(`  ${label('Environment')}${value(environment)}`);
  logger.print(`  ${label('Kibana')}${value(kibanaUrl || '(pending)')}`);
  logger.print(`  ${label('Elasticsearch')}${value(esUrl || '(pending)')}`);
  logger.print(`  ${label('Username')}${value(username)}`);
  logger.print(`  ${label('Password')}${warn(password)}`);
  logger.print(`  ${label('Spaces')}${value(spacesLine)}`);
  logger.print(line);
  logger.print(chalk.dim('  Keep your password safe — it will not be shown again.'));
  logger.print('');
}

/**
 * Runs a data-generation script from the kibana repository.
 * Streams output directly to stdio so the user can see progress.
 * Errors are caught and logged as warnings — they must not abort the command.
 */
function runDataScript(
  kibanaRepoPath: string,
  scriptName: string,
  kibanaUrl: string,
  username: string,
  password: string,
): void {
  const scriptPath = path.join(
    kibanaRepoPath,
    'x-pack',
    'plugins',
    'security_solution',
    'scripts',
    scriptName,
  );

  try {
    execFileSync(
      'node',
      [scriptPath, '--kibana-url', kibanaUrl, '--username', username, '--password', password],
      { stdio: 'inherit' },
    );
  } catch (err) {
    logger.warn(`Data generation script "${scriptName}" failed: ${getErrorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// SIGINT handler
// ---------------------------------------------------------------------------

function registerSigintHandler(): void {
  process.on('SIGINT', () => {
    logger.print('');
    logger.warn('Interrupted — exiting. Resources already created in the cloud will remain.');
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// Command action
// ---------------------------------------------------------------------------

async function runCreate(): Promise<void> {
  registerSigintHandler();

  // ── Step 1/5: Interactive wizard ──────────────────────────────────────────
  logger.step(1, TOTAL_STEPS, 'Running deployment wizard…');

  const { config, environment } = await runWizard();

  if (getApiKey(environment) === undefined) {
    logger.error(
      `No API key configured for environment "${environment}". Run: security-env-setup auth login`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Step 2/5: Create deployment ───────────────────────────────────────────
  logger.info(`Creating deployment "${config.name}" on ${environment}…`);

  const initialResult = await createDeployment(config, environment);

  // ── Step 3/5: Wait for deployment ─────────────────────────────────────────
  logger.step(3, TOTAL_STEPS, 'Waiting for deployment to become healthy…');

  const deployment = await waitForDeployment(
    initialResult.id,
    environment,
    initialResult.credentials,
  );

  // ── Step 4/5: Create Kibana spaces ────────────────────────────────────────
  logger.step(4, TOTAL_STEPS, 'Creating Kibana spaces…');

  const credentials = deployment.credentials;
  const createdSpaces = await createSpaces(
    deployment.kibanaUrl,
    credentials,
    config.spaces,
  );

  // ── Step 5/5: Initialize Security + data generation ───────────────────────
  logger.step(5, TOTAL_STEPS, 'Initializing Security Solution…');

  await initializeSecurityApp(deployment.kibanaUrl, credentials);

  const { kibanaRepoPath, generateAlerts, generateCases, generateEvents } =
    config.dataTypes;

  if (kibanaRepoPath.length > 0) {
    if (generateAlerts) {
      logger.info('Generating alerts and attack discoveries…');
      runDataScript(
        kibanaRepoPath,
        'create_alerts.js',
        deployment.kibanaUrl,
        credentials.username,
        credentials.password,
      );
    }

    if (generateCases) {
      logger.info('Generating cases…');
      runDataScript(
        kibanaRepoPath,
        'create_cases.js',
        deployment.kibanaUrl,
        credentials.username,
        credentials.password,
      );
    }

    if (generateEvents) {
      logger.info('Generating events…');
      runDataScript(
        kibanaRepoPath,
        'create_events.js',
        deployment.kibanaUrl,
        credentials.username,
        credentials.password,
      );
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  printSummary({
    name: config.name,
    environment,
    kibanaUrl: deployment.kibanaUrl,
    esUrl: deployment.esUrl,
    username: credentials.username,
    password: credentials.password,
    spaceNames: createdSpaces.map((s) => s.name),
  });
}

// ---------------------------------------------------------------------------
// Commander export
// ---------------------------------------------------------------------------

export const createCommand = new Command('create')
  .description('Start the interactive deployment creation wizard')
  .action((): void => {
    runCreate().catch((err: unknown) => {
      logger.error(`Deployment failed: ${getErrorMessage(err)}`);
      process.exitCode = 1;
    });
  });
