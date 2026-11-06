// Web E2E for stage 15 "한 프로젝트 + 권한" (SPEC 계정 "만들기·공개·구성원"): access request → owner approves
// as runner → the runner can run but not edit · invite by search + check (checked on top, numbered) ·
// members-only switch hides the project from a non-member (even one with it open) · admin assigns an owner
// to an ownerless project. Screenshots go to e2e-results/perm-*.png for the UI review.
import { expect, request as playwrightRequest, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E } from './env.mjs';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'correct-horse-battery';
const OWNER = { name: '정소유', email: 'own.perm@example.com' };
const REQ = { name: '최요청', email: 'req.perm@example.com' };
const PEER = { name: '한동료', email: 'peer.perm@example.com' };
const GONE = { name: '윤퇴사', email: 'gone.perm@example.com' };
const OUT = { name: '구경꾼', email: 'out.perm@example.com' };
const PROJECT = '권한 E2E 프로젝트';
const ORPHAN = '주인 없는 프로젝트';

async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByTestId('me')).toBeVisible();
}

async function apiAs(email: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: E2E.baseUrl });
  expect((await ctx.post('/api/auth/sign-in/email', { data: { email, password: PASSWORD } })).ok()).toBe(true);
  return ctx;
}

async function newPage(browser: Browser, email: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await logIn(page, email);
  return page;
}

