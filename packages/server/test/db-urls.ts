export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://euta:euta-dev-only@localhost:55432/euta';
export const TEMPLATE_DB = 'euta_test_template';
export function dbUrl(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}
export const MAILPIT_SMTP = process.env.TEST_SMTP_URL ?? 'smtp://localhost:51025';
export const MAILPIT_API = process.env.TEST_MAILPIT_API ?? 'http://localhost:58025';
