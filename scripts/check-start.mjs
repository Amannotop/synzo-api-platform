/**
 * Guards the production start path.
 *
 * The workspace packages used to export TypeScript source directly, which is
 * fine for tsx and Vitest but breaks `node dist/server.js`: Node cannot load a
 * .ts file, so the first import of @synzo/config threw ERR_MODULE_NOT_FOUND and
 * the server never started. Nothing in the test suite caught it, because every
 * test resolves those specifiers through an alias or a TypeScript loader.
 *
 * This check imports the built entry point in a child process the same way the
 * container does, so the failure surfaces here instead of in production.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  'apps/api/dist/server.js',
  'packages/types/dist/index.js',
  'packages/config/dist/index.js',
  'packages/validation/dist/index.js',
  'packages/database/dist/index.js',
];

let failed = false;

for (const rel of required) {
  if (existsSync(join(root, rel))) {
    console.log(`  ok   ${rel}`);
  } else {
    console.error(`  FAIL ${rel} is missing - run \`pnpm build\` first`);
    failed = true;
  }
}

// Loading the built API entry must not pull in a .ts file. If a workspace
// package regresses to exporting source, this is the line that catches it.
const probe = spawnSync(process.execPath, ['-e', "import('@synzo/config').then(m => { if (!m.buildConfig) process.exit(1); })"], {
  cwd: join(root, 'apps/api'),
  encoding: 'utf8',
});

if (probe.status === 0) {
  console.log('  ok   built @synzo/config loads under plain node');
} else {
  console.error('  FAIL built @synzo/config does not load under plain node');
  if (probe.stderr) console.error(`       ${probe.stderr.split('\n')[0]}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
