// Web E2E for the project / run screens (SPEC 계정 완료 기준 C4 · 실행 완료 기준 C4) against the real
// server + compose PostgreSQL + a real runner (engine CLI, Chromium) on the engine fixture site:
// create project → environment + test credentials → script built in the form editor → save → cloud
// run with live progress → run detail (screenshots, report) → schedule → a second (viewer) account sees
// the same state read-only (no webhook URL) → invited as editor → concurrent save conflict dialog →
// revert from history → test set report → "수동 확인 필요" (DSL manual steps).
import { expect, request as playwrightRequest, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E } from './env.mjs';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'correct-horse-battery';
const OWNER = { name: '김소유', email: 'owner.e2e@example.com' };
const OTHER = { name: '박동료', email: 'other.e2e@example.com' };
const FIXTURE_USER = { email: 'qa.user@example.com', password: 's3cret P@ss&word!' };
const PROJECT = 'E2E 쇼핑몰';
const WEBHOOK = 'https://prod-00.koreacentral.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=e2e-secret-sig-value';

async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByTestId('me')).toBeVisible();
}

/** Sign-ups over HTTP + approval by the administrator (admin-approval mode). */
async function prepareAccounts() {
  const api = await playwrightRequest.newContext({ baseURL: E2E.baseUrl });
  for (const u of [{ name: '관리자2', email: E2E.admin2Email }, OWNER, OTHER]) {
    await api.post('/api/auth/sign-up/email', { data: { name: u.name, email: u.email, password: PASSWORD } }); // may already exist
  }
  const admin = await playwrightRequest.newContext({ baseURL: E2E.baseUrl });
  expect((await admin.post('/api/auth/sign-in/email', { data: { email: E2E.admin2Email, password: PASSWORD } })).ok()).toBe(true);
  const users = (await (await admin.get('/api/admin/users')).json()).users as { id: string; email: string; status: string }[];
  for (const u of users.filter((x) => [OWNER.email, OTHER.email].includes(x.email) && x.status === 'pending')) {
    expect((await admin.post(`/api/admin/users/${u.id}/approve`)).ok()).toBe(true);
  }
  await api.dispose();
  await admin.dispose();
}

async function newPage(browser: Browser, email: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await logIn(page, email);
  return page;
}

/** Open the step form of step `id` in the editor. */
async function openStep(page: Page, id: string) {
  await page.locator(`[data-testid="detail-step"][data-step-id="${id}"] .step-main`).click();
  await expect(page.getByTestId('step-form')).toBeVisible();
}

async function startEditing(page: Page) {
  await page.getByTestId('detail-edit').click();
  await expect(page.getByTestId('script-detail')).toHaveAttribute('data-mode', 'edit');
}

async function addStep(page: Page, kind: string) {
  await page.getByTestId('step-add-end').selectOption(kind);
  await expect(page.getByTestId('step-form')).toBeVisible();
}

const saveReady = (page: Page) => expect(page.getByTestId('edit-status')).toHaveText('✓ 저장할 수 있습니다', { timeout: 10_000 });

