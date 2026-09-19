ARG NODE_IMAGE=node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46
ARG RUNTIME_NODE_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:4e4fb0ce55fd73901600796ef079a9490369d2515d7da31633a91608c82ca13b
FROM ${NODE_IMAGE} AS build

WORKDIR /app/packages/protocol
COPY packages/protocol/package*.json packages/protocol/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY packages/protocol/src ./src
RUN npm run build && npm prune --omit=dev

WORKDIR /app/packages/passkey-domain
COPY packages/passkey-domain/package*.json packages/passkey-domain/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY packages/passkey-domain/src ./src
RUN npm run build && npm prune --omit=dev

WORKDIR /app/packages/call-control
COPY packages/call-control/package*.json packages/call-control/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY packages/call-control/src ./src
RUN npm run build && npm prune --omit=dev

WORKDIR /app/services/api
COPY services/api/package*.json services/api/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY services/api/src ./src
RUN npm run build && npm prune --omit=dev
RUN mkdir -p /app/runtime-data/blobs /app/runtime-data/uploads && touch /app/runtime-data/.keep

FROM ${RUNTIME_NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/app/data/luxora.db \
    STORAGE_LOCAL_PATH=/app/data/blobs \
    UPLOAD_STAGING_PATH=/app/data/uploads

WORKDIR /app/services/api
COPY --from=build --chown=65532:65532 /app/runtime-data /app/data
COPY --from=build --chown=65532:65532 /app/packages/protocol/package.json /app/packages/protocol/package.json
COPY --from=build --chown=65532:65532 /app/packages/protocol/node_modules /app/packages/protocol/node_modules
COPY --from=build --chown=65532:65532 /app/packages/protocol/dist /app/packages/protocol/dist
COPY --from=build --chown=65532:65532 /app/packages/passkey-domain/package.json /app/packages/passkey-domain/package.json
COPY --from=build --chown=65532:65532 /app/packages/passkey-domain/node_modules /app/packages/passkey-domain/node_modules
COPY --from=build --chown=65532:65532 /app/packages/passkey-domain/dist /app/packages/passkey-domain/dist
COPY --from=build --chown=65532:65532 /app/packages/call-control/package.json /app/packages/call-control/package.json
COPY --from=build --chown=65532:65532 /app/packages/call-control/node_modules /app/packages/call-control/node_modules
COPY --from=build --chown=65532:65532 /app/packages/call-control/dist /app/packages/call-control/dist
COPY --from=build --chown=65532:65532 /app/services/api/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/services/api/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/services/api/dist ./dist

USER 65532:65532
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["--enable-source-maps", "dist/server.js"]
