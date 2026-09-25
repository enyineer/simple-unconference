// One-off simulation: replay "Update seating" (agenda.assignAll) against a
// production snapshot copy — no HTTP, no notifications (this bypasses the RPC
// handler, which is where bell rows are created). Read-only apart from the
// UserAssignment/staleness writes the seating itself performs.
//
// Usage: bun scripts/sim-seating.ts <dbUrl> <slug> [slug...]
// Example:
//   bun scripts/sim-seating.ts file:./data/prod-sim.sqlite offsite-nachbesprechung devday

import { newPrisma } from "../src/server/db";
import { runAssignmentForAgenda } from "../src/server/rpc/agenda";

const [dbUrl, ...slugs] = process.argv.slice(2);
if (!dbUrl || slugs.length === 0) {
  console.error("usage: bun scripts/sim-seating.ts <dbUrl> <slug> [slug...]");
  process.exit(1);
}

const prisma = newPrisma(dbUrl);

for (const slug of slugs) {
  const conf = await prisma.conference.findUniqueOrThrow({
    where: { slug },
    select: { id: true, name: true },
  });
  const pre = await prisma.userAssignment.count({
    where: { slot: { conferenceId: conf.id } },
  });
  const r = await runAssignmentForAgenda(prisma, conf.id, {
    includeUnchanged: true,
  });
  const post = await prisma.userAssignment.count({
    where: { slot: { conferenceId: conf.id } },
  });
  console.log(`\n=== ${slug} (${conf.name}, conf ${conf.id}) ===`);
  console.log(`re-seated slots: ${JSON.stringify(r.slot_ids)}`);
  console.log(`seats total: ${pre} -> ${post}`);
  console.log(`changed users: ${r.changed_user_ids.length}`);
  console.log(`unplaced (starred-but-no-seat, this run's targets): ${r.unplaced_users.length}`);
}

await prisma.$disconnect();
