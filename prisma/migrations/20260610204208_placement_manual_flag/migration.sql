-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_unconference_placements" (
    "slot_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY ("slot_id", "submission_id"),
    CONSTRAINT "unconference_placements_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "unconference_placements_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "unconference_placements_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_unconference_placements" ("room_id", "slot_id", "submission_id") SELECT "room_id", "slot_id", "submission_id" FROM "unconference_placements";
DROP TABLE "unconference_placements";
ALTER TABLE "new_unconference_placements" RENAME TO "unconference_placements";
CREATE UNIQUE INDEX "unconference_placements_slot_id_room_id_key" ON "unconference_placements"("slot_id", "room_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
