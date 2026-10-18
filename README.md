# Profun Assistant — Docker deployment

เว็บแอดมิน บอต Discord, Queue Worker, PostgreSQL และ Redis ใช้ **root `.env` ไฟล์เดียว** เปิดด้วยคำสั่งเดียว ไม่ต้องลง Node.js หรือ pnpm บนเครื่องปลายทาง

## คู่มือ Web Admin ภาษาไทย

เริ่มที่ [Quick Start](docs/WEB_ADMIN_QUICK_START_TH.md) หรือ [คู่มือฉบับสมบูรณ์ 21 บท](docs/WEB_ADMIN_COMPLETE_GUIDE_TH.md) ซึ่งตรวจเทียบหน้าจอและซอร์สปัจจุบัน ครอบคลุมทั้ง 14 เมนู พร้อมข้อจำกัดที่พบ

- [Configuration reference](docs/WEB_ADMIN_CONFIGURATION_REFERENCE_TH.md)
- [Discord roles, channels และ TA room panels](docs/DISCORD_ROLES_AND_CHANNELS_GUIDE_TH.md)
- [Embed Builder และ placeholders](docs/EMBED_BUILDER_REFERENCE_TH.md)
- [Global FIFO และการปฏิบัติงาน TA](docs/QUEUE_AND_TA_OPERATIONS_TH.md)
- [Troubleshooting และ FAQ 38 กรณี](docs/TROUBLESHOOTING_AND_FAQ_TH.md)

## ติดตั้งครั้งแรก

ต้องมี Docker Engine/Desktop พร้อม Docker Compose v2 และ Buildx; บน Windows ใช้ Docker Desktop + WSL2 เครื่องควรมี RAM 4 GB และพื้นที่ว่างสำหรับ build อย่างน้อย 8 GB

```bash
cp .env.example .env   # ทำเฉพาะเมื่อยังไม่มี .env
chmod 600 .env
```

แก้ `.env` ใส่ค่าต่อไปนี้:

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` จาก Discord Developer Portal
- `ADMIN_BOOTSTRAP_USERNAME` และ `ADMIN_BOOTSTRAP_PASSWORD` ยาว 14–256 ตัวอักษร — ใช้เข้าสู่เว็บครั้งแรก
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD` อย่างน้อย 14 ตัวอักษร และ `AUTH_SECRET` สุ่มอย่างน้อย 32 ตัวอักษร ใช้รหัสคนละชุด
- `APP_BASE_URL` ให้ตรง URL ที่จะเปิดในเบราว์เซอร์ รวม `http/https`, hostname และ port

สุ่ม secret แต่ละชุดได้ด้วย `openssl rand -hex 32` หากมี OpenSSL; หรือใช้ password manager ใส่ single quotes รอบค่าที่มี `$` หรือ `#` เช่น `REDIS_PASSWORD='your$long#secret'`

จากนั้นรัน:

```bash
./start.sh
```

หรือใช้ Docker โดยตรง:

```bash
docker compose up -d --build
```

ถ้าบัญชีไม่มีสิทธิ์ Docker ให้ใช้ `sudo docker compose up -d --build`; `start.sh` ใช้ sudo ให้อัตโนมัติเมื่อจำเป็น ไม่ติดตั้งแพ็กเกจและไม่ถามค่าแอปซ้ำ

ระบบรอฐานข้อมูล/Redis พร้อม → รัน migrations และ seed → สร้าง owner เฉพาะเมื่อยังไม่มีแอดมิน → เปิดเว็บ บอตและ worker สคริปต์รอ health สูงสุด 300 วินาทีหลังเริ่ม containers แล้วแสดง URL; build ครั้งแรกอาจใช้เวลาหลายนาที ค่าเริ่มต้นเปิด **http://127.0.0.1:3000**

**มีบัญชีเดิมแล้ว ให้ใช้รหัสเดิม** การเปลี่ยน bootstrap password ใน `.env` แล้ว restart จะไม่เปลี่ยนบัญชีที่มีอยู่ ไม่มีรหัสแอดมินตายตัวและไม่มีไฟล์รหัสที่สร้างแยก ดูวิธีกู้รหัสด้านล่าง

## เข้าเว็บผ่าน IP หรือ VS Code

เครื่องนี้ตั้งไว้ที่ **http://10.60.3.1:3000** ค่าที่สัมพันธ์กันใน root `.env` คือ:

```dotenv
WEB_HOST=10.60.3.1
WEB_PORT=3000
APP_BASE_URL=http://10.60.3.1:3000
```

