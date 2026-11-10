// Web E2E server: the real built server (packages/server/dist/main.js — runs its migrations) on a fresh
// database in the docker compose PostgreSQL, serving the built web (packages/web/dist). Admin-approval
// sign-up mode (no SMTP_URL) like the PoC. Also starts the engine fixture site (tsx) and a real runner
// process (packages/runner/dist/main.js → engine CLI → Chromium) so cloud runs execute end to end;
// `ALLOW_PRIVATE_TARGETS=true` (dev/test only) lets runs target the fixture site on 127.0.0.1.
// A fake GitHub (in this process) backs the app release mirror (APP_MIRROR_GITHUB + APP_MIRROR_BASE_URL).
// Started by playwright.config.ts `webServer`; drops the database when stopped. Needs `pnpm db:up`,
// `pnpm -r build` (`pnpm test:e2e` does both) and a built ../euta-engine (CLI + core).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { E2E } from './env.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const serverMain = join(here, '../../server/dist/main.js');
const runnerMain = join(here, '../../runner/dist/main.js');
const webDist = join(here, '../dist');
const tsx = join(here, '../../../node_modules/.bin/tsx');
const fixtureStart = join(here, '../../../../euta-engine/packages/core/test/fixture-site/start.ts');
const engineCli = join(here, '../../../../euta-engine/packages/cli/dist/index.js');
const RUNNER_TOKEN = 'e2e-runner-token-0123456789abcdef';
for (const [what, p] of [['server build', serverMain], ['runner build', runnerMain], ['web build', join(webDist, 'index.html')], ['tsx', tsx], ['engine fixture site', fixtureStart], ['engine CLI build', engineCli]]) {
  if (!existsSync(p)) throw new Error(`${what} missing (${p}) — run \`pnpm -r build\` first`);
}

