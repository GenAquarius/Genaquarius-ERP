const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
  const logs = await prisma.auditLog.findMany({
    where: { at: { gte: startOfToday } },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { at: "asc" },
  });
  console.log("TODAY_AUDIT_COUNT", logs.length);
  console.log("TODAY_AUDIT_ROWS", JSON.stringify(logs.map(l => ({ at: l.at, user: l.user?.name || l.user?.email || null, action: l.action, entity: l.entity, entityId: l.entityId, after: l.after }))));

  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear: "FY26-27", month: "Sep" } }, include: { lines: true } });
  let rev = 0, cost = 0;
  for (const l of sheet.lines) { if (!l.isExpense) rev += l.invoiceAmount || 0; cost += l.costUsd || 0; }
  console.log("SEP_NOW", JSON.stringify({ revenue: Math.round(rev), cost: Math.round(cost), profit: Math.round(rev - cost), lineCount: sheet.lines.length, status: sheet.status, createdAt: sheet.createdAt }));

  console.log("DONE_MARKER");
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
