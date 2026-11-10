// 앱 내려받기 (SPEC_앱-배포-업데이트 "업데이트 배포"): the installer for the visitor's OS first (big
// button), other platforms, release notes, the kept versions (newest 3) and first-install warnings per
// platform. Administrators also see every release incl. drafts with publish / delete (upload is the
// app repo's `pnpm release:upload`) and, when the server mirrors GitHub releases (ADR-048), the last
// import with [지금 가져오기].
import type { AdminAppReleaseDto, AdminAppReleasesDto, AppMirrorStatusDto, AppPlatform, AppReleaseDto, AppReleaseFileDto, AppReleasesDto } from '@euta-cloud/shared';
import { Download, Laptop, RefreshCw, Send, Trash } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorText } from '../api';
import { fmtTime } from '../format';
import { useSession } from '../session';
import { Badge, Button, buttonClass, Card, EmptyState, PageHeader, Tooltip } from '../ui';
import { detectVisitorOs, installerLabel, PLATFORM_LABEL, type VisitorOs } from './download-os';
import './download.css';

const CHANNEL = 'alpha';
const CHANNEL_LABEL: Record<string, string> = { alpha: '알파', beta: '베타', stable: '정식' };
const ORDER: Record<string, number> = { 'mac-arm64': 0, 'mac-x64': 1, 'win-x64': 2, 'win-arm64': 3, 'linux-x64': 4, 'linux-arm64': 5 };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ko-KR') : '-');
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function installers(r: AppReleaseDto): AppReleaseFileDto[] {
  return r.files.filter((f) => f.kind === 'installer').sort((a, b) => (ORDER[`${a.platform}-${a.arch}`] ?? 9) - (ORDER[`${b.platform}-${b.arch}`] ?? 9));
}

function DownloadLink({ file, primary, big }: { file: AppReleaseFileDto; primary?: boolean; big?: boolean }) {
  const label = installerLabel(file.platform, file.arch);
  return (
    <Tooltip label={`${file.name} (${mb(file.size)})`}>
      <a className={buttonClass(primary ? 'primary' : 'secondary', big ? 'md' : 'sm', big ? 'dl-big' : undefined)} href={file.url} download={file.name} data-testid="download-link">
        <Download size={big ? 20 : 14} strokeWidth={2} aria-hidden="true" />
        {big ? `${label} 내려받기` : label}
      </a>
    </Tooltip>
  );
}

/** The visitor's platform first: on a Mac both chips (the browser usually cannot tell them apart). */
function pickHero(files: AppReleaseFileDto[], os: VisitorOs): AppReleaseFileDto[] {
  if (!os.platform) return [];
  const mine = files.filter((f) => f.platform === os.platform);
  if (os.platform !== 'mac') {
    const exact = mine.find((f) => f.arch === os.arch);
    return exact ? [exact] : mine.slice(0, 1);
  }
  const first = os.arch ?? 'arm64';
  return [...mine].sort((a, b) => (a.arch === first ? -1 : b.arch === first ? 1 : 0));
}

