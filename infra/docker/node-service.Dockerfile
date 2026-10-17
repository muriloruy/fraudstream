# Multi-stage image for any Node service in apps/ (SPEC §15 build-images).
#   docker build -f infra/docker/node-service.Dockerfile --build-arg APP=card-vault --build-arg MIGRATIONS=vault .
# glibc base (Debian slim): the Kafka client ships prebuilt librdkafka binaries for glibc (ADR-003).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo
COPY . .
# The install step must not depend on APP: every service then shares one cached install layer
# (BuildKit runs it once even when compose builds all images in parallel) instead of downloading
# the whole workspace once per service. The store cache mount keeps tarballs across rebuilds.
# Behind a TLS-intercepting proxy, pass its CA as a build secret (not stored in any layer):
#   docker build --secret id=extra_ca,src=/path/ca.crt --build-arg HTTPS_PROXY=... ...
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
ARG APP
RUN pnpm --filter "@fraudstream/${APP}..." run build
# deploy re-runs install scripts (the Kafka client's prebuilt binary download), so it needs the
# same optional CA as the install step.
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter "@fraudstream/${APP}" deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ARG APP
ARG MIGRATIONS=none
# A second schema owned by the same service (alerts-gateway also owns `auth`, SPEC §5.7).
ARG EXTRA_MIGRATIONS=none
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations EXTRA_MIGRATIONS_DIR=/app/migrations-extra
WORKDIR /app
COPY --from=build --chown=root:root /out ./
COPY --from=build --chown=root:root /repo/migrations/${MIGRATIONS} ./migrations
COPY --from=build --chown=root:root /repo/migrations/${EXTRA_MIGRATIONS} ./migrations-extra
USER node
# Tracing preload (libs/observability/src/register.ts): it must run before the ESM graph loads.
CMD ["node", "--import", "@fraudstream/observability/register", "dist/main.js"]
