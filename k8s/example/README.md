# euta cloud — 배포 예시 (k8s/example)

쿠버네티스 네임스페이스 하나에 서버 · 러너 · PostgreSQL 을 올리는 kustomize 예시다. **이 폴더를 자기 배포 레포로 복사**해 예시 값(네임스페이스 · 이미지 주소 · 도메인 · 가입 메일 도메인 · 관리자)을 바꾼 뒤 `kubectl apply -k` 로 적용하거나 ArgoCD 가 그 폴더를 보게 한다. 회사 값은 이 저장소에 두지 않는다.

- 예시 값: 네임스페이스 `euta` · 주소 `https://euta.example.com` (ingress `nginx` · 인증서 Secret `euta-tls`) · 이미지 `registry.example.com/euta/…`
- 설계: `euta-workspace` 의 `40.설계/ARCH_euta-cloud.md` "배포 · 운영"

## 구성

| 파일 | 내용 |
|---|---|
| `kustomization.yaml` | 네임스페이스 · 공통 라벨 · **이미지 주소**(`registry.example.com/euta/…`, 태그는 `<TAG>` 자리표시) |
| `config.yaml` | ConfigMap 2개 — 서버(`BASE_URL` · 가입 도메인 · 관리자 · 결과 보관) · 러너(서버 내부 주소 · 실행 위치 · 동시 실행 2) |
| `postgres.yaml` | PostgreSQL 17 StatefulSet + PVC 5Gi + Service `euta-db` |
| `server.yaml` | 서버 Deployment(1개, Recreate) + PVC 14Gi(결과 파일 · 앱 업데이트 파일) + Service(8080 공개 · 8081 러너 전용) + Ingress 2개(전체 · 앱 릴리스 올리기 1g, §11) |
| `runner.yaml` | 러너 Deployment(1개, Recreate, 동시 실행 2) |
| `create-secrets.sh` | 앱 Secret `euta-cloud-secrets` 를 1회 생성 (Git 에 비밀 없음) |

자원 요청 (작은 네임스페이스 한도 — 예: CPU 2 · 메모리 4Gi · 저장소 20Gi — 안에 들어가게 잡았다):

| 구성 | CPU 요청/제한 | 메모리 요청/제한 | 저장소 |
|---|---|---|---|
| 서버 | 0.2 / 1 | 384Mi / 1Gi | 14Gi |
| DB | 0.2 / 1 | 512Mi / 1Gi | 5Gi |
| 러너 | 1.0 / 2 | 2Gi / 4Gi (`/dev/shm` 1Gi 포함) | — (임시 폴더 emptyDir 8Gi) |
| 합계 | 1.4 | 2944Mi | 19Gi |

- 서버·러너 모두 **Recreate** — 새 pod 를 먼저 띄우면(RollingUpdate) 요청 합이 한도를 넘어 Pending 이 된다. 교체하는 동안 잠깐 끊긴다.
- 클러스터 범위 자원 · ResourceQuota · LimitRange · Secret 은 이 폴더에 없다.

## 1. 사전 준비

1. **도메인 · 인증서** — 주소를 ingress 로 연결하고 TLS Secret(`euta-tls`)을 준비한다. 접속 범위를 줄이려면 `server.yaml` 의 `whitelist-source-range` 주석을 풀어 허용할 공인 IP 를 넣는다.
2. **이미지 저장소** — 서버 · 러너 이미지를 올릴 저장소(`registry.example.com/euta`)와 로그인:
   ```sh
   docker login registry.example.com
   ```
3. **kubectl** — 대상 클러스터 · 네임스페이스로 연결된 kubeconfig.
4. 이 저장소(`euta-cloud`) 옆에 `euta-engine` 을 클론하고 둘 다 의존 설치(`pnpm install`)를 해 둔다 — 이미지 준비 스크립트가 옆의 엔진 core·cli 를 빌드해 tarball 로 넣는다.

