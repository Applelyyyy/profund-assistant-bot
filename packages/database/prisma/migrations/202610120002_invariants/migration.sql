-- Deferred validation checks the final ownership after an atomic assistance/reassignment.
CREATE FUNCTION validate_reservation_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_reservation "QueueReservation"%ROWTYPE; ticket_session text;
BEGIN
 SELECT * INTO current_reservation FROM "QueueReservation" WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT "sessionId" INTO ticket_session FROM "QueueTicket" WHERE id=current_reservation."ticketId";
 IF ticket_session IS DISTINCT FROM current_reservation."sessionId" THEN RAISE EXCEPTION 'Reservation owner must match ticket owner'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER reservation_owner AFTER INSERT OR UPDATE ON "QueueReservation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reservation_owner();
CREATE FUNCTION validate_session_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.capacity < (SELECT COUNT(*) FROM "QueueReservation" WHERE "sessionId"=NEW.id) THEN RAISE EXCEPTION 'Capacity cannot be smaller than existing reservations'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER session_capacity BEFORE UPDATE OF capacity ON "TASession" FOR EACH ROW EXECUTE FUNCTION validate_session_capacity();
