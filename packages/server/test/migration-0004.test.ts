// Migration 0004 (stage 15) on existing data: projects created before it get birth record `unknown`
// and visibility `org`; existing owner/editor members keep their roles; access_requests is empty.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/index.js';
import { ADMIN_URL, dbUrl } from './db-urls.js';

describe('migration 0004 on existing data', () => {
  const name = `euta_t_mig_${Date.now().toString(36)}`;
  const url = dbUrl(name);
  const tmp = mkdtempSync(join(tmpdir(), 'euta-mig-'));

  afterAll(async () => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`drop database if exists "${name}" with (force)`);
    await c.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('maps old projects to unknown/org and keeps member roles', async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    await admin.end();

    // Every migration before project_birth_access only.
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
    const journalPath = join(tmp, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const idx = journal.entries.findIndex((e) => e.tag.endsWith('_project_birth_access'));
    expect(idx).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, idx);
    writeFileSync(journalPath, JSON.stringify(journal));
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await migrate(drizzle({ client: c }), { migrationsFolder: tmp });
      await c.query(`insert into users (id, name, email) values ('u1', 'Old Owner', 'old@example.com'), ('u2', 'Old Editor', 'ed@example.com')`);
      await c.query(`insert into projects (id, name, browser, created_by) values ('p1', 'Legacy', '{"engine":"chromium"}', 'u1')`);
      await c.query(`insert into project_members (project_id, user_id, role) values ('p1', 'u1', 'owner'), ('p1', 'u2', 'editor')`);
    } finally {
      await c.end();
    }

    await runMigrations(url);

    const d = new pg.Client({ connectionString: url });
    await d.connect();
    try {
      const p = await d.query(`select origin, origin_local_id, visibility, created_by from projects where id = 'p1'`);
      expect(p.rows[0]).toEqual({ origin: 'unknown', origin_local_id: null, visibility: 'org', created_by: 'u1' });
      const m = await d.query(`select user_id, role from project_members where project_id = 'p1' order by user_id`);
      expect(m.rows).toEqual([
        { user_id: 'u1', role: 'owner' },
        { user_id: 'u2', role: 'editor' },
      ]);
      expect((await d.query(`select count(*)::int as n from access_requests`)).rows[0].n).toBe(0);
    } finally {
      await d.end();
    }
  });
});