## 2. 이미지 빌드 · push (linux/amd64)

클러스터 노드가 x86_64 라 `--platform linux/amd64` 로 만든다 (Apple Silicon Mac 에서도 그대로 동작, 에뮬레이션이라 조금 느림).

```sh
# euta-cloud 루트에서
TAG=$(git rev-parse --short HEAD)
REG=registry.example.com/euta

packages/server/scripts/stage-image.sh   # → packages/server/.docker (엔진 core tarball + 서버 deploy + 웹 빌드)
packages/runner/scripts/stage-image.sh   # → packages/runner/.docker (엔진 core·mcp-server·cli tarball + 러너 deploy)

docker buildx build --platform linux/amd64 --pull -t $REG/euta-cloud-server:$TAG \
  -f packages/server/Dockerfile packages/server/.docker --push
docker buildx build --platform linux/amd64 --pull -t $REG/euta-cloud-runner:$TAG \
  --build-arg PLAYWRIGHT_VERSION=$(cat packages/runner/.docker/playwright-version) \
  -f packages/runner/Dockerfile packages/runner/.docker --push   # Playwright 이미지 태그 = 엔진에 설치된 버전
```

크기(2026-10-21, amd64): 서버 약 500MB(압축 약 100MB) · 러너 약 3.6GB(압축 약 1GB — Playwright 공식 이미지가 대부분).

그다음 `kustomization.yaml` 의 `images:` 에서 `<TAG>` 를 push 한 태그로 바꾼다:

```sh
sed -i '' "s|newTag: <TAG>|newTag: \"$TAG\"|" k8s/example/kustomization.yaml   # macOS sed (다음 배포 때는 이전 태그를 새 태그로)
kubectl kustomize k8s/example | grep image:    # 확인
```

ArgoCD 로 배포할 때는 이 변경을 커밋해 저장소에 올려야 반영된다(이미지 교체 = `newTag` 변경 커밋).

### 이미지 풀 시크릿

비공개 저장소면 `server.yaml` · `runner.yaml` 의 `imagePullSecrets`(`registry-pull`) 에 맞는 docker-registry Secret 을 만든다. **pull 권한만** 있는 계정을 쓰고, 값은 본인 터미널에서만 입력한다:

```sh
read -r -p 'registry user: ' HU; read -r -s -p 'registry token: ' HP; echo
kubectl -n euta create secret docker-registry registry-pull \
  --docker-server=registry.example.com --docker-username="$HU" --docker-password="$HP"
unset HU HP
```

공개 저장소면 `imagePullSecrets` 두 줄을 지운다.

## 3. 앱 Secret 생성 (1회, kubectl)

```sh
k8s/example/create-secrets.sh
```

- `BETTER_AUTH_SECRET`(세션 서명) · `CREDENTIALS_KEY`(테스트 계정 암호화, AES-256) · `RUNNER_TOKEN`(러너 공유 토큰) · `POSTGRES_PASSWORD` · `DATABASE_URL` 을 이 PC 에서 무작위로 만들어 Secret `euta-cloud-secrets` 로 넣는다. 값은 화면·파일·저장소 어디에도 남기지 않는다(임시 폴더는 끝나면 지움).
- 이미 있으면 아무것도 바꾸지 않는다. ArgoCD 는 이 Secret 을 관리하지 않으므로(Git 에 없음) 동기화·prune 에도 지워지지 않는다.
- **회전**: `k8s/example/create-secrets.sh --rotate` = `BETTER_AUTH_SECRET`(모두 다시 로그인) · `RUNNER_TOKEN` 만 새로 만들고, 끝에 안내하는 `kubectl rollout restart` 로 서버·러너를 다시 띄운다.
  - `CREDENTIALS_KEY` 는 바꾸지 않는다 — 바꾸면 저장된 테스트 계정 값을 모두 읽을 수 없게 된다(다시 입력해야 함).
  - `POSTGRES_PASSWORD` 도 바꾸지 않는다 — 초기화된 DB 안의 비밀번호는 그대로라 서버가 접속하지 못한다. 꼭 바꿔야 하면 DB 에서 `ALTER USER euta PASSWORD '…'` 를 먼저 하고 Secret 의 `POSTGRES_PASSWORD` · `DATABASE_URL` 을 같은 값으로 고친 뒤 서버를 재시작한다.
