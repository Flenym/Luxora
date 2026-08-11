ARG RUNTIME_NODE_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167
FROM ${RUNTIME_NODE_IMAGE}

ENV NODE_ENV=development \
    PORT=8081

WORKDIR /app
COPY --chown=65532:65532 tools/otp-console/server.mjs ./server.mjs

USER 65532:65532
EXPOSE 8081
CMD ["server.mjs"]
