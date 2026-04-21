import chalk from 'chalk';
import { Command } from 'commander';
import * as inquirer from 'inquirer';
import ora from 'ora';
import {
  findCustomRules,
  bulkDeleteRules,
  findCasesByTag,
  bulkDeleteCases,
  listSpaces,
  deleteSpace,
} from '../api/kibana';
import { runCleanPrompts } from '../wizard/prompts';
import type {
  CleanAnswers,
  CleanOptions,
  CleanResult,
  ElasticCredentials,
} from '../types';
import logger from '../utils/logger';
import { getErrorMessage } from '../utils/errors';

// ---------------------------------------------------------------------------
// Zero result helper
// ---------------------------------------------------------------------------

function zeroResult(): CleanResult {
  return {
    rulesDeleted: 0,
    rulesSkipped: 0,
    casesDeleted: 0,
    casesSkipped: 0,
    spacesDeleted: 0,
    spacesSkipped: 0,
  };
}

// ---------------------------------------------------------------------------
// Summary box
// ---------------------------------------------------------------------------

function printCleanSummary(result: CleanResult): void {
  const line = chalk.cyan('─'.repeat(60));
  const header = chalk.bold.cyan('  Clean Summary');
  const label = (l: string): string => chalk.bold.white(l.padEnd(20));
  const val = (v: number): string => chalk.green(String(v));

  logger.print('');
  logger.print(line);
  logger.print(header);
  logger.print(line);
  logger.print(`  ${label('Rules deleted')}${val(result.rulesDeleted)}`);
  logger.print(`  ${label('Rules skipped')}${val(result.rulesSkipped)}`);
  logger.print(`  ${label('Cases deleted')}${val(result.casesDeleted)}`);
  logger.print(`  ${label('Cases skipped')}${val(result.casesSkipped)}`);
  logger.print(`  ${label('Spaces deleted')}${val(result.spacesDeleted)}`);
  logger.print(`  ${label('Spaces skipped')}${val(result.spacesSkipped)}`);
  logger.print(line);
  logger.print('');
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Runs the full clean flow with pre-collected answers.
 * Does NOT run the wizard — callers must supply answers themselves.
 *
 * Used both by the standalone `clean` subcommand (via `runClean`) and by
 * `create --clean` after the create wizard has already gathered answers.
 */
export async function runCleanCore(
  answers: CleanAnswers,
  options: CleanOptions,
): Promise<CleanResult> {
  // Defensive guard — the type excludes 'local-serverless' but guard at runtime.
  if ((answers.target as string) === 'local-serverless') {
    throw new Error('Cleaning serverless targets is not supported in this version.');
  }

  const credentials: ElasticCredentials = {
    url: answers.elasticsearchUrl,
    username: answers.username,
    password: answers.password,
  };

  const spaceId = answers.space === 'default' ? undefined : answers.space;

  // ── 1. Scan ──────────────────────────────────────────────────────────────
  const scanSpinner = ora('Scanning environment…').start();
  const [rulesResult, casesResult, spacesResult] = await Promise.allSettled([
    findCustomRules(answers.kibanaUrl, credentials, spaceId),
    findCasesByTag(answers.kibanaUrl, credentials, 'data-generator', spaceId),
    listSpaces(answers.kibanaUrl, credentials), // top-level — no space id
  ]);
  scanSpinner.stop();

  const allFailed =
    rulesResult.status === 'rejected' &&
    casesResult.status === 'rejected' &&
    spacesResult.status === 'rejected';

  let rules: Array<{ id: string; name: string }> = [];
  let cases: Array<{ id: string; title: string }> = [];
  let spaces: Array<{ id: string; name: string; color?: string }> = [];

  if (rulesResult.status === 'fulfilled') {
    rules = rulesResult.value;
  } else {
    logger.warn(`Could not fetch custom rules: ${getErrorMessage(rulesResult.reason)}`);
  }

  if (casesResult.status === 'fulfilled') {
    cases = casesResult.value;
  } else {
    logger.warn(`Could not fetch cases: ${getErrorMessage(casesResult.reason)}`);
  }

  if (spacesResult.status === 'fulfilled') {
    // Filter out the default space — it cannot be deleted.
    spaces = spacesResult.value.filter((s) => s.id !== 'default');
  } else {
    logger.warn(`Could not fetch spaces: ${getErrorMessage(spacesResult.reason)}`);
  }

  if (allFailed) {
    throw new Error(
      'Failed to scan environment. All three queries failed. See warnings above.',
    );
  }

  // ── 2. Print plan ────────────────────────────────────────────────────────
  logger.print(`\nClean plan for ${answers.kibanaUrl} (space: ${answers.space}):`);
  logger.print(`  \u2022 ${rules.length} custom detection rules`);
  logger.print(`  \u2022 ${cases.length} cases with tag "data-generator"`);
  logger.print(`  \u2022 ${spaces.length} non-default Kibana spaces`);

  // ── 3. Early exits ───────────────────────────────────────────────────────
  if (rules.length === 0 && cases.length === 0 && spaces.length === 0) {
    logger.print('\nNothing to clean. Environment is already empty.');
    return zeroResult();
  }

  if (options.dryRun) {
    logger.print('\nDry run — nothing will be deleted.');
    return zeroResult();
  }

  // ── 4. Interactive selection ─────────────────────────────────────────────
  let selectedRuleIds: string[] = [];
  let casesConfirmed = false;
  let selectedSpaceIds: string[] = [];

  if (rules.length > 0) {
    const rulesAnswer = await inquirer.prompt<{ selectedRules: string[] }>([
      {
        type: 'checkbox',
        name: 'selectedRules',
        message:
          'Select rules to delete (space to toggle, a = all, i = invert, enter to confirm):',
        choices: rules.map((r) => ({ name: r.name, value: r.id, checked: true })),
      },
    ]);
    selectedRuleIds = rulesAnswer.selectedRules;
  }

  if (cases.length > 0) {
    const casesAnswer = await inquirer.prompt<{ deleteCases: boolean }>([
      {
        type: 'confirm',
        name: 'deleteCases',
        message: `Delete all ${cases.length} cases tagged "data-generator"?`,
        default: true,
      },
    ]);
    casesConfirmed = casesAnswer.deleteCases;
  }

  if (spaces.length > 0) {
    const spacesAnswer = await inquirer.prompt<{ selectedSpaces: string[] }>([
      {
        type: 'checkbox',
        name: 'selectedSpaces',
        message: 'Select spaces to delete:',
        choices: spaces.map((s) => ({
          name: `${s.name} (${s.id})`,
          value: s.id,
          checked: false,
        })),
      },
    ]);
    selectedSpaceIds = spacesAnswer.selectedSpaces;
  }

  // Nothing selected at all?
  const totalSelected =
    selectedRuleIds.length +
    (casesConfirmed ? cases.length : 0) +
    selectedSpaceIds.length;

  if (totalSelected === 0) {
    logger.print('\nNothing selected to delete. Exiting.');
    return zeroResult();
  }

  // ── 5. Final confirmation ────────────────────────────────────────────────
  logger.print('\nAbout to delete:');
  logger.print(`  \u2022 ${selectedRuleIds.length} rules`);
  logger.print(`  \u2022 ${casesConfirmed ? cases.length : 0} cases`);
  logger.print(`  \u2022 ${selectedSpaceIds.length} spaces`);

  if (!options.yes) {
    const confirmAnswer = await inquirer.prompt<{ proceed: boolean }>([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Proceed?',
        default: false,
      },
    ]);
    if (!confirmAnswer.proceed) {
      logger.print('\nAborted by user.');
      return zeroResult();
    }
  }

  // ── 6. Execute deletions: rules → cases → spaces ─────────────────────────
  let rulesDeleted = 0;
  let rulesSkipped = 0;
  let casesDeleted = 0;
  let casesSkipped = 0;
  let spacesDeleted = 0;
  let spacesSkipped = 0;

  // Rules
  if (selectedRuleIds.length > 0) {
    const rulesSpinner = ora(`Deleting ${selectedRuleIds.length} rules…`).start();
    try {
      const r = await bulkDeleteRules(
        answers.kibanaUrl,
        credentials,
        selectedRuleIds,
        spaceId,
      );
      rulesDeleted = r.deleted;
      rulesSkipped = r.skipped;
      rulesSpinner.succeed(`Rules: deleted ${rulesDeleted}, skipped ${rulesSkipped}.`);
    } catch (err) {
      rulesSpinner.fail('Rules deletion failed.');
      logger.warn(`Rules deletion error: ${getErrorMessage(err)}`);
      rulesDeleted = 0;
      rulesSkipped = selectedRuleIds.length;
    }
  }

  // Cases
  if (casesConfirmed && cases.length > 0) {
    const caseIds = cases.map((c) => c.id);
    const casesSpinner = ora(`Deleting ${caseIds.length} cases…`).start();
    try {
      const r = await bulkDeleteCases(
        answers.kibanaUrl,
        credentials,
        caseIds,
        spaceId,
      );
      casesDeleted = r.deleted;
      casesSkipped = r.skipped;
      casesSpinner.succeed(`Cases: deleted ${casesDeleted}, skipped ${casesSkipped}.`);
    } catch (err) {
      casesSpinner.fail('Cases deletion failed.');
      logger.warn(`Cases deletion error: ${getErrorMessage(err)}`);
      casesDeleted = 0;
      casesSkipped = caseIds.length;
    }
  }

  // Spaces — one at a time
  for (const sid of selectedSpaceIds) {
    const spaceSpinner = ora(`Deleting space "${sid}"…`).start();
    try {
      await deleteSpace(answers.kibanaUrl, credentials, sid);
      spacesDeleted += 1;
      spaceSpinner.succeed(`Space "${sid}" deleted.`);
    } catch (err) {
      spaceSpinner.fail(`Failed to delete space "${sid}".`);
      logger.warn(`Space "${sid}" deletion error: ${getErrorMessage(err)}`);
      spacesSkipped += 1;
    }
  }

  // ── 7. Summary ───────────────────────────────────────────────────────────
  const result: CleanResult = {
    rulesDeleted,
    rulesSkipped,
    casesDeleted,
    casesSkipped,
    spacesDeleted,
    spacesSkipped,
  };
  printCleanSummary(result);

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the full interactive clean flow: mini-wizard → scan → select → delete.
 * Returns `CleanResult` for test observability; callers may ignore it.
 */
export async function runClean(options: CleanOptions): Promise<CleanResult> {
  const answers = await runCleanPrompts();
  return runCleanCore(answers, options);
}

// ---------------------------------------------------------------------------
// Commander export
// ---------------------------------------------------------------------------

export const cleanCommand = new Command('clean')
  .description('Remove resources created by this CLI (supports --dry-run)')
  .option('--dry-run', 'List what would be deleted without deleting')
  .option('--yes', 'Skip interactive confirmation (useful for CI)')
  .action((options: { dryRun?: boolean; yes?: boolean }): void => {
    runClean({ dryRun: options.dryRun, yes: options.yes }).catch((err: unknown) => {
      logger.error(`Clean failed: ${getErrorMessage(err)}`);
      process.exitCode = 1;
    });
  });
