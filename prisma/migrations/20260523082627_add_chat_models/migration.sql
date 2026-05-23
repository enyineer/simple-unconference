-- CreateTable
CREATE TABLE "conversations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "identity_id_low" INTEGER NOT NULL,
    "identity_id_high" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "accepted_at" DATETIME,
    "last_message_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversations_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conversations_identity_id_low_fkey" FOREIGN KEY ("identity_id_low") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conversations_identity_id_high_fkey" FOREIGN KEY ("identity_id_high") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conversation_id" INTEGER NOT NULL,
    "sender_identity_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" DATETIME,
    "deleted_at" DATETIME,
    "deleted_reason" TEXT,
    "read_at" DATETIME,
    CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "messages_sender_identity_id_fkey" FOREIGN KEY ("sender_identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "message_revisions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "message_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "message_reports" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "message_id" INTEGER NOT NULL,
    "reporter_identity_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" DATETIME,
    "resolved_by_user_id" INTEGER,
    "action" TEXT,
    CONSTRAINT "message_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "message_reports_reporter_identity_id_fkey" FOREIGN KEY ("reporter_identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "message_reports_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chat_blocks" (
    "blocker_identity_id" INTEGER NOT NULL,
    "blocked_identity_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("blocker_identity_id", "blocked_identity_id"),
    CONSTRAINT "chat_blocks_blocker_identity_id_fkey" FOREIGN KEY ("blocker_identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chat_blocks_blocked_identity_id_fkey" FOREIGN KEY ("blocked_identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "avatar_hash" TEXT,
    "profile_completion_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "chat_enabled" BOOLEAN NOT NULL DEFAULT true,
    "chat_read_receipts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "chat_banned_at" DATETIME,
    "chat_banned_reason" TEXT,
    "chat_banned_by_user_id" INTEGER,
    CONSTRAINT "conference_identities_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_chat_banned_by_user_id_fkey" FOREIGN KEY ("chat_banned_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_conference_identities" ("avatar_hash", "avatar_path", "bio", "calendar_token", "claimed_at", "color_mode", "company", "conference_id", "created_at", "email", "id", "name", "owner_user_id", "password_hash", "profile_completion_dismissed", "profile_published", "pronouns", "role", "title") SELECT "avatar_hash", "avatar_path", "bio", "calendar_token", "claimed_at", "color_mode", "company", "conference_id", "created_at", "email", "id", "name", "owner_user_id", "password_hash", "profile_completion_dismissed", "profile_published", "pronouns", "role", "title" FROM "conference_identities";
DROP TABLE "conference_identities";
ALTER TABLE "new_conference_identities" RENAME TO "conference_identities";
CREATE UNIQUE INDEX "conference_identities_calendar_token_key" ON "conference_identities"("calendar_token");
CREATE INDEX "conference_identities_conference_id_idx" ON "conference_identities"("conference_id");
CREATE INDEX "conference_identities_owner_user_id_idx" ON "conference_identities"("owner_user_id");
CREATE UNIQUE INDEX "conference_identities_conference_id_email_key" ON "conference_identities"("conference_id", "email");
CREATE TABLE "new_notifications" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "identity_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "cta_label" TEXT,
    "cta_href" TEXT,
    "read_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupe_key" TEXT,
    "unread_count" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "notifications_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_notifications" ("body", "created_at", "cta_href", "cta_label", "id", "identity_id", "kind", "read_at", "title") SELECT "body", "created_at", "cta_href", "cta_label", "id", "identity_id", "kind", "read_at", "title" FROM "notifications";
DROP TABLE "notifications";
ALTER TABLE "new_notifications" RENAME TO "notifications";
CREATE INDEX "notifications_identity_id_read_at_idx" ON "notifications"("identity_id", "read_at");
CREATE INDEX "notifications_identity_id_created_at_idx" ON "notifications"("identity_id", "created_at");
CREATE UNIQUE INDEX "notifications_identity_dedupe_uniq" ON "notifications"("identity_id", "dedupe_key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "conversations_conference_id_last_message_at_idx" ON "conversations"("conference_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_identity_id_low_last_message_at_idx" ON "conversations"("identity_id_low", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_identity_id_high_last_message_at_idx" ON "conversations"("identity_id_high", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_conference_id_identity_id_low_identity_id_high_key" ON "conversations"("conference_id", "identity_id_low", "identity_id_high");

-- CreateIndex
CREATE INDEX "messages_conversation_id_id_idx" ON "messages"("conversation_id", "id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "message_revisions_message_id_created_at_idx" ON "message_revisions"("message_id", "created_at");

-- CreateIndex
CREATE INDEX "message_reports_resolved_at_created_at_idx" ON "message_reports"("resolved_at", "created_at");

-- CreateIndex
CREATE INDEX "chat_blocks_blocked_identity_id_idx" ON "chat_blocks"("blocked_identity_id");
