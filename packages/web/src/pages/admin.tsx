// 관리자 — 가입 승인(관리자 승인 모드). 비활성화 등 나머지 관리 화면은 C4 본 작업.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Check, Inbox } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '../ui';
import { OwnerlessProjects } from './admin-ownerless';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'pending' | 'deactivated';
  isAdmin: boolean;
  createdAt: string;
}

const STATUS_KO: Record<AdminUser['status'], string> = { active: '활성', pending: '승인 대기', deactivated: '비활성' };

export function AdminPage() {
  const [data, setData] = useState<{ users: AdminUser[]; approvalMode: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<{ users: AdminUser[]; approvalMode: boolean }>('GET', '/api/admin/users'));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (u: AdminUser) => {
    setBusy(u.id);
    setError(null);
    try {
      await api('POST', `/api/admin/users/${encodeURIComponent(u.id)}/approve`);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <Card>{error ? <p className="error">{error}</p> : <p className="muted">불러오는 중…</p>}</Card>;
  const pending = data.users.filter((u) => u.status === 'pending');
  const others = data.users.filter((u) => u.status !== 'pending');
  return (
    <Card>
      <h1>관리자 · 구성원</h1>
      <p className="muted">{data.approvalMode ? '관리자 승인 모드 — 가입한 사람은 여기서 승인해야 로그인할 수 있습니다.' : '메일 인증 모드 — 가입자는 인증 메일로 활성화됩니다.'}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h2>승인 대기 ({pending.length})</h2>
      {pending.length === 0 ? (
        <EmptyState icon={Inbox} title="승인 대기 중인 가입자가 없습니다." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>이름</th>
              <th>이메일</th>
              <th>가입</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pending.map((u) => (
              <tr key={u.id} data-testid="pending-row">
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{new Date(u.createdAt).toLocaleString('ko-KR')}</td>
                <td>
                  <Button size="sm" icon={Check} disabled={busy === u.id} onClick={() => approve(u)}>
                    승인
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>구성원 ({others.length})</h2>
      <table>
        <thead>
          <tr>
            <th>이름</th>
            <th>이메일</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {others.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name} {u.isAdmin && <Badge>관리자</Badge>}
              </td>
              <td>{u.email}</td>
              <td>
                <Badge tone={u.status === 'active' ? 'ok' : u.status === 'pending' ? 'warn' : 'idle'}>{STATUS_KO[u.status]}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <OwnerlessProjects />
    </Card>
  );
}
