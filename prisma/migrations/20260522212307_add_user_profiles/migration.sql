-- CreateTable
CREATE TABLE "profile_entries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "identity_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "href" TEXT,
    "category" TEXT NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "profile_entries_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "profile_tags" (
    "identity_id" INTEGER NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("identity_id", "tag"),
    CONSTRAINT "profile_tags_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_conference_identities" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "color_mode" TEXT NOT NULL DEFAULT 'auto',
    "calendar_token" TEXT,
    "owner_user_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" DATETIME,
    "profile_published" BOOLEAN NOT NULL DEFAULT false,
    "bio" TEXT,
    "pronouns" TEXT,
    "title" TEXT,
    "company" TEXT,
    "avatar_path" TEXT,
    "profile_completion_dismissed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "conference_identities_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conference_identities" ("calendar_token", "claimed_at", "color_mode", "conference_id", "created_at", "email", "id", "name", "owner_user_id", "password_hash", "role") SELECT "calendar_token", "claimed_at", "color_mode", "conference_id", "created_at", "email", "id", "name", "owner_user_id", "password_hash", "role" FROM "conference_identities";
DROP TABLE "conference_identities";
ALTER TABLE "new_conference_identities" RENAME TO "conference_identities";
CREATE UNIQUE INDEX "conference_identities_calendar_token_key" ON "conference_identities"("calendar_token");
CREATE INDEX "conference_identities_conference_id_idx" ON "conference_identities"("conference_id");
CREATE INDEX "conference_identities_owner_user_id_idx" ON "conference_identities"("owner_user_id");
CREATE UNIQUE INDEX "conference_identities_conference_id_email_key" ON "conference_identities"("conference_id", "email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "profile_entries_identity_id_idx" ON "profile_entries"("identity_id");

-- CreateIndex
CREATE INDEX "profile_tags_identity_id_idx" ON "profile_tags"("identity_id");
