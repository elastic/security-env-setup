import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  moduleNameMapper: {
    '^@commands/(.*)$': '<rootDir>/src/commands/$1',
    '^@api/(.*)$': '<rootDir>/src/api/$1',
    '^@wizard/(.*)$': '<rootDir>/src/wizard/$1',
    '^@runners/(.*)$': '<rootDir>/src/runners/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@types-local/(.*)$': '<rootDir>/src/types/$1',
  },
};

export default config;
