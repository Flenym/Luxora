ARG RUNTIME_NODE_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
FROM ${RUNTIME_NODE_IMAGE}

ENV NODE_ENV=development \
    PORT=8081

WORKDIR /app
COPY --chown=65532:65532 tools/otp-console/server.mjs ./server.mjs

USER 65532:65532
EXPOSE 8081
CMD ["server.mjs"]