- 값 확인이 꼭 필요할 때(예: 로컬 러너를 dev 서버에 붙임): `kubectl -n euta get secret euta-cloud-secrets -o jsonpath='{.data.RUNNER_TOKEN}' | base64 -d`
- **회사 Microsoft 로그인 켜기**(선택, Entra ID 단일 테넌트 앱 등록 후 1회):
  - 앱 유형 **웹 앱(서버)** · 리디렉션 URI `https://euta.example.com/api/auth/callback/microsoft` · 위임 권한 **`openid` · `profile` · `email` 만**(서버가 Graph 를 부르지 않음) · 애플리케이션 권한 없음.
  1. `k8s/example/create-secrets.sh --microsoft` — 클라이언트 비밀 **값**을 가려진 입력으로 받아 Secret 에 `MICROSOFT_CLIENT_SECRET` 으로 넣는다(명령 인자·화면·파일에 남지 않음).
  2. `config.yaml` 의 `MICROSOFT_TENANT_ID`(테넌트 GUID) · `MICROSOFT_CLIENT_ID` 주석을 풀어 값을 넣고 적용한다.
  3. `kubectl -n euta rollout restart deployment/euta-server`.
  - 세 값 중 일부만 있으면 서버가 뜨지 않는다(1~3 은 이어서 한다). 끌 때는 2 의 두 줄을 다시 주석으로 돌리고 Secret 에서 `MICROSOFT_CLIENT_SECRET` 을 지운 뒤 재시작한다. `--rotate` 는 이 값을 유지한다.
  - 비밀값 만료(Entra 기본 최대 2년 · 조직 정책) 전에 새로 발급해 1 · 3 을 다시 한다. 만료되면 Microsoft 로그인만 실패하고 이메일 로그인 · 토큰은 계속 된다.

## 4. 적용

### 방식 A — kubectl 직접 적용 (1차)

```sh
kubectl apply -k k8s/example --dry-run=client     # 렌더·형식 확인
kubectl apply -k k8s/example
kubectl -n euta rollout status statefulset/euta-db
kubectl -n euta rollout status deployment/euta-server
kubectl -n euta rollout status deployment/euta-runner
```

서버는 시작할 때 DB 마이그레이션을 적용한 뒤 연다(startupProbe 최대 5분 대기). DB 가 아직 준비 전이면 서버가 재시작을 몇 번 하다가 붙는다.

### 방식 B — ArgoCD

1. 이 폴더를 복사한 **자기 배포 레포**를 ArgoCD 에 연결한다(읽기 전용 토큰 · 배포 키).
2. Application — Repository: 그 레포 · Revision: 배포 브랜치 · **Path: 복사한 폴더** · Namespace: `euta` · Sync: Automatic.
3. 앱 Secret 은 ArgoCD 와 별개로 위 3단계(`create-secrets.sh`)로 먼저 만들어 둔다.
4. 방식 A 로 이미 올린 자원은 같은 이름이라 ArgoCD 가 그대로 넘겨받는다. 전환 뒤에는 `kubectl` 로 직접 고치지 않는다 — 자동 동기화가 Git 상태로 되돌린다.

## 5. 확인

```sh
kubectl -n euta get pods,svc,ingress,pvc
curl -s https://euta.example.com/healthz      # {"ok":true}
curl -s https://euta.example.com/readyz       # {"ok":true} — DB 응답까지
kubectl -n euta logs deploy/euta-runner | grep 'runner started'
```

