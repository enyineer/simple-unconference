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
    "board_days" TEXT,
    "board_skip_empty" BOOLEAN NOT NULL DEFAULT true,
    "icon_path" TEXT,
    "icon_hash" TEXT,
    "spotlight_submission_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conferences_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conferences_spotlight_submission_id_fkey" FOREIGN KEY ("spotlight_submission_id") REFERENCES "submissions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conferences" ("board_days", "board_token", "created_at", "design_system", "icon_hash", "icon_path", "id", "mixer_avoid_repeats_default", "name", "owner_id", "participant_submissions_enabled", "slug", "spotlight_submission_id", "submission_max_placements_default", "timezone") SELECT "board_days", "board_token", "created_at", "design_system", "icon_hash", "icon_path", "id", "mixer_avoid_repeats_default", "name", "owner_id", "participant_submissions_enabled", "slug", "spotlight_submission_id", "submission_max_placements_default", "timezone" FROM "conferences";
DROP TABLE "conferences";
ALTER TABLE "new_conferences" RENAME TO "conferences";
CREATE UNIQUE INDEX "conferences_slug_key" ON "conferences"("slug");
CREATE UNIQUE INDEX "conferences_board_token_key" ON "conferences"("board_token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
