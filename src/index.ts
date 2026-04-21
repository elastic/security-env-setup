#!/usr/bin/env node

import { Command } from 'commander';
import { authCommand } from './commands/auth';
import { cleanCommand } from './commands/clean';
import { createCommand } from './commands/create';

const program = new Command();

program
  .name('security-env-setup')
  .description('CLI tool for setting up Elastic security environments')
  .version('0.1.0');

program.addCommand(authCommand);
program.addCommand(cleanCommand);
program.addCommand(createCommand);

program.parse(process.argv);
