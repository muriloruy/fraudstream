# Multi-stage image for any Node service in apps/ (SPEC §15 build-images).
#   docker build -f infra/docker/node-service.Dockerfile --build-arg APP=card-vault --build-arg MIGRATIONS=vault .
# glibc base (Debian slim): the Kafka client ships prebuilt librdkafka binaries for glibc (ADR-003).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG APP
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo
COPY . .
# Behind a TLS-intercepting proxy, pass its CA as a build secret (not stored in any layer):
#   docker build --secret id=extra_ca,src=/path/ca.crt --build-arg HTTPS_PROXY=... ...
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter "@fraudstream/${APP}..." run build
RUN pnpm --filter "@fraudstream/${APP}" deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ARG APP
ARG MIGRATIONS=none
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=root:root /out ./
COPY --from=build --chown=root:root /repo/migrations/${MIGRATIONS} ./migrations
USER node
CMD ["node", "dist/main.js"]
