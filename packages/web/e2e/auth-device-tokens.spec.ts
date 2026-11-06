// Web E2E (real server + compose PostgreSQL, admin-approval mode): sign-up → approval pending →
// admin approves on the admin page → login → sign-out → device approval of a code the "app" requested
// over HTTP (login redirect and back) → the app's token poll gets a session token → personal token is
// shown once, works, and is revocable. Plus: denying a device code.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from './env.mjs';

const PASSWORD = 'correct-horse-battery';
const USER = { name: '윤사용', email: 'yoon.user@example.com' };
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function signUp(page: Page, name: string, email: string) {
  await page.goto('/signup');
  await page.getByLabel('이름').fill(name);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '가입' }).click();
}

async function logIn(page: Page, email: string) {
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
}

/** What the local app does: request a device code (no browser session). */
async function requestDeviceCode(request: APIRequestContext) {
  const r = await request.post('/api/auth/device/code', { data: { client_id: 'euta-app' } });
  expect(r.status()).toBe(200);
  return (await r.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; interval: number };
}

const pollToken = (request: APIRequestContext, deviceCode: string) =>
  request.post('/api/auth/device/token', { data: { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: 'euta-app' } });

test('sign-up → pending → admin approval → login → device approval → personal token once + revoke', async ({ page, browser, request }) => {
  // 1. A new member signs up and waits for approval; logging in sends them back to the pending page.
  await signUp(page, USER.name, USER.email);
  await expect(page).toHaveURL(/\/pending$/);
  await expect(page.getByRole('heading', { name: '승인 대기 중' })).toBeVisible();
  await page.goto('/login');
  await logIn(page, USER.email);
  await expect(page).toHaveURL(/\/pending$/);

  // 2. The administrator (ADMIN_EMAILS — active at sign-up) approves on the admin page.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signUp(admin, '관리자', E2E.adminEmail);
  await expect(admin).toHaveURL(/\/login\?notice=signed-up/);
  await expect(admin.getByText('가입했습니다. 로그인하세요.')).toBeVisible();
  await logIn(admin, E2E.adminEmail);
  await expect(admin.getByTestId('me')).toHaveText('관리자');
  await admin.locator('header').getByRole('link', { name: '관리자' }).click();
  await expect(admin).toHaveURL(/\/admin$/);
  const row = admin.getByTestId('pending-row').filter({ hasText: USER.email });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '승인' }).click();
  await expect(admin.getByTestId('pending-row')).toHaveCount(0);
  await expect(admin.getByRole('heading', { name: '승인 대기 (0)' })).toBeVisible();
  await adminCtx.close();

  // 3. Now the member can log in, and sign out again.
  await page.goto('/login');
  await logIn(page, USER.email);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('me')).toHaveText(USER.name);
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // 4. The local app requests a code and opens verification_uri_complete in the browser: not signed in →
  //    login → back on /device with the same code → approve.
  const code = await requestDeviceCode(request);
  expect(code.verification_uri).toBe(`${E2E.baseUrl}/device`);
  expect(code.verification_uri_complete).toBe(`${E2E.baseUrl}/device?user_code=${code.user_code}`);
  expect((await (await pollToken(request, code.device_code)).json()).error).toBe('authorization_pending');
  await page.goto(code.verification_uri_complete);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByText('로컬 앱 로그인을 승인하려면 먼저 로그인하세요.')).toBeVisible();
  await logIn(page, USER.email);
  await expect(page).toHaveURL(new RegExp(`/device\\?user_code=${code.user_code}$`));
  await expect(page.getByTestId('user-code')).toHaveText(`${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`);
  await page.getByRole('button', { name: '승인' }).click();
  await expect(page.getByRole('status')).toContainText('승인했습니다');

  // 5. The app's next poll (after the 5 s interval) gets a session token usable as Bearer.
  let accessToken = '';
  await expect
    .poll(
      async () => {
        const body = await (await pollToken(request, code.device_code)).json();
        accessToken = body.access_token ?? '';
        return accessToken ? 'ok' : body.error;
      },
      { timeout: 30_000, intervals: [code.interval * 1000 + 500] },
    )
    .toBe('ok');
  const meByDevice = await request.get('/api/me', { headers: { authorization: `Bearer ${accessToken}` } });
  expect(meByDevice.status()).toBe(200);
  expect(await meByDevice.json()).toMatchObject({ email: USER.email, auth: 'session' });

  // 6. Personal token: issued once (raw value only right after issuing), works, revocable.
  await page.locator('header').getByRole('link', { name: '토큰' }).click();
  await expect(page).toHaveURL(/\/settings\/tokens$/);
  await expect(page.getByText('발급한 토큰이 없습니다.')).toBeVisible();
  await page.getByLabel('이름').fill('my-claude');
  await page.getByLabel('권한').selectOption('read_write');
  await page.getByLabel('만료').selectOption('30');
  await page.getByRole('button', { name: '발급' }).click();
  const issued = page.getByTestId('issued-token');
  await expect(issued).toBeVisible();
  const raw = (await issued.locator('code').textContent())!.trim();
  expect(raw).toMatch(/^euta_[A-Za-z0-9_-]{20,}$/);
  const tokenRow = page.getByTestId('token-row').filter({ hasText: 'my-claude' });
  await expect(tokenRow).toContainText('읽기·쓰기');
  await expect(tokenRow).toContainText(`${raw.slice(0, 9)}…`);
  const viaToken = await request.get('/api/me', { headers: { authorization: `Bearer ${raw}` } });
  expect(viaToken.status()).toBe(200);
  expect(await viaToken.json()).toMatchObject({ email: USER.email, auth: 'token', tokenPermission: 'read_write' });
  // Shown once: gone after leaving the page (the server keeps only a hash).
  await page.reload();
  await expect(page.getByTestId('token-row')).toHaveCount(1);
  await expect(page.getByTestId('issued-token')).toHaveCount(0);
  expect(await page.content()).not.toContain(raw);
  page.once('dialog', (d) => void d.accept());
  await tokenRow.getByRole('button', { name: '폐기' }).click();
  await expect(page.getByTestId('token-row')).toHaveCount(0);
  expect((await request.get('/api/me', { headers: { authorization: `Bearer ${raw}` } })).status()).toBe(401);
});

test('denying a device code: the app gets access_denied', async ({ page, request }) => {
  await page.goto('/login');
  await logIn(page, USER.email);
  await expect(page.getByTestId('me')).toHaveText(USER.name);
  const code = await requestDeviceCode(request);
  await page.goto(`/device?user_code=${code.user_code}`);
  await page.getByRole('button', { name: '거부' }).click();
  await expect(page.getByRole('status')).toContainText('거부했습니다');
  // The same code cannot be approved afterwards.
  await page.reload();
  await expect(page.getByText('이미 처리된 코드입니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '승인' })).toHaveCount(0);
  await expect
    .poll(async () => (await (await pollToken(request, code.device_code)).json()).error, { timeout: 30_000, intervals: [code.interval * 1000 + 500] })
    .toBe('access_denied');
});
