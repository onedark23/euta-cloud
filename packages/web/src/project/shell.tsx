// Project screen (SPEC 계정 "웹 화면" 프로젝트): header + tabs — 현황 · 스크립트 · 실행 이력 · 예약 ·
// 테스트 세트 · 작업 로그 · 설정. Stays mounted across tabs so the change feed connection is kept.
import type { MeDto } from '@euta-cloud/shared';
import { ROLE_KO } from '../format';
import { Link, matchPath } from '../router';
import { Badge, Card, PageHeader, Tabs } from '../ui';
import { ActivityTab } from './activity';
import { ProjectProvider, useProject } from './context';
import { OverviewTab } from './overview';
import { RunDetail } from './run-detail';
import { RunsTab } from './runs';
import { SchedulesTab } from './schedules';
import { ScriptDetail } from './script-detail';
import { RequestAccessButton } from './members';
import { ScriptsTab } from './scripts';
import { SettingsTab } from './settings';
import { SuitesTab } from './suites';

const TABS: { key: string; label: string; sub: string }[] = [
  { key: 'overview', label: '현황', sub: '' },
  { key: 'scripts', label: '스크립트', sub: '/scripts' },
  { key: 'runs', label: '실행 이력', sub: '/runs' },
  { key: 'schedules', label: '예약', sub: '/schedules' },
  { key: 'suites', label: '테스트 세트', sub: '/suites' },
  { key: 'activity', label: '작업 로그', sub: '/activity' },
  { key: 'settings', label: '설정', sub: '/settings' },
];

export const projectHref = (id: string, sub = '') => `/projects/${encodeURIComponent(id)}${sub}`;

function Body({ path }: { path: string }) {
  const { project } = useProject();
  const m = (p: string) => matchPath(`/projects/:id${p}`, path);
  let tab = 'overview';
  let content = <OverviewTab />;
  let r: Record<string, string> | null;
  if ((r = m('/scripts/*'))) {
    tab = 'scripts';
    content = <ScriptDetail key={r['*']} path={r['*']!} />;
  } else if (m('/scripts')) {
    tab = 'scripts';
    content = <ScriptsTab />;
  } else if ((r = m('/runs/:runId'))) {
    tab = 'runs';
    content = <RunDetail key={r.runId} runId={r.runId!} />;
  } else if (m('/runs')) {
    tab = 'runs';
    content = <RunsTab />;
  } else if (m('/schedules')) {
    tab = 'schedules';
    content = <SchedulesTab />;
  } else if (m('/suites')) {
    tab = 'suites';
    content = <SuitesTab />;
  } else if (m('/activity')) {
    tab = 'activity';
    content = <ActivityTab />;
  } else if (m('/settings')) {
    tab = 'settings';
    content = <SettingsTab />;
  }
  const readOnly = !project.can?.includes('script.edit');
  const runOnly = readOnly && !!project.can?.includes('run.execute');
  return (
    <section className="project" data-testid="project" data-project-id={project.id}>
      <PageHeader
        title={project.name}
        titleTestId="project-name"
        meta={
          <>
            <Badge data-testid="my-role">{ROLE_KO[project.myRole] ?? project.myRole}</Badge>
            {readOnly && (
              <Badge tone="warn" data-testid="read-only">
                {runOnly ? '실행 전용' : '보기 전용'}
              </Badge>
            )}
            {project.visibility === 'members' && <Badge data-testid="visibility-badge">구성원만</Badge>}
            <RequestAccessButton />
          </>
        }
      />
      {project.description && <p className="muted project-desc">{project.description}</p>}
      <Tabs asTablist items={TABS.map((t) => ({ key: t.key, label: t.label, href: projectHref(project.id, t.sub) }))} active={tab} />
      <div className="tab-body">{content}</div>
    </section>
  );
}

export function ProjectShell({ id, path, me }: { id: string; path: string; me: MeDto }) {
  return (
    <ProjectProvider
      key={id}
      id={id}
      me={me}
      fallback={({ error, notFound }) =>
        notFound ? (
          <Card className="narrow">
            <h1>프로젝트를 찾을 수 없습니다</h1>
            <p className="muted">삭제됐거나, 구성원만 볼 수 있는 프로젝트이거나, 주소가 잘못됐습니다.</p>
            <Link href="/">프로젝트 목록</Link>
          </Card>
        ) : error ? (
          <p className="error">{error}</p>
        ) : (
          <p className="muted">불러오는 중…</p>
        )
      }
    >
      <Body path={path} />
    </ProjectProvider>
  );
}
