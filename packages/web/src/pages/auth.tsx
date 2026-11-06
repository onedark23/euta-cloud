// 로그인 · 가입 · 승인 대기 (SPEC 계정 "가입·로그인"). Microsoft 로그인이 켜져 있으면 회사 계정이 주 입구이고
// 이메일 새 가입은 닫힌다(기존 이메일 회원 로그인만 접어서). 꺼져 있으면 이메일 가입 + 관리자 승인(SMTP 없음).
import { PASSWORD_MAX, PASSWORD_MIN } from '@euta-cloud/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorText } from '../api';
import { Link, navigate, safeNext, useLocation } from '../router';
import { useServerConfig, useSession } from '../session';
import { Building2, ChevronDown, ChevronRight, LogIn, UserPlus } from 'lucide-react';
import { Button, Card, TextField } from '../ui';

function loginError(e: unknown): string | 'pending' {
  if (!(e instanceof ApiError)) return errorText(e);
  if (e.code === 'PENDING_APPROVAL') return 'pending';
  if (e.code === 'ACCOUNT_DEACTIVATED') return '비활성화된 계정입니다. 관리자에게 문의하세요.';
  if (e.code === 'ACCOUNT_LOCKED') return '로그인을 5번 연속 실패해 10분 동안 잠겼습니다. 잠시 뒤 다시 시도하세요.';
  if (e.code === 'EMAIL_NOT_VERIFIED') return '메일 인증이 필요합니다. 인증 메일을 다시 보냈으니 받은 편지함을 확인하세요.';
  if (e.status === 401) return '이메일 또는 비밀번호가 맞지 않습니다.';
  if (e.status === 429) return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.';
  return e.message || '로그인하지 못했습니다.';
}

/** Why Microsoft sent the person back (`?error=` from Better Auth: our code, its own code, or its mangled message). */
function microsoftError(code: string): string {
  if (code === 'ACCOUNT_DEACTIVATED') return '비활성화된 계정입니다. 관리자에게 문의하세요.';
  if (code === 'access_denied') return 'Microsoft 로그인을 취소했습니다.';
  if (code === 'unable_to_get_user_info' || code === 'EMAIL_DOMAIN_NOT_ALLOWED' || code.startsWith('sign-up_is_limited_to'))
    return '회사 계정으로만 로그인할 수 있습니다. 회사 Microsoft 계정(Office 365)으로 다시 로그인하세요.';
  return 'Microsoft 로그인에 실패했습니다. 다시 시도하세요.';
}

export function LoginPage() {
  const { me, refresh } = useSession();
  const config = useServerConfig();
  const loc = useLocation();
  const next = safeNext(loc.query.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [msError, setMsError] = useState<string | null>(null);
  const notice = loc.query.get('notice');
  const backError = loc.query.get('error');
  const microsoft = config?.microsoftLogin === true;

  useEffect(() => {
    if (me) navigate(next, { replace: true });
  }, [me, next]);

  useEffect(() => {
    if (backError === 'PENDING_APPROVAL') navigate('/pending', { replace: true });
  }, [backError]);

  const microsoftLogin = async () => {
    setBusy(true);
    setMsError(null);
    try {
      const back = `/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;
      const r = await api<{ url: string }>('POST', '/api/auth/sign-in/social', { provider: 'microsoft', callbackURL: next, errorCallbackURL: back, disableRedirect: true });
      window.location.assign(r.url);
    } catch (err) {
      setMsError(errorText(err));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/sign-in/email', { email, password });
      await refresh(); // the effect above moves on to `next`
    } catch (err) {
      const msg = loginError(err);
      if (msg === 'pending') navigate('/pending');
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const emailForm = (
    <form onSubmit={submit} id="email-login">
      <TextField label="이메일" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label="비밀번호" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant={microsoft ? 'secondary' : 'primary'} icon={LogIn} disabled={busy}>
        로그인
      </Button>
    </form>
  );

  // Wait for the config so the page does not flash the email form before switching to Microsoft.
  if (config === undefined) return <p className="muted">불러오는 중…</p>;

  return (
    <Card className="narrow">
      <h1>로그인</h1>
      {notice === 'signed-up' && <p className="ok">가입했습니다. 로그인하세요.</p>}
      {next.startsWith('/device') && <p className="muted">로컬 앱 로그인을 승인하려면 먼저 로그인하세요.</p>}
      {microsoft ? (
        <>
          <Button variant="primary" icon={Building2} className="btn-block" disabled={busy} onClick={() => void microsoftLogin()}>
            회사 계정(Office 365)으로 로그인
          </Button>
          <p className="muted">처음 오셨다면 회사 계정으로 로그인하면 바로 사용할 수 있습니다.</p>
          {(msError || (backError && backError !== 'PENDING_APPROVAL')) && (
            <p className="error" role="alert">
              {msError ?? microsoftError(backError!)}
            </p>
          )}
          <div className="auth-alt">
            <Button icon={emailOpen ? ChevronDown : ChevronRight} aria-expanded={emailOpen} aria-controls="email-login" onClick={() => setEmailOpen((o) => !o)}>
              기존 이메일 회원 로그인
            </Button>
            {emailOpen && emailForm}
          </div>
        </>
      ) : (
        <>
          {emailForm}
          <p className="muted">
            계정이 없나요? <Link href={`/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>가입하기</Link>
          </p>
        </>
      )}
    </Card>
  );
}

