-- Normalize every user-set instant (agenda slots, expert timeframes,
-- expert bookings) to whole minutes. The UI's time pickers and labels
-- render at minute granularity, but some legacy rows ended up with
-- sub-minute precision (e.g. createSlot via the test helpers using
-- Date.now()). That made overlap / conflict detection see touching-edge
-- slots as ~30s overlaps and render side-by-side, even though the labels
-- read as adjacent.
--
-- All future writes go through `clipToMinute` on the server side, so this
-- one-time normalization stays valid going forward.
--
-- Prisma serializes DateTime to SQLite as ISO-8601 text in the form
-- "YYYY-MM-DDTHH:MM:SS.SSS+00:00" (29 chars). Positions 1..17 are
-- "YYYY-MM-DDTHH:MM:"; positions 18..23 are "SS.SSS"; positions 24..29
-- are "+00:00". Substituting positions 18..23 with "00.000" floors to
-- the minute without changing the timezone offset.

UPDATE "agenda_slots"
SET "starts_at" = substr("starts_at", 1, 17) || '00.000' || substr("starts_at", 24),
    "ends_at"   = substr("ends_at",   1, 17) || '00.000' || substr("ends_at",   24);

UPDATE "expert_timeframes"
SET "starts_at" = substr("starts_at", 1, 17) || '00.000' || substr("starts_at", 24),
    "ends_at"   = substr("ends_at",   1, 17) || '00.000' || substr("ends_at",   24);

UPDATE "expert_bookings"
SET "starts_at" = substr("starts_at", 1, 17) || '00.000' || substr("starts_at", 24),
    "ends_at"   = substr("ends_at",   1, 17) || '00.000' || substr("ends_at",   24);
