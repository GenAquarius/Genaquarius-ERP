// Finance's queue for the CTC change HR issued via the Appraisal flow (appraisals.ts). Approving
// is what actually performs "CTC & Employment History → Add CTC Record" — creating a new
// CtcRecord for the employee, pre-filled from the issued appraisal exactly as Confirm Joining's
// own CTC approval does (same buildCtcComponentsFromBreakup() for India Full-Time). Nothing
// changes on the employee's CTC until Approved.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole } from "../../auth/auth";
import { Role } from "@prisma/client";
import { requirePermission } from "../../engine/permissions";
import { buildCtcComponentsFromBreakup } from "../../engine/hr";
import { applyCtcToMonthlyLines, lineAddon } from "../shared/masters";
import { computeMonthlyEmployeeCostUsd, computeEmployeeCost, monthBounds } from "../../engine/calc";

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
// What this appraisal's own CtcData would look like if approved right now — shared by the preview
// below and kept in sync with /approve's own identical construction (not factored into one function
// since /approve's version is a fixed part of that route's own flow and doesn't need reuse there).
// step 2 reads the mirrored second* fields — a staged raise's later step (see schema comment on
// Appraisal.secondEffectiveDate); Approve creates one CtcRecord per step.
function ctcDataForAppraisal(a: any, step: 1 | 2 = 1) {
  const isIndiaComponents = a.countryCode === "INDIA" && a.empType !== "CONTRACTOR";
  const isContractor = a.countryCode === "INDIA" && a.empType === "CONTRACTOR";
  const breakup = step === 2 ? a.secondSalaryBreakup : a.salaryBreakup;
  const monthly = step === 2 ? a.secondMonthlyCompensation : a.monthlyCompensation;
  const annual = step === 2 ? a.secondAnnualCostOverride : a.annualCostOverride;
  return isIndiaComponents
    ? { currency: "INR", ...buildCtcComponentsFromBreakup(breakup as any), empType: a.empType }
    : isContractor
    ? { currency: "INR", basic: monthly || 0, empType: "CONTRACTOR" }
    : { currency: a.countryCode === "US" ? "USD" : "CAD", annualCostOverride: annual, empType: a.empType };
}

const APPROVER_ROLES = [Role.FINANCE, Role.CTO, Role.CEO];

const router = Router();
router.use(requireRole(...APPROVER_ROLES));
router.use(requirePermission("appraisal-approvals"));

router.get("/", async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const rows = await prisma.appraisal.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { issuedAt: "desc" },
    include: { employee: { select: { id: true, name: true, empNo: true, location: true, empType: true } } },
  });
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  res.json(a);
});

// Read-only "what Approve will actually do to Monthly Forecast" preview — the same before/after
// per-month Cost comparison Finance would otherwise only discover after already approving. Builds
// a VIRTUAL CtcRecord (never persisted) matching exactly what /approve below would create, and
// re-prices each editable month's existing lines against it via computeMonthlyEmployeeCostUsd's own
// virtualCtcRecords support — the same mechanism the New Employee CTC approval preview uses.
router.get("/:id/forecast-preview", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) }, include: { employee: { include: { ctcRecords: true } } } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  const ctcEffectiveFrom = req.query.ctcEffectiveFrom ? new Date(String(req.query.ctcEffectiveFrom)) : a.effectiveDate;
  // Mirrors /approve exactly: when there's a second step, the first segment ends the day before
  // it starts, and a second virtual record picks up from there — so Finance previews the SAME
  // two-segment forecast impact that Approve will actually create.
  const firstTill = a.secondEffectiveDate ? new Date(a.secondEffectiveDate.getTime() - 86400000) : null;
  const virtualFirst = { id: -1, employeeId: a.employeeId, effectiveFrom: ctcEffectiveFrom, effectiveTill: firstTill, ...ctcDataForAppraisal(a) };
  const virtualCtcRecords = [...a.employee.ctcRecords, virtualFirst as any];
  if (a.secondEffectiveDate) {
    virtualCtcRecords.push({ id: -2, employeeId: a.employeeId, effectiveFrom: a.secondEffectiveDate, effectiveTill: null, ...ctcDataForAppraisal(a, 2) } as any);
  }

  // ALL sheets (locked too, in order) so the last double-dip incentive can be carried forward into
  // later months where it hasn't been entered yet; only editable months are listed below.
  const sheets = await prisma.monthlySheet.findMany({
    include: { lines: { where: { employeeId: a.employeeId, isExpense: false } } },
    orderBy: [{ fiscalYear: "asc" }, { monthIndex: "asc" }],
  });
  // Same rules /approve applies (applyCtcToMonthlyLines): every line's stored cost = CTC share +
  // add-ons (double-dip incentive / bonus); only the CTC part is re-priced, add-ons carry over; all of
  // the employee's lines (double dip = 2+) are totalled together; months ending before the effective
  // date and day-rate/hourly vendor lines are untouched — so Change shows only the real CTC effect.
  const cc = await computeEmployeeCost(a.employeeId);
  const isVendor = !!cc && (cc.usEngagement === "VENDOR" || cc.usEngagement === "W2_NO_BENEFIT");
  const fromMs = new Date(ctcEffectiveFrom).setHours(0, 0, 0, 0);
  const months = [];
  // Last non-zero add-on total (all double-dip lines summed) seen so far — a month with no incentive
  // entered yet is shown WITH it (preview only, nothing is written), so Current and New Cost both
  // reflect the full cost: CTC (all projects) + double-dip incentive.
  // Only the double-dip INCENTIVE is carried forward (never a one-off bonus), and only into months
  // where the employee actually has a double-dip line.
  let carriedInc = 0;
  for (const sheet of sheets) {
    if (!sheet.lines.length) continue;
    const storedInc = sheet.lines.reduce((s, l) => s + (Number(l.doubleDipIncentive) || 0), 0);
    const storedBonus = sheet.lines.reduce((s, l) => s + (Number(l.bonus) || 0), 0);
    if (storedInc > 0) carriedInc = storedInc;
    const hasDD = sheet.lines.some((l) => l.doubleDip);
    const effInc = storedInc > 0 ? storedInc : hasDD ? carriedInc : 0;
    const addons = effInc + storedBonus;
    const monthEnd = monthBounds(sheet.fiscalYear, sheet.monthIndex).endNum * 86400000;
    // Only editable months at/after the effective date are affected by this appraisal.
    if (sheet.status === "LOCKED" || monthEnd < fromMs) continue;
    const storedCost = r2(sheet.lines.reduce((s, l) => s + (l.costUsd || 0), 0));
    // Current Cost = what the employee's EXISTING CTC records price this month at (all projects
    // together) + add-ons — not the raw stored line values, which can be stale (e.g. a past bonus
    // baked into costUsd by a roll-forward). Approve re-prices the lines the same way.
    const currentCost = isVendor ? storedCost : r2((await computeMonthlyEmployeeCostUsd(a.employeeId, sheet.fiscalYear, sheet.monthIndex)) + addons);
    const newCost = isVendor
      ? currentCost
      : r2((await computeMonthlyEmployeeCostUsd(a.employeeId, sheet.fiscalYear, sheet.monthIndex, undefined, undefined, virtualCtcRecords)) + addons);
    months.push({ fiscalYear: sheet.fiscalYear, monthIndex: sheet.monthIndex, month: sheet.month, currentCost, newCost, delta: r2(newCost - currentCost), storedForecastCost: storedCost, doubleDipIncentive: r2(effInc), incentiveCarriedForward: storedInc === 0 && effInc > 0 });
  }
  res.json({ months });
});

