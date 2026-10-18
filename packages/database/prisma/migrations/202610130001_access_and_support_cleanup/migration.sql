ALTER TABLE "SupportTicket"
  ADD COLUMN "closedBy" TEXT,
  ADD COLUMN "closureReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "transcriptRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "channelDeletedAt" TIMESTAMP(3),
  ADD COLUMN "cleanupError" TEXT,
  ADD COLUMN "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "cleanupLeaseToken" TEXT,
  ADD COLUMN "cleanupLeaseUntil" TIMESTAMP(3);
CREATE INDEX "SupportTicket_cleanup" ON "SupportTicket" ("guildId", "status", "cleanupNextAttemptAt");
CREATE TABLE "ManagedPermission" (
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetType" INTEGER NOT NULL,
  "original" JSONB NOT NULL,
  "applied" JSONB NOT NULL,
  CONSTRAINT "ManagedPermission_pkey" PRIMARY KEY ("guildId", "channelId", "targetId")
);

ALTER TABLE "ManagedPermission" ADD CONSTRAINT "ManagedPermission_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManagedPermission" ADD CONSTRAINT "ManagedPermission_targetType_check" CHECK ("targetType" IN (0,1));

-- Resume old closed/closing channels without changing their original closure time or history.
UPDATE "SupportTicket" t SET
  "cleanupNextAttemptAt" = CURRENT_TIMESTAMP,
  "closedBy" = COALESCE(
    (SELECT e."actorId" FROM "SupportTicketEvent" e WHERE e."ticketId" = t."id" AND e."action" = 'close' ORDER BY e."createdAt" DESC LIMIT 1),
    (SELECT o."actorId" FROM "ServiceOperation" o WHERE o."action" = 'support_action' AND o."data"->>'ticketId' = t."id" AND o."data"->>'action' = 'close' ORDER BY o."createdAt" DESC LIMIT 1), 'system'),
  "closureReason" = COALESCE(
    (SELECT e."note" FROM "SupportTicketEvent" e WHERE e."ticketId" = t."id" AND e."action" = 'close' ORDER BY e."createdAt" DESC LIMIT 1), '')
WHERE t."status" IN ('CLOSED','CLOSING') AND t."channelId" IS NOT NULL;

-- Keep existing advanced policies active until an administrator explicitly selects simple presets.
UPDATE "Guild" SET "settings" = "settings" || '{"advancedPermissionsEnabled": true}'::jsonb
WHERE NOT ("settings" ? 'advancedPermissionsEnabled')
  AND jsonb_typeof("settings"->'featurePermissions') = 'object'
  AND "settings"->'featurePermissions' <> '{}'::jsonb;
