# Profund Assistant

A Discord-based coursework inspection queue with a web administration dashboard.

## Overview

Profund Assistant helps students verify their identity, request coursework inspections, and wait for a teaching assistant (TA). TAs call students into inspection voice rooms, while administrators manage student records, coursework, permissions, and support from the Web Admin dashboard.

The platform runs a Discord bot, web dashboard, and background worker together. PostgreSQL stores student records, queue state, and history; Redis and BullMQ coordinate background jobs. The dashboard is intended for local administration by default.

## Key Features

- **Student management:** CSV imports, student ID verification, optional administrator approval, and Discord nickname and Student role synchronization.
- **Queue management:** A shared first-in, first-out (FIFO) queue, coursework selection, live status, capacity limits, and ticket cancellation.
- **TA tools:** Inspection room ownership, accepting sessions, calling the next student, automatic voice transfers, inspection completion, and No Show handling.
- **Administration:** Role and channel configuration, coursework management, an Embed Builder, room panels, and waiting room alerts.
- **Support and monitoring:** Private support tickets, configurable transcript collection, analytics and rankings, audit logs, database backups, and recovery tools.
- **Persistence and deployment:** Durable queue state across restarts and a Docker Compose deployment using one root `.env` file.

## Tech Stack

| Component            | Technology                         |
| -------------------- | ---------------------------------- |
| Runtime and language | Node.js 22, TypeScript 5.9         |
| Discord bot          | discord.js 14                      |
| Web dashboard        | Next.js 16, React 19               |
| Database             | PostgreSQL 18, Prisma 6            |
| Background jobs      | Redis 8, BullMQ 5                  |
| Workspace and checks | pnpm 10, Turborepo, ESLint, Vitest |
| Deployment           | Docker Compose v2                  |

Exact dependency versions are pinned in [package.json](package.json) and [pnpm-lock.yaml](pnpm-lock.yaml); container versions are defined in [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml).

## Prerequisites

- Docker Engine or Docker Desktop with Docker Compose v2 and Buildx, with the Docker daemon running.
- Git and a Bash shell. On Windows, use Docker Desktop with WSL2 for the supplied shell scripts.
- A Discord application, bot token, and server where you can install the bot and configure roles and channels.
- Strong, separate passwords for the administrator, PostgreSQL, and Redis, plus a random authentication secret.

