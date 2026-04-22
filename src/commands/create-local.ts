import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import type { ElasticCredentials, LocalWizardAnswers } from '../types';
import {
  createSpace,
  initializeSecurityApp,
  installPrebuiltRules,
  installSampleData,
} from '../api/kibana';
import { ensureServicesRunning } from '../runners/local-services';
import type { AutoStartResult } from '../runners/local-services';
import {
  ensureNode24Installed,
  ensureRepoCloned,
  writeConfig,
  installDependencies,
  runStandardSequence,
} from '../runners/docs-generator';
import { runKibanaLocalGenerator, runGenerateEvents } from '../runners/scripts';
import { VOLUME_PRESETS } from '../config/volume-presets';
import logger from '../utils/logger';
import { getErrorMessage } from '../utils/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 11;
const SAMPLE_DATASETS: ReadonlyArray<'flights' | 'ecommerce' | 'logs'> = [
  'flights',
  'ecommerce',
  'logs',
];

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printLocalSummary(
  answers: LocalWizardAnswers,
  startMethod: AutoStartResult['method'],
  rulesInstalled: number,
): void {
  const {
    target,
    kibanaUrl,
    elasticsearchUrl,
    space,
    volume,
    docsGeneratorDir,
    installSampleData: sampleDataFlag,
    generateAlertsAndCases,
    generateEvents,
    generateExtended,
  } = answers;

  const line = chalk.cyan('─'.repeat(60));
  const header = chalk.bold.cyan('  Local Environment Ready');
  const label = (l: string): string => chalk.bold.white(l.padEnd(18));
  const value = (v: string): string => chalk.green(v);

  const spaceBase =
    space === 'default' ? kibanaUrl : `${kibanaUrl}/s/${space}`;

  logger.print('');
  logger.print(line);
  logger.print(header);
  logger.print(line);
  logger.print(`  ${label('Target')}${value(target)}`);
  logger.print(`  ${label('Services')}${value(startMethod)}`);
  logger.print(`  ${label('Kibana')}${value(kibanaUrl)}`);
  logger.print(`  ${label('Elasticsearch')}${value(elasticsearchUrl)}`);
  logger.print(`  ${label('Space')}${value(space)}`);
  logger.print(`  ${label('Volume')}${value(volume)}`);
  logger.print(`  ${label('Sample data')}${value(sampleDataFlag ? 'installed' : 'skipped')}`);
  logger.print(
    `  ${label('Rules')}${value(`${String(rulesInstalled)} installed (enable from Rules UI)`)}`,
  );
  logger.print(
    `  ${label('Alerts + Cases')}${generateAlertsAndCases ? value('generated') : chalk.dim('skipped')}`,
  );
  logger.print(
    `  ${label('Events')}${generateEvents ? value('generated') : chalk.dim('skipped')}`,
  );
  logger.print(
    `  ${label('Extended data')}${generateExtended ? value('generated') : chalk.dim('skipped')}`,
  );
  logger.print(`  ${label('docs-generator')}${value(docsGeneratorDir)}`);
  logger.print('');
  logger.print(`  ${chalk.bold.white('Verify at:')}`);
  logger.print(`  ${chalk.cyan(`${spaceBase}/app/security`)}`);
  logger.print(`  ${chalk.cyan(`${spaceBase}/app/security/alerts`)}`);
  logger.print(`  ${chalk.cyan(`${spaceBase}/app/security/rules`)}`);
  logger.print(`  ${chalk.cyan(`${spaceBase}/app/security/entity_analytics`)}`);
  logger.print(line);
  logger.print('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full local-target setup flow.
 *
 * Fatal errors (bootstrap missing, services down, clone fails) propagate to
 * the caller. Non-fatal errors (individual generator failures) are swallowed
 * as warnings so the sequence always reaches the summary step.
 */
export async function runLocalFlow(answers: LocalWizardAnswers): Promise<void> {
  const credentials: ElasticCredentials = {
    url: answers.elasticsearchUrl,
    username: answers.username,
    password: answers.password,
  };
  const spaceArg = answers.space === 'default' ? undefined : answers.space;

  // ── Step 1/11: Node 24 preflight ──────────────────────────────────────────
  logger.step(1, TOTAL_STEPS, 'Checking Node 24 via nvm…');
  try {
    await ensureNode24Installed();
  } catch (err) {
    logger.error(getErrorMessage(err));
    return;
  }

  // ── Step 2/11: Bootstrap check ────────────────────────────────────────────
  logger.step(2, TOTAL_STEPS, 'Checking Kibana bootstrap…');
  const markerPath = path.join(
    answers.kibanaDir,
    'node_modules',
    '@kbn',
    'test-es-server',
  );
  if (!fs.existsSync(markerPath)) {
    throw new Error(
      `Kibana bootstrap not found. Run 'yarn kbn bootstrap' in ` +
        `${answers.kibanaDir} first, then re-run this command.`,
    );
  }

  // ── Step 3/11: Ensure services running ───────────────────────────────────
  logger.step(3, TOTAL_STEPS, 'Ensuring Kibana and Elasticsearch are running…');
  const autoStart = await ensureServicesRunning(
    answers.target,
    answers.kibanaDir,
    answers.kibanaUrl,
    answers.elasticsearchUrl,
    credentials,
  );
  if (autoStart.method === 'already-running') {
    logger.info('Services already running.');
  } else if (autoStart.method === 'osascript') {
    logger.info('Started services in new Terminal tabs.');
  } else {
    logger.info('Services started (assisted).');
  }

  // ── Step 4/11: Sample data ────────────────────────────────────────────────
  logger.step(4, TOTAL_STEPS, 'Installing Kibana sample data…');
  if (answers.installSampleData) {
    for (const dataset of SAMPLE_DATASETS) {
      try {
        await installSampleData(
          answers.kibanaUrl,
          credentials,
          dataset,
          spaceArg,
        );
        logger.info(`Sample dataset "${dataset}" installed.`);
      } catch (err) {
        logger.warn(
          `Failed to install sample dataset "${dataset}": ${getErrorMessage(err)}`,
        );
      }
    }
  } else {
    logger.info('Sample data installation skipped.');
  }

  // ── Step 5/11: Space creation ─────────────────────────────────────────────
  logger.step(5, TOTAL_STEPS, 'Creating Kibana space…');
  if (answers.space !== 'default') {
    const { alreadyExisted } = await createSpace(
      answers.kibanaUrl,
      credentials,
      { id: answers.space, name: answers.space },
    );
    if (alreadyExisted) {
      logger.warn(`Space "${answers.space}" already exists — skipping creation.`);
    } else {
      logger.info(`Space "${answers.space}" created.`);
    }
  } else {
    logger.info('Using default space — no space creation needed.');
  }

  // ── Step 6/11: Detection Engine init ──────────────────────────────────────
  logger.step(6, TOTAL_STEPS, 'Initializing Security Solution detection engine…');
  await initializeSecurityApp(answers.kibanaUrl, credentials);

  // ── Step 7/11: Prebuilt rules ─────────────────────────────────────────────
  logger.step(7, TOTAL_STEPS, 'Installing prebuilt detection rules…');
  const installResult = await installPrebuiltRules(
    answers.kibanaUrl,
    credentials,
    spaceArg,
  );
  logger.info(
    `Installed ${String(installResult.summary.succeeded)}/${String(installResult.summary.total)} prebuilt rules ` +
      `(${String(installResult.packages.length)} Fleet packages synced).`,
  );
  logger.info(
    'Rules are installed but NOT enabled. Open Kibana → Security → Rules to enable the ones you need.',
  );

  // ── Step 8/11: Kibana internal generator ──────────────────────────────────
  logger.step(8, TOTAL_STEPS, 'Running Kibana internal data generator…');
  if (answers.generateAlertsAndCases) {
    const preset = VOLUME_PRESETS[answers.volume];
    try {
      await runKibanaLocalGenerator(answers.kibanaDir, answers.kibanaUrl, credentials, {
        spaceId: answers.space,
        events: preset.events,
        hosts: preset.hosts,
        users: preset.users,
      });
    } catch (err) {
      logger.warn(
        `Kibana internal generator failed (continuing): ${getErrorMessage(err)}`,
      );
    }
  } else {
    logger.info('Alerts + Cases generation skipped (not selected).');
  }

  // ── Step 9/11: Endpoint event generator (resolver trees) ─────────────────
  // Note: yarn test:generate does NOT support --spaceId; always writes to
  // the default space regardless of the configured space.
  logger.step(9, TOTAL_STEPS, 'Running Kibana endpoint event generator (resolver trees)…');
  if (answers.generateEvents) {
    try {
      await runGenerateEvents(answers.kibanaDir, answers.kibanaUrl, credentials);
    } catch (err) {
      logger.warn(
        `Endpoint event generator failed (continuing): ${getErrorMessage(err)}`,
      );
    }
  } else {
    logger.info('Events generation skipped (not selected).');
  }

  // ── Step 10/11: docs-generator ────────────────────────────────────────────
  logger.step(10, TOTAL_STEPS, 'Setting up security-documents-generator…');
  if (answers.generateExtended) {
    await ensureRepoCloned(answers.docsGeneratorDir);
    await writeConfig(answers.docsGeneratorDir, {
      elasticsearchUrl: answers.elasticsearchUrl,
      kibanaUrl: answers.kibanaUrl,
      mode: answers.target === 'local-serverless' ? 'serverless' : 'stateful',
      credentials,
    });
    await installDependencies(answers.docsGeneratorDir);
    await runStandardSequence(answers.docsGeneratorDir, {
      space: answers.space,
      volume: answers.volume,
    });
  } else {
    logger.info('Extended data (docs-generator) skipped (not selected).');
  }

  // ── Step 11/11: Summary ───────────────────────────────────────────────────
  logger.step(11, TOTAL_STEPS, 'Done!');
  printLocalSummary(answers, autoStart.method, installResult.summary.succeeded);
}