function signupError(e: unknown, domains: string[]): string {
  if (!(e instanceof ApiError)) return errorText(e);
  if (e.code === 'EMAIL_DOMAIN_NOT_ALLOWED') return `${domains.map((d) => '@' + d).join(', ') || '회사'} 주소로만 가입할 수 있습니다.`;
  if (/ALREADY_EXISTS/.test(e.code)) return '이미 가입된 이메일입니다. 로그인하세요.';
  if (e.code === 'PASSWORD_TOO_SHORT') return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  if (e.code === 'PASSWORD_TOO_LONG') return `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.`;
  return e.message || '가입하지 못했습니다.';
}

export function SignupPage() {
  const loc = useLocation();
  const config = useServerConfig();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mailSent, setMailSent] = useState(false);
  const [busy, setBusy] = useState(false);

  // Microsoft login on → email sign-up is closed; the first company login is the sign-up.
  useEffect(() => {
    const next = loc.query.get('next');
    if (config?.microsoftLogin) navigate(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true });
  }, [config, loc.href]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN) return setError(`비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
    setBusy(true);
    try {
      const r = await api<{ user: { status?: string } }>('POST', '/api/auth/sign-up/email', { name, email, password });
      if (config?.signUpMode === 'email') setMailSent(true);
      // Approval mode: everyone but configured administrators waits for approval.
      else if (r.user.status === 'active') navigate(`/login?notice=signed-up${loc.query.get('next') ? `&next=${encodeURIComponent(loc.query.get('next')!)}` : ''}`);
      else navigate('/pending');
    } catch (err) {
      setError(signupError(err, config?.allowedEmailDomains ?? []));
    } finally {
      setBusy(false);
    }
  };

  if (mailSent) {
    return (
      <Card className="narrow">
        <h1>메일을 확인하세요</h1>
        <p>
          <strong>{email}</strong> 로 인증 메일을 보냈습니다. 메일의 링크를 누른 뒤(24시간 유효) 로그인하세요.
        </p>
        <Link href="/login">로그인으로</Link>
      </Card>
    );
  }

  const domains = config?.allowedEmailDomains ?? [];
  return (
    <Card className="narrow">
      <h1>가입</h1>
      {domains.length > 0 && <p className="muted">{domains.map((d) => '@' + d).join(', ')} 주소로 가입할 수 있습니다.</p>}
      {config?.signUpMode === 'approval' && <p className="muted">가입하면 관리자가 승인한 뒤에 로그인할 수 있습니다.</p>}
      <form onSubmit={submit}>
        <TextField label="이름" name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="이메일" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField
          label="비밀번호"
          help={`${PASSWORD_MIN}자 이상`}
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" icon={UserPlus} disabled={busy}>
          가입
        </Button>
      </form>
      <p className="muted">
        이미 계정이 있나요? <Link href="/login">로그인</Link>
      </p>
    </Card>
  );
}

export function PendingPage() {
  return (
    <Card className="narrow">
      <h1>승인 대기 중</h1>
      <p>가입 신청을 받았습니다. 관리자가 승인하면 로그인할 수 있습니다.</p>
      <p className="muted">승인이 늦어지면 관리자에게 알려 주세요.</p>
      <Link href="/login">로그인으로</Link>
    </Card>
  );
}
