// Builds a migrated template database once; each test file clones it (CREATE DATABASE … TEMPLATE).
// Needs the docker compose Postgres (`pnpm db:up`, done by `pnpm test`).
import pg from 'pg';
import { runMigrations } from '../src/db/index.js';
import { ADMIN_URL, TEMPLATE_DB, dbUrl } from './db-urls.js';

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`cannot reach the test database at ${ADMIN_URL} — run \`pnpm db:up\` first (${(e as Error).message})`);
  }
  // Drop leftovers of earlier aborted runs.
  const old = await admin.query<{ datname: string }>(`select datname from pg_database where datname like 'euta_t_%' or datname = $1`, [TEMPLATE_DB]);
  for (const r of old.rows) await admin.query(`drop database if exists "${r.datname}" with (force)`);
  await admin.query(`create database "${TEMPLATE_DB}"`);
  await admin.end();
  await runMigrations(dbUrl(TEMPLATE_DB));
}
