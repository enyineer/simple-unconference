-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_submissions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "submitter_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "max_placements" INTEGER,
    "manually_finished" BOOLEAN NOT NULL DEFAULT false,
    "pre_assigned_room_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "submissions_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "submissions_submitter_id_fkey" FOREIGN KEY ("submitter_id") REFERENCES "conference_identities" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "submissions_pre_assigned_room_id_fkey" FOREIGN KEY ("pre_assigned_room_id") REFERENCES "rooms" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_submissions" ("conference_id", "created_at", "description", "id", "manually_finished", "max_placements", "status", "submitter_id", "title") SELECT "conference_id", "created_at", "description", "id", "manually_finished", "max_placements", "status", "submitter_id", "title" FROM "submissions";
DROP TABLE "submissions";
ALTER TABLE "new_submissions" RENAME TO "submissions";
CREATE INDEX "submissions_conference_id_idx" ON "submissions"("conference_id");
CREATE INDEX "submissions_conference_id_status_idx" ON "submissions"("conference_id", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
