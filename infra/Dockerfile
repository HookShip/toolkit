# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --config.inject-workspace-packages=true \
  --filter @webhook-portal/reference-server deploy --prod /opt/reference-server

FROM build AS integration-test

RUN test -f packages/cli/test/reference-migrations.test.ts \
  && test -f packages/cli/test/reference-minio.integration.test.ts \
  && test -f packages/cli/test/reference-repository.contract.test.ts \
  && test -f infra/migrations/011_store_derived_bucket.sql \
  && test "$(find packages/cli/test -maxdepth 1 -type f | wc -l)" -eq 3

CMD ["pnpm", "test:integration:reference"]

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /opt/reference-server/ ./

USER node
EXPOSE 3210
CMD ["node", "dist/index.js"]
