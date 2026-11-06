# euta-cloud

euta 의 클라우드 웹 — 로컬 앱(euta-app)에서 만든 테스트 스크립트를 PC 가 꺼져 있어도 대신 실행(위임·예약)하고, 프로젝트를 구성원이 함께 보는 서버 · 웹 · 러너.

- 계획: `../euta-workspace/20.프로젝트관리/PLAN_euta-cloud.md`
- 설계: `../euta-workspace/40.설계/ARCH_euta-cloud.md` · SPEC `SPEC_클라우드-*.md` · ADR-019~023
- 엔진: `../euta-engine` (`link:` 의존 — 엔진 `pnpm build` 가 먼저 돼 있어야 함)

> 상태: C1 완료 — 서버(계정·프로젝트 · 실행·사전 검사·대기열·결과 파일) + 러너(컨테이너). 예약·알림(C3) · 웹 화면(C4)은 다음 단계.

## 구성

| 패키지 | 내용 |
|---|---|
| `packages/shared` | API 타입 · 권한 판정(`decide`, 역할 표) · 검증 스키마(zod) |
| `packages/server` | Fastify 5 API · Better Auth 인증 · Drizzle(PostgreSQL) · SSE 변경 수신 · 실행·대기열 · 내부 러너 API(별도 포트) · 결과 파일 저장 · 원격 MCP(`/mcp`) · 웹 정적 파일 |
| `packages/runner` | 러너 — 대기열 임대 → 엔진 CLI 하위 프로세스(`euta run --cloud`) → 이벤트·결과 업로드. `Dockerfile`(Playwright 이미지 — 태그는 엔진에 설치된 playwright 버전, ADR-040) |
| `packages/web` | 웹 화면(React 19 + Vite 7) — 가입 · 로그인 · 승인 대기 · 장치 승인(`/device`) · 관리자(가입 승인) · 내 설정 > 토큰 · 프로젝트 목록 · 프로젝트(현황 · 스크립트 단계 문장·폼 편집·이력 · 실행 이력 · 실행 상세 `/projects/:id/runs/:runId` · 예약 · 테스트 세트 · 작업 로그 · 설정). `pnpm --filter @euta-cloud/web dev` = `/api` 를 `localhost:8080` 서버로 프록시 |
| `deploy/` | docker compose (PostgreSQL 17 + Mailpit, `runner` 프로필 = 러너 컨테이너) |
| `k8s/example/` | 배포 예시(kustomize — 복사해 자기 값으로 바꿔 씀) · 앱 Secret 생성 스크립트 · 배포 안내 `k8s/example/README.md`. 회사(사내) 배포 설정은 이 저장소에 두지 않는다. 이미지: `packages/server/Dockerfile` · `packages/runner/Dockerfile` (각 `scripts/stage-image.sh` 로 빌드 컨텍스트 준비) |

## 로컬 실행

```sh
pnpm install
pnpm db:up                       # PostgreSQL 17 (localhost:55432) + Mailpit (SMTP :51025, UI http://localhost:58025)
cp .env.example .env             # BETTER_AUTH_SECRET · CREDENTIALS_KEY 채우기
pnpm build
set -a; . ./.env; set +a
pnpm --filter @euta-cloud/server start   # 시작 시 마이그레이션 적용, http://localhost:8080
```

- `SMTP_URL` 을 비우면 관리자 승인 가입 모드. `ADMIN_EMAILS` 의 계정이 관리자.
- 스키마 변경: `packages/server/src/db/schema.ts` 수정 → `pnpm --filter @euta-cloud/server db:generate`.

## 러너

```sh
# 서버 .env 에 RUNNER_TOKEN 을 넣고 서버 시작(공개 :8080, 내부 러너 API :8081)
# 로컬 Node 프로세스로
EUTA_SERVER_URL=http://localhost:8081 EUTA_RUNNER_TOKEN=<RUNNER_TOKEN> RUNNER_CONCURRENCY=2 \
  node packages/runner/dist/main.js
# 컨테이너로 (엔진 tarball + runner deploy 를 packages/runner/.docker 에 모은 뒤)
packages/runner/scripts/stage-image.sh
RUNNER_TOKEN=<RUNNER_TOKEN> docker compose -f deploy/docker-compose.yml --profile runner up --build runner
```

- 러너 설정: `EUTA_SERVER_URL` · `EUTA_RUNNER_TOKEN`(필수) · `RUNNER_LOCATION`(실행 위치 이름) · `RUNNER_CONCURRENCY`(기본 4) · `RUNNER_WORK_DIR` · `EUTA_CLI`(엔진 CLI, 기본 = 옆 `euta-engine` 빌드).
- 로컬에서 픽스처 사이트(`127.0.0.1`·`host.docker.internal`)를 대상으로 돌리려면 서버에 `ALLOW_PRIVATE_TARGETS=true` — **개발·테스트 전용**, 배포 환경에는 넣지 않는다.

## 원격 MCP

구성원이 자기 Claude Code 에 서버를 MCP 로 붙인다(SPEC_클라우드-MCP · ADR-028). Streamable HTTP · 무상태 · 개인 토큰(`euta_…`, 웹 "내 설정 > 토큰")만.

```sh
claude mcp add --transport http -s user euta-cloud http://localhost:8080/mcp --header "Authorization: Bearer euta_…"
claude mcp list    # euta-cloud … ✔ Connected
```

- 도구 14개: `list_projects` · `get_project` · `list_scripts` · `read_script` · `get_schema` · `validate_script` · `save_script` · `run_script` · `get_run` · `list_runs` · `get_screenshot` · `get_artifact` · `cancel_run` · `list_schedules` (`packages/server/src/mcp/`).
- 권한 = 토큰 권한 ∧ 프로젝트 역할. 토큰당 분당 120 요청(HTTP 429). 테스트 계정 값은 어떤 결과에도 없음.

## 테스트

```sh
pnpm test        # docker compose 기동(db:up) → 전체 빌드 → vitest (실제 PostgreSQL · Mailpit)
pnpm test:only   # DB 가 이미 떠 있을 때 vitest 만
pnpm test:e2e    # 웹 E2E — 빌드한 서버(새 DB, 관리자 승인 모드) + 엔진 픽스처 사이트 + 실제 러너, 웹을 Playwright(Chromium)로
pnpm -r typecheck
```

- 웹 E2E 는 `ALLOW_PRIVATE_TARGETS=true`(테스트 전용)로 러너가 `127.0.0.1` 의 엔진 픽스처 사이트를 실제로 돌린다 — `../euta-engine` 빌드(CLI · core)가 필요하다.
- 러너 E2E(`packages/runner/test`)는 엔진 CLI(`../euta-engine` 빌드)와 Chromium 으로 엔진 픽스처 사이트를 실제로 돌린다(약 1~2분).
- 테스트는 마이그레이션된 템플릿 DB(`euta_test_template`)를 한 번 만들고 테스트 파일마다 복제 DB 를 쓴다. 접속 주소는 `TEST_DATABASE_URL` 로 바꿀 수 있다.
