import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { computeEmployeeCost, MONTHS } from "../../engine/calc";

// F4 — Employee per-month, per-project COST allocation.
//
// An allocation row says: "in <fiscalYear>/<month>, put <pct>% of <employee>'s
// monthly cost onto <project>". The grid the UI edits is 12 month-rows ×
// N project-columns; each month must total ~100% (or be left empty = unallocated).
//
// Endpoints:
//   GET  /allocations?employeeId=&fiscalYear=          -> raw rows
//   PUT  /allocations  {employeeId, fiscalYear, rows}  -> upsert whole grid
//   POST /allocations/apply {employeeId|all, fiscalYear} -> expand into MonthlyLine.costUsd
const router = Router();
router.use(requireAdmin);
router.use(requirePermission("employees")); // per-employee cost-allocation grid, opened from the Employees page

// allow a small rounding tolerance when validating that a month sums to 100
const TOL = 0.5;

// --- list the grid for one employee + fiscal year ---
router.get("/", requireAdmin, async (req, res) => {
  const employeeId = Number(req.query.employeeId);
  const fiscalYear = String(req.query.fiscalYear || "");
  if (!employeeId || !fiscalYear) return res.status(400).json({ error: "employeeId and fiscalYear are required" });
  const rows = await prisma.employeeCostAllocation.findMany({
    where: { employeeId, fiscalYear },
    include: { project: true },
    orderBy: [{ projectId: "asc" }],
  });
  // surface the employee's monthly cost so the UI can show cost = pct × monthlyCost
  const cost = await computeEmployeeCost(employeeId);
  const monthlyCostUsd = (cost?.annualUsd || 0) / 12;
  res.json({ employeeId, fiscalYear, monthlyCostUsd, rows });
});

// --- upsert the whole grid for one employee + fiscal year ---
// body: { employeeId, fiscalYear, rows: [{ month, projectId, pct }] }
// Validation: for each month that has any rows, the pct must sum to ~100.
router.put("/", requireAdmin, async (req, res) => {
  const employeeId = Number(req.body.employeeId);
  const fiscalYear = String(req.body.fiscalYear || "");
  const rows: { month: string; projectId: number; pct: number }[] = req.body.rows || [];
  if (!employeeId || !fiscalYear) return res.status(400).json({ error: "employeeId and fiscalYear are required" });

  // normalise + drop empty cells (pct 0/blank means "no allocation")
  const clean = rows
    .map((r) => ({ month: String(r.month), projectId: Number(r.projectId), pct: +r.pct || 0 }))
    .filter((r) => MONTHS.includes(r.month) && r.projectId && r.pct > 0);

  // validate each month totals ~100 (months with no rows are allowed = unallocated)
  const byMonth = new Map<string, number>();
  for (const r of clean) byMonth.set(r.month, (byMonth.get(r.month) || 0) + r.pct);
  for (const [month, total] of byMonth) {
    if (Math.abs(total - 100) > TOL)
      return res.status(400).json({ error: `${month} totals ${total.toFixed(1)}% — each allocated month must sum to 100%.` });
  }

  // replace this employee+FY's grid atomically
  await prisma.$transaction([
    prisma.employeeCostAllocation.deleteMany({ where: { employeeId, fiscalYear } }),
    ...(clean.length
      ? [prisma.employeeCostAllocation.createMany({
          data: clean.map((r) => ({ employeeId, fiscalYear, month: r.month, projectId: r.projectId, pct: r.pct })),
        })]
      : []),
  ]);

  // Sync project ASSIGNMENTS so the projects in this grid appear in the employee's
  // timesheet / approvals pickers (my-projects reads EmployeeProject). Additive —
  // we never unassign existing links here.
  const projIds = [...new Set(clean.map((r) => r.projectId))];
  if (projIds.length) {
    await prisma.employeeProject.createMany({
      data: projIds.map((projectId) => ({ employeeId, projectId })),
      skipDuplicates: true,
    });
  }

  const saved = await prisma.employeeCostAllocation.findMany({ where: { employeeId, fiscalYear }, include: { project: true } });
  res.json({ employeeId, fiscalYear, rows: saved });
});

