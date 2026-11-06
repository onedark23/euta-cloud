# euta cloud runner image (ADR-019 §4): official Playwright image with the same version as the engine
# (browsers + system deps preinstalled under /ms-playwright).
# Build context = packages/runner/.docker, prepared by scripts/stage-image.sh, which writes the engine's
# installed playwright version to .docker/playwright-version — pass it as PLAYWRIGHT_VERSION (ADR-040).
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ENV NODE_ENV=production

# Engine (tarballs from euta-engine). Optional deps (OS input adapter) are not installed.
WORKDIR /opt/euta-engine
COPY engine/ ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

# Runner (pnpm deploy output).
COPY app/ /opt/euta-runner/

ENV EUTA_CLI=/opt/euta-engine/node_modules/@euta/cli/dist/index.js \
    RUNNER_WORK_DIR=/tmp/euta-runs \
    RUNNER_LOCATION=docker-local
RUN mkdir -p /tmp/euta-runs && chown pwuser:pwuser /tmp/euta-runs

USER pwuser
WORKDIR /opt/euta-runner
# Graceful stop: SIGTERM → stop claiming, wait for running runs (set the stop grace period accordingly).
CMD ["node", "dist/main.js"]