const HELP: Record<AppPlatform, { title: string; steps: ReactNode[] }> = {
  mac: {
    title: 'macOS — "확인되지 않은 개발자" 경고가 뜰 때',
    steps: [
      <>내려받은 <code>.dmg</code> 를 열고 euta 아이콘을 [응용 프로그램] 폴더로 끌어 놓습니다.</>,
      <>처음 열 때 "Apple은 euta에 악성 코드가 없음을 확인할 수 없습니다" 경고가 뜨면 [완료]를 눌러 닫습니다.</>,
      <>
        <strong>시스템 설정 › 개인정보 보호 및 보안</strong> 을 열고 아래쪽 "euta이(가) 차단되었습니다" 옆의 <strong>[그래도 열기]</strong> 를 누른 뒤, 다시 뜨는 창에서 [열기]를
        누릅니다(암호 또는 Touch ID 확인).
      </>,
      <>한 번 열고 나면 다음부터는 그냥 열립니다. 새 버전이 나오면 앱이 알려 주고, 이 화면에서 새 dmg 를 받아 같은 방법으로 덮어 설치합니다.</>,
    ],
  },
  win: {
    title: 'Windows — "Windows의 PC 보호" (SmartScreen) 창이 뜰 때',
    steps: [
      <>내려받은 <code>.exe</code> 를 실행합니다.</>,
      <>
        파란 "Windows의 PC 보호" 창이 뜨면 <strong>[추가 정보]</strong> 를 누르고, 나타나는 <strong>[실행]</strong> 을 누릅니다.
      </>,
      <>설치가 끝나면 시작 메뉴에서 euta 를 엽니다. 다음 버전부터는 앱이 뒤에서 내려받고 "다시 시작해서 업데이트" 를 알려 줍니다.</>,
    ],
  },
  linux: {
    title: 'Linux — AppImage 에 실행 권한 주기',
    steps: [
      <>
        내려받은 파일에 실행 권한을 줍니다: <code>chmod +x euta-*.AppImage</code> (파일 관리자 › 속성 › "프로그램으로 실행 허용" 도 같습니다).
      </>,
      <>
        더블클릭하거나 <code>./euta-*.AppImage</code> 로 실행합니다. Ubuntu 22.04 이후에서 실행되지 않으면 <code>sudo apt install libfuse2</code> 를 먼저 합니다.
      </>,
      <>X11 데스크톱 기준입니다(Wayland 에서는 화면 녹화 입력이 동작하지 않습니다). 다음 버전부터는 앱이 스스로 업데이트합니다.</>,
    ],
  },
};

