-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS';

-- AlterTable
ALTER TABLE "InspectionCompletion" ADD COLUMN     "notificationChannelId" TEXT,
ADD COLUMN     "notificationError" TEXT,
ADD COLUMN     "notificationMessageId" TEXT,
ADD COLUMN     "notificationSentAt" TIMESTAMP(3),
ADD COLUMN     "notificationState" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "outcome" TEXT NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN     "studentDiscordId" TEXT;

UPDATE "Inspection" SET status = CASE WHEN "completedAt" IS NULL THEN 'IN_PROGRESS' ELSE 'COMPLETED' END;
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_status_check" CHECK (status IN ('IN_PROGRESS','COMPLETED','NO_SHOW'));
ALTER TABLE "InspectionCompletion" ADD CONSTRAINT "InspectionCompletion_outcome_check" CHECK (outcome IN ('COMPLETED','NO_SHOW'));
ALTER TABLE "InspectionCompletion" ADD CONSTRAINT "InspectionCompletion_notification_check" CHECK ("notificationState" IN ('NONE','PENDING','SENDING','SENT','FAILED','SKIPPED','NEEDS_REVIEW'));
