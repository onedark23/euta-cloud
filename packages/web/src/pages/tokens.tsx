// 내 설정 > 토큰 (SPEC 개인 토큰): 발급(원문은 발급 직후 1번만) · 목록 · 폐기. 로그인 세션 전용 API.
import { TOKEN_DEFAULT_EXPIRY_DAYS, TOKEN_EXPIRY_DAYS, type TokenDto, type TokenPermission } from '@euta-cloud/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorText } from '../api';
import { Check, Copy, KeyRound, Plus, Trash } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Select, TextField } from '../ui';

const PERMISSION_KO: Record<TokenPermission, string> = { read: '읽기', read_write: '읽기·쓰기' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ko-KR') : '-');
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR') : '사용 안 함');

export function TokensPage() {
  const [tokens, setTokens] = useState<TokenDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [permission, setPermission] = useState<TokenPermission>('read');
  const [days, setDays] = useState<number>(TOKEN_DEFAULT_EXPIRY_DAYS);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTokens((await api<{ tokens: TokenDto[] }>('GET', '/api/me/tokens')).tokens);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await api<TokenDto & { token: string }>('POST', '/api/me/tokens', { name: name.trim(), permission, expiresInDays: days });
      setIssued({ name: r.name, token: r.token });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'TOKEN_LIMIT' ? '활성 토큰은 10개까지입니다. 쓰지 않는 토큰을 먼저 폐기하세요.' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: TokenDto) => {
    if (!window.confirm(`토큰 "${t.name}" 을(를) 폐기할까요? 이 토큰을 쓰는 MCP 연결은 바로 끊깁니다.`)) return;
    try {
      await api('DELETE', `/api/me/tokens/${encodeURIComponent(t.id)}`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const soon = tokens?.filter((t) => t.expiringSoon) ?? [];
  return (
    <Card>
      <h1>내 설정 · 개인 토큰</h1>
      <p className="muted">MCP(Claude Code 등)에서 euta cloud 에 접속할 때 쓰는 토큰입니다. 토큰 권한과 프로젝트 역할 중 좁은 쪽이 적용됩니다.</p>
      {soon.length > 0 && (
        <p className="warn" role="status">
          곧 만료되는 토큰: {soon.map((t) => t.name).join(', ')}
        </p>
      )}

      {issued && (
        <div className="issued" data-testid="issued-token">
          <p>
            <strong>토큰 "{issued.name}" 을(를) 발급했습니다.</strong> 지금만 볼 수 있습니다 — 이 화면을 벗어나면 다시 볼 수 없으니 바로 복사해 두세요.
          </p>
          <div className="row">
            <code className="token-value">{issued.token}</code>
            <Button variant="primary" icon={copied ? Check : Copy} onClick={copy}>
              {copied ? '복사됨' : '복사'}
            </Button>
          </div>
          <Button icon={Check} onClick={() => setIssued(null)}>
            확인했습니다
          </Button>
        </div>
      )}

      <h2>새 토큰</h2>
      <form className="inline" onSubmit={create}>
        <TextField label="이름" name="token-name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: my-claude" />
        <Select label="권한" name="permission" value={permission} onChange={(e) => setPermission(e.target.value as TokenPermission)}>
          <option value="read">읽기</option>
          <option value="read_write">읽기·쓰기</option>
        </Select>
        <Select label="만료" name="expires" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {TOKEN_EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {d}일
            </option>
          ))}
        </Select>
        <Button type="submit" icon={Plus} disabled={busy || !name.trim()}>
          발급
        </Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h2>내 토큰</h2>
      {tokens === null ? (
        <p className="muted">불러오는 중…</p>
      ) : tokens.length === 0 ? (
        <EmptyState icon={KeyRound} title="발급한 토큰이 없습니다." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>이름</th>
              <th>권한</th>
              <th>앞자리</th>
              <th>만든 날</th>
              <th>만료일</th>
              <th>마지막 사용</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} data-testid="token-row">
                <td>{t.name}</td>
                <td>{PERMISSION_KO[t.permission]}</td>
                <td>
                  <code>{t.start ?? ''}…</code>
                </td>
                <td>{day(t.createdAt)}</td>
                <td>
                  {day(t.expiresAt)} {t.expiringSoon && <Badge tone="warn">곧 만료</Badge>}
                </td>
                <td>{time(t.lastUsedAt)}</td>
                <td>
                  <Button variant="danger" size="sm" icon={Trash} onClick={() => revoke(t)}>
                    폐기
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
