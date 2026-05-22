-- Path C refactor: drop StaticStar entirely; require submission_id on every
-- TrackAssignment; drop the now-redundant TrackAssignment.title column.
--
-- The participant's "I want this on my schedule" signal collapses to a single
-- Star on Submission. The MyAssignments derivation joins TrackAssignments
-- against the user's submission stars instead of carrying a parallel
-- StaticStar table.
--
-- PREREQUISITE FOR PROD: every TrackAssignment must have a non-null
-- `submission_id` BEFORE this migration runs (the schema flips it to NOT NULL
-- below). Custom-title tracks are no longer allowed — the operator must
-- convert each into a Submission first. The INSERT into new_track_assignments
-- will fail with a NOT NULL violation if any null rows remain, which surfaces
-- the problem clearly.

-- Mirror every StaticStar into the Submission `stars` table so the user's
-- "going to this planned track" intent survives as "starred this submission."
-- INSERT OR IGNORE keeps it idempotent against re-runs and against users who
-- already starred the submission directly.
INSERT OR IGNORE INTO "stars" ("user_id", "submission_id", "created_at")
SELECT ss."user_id", ta."submission_id", CURRENT_TIMESTAMP
FROM "static_stars" ss
JOIN "track_assignments" ta ON ta."id" = ss."track_id"
WHERE ta."submission_id" IS NOT NULL;

-- Wipe the now-redundant StaticStar rows so the DropTable below succeeds.
DELETE FROM "static_stars";

-- DropIndex
DROP INDEX "static_stars_track_id_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "static_stars";
PRAGMA foreign_keys=on;

-- RedefineTables: TrackAssignment loses `title`, gains NOT NULL submission_id,
-- and the FK now cascades on submission delete (was SetNull — meaningless now
-- that the column is required).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_track_assignments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slot_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,
    "speakers" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "track_assignments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "track_assignments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "track_assignments_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_track_assignments" ("id", "mandatory", "room_id", "slot_id", "speakers", "submission_id") SELECT "id", "mandatory", "room_id", "slot_id", "speakers", "submission_id" FROM "track_assignments";
DROP TABLE "track_assignments";
ALTER TABLE "new_track_assignments" RENAME TO "track_assignments";
CREATE INDEX "track_assignments_submission_id_idx" ON "track_assignments"("submission_id");
CREATE UNIQUE INDEX "track_assignments_slot_id_room_id_key" ON "track_assignments"("slot_id", "room_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
