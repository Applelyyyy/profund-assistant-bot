BEGIN;
ALTER TABLE "TARoomPanel"
  ADD COLUMN "studentIdDisclosureAcknowledged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TARoomPanel" DROP CONSTRAINT room_visibility;
ALTER TABLE "TARoomPanel" ADD CONSTRAINT room_visibility
  CHECK (visibility IN ('PUBLIC', 'TAS', 'FULL_INSPECTION_DETAILS'));
ALTER TABLE "TARoomPanel" ADD CONSTRAINT room_disclosure_acknowledged
  CHECK (visibility <> 'FULL_INSPECTION_DETAILS' OR "studentIdDisclosureAcknowledged");
COMMIT;
