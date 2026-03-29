FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV NODE_ENV=production
EXPOSE 2727
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:2727/health/live || exit 1
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
