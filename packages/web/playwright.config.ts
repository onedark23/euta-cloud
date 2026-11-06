// Web E2E against the real server + compose PostgreSQL (see e2e/server.mjs). `pnpm test:e2e` at the root.
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/env.mjs';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: E2E.baseUrl, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  outputDir: 'e2e-results',
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${E2E.baseUrl}/healthz`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
