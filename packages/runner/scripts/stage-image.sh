#!/usr/bin/env bash
# Stage the runner image build context (packages/runner/.docker, git-ignored), then optionally build it.
#   engine/  euta-engine packages as `pnpm pack` tarballs (workspace:* → versions) + a package.json
#            that installs them (ADR-014 tarball approach; @euta/input-os is not shipped — no OS input
#            in the cloud)
#   app/     `pnpm deploy --prod` of @euta-cloud/runner (dist + node_modules incl. @euta-cloud/shared)
# Usage: packages/runner/scripts/stage-image.sh [--build [tag]]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cloud="$(cd "$here/../.." && pwd)"
engine="${EUTA_ENGINE_DIR:-$(cd "$cloud/../euta-engine" && pwd)}"
stage="$here/.docker"

# The engine's installed playwright (its package.json holds only a range): the image tag and the
# in-image npm install must both use it, or the preinstalled browsers would not match (ADR-040).
pw="$(cd "$engine/packages/core" && node -p "require('playwright/package.json').version")"

rm -rf "$stage"
mkdir -p "$stage/engine"
echo "$pw" > "$stage/playwright-version"
(cd "$engine" && pnpm -r --filter @euta/core --filter @euta/mcp-server --filter @euta/cli build >/dev/null)
for p in core mcp-server cli; do
  (cd "$engine/packages/$p" && pnpm pack --pack-destination "$stage/engine" >/dev/null)
done
core="$(cd "$stage/engine" && ls euta-core-*.tgz)"
mcp="$(cd "$stage/engine" && ls euta-mcp-server-*.tgz)"
cli="$(cd "$stage/engine" && ls euta-cli-*.tgz)"
cat > "$stage/engine/package.json" <<JSON
{
  "name": "euta-engine-runtime",
  "private": true,
  "dependencies": {
    "@euta/core": "file:./$core",
    "@euta/mcp-server": "file:./$mcp",
    "@euta/cli": "file:./$cli"
  },
  "overrides": {
    "@euta/core": "file:./$core",
    "@euta/mcp-server": "file:./$mcp",
    "playwright": "$pw"
  }
}
JSON

(cd "$cloud" && pnpm --filter @euta-cloud/shared --filter @euta-cloud/runner build >/dev/null)
(cd "$cloud" && pnpm --filter @euta-cloud/runner deploy --prod "$stage/app" >/dev/null)
echo "staged: $stage (playwright $pw)"

if [[ "${1:-}" == "--build" ]]; then
  tag="${2:-euta-runner:dev}"
  docker build --pull --build-arg PLAYWRIGHT_VERSION="$pw" -t "$tag" -f "$here/Dockerfile" "$stage"
fi