router.post("/:id/approve", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (a.status !== "ISSUED") return res.status(400).json({ error: `Cannot approve from status ${a.status}.` });
  const b = req.body || {};
  const ctcEffectiveFrom = b.ctcEffectiveFrom ? new Date(b.ctcEffectiveFrom) : a.effectiveDate;
  // A staged raise's first segment must end the day before the second step starts — no gap, no
  // overlap — so that date always wins over anything manually typed for Effective Till.
  const ctcEffectiveTill = a.secondEffectiveDate
    ? new Date(a.secondEffectiveDate.getTime() - 86400000)
    : b.ctcEffectiveTill ? new Date(b.ctcEffectiveTill) : null;
  const ctcData: any = ctcDataForAppraisal(a);

  const ctc = await prisma.ctcRecord.create({ data: { employeeId: a.employeeId, effectiveFrom: ctcEffectiveFrom, effectiveTill: ctcEffectiveTill, ...ctcData } });
  // Second step of a staged raise — its own open-ended CtcRecord starting exactly where the first
  // segment above leaves off.
  let secondCtc: any = null;
  if (a.secondEffectiveDate) {
    const secondCtcData: any = ctcDataForAppraisal(a, 2);
    secondCtc = await prisma.ctcRecord.create({ data: { employeeId: a.employeeId, effectiveFrom: a.secondEffectiveDate, effectiveTill: null, ...secondCtcData } });
  }
  // Same "reflect the new CTC into Monthly Forecast" step the direct Admin CTC routes (masters.ts's
  // POST/PUT /ctc) already do — without this, adding the CtcRecord alone left every editable
  // month's Cost column stuck at the employee's OLD CTC until something unrelated happened to
  // recompute it (e.g. hand-editing the row, or a brand-new month created later).
  const reflected = await applyCtcToMonthlyLines(a.employeeId, ctcEffectiveFrom);
  const updated = await prisma.appraisal.update({ where: { id: a.id }, data: { status: "APPROVED", reviewedById: req.user!.id, reviewedAt: new Date() } });
  // An approved appraisal can carry a new designation — keep Employee.designation current so the
  // Org Chart / Directory and the employee's Designation Revision history reflect it.
  if (a.designation && a.designation.trim() && a.designation.trim() !== (a.employee.designation || "").trim()) {
    await prisma.employee.update({ where: { id: a.employeeId }, data: { designation: a.designation.trim() } });
  }
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "APPROVE_APPRAISAL", entity: "Appraisal", entityId: String(a.id), after: { employeeId: a.employeeId, ctcRecordId: ctc.id, secondCtcRecordId: secondCtc?.id } } }).catch(() => {});
  res.json({ appraisal: updated, ctc, secondCtc, reflected });
});

router.post("/:id/reject", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (a.status !== "ISSUED") return res.status(400).json({ error: `Cannot reject from status ${a.status}.` });
  const updated = await prisma.appraisal.update({ where: { id: a.id }, data: { status: "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date(), reviewNote: req.body?.note || null } });
  res.json(updated);
});

export default router;
