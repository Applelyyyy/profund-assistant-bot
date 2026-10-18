-- Keep pre-upgrade ownership in the audit trail and historical originalSessionId.
DROP TRIGGER reservation_capacity ON "QueueReservation";
DROP TRIGGER reservation_owner ON "QueueReservation";
DROP TRIGGER session_capacity ON "TASession";
DROP FUNCTION validate_reservation_owner();
DROP FUNCTION validate_session_capacity();
ALTER TABLE "QueueTicket" ALTER COLUMN "sessionId" DROP NOT NULL, ALTER COLUMN "originalSessionId" DROP NOT NULL;
ALTER TABLE "QueueReservation" ALTER COLUMN "sessionId" DROP NOT NULL;
ALTER TABLE "TASession" DROP CONSTRAINT positive_capacity;
ALTER TABLE "TASession" ADD CONSTRAINT positive_capacity CHECK (capacity >= 0 AND weight > 0 AND (status <> 'ACCEPTING' OR capacity > 0));
CREATE OR REPLACE FUNCTION validate_ticket_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Student" WHERE id=NEW."studentId" AND "guildId"=NEW."guildId")
 OR NOT EXISTS (SELECT 1 FROM "Coursework" WHERE id=NEW."courseworkId" AND "guildId"=NEW."guildId")
 OR (NEW."sessionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "TASession" WHERE id=NEW."sessionId" AND "guildId"=NEW."guildId" AND status <> 'COMPLETED')) THEN
 RAISE EXCEPTION 'Invalid queue ownership'; END IF;
 RETURN NEW;
END; $$;
INSERT INTO "SystemEvent" ("guildId","actorId",type,severity,message,data,"correlationId")
SELECT "guildId",'migration','queue.globalized','info','Waiting ownership removed; original ownership retained in audit history.',
 jsonb_build_object('ticketId',id,'previousSessionId',"sessionId",'originalSessionId',"originalSessionId"),'migration-global-waiting-'||id
FROM "QueueTicket" WHERE status='QUEUED';
UPDATE "QueueTicket" SET "sessionId"=NULL WHERE status='QUEUED';
UPDATE "QueueReservation" SET "sessionId"=NULL;
ALTER TABLE "QueueTicket" ADD CONSTRAINT waiting_is_global CHECK (status <> 'QUEUED' OR "sessionId" IS NULL);
ALTER TABLE "QueueTicket" ADD CONSTRAINT dispatched_has_ta CHECK (status NOT IN ('CLAIMED','MOVING','IN_PROGRESS','MOVE_FAILED','NEEDS_REVIEW') OR "sessionId" IS NOT NULL);
ALTER TABLE "QueueReservation" ADD CONSTRAINT reservation_is_global CHECK ("sessionId" IS NULL);
-- Serialize admissions at the same guild lock used by all domain mutations.
CREATE OR REPLACE FUNCTION validate_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gid text; accepting integer; waiting integer;
BEGIN
 SELECT "guildId" INTO gid FROM "QueueTicket" WHERE id=NEW."ticketId";
 IF gid IS NULL THEN RAISE EXCEPTION 'Missing ticket'; END IF;
 PERFORM id FROM "Guild" WHERE id=gid FOR UPDATE;
 SELECT COALESCE(SUM(capacity),0) INTO accepting FROM "TASession" WHERE "guildId"=gid AND status='ACCEPTING' AND present AND NOT paused;
 SELECT COUNT(*) INTO waiting FROM "QueueReservation" r JOIN "QueueTicket" t ON t.id=r."ticketId" WHERE t."guildId"=gid AND r.id<>NEW.id;
 IF waiting >= accepting THEN RAISE EXCEPTION 'Global waiting capacity exceeded'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER reservation_capacity BEFORE INSERT ON "QueueReservation" FOR EACH ROW EXECUTE FUNCTION validate_reservation();

-- Availability exists independently of opening admission capacity.
CREATE TABLE "TAPresence" ("guildId" TEXT NOT NULL REFERENCES "Guild"(id) ON DELETE RESTRICT ON UPDATE CASCADE, "taId" TEXT NOT NULL, "taName" TEXT NOT NULL, "voiceChannelId" TEXT NOT NULL, "roleIds" TEXT[] NOT NULL, "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("guildId","taId"));
CREATE INDEX "TAPresence_guildId_observedAt_idx" ON "TAPresence"("guildId","observedAt");