const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://euta:euta-dev-only@localhost:55432/euta';
const dbName = `euta_e2e_${process.pid}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;

async function admin(sql) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

// Leftovers of earlier aborted runs.
{
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const old = await c.query(`select datname from pg_database where datname like 'euta_e2e_%'`);
  for (const r of old.rows) await c.query(`drop database if exists "${r.datname}" with (force)`);
  await c.end();
}
await admin(`create database "${dbName}"`);

// Fake GitHub: `releases/latest` redirects to the tag page once armed (before that: no release), and
// `releases/download/<tag>/<name>` redirects to an object URL like github.com does.
const ghRelease = (() => {
  const v = E2E.mirrorVersion;
  const files = new Map();
  const add = (name) => {
    const b = Buffer.from(`fake ${name} `.repeat(2000));
    files.set(name, b);
    return b;
  };
  const yml = (name, list) => {
    const entries = list.map((f) => `  - url: ${f}\n    sha512: ${createHash('sha512').update(add(f)).digest('base64')}\n    size: ${files.get(f).length}`);
    for (const f of list) if (!f.endsWith('.dmg')) add(`${f}.blockmap`);
    files.set(name, Buffer.from(`version: ${v}\nfiles:\n${entries.join('\n')}\npath: ${list[0]}\nreleaseNotes: "- GitHub 에서 가져온 베타"\nreleaseDate: '2026-11-10T00:00:00.000Z'\n`));
  };
  yml('latest-mac.yml', [`euta-${v}-mac-arm64.zip`, `euta-${v}-mac-arm64.dmg`]);
  yml('latest.yml', [`euta-${v}-win-x64.exe`]);
  yml('latest-linux.yml', [`euta-${v}-linux-x64.AppImage`]);
  return { tag: `app-v${v}`, files };
})();
let ghArmed = false;
const github = createServer((req, res) => {
  const repo = `/${E2E.mirrorRepo}`;
  if (req.method === 'POST' && req.url === '/__e2e/arm') {
    ghArmed = true;
    return res.writeHead(204).end();
  }
  if (req.url === `${repo}/releases/latest`) {
    return res.writeHead(302, { location: `${E2E.githubUrl}${repo}/releases${ghArmed ? `/tag/${ghRelease.tag}` : ''}` }).end();
  }
  const dl = `${repo}/releases/download/${ghRelease.tag}/`;
  if (ghArmed && req.url?.startsWith(dl) && ghRelease.files.has(req.url.slice(dl.length))) {
    return res.writeHead(302, { location: `/_objects/${req.url.slice(dl.length)}` }).end();
  }
  const body = req.url?.startsWith('/_objects/') ? ghRelease.files.get(req.url.slice('/_objects/'.length)) : undefined;
  if (body) return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }).end(body);
  res.writeHead(404).end('Not Found');
});
await new Promise((r) => github.listen(E2E.githubPort, '127.0.0.1', r));

const env = { ...process.env };
delete env.SMTP_URL; // admin-approval mode
Object.assign(env, {
  DATABASE_URL: dbUrl.toString(),
  BASE_URL: E2E.baseUrl,
  HOST: '127.0.0.1',
  PORT: String(E2E.port),
  INTERNAL_PORT: String(E2E.internalPort),
  BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
  CREDENTIALS_KEY: Buffer.alloc(32, 9).toString('base64'),
  ADMIN_EMAILS: `${E2E.adminEmail},${E2E.admin2Email}`,
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  AUTH_RATE_LIMIT: 'false',
  WEB_DIST: webDist,
  RESULTS_DIR: mkdtempSync(join(tmpdir(), 'euta-e2e-results-')),
  UPDATES_DIR: mkdtempSync(join(tmpdir(), 'euta-e2e-updates-')),
  LOG_LEVEL: 'warn',
  RUNNER_TOKEN,
  RUNNER_HEARTBEAT_MS: '1000',
  ALLOW_PRIVATE_TARGETS: 'true',
  APP_MIRROR_GITHUB: E2E.mirrorRepo,
  APP_MIRROR_INTERVAL: '1h',
  APP_MIRROR_BASE_URL: E2E.githubUrl,
});

const fixture = spawn(tsx, [fixtureStart], { env: { ...process.env, PORT: String(E2E.fixturePort) }, stdio: ['ignore', 'ignore', 'inherit'] });
const child = spawn(process.execPath, [serverMain], { env, stdio: 'inherit' });
let runner = null;
let stopping = false;

/** SIGTERM, then SIGKILL after `ms` (a graceful runner waits for running runs). */
const kill = async (p, ms = 5000) => {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  const t = setTimeout(() => p.kill('SIGKILL'), ms);
  await exited;
  clearTimeout(t);
};
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  await kill(runner, 3000);
  await kill(child, 10_000);
  await kill(fixture, 3000);
  github.close();
  await admin(`drop database if exists "${dbName}" with (force)`).catch(() => {});
  process.exit(code);
};
child.on('exit', (code) => void stop(code ?? 1));
fixture.on('exit', (code) => void stop(code ?? 1));
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));

// The runner claims over the internal API once the server is up.
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${E2E.baseUrl}/healthz`)).ok) break;
  } catch {
    /* not yet */
  }
  if (i > 300 || stopping) throw new Error('server did not become healthy');
  await new Promise((r) => setTimeout(r, 200));
}
runner = spawn(process.execPath, [runnerMain], {
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    EUTA_SERVER_URL: `http://127.0.0.1:${E2E.internalPort}`,
    EUTA_RUNNER_TOKEN: RUNNER_TOKEN,
    EUTA_CLI: engineCli,
    RUNNER_ID: 'e2e-runner',
    RUNNER_LOCATION: E2E.runnerLocation,
    RUNNER_CONCURRENCY: '2',
    RUNNER_CLAIM_WAIT_MS: '2000',
    RUNNER_KILL_GRACE_MS: '3000',
    RUNNER_WORK_DIR: mkdtempSync(join(tmpdir(), 'euta-e2e-runner-')),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
runner.on('exit', (code, signal) => {
  if (!stopping) console.error(`runner exited unexpectedly (${code ?? signal})`);
});
