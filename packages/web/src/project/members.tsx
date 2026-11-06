// 설정 > 공개 범위 · 권한 요청 · 구성원 (stage 15, SPEC 계정 "만들기·공개·구성원"). Owner-only actions are
// hidden for everyone else (the server checks again). Invite = search + check: checked people move to the
// top in check order with their number and are invited in that order (CLAUDE.md UI ground rules).
import {
  REQUESTABLE_ROLES,
  type AccessRequestDto,
  type MemberDto,
  type MemberRole,
  type ProjectVisibility,
  type RequestableRole,
  type UserSummaryDto,
} from "@euta-cloud/shared";
import {
  Check,
  Crown,
  DoorOpen,
  Globe,
  Hand,
  Lock,
  Send,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, errorText } from "../api";
import { fmtTime, ROLE_KO } from "../format";
import { navigate } from "../router";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  Select,
  TextArea,
  TextField,
  Tooltip,
} from "../ui";
import { useProject, useProjectEvents } from "./context";

const ROLES: MemberRole[] = ["owner", "editor", "runner", "viewer"];
const ROLE_HELP: Record<MemberRole, string> = {
  owner: "모든 것 + 구성원·공개 범위·삭제",
  editor: "스크립트·환경·테스트 계정·예약 편집, 실행",
  runner: "실행·테스트 세트 실행·결과 보기만 (편집 불가)",
  viewer: "보기만",
};
const VIS_KO: Record<ProjectVisibility, string> = {
  org: "조직 공개",
  members: "구성원만",
};

const codeText = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.code === "LAST_OWNER")
      return "소유자는 최소 1명이어야 합니다 — 먼저 다른 사람에게 소유권을 이전하세요.";
    if (e.code === "REQUEST_OPEN") return "이미 요청 중입니다.";
    if (e.code === "REQUEST_CLOSED")
      return "이미 처리됐거나 만료된 요청입니다.";
    if (e.code === "ALREADY_HAS_ROLE")
      return "지금 역할보다 높은 역할만 요청할 수 있습니다.";
  }
  return errorText(e);
};

/** Bordered button with a tooltip (UI ground rule: actions look like buttons and explain themselves). */
function Act({ tip, children }: { tip: string; children: ReactNode }) {
  return <Tooltip label={tip}>{children}</Tooltip>;
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="settings-section" data-testid={testId}>
      <h3>{title}</h3>
      {children}
    </Card>
  );
}

// ── Visibility ────────────────────────────────────────────────────────────────

