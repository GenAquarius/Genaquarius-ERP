// One-off data migration (HR-requested): existing Holiday rows were all Company Default
// (businessUnitId null). Since today there's exactly one Business Unit per country, reassign
// each country's holidays to become that BU's own calendar instead of a generic default —
// looked up by countryCode (not hardcoded ids) so this is safe to run on any environment.
// Idempotent: only touches rows that are still businessUnitId IS NULL, so re-running after a
// BU has since customized its own calendar never clobbers that edit.
import { prisma } from "../prisma";

export async function main() {
  const bus = await prisma.hrBusinessUnit.findMany();
  let totalMoved = 0;
  for (const bu of bus) {
    const country = bu.countryCode.toUpperCase();
    // Only move a country's default holidays into the FIRST/only BU for that country — if a
    // country ever has more than one BU, this picks the lowest id and leaves the rest alone
    // (skip so a human decides how to split them, rather than guessing).
    const busForCountry = bus.filter((b) => b.countryCode.toUpperCase() === country);
    if (busForCountry.length > 1 && busForCountry[0].id !== bu.id) continue;
    const { count } = await prisma.holiday.updateMany({ where: { country, businessUnitId: null }, data: { businessUnitId: bu.id } });
    if (count) { totalMoved += count; console.log(`Moved ${count} ${country} holiday(s) to Business Unit "${bu.name}" (id ${bu.id})`); }
  }
  const msg = totalMoved ? `Migrated ${totalMoved} holiday(s) to their matching Business Unit.` : "No Company Default holidays left to migrate.";
  console.log(msg);
  return msg;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
