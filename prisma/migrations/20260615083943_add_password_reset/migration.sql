-- AlterTable
ALTER TABLE "conference_identities" ADD COLUMN "password_reset_expires_at" DATETIME;
ALTER TABLE "conference_identities" ADD COLUMN "password_reset_token_hash" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "password_reset_expires_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "password_reset_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "conference_identities_password_reset_token_hash_key" ON "conference_identities"("password_reset_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "users_password_reset_token_hash_key" ON "users"("password_reset_token_hash");

