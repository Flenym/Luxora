ARG RUNTIME_NODE_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:4e4fb0ce55fd73901600796ef079a9490369d2515d7da31633a91608c82ca13b
FROM ${RUNTIME_NODE_IMAGE}

ENV NODE_ENV=development \
    PORT=8081

WORKDIR /app
COPY --chown=65532:65532 tools/otp-console/server.mjs ./server.mjs

USER 65532:65532
EXPOSE 8081
CMD ["server.mjs"]
