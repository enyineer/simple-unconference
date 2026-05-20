-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "sessions" (
    "token" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER,
    "conference_identity_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sessions_conference_identity_id_fkey" FOREIGN KEY ("conference_identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conferences" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "design_system" TEXT NOT NULL DEFAULT 'github',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conferences_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conference_identities" (
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
    CONSTRAINT "conference_identities_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conference_identities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conference_invites" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "claimed_at" DATETIME,
    "claimed_by_identity_id" INTEGER,
    CONSTRAINT "conference_invites_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "conference_invites_claimed_by_identity_id_fkey" FOREIGN KEY ("claimed_by_identity_id") REFERENCES "conference_identities" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conference_join_links" (
    "conference_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" DATETIME,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" DATETIME,
    CONSTRAINT "conference_join_links_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "description" TEXT,
    CONSTRAINT "rooms_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "room_tags" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "room_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "room_tags_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "submitter_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "submissions_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "submissions_submitter_id_fkey" FOREIGN KEY ("submitter_id") REFERENCES "conference_identities" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "submission_tags" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submission_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "submission_tags_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "submission_requirements" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submission_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "submission_requirements_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stars" (
    "user_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("user_id", "submission_id"),
    CONSTRAINT "stars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stars_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agenda_slots" (
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
    CONSTRAINT "agenda_slots_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slot_rooms" (
    "slot_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,

    PRIMARY KEY ("slot_id", "room_id"),
    CONSTRAINT "slot_rooms_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "slot_rooms_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slot_submissions" (
    "slot_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,

    PRIMARY KEY ("slot_id", "submission_id"),
    CONSTRAINT "slot_submissions_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "slot_submissions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "track_assignments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slot_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,
    "submission_id" INTEGER,
    "title" TEXT,
    "speakers" TEXT,
    CONSTRAINT "track_assignments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "track_assignments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "track_assignments_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "track_requirements" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "track_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "track_requirements_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "track_assignments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "static_stars" (
    "user_id" INTEGER NOT NULL,
    "track_id" INTEGER NOT NULL,

    PRIMARY KEY ("user_id", "track_id"),
    CONSTRAINT "static_stars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "static_stars_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "track_assignments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "unconference_placements" (
    "slot_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,

    PRIMARY KEY ("slot_id", "submission_id"),
    CONSTRAINT "unconference_placements_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "unconference_placements_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "unconference_placements_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_assignments" (
    "slot_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "submission_id" INTEGER,
    "room_id" INTEGER,
    "manual" BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY ("slot_id", "user_id"),
    CONSTRAINT "user_assignments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "agenda_slots" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_assignments_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "user_assignments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_conference_identity_id_idx" ON "sessions"("conference_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "conferences_slug_key" ON "conferences"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "conference_identities_calendar_token_key" ON "conference_identities"("calendar_token");

-- CreateIndex
CREATE INDEX "conference_identities_conference_id_idx" ON "conference_identities"("conference_id");

-- CreateIndex
CREATE INDEX "conference_identities_owner_user_id_idx" ON "conference_identities"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conference_identities_conference_id_email_key" ON "conference_identities"("conference_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "conference_invites_token_key" ON "conference_invites"("token");

-- CreateIndex
CREATE INDEX "conference_invites_conference_id_idx" ON "conference_invites"("conference_id");

-- CreateIndex
CREATE INDEX "conference_invites_conference_id_email_idx" ON "conference_invites"("conference_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "conference_join_links_token_key" ON "conference_join_links"("token");

-- CreateIndex
CREATE INDEX "rooms_conference_id_idx" ON "rooms"("conference_id");

-- CreateIndex
CREATE INDEX "room_tags_room_id_idx" ON "room_tags"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_tags_room_id_value_key" ON "room_tags"("room_id", "value");

-- CreateIndex
CREATE INDEX "submissions_conference_id_idx" ON "submissions"("conference_id");

-- CreateIndex
CREATE INDEX "submissions_conference_id_status_idx" ON "submissions"("conference_id", "status");

-- CreateIndex
CREATE INDEX "submission_tags_submission_id_idx" ON "submission_tags"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_tags_submission_id_value_key" ON "submission_tags"("submission_id", "value");

-- CreateIndex
CREATE INDEX "submission_requirements_submission_id_idx" ON "submission_requirements"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_requirements_submission_id_value_key" ON "submission_requirements"("submission_id", "value");

-- CreateIndex
CREATE INDEX "stars_submission_id_idx" ON "stars"("submission_id");

-- CreateIndex
CREATE INDEX "agenda_slots_conference_id_starts_at_idx" ON "agenda_slots"("conference_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "track_assignments_slot_id_room_id_key" ON "track_assignments"("slot_id", "room_id");

-- CreateIndex
CREATE INDEX "track_requirements_track_id_idx" ON "track_requirements"("track_id");

-- CreateIndex
CREATE UNIQUE INDEX "track_requirements_track_id_value_key" ON "track_requirements"("track_id", "value");

-- CreateIndex
CREATE INDEX "static_stars_track_id_idx" ON "static_stars"("track_id");

-- CreateIndex
CREATE UNIQUE INDEX "unconference_placements_slot_id_room_id_key" ON "unconference_placements"("slot_id", "room_id");

-- CreateIndex
CREATE INDEX "user_assignments_user_id_idx" ON "user_assignments"("user_id");

-- CreateIndex
CREATE INDEX "user_assignments_user_id_submission_id_idx" ON "user_assignments"("user_id", "submission_id");
