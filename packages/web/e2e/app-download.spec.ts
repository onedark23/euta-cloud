// Web E2E for stage 17 "앱 내려받기" (SPEC_앱-배포-업데이트): releases uploaded with an admin read_write
// token through the real upload API → the download screen shows the visitor's OS first (Mac: both chips +
// hint, Windows, Linux), other platforms, release notes, the kept versions and first-install help; the
// admin publishes a draft there and the oldest version drops out (keep 3); a member sees no admin part.
// Screenshots go to e2e-results/download-*.png for the UI review.
import { expect, request as playwrightRequest, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E } from './env.mjs';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'correct-horse-battery';
const MEMBER = { name: '송사원', email: 'dl.member@example.com' };
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};
const NOTES: Record<string, string> = {
  '0.1.0-alpha.1': '첫 알파 배포',
  '0.1.0-alpha.2': '- 실행 결과 화면 정리\n- 녹화 중 멈춤 수정',
  '0.1.0-alpha.3': '- 클라우드 프로젝트 보내기 속도 개선\n- 설정 › 업데이트 확인 버튼 추가\n- Windows 설치 파일 첫 제공',
  '0.1.0-alpha.4': '- 앱 업데이트 알림 문구 정리',
};

async function upload(api: APIRequestContext, version: string, publish: boolean) {
  expect((await api.post('/api/admin/app-releases', { data: { version, notes: NOTES[version] } })).status()).toBe(201);
  const names = [
    `euta-${version}-mac-arm64.dmg`,
    `euta-${version}-mac-x64.dmg`,
    `euta-${version}-mac-arm64.zip`,
    `euta-${version}-win-x64.exe`,
    `euta-${version}-linux-x64.AppImage`,
    'latest-mac.yml',
    'latest.yml',
    'latest-linux.yml',
  ];
  for (const name of names) {
    const body = name.endsWith('.yml') ? `version: ${version}\npath: x\n` : `fake ${name} `.repeat(4000);
    const r = await api.put(`/api/admin/app-releases/${version}/files/${name}`, { data: Buffer.from(body), headers: { 'content-type': 'application/octet-stream' } });
    expect(r.status(), name).toBe(201);
  }
  if (publish) expect((await api.post(`/api/admin/app-releases/${version}/publish`)).status()).toBe(200);
}

async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByTestId('me')).toBeVisible();
}

/** A browser that looks like `os`; userAgentData removed so the Mac CPU stays unknown (Safari-like). */
async function visitor(browser: Browser, os: keyof typeof UA, email: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA[os], acceptDownloads: true });
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined }));
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await logIn(page, email);
  return page;
}

