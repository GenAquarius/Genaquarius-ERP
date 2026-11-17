const { PrismaClient } = require("/node_modules/@prisma/client");
const prisma = new PrismaClient();
(async () => {
  try {
    await prisma.$executeRawUnsafe("ALTER TABLE `timesheet` ADD COLUMN `billableHours` DOUBLE NOT NULL DEFAULT 0");
    console.log("timesheet.billableHours added");
  } catch (e) { console.log("timesheet.billableHours FAILED: " + e.message); }
  try {
    await prisma.$executeRawUnsafe("ALTER TABLE `timesheetentry` ADD COLUMN `billable` BOOLEAN NOT NULL DEFAULT true");
    console.log("timesheetentry.billable added");
  } catch (e) { console.log("timesheetentry.billable FAILED: " + e.message); }
  // Required one-time backfill: pre-existing rows get billableHours = totalHours (nothing was
  // ever marked non-billable before this feature existed, so this is exactly correct — NOT a
  // fallback masking a genuinely-all-non-billable month, since no such month can exist yet).
  try {
    const r = await prisma.$executeRawUnsafe("UPDATE `timesheet` SET `billableHours` = `totalHours` WHERE `billableHours` = 0 AND `totalHours` > 0");
    console.log("backfill billableHours=totalHours affected rows: " + r);
  } catch (e) { console.log("backfill FAILED: " + e.message); }
  await prisma.$disconnect();
})();
