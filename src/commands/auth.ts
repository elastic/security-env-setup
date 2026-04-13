import { Command } from 'commander';
import * as inquirer from 'inquirer';
import axios from 'axios';
import ora from 'ora';
import chalk from 'chalk';
import type { Environment } from '../types';
import { clearApiKey, hasApiKey, setApiKey } from '../config/store';
import logger from '../utils/logger';

const ENDPOINTS: Record<Environment, string> = {
  prod: 'https://api.elastic-cloud.com',
  staging: 'https://api.staging.foundit.no',
  qa: 'https://api.qa.cld.elstc.co',
};

const ENVIRONMENTS: Environment[] = ['prod', 'qa', 'staging'];

interface EnvAnswer extends inquirer.Answers {
  environment: Environment;
}

interface ApiKeyAnswer extends inquirer.Answers {
  apiKey: string;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

async function login(): Promise<void> {
  const { environment } = await inquirer.prompt<EnvAnswer>([
    {
      type: 'list',
      name: 'environment',
      message: 'Select environment:',
      choices: ENVIRONMENTS,
    },
  ]);

  const { apiKey } = await inquirer.prompt<ApiKeyAnswer>([
    {
      type: 'password',
      name: 'apiKey',
      message: `Enter API key for ${environment}:`,
      mask: '*',
      filter: (input: string) => input.trim(),
      validate: (input: string) => input.trim().length > 0 || 'API key cannot be empty.',
    },
  ]);

  const spinner = ora('Validating API key…').start();

  try {
    await axios.get<unknown>(`${ENDPOINTS[environment]}/api/v1/deployments`, {
      headers: { Authorization: `ApiKey ${apiKey}` },
    });
    setApiKey(environment, apiKey);
    spinner.succeed(chalk.green(`Authenticated to ${environment} — credentials saved.`));
  } catch (err) {
    spinner.fail(chalk.red('Authentication failed.'));
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      logger.error(
        status !== undefined
          ? `Server responded with HTTP ${status}`
          : `No response received: ${getErrorMessage(err)}`,
      );
    } else {
      logger.error(getErrorMessage(err));
    }
    throw err instanceof Error ? err : new Error(getErrorMessage(err));
  }
}

function status(): void {
  // eslint-disable-next-line no-console
  console.log('');
  for (const env of ENVIRONMENTS) {
    const label = chalk.bold(env.padEnd(10));
    const indicator = hasApiKey(env) ? chalk.green('✓ configured') : chalk.red('✗ not configured');
    // eslint-disable-next-line no-console
    console.log(`  ${label} ${indicator}`);
  }
  // eslint-disable-next-line no-console
  console.log('');
}

async function logout(): Promise<void> {
  const { environment } = await inquirer.prompt<EnvAnswer>([
    {
      type: 'list',
      name: 'environment',
      message: 'Select environment to log out from:',
      choices: ENVIRONMENTS,
    },
  ]);

  if (!hasApiKey(environment)) {
    logger.warn(`No API key configured for ${environment}.`);
    return;
  }

  clearApiKey(environment);
  logger.success(`Cleared API key for ${environment}.`);
}

export const authCommand = new Command('auth').description(
  'Configure Elastic Cloud API credentials',
);

authCommand
  .command('login')
  .description('Interactively set and validate an API key for an environment')
  .action((): void => {
    login().catch((err: unknown): void => {
      logger.error(`Login failed: ${getErrorMessage(err)}`);
      process.exitCode = 1;
    });
  });

authCommand
  .command('status')
  .description('Show which environments have a configured API key')
  .action((): void => {
    status();
  });

authCommand
  .command('logout')
  .description('Remove the stored API key for an environment')
  .action((): void => {
    logout().catch((err: unknown): void => {
      logger.error(`Logout failed: ${getErrorMessage(err)}`);
      process.exitCode = 1;
    });
  });
