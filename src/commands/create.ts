import { Command } from 'commander';

export const createCommand = new Command('create')
  .description('Start the deployment creation wizard')
  .action((): void => {
    // TODO: implement deployment creation wizard
  });
