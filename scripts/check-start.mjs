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
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * The dashboard build is only required when the API is going to serve it.
 *
 * With SERVE_DASHBOARD=true the API serves the SPA from this build directory,
 * and a missing one is served as a blank page to every customer rather than as
 * a startup error — which is the failure mode this check exists to prevent. The
 * flag is read the same way the app reads it, so the check and the server
 * cannot disagree about whether serving is on.
 */
const envValue = (name) => {
  const file = join(root, '.env');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === name) {
      return trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
};

// process.env wins, matching dotenv's own precedence, so a launchd job that
// exports the variable is checked against what it will actually run with.
const serveDashboard =
  (process.env.SERVE_DASHBOARD ?? envValue('SERVE_DASHBOARD')) === 'true';

if (serveDashboard) {
  const indexHtml = join(root, 'apps/dashboard/dist/index.html');
  if (existsSync(indexHtml)) {
    console.log('  ok   apps/dashboard/dist/index.html (SERVE_DASHBOARD=true)');
  } else {
    console.error(
      '  FAIL apps/dashboard/dist/index.html is missing but SERVE_DASHBOARD=true\n' +
        '       The API would serve a blank page to every customer. Run `pnpm build` first.',
    );
    failed = true;
  }
} else {
  console.log('  skip dashboard build (SERVE_DASHBOARD is not enabled)');
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