/**
 * Expand allocations into MonthlyLine cost rows.
 *
 * For each employee+month, the employee's monthly cost (annualUsd/12) is split
 * by pct onto the matching project's line inside that month's MonthlySheet.
 * Idempotent: for an allocation-owned line we set costUsd to the split amount
 * (we do not accumulate). A line is matched by (employeeId, projectId) within
 * the sheet; if none exists one is created (revenue fields 0 — cost-only line).
 *
 * Sheets that are LOCKED are skipped (their cost is frozen). Months for which a
 * MonthlySheet does not yet exist are skipped (we never auto-create sheets here).
 */
router.post("/apply", requireAdmin, async (req, res) => {
  const fiscalYear = String(req.body.fiscalYear || "");
  if (!fiscalYear) return res.status(400).json({ error: "fiscalYear is required" });
  const all = req.body.employeeId === "all" || req.body.all === true || req.body.employeeId == null;
  const employeeId = all ? null : Number(req.body.employeeId);
  if (!all && !employeeId) return res.status(400).json({ error: "employeeId or {all:true} is required" });

  const allocations = await prisma.employeeCostAllocation.findMany({
    where: { fiscalYear, ...(employeeId ? { employeeId } : {}) },
  });
  if (!allocations.length) return res.json({ applied: 0, skippedLocked: 0, message: "No allocations to apply." });

  // sheets for this FY, indexed by month
  const sheets = await prisma.monthlySheet.findMany({ where: { fiscalYear } });
  const sheetByMonth = new Map(sheets.map((s) => [s.month, s]));

  // cache per-employee monthly cost + name + project name lookups
  const empMonthlyCost = new Map<number, number>();
  const empName = new Map<number, string>();
  const projName = new Map<number, string>();

  let applied = 0, skippedLocked = 0, skippedNoSheet = 0;
  for (const a of allocations) {
    const sheet = sheetByMonth.get(a.month);
    if (!sheet) { skippedNoSheet++; continue; }
    if (sheet.status === "LOCKED") { skippedLocked++; continue; }

    if (!empMonthlyCost.has(a.employeeId)) {
      const c = await computeEmployeeCost(a.employeeId);
      empMonthlyCost.set(a.employeeId, (c?.annualUsd || 0) / 12);
      empName.set(a.employeeId, c?.name || "");
    }
    if (!projName.has(a.projectId)) {
      const p = await prisma.project.findUnique({ where: { id: a.projectId } });
      projName.set(a.projectId, p?.name || "");
    }
    const split = (empMonthlyCost.get(a.employeeId) || 0) * (a.pct / 100);

    // find an existing line for this employee+project in this month's sheet
    const line = await prisma.monthlyLine.findFirst({
      where: { monthlySheetId: sheet.id, employeeId: a.employeeId, projectId: a.projectId },
    });
    if (line) {
      await prisma.monthlyLine.update({ where: { id: line.id }, data: { costUsd: split } });
    } else {
      await prisma.monthlyLine.create({
        data: {
          monthlySheetId: sheet.id, employeeId: a.employeeId, projectId: a.projectId,
          resourceName: empName.get(a.employeeId) || "", projectName: projName.get(a.projectId) || "",
          rateUsd: 0, estimateHours: 0, actualHours: 0, fxMultiplier: 1,
          billingAmount: 0, invoiceAmount: 0, costUsd: split, isExpense: false,
        },
      });
    }
    applied++;
  }

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "APPLY_ALLOCATIONS", entity: "EmployeeCostAllocation",
      entityId: employeeId ? String(employeeId) : "all",
      after: { fiscalYear, applied, skippedLocked, skippedNoSheet } },
  }).catch(() => {});

  res.json({ applied, skippedLocked, skippedNoSheet });
});

export default router;
