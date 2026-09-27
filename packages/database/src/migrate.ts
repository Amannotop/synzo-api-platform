/**
 * Migration runner. Applies every .sql file in ../../migrations exactly once,
 * in filename order, tracked in the `_migrations` table.
 *
 * Each migration runs inside a transaction so a failure leaves no partial state.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadEnv } from '@synzo/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file runs from src/ under tsx and from dist/ under node, so the SQL
// directory is one level up in both cases: <package>/migrations. Resolving
// from the module location rather than the process CWD keeps `pnpm migrate`
// working from anywhere.
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(connectionString: string): Promise<MigrationResult> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
    );

    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(statements);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      result.applied.push(file);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return result;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isDirectRun) {
  // Goes through the same loader as the API, so `pnpm migrate` picks up the
  // repository .env instead of demanding the variable be exported by hand.
  let url: string;
  try {
    url = loadEnv().DATABASE_URL;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  runMigrations(url)
    .then((r) => {
      console.log(`Migrations applied: ${r.applied.length}`);
      for (const a of r.applied) console.log(`  + ${a}`);
      if (r.skipped.length) console.log(`Already applied: ${r.skipped.length}`);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