test.describe('members · access requests · visibility · admin owner', () => {
  let owner: Page;
  let req: Page;
  let pid = '';
  let orphanId = '';
  let adminApi: APIRequestContext;
  const ids: Record<string, string> = {};

  test.beforeAll(async ({ browser }) => {
    const anon = await playwrightRequest.newContext({ baseURL: E2E.baseUrl });
    for (const u of [{ name: '관리자2', email: E2E.admin2Email }, OWNER, REQ, PEER, GONE, OUT]) {
      await anon.post('/api/auth/sign-up/email', { data: { name: u.name, email: u.email, password: PASSWORD } });
    }
    await anon.dispose();
    adminApi = await apiAs(E2E.admin2Email);
    const users = (await (await adminApi.get('/api/admin/users')).json()).users as { id: string; email: string; status: string }[];
    for (const u of users) {
      ids[u.email] = u.id;
      if ([OWNER, REQ, PEER, GONE, OUT].some((x) => x.email === u.email) && u.status === 'pending') expect((await adminApi.post(`/api/admin/users/${u.id}/approve`)).ok()).toBe(true);
    }
    // Owner's project: an environment on the engine fixture site and one plain script.
    const o = await apiAs(OWNER.email);
    const p = await (await o.post('/api/projects', { data: { name: PROJECT, description: '권한 E2E' } })).json();
    pid = p.id;
    expect((await o.post(`/api/projects/${pid}/environments`, { data: { name: 'dev', baseUrl: E2E.fixtureUrl, makeDefault: true } })).ok()).toBe(true);
    const put = await o.put(`/api/projects/${pid}/scripts/smoke.yaml`, { data: { source: 'version: 1\nname: Smoke\ntarget:\n  baseUrl: ${env.BASE_URL}\nsteps:\n  - goto: /\n' } });
    expect(put.ok()).toBe(true);
    await o.dispose();
    owner = await newPage(browser, OWNER.email);
    req = await newPage(browser, REQ.email);
  });
  test.afterAll(async () => {
    await owner?.context().close();
    await req?.context().close();
    await adminApi?.dispose();
  });

  test('a viewer asks for runner access; the request shows as pending', async () => {
    await req.goto(`/projects/${pid}`);
    await expect(req.getByTestId('read-only')).toHaveText('보기 전용');
    await expect(req.getByTestId('my-role')).toHaveText('보기');
    await req.getByTestId('request-access').click();
    const dlg = req.getByTestId('request-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel(/^실행자/).check();
    await dlg.getByLabel('메모 (선택, 200자)').fill('배포 전 스모크를 돌리려고 합니다');
    await req.screenshot({ path: 'e2e-results/perm-1-request-dialog.png' });
    await req.getByTestId('request-send').click();
    await expect(req.getByTestId('request-pending')).toHaveText('실행자 권한 요청 중');
  });

  test('the owner approves it in settings → the requester becomes 실행 전용: can run, cannot edit', async () => {
    test.setTimeout(120_000);
    await owner.goto(`/projects/${pid}/settings`);
    const row = owner.locator(`[data-testid="request-row"][data-email="${REQ.email}"]`);
    await expect(row).toContainText('배포 전 스모크를 돌리려고 합니다');
    await expect(row.getByTestId('grant-role')).toHaveValue('runner');
    await owner.getByTestId('settings-visibility').scrollIntoViewIfNeeded();
    await owner.screenshot({ path: 'e2e-results/perm-2-owner-requests.png', fullPage: true });
    await row.getByTestId('request-approve').click();
    await expect(owner.getByTestId('request-row')).toHaveCount(0);
    await expect(owner.locator(`[data-testid="member-row"][data-email="${REQ.email}"] [data-testid="member-role"]`)).toHaveValue('runner');

    // The requester's open page follows the change feed: role badge and "실행 전용".
    await expect(req.getByTestId('my-role')).toHaveText('실행자', { timeout: 15_000 });
    await expect(req.getByTestId('read-only')).toHaveText('실행 전용');
    await expect(req.getByTestId('request-access')).toBeVisible(); // a runner may still ask for editor
    await req.goto(`/projects/${pid}/scripts/smoke.yaml`);
    await expect(req.getByTestId('detail-run')).toBeVisible();
    await expect(req.getByTestId('detail-edit')).toHaveCount(0);
    await expect(req.getByTestId('detail-delete')).toHaveCount(0);
    await req.getByTestId('detail-run').click();
    await expect(req.getByTestId('precheck-ok')).toBeVisible();
    await req.screenshot({ path: 'e2e-results/perm-3-runner-script.png' });
    await req.getByTestId('run-start').click();
    await expect(req).toHaveURL(/\/runs\/[^/]+$/);
    await expect(req.getByTestId('run-detail')).toHaveAttribute('data-status', 'passed', { timeout: 90_000 });
    // Settings stay read-only for a runner; schedules cannot be created.
    await req.goto(`/projects/${pid}/settings`);
    await expect(req.getByTestId('invite')).toHaveCount(0);
    await expect(req.getByTestId('visibility-current')).toHaveText('조직 공개');
    await expect(req.getByTestId('member-leave')).toBeVisible();
  });

  test('invite by search + check: checked people move up in check order with numbers', async () => {
    await owner.goto(`/projects/${pid}/settings`);
    const search = owner.locator('input[name="invite-search"]');
    const cand = (email: string) => owner.locator(`[data-testid="invite-candidate"][data-email="${email}"]`);
    await search.fill('req.perm');
    await expect(cand(REQ.email)).toContainText('이미 구성원');
    // Search, check, search again: the checked people stay on top in check order.
    await search.fill('peer');
    await cand(PEER.email).getByRole('checkbox').check();
    await search.fill('gone');
    await cand(GONE.email).getByRole('checkbox').check();
    const picked = owner.locator('[data-testid="invite-candidate"][data-picked="true"]');
    await expect(picked).toHaveCount(2);
    await expect(picked.nth(0)).toContainText('1');
    await expect(picked.nth(0)).toContainText(PEER.name);
    await expect(picked.nth(1)).toContainText('2');
    await expect(picked.nth(1)).toContainText(GONE.name);
    await owner.locator('select[name="invite-role"]').selectOption('viewer');
    await expect(owner.getByTestId('invite-submit')).toHaveText('2명 보기(으)로 초대');
    await owner.getByTestId('invite').scrollIntoViewIfNeeded();
    await owner.screenshot({ path: 'e2e-results/perm-4-invite-picked.png', fullPage: true });
    await owner.getByTestId('invite-submit').click();
    for (const u of [PEER, GONE]) await expect(owner.locator(`[data-testid="member-row"][data-email="${u.email}"] [data-testid="member-role"]`)).toHaveValue('viewer');
    // The work log records who did what.
    await owner.goto(`/projects/${pid}/activity`);
    await expect(owner.getByText(`구성원 초대: ${PEER.name} (보기)`)).toBeVisible();
    await expect(owner.getByText(`권한 요청 승인: ${REQ.name} → 실행자`)).toBeVisible();
  });

  test('switching to 구성원만 hides the project from a non-member, even one who has it open', async ({ browser }) => {
    const out = await newPage(browser, OUT.email);
    await out.goto('/?scope=all');
    await expect(out.locator('[data-testid="project-row"]', { hasText: PROJECT })).toBeVisible();
    await out.goto(`/projects/${pid}`);
    await expect(out.getByTestId('project-name')).toHaveText(PROJECT);

    await owner.goto(`/projects/${pid}/settings`);
    await owner.getByTestId('visibility-members').click();
    await expect(owner.getByTestId('visibility-members')).toHaveAttribute('aria-checked', 'true');
    await expect(owner.getByTestId('visibility-badge')).toHaveText('구성원만');
    await owner.screenshot({ path: 'e2e-results/perm-5-visibility.png' });

    // The open page loses access (server ends the feed with access_lost) → not found.
    await expect(out.getByText('프로젝트를 찾을 수 없습니다')).toBeVisible({ timeout: 15_000 });
    await out.screenshot({ path: 'e2e-results/perm-6-outsider-lost.png' });
    await out.goto('/?scope=all');
    await expect(out.getByTestId('me')).toBeVisible();
    await expect(out.getByText('프로젝트가 없습니다.')).toBeVisible();
    await expect(out.locator('[data-testid="project-row"]', { hasText: PROJECT })).toHaveCount(0);
    // An invited viewer still sees it.
    const peer = await newPage(browser, PEER.email);
    await peer.goto(`/projects/${pid}`);
    await expect(peer.getByTestId('project-name')).toHaveText(PROJECT);
    await expect(peer.getByTestId('visibility-badge')).toHaveText('구성원만');
    await peer.context().close();
    await out.context().close();
  });

  test('admin assigns a new owner to a project whose owners are all deactivated', async ({ browser }) => {
    const g = await apiAs(GONE.email);
    orphanId = (await (await g.post('/api/projects', { data: { name: ORPHAN } })).json()).id;
    expect((await g.put(`/api/projects/${orphanId}/members/${ids[PEER.email]}`, { data: { role: 'editor' } })).ok()).toBe(true);
    await g.dispose();
    expect((await adminApi.post(`/api/admin/users/${ids[GONE.email]}/deactivate`)).ok()).toBe(true);

    const admin = await newPage(browser, E2E.admin2Email);
    await admin.goto('/admin');
    const row = admin.locator(`[data-testid="ownerless-row"][data-project-id="${orphanId}"]`);
    await expect(row).toContainText(ORPHAN);
    await expect(row).toContainText(`${GONE.name} (${GONE.email})`);
    await expect(row.locator(`[data-testid="owner-candidate"][data-email="${PEER.email}"]`)).toContainText('편집자');
    await row.scrollIntoViewIfNeeded();
    await admin.screenshot({ path: 'e2e-results/perm-7-admin-ownerless.png', fullPage: true });
    await row.locator(`[data-testid="owner-candidate"][data-email="${PEER.email}"]`).getByTestId('owner-assign').click();
    await expect(admin.locator(`[data-testid="ownerless-row"][data-project-id="${orphanId}"]`)).toHaveCount(0);
    await admin.context().close();

    const peer = await newPage(browser, PEER.email);
    await peer.goto(`/projects/${orphanId}`);
    await expect(peer.getByTestId('my-role')).toHaveText('소유자');
    await peer.goto(`/projects/${orphanId}/activity`);
    await expect(peer.getByText(`관리자 소유자 지정: ${PEER.name}`)).toBeVisible();
    await peer.context().close();
  });
});
