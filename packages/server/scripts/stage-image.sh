#!/usr/bin/env bash
# Stage the server image build context (packages/server/.docker, git-ignored), then optionally build it.
#   engine/  @euta/core as a `pnpm pack` tarball + a package.json that installs it (ADR-014 tarball
#            approach, same as the runner image) — the server imports core for script validation
#   app/     `pnpm deploy --prod` of @euta-cloud/server (dist + drizzle migrations + node_modules incl.
#            @euta-cloud/shared). The `link:` to the sibling engine checkout is removed here and re-linked
#            to the installed tarball inside the image.
#   web/     the built web UI (packages/web/dist), served by the server (WEB_DIST)
# Usage: packages/server/scripts/stage-image.sh [--build [tag]]   (--build = local docker build, host arch)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cloud="$(cd "$here/../.." && pwd)"
engine="${EUTA_ENGINE_DIR:-$(cd "$cloud/../euta-engine" && pwd)}"
stage="$here/.docker"

# Hold the engine's playwright range to its installed version, like the runner image (ADR-040).
pw="$(cd "$engine/packages/core" && node -p "require('playwright/package.json').version")"

rm -rf "$stage"
mkdir -p "$stage/engine"
(cd "$engine" && pnpm -r --filter @euta/core build >/dev/null)
(cd "$engine/packages/core" && pnpm pack --pack-destination "$stage/engine" >/dev/null)
core="$(cd "$stage/engine" && ls euta-core-*.tgz)"
cat > "$stage/engine/package.json" <<JSON
{
  "name": "euta-engine-runtime",
  "private": true,
  "dependencies": {
    "@euta/core": "file:./$core"
  },
  "overrides": {
    "playwright": "$pw"
  }
}
JSON

(cd "$cloud" && pnpm --filter @euta-cloud/shared --filter @euta-cloud/server --filter @euta-cloud/web build >/dev/null)
(cd "$cloud" && pnpm --filter @euta-cloud/server deploy --prod "$stage/app" >/dev/null)
rm -f "$stage/app/node_modules/@euta/core"
rmdir "$stage/app/node_modules/@euta" 2>/dev/null || true
# better-auth declares vitest as a peer, so `deploy` pulls the vitest → vite → esbuild/rolldown chain with
# host-platform native binaries. None of it is loaded at runtime — drop it (and the links into it).
(cd "$stage/app/node_modules/.pnpm" && rm -rf vitest@* @vitest+* vite@* esbuild@* @esbuild+* @esbuild-kit+* \
  rolldown@* @rolldown+* lightningcss* fsevents@*)
find "$stage/app/node_modules" -type l ! -exec test -e {} \; -delete
rm -rf "$stage/app/node_modules/.bin"
cp -R "$cloud/packages/web/dist" "$stage/web"
echo "staged: $stage"

if [[ "${1:-}" == "--build" ]]; then
  tag="${2:-euta-cloud-server:dev}"
  docker build --pull -t "$tag" -f "$here/Dockerfile" "$stage"
fi