ถ้าใช้ VS Code forwarding และเบราว์เซอร์เปิด `http://localhost:3001` ให้ใช้ `WEB_HOST=127.0.0.1`, `WEB_PORT=3000`, `APP_BASE_URL=http://localhost:3001` แล้วรัน `./start.sh` ใหม่ ใช้ URL จากแถบที่อยู่จริง อย่าเดา hostname หรือ port; `localhost` กับ `127.0.0.1` เป็นคนละ origin

หาก deploy ผ่าน public domain ให้ใช้ HTTPS reverse proxy และตั้ง `APP_BASE_URL=https://your-domain.example` โดยคง backend bind เฉพาะ loopback ไม่เปิด PostgreSQL/Redis ออกภายนอก

## ตั้งค่าใช้งานผ่านเว็บ

สร้างและเชิญบอตตาม [Discord installation/permissions](docs/DISCORD_GUIDE.md): เปิด Server Members Intent และวาง role บอตเหนือ Student role Message Content ไม่จำเป็นต่อคิว; เปิดเมื่อใช้ support transcripts เท่านั้น

หลัง login ตั้งค่าตามลำดับ:

1. **Roles & Access** — เลือก Student, TA, Support, Admin roles และช่องจากเซิร์ฟเวอร์จริง ตรวจ preview แล้ว Confirm save & sync
2. **Discord Channels** — ผูก Registration, Student Queue, TA Dashboard, Waiting Voice, TA Inspection Voice และ Support category
3. **Students** — import CSV `id,name,lastname`; รหัสนักศึกษาเป็นข้อความ เก็บเลขศูนย์นำหน้า
4. **Coursework** — เพิ่มงานที่เปิดรับตรวจ
5. **Queue Configuration / Tickets** — ตั้ง capacity, recovery, mute, alerts และ support policy
6. **Embed Builder** — Save draft แล้ว Publish ไปช่องที่เลือก

ห้องตรวจให้นักศึกษา View ได้แต่ Connect เองไม่ได้ จากนั้น TA เข้าห้องตรวจ → Start Queue; นักศึกษา Verify → เข้าห้องรอ → เลือกงาน → Join Queue; TA Call Next → inspection completes when the student leaves the TA room การเปลี่ยนค่าผ่านเว็บบันทึก PostgreSQL และส่ง event ให้ bot/worker โดยไม่ต้อง restart

## คำสั่งประจำวัน

```bash
./start.sh status
./start.sh logs
./start.sh stop
./start.sh restart
./start.sh update    # build source ปัจจุบัน ไม่ได้ git pull
```

ทุกคำสั่งเก็บ volumes และคิวเดิม **อย่าใช้ `docker compose down -v`** หากต้องการเก็บข้อมูล หลังแก้ `.env` ใช้ `./start.sh` เพื่อ recreate ด้วยค่าใหม่; `docker compose restart` อย่างเดียวไม่โหลด environment ใหม่

บอตต้องเชื่อม Discord ค้างไว้ตามปกติ ใช้หนึ่ง bot และหนึ่ง worker ต่อ deployment ห้ามรันบอต host ซ้ำกับ Docker ใน guild เดียวกัน App containers retry เมื่อ crash สูงสุด 5 ครั้งต่อ failure streak; หากผิด config จะหยุดให้แก้ ไม่วนไม่สิ้นสุด PostgreSQL/Redis ใช้ `unless-stopped` **หลัง reboot/เริ่ม Docker daemon ใหม่ ให้รัน `./start.sh` เพื่อเปิด app services**

## ลืมรหัสแอดมิน

แก้ `ADMIN_BOOTSTRAP_USERNAME` เป็นชื่อบัญชีที่มีอยู่ และ `ADMIN_BOOTSTRAP_PASSWORD` เป็นรหัสใหม่ใน root `.env` แล้วรันอย่างชัดเจน:

```bash
docker compose run --rm --no-deps migrate node --import tsx scripts/reset-admin.ts --confirm
```

ต้องเปิด PostgreSQL อยู่ คำสั่งนี้เปลี่ยนเฉพาะบัญชีชื่อที่ระบุ เปิดบัญชีที่ถูก disable กลับ รักษา role เดิม เพิกถอน sessions และบันทึก audit ไม่แสดงรหัสผ่าน หากใช้ sudo กับ Docker ให้เติม sudo เช่นเดียวกัน การบูตปกติจะไม่ reset ให้เอง

## แก้ปัญหา

