ALTER TABLE "Guild" ADD COLUMN "analyticsSince" TIMESTAMP(3), ADD COLUMN "rankingsSince" TIMESTAMP(3);
ALTER TABLE "PublishedPanel" ADD COLUMN active BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "checkedAt" TIMESTAMP(3);
CREATE TABLE "TARoomPanel" (
 id TEXT PRIMARY KEY, "guildId" TEXT NOT NULL REFERENCES "Guild"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "voiceChannelId" TEXT NOT NULL, "destinationChannelId" TEXT NOT NULL,
 mode TEXT NOT NULL DEFAULT 'VOICE', visibility TEXT NOT NULL DEFAULT 'PUBLIC',
 "templateId" TEXT NOT NULL REFERENCES "EmbedTemplate"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 enabled BOOLEAN NOT NULL DEFAULT true, "refreshSeconds" INTEGER NOT NULL DEFAULT 30,
 "publishedPanelId" TEXT UNIQUE REFERENCES "PublishedPanel"(id) ON DELETE SET NULL ON UPDATE CASCADE,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("guildId","voiceChannelId"), UNIQUE("guildId","destinationChannelId"),
 CONSTRAINT room_mode CHECK(mode IN ('VOICE','COMPANION')),
 CONSTRAINT room_visibility CHECK(visibility IN ('PUBLIC','TAS')),
 CONSTRAINT room_interval CHECK("refreshSeconds" BETWEEN 5 AND 3600)
);
CREATE TABLE "MaintenancePlan" (
 id TEXT PRIMARY KEY, "guildId" TEXT NOT NULL REFERENCES "Guild"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "adminId" TEXT NOT NULL, input JSONB NOT NULL, preview JSONB NOT NULL, fingerprint TEXT NOT NULL,
 cutoff TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, status TEXT NOT NULL DEFAULT 'PREVIEW',
 "backupPath" TEXT, "backupVerifiedAt" TIMESTAMP(3), "leaseUntil" TIMESTAMP(3), result JSONB, error TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
 CONSTRAINT maintenance_status CHECK(status IN ('PREVIEW','BACKING_UP','READY','RUNNING','COMPLETED','PARTIAL','FAILED'))
);
CREATE INDEX "MaintenancePlan_guildId_createdAt_idx" ON "MaintenancePlan"("guildId","createdAt");
