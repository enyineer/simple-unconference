-- CreateTable
CREATE TABLE "slot_series" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "unconf_use_all_rooms" BOOLEAN NOT NULL DEFAULT true,
    "unconf_use_all_submissions" BOOLEAN NOT NULL DEFAULT true,
    "unconf_avoid_repeats" BOOLEAN NOT NULL DEFAULT true,
    "mixer_avoid_repeats" BOOLEAN,
    "avoid_repeats_across_siblings" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "slot_series_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "series_rooms" (
    "series_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,

    PRIMARY KEY ("series_id", "room_id"),
    CONSTRAINT "series_rooms_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "slot_series" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "series_rooms_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "series_submissions" (
    "series_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,

    PRIMARY KEY ("series_id", "submission_id"),
    CONSTRAINT "series_submissions_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "slot_series" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "series_submissions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agenda_slots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "starts_at" DATETIME NOT NULL,
    "ends_at" DATETIME NOT NULL,
    "unconf_use_all_rooms" BOOLEAN NOT NULL DEFAULT true,
    "unconf_use_all_submissions" BOOLEAN NOT NULL DEFAULT true,
    "unconf_avoid_repeats" BOOLEAN NOT NULL DEFAULT true,
    "mixer_avoid_repeats" BOOLEAN,
    "series_id" INTEGER,
    CONSTRAINT "agenda_slots_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agenda_slots_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "slot_series" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_agenda_slots" ("conference_id", "description", "ends_at", "id", "mixer_avoid_repeats", "starts_at", "title", "type", "unconf_avoid_repeats", "unconf_use_all_rooms", "unconf_use_all_submissions") SELECT "conference_id", "description", "ends_at", "id", "mixer_avoid_repeats", "starts_at", "title", "type", "unconf_avoid_repeats", "unconf_use_all_rooms", "unconf_use_all_submissions" FROM "agenda_slots";
DROP TABLE "agenda_slots";
ALTER TABLE "new_agenda_slots" RENAME TO "agenda_slots";
CREATE INDEX "agenda_slots_conference_id_starts_at_idx" ON "agenda_slots"("conference_id", "starts_at");
CREATE INDEX "agenda_slots_series_id_idx" ON "agenda_slots"("series_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "slot_series_conference_id_idx" ON "slot_series"("conference_id");