The Docker installation does not require Node.js or pnpm on the host. Contributors running services directly need the tools listed under [Development](#development).

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/Applelyyyy/profund-assistant-bot.git
cd profund-assistant-bot
```

### 2. Create the environment file

From the repository root, copy the example only if `.env` does not already exist:

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
```

Edit the root `.env` file. Fill in the three Discord credentials, the bootstrap administrator credentials, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and `AUTH_SECRET`. Keep the default browser address for a local installation, or set `APP_BASE_URL` to the exact origin you will use.

See [Environment Configuration](#environment-configuration) for required formats. Generate each secret independently with a password manager or, if OpenSSL is installed, `openssl rand -hex 32`. Never use example placeholders as credentials.

### 3. Prepare Discord

Complete [Discord Bot Setup](#discord-bot-setup): enable Server Members Intent, invite the bot, and position its role above the Student role and the members whose nicknames it must manage. Channel bindings and application policies are configured in Web Admin after startup.

### 4. Start the application

```bash
./start.sh
```

The script builds the image, waits for PostgreSQL and Redis, applies database migrations and seed data, and creates an owner account **only when no administrator exists**. It then starts the web dashboard, bot, and worker.

The first build can take several minutes. After the build, the script waits up to 300 seconds for service readiness and prints the dashboard URL. It uses `sudo` if needed for Docker access.

### 5. Open Web Admin

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) with the default configuration and sign in using your bootstrap credentials. If an administrator account already exists, use its existing password; changing the bootstrap values does not reset it.

Follow the [administrator workflow](#administrator-workflow) to configure your server before opening the queue.

### 6. Verify the installation

```bash
./start.sh status
./start.sh logs
```

- `postgres`, `redis`, `web`, `bot`, and `worker` should be running and healthy.
- `migrate` should have exited with code `0`; it is a one-time initialization service.
- Confirm that Web Admin opens, the bot appears online in your Discord server, and the dashboard reports the bot and worker online.
- Check logs for authentication, connection, migration, or permission errors. Successful initialization and service health checks exercise database connectivity.

## Discord Bot Setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open its **Bot** page. Create a bot if necessary, obtain its token, and store it as `DISCORD_BOT_TOKEN` in `.env`. Treat the token as a password.
3. Under **Privileged Gateway Intents**, enable **Server Members Intent**. The code requests `Guilds`, `GuildMembers`, `GuildVoiceStates`, and `GuildModeration`; it does not request Presence Intent.
4. Leave **Message Content Intent** disabled for ordinary queue operation. If you enable support transcript collection, enable it in the portal and set `DISCORD_MESSAGE_CONTENT_ENABLED=true` in `.env`. This also enables `GuildMessages` and `MessageContent` in the bot. See Discord's [gateway intent documentation](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx) for privileged intent requirements.
5. Copy the **Application ID** from **General Information** into `DISCORD_CLIENT_ID`. In Discord, enable **Developer Mode**, right-click your server, and copy its server ID into `DISCORD_GUILD_ID`.
6. Use the portal's installation settings or OAuth2 URL Generator to create a server installation link with the `bot` scope. Discord includes `applications.commands` with that scope. Select the permissions below and install the bot in the configured server. See the official [bot authorization documentation](https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx).
7. In Discord server settings, move the bot role above the Student role and students it must manage. Channel overrides must also permit the bot's required actions.
8. In Web Admin, bind existing roles and channels, review the **Roles & Access** permission preview, and explicitly confirm synchronization. Publish your configured panels through **Embed builder**.

Grant permissions for the features you use; Administrator permission is not required.

| Feature                                         | Bot permissions                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Panels and messages                             | View Channel, Send Messages, Embed Links, Read Message History in configured destinations               |
| Student verification and access synchronization | Manage Roles and Manage Nicknames; View Channel and Manage Roles in channels being synchronized         |
| Voice transfers and completion                  | View Channel, Connect, and Move Members in configured waiting and inspection rooms                      |
| Support ticket channels                         | View Channel and Manage Channels in the support category, plus messaging permissions in ticket channels |
| Optional waiting room muting                    | Mute Members and View Audit Log, so the bot can identify and release its own mutes                      |
| Optional alerts with restricted mentions        | Mention Everyone when the configured alert requires it                                                  |
| Optional room panels in threads                 | Send Messages in Threads and access to the target thread, in addition to panel permissions              |

Developer Portal settings authorize the bot to connect to Discord. Web Admin settings determine which roles, channels, coursework, and policies the application uses. Dashboard accounts are separate from Discord roles.

## Environment Configuration

[.env.example](.env.example) is the configuration template. Docker Compose reads the root `.env` and constructs internal PostgreSQL and Redis connection URLs; you do not need to supply `DATABASE_URL` or `REDIS_URL` for the Docker deployment.

The examples below describe formats, not usable secrets.

| Variable                   | Required             | Purpose and format                                                                              |
| -------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`        | Yes                  | Private bot token from the Developer Portal                                                     |
| `DISCORD_CLIENT_ID`        | Yes                  | Application ID, a 17–20 digit Discord ID                                                        |
| `DISCORD_GUILD_ID`         | Yes                  | Target server ID, a 17–20 digit Discord ID                                                      |
| `ADMIN_BOOTSTRAP_USERNAME` | First initialization | Initial owner username; 3–64 letters, digits, underscores, periods, or hyphens; default `admin` |
| `ADMIN_BOOTSTRAP_PASSWORD` | First initialization | Initial owner password, 14–256 characters                                                       |
| `AUTH_SECRET`              | Yes                  | Random secret of at least 32 characters; do not use a `replace-` placeholder                    |
| `POSTGRES_PASSWORD`        | Yes                  | PostgreSQL password, 14–256 characters                                                          |
| `REDIS_PASSWORD`           | Yes                  | Redis password, 14–256 characters                                                               |
| `APP_BASE_URL`             | Has default          | Exact browser origin, default `http://127.0.0.1:3000`; no additional path, query, or fragment   |

| Optional variable                 | Default                      | Purpose                                                                                                                |
| --------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WEB_HOST` / `WEB_PORT`           | `127.0.0.1` / `3000`         | Host address and port published by Compose                                                                             |
| `POSTGRES_USER` / `POSTGRES_DB`   | `ta` / `ta_queue`            | Database user and name; start with a letter or underscore and use letters, digits, or underscores, up to 63 characters |
| `DISCORD_MESSAGE_CONTENT_ENABLED` | `false`                      | Enable message content access for support transcripts; also requires the portal intent                                 |
| `LOG_LEVEL`                       | `info`                       | `debug`, `info`, `warn`, `error`, or `fatal`                                                                           |
| `TZ`                              | `Asia/Bangkok`               | Container and application timezone in Docker                                                                           |
| `APP_UID` / `APP_GID`             | `1000` / `1000`              | Image user IDs; keep stable when reusing existing log volumes                                                          |
| `PERFORMANCE_METRICS_ENABLED`     | `false`                      | Bounded, redacted runtime summaries every 60 seconds                                                                   |
| `NODE_ENV`                        | `production` in the template | Runtime mode; Docker forces `production`                                                                               |

For direct contributor runs, `.env.example` also lists `DATABASE_URL`, `REDIS_URL`, `TEST_DATABASE_URL`, `TIMEZONE`, and `SERVICE_CONTROL_ENABLED`. See [Development](#development); Docker disables the host service supervisor.

Quote secrets containing `$` or `#` with single quotes in `.env` to preserve their contents. Do not share the file or commit it.

`APP_BASE_URL` must match the browser's protocol, hostname, and port. For example, with VS Code forwarding from local port `3000` to browser address `http://localhost:3001`, use `WEB_HOST=127.0.0.1`, `WEB_PORT=3000`, and `APP_BASE_URL=http://localhost:3001`. `localhost` and `127.0.0.1` are different origins. After editing `.env`, rerun `./start.sh`; `docker compose restart` alone does not load changed environment values.

## Running the Application

Run these commands from the repository root:

| Command              | Action                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `./start.sh`         | Build and start services, applying configuration changes                 |
| `./start.sh status`  | Show all service states, including initialization                        |
| `./start.sh logs`    | Follow the latest service logs                                           |
| `./start.sh stop`    | Stop services while retaining volumes                                    |
| `./start.sh restart` | Stop, rebuild, and start services                                        |
| `./start.sh update`  | Rebuild and start from the current local source; does not run `git pull` |

Keep one bot and one worker per deployment. Do not run a host bot alongside the Docker bot for the same server. Application containers retry failed processes up to five times; PostgreSQL and Redis use `unless-stopped`. Run `./start.sh` after a host reboot or Docker daemon restart to bring application services up.

Named volumes retain PostgreSQL data, Redis data, logs, and backups. **Do not run `docker compose down -v` if you need to retain these volumes.** Changing database credentials in `.env` does not update credentials inside an already initialized PostgreSQL data volume; coordinate changes with the database instead of deleting its data.

### Administrator password recovery

With PostgreSQL running, set `ADMIN_BOOTSTRAP_USERNAME` to the existing account name and `ADMIN_BOOTSTRAP_PASSWORD` to a new password in the root `.env`. Then explicitly run:

```bash
docker compose run --rm --no-deps migrate node --import tsx scripts/reset-admin.ts --confirm
```

Prefix the command with `sudo` if required for Docker access. This resets only the named account, re-enables it if disabled, preserves its role, revokes its sessions, and records an audit event without printing the password. Normal startup never resets an existing account.

## How It Works

### Student workflow

1. Verify an imported student ID through the registration panel; wait for administrator approval if required by policy.
2. Join a configured waiting voice channel.
3. Select available coursework and request a queue ticket.
4. Remain in the waiting room until a TA calls the ticket. A student can cancel an active waiting ticket through the configured controls.
5. The bot moves the student to the TA's inspection room after checking permissions and eligibility.
6. Complete the inspection. Leaving the assigned inspection room completes it; TAs can also use completion controls to disconnect the student and finalize the outcome.

Admission requires available capacity from a present, unpaused accepting TA who can handle the coursework. Each student can have only one active ticket.

### Teaching assistant workflow

1. Join an available configured inspection voice room with the required TA role.
2. Optionally use **Start Queue** to contribute accepting capacity and configure coursework availability.
3. Call the next student when available and eligible for the next coursework.
4. Inspect the coursework, complete the inspection, or confirm a **No Show** when appropriate.
5. Continue calling students or stop accepting new tickets. Stopping admission preserves existing tickets for processing.

**Start Queue controls admission capacity.** An authorized TA in an available inspection room can call existing tickets without starting an accepting session. Room ownership, current inspections, and coursework restrictions still apply.

### Administrator workflow

1. Sign in to Web Admin and select Student, TA, Support, and Admin roles in **Roles & Access**.
2. Bind registration and queue text channels, the TA dashboard, waiting and inspection voice rooms, and the support category in **Discord channels**. Review and confirm access synchronization.
3. Import students through **Students** using CSV columns `id,name,lastname`. Keep student IDs as text to preserve leading zeros.
4. Add and enable coursework, then configure capacity, identity policy, waiting alerts, and support settings.
5. Save panel drafts in **Embed builder**, review them, and publish to the intended channels.
6. Monitor the queue, resolve failed transfers or identity synchronization, and review audit logs.

Inspection rooms must deny students normal Connect permission; visibility is configurable. The bot controls transfers into these rooms. Saved application settings are persisted in PostgreSQL and propagated to the bot and worker without a service restart.

**Global FIFO:** Tickets belong to one server-wide queue and are called in admission order, rather than being assigned permanently to the TA who provided capacity. A TA must be eligible for the next ticket's coursework; later tickets cannot bypass an ineligible or unresolved ticket. A failed transfer may require recovery before dispatch can continue.

## Web Admin Dashboard

Available actions depend on the signed-in account's permissions.

| Page                 | Purpose                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| Overview             | Queue totals, available capacity, and service status                              |
| Live queue           | Active tickets, inspection state, and recovery actions                            |
| TA management        | TA presence, sessions, capacity, and room ownership                               |
| Students             | Student records, CSV import/export, identity mappings, and verification           |
| Coursework           | Available assignments, ordering, schedules, and TA eligibility                    |
| Queue configuration  | Admission, identity, inspection, waiting alert, and support policies              |
| Discord channels     | Bind application features to server channels and configure room panels            |
| Roles & Access       | Role assignments, channel visibility, and permission previews and synchronization |
| Embed builder        | Edit templates, save drafts, and publish Discord panels                           |
| Support tickets      | Review ticket history, assignments, closure, and cleanup                          |
| Analytics & rankings | Queue activity and TA and student inspection statistics                           |
| Logs & audit         | Recorded application events and structured runtime logs                           |
| System operations    | Service checks, database backups, and recovery operations                         |
| Settings             | Application settings and administrator accounts                                   |

Docker deployments use `./start.sh` for process restarts. Dashboard process restart controls require the separate, restricted local supervisor; they are not enabled in the supplied Compose deployment.

## Project Structure

```text
profund-assistant-bot/
├── apps/
│   ├── bot/             # Discord interactions, panels, and voice actions
│   ├── web/             # Next.js administration dashboard and API
│   ├── worker/          # Background scheduling and recovery
│   └── ops-agent/       # Optional local process supervisor
├── packages/
│   ├── config/          # Runtime configuration, access plans, logs, and backups
│   ├── database/        # Prisma schema, migrations, client, and seed
│   ├── discord-ui/      # Discord templates and display helpers
│   ├── queue-engine/    # Queue admission, claims, completion, and maintenance
│   ├── shared/          # Validation, authentication, and shared rules
│   └── ui/              # Shared web UI utilities
├── scripts/             # Startup, bootstrap, recovery, and maintenance tools
├── tests/               # Automated checks and browser test scripts
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── start.sh
```

## Development

Direct development requires **Node.js 22.12.0 or newer** and **pnpm 10.11.0**, as specified in `package.json`. Use separate development PostgreSQL and Redis instances reachable from the host. The supplied Compose file keeps database ports private and does not expose them for host development.

Use the root `.env` template, set `NODE_ENV=development`, and supply `DATABASE_URL` and `REDIS_URL` for those development services. Set `TIMEZONE` if overriding the direct-run default of `Asia/Bangkok`. Keep all bot connections pointed at a separate development Discord server; never run a second bot against an active deployment's server.

From the repository root, initialize a **development database** and start the services:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm bootstrap
pnpm dev
```

Run `pnpm bootstrap` only when the development database has no administrator, using the configured bootstrap credentials. `pnpm dev` starts the web dashboard, bot, and worker together. To run a service separately, use `pnpm web`, `pnpm bot`, or `pnpm worker`; do not start duplicates of services already running.

### Checks and builds

Before `pnpm test`, create a dedicated test database whose name ends in `_test`. Set `TEST_DATABASE_URL` to it and use a separate test Redis instance. Export `TEST_DATABASE_URL` in your shell before applying migrations to that database:

```bash
DATABASE_URL="${TEST_DATABASE_URL:?Export the dedicated test database URL first}" pnpm db:migrate
```

Vitest maps `TEST_DATABASE_URL` to `DATABASE_URL` for tests; integration tests write database records and require real PostgreSQL, and some checks also require Redis. Never point tests at deployment data. The backup integration test additionally needs compatible `pg_dump` and `pg_restore` tools and is enabled with `RUN_BACKUP_TESTS=true`.

Run the checks and production build from the repository root:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm check` combines type checking, linting, and Vitest. `pnpm build` runs workspace build tasks, including the Next.js production build. `pnpm start` serves the built web dashboard only; it does not start the bot or worker. These commands still require valid runtime configuration.

## Troubleshooting

Start with `./start.sh status` and `./start.sh logs`. For one service, use `docker compose logs --tail=100 bot`, replacing `bot` with `web`, `worker`, `migrate`, `postgres`, or `redis` as needed.

| Problem                       | What to check                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot is offline                | Check bot logs, the token and server ID, enabled Server Members Intent, network access, and whether another bot process is running.                                                               |
| Web Admin does not load       | Check web health, `WEB_HOST` and `WEB_PORT`, port forwarding, and the exact `APP_BASE_URL` origin.                                                                                                |
| Discord interactions fail     | Confirm bot and worker health, current channel bindings, feature permissions, and the event or error in Logs & audit.                                                                             |
| Student cannot verify         | Confirm the imported ID, approval policy, existing account mapping, Student role, and bot role hierarchy and nickname permissions.                                                                |
| Student cannot join the queue | Check verification, waiting voice presence, an enabled assignment within its schedule, accepting TA eligibility, free capacity, and duplicate tickets.                                            |
| TA cannot call next           | Check TA role, inspection room binding and ownership, current inspections, next coursework eligibility, and unresolved earlier transfers. Start Queue is not required to assist existing tickets. |
| Bot cannot move a student     | Check View Channel, Connect, and Move Members in relevant rooms, the student's waiting presence, and Speak and Use Voice Activity permissions in the destination.                                 |
| Discord embed does not update | Save the intended draft and publish to the correct destination; check panel records, message access, channel permissions, and bot/worker logs before republishing.                                |
| PostgreSQL connection fails   | Check database health and initialization logs. Existing volumes keep their original credentials even if `.env` is changed.                                                                        |
| Redis connection fails        | Check Redis health, password consistency, and bot/worker logs. Docker uses the internal `redis` hostname.                                                                                         |
| Startup takes a long time     | Check whether Docker is still downloading or building. The readiness timeout starts after the build; inspect `migrate` logs if application services have not started.                             |

See [administrator password recovery](#administrator-password-recovery) for forgotten dashboard credentials. Dedicated troubleshooting documentation is not currently included in the repository.

## Documentation

- [Product scope and operational commitments](PRODUCT.md)
- [Dashboard design specification](DESIGN.md)
- [Environment template](.env.example)
- [Deployment configuration](docker-compose.yml)
- [Database schema](packages/database/prisma/schema.prisma)
- [Development commands](package.json)

The repository currently has no `docs/` directory or separate Web Admin, configuration, or troubleshooting manual. This README covers initial setup and common operations.

## Security and Privacy

- Never commit `.env`, bot tokens, database passwords, authentication secrets, or exported student records. Restrict access to configuration, logs, and backups.
- Keep Web Admin on loopback or behind controlled access. For access through a public domain, use an HTTPS reverse proxy and set `APP_BASE_URL` to its browser origin. Keep PostgreSQL and Redis private.
- Grant only the Discord permissions needed for enabled features. Review permission previews, role hierarchy, and channel overrides before applying changes.
- Protect student identity mappings and support transcripts. A student ID alone is not strong identity proof; use administrator approval when required by your institution.
- Review channel audiences before enabling full inspection details. Full Student ID visibility in a shared channel exposes those IDs to anyone who can access it. Discord server owners and Administrator roles bypass ordinary channel restrictions.
- Use the database backup operation in **System operations** and keep protected copies outside the deployment. Back up before upgrades or recovery work, and verify restoration separately. Persistent volumes alone are not backups.

## License

No project license is specified in the repository. The bundled [Noto Sans Thai font license](apps/web/public/fonts/NotoSansThai-LICENSE.txt) applies to that font, not to the application as a whole.
