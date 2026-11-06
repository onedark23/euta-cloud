# euta cloud server image (API · auth · scheduler · SSE · remote MCP · web UI static files).
# Build context = packages/server/.docker, prepared by scripts/stage-image.sh.
# dev cluster nodes are x86_64: docker buildx build --platform linux/amd64 …
FROM node:22-bookworm-slim

ENV NODE_ENV=production

# Engine core (tarball from euta-engine). Its deps are pure JS; scripts are skipped so no browser
# download happens — the server only parses/validates scripts, it never launches a browser.
WORKDIR /opt/euta-engine
COPY engine/ ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

# Server (pnpm deploy output: dist + drizzle migrations + node_modules) and the built web UI.
COPY app/ /opt/euta-cloud-server/
COPY web/ /opt/euta-cloud-server/web/
RUN mkdir -p /opt/euta-cloud-server/node_modules/@euta \
  && ln -s /opt/euta-engine/node_modules/@euta/core /opt/euta-cloud-server/node_modules/@euta/core \
  && mkdir -p /data/results && chown -R node:node /data

ENV WEB_DIST=/opt/euta-cloud-server/web \
    RESULTS_DIR=/data/results \
    PORT=8080 \
    INTERNAL_PORT=8081

USER node
WORKDIR /opt/euta-cloud-server
EXPOSE 8080 8081
# Migrations are applied at startup (dist/main.js) before listening. SIGTERM → close listeners → exit.
CMD ["node", "dist/main.js"]
