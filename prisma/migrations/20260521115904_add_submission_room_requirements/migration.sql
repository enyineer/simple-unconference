-- CreateTable
CREATE TABLE "submission_room_requirements" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submission_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "submission_room_requirements_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "submission_room_requirements_submission_id_idx" ON "submission_room_requirements"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_room_requirements_submission_id_value_key" ON "submission_room_requirements"("submission_id", "value");
