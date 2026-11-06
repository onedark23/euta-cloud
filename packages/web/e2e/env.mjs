// Shared by the E2E server launcher and playwright.config.ts. BASE_URL must equal the URL the browser
// opens exactly (Better Auth trusted origin, device verification_uri).
const port = Number(process.env.E2E_PORT ?? 58180);
export const E2E = {
  port,
  internalPort: port + 1,
  baseUrl: `http://127.0.0.1:${port}`,
  adminEmail: 'admin@example.com',
  /** Second administrator for specs that must not depend on another spec's sign-ups. */
  admin2Email: 'admin2@example.com',
  /** Engine fixture site (login → dashboard) the runner drives — a private address (ALLOW_PRIVATE_TARGETS). */
  fixturePort: port + 2,
  fixtureUrl: `http://127.0.0.1:${port + 2}`,
  runnerLocation: 'e2e-lab',
};
