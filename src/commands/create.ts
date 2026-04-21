import chalk from 'chalk';
import { Command } from 'commander';
import type { CleanAnswers, Environment } from '../types';
import { hasApiKey } from '../config/store';
import { createDeployment, waitForDeployment } from '../api/cloud';
import { createSpaces, initializeSecurityApp } from '../api/kibana';
import { runAllDataGeneration, runGenerateAttacks, runGenerateCases } from '../runners/scripts';
import { runWizard } from '../wizard/prompts';
import { runLocalFlow } from './create-local';
import { runCleanCore } from './clean';
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
  dataSpaces?: string[];
}): void {
  const { name, kibanaUrl, esUrl, username, password, spaceNames, environment, dataSpaces } = params;

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
  logger.print(`  ${label('Spaces')}${spaceNames.length > 0 ? value(spacesLine) : spacesLine}`);
  if (dataSpaces && dataSpaces.length > 0) {
    logger.print(`  ${label('Data spaces')}${value(dataSpaces.join(', '))}`);
  }
  logger.print(line);
  logger.print(chalk.dim('  Keep your password safe — it will not be shown again.'));
  logger.print('');
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

async function runCreate(options: {
  clean?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}): Promise<void> {
  registerSigintHandler();

  if (options.dryRun && !options.clean) {
    logger.warn('--dry-run is only meaningful with --clean; ignoring it for provisioning.');
  }

  // ── Step 1/5: Interactive wizard ──────────────────────────────────────────
  logger.step(1, TOTAL_STEPS, 'Running deployment wizard…');

  const result = await runWizard();

  if (result.target !== 'elastic-cloud') {
    if (options.clean && result.target === 'local-stateful') {
      const cleanAnswers: CleanAnswers = {
        target: 'local-stateful',
        kibanaUrl: result.kibanaUrl,
        elasticsearchUrl: result.elasticsearchUrl,
        username: result.username,
        password: result.password,
        space: result.space,
      };
      await runCleanCore(cleanAnswers, { dryRun: options.dryRun, yes: options.yes });
      if (options.dryRun) {
        logger.info('Dry run complete — create was not executed.');
        return;
      }
    } else if (options.clean) {
      logger.warn('--clean is not supported for local-serverless; skipping clean.');
    }
    await runLocalFlow(result);
    return;
  }

  const { config, environment } = result;
  const cleanFlagsUsed = [
    options.clean ? '--clean' : undefined,
    options.dryRun ? '--dry-run' : undefined,
    options.yes ? '--yes' : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  if (cleanFlagsUsed.length > 0) {
    logger.warn(
      `${cleanFlagsUsed.join(', ')} ${cleanFlagsUsed.length === 1 ? 'is' : 'are'} only supported with local-stateful target; ignoring for elastic-cloud provisioning.`,
    );
  }

  if (!hasApiKey(environment)) {
    logger.error(
      `No API key configured for environment "${environment}". Run: security-env-setup auth login`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Step 2/5: Create deployment ───────────────────────────────────────────
  logger.step(2, TOTAL_STEPS, `Creating deployment "${config.name}" on ${environment}…`);

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

  const { kibanaRepoPath, generateAlerts, generateCases, generateEvents } = config.dataTypes;

  if (kibanaRepoPath.length > 0) {
    // Run all scripts against the Kibana default space first.
    const dataResult = await runAllDataGeneration({
      kibanaRepoPath,
      kibanaUrl: deployment.kibanaUrl,
      credentials,
      generateAlerts,
      generateCases,
      generateEvents,
    });

    for (const errorMsg of dataResult.errors) {
      logger.warn(errorMsg);
    }

    // Run attacks and cases for each additional space (events always runs once only).
    for (const spaceId of config.additionalDataSpaces ?? []) {
      try {
        if (generateAlerts) {
          await runGenerateAttacks(kibanaRepoPath, deployment.kibanaUrl, credentials, spaceId);
        }
        if (generateCases) {
          await runGenerateCases(kibanaRepoPath, deployment.kibanaUrl, credentials, spaceId, 300);
        }
      } catch (err) {
        logger.warn(`Data generation for space "${spaceId}" failed: ${getErrorMessage(err)}`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const additionalDataSpaces = config.additionalDataSpaces ?? [];
  const ranPerSpaceDataGeneration = kibanaRepoPath.length > 0 && (generateAlerts || generateCases);
  const dataSpaces =
    ranPerSpaceDataGeneration && additionalDataSpaces.length > 0
      ? ['default', ...additionalDataSpaces]
      : [];

  printSummary({
    name: config.name,
    environment,
    kibanaUrl: deployment.kibanaUrl,
    esUrl: deployment.esUrl,
    username: credentials.username,
    password: credentials.password,
    spaceNames: createdSpaces.map((s) => s.name),
    dataSpaces,
  });
}

// ---------------------------------------------------------------------------
// Commander export
// ---------------------------------------------------------------------------

export const createCommand = new Command('create')
  .description('Start the interactive deployment creation wizard')
  .option('--clean', 'Clean up previously provisioned resources before creating')
  .option('--dry-run', 'Preview what clean would delete (requires --clean)')
  .option('--yes', 'Skip interactive confirmation for clean operations')
  .action((options: { clean?: boolean; dryRun?: boolean; yes?: boolean }): void => {
    runCreate(options).catch((err: unknown) => {
      logger.error(`Deployment failed: ${getErrorMessage(err)}`);
      process.exitCode = 1;
    });
  });
