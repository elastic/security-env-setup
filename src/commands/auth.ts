import { Command } from 'commander';
import * as inquirer from 'inquirer';
import axios from 'axios';
import ora from 'ora';
import chalk from 'chalk';
import type { Environment } from '../types';
import { clearApiKey, setApiKey, getAllApiKeys } from '../config/store';
import { API_ENDPOINTS } from '../config/endpoints';
import { buildHeaders } from '../utils/http';
import { getErrorMessage } from '../utils/errors';
import logger from '../utils/logger';

const API_KEY_VALIDATION_TIMEOUT_MS = 10_000;

const ENVIRONMENTS: Environment[] = ['prod', 'qa', 'staging'];

interface EnvAnswer extends inquirer.Answers {
  environment: Environment;
}

interface ApiKeyAnswer extends inquirer.Answers {
  apiKey: string;
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
      filter: (input: string): string => input.trim(),
      validate: (input: string): boolean | string =>
        input.trim().length > 0 || 'API key cannot be empty.',
    },
  ]);

  const spinner = ora('Validating API key…').start();

  try {
    await axios.get<unknown>(`${API_ENDPOINTS[environment]}/api/v1/deployments`, {
      headers: buildHeaders(apiKey),
      timeout: API_KEY_VALIDATION_TIMEOUT_MS,
    });
  } catch (err) {
    spinner.fail('Authentication failed.');
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      throw new Error(
        status !== undefined
          ? `Server responded with HTTP ${status}`
          : `No response received: ${getErrorMessage(err)}`,
      );
    }
    throw new Error(getErrorMessage(err));
  }

  try {
    setApiKey(environment, apiKey);
    spinner.succeed(`Authenticated to ${environment} — credentials saved.`);
  } catch (err) {
    spinner.fail('Authentication succeeded, but saving credentials failed.');
    throw new Error(`Failed to save API key: ${getErrorMessage(err)}`);
  }
}

function status(): void {
  // Read config once; avoids N separate fs.readFileSync calls in the loop.
  const stored = getAllApiKeys();

  logger.print('');
  for (const env of ENVIRONMENTS) {
    const val = stored[env];
    const isConfigured = typeof val === 'string' && val.trim().length > 0;
    const label = chalk.bold(env.padEnd(10));
    const indicator = isConfigured
      ? chalk.green('✓ configured')
      : chalk.red('✗ not configured');
    logger.print(`  ${label} ${indicator}`);
  }
  logger.print('');
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

  // clearApiKey returns false when no key was stored — avoids a separate hasApiKey read.
  const removed = clearApiKey(environment);
  if (!removed) {
    logger.warn(`No API key configured for ${environment}.`);
    return;
  }

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
