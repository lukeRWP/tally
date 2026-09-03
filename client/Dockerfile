# LOCAL DEV ONLY — production does NOT build or run this image (CLAUDE.md
# CI/CD rule 11a). Prod builds client/dist on the orchestrator VM (pw.json
# build steps, host Node 22 on glibc) and serves it from PW's pinned
# nginx:alpine catalog image with a generated config — see rule 11 for why
# client/nginx.conf below is likewise local-only. The build stage matches
# the server image so both halves of local dev use one Node.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Unprivileged nginx image: already runs as the non-root `nginx` user (uid
# 101) and listens on 8080 by default, with cache/pid/temp paths pre-chowned
# for that user — no manual permission surgery needed (trivy DS-0002, #46).
FROM nginxinc/nginx-unprivileged:alpine
# The base image already runs unprivileged; the explicit USER satisfies
# trivy's textual DS-0002 check (it doesn't resolve inherited users).
USER nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1