- 브라우저로 `https://euta.example.com` → 가입(`ALLOWED_EMAIL_DOMAINS` 메일) → 관리자(`ADMIN_EMAILS`)가 "관리자 > 가입 승인"에서 승인 (SMTP 없음 = 관리자 승인 모드).
- 공개 대상 사이트로 실행 1건 → 실행 상세에 단계·스크린샷이 오면 러너 → 서버 내부 포트 → 결과 PVC 까지 동작.
- 원격 MCP: `claude mcp add --transport http -s user euta-cloud https://euta.example.com/mcp --header "Authorization: Bearer euta_…"`
- 내부 러너 API(8081)는 Ingress 에 없다 — `curl -s -X POST https://euta.example.com/internal/runner/claim` 이 `NOT_FOUND` 여야 한다(공개 포트에는 그 경로가 없음).

## 6. 로그 · 상태

```sh
kubectl -n euta logs deploy/euta-server -f        # JSON 로그 (pino)
kubectl -n euta logs deploy/euta-runner -f
kubectl -n euta logs statefulset/euta-db
kubectl -n euta logs deploy/euta-server --previous   # 재시작 직전 로그
kubectl -n euta describe pod -l app.kubernetes.io/name=euta-server   # 이벤트 (Pending · 이미지 풀 실패 등)
kubectl -n euta describe quota
```

## 7. 롤백

- 이미지: `kustomization.yaml` 의 `newTag` 를 이전 값으로 되돌려 `kubectl apply -k k8s/example` (ArgoCD 면 그 변경을 커밋). 급할 때는 `kubectl -n euta rollout undo deployment/euta-server` 도 되지만 다음 apply·동기화 때 매니페스트 값으로 돌아간다.
- **DB 마이그레이션은 앞으로만 간다** — 스키마를 바꾼 버전에서 되돌리면 이전 서버가 새 스키마를 만난다. 마이그레이션이 든 배포 전에는 아래 백업을 먼저 한다.

## 8. 러너 종료와 긴 실행

- pod 삭제(재배포 · 노드 정비) 때 러너는 SIGTERM 을 받으면 새 실행을 더 가져오지 않고, 돌던 실행이 끝나기를 `terminationGracePeriodSeconds`(30분)까지 기다린다.
- 30분 안에 안 끝난 실행은 강제 종료되고, 서버가 임대 만료(2분) 뒤 그 실행을 `aborted` 로 표시한다. 실행 제한 시간은 최대 24시간까지 허용되므로 긴 실행이 돌 때는 재배포를 피한다(실행 이력에서 진행 중인 실행 확인).
- Recreate 라 새 러너 pod 는 이전 pod 가 완전히 끝난 뒤 뜬다 — 그동안 들어온 실행은 대기열에서 기다린다.

## 9. 백업 (수동, 최소)

```sh
kubectl -n euta exec statefulset/euta-db -- pg_dump -U euta -d euta -Fc > euta-$(date +%Y%m%d).dump
# 복원: kubectl -n euta exec -i statefulset/euta-db -- pg_restore -U euta -d euta --clean < euta-YYYYMMDD.dump
```

결과 파일(서버 PVC)은 30일 보관 · 10Gi 상한으로 스스로 지워지는 데이터라 백업 대상에서 뺀다.

## 10. 지우기 (주의)

- `kubectl delete -k k8s/example` 는 **서버 결과 PVC(`euta-server-data`)까지 지운다**. DB PVC(`data-euta-db-0`, StatefulSet 이 만든 것)는 남는다 — DB 까지 지우려면 따로 `kubectl -n euta delete pvc data-euta-db-0`.
- Secret `euta-cloud-secrets` 는 남는다. DB PVC 를 지우지 않은 채 Secret 을 지우고 새로 만들면 DB 비밀번호가 맞지 않게 되므로 함께 처리한다.

## 11. 앱 업데이트 배포 (선택)

