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

เครื่องนี้ตั้งไว้ที่ **http://xx.xx.x.x:3000** ค่าที่สัมพันธ์กันใน root `.env` คือ:

```dotenv
WEB_HOST=xx.xx.xx.xx
WEB_PORT=3000
APP_BASE_URL=http://xx.xx.xx.xx:3000
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