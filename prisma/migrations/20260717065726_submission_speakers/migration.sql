-- CreateTable
CREATE TABLE "submission_speakers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submission_id" INTEGER NOT NULL,
    "identity_id" INTEGER,
    "name" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "submission_speakers_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "submission_speakers_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "conference_identities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "submission_speakers_submission_id_idx" ON "submission_speakers"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_speakers_submission_id_identity_id_key" ON "submission_speakers"("submission_id", "identity_id");