설계: `../euta-workspace/40.설계/SPEC_앱-배포-업데이트.md` · ADR-047. 이 서버가 앱 설치 · 업데이트 파일을 내려주게 할 수 있다(조직용 미러). **게시한 릴리스가 하나라도 있으면** 이 서버에 연결한 앱은 여기서 업데이트를 받고(`GET /api/config` `appUpdates: true`), 없으면 GitHub Releases(`onedark23/euta-app`)에서 받는다.

- 파일은 서버 PVC 의 `UPDATES_DIR`(`/data/updates/<채널>/<버전>/`)에 두고 서버가 직접 내려준다. 공개 경로(로그인 없음): `/updates/<채널>/latest*.yml` · 파일(electron-updater generic 형식) · `/api/app/releases?channel=` · `/api/app/compat`. 웹 머리 메뉴 **앱 내려받기** 가 같은 목록을 보여 준다.
- 올리기는 **관리자 계정의 읽기·쓰기 개인 토큰**으로, 앱 레포(`euta-app`)에서:

```sh
# 웹 › 토큰 에서 관리자 계정으로 "읽기·쓰기" 토큰 발급 → 환경 변수로만 넘긴다(파일·커밋에 남기지 않음)
EUTA_ADMIN_TOKEN=… pnpm release:upload --server https://euta.example.com --publish
```

- 흐름: `POST /api/admin/app-releases`(초안) → 파일마다 `PUT …/<버전>/files/<이름>`(1개 최대 1GiB, 스트리밍) → `POST …/<버전>/publish`. 게시하는 순간 그 채널의 `latest*.yml` 이 새 버전으로 바뀌고, **채널별 게시본 최근 3개만** 남긴다. 같은 버전 다시 올리기는 거절.
- Ingress: 큰 본문은 `euta-server-release-upload`(경로 `/api/admin/app-releases` 만, `proxy-body-size: 1g` · 요청 버퍼링 끔)로만 들어온다. 접속 허용 목록을 쓰면 **두 Ingress 에 똑같이** 둔다.
- 확인:

```sh
curl -s https://euta.example.com/api/config                      # "appUpdates": true (게시 후)
curl -sI https://euta.example.com/updates/alpha/latest-mac.yml   # 200 · cache-control: no-store
kubectl -n euta exec deploy/euta-server -- du -sh /data/updates /data/results
```

- 용량: 한 버전 ≈ 1.5GB × 3 = 약 4.5GB 가 결과 파일 상한(`RESULT_MAX_TOTAL`)과 **따로** PVC 를 쓴다.
- GitHub 에서 자동으로 가져오기(선택, ADR-048): `config.yaml` 에 `APP_MIRROR_GITHUB: onedark23/euta-app` 을 두면 서버가 시작 1분 뒤 · `APP_MIRROR_INTERVAL`(기본 `10m`)마다 그 레포의 GitHub 최신 릴리스(`releases/latest` 넘겨 주기 — GitHub API 아님)를 보고, 서버에 없는 버전이면 `latest*.yml` · 파일 · `.blockmap` 을 받아(sha512 확인) 게시한다. 토큰이 필요 없고 업로드 Ingress 도 쓰지 않는다 — pod 가 `github.com` 과 파일이 넘겨지는 `release-assets.githubusercontent.com`(2026-11-10 확인) 으로 나갈 수 있어야 한다. 웹 **앱 내려받기 › 릴리스 관리** 에 마지막 가져오기와 [지금 가져오기](`POST /api/admin/app-releases/mirror`)가 보인다. 실패하면 초안을 지우고 다음 주기에 다시 한다. GitHub 에 없는 버전(사내 먼저 배포)은 위의 `release:upload` 로 올린다.
- 최소 앱 버전: 서버 API 가 옛 앱과 맞지 않게 바뀌는 배포는 **같은 배포에서** `config.yaml` 의 `MIN_APP_VERSION` 을 올린다(빈 값 = 검사 안 함). 그보다 낮은 앱은 클라우드 기능이 "업데이트 필요" 로 잠긴다.
