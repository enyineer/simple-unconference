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
    "password_reset_token_hash" TEXT,
    "password_reset_expires_at" DATETIME,
    "linked_user_id" INTEGER,
    "profile_published" BOOLEAN NOT NULL DEFAULT false,
    "bio" TEXT,
    "pronouns" TEXT,
    "title" TEXT,
    "company" TEXT,
    "avatar_path" TEXT,
    "avatar_hash" TEXT,
    "profile_completion_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "chat_enabled" BOOLEAN NOT NULL DEFAULT true,
    "chat_read_receipts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "chat_banned_at" DATETIME,
    "chat_banned_reason" TEXT,
    "chat_banned_by_user_id" INTEGER,
    CONSTRAINT "conference_identities_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_linked_user_id_fkey" FOREIGN KEY ("linked_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_chat_banned_by_user_id_fkey" FOREIGN KEY ("chat_banned_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conference_identities" ("avatar_hash", "avatar_path", "bio", "calendar_token", "chat_banned_at", "chat_banned_by_user_id", "chat_banned_reason", "chat_enabled", "chat_read_receipts_enabled", "claimed_at", "color_mode", "company", "conference_id", "created_at", "email", "id", "name", "owner_user_id", "password_hash", "password_reset_expires_at", "password_reset_token_hash", "profile_completion_dismissed", "profile_published", "pronouns", "role", "title") SELECT "avatar_hash", "avatar_path", "bio", "calendar_token", "chat_banned_at", "chat_banned_by_user_id", "chat_banned_reason", "chat_enabled", "chat_read_receipts_enabled", "claimed_at", "color_mode", "company", "conference_id", "created_at", "email", "id", "name", "owner_user_id", "password_hash", "password_reset_expires_at", "password_reset_token_hash", "profile_completion_dismissed", "profile_published", "pronouns", "role", "title" FROM "conference_identities";
DROP TABLE "conference_identities";
ALTER TABLE "new_conference_identities" RENAME TO "conference_identities";
CREATE UNIQUE INDEX "conference_identities_calendar_token_key" ON "conference_identities"("calendar_token");
CREATE UNIQUE INDEX "conference_identities_password_reset_token_hash_key" ON "conference_identities"("password_reset_token_hash");
CREATE INDEX "conference_identities_conference_id_idx" ON "conference_identities"("conference_id");
CREATE INDEX "conference_identities_owner_user_id_idx" ON "conference_identities"("owner_user_id");
CREATE INDEX "conference_identities_linked_user_id_idx" ON "conference_identities"("linked_user_id");
CREATE UNIQUE INDEX "conference_identities_conference_id_email_key" ON "conference_identities"("conference_id", "email");
CREATE TABLE "new_users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "password_reset_token_hash" TEXT,
    "password_reset_expires_at" DATETIME,
    "email_verified_at" DATETIME,
    "email_verify_token_hash" TEXT,
    "email_verify_link_expires_at" DATETIME,
    "email_verify_code_hash" TEXT,
    "email_verify_code_expires_at" DATETIME,
    "email_verify_attempts" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_users" ("created_at", "email", "id", "name", "password_hash", "password_reset_expires_at", "password_reset_token_hash") SELECT "created_at", "email", "id", "name", "password_hash", "password_reset_expires_at", "password_reset_token_hash" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_password_reset_token_hash_key" ON "users"("password_reset_token_hash");
CREATE UNIQUE INDEX "users_email_verify_token_hash_key" ON "users"("email_verify_token_hash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Data backfill (added by hand on top of the Prisma-generated DDL above).
-- Critical: the table rebuild copies existing rows with the new columns NULL,
-- which would (a) wall every current owner behind email verification and
-- (b) drop the owner<->identity link. Grandfather both:
--   1. Treat every pre-existing account as already email-verified.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
--   2. Make the owner's auto-minted identity uniformly "linked" so principal
--      resolution has a single code path (linkedUserId), not two.
UPDATE "conference_identities" SET "linked_user_id" = "owner_user_id" WHERE "owner_user_id" IS NOT NULL;

