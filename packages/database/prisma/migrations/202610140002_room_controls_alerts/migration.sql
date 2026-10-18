-- CreateTable
CREATE TABLE "InspectionCompletion" (
    "ticketId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "voiceChannelId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionCompletion_pkey" PRIMARY KEY ("ticketId")
);

-- CreateTable
CREATE TABLE "WaitingPresence" (
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "voiceChannelId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitingPresence_pkey" PRIMARY KEY ("guildId","discordId")
);

-- CreateTable
CREATE TABLE "WaitingRoomAlert" (
    "guildId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "mentionAttempted" BOOLEAN NOT NULL DEFAULT false,
    "channelId" TEXT,
    "messageId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "fingerprint" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "WaitingRoomAlert_pkey" PRIMARY KEY ("guildId","scope")
);

-- CreateIndex
CREATE INDEX "InspectionCompletion_state_nextAttemptAt_idx" ON "InspectionCompletion"("state", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "InspectionCompletion" ADD CONSTRAINT "InspectionCompletion_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "QueueTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingPresence" ADD CONSTRAINT "WaitingPresence_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingRoomAlert" ADD CONSTRAINT "WaitingRoomAlert_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "InspectionCompletion" ADD CONSTRAINT "InspectionCompletion_state_check" CHECK (state IN ('PENDING', 'DISCONNECTING', 'SUCCEEDED', 'NEEDS_REVIEW'));
ALTER TABLE "InspectionCompletion" ADD CONSTRAINT "InspectionCompletion_attempts_check" CHECK (attempts >= 0);
ALTER TABLE "WaitingRoomAlert" ADD CONSTRAINT "WaitingRoomAlert_generation_check" CHECK (generation >= 0);
