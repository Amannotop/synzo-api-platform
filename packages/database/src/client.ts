import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  sql: ReturnType<typeof postgres>;
  close: () => Promise<void>;
}

export function createDatabase(
  connectionString: string,
  options: { max?: number; onError?: (err: unknown) => void } = {},
): DatabaseHandle {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    // Fail loudly on unexpected conditions rather than silently degrading.
    onnotice: () => {},
    ...(options.onError ? { onerror: options.onError } : {}),
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export { schema };
