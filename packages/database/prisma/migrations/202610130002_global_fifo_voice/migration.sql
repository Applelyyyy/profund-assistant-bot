ALTER TABLE "QueueTicket" ADD COLUMN assisted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Inspection"
  ADD COLUMN "voiceChannelId" TEXT,
  ADD COLUMN "completionReason" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "durationSeconds" INTEGER,
  ADD COLUMN voided BOOLEAN NOT NULL DEFAULT false;
UPDATE "Inspection" i SET "voiceChannelId"=s."voiceChannelId",
  "durationSeconds"=CASE WHEN i."completedAt" IS NULL THEN NULL ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (i."completedAt"-i."startedAt"))))::integer END
FROM "QueueTicket" t JOIN "TASession" s ON s.id=t."sessionId" WHERE i."ticketId"=t.id;
-- Reservations retain their capacity sponsor while sessionId becomes the inspecting TA at claim.
CREATE OR REPLACE FUNCTION validate_reservation_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_reservation "QueueReservation"%ROWTYPE;
BEGIN
 SELECT * INTO current_reservation FROM "QueueReservation" WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM "QueueTicket" t JOIN "TASession" s ON s.id=current_reservation."sessionId" WHERE t.id=current_reservation."ticketId" AND t."guildId"=s."guildId") THEN
  RAISE EXCEPTION 'Reservation sponsor must belong to the ticket guild';
 END IF;
 RETURN NULL;
END; $$;
UPDATE "QueueTicket" SET assisted=true WHERE "originalSessionId"<>"sessionId";
ALTER TABLE "Inspection" ADD CONSTRAINT "inspection_duration" CHECK ("durationSeconds" IS NULL OR "durationSeconds">=0);

-- Do not replay historical arrival announcements during upgrade.
INSERT INTO "NotificationDelivery" (id,"guildId","channelId","eventId",status)
SELECT 'arrival:' || id,"guildId",COALESCE(data->>'channelId',''),id,'SKIPPED' FROM "SystemEvent" WHERE type='transfer.succeeded'
ON CONFLICT (id) DO NOTHING;
