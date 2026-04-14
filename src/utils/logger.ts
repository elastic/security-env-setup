import chalk from 'chalk';

const logger = {
  info: (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(chalk.blue(msg));
  },

  success: (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(chalk.green(msg));
  },

  warn: (msg: string): void => {
    // eslint-disable-next-line no-console
    console.warn(chalk.yellow(msg));
  },

  error: (msg: string): void => {
    // eslint-disable-next-line no-console
    console.error(chalk.red(msg));
  },

  step: (n: number, total: number, msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(chalk.cyan(`[${n}/${total}] ${msg}`));
  },

  /** Output a pre-formatted string without any additional colour transformation. */
  print: (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(msg);
  },
};

export default logger;
