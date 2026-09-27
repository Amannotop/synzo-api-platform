import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Two test projects with different needs (spec 52):
 *
 *  - `unit`        pure functions, no I/O. Fast, no services required.
 *  - `integration` boots the real Fastify app against the real PostgreSQL and
 *                  Valkey instances, with a LOCAL controllable HTTP server
 *                  standing in for the upstream provider. Provider mechanics
 *                  (timeouts, disconnects, malformed frames) must be
 *                  deterministic, so they are never tested against the live
 *                  OpenCode endpoint; scripts/smoke.sh covers the real one.
 *
 * Aliases mirror tsconfig.json so tests import the same specifiers the source
 * does, without a build step. They are declared on each project because
 * Vitest does not merge a root-level `resolve.alias` into inline projects.
 */
const alias = {
  '@synzo/types': resolve(process.cwd(), 'packages/types/src/index.ts'),
  '@synzo/validation': resolve(process.cwd(), 'packages/validation/src/index.ts'),
  '@synzo/config': resolve(process.cwd(), 'packages/config/src/index.ts'),
  '@synzo/database': resolve(process.cwd(), 'packages/database/src/index.ts'),
} as const;

export default defineConfig({
  test: {
    // The integration suite shares one database and one Redis, so files must
    // not interleave; serial execution keeps the shared state deterministic.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias: { ...alias } },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: { ...alias } },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', 'apps/api/src/server.ts'],
    },
  },
});
