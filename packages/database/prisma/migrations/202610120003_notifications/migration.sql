CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "guildId" TEXT NOT NULL REFERENCES "Guild"("id"),
  "channelId" TEXT NOT NULL,
  "eventId" INTEGER NOT NULL REFERENCES "SystemEvent"("id"),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3)
);