function Visibility() {
  const { project, can, reload } = useProject();
  const [error, setError] = useState<string | null>(null);
  const set = async (v: ProjectVisibility) => {
    if (v === project.visibility) return;
    if (
      v === "members" &&
      !window.confirm(
        '구성원만 볼 수 있게 바꿀까요? 초대받지 않은 사람은 목록에서 사라지고, 받아 둔 작업 사본도 "접근 권한 없음"이 됩니다.',
      )
    )
      return;
    setError(null);
    try {
      await api(
        "PUT",
        `/api/projects/${encodeURIComponent(project.id)}/visibility`,
        { visibility: v },
      );
      await reload();
    } catch (e) {
      setError(codeText(e));
    }
  };
  const editable = can("project.visibility");
  return (
    <Section title="공개 범위" testId="settings-visibility">
      {editable ? (
        <div className="row" role="radiogroup" aria-label="공개 범위">
          <Act tip="조직 구성원 누구나 보기로 볼 수 있고, 앱 받기 목록에 나옵니다">
            <Button
              icon={Globe}
              active={project.visibility === "org"}
              aria-checked={project.visibility === "org"}
              role="radio"
              onClick={() => void set("org")}
              data-testid="visibility-org"
            >
              조직 공개
            </Button>
          </Act>
          <Act tip="초대받은 구성원만 보고 받을 수 있습니다 (그 밖에는 목록에도 없음)">
            <Button
              icon={Lock}
              active={project.visibility === "members"}
              aria-checked={project.visibility === "members"}
              role="radio"
              onClick={() => void set("members")}
              data-testid="visibility-members"
            >
              구성원만
            </Button>
          </Act>
        </div>
      ) : (
        <p data-testid="visibility-current">
          <Badge>{VIS_KO[project.visibility]}</Badge>
        </p>
      )}
      <p className="muted small">
        {project.visibility === "org"
          ? '조직 구성원은 초대 없이 "보기"로 볼 수 있습니다.'
          : "초대받은 사람만 이 프로젝트를 볼 수 있습니다."}
        {" · "}출처{" "}
        {project.birth.origin === "web"
          ? "웹에서 만듦"
          : project.birth.origin === "app"
            ? "앱에서 올림"
            : "이전 방식"}
        {project.birth.createdBy &&
          ` · 만든 사람 ${project.birth.createdBy.name}`}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

// ── Access requests ───────────────────────────────────────────────────────────

/** Header button + dialog: ask the owners for editor / runner. */
export function RequestAccessButton() {
  const { project, can } = useProject();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<RequestableRole>(
    project.myRole === "runner" ? "editor" : "runner",
  );
  const [memo, setMemo] = useState("");
  const [mine, setMine] = useState<AccessRequestDto | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${encodeURIComponent(project.id)}/access-requests`;
  const load = useCallback(async () => {
    try {
      setMine(
        (
          await api<{ requests: AccessRequestDto[] }>(
            "GET",
            `${base}?status=open`,
          )
        ).requests.find((r) => r.status === "open") ?? null,
      );
    } catch {
      setMine(null);
    }
  }, [base]);
  useEffect(() => {
    if (can("access.request")) void load();
  }, [load, can]);
  useProjectEvents((e) => {
    if (e.kind.startsWith("access.")) void load();
  });
  if (!can("access.request")) return null;
  if (mine)
    return (
      <Badge tone="warn" data-testid="request-pending">
        {ROLE_KO[mine.role]} 권한 요청 중
      </Badge>
    );
  const choices = REQUESTABLE_ROLES.filter(
    (r) => !(project.myRole === "runner" && r === "runner"),
  );
  const submit = async () => {
    setError(null);
    try {
      await api("POST", base, { role, memo: memo.trim() || undefined });
      setOpen(false);
      setMemo("");
      await load();
    } catch (e) {
      setError(codeText(e));
    }
  };
  return (
    <>
      <Act tip="소유자에게 편집자·실행자 권한을 요청합니다">
        <Button
          size="sm"
          icon={Hand}
          onClick={() => setOpen(true)}
          data-testid="request-access"
        >
          권한 요청
        </Button>
      </Act>
      {open && (
        <Dialog label="권한 요청" data-testid="request-dialog">
          <h3>권한 요청 — {project.name}</h3>
          <div className="stack">
            {choices.map((r) => (
              <label key={r} className="check">
                <input
                  type="radio"
                  name="request-role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                />
                <span>
                  {ROLE_KO[r]}{" "}
                  <span className="muted small">{ROLE_HELP[r]}</span>
                </span>
              </label>
            ))}
            <TextArea
              label="메모 (선택, 200자)"
              name="request-memo"
              maxLength={200}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <DialogActions>
            <Button icon={X} onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button
              variant="primary"
              icon={Send}
              onClick={() => void submit()}
              data-testid="request-send"
            >
              요청 보내기
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}

function AccessRequests() {
  const { project } = useProject();
  const base = `/api/projects/${encodeURIComponent(project.id)}/access-requests`;
  const [list, setList] = useState<AccessRequestDto[] | null>(null);
  const [grant, setGrant] = useState<Record<string, MemberRole>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(
        (
          await api<{ requests: AccessRequestDto[] }>(
            "GET",
            `${base}?status=open`,
          )
        ).requests,
      );
    } catch (e) {
      setError(errorText(e));
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind === "resync" || e.kind.startsWith("access.")) void load();
  });
  const decide = async (r: AccessRequestDto, approve: boolean) => {
    setError(null);
    try {
      await api(
        "POST",
        `${base}/${encodeURIComponent(r.id)}/${approve ? "approve" : "reject"}`,
        approve ? { role: grant[r.id] ?? r.role } : undefined,
      );
      await load();
    } catch (e) {
      setError(codeText(e));
    }
  };
  return (
    <Section
      title={`권한 요청${list?.length ? ` (${list.length})` : ""}`}
      testId="settings-requests"
    >
      {list === null ? (
        <p className="muted">불러오는 중…</p>
      ) : list.length === 0 ? (
        <p className="muted small">
          열린 권한 요청이 없습니다. 요청은 30일이 지나면 자동으로 만료됩니다.
        </p>
      ) : (
        <table>
          <tbody>
            {list.map((r) => (
              <tr
                key={r.id}
                data-testid="request-row"
                data-email={r.user.email}
              >
                <td>
                  <strong>{r.user.name}</strong>{" "}
                  <span className="muted small">{r.user.email}</span>
                  {r.memo && <div className="small">“{r.memo}”</div>}
                  <div className="muted small">
                    {fmtTime(r.createdAt)} · {fmtTime(r.expiresAt)} 만료
                  </div>
                </td>
                <td>
                  <Select
                    label="줄 역할"
                    value={grant[r.id] ?? r.role}
                    onChange={(e) =>
                      setGrant({
                        ...grant,
                        [r.id]: e.target.value as MemberRole,
                      })
                    }
                    name="grant-role"
                    data-testid="grant-role"
                  >
                    {ROLES.map((x) => (
                      <option key={x} value={x}>
                        {ROLE_KO[x]}
                        {x === r.role ? " (요청)" : ""}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <div className="row">
                    <Act tip="고른 역할로 구성원에 추가합니다">
                      <Button
                        size="sm"
                        variant="primary"
                        icon={Check}
                        onClick={() => void decide(r, true)}
                        data-testid="request-approve"
                      >
                        승인
                      </Button>
                    </Act>
                    <Act tip="요청을 거절합니다 (요청자에게 알림)">
                      <Button
                        size="sm"
                        variant="danger"
                        icon={X}
                        onClick={() => void decide(r, false)}
                        data-testid="request-reject"
                      >
                        거절
                      </Button>
                    </Act>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

// ── Members ───────────────────────────────────────────────────────────────────

function TransferDialog({
  target,
  onClose,
  onDone,
}: {
  target: MemberDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { project } = useProject();
  const [myRole, setMyRole] = useState<
    "editor" | "runner" | "viewer" | "leave"
  >("editor");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await api(
        "POST",
        `/api/projects/${encodeURIComponent(project.id)}/transfer`,
        { userId: target.userId, myRole },
      );
      onDone();
    } catch (e) {
      setError(codeText(e));
    }
  };
  return (
    <Dialog label="소유권 이전" data-testid="transfer-dialog">
      <h3>소유권 이전 — {target.name}</h3>
      <p className="muted small">
        {target.name} 님이 소유자가 되고, 나는 아래 역할로 바뀝니다.
      </p>
      <Select
        label="이전 뒤 내 역할"
        name="transfer-my-role"
        value={myRole}
        onChange={(e) => setMyRole(e.target.value as typeof myRole)}
      >
        <option value="editor">편집자</option>
        <option value="runner">실행자</option>
        <option value="viewer">보기</option>
        <option value="leave">프로젝트에서 나가기</option>
      </Select>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button icon={X} onClick={onClose}>
          취소
        </Button>
        <Button
          variant="primary"
          icon={Crown}
          onClick={() => void submit()}
          data-testid="transfer-confirm"
        >
          이전하기
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function Members() {
  const { project, can, me, reload } = useProject();
  const manage = can("member.manage");
  const base = `/api/projects/${encodeURIComponent(project.id)}/members`;
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<UserSummaryDto[]>([]);
  /** Checked people, in check order. */
  const [picked, setPicked] = useState<UserSummaryDto[]>([]);
  const [role, setRole] = useState<MemberRole>("editor");
  const [transfer, setTransfer] = useState<MemberDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setMembers((await api<{ members: MemberDto[] }>("GET", base)).members);
    } catch (e) {
      setError(errorText(e));
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (
      e.kind === "resync" ||
      e.kind.startsWith("member.") ||
      e.kind.startsWith("access.") ||
      e.kind.startsWith("project.")
    )
      void load();
  });
  useEffect(() => {
    if (!manage) return setFound([]);
    let stale = false;
    const t = setTimeout(() => {
      api<{ users: UserSummaryDto[] }>(
        "GET",
        `/api/users?q=${encodeURIComponent(q.trim())}`,
      )
        .then((r) => !stale && setFound(r.users))
        .catch(() => !stale && setFound([]));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, manage]);

  const memberIds = new Set((members ?? []).map((m) => m.userId));
  /** The last active owner cannot leave (transfer first) — hide the button instead of failing. */
  const activeOwners = (members ?? []).filter(
    (m) => m.role === "owner" && m.active,
  ).length;
  const pickedIds = new Set(picked.map((u) => u.id));
  const toggle = (u: UserSummaryDto) =>
    setPicked((cur) =>
      cur.some((x) => x.id === u.id)
        ? cur.filter((x) => x.id !== u.id)
        : [...cur, u],
    );

  const put = async (userId: string, r: MemberRole) => {
    setError(null);
    try {
      await api("PUT", `${base}/${encodeURIComponent(userId)}`, { role: r });
      await load();
      if (userId === me.id) await reload();
    } catch (e) {
      setError(codeText(e));
    }
  };
  const invite = async () => {
    setError(null);
    try {
      for (const u of picked)
        await api("PUT", `${base}/${encodeURIComponent(u.id)}`, { role });
      setPicked([]);
      setQ("");
      await load();
    } catch (e) {
      setError(codeText(e));
      await load();
    }
  };
  const remove = async (m: MemberDto) => {
    const note =
      project.visibility === "org"
        ? '(조직 공개 프로젝트라 "보기"로는 계속 볼 수 있습니다)'
        : "(구성원만 공개라 더는 볼 수 없습니다)";
    if (!window.confirm(`${m.name} 님을 프로젝트에서 내보낼까요? ${note}`))
      return;
    try {
      await api("DELETE", `${base}/${encodeURIComponent(m.userId)}`);
      await load();
    } catch (e) {
      setError(codeText(e));
    }
  };
  const leave = async () => {
    if (
      !window.confirm(
        `"${project.name}" 에서 나갈까요?${project.visibility === "members" ? " 구성원만 공개라 더는 볼 수 없습니다." : ""}`,
      )
    )
      return;
    setError(null);
    try {
      await api(
        "POST",
        `/api/projects/${encodeURIComponent(project.id)}/leave`,
      );
      if (project.visibility === "members") navigate("/");
      else await reload();
    } catch (e) {
      setError(codeText(e));
    }
  };

  // Search results: checked people first (in check order, numbered), then the rest.
  const rest = found.filter((u) => !pickedIds.has(u.id));
  return (
    <Section title="구성원" testId="settings-members">
      <p className="muted small">
        {project.visibility === "org"
          ? '조직 구성원은 누구나 "보기"로 볼 수 있습니다. '
          : ""}
        소유자 · 편집자 · 실행자(실행만) · 보기 역할을 초대합니다.
      </p>
      {members && (
        <table>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} data-testid="member-row" data-email={m.email}>
                <td>
                  <strong>{m.name}</strong>{" "}
                  {m.userId === me.id && (
                    <span className="muted small">(나)</span>
                  )}{" "}
                  <span className="muted small">{m.email}</span>
                  {!m.active && <Badge tone="warn">비활성</Badge>}
                </td>
                <td>
                  {manage ? (
                    <Select
                      label={`${m.name} 역할`}
                      value={m.role}
                      onChange={(e) =>
                        void put(m.userId, e.target.value as MemberRole)
                      }
                      name="member-role"
                      data-testid="member-role"
                    >
                      {ROLES.map((x) => (
                        <option key={x} value={x}>
                          {ROLE_KO[x]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge data-testid="member-role-label">
                      {ROLE_KO[m.role]}
                    </Badge>
                  )}
                </td>
                <td>
                  <div className="row">
                    {can("project.transfer") &&
                      m.userId !== me.id &&
                      m.role !== "owner" &&
                      m.active && (
                        <Act tip="이 사람을 소유자로 올리고 내 역할을 낮춥니다">
                          <Button
                            size="sm"
                            icon={Crown}
                            onClick={() => setTransfer(m)}
                            data-testid="member-transfer"
                          >
                            소유권 이전
                          </Button>
                        </Act>
                      )}
                    {manage && m.userId !== me.id && (
                      <Act tip="프로젝트 구성원에서 뺍니다">
                        <Button
                          size="sm"
                          variant="danger"
                          icon={UserMinus}
                          onClick={() => void remove(m)}
                          data-testid="member-remove"
                        >
                          내보내기
                        </Button>
                      </Act>
                    )}
                    {m.userId === me.id &&
                      can("member.leave") &&
                      !(m.role === "owner" && activeOwners <= 1) && (
                        <Act tip="이 프로젝트의 구성원에서 나갑니다 (마지막 소유자는 먼저 이전)">
                          <Button
                            size="sm"
                            icon={DoorOpen}
                            onClick={() => void leave()}
                            data-testid="member-leave"
                          >
                            나가기
                          </Button>
                        </Act>
                      )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manage && (
        <div className="invite boxed" data-testid="invite">
          <div className="inline">
            <TextField
              label="초대할 사람 찾기 (이름 또는 이메일)"
              className="grow"
              name="invite-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
            />
            <Select
              label="역할"
              value={role}
              onChange={(e) => setRole(e.target.value as MemberRole)}
              name="invite-role"
            >
              {ROLES.map((x) => (
                <option key={x} value={x}>
                  {ROLE_KO[x]} — {ROLE_HELP[x]}
                </option>
              ))}
            </Select>
          </div>
          <ul className="plain pick-list" data-testid="invite-list">
            {picked.map((u, i) => (
              <li
                key={u.id}
                className="row picked"
                data-testid="invite-candidate"
                data-email={u.email}
                data-picked="true"
              >
                <span className="suite-order">{i + 1}</span>
                <Checkbox
                  label={
                    <>
                      {u.name} <span className="muted small">{u.email}</span>
                    </>
                  }
                  checked
                  onChange={() => toggle(u)}
                />
              </li>
            ))}
            {rest.map((u) => (
              <li
                key={u.id}
                className="row"
                data-testid="invite-candidate"
                data-email={u.email}
              >
                {memberIds.has(u.id) ? (
                  <span className="muted">
                    {u.name}{" "}
                    <span className="small">{u.email} · 이미 구성원</span>
                  </span>
                ) : (
                  <Checkbox
                    label={
                      <>
                        {u.name} <span className="muted small">{u.email}</span>
                      </>
                    }
                    checked={false}
                    onChange={() => toggle(u)}
                  />
                )}
              </li>
            ))}
          </ul>
          {q.trim() && found.length === 0 && (
            <p className="muted small">맞는 활성 구성원이 없습니다.</p>
          )}
          <div className="row">
            <Act tip="체크한 사람을 체크한 순서대로 고른 역할로 초대합니다">
              <Button
                variant="primary"
                icon={UserPlus}
                disabled={!picked.length}
                onClick={() => void invite()}
                data-testid="invite-submit"
              >
                {picked.length
                  ? `${picked.length}명 ${ROLE_KO[role]}(으)로 초대`
                  : "초대할 사람을 체크하세요"}
              </Button>
            </Act>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {transfer && (
        <TransferDialog
          target={transfer}
          onClose={() => setTransfer(null)}
          onDone={() => {
            setTransfer(null);
            void load();
            void reload();
          }}
        />
      )}
    </Section>
  );
}

/** Settings sections added in stage 15: visibility · access requests (owner) · members. */
export function MembersSection() {
  const { can } = useProject();
  return (
    <>
      <Visibility />
      {can("member.manage") && <AccessRequests />}
      <Members />
    </>
  );
}