test.describe('앱 내려받기', () => {
  test.beforeAll(async () => {
    const anon = await playwrightRequest.newContext({ baseURL: E2E.baseUrl });
    for (const u of [{ name: '관리자2', email: E2E.admin2Email }, MEMBER]) {
      await anon.post('/api/auth/sign-up/email', { data: { name: u.name, email: u.email, password: PASSWORD } });
    }
    await anon.dispose();
    const admin = await playwrightRequest.newContext({ baseURL: E2E.baseUrl });
    expect((await admin.post('/api/auth/sign-in/email', { data: { email: E2E.admin2Email, password: PASSWORD } })).ok()).toBe(true);
    const users = (await (await admin.get('/api/admin/users')).json()).users as { id: string; email: string; status: string }[];
    const m = users.find((u) => u.email === MEMBER.email)!;
    if (m.status === 'pending') expect((await admin.post(`/api/admin/users/${m.id}/approve`)).ok()).toBe(true);
    const tok = await admin.post('/api/me/tokens', { data: { name: 'release-e2e', permission: 'read_write' } });
    expect(tok.status()).toBe(201);
    const token = ((await tok.json()) as { token: string }).token;
    await admin.dispose();
    // What `pnpm release:upload` does: create → PUT each file → publish.
    const api = await playwrightRequest.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
    await upload(api, '0.1.0-alpha.1', true);
    await upload(api, '0.1.0-alpha.2', true);
    await upload(api, '0.1.0-alpha.3', true);
    await upload(api, '0.1.0-alpha.4', false);
    await api.dispose();
  });

  test('Mac visitor: both chips first, other platforms, notes, kept versions, mac help', async ({ browser }) => {
    const page = await visitor(browser, 'mac', MEMBER.email);
    await page.locator('header').getByRole('link', { name: '앱 내려받기' }).click();
    await expect(page).toHaveURL(/\/download$/);
    await expect(page.getByRole('heading', { name: '앱 내려받기' })).toBeVisible();
    await expect(page.getByTestId('latest-version')).toContainText('최신 0.1.0-alpha.3');

    const hero = page.getByTestId('dl-hero');
    await expect(hero.getByRole('heading')).toHaveText('이 컴퓨터(macOS)용 설치 파일');
    const heroLinks = hero.getByTestId('download-link');
    await expect(heroLinks).toHaveCount(2);
    await expect(heroLinks.nth(0)).toHaveText('macOS (Apple 칩) 내려받기');
    await expect(heroLinks.nth(0)).toHaveClass(/btn-primary/);
    await expect(heroLinks.nth(1)).toHaveText('macOS (Intel) 내려받기');
    await expect(heroLinks.nth(0)).toHaveAttribute('href', `${E2E.baseUrl}/updates/alpha/0.1.0-alpha.3/euta-0.1.0-alpha.3-mac-arm64.dmg`);
    await expect(hero).toContainText('euta-0.1.0-alpha.3-mac-arm64.dmg');
    await expect(page.getByTestId('mac-chip-hint')).toContainText('이 Mac에 관하여');

    const others = page.getByTestId('other-platforms').getByTestId('download-link');
    await expect(others).toHaveText(['Windows (64비트)', 'Linux (x64 · AppImage)']);
    await expect(page.getByTestId('release-notes')).toContainText('Windows 설치 파일 첫 제공');

    const rows = page.getByTestId('version-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('0.1.0-alpha.3');
    await expect(rows.nth(0)).toContainText('최신');
    await expect(rows.nth(2)).toContainText('0.1.0-alpha.1');
    await expect(rows.nth(1).getByTestId('download-link')).toHaveCount(4);

    const help = page.getByTestId('install-help');
    await expect(help.getByRole('button', { name: 'macOS' })).toHaveAttribute('aria-pressed', 'true');
    await expect(help).toContainText('그래도 열기');
    await expect(help).toContainText('개인정보 보호 및 보안');
    // No admin part for a member.
    await expect(page.getByTestId('admin-releases')).toHaveCount(0);
    await page.screenshot({ path: 'e2e-results/download-1-mac.png', fullPage: true });

    // The big button really downloads the installer.
    const [download] = await Promise.all([page.waitForEvent('download'), heroLinks.nth(0).click()]);
    expect(download.suggestedFilename()).toBe('euta-0.1.0-alpha.3-mac-arm64.dmg');
    // An older kept version too.
    const [old] = await Promise.all([page.waitForEvent('download'), rows.nth(2).getByTestId('download-link').first().click()]);
    expect(old.suggestedFilename()).toBe('euta-0.1.0-alpha.1-mac-arm64.dmg');

    // Help for the other platforms.
    await help.getByRole('button', { name: 'Windows' }).click();
    await expect(help).toContainText('추가 정보');
    await expect(help).toContainText('[실행]');
    await help.getByRole('button', { name: 'Linux' }).click();
    await expect(help).toContainText('chmod +x');
    await page.context().close();
  });

  test('Windows and Linux visitors get their installer first', async ({ browser }) => {
    const win = await visitor(browser, 'win', MEMBER.email);
    await win.goto('/download');
    const hero = win.getByTestId('dl-hero');
    await expect(hero.getByTestId('download-link')).toHaveText(['Windows (64비트) 내려받기']);
    await expect(win.getByTestId('mac-chip-hint')).toHaveCount(0);
    await expect(win.getByTestId('other-platforms').getByTestId('download-link')).toHaveText(['macOS (Apple 칩)', 'macOS (Intel)', 'Linux (x64 · AppImage)']);
    await expect(win.getByTestId('install-help').getByRole('button', { name: 'Windows' })).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('install-help')).toContainText('SmartScreen');
    await win.screenshot({ path: 'e2e-results/download-2-windows.png', fullPage: true });
    await win.context().close();

    const linux = await visitor(browser, 'linux', MEMBER.email);
    await linux.goto('/download');
    await expect(linux.getByTestId('dl-hero').getByTestId('download-link')).toHaveText(['Linux (x64 · AppImage) 내려받기']);
    await expect(linux.getByTestId('install-help')).toContainText('chmod +x');
    await linux.screenshot({ path: 'e2e-results/download-3-linux.png' });
    await linux.context().close();
  });

  test('admin publishes the draft; the oldest kept version drops out', async ({ browser }) => {
    const page = await visitor(browser, 'mac', E2E.admin2Email);
    await page.goto('/download');
    const admin = page.getByTestId('admin-releases');
    await expect(admin.getByRole('heading', { name: '릴리스 관리 (관리자)' })).toBeVisible();
    const draft = admin.getByTestId('admin-release-row').filter({ hasText: '0.1.0-alpha.4' });
    await expect(draft).toContainText('초안');
    await expect(admin.getByTestId('admin-release-row')).toHaveCount(4);
    await admin.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'e2e-results/download-4-admin.png', fullPage: true });

    await draft.getByRole('button', { name: '게시' }).click();
    await expect(draft).toContainText('게시');
    await expect(draft).not.toContainText('초안');
    // alpha.1 was the 4th published → removed with its files.
    await expect(admin.getByTestId('admin-release-row')).toHaveCount(3);
    await page.reload();
    await expect(page.getByTestId('latest-version')).toContainText('최신 0.1.0-alpha.4');
    await expect(page.getByTestId('version-row')).toHaveCount(3);
    await expect(page.getByTestId('version-row').filter({ hasText: '0.1.0-alpha.1' })).toHaveCount(0);
    expect((await page.request.get('/updates/alpha/0.1.0-alpha.1/euta-0.1.0-alpha.1-mac-arm64.dmg')).status()).toBe(404);
    const yml = await page.request.get('/updates/alpha/latest-mac.yml');
    expect(yml.headers()['cache-control']).toBe('no-store');
    expect(await yml.text()).toContain('0.1.0-alpha.4');
    await page.context().close();
  });
});
