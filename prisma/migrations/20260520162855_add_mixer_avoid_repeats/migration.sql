-- AlterTable
ALTER TABLE "agenda_slots" ADD COLUMN "mixer_avoid_repeats" BOOLEAN;

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
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conferences_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_conferences" ("created_at", "design_system", "id", "name", "owner_id", "slug", "timezone") SELECT "created_at", "design_system", "id", "name", "owner_id", "slug", "timezone" FROM "conferences";
DROP TABLE "conferences";
ALTER TABLE "new_conferences" RENAME TO "conferences";
CREATE UNIQUE INDEX "conferences_slug_key" ON "conferences"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
