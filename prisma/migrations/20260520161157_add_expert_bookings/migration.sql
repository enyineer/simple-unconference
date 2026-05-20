-- CreateTable
CREATE TABLE "expert_room_pools" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expert_room_pools_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "expert_room_pool_rooms" (
    "pool_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,

    PRIMARY KEY ("pool_id", "room_id"),
    CONSTRAINT "expert_room_pool_rooms_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "expert_room_pools" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "expert_room_pool_rooms_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "experts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "conference_id" INTEGER NOT NULL,
    "identity_id" INTEGER NOT NULL,
    "pool_id" INTEGER,
    "bio" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experts_conference_id_fkey" FOREIGN KEY ("conference_id") REFERENCES "conferences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "experts_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "experts_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "expert_room_pools" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "expert_rooms" (
    "expert_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,

    PRIMARY KEY ("expert_id", "room_id"),
    CONSTRAINT "expert_rooms_expert_id_fkey" FOREIGN KEY ("expert_id") REFERENCES "experts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "expert_rooms_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "expert_timeframes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "expert_id" INTEGER NOT NULL,
    "starts_at" DATETIME NOT NULL,
    "ends_at" DATETIME NOT NULL,
    "slot_duration_minutes" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expert_timeframes_expert_id_fkey" FOREIGN KEY ("expert_id") REFERENCES "experts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "expert_bookings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "expert_id" INTEGER NOT NULL,
    "timeframe_id" INTEGER NOT NULL,
    "booker_id" INTEGER NOT NULL,
    "room_id" INTEGER NOT NULL,
    "starts_at" DATETIME NOT NULL,
    "ends_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expert_bookings_expert_id_fkey" FOREIGN KEY ("expert_id") REFERENCES "experts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "expert_bookings_timeframe_id_fkey" FOREIGN KEY ("timeframe_id") REFERENCES "expert_timeframes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "expert_bookings_booker_id_fkey" FOREIGN KEY ("booker_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "expert_bookings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "expert_room_pools_conference_id_idx" ON "expert_room_pools"("conference_id");

-- CreateIndex
CREATE UNIQUE INDEX "expert_room_pools_conference_id_name_key" ON "expert_room_pools"("conference_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "experts_identity_id_key" ON "experts"("identity_id");

-- CreateIndex
CREATE INDEX "experts_conference_id_idx" ON "experts"("conference_id");

-- CreateIndex
CREATE INDEX "expert_timeframes_expert_id_idx" ON "expert_timeframes"("expert_id");

-- CreateIndex
CREATE INDEX "expert_bookings_room_id_starts_at_idx" ON "expert_bookings"("room_id", "starts_at");

-- CreateIndex
CREATE INDEX "expert_bookings_expert_id_idx" ON "expert_bookings"("expert_id");

-- CreateIndex
CREATE INDEX "expert_bookings_booker_id_idx" ON "expert_bookings"("booker_id");

-- CreateIndex
CREATE UNIQUE INDEX "expert_bookings_expert_id_starts_at_key" ON "expert_bookings"("expert_id", "starts_at");
