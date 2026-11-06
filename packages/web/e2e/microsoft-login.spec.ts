// Web E2E — login screen with company Microsoft login on (SPEC 계정 "웹 화면", C10). The E2E server runs
// without Entra settings, so `/api/config` is answered here with `microsoftLogin: true` and the social
// sign-in start is stubbed; the Microsoft round trip itself is covered by the server tests (stubbed IdP).
import { expect, test, type Page } from '@playwright/test';

const AUTHORIZE = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?client_id=euta';

async function microsoftOn(page: Page) {
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { signUpMode: 'approval', allowedEmailDomains: ['example.com'], microsoftLogin: true } }),
  );
}

test('company login is the main way in; email login folded; sign-up closed', async ({ page }) => {
  await microsoftOn(page);
  let started: Record<string, unknown> | null = null;
  await page.route('**/api/auth/sign-in/social', async (route) => {
    started = route.request().postDataJSON();
    await route.fulfill({ json: { url: AUTHORIZE, redirect: false } });
  });
  await page.route('https://login.microsoftonline.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Microsoft</h1>' }));

  await page.goto('/login?next=%2Fdevice%3Fuser_code%3DABCD-EFGH');
  const ms = page.getByRole('button', { name: '회사 계정(Office 365)으로 로그인' });
  await expect(ms).toBeVisible();
  await expect(page.getByText('처음 오셨다면 회사 계정으로 로그인하면 바로 사용할 수 있습니다.')).toBeVisible();
  await expect(page.getByLabel('이메일')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '가입' })).toHaveCount(0);
  await page.screenshot({ path: 'e2e-results/ms-1-login.png' });

  // Existing email members unfold their form.
  const fold = page.getByRole('button', { name: '기존 이메일 회원 로그인' });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('이메일')).toBeVisible();
  await expect(page.getByLabel('비밀번호')).toBeVisible();
  await page.screenshot({ path: 'e2e-results/ms-2-email-unfolded.png' });

  // The company button goes to Microsoft and asks to come back to `next` (device approval here).
  await ms.click();
  await expect(page).toHaveURL(/login\.microsoftonline\.com/);
  expect(started).toMatchObject({
    provider: 'microsoft',
    callbackURL: '/device?user_code=ABCD-EFGH',
    errorCallbackURL: '/login?next=%2Fdevice%3Fuser_code%3DABCD-EFGH',
  });

  // The sign-up page is closed: it sends people to the login page.
  await page.goto('/signup');
  await expect(page).toHaveURL(/\/login$/);
});

test('says why Microsoft sent the person back', async ({ page }) => {
  await microsoftOn(page);
  const cases: [string, string][] = [
    ['ACCOUNT_DEACTIVATED', '비활성화된 계정입니다. 관리자에게 문의하세요.'],
    ['sign-up_is_limited_to_@example.com_addresses', '회사 계정으로만 로그인할 수 있습니다.'],
    ['unable_to_get_user_info', '회사 계정으로만 로그인할 수 있습니다.'],
    ['access_denied', 'Microsoft 로그인을 취소했습니다.'],
    ['state_mismatch', 'Microsoft 로그인에 실패했습니다. 다시 시도하세요.'],
  ];
  for (const [code, text] of cases) {
    await page.goto(`/login?error=${encodeURIComponent(code)}`);
    await expect(page.getByRole('alert')).toContainText(text);
    if (code === 'sign-up_is_limited_to_@example.com_addresses') await page.screenshot({ path: 'e2e-results/ms-3-not-company.png' });
  }
  await page.goto('/login?error=PENDING_APPROVAL');
  await expect(page).toHaveURL(/\/pending$/);
});
