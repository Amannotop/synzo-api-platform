import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/**
 * Locating things that live in the repository, from a compiled file.
 *
 * `import.meta.url` points at the file doing the resolving, so the same code
 * works whether the app is running from `src` (tsx, tests) or from `dist`
 * (production). Both layouts sit at the same depth under the repo
 * (`apps/api/src/lib` and `apps/api/dist/lib`), so one constant covers both.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Resolves a configured path against the repository root when it is relative.
 *
 * Config values are authored by hand in .env and in launchd plists, where the
 * working directory is not guaranteed to be the repo. An absolute path is
 * honoured as-is so an operator can put the dashboard build anywhere.
 */
export function resolveFromRepo(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/** Fails fast, at startup, rather than serving blank pages at runtime. */
export function assertDirectoryWithIndex(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `${label} directory not found at ${path}. Run \`pnpm build\` before starting with this enabled.`,
    );
  }
  if (!existsSync(resolve(path, 'index.html'))) {
    throw new Error(
      `${label} is missing index.html at ${resolve(path, 'index.html')}. ` +
        'The build did not complete; run `pnpm build` before starting with this enabled.',
    );
  }
}
