import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { MONTHS } from "../../engine/calc";

// F5 — Fiscal year definition + lock / rollover.
//
//   GET  /fiscal-years                 -> list
//   POST /fiscal-years {label,startMonth} -> create
//   POST /fiscal-years/:id/lock        -> status LOCKED + lock every MonthlySheet of that FY
//   POST /fiscal-years/:id/unlock      -> reverse (status OPEN + sheets back to DRAFT)
//   POST /fiscal-years/:id/rollover    -> create the NEXT fiscal year + seed its 12 DRAFT sheets
//   POST /fiscal-years/rollover {fromLabel} -> same, addressed by label
const router = Router();
router.use(requireAdmin);

// FY26-27 -> FY27-28
function nextLabel(label: string): string {
  const m = label.match(/FY(\d+)-(\d+)/i);
  if (!m) return label + " (next)";
  return `FY${+m[1] + 1}-${+m[2] + 1}`;
}

// seed the 12 DRAFT MonthlySheets (Apr..Mar) for a fiscal year, skipping any that exist
async function seedSheets(fiscalYear: string, userId?: number) {
  const existing = await prisma.monthlySheet.findMany({ where: { fiscalYear }, select: { month: true } });
  const have = new Set(existing.map((s) => s.month));
  const toCreate = MONTHS
    .map((month, i) => ({ fiscalYear, month, monthIndex: i + 1, status: "DRAFT" as const, createdById: userId ?? null }))
    .filter((s) => !have.has(s.month));
  if (toCreate.length) await prisma.monthlySheet.createMany({ data: toCreate });
  return toCreate.length;
}

// --- list (self-healing) ---
// Any fiscal year that already has data (MonthlySheets) but no FiscalYear row yet
// is auto-registered as OPEN, so existing & past years always appear in every
// dropdown (dashboard, monthly, Excel export) — not just ones added by hand.
router.get("/", requireAdmin, async (_req, res) => {
  const sheetFys = await prisma.monthlySheet.findMany({ distinct: ["fiscalYear"], select: { fiscalYear: true } });
  const existing = await prisma.fiscalYear.findMany({ select: { label: true } });
  const have = new Set(existing.map((f) => f.label));
  const missing = sheetFys.map((s) => s.fiscalYear).filter((l) => l && !have.has(l));
  if (missing.length) {
    await prisma.fiscalYear.createMany({ data: missing.map((label) => ({ label, startMonth: 4, status: "OPEN" })), skipDuplicates: true });
  }
  res.json(await prisma.fiscalYear.findMany({ orderBy: { label: "desc" } }));
});

// --- delete an OPEN fiscal year (only if it carries no data) ---
router.delete("/:id", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const fy = await prisma.fiscalYear.findUnique({ where: { id: Number(req.params.id) } });
  if (!fy) return res.status(404).json({ error: "Fiscal year not found" });
  if (fy.status === "LOCKED") return res.status(400).json({ error: "This fiscal year is locked. Unlock it first." });
  // refuse if any of its monthly sheets actually contain rows (protect real data)
  const sheets = await prisma.monthlySheet.findMany({ where: { fiscalYear: fy.label }, select: { id: true, _count: { select: { lines: true } } } });
  const withData = sheets.filter((s) => s._count.lines > 0);
  if (withData.length) return res.status(400).json({ error: `Cannot delete — ${withData.length} month(s) still have data. Clear those months first.` });
  // delete the empty seeded sheets, then the fiscal year row
  await prisma.monthlySheet.deleteMany({ where: { fiscalYear: fy.label } });
  await prisma.fiscalYear.delete({ where: { id: fy.id } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "DELETE_FY", entity: "FiscalYear", entityId: String(fy.id), before: { label: fy.label } } }).catch(() => {});
  res.json({ ok: true });
});

// --- create ---
router.post("/", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const label = String(req.body.label || "").trim();
  if (!label) return res.status(400).json({ error: "Label is required (e.g. FY26-27)" });
  const startMonth = Number(req.body.startMonth) || 4;
  try {
    const fy = await prisma.fiscalYear.create({ data: { label, startMonth, status: "OPEN" } });
    res.status(201).json(fy);
  } catch {
    res.status(400).json({ error: `Fiscal year "${label}" already exists.` });
  }
});

// --- lock: freeze the FY and every one of its monthly sheets ---
router.post("/:id/lock", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const fy = await prisma.fiscalYear.findUnique({ where: { id: Number(req.params.id) } });
  if (!fy) return res.status(404).json({ error: "Fiscal year not found" });
  const [updated] = await prisma.$transaction([
    prisma.fiscalYear.update({ where: { id: fy.id }, data: { status: "LOCKED", closedAt: new Date() } }),
    prisma.monthlySheet.updateMany({ where: { fiscalYear: fy.label }, data: { status: "LOCKED", lockedAt: new Date() } }),
  ]);
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "LOCK_FY", entity: "FiscalYear", entityId: String(fy.id), after: { label: fy.label } } }).catch(() => {});
  res.json(updated);
});

// --- unlock: re-open the FY and its sheets ---
router.post("/:id/unlock", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const fy = await prisma.fiscalYear.findUnique({ where: { id: Number(req.params.id) } });
  if (!fy) return res.status(404).json({ error: "Fiscal year not found" });
  const [updated] = await prisma.$transaction([
    prisma.fiscalYear.update({ where: { id: fy.id }, data: { status: "OPEN", closedAt: null } }),
    prisma.monthlySheet.updateMany({ where: { fiscalYear: fy.label }, data: { status: "DRAFT", lockedAt: null } }),
  ]);
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "UNLOCK_FY", entity: "FiscalYear", entityId: String(fy.id), after: { label: fy.label } } }).catch(() => {});
  res.json(updated);
});

// --- rollover by id: create the next FY + seed its 12 DRAFT sheets ---
router.post("/:id/rollover", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const fy = await prisma.fiscalYear.findUnique({ where: { id: Number(req.params.id) } });
  if (!fy) return res.status(404).json({ error: "Fiscal year not found" });
  return doRollover(fy.label, fy.startMonth, req, res);
});

// --- rollover by label ---
router.post("/rollover", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const fromLabel = String(req.body.fromLabel || "").trim();
  if (!fromLabel) return res.status(400).json({ error: "fromLabel is required" });
  const fy = await prisma.fiscalYear.findUnique({ where: { label: fromLabel } });
  return doRollover(fromLabel, fy?.startMonth || 4, req, res);
});

async function doRollover(fromLabel: string, startMonth: number, req: any, res: any) {
  const label = nextLabel(fromLabel);
  const created = await prisma.fiscalYear.upsert({
    where: { label },
    update: {},
    create: { label, startMonth, status: "OPEN" },
  });
  const seeded = await seedSheets(label, req.user?.id);
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "ROLLOVER_FY", entity: "FiscalYear", entityId: String(created.id), after: { from: fromLabel, to: label, seededSheets: seeded } } }).catch(() => {});
  res.status(201).json({ fiscalYear: created, seededSheets: seeded });
}

export default router;
