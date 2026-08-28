UPDATE "rooms"
SET "allow_guests" = false
WHERE "kind" = 'direct' AND "allow_guests" = true;
