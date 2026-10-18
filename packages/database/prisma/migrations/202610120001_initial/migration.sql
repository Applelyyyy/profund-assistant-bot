-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACCEPTING', 'DRAINING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('QUEUED', 'CLAIMED', 'MOVING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'MOVE_FAILED', 'NEEDS_REVIEW', 'NO_SHOW');

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nextSequence" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "csrf" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastname" TEXT NOT NULL,
    "discordId" TEXT,
    "registration" TEXT NOT NULL DEFAULT 'UNREGISTERED',
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentImport" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "errors" JSONB NOT NULL,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coursework" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "eligibleUsers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eligibleRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),

    CONSTRAINT "Coursework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TASession" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "taId" TEXT NOT NULL,
    "taName" TEXT NOT NULL,
    "voiceChannelId" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACCEPTING',
    "present" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "courseworkIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT NOT NULL DEFAULT '',
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPresence" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TASession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueTicket" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseworkId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "originalSessionId" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueReservation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "taId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "assisted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceTransferOperation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "targetChannelId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceTransferOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DraftSelection" (
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "courseworkId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftSelection_pkey" PRIMARY KEY ("guildId","discordId")
);

-- CreateTable
CREATE TABLE "MuteOwnership" (
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MuteOwnership_pkey" PRIMARY KEY ("guildId","discordId")
);

-- CreateTable
CREATE TABLE "ChannelBinding" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "channelIds" TEXT[],

    CONSTRAINT "ChannelBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbedTemplate" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "document" JSONB NOT NULL,
    "versions" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmbedTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedPanel" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL DEFAULT 'EMBED',
    "fingerprint" TEXT,
    "publishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "PublishedPanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "channelId" TEXT,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "additional" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "assignedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "transcript" JSONB,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemEvent" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "correlationId" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceOperation" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceHeartbeat" (
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("service")
);

-- CreateTable
CREATE TABLE "QueueIncident" (
    "guildId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "unresolvedCount" INTEGER NOT NULL,

    CONSTRAINT "QueueIncident_pkey" PRIMARY KEY ("guildId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Student_guildId_studentId_key" ON "Student"("guildId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_guildId_discordId_key" ON "Student"("guildId", "discordId");

-- CreateIndex
CREATE INDEX "Coursework_guildId_sortOrder_idx" ON "Coursework"("guildId", "sortOrder");

-- CreateIndex
CREATE INDEX "TASession_guildId_status_idx" ON "TASession"("guildId", "status");

-- CreateIndex
CREATE INDEX "QueueTicket_guildId_status_sequence_idx" ON "QueueTicket"("guildId", "status", "sequence");

-- CreateIndex
CREATE INDEX "QueueTicket_sessionId_status_sequence_idx" ON "QueueTicket"("sessionId", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "QueueTicket_guildId_sequence_key" ON "QueueTicket"("guildId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "QueueReservation_ticketId_key" ON "QueueReservation"("ticketId");

-- CreateIndex
CREATE INDEX "QueueReservation_sessionId_idx" ON "QueueReservation"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_ticketId_key" ON "Inspection"("ticketId");

-- CreateIndex
CREATE INDEX "VoiceTransferOperation_state_nextAttemptAt_idx" ON "VoiceTransferOperation"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelBinding_guildId_feature_key" ON "ChannelBinding"("guildId", "feature");

-- CreateIndex
CREATE UNIQUE INDEX "PublishedPanel_guildId_channelId_templateId_key" ON "PublishedPanel"("guildId", "channelId", "templateId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_channelId_key" ON "SupportTicket"("channelId");

-- CreateIndex
CREATE INDEX "SupportTicket_guildId_status_idx" ON "SupportTicket"("guildId", "status");

-- CreateIndex
CREATE INDEX "SystemEvent_guildId_createdAt_idx" ON "SystemEvent"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "SystemEvent_dispatchedAt_idx" ON "SystemEvent"("dispatchedAt");

-- CreateIndex
CREATE INDEX "ServiceOperation_status_createdAt_idx" ON "ServiceOperation"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coursework" ADD CONSTRAINT "Coursework_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TASession" ADD CONSTRAINT "TASession_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueTicket" ADD CONSTRAINT "QueueTicket_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueTicket" ADD CONSTRAINT "QueueTicket_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueTicket" ADD CONSTRAINT "QueueTicket_courseworkId_fkey" FOREIGN KEY ("courseworkId") REFERENCES "Coursework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueTicket" ADD CONSTRAINT "QueueTicket_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TASession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueReservation" ADD CONSTRAINT "QueueReservation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "QueueTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueReservation" ADD CONSTRAINT "QueueReservation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TASession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "QueueTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceTransferOperation" ADD CONSTRAINT "VoiceTransferOperation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "QueueTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBinding" ADD CONSTRAINT "ChannelBinding_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbedTemplate" ADD CONSTRAINT "EmbedTemplate_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedPanel" ADD CONSTRAINT "PublishedPanel_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedPanel" ADD CONSTRAINT "PublishedPanel_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmbedTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketEvent" ADD CONSTRAINT "SupportTicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemEvent" ADD CONSTRAINT "SystemEvent_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOperation" ADD CONSTRAINT "ServiceOperation_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Partial indexes enforce exclusive live ownership without restricting historical sessions.
CREATE UNIQUE INDEX "one_live_ticket_per_student" ON "QueueTicket" ("guildId", "studentId") WHERE "status" IN ('QUEUED','CLAIMED','MOVING','IN_PROGRESS','MOVE_FAILED','NEEDS_REVIEW');
CREATE UNIQUE INDEX "one_live_session_per_ta" ON "TASession" ("guildId", "taId") WHERE "status" <> 'COMPLETED';
CREATE UNIQUE INDEX "one_live_owner_per_room" ON "TASession" ("guildId", "voiceChannelId") WHERE "status" <> 'COMPLETED';
CREATE UNIQUE INDEX "one_live_transfer_per_ticket" ON "VoiceTransferOperation" ("ticketId") WHERE "state" IN ('PENDING','MOVING','FAILED','NEEDS_REVIEW');
ALTER TABLE "TASession" ADD CONSTRAINT "positive_capacity" CHECK ("capacity" > 0 AND "weight" > 0);
ALTER TABLE "QueueTicket" ADD CONSTRAINT "positive_sequence" CHECK ("sequence" > 0);
ALTER TABLE "AdminUser" ADD CONSTRAINT "admin_role" CHECK ("role" IN ('OWNER','ADMIN','OPERATOR','VIEWER'));
ALTER TABLE "VoiceTransferOperation" ADD CONSTRAINT "transfer_state" CHECK ("state" IN ('PENDING','MOVING','SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED'));

-- Validate cross-guild ownership and reservations even for writes outside the queue engine.
CREATE FUNCTION validate_ticket_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Student" WHERE id=NEW."studentId" AND "guildId"=NEW."guildId")
 OR NOT EXISTS (SELECT 1 FROM "Coursework" WHERE id=NEW."courseworkId" AND "guildId"=NEW."guildId")
 OR NOT EXISTS (SELECT 1 FROM "TASession" WHERE id=NEW."sessionId" AND "guildId"=NEW."guildId" AND status <> 'COMPLETED') THEN
 RAISE EXCEPTION 'Invalid queue ownership';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ticket_ownership BEFORE INSERT OR UPDATE OF "studentId","courseworkId","sessionId","guildId" ON "QueueTicket" FOR EACH ROW EXECUTE FUNCTION validate_ticket_ownership();
CREATE FUNCTION validate_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_capacity integer; session_status text;
BEGIN
 SELECT capacity,status::text INTO session_capacity,session_status FROM "TASession" WHERE id=NEW."sessionId" FOR UPDATE;
 IF NOT EXISTS (SELECT 1 FROM "QueueTicket" WHERE id=NEW."ticketId") OR session_status='COMPLETED' THEN RAISE EXCEPTION 'Invalid reservation session'; END IF;
 IF (SELECT COUNT(*) FROM "QueueReservation" WHERE "sessionId"=NEW."sessionId" AND id<>NEW.id) >= session_capacity THEN RAISE EXCEPTION 'Reservation capacity exceeded'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER reservation_capacity BEFORE INSERT OR UPDATE OF "sessionId" ON "QueueReservation" FOR EACH ROW EXECUTE FUNCTION validate_reservation();