function InstallHelp({ initial }: { initial: AppPlatform }) {
  const [shown, setShown] = useState<AppPlatform>(initial);
  useEffect(() => setShown(initial), [initial]);
  const help = HELP[shown];
  return (
    <Card data-testid="install-help">
      <h2>처음 설치할 때</h2>
      <p className="muted">euta 앱은 아직 운영체제 서명 전이라 처음 한 번 경고가 뜹니다. 아래 순서대로 넘기면 됩니다.</p>
      <div className="row dl-switch" role="group" aria-label="운영체제">
        {(['mac', 'win', 'linux'] as const).map((p) => (
          <Button key={p} icon={Laptop} active={p === shown} aria-pressed={p === shown} onClick={() => setShown(p)}>
            {PLATFORM_LABEL[p]}
          </Button>
        ))}
      </div>
      <h3>{help.title}</h3>
      <ol className="dl-steps">
        {help.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </Card>
  );
}

function mirrorResultText(run: NonNullable<AppMirrorStatusDto['lastRun']>): string {
  switch (run.result) {
    case 'published':
      return `${run.version} 가져와 게시함`;
    case 'already':
      return `새 버전 없음 (GitHub 최신 ${run.version})`;
    case 'none':
      return 'GitHub 에 게시된 릴리스 없음';
    default:
      return `실패: ${run.message ?? '알 수 없는 오류'}`;
  }
}

/** GitHub release mirror (ADR-048): last import and [지금 가져오기]. */
function MirrorStatus({ mirror, busy, onSync }: { mirror: AppMirrorStatusDto; busy: boolean; onSync: () => void }) {
  const run = mirror.lastRun;
  const running = busy || mirror.running;
  return (
    <div className="row dl-mirror" data-testid="mirror-status">
      <span>
        GitHub 에서 가져오기: <strong>{mirror.repo}</strong>
        {' · '}
        {running ? (
          '가져오는 중…'
        ) : run ? (
          <>
            마지막 {fmtTime(run.at)} — <span className={run.result === 'error' ? 'error' : undefined}>{mirrorResultText(run)}</span>
          </>
        ) : (
          '아직 가져오지 않음 (서버 시작 1분 뒤 · 10분마다)'
        )}
      </span>
      <Tooltip label="GitHub 최신 릴리스를 지금 확인합니다 — 새 버전이면 가져와 게시">
        <Button size="sm" icon={RefreshCw} disabled={running} onClick={onSync}>
          지금 가져오기
        </Button>
      </Tooltip>
    </div>
  );
}

function AdminReleases() {
  const [rows, setRows] = useState<AdminAppReleaseDto[] | null>(null);
  const [mirror, setMirror] = useState<AppMirrorStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<AdminAppReleasesDto>('GET', '/api/admin/app-releases');
      setRows(r.releases);
      setMirror(r.mirror);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // A scheduled import is running on the server → look again shortly.
  useEffect(() => {
    if (!mirror?.running || busy) return;
    const t = setTimeout(() => void load(), 3000);
    return () => clearTimeout(t);
  }, [mirror, busy, load]);

  const syncMirror = async () => {
    setBusy('mirror');
    setError(null);
    try {
      setMirror(await api<AppMirrorStatusDto>('POST', '/api/admin/app-releases/mirror'));
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const act = async (r: AdminAppReleaseDto, what: 'publish' | 'delete') => {
    const q =
      what === 'publish'
        ? `${r.version} 을(를) 게시할까요? 바로 앱들이 이 버전으로 업데이트를 받기 시작하고, ${CHANNEL_LABEL[r.channel] ?? r.channel} 채널의 게시본은 최근 3개만 남습니다.`
        : `초안 ${r.version} 을(를) 지울까요? 올린 파일도 함께 지워집니다.`;
    if (!window.confirm(q)) return;
    setBusy(r.version);
    setError(null);
    try {
      if (what === 'publish') await api('POST', `/api/admin/app-releases/${encodeURIComponent(r.version)}/publish`);
      else await api('DELETE', `/api/admin/app-releases/${encodeURIComponent(r.version)}`);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-testid="admin-releases">
      <h2>릴리스 관리 (관리자)</h2>
      <p className="muted">
        {mirror
          ? '새 버전은 GitHub 릴리스에서 자동으로 가져와 게시합니다(시작 1분 뒤 · 주기마다). 직접 올리기(초안)는 앱 레포의 '
          : '올리기는 앱 레포에서 '}
        <code>pnpm release:upload</code> (관리자 계정의 읽기·쓰기 토큰)로 합니다. 초안을 확인한 뒤 여기서 게시하거나 지웁니다.
      </p>
      {mirror && <MirrorStatus mirror={mirror} busy={busy === 'mirror'} onSync={() => void syncMirror()} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="muted">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Download} title="올린 릴리스가 없습니다." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>버전</th>
                <th>채널</th>
                <th>상태</th>
                <th>파일</th>
                <th>만든 날</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hasMeta = r.files.some((f) => f.kind === 'meta');
                return (
                  <tr key={r.version} data-testid="admin-release-row">
                    <td>
                      <strong>{r.version}</strong>
                    </td>
                    <td>{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                    <td>{r.status === 'published' ? <Badge tone="ok">게시 {day(r.publishedAt)}</Badge> : <Badge tone="warn">초안</Badge>}</td>
                    <td>
                      {r.files.length}개 · {mb(r.files.reduce((n, f) => n + f.size, 0))}
                      {r.status === 'draft' && !hasMeta && <div className="small muted">latest*.yml 이 아직 없음</div>}
                    </td>
                    <td>{day(r.createdAt)}</td>
                    <td>
                      {r.status === 'draft' && (
                        <div className="row nowrap">
                          <Tooltip label={hasMeta ? '앱들이 이 버전으로 업데이트를 받기 시작합니다' : '업데이트 정보(latest*.yml)를 먼저 올려야 합니다'}>
                            <Button size="sm" icon={Send} disabled={!hasMeta || busy !== null} onClick={() => void act(r, 'publish')}>
                              게시
                            </Button>
                          </Tooltip>
                          <Tooltip label="초안과 올린 파일을 지웁니다">
                            <Button size="sm" variant="danger" icon={Trash} disabled={busy !== null} onClick={() => void act(r, 'delete')}>
                              삭제
                            </Button>
                          </Tooltip>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function DownloadPage() {
  const { me } = useSession();
  const [data, setData] = useState<AppReleasesDto | null>(null);
  const [os, setOs] = useState<VisitorOs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AppReleasesDto>('GET', `/api/app/releases?channel=${CHANNEL}`).then(setData, (e) => setError(errorText(e)));
    void detectVisitorOs().then(setOs);
  }, []);

  const latest = data?.releases[0];
  const files = latest ? installers(latest) : [];
  const hero = os ? pickHero(files, os) : [];
  const others = files.filter((f) => !hero.includes(f));

  return (
    <div className="stack dl-page">
      <PageHeader
        title="앱 내려받기"
        meta={
          latest && (
            <>
              <Badge tone="neutral">{CHANNEL_LABEL[CHANNEL]}</Badge>
              <span className="muted" data-testid="latest-version">
                최신 {latest.version} · {day(latest.publishedAt)}
              </span>
            </>
          )
        }
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && !latest && (
        <Card>
          <EmptyState icon={Download} title="아직 게시된 앱 버전이 없습니다." description="관리자가 첫 버전을 게시하면 여기에서 내려받을 수 있습니다." testId="no-release" />
        </Card>
      )}
      {latest && os && (
        <Card className="dl-hero" data-testid="dl-hero">
          {os.platform ? (
            <>
              <h2>
                이 컴퓨터({PLATFORM_LABEL[os.platform]})용 설치 파일
              </h2>
              {hero.length === 0 ? (
                <p className="muted">이 버전에는 {PLATFORM_LABEL[os.platform]}용 설치 파일이 없습니다. 아래 다른 플랫폼을 보세요.</p>
              ) : (
                <div className="dl-hero-buttons">
                  {hero.map((f, i) => (
                    <div key={f.name} className="dl-hero-item">
                      <DownloadLink file={f} primary={i === 0} big />
                      <span className="small muted mono-name">
                        {f.name} · {mb(f.size)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {os.platform === 'mac' && hero.length > 1 && (
                <p className="small muted" data-testid="mac-chip-hint">
                  어느 쪽인지 모르겠으면: 화면 왼쪽 위 Apple 메뉴 › 이 Mac에 관하여 — "칩" 이 Apple M1·M2·M3… 이면 <strong>Apple 칩</strong>, "프로세서" 가 Intel 이면 <strong>Intel</strong>.
                </p>
              )}
            </>
          ) : (
            <p className="muted">이 기기에서는 설치할 수 없습니다 — PC(macOS · Windows · Linux)에서 이 화면을 여세요.</p>
          )}
        </Card>
      )}
      {latest && others.length > 0 && (
        <Card data-testid="other-platforms">
          <h2>다른 플랫폼</h2>
          <div className="row dl-others">
            {others.map((f) => (
              <DownloadLink key={f.name} file={f} />
            ))}
          </div>
        </Card>
      )}
      {latest && (
        <Card data-testid="release-notes">
          <h2>바뀐 것 — {latest.version}</h2>
          <p className="pre">{latest.notes || '릴리스 노트가 없습니다.'}</p>
        </Card>
      )}
      {latest && os && <InstallHelp initial={os.platform ?? 'mac'} />}
      {data && data.releases.length > 0 && (
        <Card data-testid="versions">
          <h2>보관 중인 버전 (최근 {data.releases.length}개)</h2>
          <p className="muted">게시본은 최근 3개만 남습니다. 새 버전에 문제가 있으면 이전 버전을 받아 다시 설치할 수 있습니다.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>버전</th>
                  <th>게시일</th>
                  <th>바뀐 것</th>
                  <th>내려받기</th>
                </tr>
              </thead>
              <tbody>
                {data.releases.map((r, i) => (
                  <tr key={r.version} data-testid="version-row">
                    <td className="nowrap">
                      <strong>{r.version}</strong> {i === 0 && <Badge tone="neutral">최신</Badge>}
                    </td>
                    <td className="nowrap">{day(r.publishedAt)}</td>
                    <td className="pre dl-notes">{r.notes}</td>
                    <td>
                      <div className="row dl-others">
                        {installers(r).map((f) => (
                          <DownloadLink key={f.name} file={f} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {me?.isAdmin && <AdminReleases />}
    </div>
  );
}
