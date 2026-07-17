-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "identity_id" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_subscriptions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "push_subscriptions_identity_id_idx" ON "push_subscriptions"("identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_identity_id_endpoint_key" ON "push_subscriptions"("identity_id", "endpoint");
