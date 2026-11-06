// Layout + routes (SPEC 계정 "웹 화면"): 가입 · 로그인 · 승인 대기 · 장치 승인 · 관리자(가입 승인) ·
// 내 설정 > 토큰 · 프로젝트 목록 · 프로젝트(탭 — 현황 · 스크립트 · 실행 이력 · 실행 상세 · 예약 · 테스트 세트 ·
// 작업 로그 · 설정).
import { AdminPage } from './pages/admin';
import { LoginPage, PendingPage, SignupPage } from './pages/auth';
import { DevicePage } from './pages/device';
import { ProjectsPage } from './pages/projects';
import { TokensPage } from './pages/tokens';
import { ProjectShell } from './project/shell';
import { FolderKanban, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { Link, matchPath, useLocation } from './router';
import { RequireLogin, useServerConfig, useSession } from './session';
import { Button, Card, ThemeSelect } from './ui';

function Header() {
  const { me, signOut } = useSession();
  const config = useServerConfig();
  return (
    <header className="top">
      <Link href="/" className="brand">
        <img src="/favicon.svg" alt="" width={24} height={24} />
        euta cloud
      </Link>
      {me && (
        <nav className="main-nav">
          <Link href="/">
            <FolderKanban size={16} aria-hidden="true" />
            프로젝트
          </Link>
          <Link href="/settings/tokens">
            <KeyRound size={16} aria-hidden="true" />
            토큰
          </Link>
          {me.isAdmin && (
            <Link href="/admin">
              <ShieldCheck size={16} aria-hidden="true" />
              관리자
            </Link>
          )}
        </nav>
      )}
      <div className="account">
        {me && (
          <span className="me" data-testid="me">
            {me.name}
          </span>
        )}
        <ThemeSelect />
        {me && (
          <Button size="sm" icon={LogOut} onClick={() => void signOut()}>
            로그아웃
          </Button>
        )}
        {me === null && (
          <nav className="main-nav">
            <Link href="/login">로그인</Link>
            {config !== undefined && !config?.microsoftLogin && <Link href="/signup">가입</Link>}
          </nav>
        )}
      </div>
    </header>
  );
}

function Forbidden() {
  return (
    <Card className="narrow">
      <h1>권한 없음</h1>
      <p>관리자만 볼 수 있는 화면입니다.</p>
    </Card>
  );
}

function Routes() {
  const { path } = useLocation();
  switch (path) {
    case '/login':
      return <LoginPage />;
    case '/signup':
      return <SignupPage />;
    case '/pending':
      return <PendingPage />;
    case '/device':
      return <RequireLogin>{() => <DevicePage />}</RequireLogin>;
    case '/settings/tokens':
      return <RequireLogin>{() => <TokensPage />}</RequireLogin>;
    case '/admin':
      return <RequireLogin>{(me) => (me.isAdmin ? <AdminPage /> : <Forbidden />)}</RequireLogin>;
    case '/':
      return <RequireLogin>{() => <ProjectsPage />}</RequireLogin>;
    default: {
      const m = matchPath('/projects/:id/*', path) ?? matchPath('/projects/:id', path);
      if (m) return <RequireLogin>{(me) => <ProjectShell id={m.id!} path={path} me={me} />}</RequireLogin>;
      return (
        <Card className="narrow">
          <h1>페이지를 찾을 수 없습니다</h1>
          <Link href="/">프로젝트 목록</Link>
        </Card>
      );
    }
  }
}

export function App() {
  return (
    <>
      <Header />
      <main>
        <Routes />
      </main>
    </>
  );
}
