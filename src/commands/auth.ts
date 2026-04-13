import { Command } from 'commander';

export const authCommand = new Command('auth')
  .description('Configure Elastic Cloud API credentials')
  .action((): void => {
    // TODO: implement credential configuration wizard
  });
