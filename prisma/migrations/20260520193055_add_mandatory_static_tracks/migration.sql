-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_track_assignments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slot_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,
    "submission_id" INTEGER,
    "title" TEXT,
    "speakers" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "track_assignments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "track_assignments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "track_assignments_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_track_assignments" ("id", "room_id", "slot_id", "speakers", "submission_id", "title") SELECT "id", "room_id", "slot_id", "speakers", "submission_id", "title" FROM "track_assignments";
DROP TABLE "track_assignments";
ALTER TABLE "new_track_assignments" RENAME TO "track_assignments";
CREATE UNIQUE INDEX "track_assignments_slot_id_room_id_key" ON "track_assignments"("slot_id", "room_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
