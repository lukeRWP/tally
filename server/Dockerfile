# LOCAL DEV ONLY — production does NOT build or run this image (CLAUDE.md
# CI/CD rule 11a). Prod (PW v2) bind-mounts the built ./server tree into the
# stock node:22-bookworm-slim image declared in pw.json
# (environments.prod.services.app) and runs `node index.js` there. Keep the
# base image, Node major, NODE_ENV and the healthcheck here in step with
# pw.json / PW's nodejs catalog, so `sharp` resolves the same native binary
# locally as in prod (glibc, not musl). Deliberate differences: tini and a
# non-root user (prod runs as root — tally #370), and `--omit=dev` (prod
# installs devDependencies on the orchestrator, rule 2).
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 2727
# Same probe PW's nodejs catalog uses (bookworm-slim has no wget/curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:2727/health/live',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
