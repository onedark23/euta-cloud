// 장치 승인 (/device) — 로컬 앱 로그인(ADR-023 장치 인가). 앱이 `verification_uri_complete`
// (`/device?user_code=…`)를 연다. 순서: 로그인 확인(RequireLogin) → GET /api/auth/device?user_code=
// (코드를 이 계정에 묶음 — 안 하면 승인 거절) → POST /api/auth/device/approve 또는 /deny.
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorText } from '../api';
import { navigate, useLocation } from '../router';
import { ArrowRight, Check, X } from 'lucide-react';
import { Button, Card, TextField } from '../ui';

type State =
  | { kind: 'loading' }
  | { kind: 'pending' }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'processed' }
  | { kind: 'error'; message: string };

function codeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'expired_token') return '코드가 만료되었습니다(15분). 앱에서 로그인을 다시 시작하세요.';
    if (e.code === 'invalid_request') return '코드를 찾을 수 없거나 이미 처리되었습니다. 앱에 표시된 코드를 확인하세요.';
    if (e.code === 'access_denied') return '다른 계정에서 연 코드입니다. 앱에서 로그인을 다시 시작하세요.';
  }
  return errorText(e);
}

/** "ABCD1234" → "ABCD-1234" for reading; the server ignores dashes. */
const pretty = (code: string) => (/^[A-Z0-9]{8}$/i.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export function DevicePage() {
  const loc = useLocation();
  const userCode = (loc.query.get('user_code') ?? '').trim();
  return userCode ? <DeviceApproval key={userCode} userCode={userCode} /> : <DeviceCodeForm />;
}

function DeviceCodeForm() {
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) navigate(`/device?user_code=${encodeURIComponent(code.trim().toUpperCase())}`);
  };
  return (
    <Card className="narrow">
      <h1>장치 승인</h1>
      <p>로컬 앱에 표시된 코드를 입력하세요.</p>
      <form onSubmit={submit}>
        <TextField label="코드" name="user_code" autoComplete="off" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-1234" />
        <Button type="submit" variant="primary" icon={ArrowRight}>
          다음
        </Button>
      </form>
    </Card>
  );
}

function DeviceApproval({ userCode }: { userCode: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ user_code: string; status: string }>('GET', `/api/auth/device?user_code=${encodeURIComponent(userCode)}`).then(
      (r) => alive && setState(r.status === 'pending' ? { kind: 'pending' } : { kind: 'processed' }),
      (e) => alive && setState({ kind: 'error', message: codeError(e) }),
    );
    return () => {
      alive = false;
    };
  }, [userCode]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await api('POST', `/api/auth/device/${approve ? 'approve' : 'deny'}`, { userCode });
      setState({ kind: approve ? 'approved' : 'denied' });
    } catch (e) {
      setState({ kind: 'error', message: codeError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="narrow">
      <h1>장치 승인</h1>
      <p className="muted">로컬 앱(euta)이 이 계정으로 로그인하려고 합니다. 앱에 보이는 코드와 같은지 확인하세요.</p>
      <p className="user-code" data-testid="user-code">
        {pretty(userCode)}
      </p>
      {state.kind === 'loading' && <p className="muted">코드 확인 중…</p>}
      {state.kind === 'pending' && (
        <div className="row">
          <Button variant="primary" icon={Check} disabled={busy} onClick={() => decide(true)}>
            승인
          </Button>
          <Button icon={X} disabled={busy} onClick={() => decide(false)}>
            거부
          </Button>
        </div>
      )}
      {state.kind === 'approved' && (
        <p className="ok" role="status">
          승인했습니다. 앱으로 돌아가면 로그인이 끝납니다. 이 창은 닫아도 됩니다.
        </p>
      )}
      {state.kind === 'denied' && (
        <p className="ok" role="status">
          거부했습니다. 앱은 로그인되지 않습니다.
        </p>
      )}
      {state.kind === 'processed' && <p className="muted">이미 처리된 코드입니다. 다시 로그인하려면 앱에서 새로 시작하세요.</p>}
      {state.kind === 'error' && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
    </Card>
  );
}
