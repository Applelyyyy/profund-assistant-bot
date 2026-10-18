FROM node:22.22.1-bookworm-slim
ARG APP_UID=1000
ARG APP_GID=1000
RUN groupmod -g "$APP_GID" node && usermod -u "$APP_UID" -g "$APP_GID" node
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.11.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/ops-agent/package.json apps/ops-agent/package.json
COPY packages packages
RUN --mount=type=cache,id=ta-prisma-engines,target=/root/.cache/prisma,sharing=locked pnpm install --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=ta-prisma-engines,target=/root/.cache/prisma,sharing=locked pnpm db:generate
ENV NEXT_TELEMETRY_DISABLED=1
# Next imports server modules while compiling; these values exist only in this build step.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    DISCORD_GUILD_ID=100000000000000001 \
    AUTH_SECRET=build-only-placeholder-never-used-at-runtime \
    pnpm --filter @ta/web build
RUN mkdir -p logs backups && chown -R node:node logs backups apps/web/.next
USER node
ENTRYPOINT ["node", "--import", "tsx", "scripts/docker-entrypoint.ts"]
CMD ["node", "--import", "tsx", "scripts/web.ts", "start"]
