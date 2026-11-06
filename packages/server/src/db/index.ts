import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query API as the db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createDb(databaseUrl: string): { pool: pg.Pool; db: Db } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { pool, db: drizzle({ client: pool, schema }) };
}

/** Apply pending migrations on a single dedicated connection (drizzle recommendation for DDL). */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end();
  }
}

export { schema };