- **Missing root .env / missing variable** — คัดลอก template และเติมค่าที่ error ระบุ ไม่ต้องส่ง secrets มาในแชต
- **Docker/Compose ไม่พบ** — ติดตั้ง Docker พร้อม Compose v2/Buildx ก่อน สคริปต์ไม่ติดตั้งให้
- **`Request origin is not allowed.`** — ตั้ง `APP_BASE_URL` ให้ตรง URL เบราว์เซอร์แล้วรัน `./start.sh`; ไม่ปิด CSRF protection
- **port ถูกใช้** — เปลี่ยน `WEB_PORT` และ `APP_BASE_URL` ให้สัมพันธ์กัน
- **bot unhealthy** — `docker compose logs --tail=100 bot`; ตรวจ token, guild, invite และ Gateway intents
- **database authentication failed หลังเปลี่ยนรหัส** — รหัส PostgreSQL ใน `.env` ต้องตรง role ใน volume เดิม เปลี่ยน `.env` อย่างเดียวไม่เปลี่ยนรหัสในฐานข้อมูล ห้ามลบ volume เพื่อแก้
- **พื้นที่เต็ม** — `df -h` และ `docker system df`; เครื่องนี้เก็บ Docker/containerd ที่ `/data` แล้ว ดู [storage guide](docs/DOCKER_DEPLOYMENT.md#docker-storage-on-a-separate-disk)

เก็บ `.env` ส่วนตัว ไม่รวมใน Git, image หรือ browser bundle สำรอง PostgreSQL ก่อนย้ายเครื่อง/อัปเกรด; Redis ไม่ใช่แหล่งข้อมูลคิวหลัก

[Deployment details](docs/DOCKER_DEPLOYMENT.md) · [Backup/restore](docs/BACKUP_RESTORE.md) · [Development/tests](docs/DEVELOPMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [State machine](docs/STATE_MACHINE.md) · [Permission matrix](docs/PERMISSIONS.md) · [Test report](docs/TEST_REPORT.md) · [Requirements coverage](docs/REQUIREMENTS.md)

ฟีเจอร์จาก master brief ที่ยังไม่ครบและการทดสอบ Discord หลายบัญชีจริงระบุใน requirements/test report ไม่อ้างว่าผ่าน production certification ทั้งหมด

See [Verification, live panels, support cleanup and Roles & Access](docs/FEATURE_FIXES.md) for the new workflows and [verified results](docs/FEATURE_TEST_REPORT.md) for test evidence.

Verification stays public. **Roles & Access → Use simple role presets** removes old extra action restrictions after a permission preview, while keeping configured Student/TA/Support checks and stored advanced rules. **Queue Configuration** controls automatic panel refresh/debounce and optional administrator approval of student IDs. Closed support channels are deleted after their configured transcript and history are saved; use **Tickets → Manage → Retry cleanup** after repairing a deletion failure. Reopening creates a new private channel with the same retained history.

[Global FIFO and voice automation](docs/GLOBAL_FIFO.md): Waiting tickets have no TA owner. Any authorized TA in an inspection room can call next without Start Queue; concurrent claims retain ordered moves. Leaving waiting cancels a ticket; leaving the inspection room completes it. Sync **Roles & Access** for Speak/Use Voice Activity. Customize **Student called / นักศึกษาเข้าห้องตรวจงาน** in Embed Builder. Support opening follows its saved access preset, including Everyone. See [FIFO test results](docs/FIFO_TEST_REPORT.md) and [review](docs/FIFO_REVIEW.md).

### Unified global queue and Thai Discord defaults

See [current queue behavior](docs/GLOBAL_FIFO.md) and [latest verification report](docs/UNIFIED_QUEUE_REPORT.md). Start Queue opens pooled admission capacity only. Call Next also works for a TA who never opened capacity. Discord defaults are Thai; the website stays English. Long support subjects are retained in full. Custom templates are preserved; Apply Thai default is an explicit, versioned operation in Embed Builder.

## Visibility, TA room panels and data cleanup

Configure **Onboarding README / Channel Visibility** in **Roles & Access**, and per-room queue panels in **Discord channels → TA Inspection Rooms**. Defaults are Thai on Discord and English in the dashboard. Room panels reuse Global FIFO; TAs can call next without opening capacity.

Owners can use **System operations → Data Management** to preview historical cleanup, create a verified backup and type `RESET PRODUCTION DATA` before execution. Live queues, active inspections, identities, configuration and open support tickets are protected. Reporting baselines survive restarts; cleanup never runs automatically. Docker now retains backups in the `platform-backups` volume.

See [operations setup and safeguards](docs/OPERATIONS_FEATURES.md), [implementation and test report](docs/OPERATIONS_FEATURES_REPORT.md), and [review](docs/OPERATIONS_FEATURES_REVIEW.md).

### Quiet Discord queue UX

Coursework selection and room-panel calls now acknowledge silently. Routine call/arrival announcements default to off. Existing room templates stay unchanged: open **Embed builder → room template → Add current inspection section → Save draft** to show the called/inspected student in the same message. **Apply default** installs the full three-section layout with a confirmation and version history.

Queue configuration controls public names, student-ID masking and optional routine announcements. README and Registration default to **Unverified Only**; customize them in **Roles & Access → Channel Visibility**. Discord administrators retain access. Details and verification results: [Queue UX guide](docs/QUEUE_UX.md) and [testing report](docs/QUEUE_UX_REPORT.md).

### Embed accent color picker

**Embed builder → Message properties → Accent color** opens an in-app picker with live preview, HEX/RGB/HSL inputs, presets and recent colors. **Apply** closes the picker; **Save draft** persists the color. Reset changes only the accent. No database migration is required. [Implementation and testing report](docs/COLOR_PICKER_REPORT.md).

### TA room operations and waiting alerts

Use **Embed Builder → TA_ROOM_QUEUE_PANEL → Restore default room controls → Save draft**, then republish from **Discord Channels → TA Inspection Rooms**. This preserves custom text. The new room defaults contain Start/Stop, Call Next, Complete and Disconnect, My Status, No Show, Retry, Return, Session Settings and Inspection Note. Completion disconnects only the clicking TA's uniquely owned current student and preserves membership, Student role and identity.

The main TA dashboard's new default is for monitoring; apply its Thai default and republish to adopt it. Existing customized dashboards remain available.

Configure **Queue Configuration → Waiting Room Alerts**. It reuses Queue Alert unless you choose a dedicated channel. Choose notification roles explicitly; no selected roles means no ping. Grace defaults to 30 seconds and cooldown to five minutes. Save before running diagnostics or a labeled test alert; check their results in System Operations. Edit `waiting_room_alert` in Embed Builder and save to change automatic notifications.

See [implementation, recovery and verification report](docs/TA_ROOM_CONTROLS_REPORT.md) and [change review](docs/TA_ROOM_CONTROLS_REVIEW.md) for details and the live Discord checklist. The usual single-root-`.env` Docker startup remains unchanged; migrations are additive and service restarts preserve queues.

### No Show, capacity settings, and TA student-channel access

In the TA room panel, **นักศึกษาไม่ตอบกลับ** opens a private confirmation for the TA's current inspection. Confirm once to disconnect that student and classify the inspection as **NO_SHOW**, without completion credit. A durable decision takes precedence over the automatic voice-departure completion handler. A private Thai notification asks the student to request a new ticket. Closed DMs do not undo the decision. Configure delivery in **Queue Configuration → No Show notifications**, and edit the **No Show notification** template in **Embed Builder**. Use the existing completion recovery controls in **System Operations** for failed disconnects.

Repeated **Start Queue** clicks cannot edit capacity. Use **Session Settings** to change it; reductions below outstanding global waiting reservations are rejected. Starting a draining session resumes the same session in the same authorized room. An administrator must resume an administratively paused session.

**Roles & Access → Student Channel Access** enables TA visibility by default for configured student-facing channels. Select channel exceptions and explicit waiting-voice Connect grants. Preview the exact changes before applying. Private support tickets and administrative bindings are excluded; unrelated permission bits remain intact.

**Queue Configuration → Alerts** separates Waiting Room (verified students without tickets), Abandoned Queue (existing tickets without eligible TAs), and Operations (failed/stalled queue work). Waiting Room shows current incidents, recent diagnostics, last notification and a saved-template preview. Save before checking permissions or sending a labeled test. Switching alert tabs preserves unsaved fields.

See [No Show and access verification report](docs/NO_SHOW_ACCESS_REPORT.md) for migration, tests, deployment evidence and live Discord limitations. Docker startup remains `./start.sh`; stop all services with `docker compose stop`. Never remove database volumes to apply this update.

### Student IDs in the current TA inspection

`{room.current}` now separates the registered Student ID, database name, coursework, ticket number, TA and Thai status. IDs remain strings, including leading zeros. Missing verified Discord mappings show `ไม่พบรหัสนักศึกษา`; check **Students → Discord identity mapping**. The bot logs a mapping warning when the affected panel content changes, without logging the Student ID.

Embed Builder supports `{room.current.student_id}`, `{room.current.student_name}`, `{room.current.coursework}`, `{room.current.ticket}`, `{room.current.ta}` and `{room.current.status}`. Use these inside custom fields or descriptions; existing `{room.current}` templates continue working. Current-section and detail visibility switches still apply.

**Public-safe is the default for every room.** It hides or masks registered Student IDs, including in custom room fields and waiting-list placeholders. To show the current inspection’s full registered ID directly in the existing voice-channel chat, open **Discord Channels → TA Inspection Rooms → Edit → Visibility → Full Inspection Details**, acknowledge the disclosure warning, then choose **Preview & publish → Confirm save & sync**. This is an explicit disclosure to everyone who can access the destination, including students; enable it only when your institution permits this. No additional channel, Discord button, role assignment or permission grant is needed. Each room keeps its own policy. Existing TA-only companion channels remain available as a separate option. Republish requests for full-details panels require acknowledgment again. Normal policy changes apply without restarting the bot.

See [Student ID fix and verification](docs/ROOM_CURRENT_STUDENT_ID_REPORT.md).

### Performance diagnostics and repeatable benchmarks

See [the performance audit](docs/PERFORMANCE_AUDIT_REPORT.md), [measured results](docs/performance-benchmarks.json) and [change review](docs/PERFORMANCE_REVIEW.md). The optimization keeps PostgreSQL FIFO locking, persistent transfer/completion operations and the existing Docker deployment.

The follow-up [concurrent performance report](docs/CONCURRENT_PERFORMANCE_REPORT.md) covers batched recovery, duplicate interaction delivery, direct message edits, dashboard refreshes and 200-event dispatch/replay bursts. Its [raw measurements](docs/concurrent-performance-benchmarks.json) include p50/p95/p99 and measurement limits.

Metrics are optional. Add `PERFORMANCE_METRICS_ENABLED=true` to the **existing root `.env`**, then recreate the application containers:

```bash
docker compose up -d --force-recreate --wait web bot worker
```

The flag defaults to false. Enabled processes write `performance.summary` once per minute in normal runtime logs. An authenticated `GET /api/performance` returns the web process snapshot; bot/worker snapshots are in their own logs. Metrics omit credentials, SQL parameters and Student IDs, and bound stored latency samples. Ordinary dashboard configuration changes still apply without a restart. To stop metrics, set the flag back to false and recreate the same application containers.

Run benchmarks **only against a fresh disposable PostgreSQL database**, never the production database. Create an environment file outside Git with `NODE_ENV=test`, matching `DATABASE_URL`/`TEST_DATABASE_URL` ending in `_test`, isolated Redis, a synthetic `DISCORD_GUILD_ID`, and test-only credentials. Apply migrations and seed defaults first:

```bash
node --env-file=/path/to/test.env node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
node --env-file=/path/to/test.env --import tsx packages/database/src/seed.ts
PERFORMANCE_OUTPUT=/path/to/results.json node --env-file=/path/to/test.env --import tsx scripts/performance-benchmark.ts
PERFORMANCE_ADAPTER_OUTPUT=/path/to/discord-results.json node --env-file=/path/to/test.env --import tsx node_modules/vitest/vitest.mjs run tests/discord.test.ts -t 'isolated performance workload'
```

The domain benchmark rejects an existing ticket history, creates synthetic workload records, checks database invariants and removes only its own live reservations. Use a new disposable database for each comparable run. It does not contact Discord. Adapter tests use mocked Discord requests and a query-counting test fixture. For real backup tests, PostgreSQL client tools must match the server major version; use `RUN_BACKUP_TESTS=true` and `RUN_OPS_TESTS=true` only with the dedicated test infrastructure.

`tests/performance_browser.py` measures a production web build at `http://127.0.0.1:3010` backed by a disposable database. Set `E2E_BASE_URL`, `E2E_USERNAME`, `E2E_PASSWORD` and `PERFORMANCE_BROWSER_OUTPUT` for that test administrator, with Playwright/Chromium installed. Optional `PERFORMANCE_EVENT_STORM_ENV=/path/to/test.env` adds 100 synthetic note events and checks selective refresh without losing an unsaved edit. It never publishes a Discord panel. Keep test environment files private and remove copied real credentials after testing.

TA history now returns session counts rather than every nested ticket. Recorded work loads 50 rows at a time through `/api/sessions/{sessionId}?before={sequence}`. The web dashboard includes Older/Newer controls and keeps exact ticket/completion totals.
