import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: './tsconfig.test.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  coveragePathIgnorePatterns: ['src/index.ts'],
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
