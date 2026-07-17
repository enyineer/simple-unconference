-- CreateTable
CREATE TABLE "session_takeaways" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submission_id" INTEGER NOT NULL,
    "identity_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "url" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_takeaways_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "session_takeaways_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_conferences" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "design_system" TEXT NOT NULL DEFAULT 'github',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "mixer_avoid_repeats_default" BOOLEAN NOT NULL DEFAULT true,
    "submission_max_placements_default" INTEGER DEFAULT 1,
    "participant_submissions_enabled" BOOLEAN NOT NULL DEFAULT true,
    "board_token" TEXT,
    "spotlight_submission_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conferences_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conferences_spotlight_submission_id_fkey" FOREIGN KEY ("spotlight_submission_id") REFERENCES "submissions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conferences" ("created_at", "design_system", "id", "mixer_avoid_repeats_default", "name", "owner_id", "participant_submissions_enabled", "slug", "submission_max_placements_default", "timezone") SELECT "created_at", "design_system", "id", "mixer_avoid_repeats_default", "name", "owner_id", "participant_submissions_enabled", "slug", "submission_max_placements_default", "timezone" FROM "conferences";
DROP TABLE "conferences";
ALTER TABLE "new_conferences" RENAME TO "conferences";
CREATE UNIQUE INDEX "conferences_slug_key" ON "conferences"("slug");
CREATE UNIQUE INDEX "conferences_board_token_key" ON "conferences"("board_token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "session_takeaways_submission_id_idx" ON "session_takeaways"("submission_id");