test.describe('project · script · cloud run · sharing', () => {
  let owner: Page;
  let other: Page;
  let projectUrl = '';
  let scriptUrl = '';
  let firstRunUrl = '';

  test.beforeAll(async ({ browser }) => {
    await prepareAccounts();
    owner = await newPage(browser, OWNER.email);
  });
  test.afterAll(async () => {
    await owner?.context().close();
    await other?.context().close();
  });

  test('create project → environment → write-only test credentials → webhook', async () => {
    await owner.getByTestId('new-project').click();
    await owner.locator('input[name="project-name"]').fill(PROJECT);
    await owner.getByRole('button', { name: '만들기' }).click();
    await expect(owner).toHaveURL(/\/projects\/[^/]+\/settings$/);
    projectUrl = owner.url().replace(/\/settings$/, '');
    await expect(owner.getByTestId('project-name')).toHaveText(PROJECT);
    await expect(owner.getByTestId('my-role')).toHaveText('소유자');

    // Environment = the fixture site (private address → warning; runs allowed by ALLOW_PRIVATE_TARGETS).
    await owner.getByTestId('new-env').click();
    await owner.locator('input[name="env-name"]').fill('dev');
    await owner.locator('input[name="env-url"]').fill(E2E.fixtureUrl);
    await owner.getByTestId('env-form').getByRole('button', { name: '추가' }).click();
    const env = owner.locator('[data-testid="env-row"][data-name="dev"]');
    await expect(env).toBeVisible();
    await expect(env.getByText('기본', { exact: true })).toBeVisible();
    await expect(env.getByTestId('env-not-public')).toBeVisible();
    await expect(env).toContainText('127.0.0.1');

    for (const [name, value] of [
      ['USER_EMAIL', FIXTURE_USER.email],
      ['USER_PASSWORD', FIXTURE_USER.password],
    ]) {
      await env.locator('input[name="credential-name"]').fill(name!);
      await env.locator('input[name="credential-value"]').fill(value!);
      await env.getByTestId('credential-form').getByRole('button', { name: '저장' }).click();
      await expect(env.locator(`[data-testid="credential-row"][data-name="${name}"]`)).toContainText(OWNER.name);
    }
    // Write-only: the value never comes back.
    await owner.reload();
    await expect(owner.locator('[data-testid="credential-row"]')).toHaveCount(2);
    expect(await owner.content()).not.toContain(FIXTURE_USER.password);

    await owner.locator('input[name="webhook"]').fill(WEBHOOK);
    await owner.getByTestId('webhook-form').getByRole('button', { name: '저장' }).click();
    await expect(owner.getByTestId('settings-notify').getByRole('status')).toHaveText('저장했습니다');
  });

  test('script built in the form editor → live validation → save', async () => {
    await owner.getByRole('tab', { name: '스크립트' }).click();
    await owner.getByTestId('new-script').click();
    // The name comes first; the path follows it (Hangul kept) until edited.
    await owner.locator('input[name="script-name"]').fill('로그인 점검');
    await expect(owner.locator('input[name="script-path"]')).toHaveValue('로그인-점검.yaml');
    await owner.screenshot({ path: 'e2e-results/scripts-1-new.png' });
    await owner.locator('input[name="script-path"]').fill('login');
    await owner.getByRole('button', { name: '폼 편집기로 만들기' }).click();
    await expect(owner).toHaveURL(/\/scripts\/login\.yaml\?new=1&name=/);
    await expect(owner.getByTestId('detail-name')).toHaveText('로그인 점검');
    await expect(owner.getByTestId('script-detail')).toHaveAttribute('data-mode', 'edit');
    await expect(owner.getByTestId('step-sentence')).toHaveText(['/ 으로 이동']);

    await openStep(owner, '1');
    await owner.getByTestId('f-url').fill('/login');
    await addStep(owner, 'fill');
    await owner.getByTestId('f-target-value').fill('이메일');
    await owner.getByTestId('f-value-mode').selectOption('secrets');
    await owner.getByTestId('f-value-secret').selectOption('USER_EMAIL');
    await addStep(owner, 'fill');
    await owner.getByTestId('f-target-value').fill('비밀번호');
    await owner.getByTestId('f-value-mode').selectOption('secrets');
    await owner.getByTestId('f-value-secret').selectOption('USER_PASSWORD');
    await addStep(owner, 'click');
    await owner.getByTestId('f-target-name').fill('로그인');
    // Live validation: an empty expect target is an error until fixed.
    await addStep(owner, 'expect');
    await owner.getByTestId('f-expect-remove').click();
    await owner.getByTestId('f-expect-add').selectOption('url');
    await owner.getByTestId('f-expect-0-text').fill('/dashboard');
    await addStep(owner, 'wait');
    await owner.getByTestId('f-wait-ms').fill('4000');
    await saveReady(owner);
    await expect(owner.getByTestId('step-sentence')).toHaveText([
      '/login 으로 이동',
      "'이메일' 입력란에 🔒USER_EMAIL 입력",
      "'비밀번호' 입력란에 🔒USER_PASSWORD 입력",
      "'로그인' 버튼 클릭",
      '확인: 주소에 /dashboard 포함',
      '4000ms 기다리기',
    ]);
    // A broken value blocks saving.
    await owner.getByTestId('f-wait-ms').fill('4 seconds');
    await expect(owner.getByTestId('edit-status')).toContainText('오류', { timeout: 10_000 });
    await expect(owner.getByTestId('edit-save')).toBeDisabled();
    await owner.getByTestId('f-wait-ms').fill('4000');
    await saveReady(owner);
    await owner.getByTestId('edit-save').click();
    await expect(owner.getByTestId('detail-note')).toHaveText('저장했습니다 — 버전 1');
    await expect(owner).toHaveURL(/\/scripts\/login\.yaml$/);
    scriptUrl = owner.url();
    await expect(owner.getByTestId('script-detail')).toHaveAttribute('data-mode', 'view');
    await expect(owner.getByTestId('step-sentence')).toHaveCount(6);
    await expect(owner.getByTestId('script-path')).toContainText('v1');
  });

  test('cloud run: precheck → live progress → run detail with screenshots and report → overlay', async () => {
    test.setTimeout(150_000);
    await owner.getByTestId('detail-run').click();
    await expect(owner.getByTestId('precheck-ok')).toContainText('USER_EMAIL, USER_PASSWORD');
    await owner.getByTestId('run-start').click();
    await expect(owner).toHaveURL(/\/runs\/[^/]+$/);
    const detail = owner.getByTestId('run-detail');
    // Live: the running state with the current step sentence (4 s wait step) and an elapsed ticker.
    await expect(owner.getByTestId('run-current-step')).toBeVisible({ timeout: 60_000 });
    await expect(owner.getByTestId('run-current-step')).toContainText('번 단계');
    await expect(owner.getByTestId('run-elapsed')).toBeVisible();
    await expect(detail).toHaveAttribute('data-status', 'passed', { timeout: 90_000 });
    firstRunUrl = owner.url();
    await expect(owner.getByTestId('run-live')).toHaveCount(0);
    await expect(owner.getByTestId('run-summary')).toContainText('6/6 통과');
    await expect(owner.getByTestId('run-source')).toHaveText('웹');
    await expect(owner.getByTestId('run-location')).toHaveText(E2E.runnerLocation);
    await expect(owner.getByTestId('run-step')).toHaveCount(6);
    await expect(owner.getByTestId('run-step').nth(1).getByTestId('step-sentence')).toHaveText("'이메일' 입력란에 🔒USER_EMAIL 입력");
    await expect(owner.getByTestId('step-shot').first()).toBeVisible({ timeout: 15_000 });
    await owner.getByTestId('step-shot').first().click();
    await expect(owner.getByTestId('shot-modal').locator('img')).toHaveJSProperty('complete', true);
    expect(await owner.getByTestId('shot-modal').locator('img').evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
    await owner.getByTestId('shot-modal').click();
    await expect(owner.getByTestId('run-files')).toContainText('report.html');
    const reportHref = await owner.getByTestId('run-report').getAttribute('href');
    const report = await owner.request.get(reportHref!);
    expect(report.status()).toBe(200);
    expect(report.headers()['content-type']).toContain('text/html');
    expect(await report.text()).not.toContain(FIXTURE_USER.password);

    // The script detail overlays this run (same content hash).
    await owner.goto(scriptUrl);
    await expect(owner.getByTestId('detail-last-run')).toContainText('통과');
    await expect(owner.locator('[data-testid="detail-step"][data-status="passed"]')).toHaveCount(6);
    await expect(owner.getByTestId('overlay-stale')).toHaveCount(0);
  });

  test('schedule create', async () => {
    await owner.goto(`${projectUrl}/schedules`);
    await owner.getByTestId('new-schedule').click();
    await owner.locator('input[name="schedule-name"]').fill('주간 로그인 점검');
    // Script target = search + check one (no file-name drop-down); nothing is pre-picked.
    await expect(owner.getByTestId('schedule-save')).toBeDisabled();
    const pick = owner.getByTestId('schedule-target');
    await pick.getByLabel('스크립트 찾기', { exact: false }).fill('로그인');
    await pick.locator('[data-testid="pick-candidate"][data-path="login.yaml"]').getByRole('checkbox').check();
    await expect(pick.locator('[data-testid="pick-candidate"][data-picked="true"]')).toHaveCount(1);
    await owner.getByTestId('schedule-kind').selectOption('weekly');
    // A day that is not today (Asia/Seoul), so it cannot fire during the test.
    const seoulDay = new Date(Date.now() + 9 * 3600_000).getUTCDay();
    await owner.getByTestId('schedule-form').getByLabel('요일').selectOption(String((seoulDay + 3) % 7));
    await owner.getByTestId('schedule-time').fill('03:00');
    await owner.getByTestId('schedule-save').click();
    const row = owner.locator('[data-testid="schedule-row"][data-name="주간 로그인 점검"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('로그인 점검');
    await expect(row).toContainText('login.yaml');
    await expect(row.getByTestId('schedule-next')).not.toHaveText('-');
    await expect(row).toContainText('켜짐');
  });

  test('another member (viewer) sees the same state read-only, without the webhook URL', async ({ browser }) => {
    other = await newPage(browser, OTHER.email);
    await expect(other.getByText('초대받은 프로젝트가 없습니다.', { exact: false })).toBeVisible();
    await other.getByRole('link', { name: '전체' }).click();
    const row = other.locator('[data-testid="project-row"]').filter({ hasText: PROJECT });
    await expect(row.getByTestId('run-status')).toHaveText('통과');
    await row.getByRole('link', { name: PROJECT }).click();
    await expect(other.getByTestId('my-role')).toHaveText('보기');
    await expect(other.getByTestId('read-only')).toHaveText('보기 전용');
    await expect(other.getByTestId('overview').getByTestId('run-row').first()).toHaveAttribute('data-status', 'passed');
    await expect(other.getByTestId('upcoming-schedules')).toContainText('주간 로그인 점검');

    await other.getByRole('tab', { name: '예약' }).click();
    await expect(other.locator('[data-testid="schedule-row"]')).toHaveCount(1);
    await expect(other.getByTestId('new-schedule')).toHaveCount(0);
    await expect(other.getByTestId('schedule-toggle')).toHaveCount(0);

    await other.getByRole('tab', { name: '스크립트' }).click();
    await expect(other.getByTestId('new-script')).toHaveCount(0);
    // The list shows the name (bold, the link) with the path small under it.
    const scriptRow = other.locator('[data-testid="script-row"][data-path="login.yaml"]');
    await expect(scriptRow).toContainText('로그인 점검');
    await other.screenshot({ path: 'e2e-results/scripts-2-list.png' });
    await scriptRow.getByRole('link', { name: '로그인 점검' }).click();
    await expect(other.getByTestId('step-sentence')).toHaveCount(6);
    await expect(other.locator('[data-testid="detail-step"][data-status="passed"]')).toHaveCount(6);
    for (const id of ['detail-edit', 'detail-run', 'detail-rename', 'detail-delete']) await expect(other.getByTestId(id)).toHaveCount(0);

    await other.getByRole('tab', { name: '실행 이력' }).click();
    await other.getByTestId('run-row').first().getByRole('link').first().click();
    await expect(other.getByTestId('run-detail')).toHaveAttribute('data-status', 'passed');
    await expect(other.getByTestId('run-rerun')).toHaveCount(0);
    await expect(other.getByTestId('step-shot').first()).toBeVisible();

    await other.getByRole('tab', { name: '설정' }).click();
    await expect(other.getByTestId('webhook-status')).toHaveText('Teams 알림: 설정됨');
    await expect(other.getByTestId('webhook-form')).toHaveCount(0);
    await expect(other.getByTestId('new-env')).toHaveCount(0);
    await expect(other.getByTestId('credential-form')).toHaveCount(0);
    await expect(other.getByTestId('invite')).toHaveCount(0);
    await expect(other.getByTestId('settings-delete')).toHaveCount(0);
    expect(await other.content()).not.toContain('e2e-secret-sig-value');
    const apiView = await (await other.request.get(`/api/projects/${projectUrl.split('/').pop()}`)).json();
    expect(apiView.teamsWebhookUrl).toBeUndefined();
    expect(apiView.teamsWebhookConfigured).toBe(true);
  });

  test('owner invites the viewer as editor → edit controls appear', async () => {
    await owner.goto(`${projectUrl}/settings`);
    await owner.locator('input[name="invite-search"]').fill('other.e2e');
    const cand = owner.locator(`[data-testid="invite-candidate"][data-email="${OTHER.email}"]`);
    await expect(cand).toBeVisible();
    await cand.getByRole('checkbox').check();
    await owner.getByTestId('invite-submit').click();
    await expect(owner.locator(`[data-testid="member-row"][data-email="${OTHER.email}"]`)).toBeVisible();

    await other.goto(scriptUrl);
    await expect(other.getByTestId('my-role')).toHaveText('편집자');
    await expect(other.getByTestId('read-only')).toHaveCount(0);
    await expect(other.getByTestId('detail-edit')).toBeVisible();
  });

  test('concurrent saves: the second save gets the conflict dialog (3 choices) → "mine" as a new version', async () => {
    // Both start editing version 1.
    await startEditing(other);
    await openStep(other, '1');
    await other.getByTestId('f-url').fill('/login?from=other');
    await saveReady(other);

    await owner.goto(scriptUrl);
    await startEditing(owner);
    await openStep(owner, '6');
    await owner.getByTestId('f-wait-ms').fill('1000');
    await saveReady(owner);
    await owner.getByTestId('edit-save').click();
    await expect(owner.getByTestId('detail-note')).toHaveText('저장했습니다 — 버전 2');

    // The other editor is told while editing, and the save opens the conflict dialog.
    await expect(other.getByTestId('remote-saved')).toContainText('버전 2');
    await other.getByTestId('edit-save').click();
    const dialog = other.getByTestId('conflict-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('conflict-server-version')).toHaveText('버전 2');
    await expect(dialog.getByTestId('conflict-summary')).toHaveText('단계 2개 변경');
    await expect(dialog.locator('[data-testid="conflict-row"][data-kind="changed"]')).toHaveCount(2);
    await expect(dialog.getByTestId('conflict-choose-theirs')).toBeVisible();
    await expect(dialog.getByTestId('conflict-choose-copy')).toContainText('login-박동료.yaml');
    await dialog.getByTestId('conflict-choose-mine').click();
    await expect(other.getByTestId('detail-note')).toHaveText('내 것으로 새 버전을 저장했습니다 — 버전 3');
    await expect(other.getByTestId('step-sentence').first()).toHaveText('/login?from=other 으로 이동');
  });

  test('revert from history', async () => {
    await owner.goto(scriptUrl);
    await expect(owner.getByTestId('script-path')).toContainText('v3');
    await owner.getByTestId('detail-history').click();
    await expect(owner.getByTestId('version-row')).toHaveCount(3);
    await expect(owner.locator('[data-testid="version-row"][data-version="3"]').getByTestId('version-author')).toHaveText(OTHER.name);
    await owner.locator('[data-testid="version-row"][data-version="1"]').click();
    await expect(owner.getByTestId('compare-view')).toHaveAttribute('data-version', '1');
    await expect(owner.getByTestId('compare-summary')).toHaveText('처음 기록 (단계 6개)');
    owner.once('dialog', (d) => void d.accept());
    await owner.getByTestId('version-revert').click();
    await expect(owner.getByTestId('detail-note')).toHaveText('버전 1 로 되돌렸습니다 — 새 버전 4');
    await expect(owner.locator('[data-testid="version-row"][data-version="4"]')).toHaveAttribute('data-origin', 'revert');
    await owner.getByTestId('detail-history').click();
    await expect(owner.getByTestId('step-sentence').first()).toHaveText('/login 으로 이동');
    await expect(owner.getByTestId('step-sentence').last()).toHaveText('4000ms 기다리기');
    // Version 1's content was run → the overlay matches again.
    await expect(owner.getByTestId('overlay-stale')).toHaveCount(0);
  });

  test('re-run with the same settings → cancel', async () => {
    test.setTimeout(120_000);
    await owner.goto(firstRunUrl);
    await owner.getByTestId('run-rerun').click();
    await expect(owner).not.toHaveURL(firstRunUrl);
    await expect(owner.getByTestId('run-cancel')).toBeVisible();
    owner.once('dialog', (d) => void d.accept());
    await owner.getByTestId('run-cancel').click();
    await expect(owner.getByTestId('run-detail')).toHaveAttribute('data-status', 'cancelled', { timeout: 60_000 });
    await expect(owner.getByTestId('run-source')).toHaveText('웹');
    await expect(owner.getByTestId('run-cancel')).toHaveCount(0);
  });

  test('테스트 세트: wording · 항상 실행 toggle → run → cancel → the always-run item still runs', async () => {
    test.setTimeout(150_000);
    const pid = decodeURIComponent(new URL(projectUrl).pathname.split('/')[2]!);
    const put = await owner.request.put(`/api/projects/${encodeURIComponent(pid)}/scripts/cleanup.yaml`, {
      data: { source: 'version: 1\nname: 정리\ntarget:\n  baseUrl: ${env.BASE_URL}\nsteps:\n  - goto: /login\n' },
    });
    expect(put.status()).toBe(201);
    await owner.goto(`${projectUrl}/suites`);
    await expect(owner.getByRole('tab', { name: '테스트 세트' })).toBeVisible();
    await expect(owner.locator('body')).not.toContainText('스위트');
    await owner.getByTestId('new-suite').click();
    await owner.locator('input[name="suite-name"]').fill('로그인 + 정리');
    // Search + check: checked scripts move up in check order with their number, then go in that order.
    const picker = owner.getByTestId('suite-pick');
    for (const p of ['login.yaml', 'cleanup.yaml']) await picker.locator(`[data-testid="pick-candidate"][data-path="${p}"]`).getByRole('checkbox').check();
    await expect(picker.locator('[data-testid="pick-candidate"][data-picked="true"]')).toHaveText([/1\s*로그인 점검/, /2\s*정리/]);
    await owner.screenshot({ path: 'e2e-results/scripts-3-suite-pick.png', fullPage: true });
    await owner.getByTestId('suite-pick-add').click();
    await expect(owner.getByTestId('suite-form-item')).toHaveText([/로그인 점검/, /정리/]);
    await owner.getByTestId('suite-form-item').nth(1).getByTestId('suite-always').check();
    await owner.getByTestId('suite-form').getByRole('button', { name: '만들기' }).click();
    const row = owner.locator('[data-testid="suite-row"][data-name="로그인 + 정리"]');
    await expect(row.getByTestId('suite-item')).toHaveCount(2);
    await expect(row.getByTestId('suite-item').nth(0).getByTestId('suite-item-always')).toHaveCount(0);
    await expect(row.getByTestId('suite-item').nth(1).getByTestId('suite-item-always')).toHaveText('항상 실행');

    await row.getByRole('button', { name: '실행…' }).click();
    await expect(row.getByTestId('precheck-ok')).toBeVisible();
    await row.getByTestId('run-start').click();
    await expect(owner).toHaveURL(/\/runs\/[^/]+$/);
    await expect(owner.getByTestId('run-detail')).toContainText('테스트 세트 로그인 + 정리');
    owner.once('dialog', (d) => void d.accept());
    await owner.getByTestId('run-cancel').click();
    await expect(owner.getByTestId('run-detail')).toHaveAttribute('data-status', 'cancelled', { timeout: 90_000 });
    const kids = owner.getByTestId('run-row');
    await expect(kids).toHaveCount(2);
    await expect(kids.nth(0)).toHaveAttribute('data-status', 'cancelled');
    await expect(kids.nth(1)).toHaveAttribute('data-status', 'passed');
    await expect(kids.nth(1).getByTestId('run-always')).toHaveText('항상 실행');
  });

  test('테스트 세트 리포트: the set run detail shows summary, per-script table, failure detail; a re-run compares (회복)', async () => {
    test.setTimeout(240_000);
    const pid = decodeURIComponent(new URL(projectUrl).pathname.split('/')[2]!);
    const api = `/api/projects/${encodeURIComponent(pid)}`;
    const broken = (title: string) => `version: 1\nname: 제목 확인\ntarget:\n  baseUrl: \${env.BASE_URL}\ndefaults:\n  timeout: 2s\nsteps:\n  - goto: /login\n  - expect: { title: ${title} }\n`;
    expect((await owner.request.put(`${api}/scripts/title-check.yaml`, { data: { source: broken('존재하지 않는 제목') } })).status()).toBe(201);
    const ids: string[] = [];
    for (const p of ['login.yaml', 'title-check.yaml']) ids.push(((await (await owner.request.get(`${api}/scripts/${p}`)).json()) as { id: string }).id);
    const suite = (await (await owner.request.post(`${api}/suites`, { data: { name: '리포트 세트', scriptIds: ids } })).json()) as { id: string };
    const runSet = async () => {
      const r = await owner.request.post(`${api}/runs`, { data: { suiteId: suite.id } });
      expect(r.status()).toBe(201);
      const id = ((await r.json()) as { id: string }).id;
      await owner.goto(`${projectUrl}/runs/${id}`);
      await expect(owner.getByTestId('run-detail')).toHaveAttribute('data-status', /^(failed|passed)$/, { timeout: 150_000 });
      return id;
    };
    await runSet();
    const report = owner.getByTestId('suite-report');
    await expect(owner.getByTestId('run-detail')).toHaveAttribute('data-status', 'failed');
    await expect(report.getByTestId('sr-passed')).toHaveText('1/2');
    await expect(report.getByTestId('sr-compare-none')).toBeVisible();
    await expect(report.getByTestId('run-row')).toHaveCount(2);
    await expect(report.getByTestId('run-row').nth(1)).toContainText('제목 확인');
    await expect(report.getByTestId('run-row').nth(1)).toContainText('title-check.yaml');
    const fail = report.getByTestId('sr-failure');
    await expect(fail).toHaveCount(1);
    await expect(fail.getByTestId('sr-step-sentence')).toContainText('존재하지 않는 제목');
    await expect(fail.getByTestId('sr-error')).toContainText('존재하지 않는 제목');
    await expect(fail.getByTestId('sr-shot').locator('img')).toBeVisible({ timeout: 20_000 });
    expect(await fail.getByTestId('sr-shot').locator('img').evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(100);
    await owner.screenshot({ path: 'e2e-results/suite-report-1.png', fullPage: true });

    // Fix the failing script and run the set again → "회복" against the previous run (same set, same environment).
    const cur = (await (await owner.request.get(`${api}/scripts/title-check.yaml`)).json()) as { version: number };
    expect((await owner.request.put(`${api}/scripts/title-check.yaml`, { data: { source: broken('/로그인/'), baseVersion: cur.version } })).status()).toBeLessThan(300);
    await runSet();
    await expect(owner.getByTestId('run-detail')).toHaveAttribute('data-status', 'passed');
    await expect(report.getByTestId('sr-recovered')).toHaveAttribute('data-count', '1');
    await expect(report.getByTestId('sr-recovered')).toContainText('2. 제목 확인');
    await expect(report.getByTestId('sr-still-passing')).toHaveAttribute('data-count', '1');
    await expect(report).toContainText('실패한 스크립트가 없습니다');
    await owner.screenshot({ path: 'e2e-results/suite-report-2.png', fullPage: true });
  });

  test('수동 확인 필요: manual steps show a badge + instruction in the run detail, the set report and the script overlay', async () => {
    test.setTimeout(240_000);
    const pid = decodeURIComponent(new URL(projectUrl).pathname.split('/')[2]!);
    const api = `/api/projects/${encodeURIComponent(pid)}`;
    // Reached manual steps (top level + in a group), then a failing check, then a manual step that is not reached.
    const source = `version: 1
name: 수동 확인 예시
target:
  baseUrl: \${env.BASE_URL}
defaults:
  timeout: 2s
steps:
  - goto: /login
  - manual: { instruction: 로그인 화면 로고 색이 브랜드 색인지 확인, reason: 사람 판단 }
  - group:
      name: 안내 문구
      steps:
        - manual: 안내 문구가 자연스러운지 읽어 보기
  - expect: { title: 존재하지 않는 제목 }
  - manual: 결제 완료 메일이 왔는지 확인
`;
    expect((await owner.request.put(`${api}/scripts/manual-check.yaml`, { data: { source } })).status()).toBe(201);
    const id = (await (await owner.request.get(`${api}/scripts/manual-check.yaml`)).json()).id as string;
    const r = await owner.request.post(`${api}/runs`, { data: { scriptId: id } });
    expect(r.status()).toBe(201);
    await owner.goto(`${projectUrl}/runs/${((await r.json()) as { id: string }).id}`);
    const detail = owner.getByTestId('run-detail');
    await expect(detail).toHaveAttribute('data-status', 'failed', { timeout: 120_000 });

    // Run detail: reached → "수동 확인 필요" badge + instruction + reason; not reached → skipped look + error.
    const step = (sid: string) => owner.locator(`[data-testid="run-step"][data-step-id="${sid}"]`);
    await expect(step('2')).toHaveAttribute('data-manual', 'reached');
    await expect(step('2')).toHaveAttribute('data-status', 'skipped');
    await expect(step('2').getByTestId('step-manual')).toHaveText('수동 확인 필요');
    await expect(step('2').getByTestId('step-sentence')).toContainText('로그인 화면 로고 색이 브랜드 색인지 확인');
    await expect(step('2').getByTestId('step-manual-reason')).toHaveText('이유: 사람 판단');
    await expect(step('3.1')).toHaveAttribute('data-manual', 'reached');
    await expect(step('3.1').getByTestId('step-sentence')).toContainText('안내 문구가 자연스러운지 읽어 보기');
    await expect(step('5')).toHaveAttribute('data-manual', 'unreached');
    await expect(step('5').getByTestId('step-manual')).toHaveCount(0);
    await expect(step('5').getByTestId('step-sentence')).toContainText('결제 완료 메일이 왔는지 확인');
    await expect(step('5')).toContainText('skipped after step 4 failed');
    await expect(owner.getByTestId('step-manual')).toHaveCount(2);
    await expect(owner.getByTestId('run-manual-count')).toHaveText('수동 확인 필요 3');
    await owner.screenshot({ path: 'e2e-results/manual-run-detail.png', fullPage: true });
    await owner.emulateMedia({ colorScheme: 'dark' });
    await owner.screenshot({ path: 'e2e-results/manual-run-detail-dark.png', fullPage: true });
    await owner.emulateMedia({ colorScheme: 'light' });

    // Script detail: the latest run overlay uses the same badge.
    await owner.goto(`${projectUrl}/scripts/manual-check.yaml`);
    await expect(owner.locator('[data-testid="detail-step"] [data-testid="step-manual"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(owner.locator('[data-testid="detail-step"][data-step-id="5"]')).toHaveAttribute('data-status', 'skipped');
    await owner.screenshot({ path: 'e2e-results/manual-script-overlay.png', fullPage: true });

    // Test set report: summary card, per-script count, "수동 확인 필요" table.
    const ids: string[] = [];
    for (const p of ['manual-check.yaml', 'title-check.yaml']) ids.push(((await (await owner.request.get(`${api}/scripts/${p}`)).json()) as { id: string }).id);
    const suite = (await (await owner.request.post(`${api}/suites`, { data: { name: '수동 확인 세트', scriptIds: ids } })).json()) as { id: string };
    const sr = await owner.request.post(`${api}/runs`, { data: { suiteId: suite.id } });
    expect(sr.status()).toBe(201);
    await owner.goto(`${projectUrl}/runs/${((await sr.json()) as { id: string }).id}`);
    await expect(owner.getByTestId('run-detail')).toHaveAttribute('data-status', 'failed', { timeout: 150_000 });
    const report = owner.getByTestId('suite-report');
    await expect(report.getByTestId('sr-manual-count')).toHaveAttribute('data-count', '3');
    await expect(report.getByTestId('run-row').nth(0).getByTestId('run-manual-count')).toHaveText('수동 확인 필요 3');
    await expect(report.getByTestId('run-row').nth(1).getByTestId('run-manual-count')).toHaveCount(0);
    const rows = report.getByTestId('sr-manual-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('수동 확인 예시');
    await expect(rows.nth(0)).toContainText('로그인 화면 로고 색이 브랜드 색인지 확인');
    await expect(rows.nth(0)).toContainText('사람 판단');
    await expect(rows.nth(1)).toContainText('3.1');
    await expect(rows.nth(2)).toHaveAttribute('data-reached', 'false');
    await expect(rows.nth(2)).toContainText('실행 안 됨');
    await owner.screenshot({ path: 'e2e-results/manual-suite-report.png', fullPage: true });
    await owner.emulateMedia({ colorScheme: 'dark' });
    await owner.screenshot({ path: 'e2e-results/manual-suite-report-dark.png', fullPage: true });
    await owner.emulateMedia({ colorScheme: 'light' });
  });

  test('result files past retention show "파일 만료"', async () => {
    // Retention itself is a server test; here the run row is marked the way the purge leaves it.
    const runId = firstRunUrl.split('/').pop()!;
    const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://euta:euta-dev-only@localhost:55432/euta';
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const dbs = (await admin.query(`select datname from pg_database where datname like 'euta_e2e_%'`)).rows.map((r) => r.datname as string);
    await admin.end();
    expect(dbs).toHaveLength(1);
    const url = new URL(adminUrl);
    url.pathname = `/${dbs[0]}`;
    const db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(`update runs set result_files = 'expired' where id = $1`, [runId]);
    await db.end();
    await owner.goto(firstRunUrl);
    await expect(owner.getByTestId('files-expired')).toContainText('파일 만료');
    await expect(owner.getByTestId('run-report')).toHaveCount(0);
    await expect(owner.getByTestId('step-shot')).toHaveCount(0);
    await expect(owner.getByTestId('run-step')).toHaveCount(6);
  });
});
