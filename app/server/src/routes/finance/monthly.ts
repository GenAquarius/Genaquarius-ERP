import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { computeEmployeeCost, computeMonthlyEmployeeCostUsd, computeMonthlyCostBreakdown, toUsd } from "../../engine/calc";
import { workingDaysInMonth, deriveBillable, deployedFraction, effectiveEnd, scaleToWindow, calOf } from "../../engine/workdays";
import { emitForecastChange } from "../../engine/realtime";
import { isFlowEnabled } from "../../engine/notify";

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
// Records ONE Monthly Forecast line change (add/edit/remove) for the CTO/Finance "what changed
// & its impact" feed — before/after is a trimmed snapshot (never the full row), and `impact` is
// the resulting $ delta on the 4 headline dashboard numbers so the feed never needs to re-derive
// it from the raw before/after at read time. `before`=null means ADD, `after`=null means REMOVE.
// Gated by the same Administration → Notification Settings toggle every other flow uses
// (MONTHLY_FORECAST_IMPACT) — off means neither the audit row nor the live dashboard ping fires.
async function auditMonthlyLineChange(
  actorUserId: number | null | undefined,
  action: "ADD" | "EDIT" | "REMOVE",
  sheet: { id: number; fiscalYear: string; month: string },
  before: any | null,
  after: any | null,
): Promise<void> {
  if (!(await isFlowEnabled("MONTHLY_FORECAST_IMPACT").catch(() => true))) return;
  const snap = (l: any) => l && { resourceName: l.resourceName, projectName: l.projectName, isExpense: l.isExpense, costUsd: l.costUsd, invoiceAmount: l.invoiceAmount };
  const b = snap(before) || { isExpense: after?.isExpense, costUsd: 0, invoiceAmount: 0 };
  const a = snap(after) || { isExpense: before?.isExpense, costUsd: 0, invoiceAmount: 0 };
  const revenueDelta = (a.isExpense ? 0 : a.invoiceAmount || 0) - (b.isExpense ? 0 : b.invoiceAmount || 0);
  const salaryDelta = (a.isExpense ? 0 : a.costUsd || 0) - (b.isExpense ? 0 : b.costUsd || 0);
  const totalCostDelta = (a.costUsd || 0) - (b.costUsd || 0);
  const profitDelta = revenueDelta - totalCostDelta;
  const impact = { revenueDelta: r2(revenueDelta), salaryDelta: r2(salaryDelta), totalCostDelta: r2(totalCostDelta), profitDelta: r2(profitDelta) };
  const payload = {
    before: snap(before), after: { ...snap(after), fiscalYear: sheet.fiscalYear, month: sheet.month, monthlySheetId: sheet.id, impact },
  };
  await prisma.auditLog.create({
    data: { userId: actorUserId ?? null, action: `${action}_MONTHLY_LINE`, entity: "MonthlyLine", entityId: String(after?.id ?? before?.id ?? ""), before: payload.before, after: payload.after },
  }).catch(() => {});
  emitForecastChange({ action, fiscalYear: sheet.fiscalYear, month: sheet.month, resourceName: a.resourceName || b.resourceName, projectName: a.projectName || b.projectName, impact });
}

// Count of billable resource LINES in a sheet (double-dips counted per line).
async function billableLineCount(sheetId: number): Promise<number> {
  return prisma.monthlyLine.count({ where: { monthlySheetId: sheetId, isExpense: false, isBillable: true } });
}
// Distinct OFFSHORE billable resources (India = not US/Canada/Caribbean) on a sheet — the
// Double-dip cost split: when a resource has 2+ BILLABLE lines in a month (same person on
// multiple projects), their single monthly CTC is split equally across those lines (so it
// isn't double-counted), and each line's own double-dip incentive is added on top.
async function splitDoubleDipCost(sheetId: number, employeeId: number | null, restoreSingle = false): Promise<void> {
  if (!employeeId) return;
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: sheetId }, select: { status: true, fiscalYear: true, monthIndex: true } });
  if (!sheet || sheet.status === "LOCKED") return;
  // Hourly/daily vendor engagements (VENDOR / W2_NO_BENEFIT) cost by rate × each line's ACTUAL
  // billable work, which the add/edit paths already set per line. That is inherently not
  // double-counted across projects, so it must NOT be overwritten by the flat monthly-CTC split
  // used for salaried staff — doing so is what made the Monthly grid diverge from the resource
  // editor (e.g. a day-rate vendor showing 8666.67/2 instead of dayRate × billable days).
  const cc = await computeEmployeeCost(employeeId);
  if (cc && (cc.usEngagement === "VENDOR" || cc.usEngagement === "W2_NO_BENEFIT")) return;
  const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: sheetId, employeeId, isExpense: false, isBillable: true } });
  const addon = (l: any) => ((l.doubleDipIncentive || 0) + (l.bonus || 0)); // per-line bonus + incentive
  // Prorated monthly CTC for this month (mid-month conversions / joins / exits split automatically).
  // Unwindowed here — the >=2-line branch below does its own day-by-day split across lines, and the
  // single-line branch further down asks for the window-clipped variant directly (see its own call).
  const monthlyCost = await computeMonthlyEmployeeCostUsd(employeeId, sheet.fiscalYear, sheet.monthIndex);
  const r2c = (n: number) => Math.round((n || 0) * 100) / 100;
  if (lines.length >= 2) {
    // The CTC is split DAY BY DAY across the lines whose deployment window covers each day — with no
    // windows this is the classic equal split, but a project past its Deployment End hands its share
    // back to the remaining project(s) (e.g. A ends the 15th → A gets 25%, the surviving B gets 75%).
    const { year, month0 } = calOf(sheet.fiscalYear, sheet.monthIndex);
    const dim = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    const first = Math.floor(Date.UTC(year, month0, 1) / 86400000);
    const dnum = (d: any) => { const x = new Date(d); return Math.floor(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 86400000); };
    const rng = lines.map((l) => ({ id: l.id, from: l.deploymentStart ? Math.max(1, dnum(l.deploymentStart) - first + 1) : 1, to: l.deploymentEnd ? Math.min(dim, dnum(l.deploymentEnd) - first + 1) : dim }));
    const shareDays = new Map<number, number>(lines.map((l) => [l.id, 0]));
    for (let d = 1; d <= dim; d++) {
      const act = rng.filter((r) => r.from <= d && d <= r.to);
      for (const r of act) shareDays.set(r.id, shareDays.get(r.id)! + 1 / act.length);
    }
    for (const l of lines) await prisma.monthlyLine.update({ where: { id: l.id }, data: { costUsd: r2c(monthlyCost * (shareDays.get(l.id)! / dim)) + addon(l) } });
  } else if (lines.length === 1 && restoreSingle) {
    // a double-dip was removed — restore the remaining line to the full CTC (+ add-ons), still
    // prorated to its own deployment window if it has one. Asks computeMonthlyEmployeeCostUsd for
    // the window-clipped cost directly rather than multiplying the unwindowed `monthlyCost` above
    // by a separate fraction — same double-proration this function's createMonthlyLine sibling had
    // (a joining-date-clipped month's cost, re-clipped again by an equal deployment window).
    const l = lines[0];
    const restoredCost = (l.deploymentStart || (l as any).deploymentEnd)
      ? await computeMonthlyEmployeeCostUsd(employeeId, sheet.fiscalYear, sheet.monthIndex, l.deploymentStart, (l as any).deploymentEnd)
      : monthlyCost;
    await prisma.monthlyLine.update({ where: { id: l.id }, data: { costUsd: r2c(restoredCost) + addon(l) } });
  }
}

// multiplier for the per-offshore-resource commission/incentive. Total = distinct OFFSHORE
// billable resources (Offshore Billable Headcount) + distinct offshore resources explicitly
// marked Double Dip (Offshore Double Dip Headcount) — the same "fills a 2nd billable slot"
// definition the Monthly sheet's Billable (TB) tooltip already uses, so this number always
// matches what Operations shows the user next to the incentive field.
async function offshoreBillableHeadcount(sheetId: number): Promise<number> {
  const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: sheetId, isExpense: false, isBillable: true }, include: { employee: { select: { location: true } } } });
  const isOnsite = (loc: string | null | undefined) => ["US", "CANADA", "CARIBBEAN"].includes((loc || "").toUpperCase());
  const isDip = (l: any) => !!l.doubleDip || (+l.doubleDipIncentive || 0) > 0;
  const nameOf = (l: any) => (l.resourceName || "").toLowerCase();
  const offshoreLines = lines.filter((l) => !isOnsite(l.employee?.location));
  const offshoreBillable = new Set(offshoreLines.map(nameOf));
  const offshoreDoubleDip = new Set(offshoreLines.filter(isDip).map(nameOf));
  return offshoreBillable.size + offshoreDoubleDip.size;
}
// Total employee (resource) cost in USD for a sheet — basis for DYNAMIC % expenses.
async function totalEmployeeCostUsd(sheetId: number): Promise<number> {
  const r = await prisma.monthlyLine.aggregate({ where: { monthlySheetId: sheetId, isExpense: false }, _sum: { costUsd: true } });
  return r._sum.costUsd || 0;
}
const MONTHS_ = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
// The fiscal month immediately BEFORE (fiscalYear, monthIndex) — Apr (1) of one FY rolls back to
// Mar (12) of the previous FY label (FY26-27 → FY25-26).
function prevFyMonth(fiscalYear: string, monthIndex: number): { fiscalYear: string; month: string; monthIndex: number } {
  if (monthIndex > 1) return { fiscalYear, month: MONTHS_[monthIndex - 2], monthIndex: monthIndex - 1 };
  const m = fiscalYear.match(/FY(\d+)-(\d+)/);
  const pf = m ? `FY${+m[1] - 1}-${+m[2] - 1}` : fiscalYear;
  return { fiscalYear: pf, month: "Mar", monthIndex: 12 };
}
// PCT_PREV_INVOICE basis: sum of Actual Invoice (USD) across the given projects' billable
// resource lines, for the month BEFORE (fiscalYear, monthIndex) — e.g. Oct's commission is based
// on Sep's invoices. 0 if that earlier sheet doesn't exist yet (nothing to base it on).
async function prevMonthProjectInvoiceUsd(fiscalYear: string, monthIndex: number, projectIds: number[]): Promise<number> {
  if (!projectIds.length) return 0;
  const { fiscalYear: pfy, month: pm } = prevFyMonth(fiscalYear, monthIndex);
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear: pfy, month: pm } } });
  if (!sheet) return 0;
  const r = await prisma.monthlyLine.aggregate({
    where: { monthlySheetId: sheet.id, isExpense: false, isBillable: true, projectId: { in: projectIds } },
    _sum: { invoiceAmount: true },
  });
  return r._sum.invoiceAmount || 0;
}
// Same as prevMonthProjectInvoiceUsd, but looked up from a sheet id directly (the create/edit
// line paths only have the sheetId in hand, not its fiscalYear/monthIndex).
async function prevMonthProjectInvoiceUsdForSheet(sheetId: number, projectIds: number[]): Promise<number> {
  if (!projectIds.length) return 0;
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: sheetId }, select: { fiscalYear: true, monthIndex: true } });
  if (!sheet) return 0;
  return prevMonthProjectInvoiceUsd(sheet.fiscalYear, sheet.monthIndex, projectIds);
}
// Parse/validate a commissionProjectIds payload (array of project ids) → number[], silently
// dropping anything non-numeric rather than rejecting the whole save.
function parseCommissionProjectIds(v: any): number[] {
  const arr = Array.isArray(v) ? v : [];
  return arr.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0);
}
// Recompute auto-calculated expense lines:
//  • PER_BILLABLE      → perResourceInr × OFFSHORE billable headcount (INR → USD)
//  • DYNAMIC           → percentValue% of total employee cost (USD)
//  • PCT_PREV_INVOICE  → percentValue% of the PREVIOUS month's invoice total across commissionProjectIds (USD)
// Keeps them in step with headcount / cost / invoices. Skips locked sheets.
async function recomputeIncentiveLines(sheetId: number): Promise<void> {
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: sheetId }, select: { status: true, fiscalYear: true, monthIndex: true } });
  if (!sheet || sheet.status === "LOCKED") return;
  const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: sheetId, isExpense: true, expenseCalc: { in: ["PER_BILLABLE", "DYNAMIC", "PCT_PREV_INVOICE"] } } });
  if (!lines.length) return;
  let offCount: number | null = null, empCost: number | null = null;
  for (const l of lines) {
    if (l.expenseCalc === "DYNAMIC") {
      if (empCost === null) empCost = await totalEmployeeCostUsd(sheetId);
      const usd = ((l.percentValue || 0) / 100) * empCost;
      await prisma.monthlyLine.update({ where: { id: l.id }, data: { currency: "USD", nativeAmount: usd, costUsd: usd } });
    } else if (l.expenseCalc === "PCT_PREV_INVOICE") {
      const ids: number[] = Array.isArray((l as any).commissionProjectIds) ? (l as any).commissionProjectIds : [];
      const basis = await prevMonthProjectInvoiceUsd(sheet.fiscalYear, sheet.monthIndex, ids);
      const usd = ((l.percentValue || 0) / 100) * basis;
      await prisma.monthlyLine.update({ where: { id: l.id }, data: { currency: "USD", nativeAmount: usd, costUsd: usd } });
    } else {
      if (offCount === null) offCount = await offshoreBillableHeadcount(sheetId);
      // A manual headcount override (if set) wins over the auto count.
      const hc = (l as any).headcountOverride ?? offCount;
      const inr = (l.perResourceInr || 0) * hc;
      await prisma.monthlyLine.update({ where: { id: l.id }, data: { nativeAmount: inr, currency: "INR", costUsd: await toUsd(inr, "INR") } });
    }
  }
}

// Net billable working days for a sheet's month + a country (holiday-aware, Business-Unit-aware).
async function workingDaysForSheet(sheetId: number, country: string | null, businessUnitId?: number | null): Promise<{ workingDays: number; fiscalYear: string; monthIndex: number } | null> {
  const s = await prisma.monthlySheet.findUnique({ where: { id: sheetId }, select: { fiscalYear: true, monthIndex: true } });
  if (!s) return null;
  return { workingDays: await workingDaysInMonth(s.fiscalYear, s.monthIndex, country, businessUnitId), fiscalYear: s.fiscalYear, monthIndex: s.monthIndex };
}
// Employee Business Unit (for holiday-aware working days), by id.
async function empBusinessUnitFor(employeeId: number | null): Promise<number | null> {
  if (!employeeId) return null;
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { businessUnitId: true } });
  return e?.businessUnitId ?? null;
}

const router = Router();
router.use(requireAdmin); // monthly forecast/actuals is admin-tier only
// GET / is also read (month-lock status only) by the Generate Invoice page, which shares the
// same ADMIN_ROLES audience as Monthly Forecast today — zero-regression to gate the whole router.
router.use(requirePermission("monthly-forecast"));

// throws-style guard: returns true if the sheet is locked OR its fiscal year is
// LOCKED (and writes the response). The FY lock (F5) is a hard, year-wide freeze.
async function blockedIfLocked(sheetId: number | null, res: any): Promise<boolean> {
  if (!sheetId) return false;
  const s = await prisma.monthlySheet.findUnique({ where: { id: sheetId } });
  if (!s) return false;
  if (s.status === "LOCKED") { res.status(423).json({ error: "This month is locked. Unlock it to make changes." }); return true; }
  const fy = await prisma.fiscalYear.findUnique({ where: { label: s.fiscalYear } });
  if (fy?.status === "LOCKED") { res.status(403).json({ error: "Fiscal year is locked" }); return true; }
  return false;
}

// ---- "Apply to future months" propagation helpers (F: edit/add/delete cascade) ----
// Future EDITABLE sheets in the same fiscal year after the given sheet (locked months
// are never touched). Used to optionally cascade a row edit/add/delete forward.
async function editableFutureSheets(sheetId: number) {
  const cur = await prisma.monthlySheet.findUnique({ where: { id: sheetId } });
  if (!cur) return [];
  return prisma.monthlySheet.findMany({
    where: { fiscalYear: cur.fiscalYear, monthIndex: { gt: cur.monthIndex }, status: { not: "LOCKED" } },
    orderBy: { monthIndex: "asc" },
  });
}
const BENCH_PROJECT = "GenAquarius (Bench)";
// Active employees NOT already on this sheet (no resource line, billable or non-billable;
// dedup also against expense rows so items like "India Health Insurance" never appear),
// each with their monthly CTC cost. These are the bench candidates the user can pick from.
async function benchCandidates(sheetId: number) {
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: sheetId }, include: { lines: true } });
  if (!sheet) return { sheet: null as any, candidates: [] as any[] };
  const employees = await prisma.employee.findMany({ where: { exitDate: null }, orderBy: { name: "asc" } });
  const plannedIds = new Set(sheet.lines.filter((l) => !l.isExpense && l.employeeId).map((l) => l.employeeId));
  const plannedNames = new Set(sheet.lines.map((l) => l.resourceName.toLowerCase()));
  const candidates: any[] = [];
  for (const e of employees) {
    if (plannedIds.has(e.id) || plannedNames.has(e.name.toLowerCase())) continue;
    const c = await computeEmployeeCost(e.id);
    candidates.push({ id: e.id, name: e.name, location: e.location, empType: e.empType, monthlyCost: c ? Math.round((c.annualUsd || 0) / 12) : 0 });
  }
  return { sheet, candidates };
}
// Add the given (or all) bench candidates as Non-billable "GenAquarius (Bench)" rows.
async function addBenchLines(sheetId: number, onlyIds?: number[]): Promise<number> {
  const { sheet, candidates } = await benchCandidates(sheetId);
  if (!sheet || sheet.status === "LOCKED") return 0;
  const toAdd = onlyIds ? candidates.filter((c) => onlyIds.includes(c.id)) : candidates;
  for (const c of toAdd) {
    await prisma.monthlyLine.create({ data: {
      monthlySheetId: sheet.id, employeeId: c.id, projectId: null,
      resourceName: c.name, projectName: BENCH_PROJECT,
      rateUsd: 0, estimateHours: 0, actualHours: 0, fxMultiplier: 1,
      billingAmount: 0, invoiceAmount: 0, costUsd: c.monthlyCost,
      isExpense: false, isBillable: false,
    } });
  }
  return toAdd.length;
}
// After a resource's deployment window ends they sit on the bench: a Non-billable
// "GenAquarius (Bench)" row with ONLY cost — no estimate, no invoice — for `fraction` of that
// month's CTC (1 = whole month; the remainder of the end month otherwise). Skipped when the person
// has any other resource row that month (deployed elsewhere) or costs nothing (already exited).
const round2 = (n: number) => Math.round((n || 0) * 100) / 100;
// dStart/dEnd = the deployment window that's covered by a real project row this month (null/null
// if the person isn't deployed to any project at all this month) — the bench row here covers the
// COMPLEMENT: days the person is active (joined … exit) but NOT inside that window. Computed as
// totalCost − deployedCost (both from computeMonthlyEmployeeCostUsd, the second one window-clipped)
// rather than a separate "fraction × unwindowed monthly cost" multiply — that used to double-
// prorate a brand-new joiner (whose deployment window starts on their own joining date): the
// "uncovered" days 1-of-month..joiningDate-1 aren't actually days they were employed at all, so
// benching them was itself a bug (a phantom Bench row for someone who has a real project row
// covering their entire employed period this month), on top of the cost math being wrong.
async function benchAfterWindow(sheetId: number, employeeId: number, resourceName: string, fiscalYear: string, monthIndex: number, dStart: Date | string | null, dEnd: Date | string | null, ignoreLineId?: number): Promise<boolean> {
  const rows = await prisma.monthlyLine.findMany({ where: { monthlySheetId: sheetId, isExpense: false, employeeId, ...(ignoreLineId ? { id: { not: ignoreLineId } } : {}) } });
  const bench = rows.find((l) => !l.isBillable && l.projectName === BENCH_PROJECT);
  if (rows.some((l) => l !== bench)) return false;
  const totalCost = await computeMonthlyEmployeeCostUsd(employeeId, fiscalYear, monthIndex);
  const deployedCost = (dStart || dEnd) ? await computeMonthlyEmployeeCostUsd(employeeId, fiscalYear, monthIndex, dStart, dEnd) : 0;
  const cost = round2(totalCost - deployedCost);
  if (cost <= 0) return false;
  if (bench) { await prisma.monthlyLine.update({ where: { id: bench.id }, data: { costUsd: cost } }); return true; }
  await prisma.monthlyLine.create({ data: {
    monthlySheetId: sheetId, employeeId, projectId: null, resourceName, projectName: BENCH_PROJECT,
    rateUsd: 0, estimateHours: 0, actualHours: 0, fxMultiplier: 1, billingAmount: 0, invoiceAmount: 0, costUsd: cost,
    isExpense: false, isBillable: false,
  } });
  return true;
}
export const isBenchLine = (l: any) => !!l && !l.isExpense && !l.isBillable && l.projectName === BENCH_PROJECT;
// Assigning a benched person to a project ABSORBS their bench row for that month: when the
// assignment covers the whole month the bench row is deleted (no double cost, no bench listing);
// for a part month benchAfterWindow instead shrinks the bench row to the undeployed remainder.
async function absorbBenchOnAssign(sheetId: number, employeeId: number | null, ignoreLineId?: number): Promise<boolean> {
  if (!employeeId) return false;
  const bench = await prisma.monthlyLine.findFirst({ where: { monthlySheetId: sheetId, isExpense: false, isBillable: false, employeeId, projectName: BENCH_PROJECT, ...(ignoreLineId ? { id: { not: ignoreLineId } } : {}) } });
  if (!bench) return false;
  await prisma.monthlyLine.delete({ where: { id: bench.id } });
  return true;
}
// Find the row in a target sheet that corresponds to `line`: same employee AND same project for
// resource rows (fallback resource name), same category+description for expense rows.
//
// BUG FIX: matching by employeeId ALONE used to be ambiguous for a double-dip resource (2+ lines,
// same employee, different projects, in the same month) — `findFirst` returned WHICHEVER of the
// employee's lines happened to sort first, not necessarily the one this edit/delete actually
// corresponds to. Cascading a double-dip line's deployment-end/delete into future months via
// "apply to future months" could then silently update or delete the person's MAIN project line
// instead of their double-dip line's own counterpart, and — since benchAfterWindow only skips
// benching when it finds another non-bench line still present — potentially bench someone who
// still has a real, untouched project assignment. Matching on projectId too (including null, which
// correctly isolates a bench row from a real project line) makes this exact, not just "same person."
async function findMatchInSheet(sheetId: number, line: any) {
  if (line.isExpense)
    return prisma.monthlyLine.findFirst({ where: { monthlySheetId: sheetId, isExpense: true, projectName: line.projectName, resourceName: line.resourceName } });
  if (line.employeeId)
    return prisma.monthlyLine.findFirst({ where: { monthlySheetId: sheetId, isExpense: false, employeeId: line.employeeId, projectId: line.projectId } });
  return prisma.monthlyLine.findFirst({ where: { monthlySheetId: sheetId, isExpense: false, resourceName: line.resourceName } });
}
// Compute the updated column values for a line from a request body (only fields present
// in `b` change; the rest keep the line's own existing values). Shared by current-row
// edit and the future-month cascade so every month gets the identical change.
async function computeLineUpdate(existing: any, b: any) {
  const rateUsd = b.rateUsd != null ? +b.rateUsd : existing.rateUsd;
  const estimateHours = b.estimateHours != null ? +b.estimateHours : existing.estimateHours;
  const actualHours = b.actualHours != null ? +b.actualHours : existing.actualHours;
  const fx = b.fxMultiplier != null ? +b.fxMultiplier : existing.fxMultiplier;
  const adjustment = b.adjustment != null ? +b.adjustment : existing.adjustment;
  let projectId = existing.projectId, projectName = existing.projectName;
  if (b.projectId !== undefined) {
    // For expense lines, projectId is the ALLOCATION target — keep projectName as the
    // category (it's set separately via b.projectName). For resource lines, projectId
    // reassigns the project and updates the display name.
    if (b.projectId) { const proj = await prisma.project.findUnique({ where: { id: Number(b.projectId) } }); if (proj) { projectId = proj.id; if (!existing.isExpense) projectName = proj.name; } }
    else projectId = null;
  }
  if (b.projectName !== undefined && (existing.isExpense || !b.projectId)) projectName = b.projectName;
  let employeeId = existing.employeeId, resourceName = existing.resourceName;
  if (b.employeeId !== undefined && b.employeeId) { const emp = await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } }); if (emp) { employeeId = emp.id; resourceName = emp.name; } }
  else if (b.resourceName !== undefined) resourceName = b.resourceName;
  let currency = b.currency !== undefined ? b.currency : existing.currency;
  let nativeAmount = existing.nativeAmount;
  // Resource add-ons stored separately; costUsd = base CTC cost + bonus + double-dip incentive.
  const doubleDipIncentive = existing.isExpense ? null : (b.doubleDipIncentive != null ? +b.doubleDipIncentive : (existing.doubleDipIncentive || 0));
  const bonus = existing.isExpense ? null : (b.bonus != null ? +b.bonus : ((existing as any).bonus || 0));
  const baseCost = b.costUsd != null ? +b.costUsd : ((existing.costUsd || 0) - (existing.doubleDipIncentive || 0) - ((existing as any).bonus || 0));
  let costUsd = !existing.isExpense ? baseCost + (doubleDipIncentive || 0) + (bonus || 0) : (b.costUsd != null ? +b.costUsd : existing.costUsd);
  if (b.nativeAmount !== undefined) { nativeAmount = +b.nativeAmount; costUsd = await toUsd(nativeAmount, currency); }
  else if (b.currency !== undefined && existing.nativeAmount != null) { costUsd = await toUsd(existing.nativeAmount, currency); }
  // Expense calculation: PER_BILLABLE (perResourceInr × offshore headcount, INR→USD), DYNAMIC
  // (percentValue% of total employee cost, USD), or PCT_PREV_INVOICE (percentValue% of the
  // PREVIOUS month's invoice total across commissionProjectIds, USD).
  const calcIn = (v: any) => (v === "PER_BILLABLE" ? "PER_BILLABLE" : v === "DYNAMIC" ? "DYNAMIC" : v === "PCT_PREV_INVOICE" ? "PCT_PREV_INVOICE" : "FIXED");
  const expenseCalc = existing.isExpense ? (b.expenseCalc !== undefined ? calcIn(b.expenseCalc) : (existing.expenseCalc || "FIXED")) : null;
  const perResourceInr = expenseCalc === "PER_BILLABLE" ? (b.perResourceInr != null ? +b.perResourceInr : (existing.perResourceInr || 0)) : null;
  const percentValue = (expenseCalc === "DYNAMIC" || expenseCalc === "PCT_PREV_INVOICE") ? (b.percentValue != null ? +b.percentValue : (existing.percentValue || 0)) : null;
  // PER_BILLABLE manual headcount override: explicit value (incl. clear→null) wins; otherwise keep existing.
  const headcountOverride = expenseCalc === "PER_BILLABLE"
    ? (b.headcountOverride !== undefined
        ? (b.headcountOverride === null || b.headcountOverride === "" ? null : Math.round(+b.headcountOverride))
        : ((existing as any).headcountOverride ?? null))
    : null;
  // PCT_PREV_INVOICE: which projects' previous-month invoices feed the commission (multi-select).
  const commissionProjectIds = expenseCalc === "PCT_PREV_INVOICE"
    ? (b.commissionProjectIds !== undefined ? parseCommissionProjectIds(b.commissionProjectIds) : parseCommissionProjectIds((existing as any).commissionProjectIds))
    : []; // Json? column — [] (not null) so Prisma's Json-typed update input stays happy
  if (expenseCalc === "PER_BILLABLE") {
    currency = "INR";
    const hc = headcountOverride ?? (await offshoreBillableHeadcount(existing.monthlySheetId));
    nativeAmount = (perResourceInr || 0) * hc;
    costUsd = await toUsd(nativeAmount, "INR");
  } else if (expenseCalc === "DYNAMIC") {
    currency = "USD";
    nativeAmount = ((percentValue || 0) / 100) * (await totalEmployeeCostUsd(existing.monthlySheetId));
    costUsd = nativeAmount;
  } else if (expenseCalc === "PCT_PREV_INVOICE") {
    currency = "USD";
    nativeAmount = ((percentValue || 0) / 100) * (await prevMonthProjectInvoiceUsdForSheet(existing.monthlySheetId, commissionProjectIds || []));
    costUsd = nativeAmount;
  }
  const expenseType = b.expenseType !== undefined ? (b.expenseType === "FIXED" ? "FIXED" : "VARIABLE") : existing.expenseType;
  const region = b.region !== undefined ? (b.region ? String(b.region).toUpperCase() : null) : existing.region;
  // Expense allocation level (expense lines only). PROJECT requires a projectId target.
  let expenseScope = b.expenseScope !== undefined ? (b.expenseScope === "PROJECT" ? "PROJECT" : "ORG") : (existing.expenseScope || "ORG");
  if (expenseScope === "PROJECT" && !projectId) expenseScope = "ORG"; // no target → org-level
  // Billable vs non-billable (resource lines only). Non-billable = cost only: rate/hours and
  // billing/invoice are forced to 0 so it produces no revenue.
  const billable = b.isBillable !== undefined
    ? !(b.isBillable === false || b.isBillable === "false" || b.isBillable === "NON_BILLABLE")
    : (existing.isBillable ?? true);
  const nonBillRes = !existing.isExpense && !billable;
  let rate2 = nonBillRes ? 0 : rateUsd, est2 = nonBillRes ? 0 : estimateHours, act2 = nonBillRes ? 0 : actualHours;
  let billingAmount = nonBillRes ? 0 : rate2 * est2 * fx + adjustment;
  let invoiceAmount = nonBillRes ? 0 : rate2 * act2 * fx + adjustment;
  // Billing type (billable resource lines only). DAILY/MONTHLY auto-derive hours from this
  // line's month working days (holiday-aware); MONTHLY keeps a fixed monthly revenue.
  const billingMode = b.billingMode !== undefined ? (["DAILY", "MONTHLY", "HOURLY"].includes(b.billingMode) ? b.billingMode : "HOURLY") : ((existing.billingMode as string) || "HOURLY");
  if (!existing.isExpense && billable && (billingMode === "DAILY" || billingMode === "MONTHLY") && projectId) {
    const ctx = await workingDaysForSheet(existing.monthlySheetId, await empLocationFor(employeeId), await empBusinessUnitFor(employeeId));
    const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { billingHoursPerDay: true } });
    const hpd = proj?.billingHoursPerDay || 8;
    const wd = ctx?.workingDays ?? 0;
    // Per Day / Per Month also expose Estimate + Actual hours: Estimated Billing = rate × Est,
    // Actual Invoice = rate × Act. Rate derives from the day-rate / monthly amount.
    const est = b.estimateHours != null ? +b.estimateHours : (existing.estimateHours || wd * hpd);
    const act = b.actualHours != null ? +b.actualHours
      : (b.billingDays != null && b.billingDays !== "" ? +b.billingDays * hpd : (existing.actualHours ?? est));
    let r: number;
    if (billingMode === "DAILY") { const dayRate = b.dayRate != null ? +b.dayRate : existing.rateUsd * hpd; r = dayRate / hpd; }
    else { const amt = b.monthlyAmount != null ? +b.monthlyAmount : (existing.billingAmount || existing.invoiceAmount || 0); r = est ? amt / est : 0; }
    rate2 = r; est2 = est; act2 = act;
    billingAmount = r * est * fx; invoiceAmount = r * act * fx;
  }
  return {
    rateUsd: rate2, estimateHours: est2, actualHours: act2, fxMultiplier: fx, adjustment,
    projectId, projectName, employeeId, resourceName, currency, nativeAmount, expenseType, region, expenseScope,
    billingAmount, invoiceAmount, costUsd,
    isBillable: existing.isExpense ? (existing.isBillable ?? true) : billable,
    billingMode: existing.isExpense ? null : billingMode,
    expenseCalc, perResourceInr, percentValue, headcountOverride, commissionProjectIds, doubleDipIncentive, bonus,
    doubleDip: existing.isExpense ? false : (b.doubleDip !== undefined ? !!b.doubleDip : ((existing as any).doubleDip ?? false)),
    allocationPct: existing.isExpense ? 100 : (b.allocationPct != null ? Math.round(+b.allocationPct) : ((existing as any).allocationPct ?? 100)),
    deploymentStart: existing.isExpense ? null : (b.deploymentStart !== undefined ? (b.deploymentStart ? new Date(b.deploymentStart) : null) : (existing as any).deploymentStart),
    deploymentEnd: existing.isExpense ? null : (b.deploymentEnd !== undefined ? (b.deploymentEnd ? new Date(b.deploymentEnd) : null) : (existing as any).deploymentEnd),
    subProjectId: await (async () => {
      // Explicit "" / null clears it. Explicit id is validated against the FINAL projectId (after
      // any reassignment above) so a stale cross-project id can't stick. Omitted (undefined) keeps
      // the existing tag UNLESS the project itself just changed, in which case a sub-project from
      // the OLD project can no longer apply, so it's cleared rather than silently left dangling.
      if (b.subProjectId !== undefined) {
        if (!b.subProjectId) return null;
        const sp = await prisma.subProject.findFirst({ where: { id: Number(b.subProjectId), projectId: projectId ?? undefined } });
        return sp?.id ?? null;
      }
      if (projectId !== existing.projectId) {
        const stillValid = existing.subProjectId && projectId
          ? await prisma.subProject.findFirst({ where: { id: existing.subProjectId, projectId } }) : null;
        return stillValid?.id ?? null;
      }
      return existing.subProjectId;
    })(),
  };
}
// Employee work location (for holiday-aware working days), by id.
async function empLocationFor(employeeId: number | null): Promise<string | null> {
  if (!employeeId) return null;
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { location: true } });
  return e?.location || null;
}

// list sheets
router.get("/", requireAdmin, async (req, res) => {
  const fy = String(req.query.fy || "FY26-27");
  const sheets = await prisma.monthlySheet.findMany({
    where: { fiscalYear: fy },
    orderBy: { monthIndex: "asc" },
    include: { _count: { select: { lines: true } } },
  });
  res.json(sheets);
});

// Net billable working days for this sheet's month + a country (Add/Edit dialog preview).
// `employeeId` (optional): when the dialog already has a specific employee selected, their own
// Business Unit's holiday calendar (if any) is used instead of just the raw country default.
router.get("/:id/working-days", requireAdmin, async (req, res) => {
  const businessUnitId = req.query.employeeId ? await empBusinessUnitFor(Number(req.query.employeeId)) : null;
  const r = await workingDaysForSheet(Number(req.params.id), req.query.location ? String(req.query.location) : null, businessUnitId);
  if (!r) return res.status(404).json({ error: "Sheet not found" });
  res.json(r);
});

// PCT_PREV_INVOICE commission preview (Add/Edit Expense dialog): the PREVIOUS month's invoice
// total for the projectIds being configured, so Finance sees the basis live while picking a %
// and projects — before saving anything.
router.get("/:id/prev-invoice-basis", requireAdmin, async (req, res) => {
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: Number(req.params.id) }, select: { fiscalYear: true, monthIndex: true } });
  if (!sheet) return res.status(404).json({ error: "Sheet not found" });
  const projectIds = String(req.query.projectIds || "").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  const { fiscalYear: prevFiscalYear, month: prevMonth } = prevFyMonth(sheet.fiscalYear, sheet.monthIndex);
  const basisUsd = await prevMonthProjectInvoiceUsd(sheet.fiscalYear, sheet.monthIndex, projectIds);
  res.json({ basisUsd, prevFiscalYear, prevMonth });
});

// Finance/Executive Dashboard — "What changed in Monthly Forecast & its impact" feed. Every
// ADD/EDIT/REMOVE on a MonthlyLine (resource or expense), newest first, with the $ impact on
// Revenue/Salary Expense/Total Cost/Profit already computed (see auditMonthlyLineChange). Scoped
// to a fiscal year; ?month= narrows to one month, else the whole year. Off entirely (empty list)
// when the MONTHLY_FORECAST_IMPACT notification flow is disabled from Notification Settings.
router.get("/forecast-changes", requireAdmin, async (req, res) => {
  if (!(await isFlowEnabled("MONTHLY_FORECAST_IMPACT"))) return res.json({ enabled: false, rows: [] });
  const fiscalYear = String(req.query.fiscalYear || "FY26-27");
  const month = req.query.month ? String(req.query.month) : null;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  // fiscalYear/month live inside the JSON after/before blobs, not their own columns, so the
  // fiscal-year/month filter happens in JS below rather than a Prisma JSON-path query — over-fetch
  // a generous recent batch to filter down from.
  const logs = await prisma.auditLog.findMany({
    where: { entity: "MonthlyLine", action: { in: ["ADD_MONTHLY_LINE", "EDIT_MONTHLY_LINE", "REMOVE_MONTHLY_LINE"] } },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { at: "desc" },
    take: Math.max(limit * 5, 1000),
  });
  const rows = logs
    .map((l) => {
      const after: any = l.after || {}; const before: any = l.before || {};
      const m = after.month || before.month;
      const fy = after.fiscalYear || before.fiscalYear;
      if (fy !== fiscalYear) return null;
      if (month && m !== month) return null;
      return {
        id: l.id, at: l.at, by: l.user?.name || l.user?.email || "System",
        action: l.action.replace("_MONTHLY_LINE", ""), month: m, fiscalYear: fy,
        resourceName: after.resourceName || before.resourceName, projectName: after.projectName || before.projectName,
        isExpense: after.isExpense ?? before.isExpense, impact: after.impact || { revenueDelta: 0, salaryDelta: 0, totalCostDelta: 0, profitDelta: 0 },
        // Raw $ snapshot either side of the change, not just the delta — ADD has no "before" (0),
        // REMOVE has no "after" (0), EDIT has both.
        before: { costUsd: r2(before.costUsd || 0), invoiceAmount: r2(before.invoiceAmount || 0) },
        after: { costUsd: r2(after.costUsd || 0), invoiceAmount: r2(after.invoiceAmount || 0) },
      };
    })
    .filter(Boolean)
    .slice(0, limit);
  res.json({ enabled: true, rows });
});

// Expense Validation / Reconciliation — CTO's month-over-month comparison of every Expense/
// Overhead line: current vs previous month's amount, Added/Removed/Increased/Decreased/Unchanged,
// and (from the forecast-changes audit trail above) who last touched each one and when. Expense
// lines have no stable id linking "the same expense" across two different months' sheets — same
// as every other cross-month expense match in this file (clone/applyFuture dedup) — so they're
// matched by category (projectName) + description (resourceName).
router.get("/expense-reconciliation", requireAdmin, async (req, res) => {
  const fiscalYear = String(req.query.fiscalYear || "FY26-27");
  const month = String(req.query.month || "");
  const monthIndex = MONTHS_.indexOf(month) + 1;
  if (!monthIndex) return res.status(400).json({ error: "A valid month is required" });
  const prev = prevFyMonth(fiscalYear, monthIndex);
  const [curSheet, prevSheet] = await Promise.all([
    prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month } }, include: { lines: { where: { isExpense: true } } } }),
    prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear: prev.fiscalYear, month: prev.month } }, include: { lines: { where: { isExpense: true } } } }),
  ]);
  const curLines = curSheet?.lines || [], prevLines = prevSheet?.lines || [];
  const keyOf = (l: any) => `${l.projectName || ""}|||${l.resourceName || ""}`;
  const prevByKey = new Map(prevLines.map((l) => [keyOf(l), l]));
  const curByKey = new Map(curLines.map((l) => [keyOf(l), l]));

  // Most recent audit entry per CURRENT-month line id, for "last modified by/when".
  const curIds = curLines.map((l) => String(l.id));
  const recentLogs = curIds.length
    ? await prisma.auditLog.findMany({
        where: { entity: "MonthlyLine", entityId: { in: curIds }, action: { in: ["ADD_MONTHLY_LINE", "EDIT_MONTHLY_LINE"] } },
        include: { user: { select: { name: true, email: true } } },
        orderBy: { at: "desc" },
      })
    : [];
  const lastModByLineId = new Map<string, { at: Date; by: string }>();
  for (const l of recentLogs) if (l.entityId && !lastModByLineId.has(l.entityId)) lastModByLineId.set(l.entityId, { at: l.at, by: l.user?.name || l.user?.email || "System" });

  const keys = new Set([...prevByKey.keys(), ...curByKey.keys()]);
  const rows = [...keys].map((k) => {
    const c = curByKey.get(k), p = prevByKey.get(k);
    const curAmt = r2(c?.costUsd || 0), prevAmt = r2(p?.costUsd || 0);
    const delta = r2(curAmt - prevAmt);
    const status = !p ? "ADDED" : !c ? "REMOVED" : delta > 0.005 ? "INCREASED" : delta < -0.005 ? "DECREASED" : "UNCHANGED";
    const mod = c ? lastModByLineId.get(String(c.id)) : null;
    return {
      category: c?.projectName || p?.projectName, description: c?.resourceName || p?.resourceName,
      currentAmount: curAmt, previousAmount: prevAmt, delta, pctChange: prevAmt ? r2((delta / prevAmt) * 100) : (curAmt ? 100 : 0),
      status, expenseType: c?.expenseType || p?.expenseType, region: c?.region || p?.region, currency: c?.currency || p?.currency,
      expenseScope: c?.expenseScope || p?.expenseScope, lastModifiedAt: mod?.at || null, lastModifiedBy: mod?.by || null,
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const totalCurrent = r2(curLines.reduce((s, l) => s + (l.costUsd || 0), 0));
  const totalPrevious = r2(prevLines.reduce((s, l) => s + (l.costUsd || 0), 0));
  res.json({
    currentMonth: { fiscalYear, month }, previousMonth: { fiscalYear: prev.fiscalYear, month: prev.month },
    summary: {
      totalCurrent, totalPrevious, totalDelta: r2(totalCurrent - totalPrevious),
      added: rows.filter((r) => r.status === "ADDED").length, removed: rows.filter((r) => r.status === "REMOVED").length,
      increased: rows.filter((r) => r.status === "INCREASED").length, decreased: rows.filter((r) => r.status === "DECREASED").length,
      unchanged: rows.filter((r) => r.status === "UNCHANGED").length,
    },
    rows,
  });
});

// one sheet with lines + computed totals
router.get("/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await recomputeIncentiveLines(id).catch(() => {}); // keep PER_BILLABLE incentives fresh on view
  const sheet = await prisma.monthlySheet.findUnique({
    where: { id },
    include: { lines: { orderBy: { id: "asc" }, include: { employee: { select: { location: true } }, project: { select: { name: true } } } } },
  });
  if (!sheet) return res.status(404).json({ error: "Not found" });
  const totals = sheet.lines.reduce(
    (t, l) => ({
      cost: t.cost + l.costUsd,
      billing: t.billing + l.billingAmount,
      invoice: t.invoice + l.invoiceAmount,
    }),
    { cost: 0, billing: 0, invoice: 0 }
  );
  res.json({ ...sheet, totals, profit: totals.invoice - totals.cost });
});

// Core "Edit Resource Row" logic, factored out of the route below so other flows (e.g. the
// contractor/full-time termination approval flow's Deployment End Date step) can apply the exact
// same deployment-window/bench/double-dip cascade a Finance user would get by editing the line
// by hand in Monthly Forecast — without going through the HTTP layer.
export async function updateMonthlyLineCore(lineId: number, b: any, actorUserId?: number | null): Promise<
  | { ok: true; updated: any; propagated: number; added: number; removed: number; benched: number }
  | { ok: false; status: number; error: string }
> {
  const existing = await prisma.monthlyLine.findUnique({ where: { id: lineId } });
  if (!existing) return { ok: false, status: 404, error: "Not found" };
  const sheetForLock = await prisma.monthlySheet.findUnique({ where: { id: existing.monthlySheetId } });
  if (sheetForLock?.status === "LOCKED") return { ok: false, status: 423, error: "This month is locked. Unlock it to make changes." };
  const fyForLock = sheetForLock ? await prisma.fiscalYear.findUnique({ where: { label: sheetForLock.fiscalYear } }) : null;
  if (fyForLock?.status === "LOCKED") return { ok: false, status: 403, error: "Fiscal year is locked" };
  // validate optional reassignments up front so bad ids fail fast
  if (b.projectId) { const p = await prisma.project.findUnique({ where: { id: Number(b.projectId) } }); if (!p) return { ok: false, status: 404, error: "Project not found" }; }
  if (b.employeeId) { const e = await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } }); if (!e) return { ok: false, status: 404, error: "Employee not found" }; }

  const updated = await prisma.monthlyLine.update({ where: { id: existing.id }, data: await computeLineUpdate(existing, b) });
  if (sheetForLock) await auditMonthlyLineChange(actorUserId, "EDIT", sheetForLock, existing, updated);

  // Deployment window (start … end / exit date). The edited month's cost arrives prorated from the
  // client; the rest of an end month and every later month put the person on the bench (cost only).
  const curSheet = await prisma.monthlySheet.findUnique({ where: { id: existing.monthlySheetId }, select: { fiscalYear: true, monthIndex: true } });
  const exitDate = !updated.isExpense && updated.employeeId ? (await prisma.employee.findUnique({ where: { id: updated.employeeId }, select: { exitDate: true } }))?.exitDate : null;
  const dEnd = updated.isExpense ? null : effectiveEnd((updated as any).deploymentEnd, exitDate);
  const hasWindow = !updated.isExpense && !isBenchLine(updated) && !!(updated.deploymentStart || dEnd);
  const curFrac = hasWindow && curSheet ? deployedFraction(curSheet.fiscalYear, curSheet.monthIndex, updated.deploymentStart, dEnd).fraction : 1;
  let benched = 0;
  if (hasWindow && curSheet && curFrac < 1 && updated.employeeId && await benchAfterWindow(existing.monthlySheetId, updated.employeeId, updated.resourceName, curSheet.fiscalYear, curSheet.monthIndex, updated.deploymentStart, dEnd, updated.id)) benched++;

  let propagated = 0, added = 0, removed = 0;
  // A project row covering the whole month absorbs any bench row the person still has there.
  if (!updated.isExpense && !isBenchLine(updated) && updated.employeeId && (!hasWindow || curFrac >= 1) && await absorbBenchOnAssign(existing.monthlySheetId, updated.employeeId, updated.id)) removed++;
  if (b.applyFuture) {
    // Upsert into each later editable month: edit the matching row if it exists, else ADD
    // the (edited) entry. For billable resource lines, Estimate Hours are recomputed per
    // month from that month's working days minus the employee-country's holidays.
    const { id: _id, monthlySheetId: _sid, ...snapshot } = updated as any;
    const billableRes = !updated.isExpense && updated.isBillable !== false && !!updated.projectId;
    const mode = (updated.billingMode as string) || "HOURLY";
    const anchorRate = updated.rateUsd;           // fixed hourly rate (HOURLY/DAILY)
    const anchorMonthly = updated.billingAmount;  // fixed monthly revenue (MONTHLY = estimated billing)
    let country: string | null = null, businessUnitId: number | null = null, hpd = 8;
    if (billableRes) {
      const emp = updated.employeeId ? await prisma.employee.findUnique({ where: { id: updated.employeeId }, select: { location: true, businessUnitId: true } }) : null;
      const proj = await prisma.project.findUnique({ where: { id: updated.projectId! }, select: { billingHoursPerDay: true } });
      country = emp?.location || null; businessUnitId = emp?.businessUnitId ?? null; hpd = proj?.billingHoursPerDay || 8;
    }
    const cache = new Map<string, number>();
    for (const s of await editableFutureSheets(existing.monthlySheetId)) {
      const m = await findMatchInSheet(s.id, existing); // match on the OLD identity
      const frac = hasWindow ? deployedFraction(s.fiscalYear, s.monthIndex, updated.deploymentStart, dEnd).fraction : 1;
      if (frac <= 0) {
        // Past the window: no project row (no estimate / invoice) — bench cost only, until exit.
        if (m && !isBenchLine(m)) { await prisma.monthlyLine.delete({ where: { id: m.id } }); removed++; await splitDoubleDipCost(s.id, updated.employeeId, true); }
        if (updated.employeeId && await benchAfterWindow(s.id, updated.employeeId, updated.resourceName, s.fiscalYear, s.monthIndex, null, null)) benched++;
        await recomputeIncentiveLines(s.id);
        continue;
      }
      let base: any = m ? await computeLineUpdate(m, { ...b, billingMode: mode }) : { ...snapshot };
      let hoursFrom = curFrac; // copied hours/revenue represent the edited month's window …
      if (billableRes) {
        // Re-derive billing for THIS month's working days: HOURLY/DAILY keep rate, MONTHLY keeps revenue.
        const wd = await workingDaysInMonth(s.fiscalYear, s.monthIndex, country, businessUnitId, cache);
        base = { ...base, ...deriveBillable({ mode, rateUsd: anchorRate, monthlyAmount: anchorMonthly, workingDays: wd, hpd, fx: base.fxMultiplier ?? snapshot.fxMultiplier }) };
        hoursFrom = 1;           // … unless just re-derived for a full month
      }
      if (hasWindow) base = scaleToWindow(base, { hoursFrom, costFrom: curFrac, to: frac });
      let lineId: number;
      if (m) { await prisma.monthlyLine.update({ where: { id: m.id }, data: base }); propagated++; lineId = m.id; }
      else { const c = await prisma.monthlyLine.create({ data: { ...base, monthlySheetId: s.id } }); propagated++; added++; lineId = c.id; }
      if (hasWindow && frac < 1 && updated.employeeId && await benchAfterWindow(s.id, updated.employeeId, updated.resourceName, s.fiscalYear, s.monthIndex, updated.deploymentStart, dEnd, lineId)) benched++;
      if (!isBenchLine(updated) && updated.employeeId && (!hasWindow || frac >= 1) && await absorbBenchOnAssign(s.id, updated.employeeId, lineId)) removed++;
      if (hasWindow) await splitDoubleDipCost(s.id, updated.employeeId); // rebalance a double-dip's CTC for this month's windows
      await recomputeIncentiveLines(s.id);
    }
  }
  // double-dip resources: split their CTC across billable projects (+ per-line incentive)
  if (!updated.isExpense) await splitDoubleDipCost(existing.monthlySheetId, updated.employeeId);
  // a resource edit (billable toggle / add) can change the month's PER_BILLABLE incentive
  if (!updated.isExpense) await recomputeIncentiveLines(existing.monthlySheetId);
  return { ok: true, updated, propagated, added, removed, benched };
}

// edit a line (rate/hours/adjustment + reassign project/employee) — recompute billing/invoice.
// Pass applyFuture:true to cascade the SAME edit to the matching row in every later
// editable month already forecasted in this fiscal year.
router.put("/lines/:id", requireAdmin, async (req, res) => {
  const r = await updateMonthlyLineCore(Number(req.params.id), req.body, req.user!.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ...r.updated, propagated: r.propagated, added: r.added, removed: r.removed, benched: r.benched });
});

// Everything computeLineForMonth needs, resolved ONCE by its caller (createMonthlyLine or the
// forecast-preview endpoint below) and reused across every month it's asked to compute — an
// Employee/Project lookup and computeEmployeeCost() call per month would be wasteful, and the
// deployment window / curFrac (the EDITED/anchor month's own fraction, for re-prorating a client-
// supplied cost) must stay identical across every month's calculation.
type LineComputeCtx = {
  emp: any; proj: any; billable: boolean; fx: number; hpd: number; country: string | null; businessUnitId: number | null;
  mode: string; anchorRate: number; anchorMonthly: number; manualDays: number | null;
  clientCost: number | null; curFrac: number; dStart: Date | null; dEnd: Date | null; hasWindow: boolean;
  ctcDaily: boolean; ctcDayRate: number; ctcHourlyRate: number; addOns: number; wdCache: Map<string, number>;
  manualEst: number | null; manualAct: number | null; manualBillDays: number | null; hasManualHours: boolean;
  bonus: number; doubleDipIncentive: number; doubleDip: boolean; allocationPct: number; rawDeploymentEnd: any;
  virtualCtc?: any[]; // see computeMonthlyCostBreakdown's own comment — forecast-preview only
};
// The exact per-month cost/billing/invoice math a Monthly Sheet line is built from — pulled out of
// createMonthlyLine (below) so both it AND a read-only preview (GET /ctc-approvals/:id/forecast-
// preview, before Finance ever clicks Approve) compute a given month identically. A hand-written
// second copy of this formula for the preview would inevitably drift from the real one over time
// (exactly the kind of bug this session already found and fixed twice today) and show Finance a
// forecast that doesn't match what Approve actually creates.
async function computeLineForMonth(ctx: LineComputeCtx, sheetId: number, fyL: string, mi: number, useManual: boolean) {
  const { emp, proj, billable, fx, hpd, country, businessUnitId, mode, anchorRate, anchorMonthly, manualDays,
    clientCost, curFrac, dStart, dEnd, hasWindow, ctcDaily, ctcDayRate, ctcHourlyRate, addOns, wdCache,
    manualEst, manualAct, manualBillDays, hasManualHours, bonus, doubleDipIncentive, doubleDip, allocationPct, rawDeploymentEnd, virtualCtc } = ctx;
  const frac = hasWindow ? deployedFraction(fyL, mi, dStart, dEnd).fraction : 1;
  if (frac <= 0) return null; // not deployed on the project this month
  // A client-supplied cost is prorated for the edited month; re-express it for this month's window.
  const cCost = clientCost == null ? null : (useManual ? clientCost : (curFrac > 0 ? clientCost / curFrac : clientCost) * frac);
  const common = { monthlySheetId: sheetId, employeeId: emp.id, projectId: proj.id, resourceName: emp.name, projectName: proj.name, isExpense: false, isBillable: billable, billingMode: mode, fxMultiplier: fx, doubleDipIncentive, bonus, doubleDip, allocationPct, deploymentStart: dStart, deploymentEnd: rawDeploymentEnd ? new Date(rawDeploymentEnd) : null };
  // Prorated monthly CTC for THIS month — splits mid-month (empType, CTC) changes / joins / exits,
  // clipped to this project's own deployment window (dStart/dEnd) in the SAME pass, not multiplied
  // by `frac` afterward (that used to double-prorate a new joiner: their first line's deployment
  // window is the same as their joining date, so it got clipped to the partial month twice).
  const proratedMonthly = await computeMonthlyEmployeeCostUsd(emp.id, fyL, mi, dStart, dEnd, virtualCtc);
  // Non-billable / no derived hours → flat monthly CTC (hourly & day-rate cost needs billable work).
  if (!billable) return { ...common, costUsd: (cCost ?? proratedMonthly) + addOns, rateUsd: 0, estimateHours: 0, actualHours: 0, billingAmount: 0, invoiceAmount: 0 };
  const wd = useManual && manualDays != null ? manualDays : await workingDaysInMonth(fyL, mi, country, businessUnitId, wdCache);
  const d = deriveBillable({ mode, rateUsd: anchorRate, monthlyAmount: anchorMonthly, workingDays: wd, hpd, fx });
  if (useManual && hasManualHours) {
    const est = manualEst ?? d.estimateHours;
    const act = manualAct ?? (manualBillDays != null ? manualBillDays * hpd : d.actualHours);
    // Per Month spreads its fixed monthly revenue over the ESTIMATE to get a rate, so the
    // actual invoice can differ from the forecast — same derivation the edit path uses.
    const rate = mode === "MONTHLY" ? (est ? anchorMonthly / est : 0) : d.rateUsd;
    d.rateUsd = rate; d.estimateHours = est; d.actualHours = act;
    d.billingAmount = rate * est * fx; d.invoiceAmount = rate * act * fx;
  } else if (frac < 1) {
    // Derived (full-month) hours & revenue → only the deployed part of the month.
    d.estimateHours *= frac; d.actualHours *= frac; d.billingAmount *= frac; d.invoiceAmount *= frac;
  }
  let base = cCost;
  if (base == null) {
    if (ctcDaily) base = ctcDayRate * (hpd ? d.actualHours / hpd : 0); // day rate × billable days
    else if (ctcHourlyRate) base = ctcHourlyRate * d.actualHours;       // hourly rate × billable hours
    else base = proratedMonthly;                                        // prorated flat monthly CTC (already window-clipped above)
  }
  return { ...common, ...d, costUsd: base + addOns };
}

// Core "Add Line to Monthly Sheet" logic, factored out of the route below so other flows
// (e.g. HR's Confirm Joining / Activate Contractor) can create a line the exact same way —
// same cost engine, same deployment-window/double-dip/bench handling — without going through
// the HTTP layer (this router is Finance/Admin-only; Confirm Joining is an HR action).
export async function createMonthlyLine(sheetId: number, b: any, actorUserId?: number | null): Promise<
  | { ok: true; line: any; propagated: number; benched: number; benchRemoved: number }
  | { ok: false; status: number; error: string }
> {
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: sheetId } });
  if (!sheet) return { ok: false, status: 404, error: "Sheet not found" };
  if (sheet.status === "LOCKED") return { ok: false, status: 423, error: "This month is locked. Unlock it to make changes." };
  const fy = await prisma.fiscalYear.findUnique({ where: { label: sheet.fiscalYear } });
  if (fy?.status === "LOCKED") return { ok: false, status: 403, error: "Fiscal year is locked" };
  const emp = b.employeeId ? await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } }) : null;
  const proj = b.projectId ? await prisma.project.findUnique({ where: { id: Number(b.projectId) } }) : null;
  if (!emp) return { ok: false, status: 400, error: "Employee is required" };
  if (!proj) return { ok: false, status: 400, error: "Project is required" };
  // Non-billable resource = cost only: rate/hours and billing/invoice are zeroed.
  const billable = !(b.isBillable === false || b.isBillable === "false" || b.isBillable === "NON_BILLABLE");
  const fx = +b.fxMultiplier || 1;
  const hpd = proj.billingHoursPerDay || 8;
  const country = emp.location || null;
  const businessUnitId = (emp as any).businessUnitId ?? null;
  // Billing type: HOURLY (rate/hr + billing days), DAILY (day-rate, auto days), MONTHLY (fixed amount).
  const mode = ["DAILY", "MONTHLY", "HOURLY"].includes(b.billingMode) ? b.billingMode : "HOURLY";
  const anchorRate = mode === "DAILY" ? (+b.dayRate || 0) / hpd : (+b.rateUsd || 0); // fixed hourly rate (hourly/daily)
  const anchorMonthly = +b.monthlyAmount || 0;                                        // fixed monthly revenue (monthly)
  const manualDays = (mode === "HOURLY" && b.billingDays != null) ? +b.billingDays : null; // hourly: optional override (current month)
  // Add Line now exposes the same Estimate / Actual controls as Edit Resource Row. Estimate
  // drives Estimated Billing, Actual drives the Actual Invoice, and they are independent —
  // a forecast is not the same as what was worked. Per Day / Per Month take Actual from their
  // Billable Days when hours weren't given. All of this applies to the month being edited only;
  // propagated future months re-derive from their own (holiday-aware) working days.
  const num = (v: any) => (v != null && v !== "" ? +v : null);
  const manualEst = num(b.estimateHours);
  const manualAct = num(b.actualHours);
  const manualBillDays = mode !== "HOURLY" ? num(b.billingDays) : null;
  const hasManualHours = manualEst != null || manualAct != null || manualBillDays != null;
  // Base monthly cost: an explicit (manual) cost wins; otherwise it's derived from the CTC.
  // Hourly engagements (US Vendor / W2-No-Benefit) cost by their CTC rate × actual billable
  // work: HOURLY → rate/hr × billable hours; DAILY → rate/day × billable days. Everyone else
  // uses the flat monthly CTC (annual USD / 12). Add-ons (bonus, double-dip) sit on top.
  const clientCost = b.costUsd != null && +b.costUsd > 0 ? +b.costUsd : null;
  const cc = await computeEmployeeCost(emp.id);
  const isHourlyCtc = !!cc && (cc.usEngagement === "VENDOR" || cc.usEngagement === "W2_NO_BENEFIT");
  const ctcDaily = isHourlyCtc && (cc as any).rateBasis === "DAILY" && ((cc as any).dayRateUsd || 0) > 0;
  const ctcDayRate = ctcDaily ? ((cc as any).dayRateUsd || 0) : 0;
  const ctcHourlyRate = (isHourlyCtc && !ctcDaily) ? ((cc as any).hourlyCostUsd || 0) : 0;
  const addOns = (+b.bonus || 0) + (+b.doubleDipIncentive || 0);
  const wdCache = new Map<string, number>();
  // Deployment window: start / end dates (the employee's exit date also ends it). The edited month's
  // cost comes prorated from the client; later months are prorated here. Past the window the person
  // is benched (cost only) instead of getting a project row.
  const dStart = b.deploymentStart ? new Date(b.deploymentStart) : null;
  const dEnd = effectiveEnd(b.deploymentEnd, emp.exitDate);
  const hasWindow = !!(dStart || dEnd);
  const curFrac = hasWindow ? deployedFraction(sheet.fiscalYear, sheet.monthIndex, dStart, dEnd).fraction : 1;
  if (hasWindow && curFrac <= 0) return { ok: false, status: 400, error: `The deployment window doesn't cover ${sheet.month} ${sheet.fiscalYear}` };
  const ctx: LineComputeCtx = {
    emp, proj, billable, fx, hpd, country, businessUnitId, mode, anchorRate, anchorMonthly, manualDays,
    clientCost, curFrac, dStart, dEnd, hasWindow, ctcDaily, ctcDayRate, ctcHourlyRate, addOns, wdCache,
    manualEst, manualAct, manualBillDays, hasManualHours, bonus: +b.bonus || 0, doubleDipIncentive: +b.doubleDipIncentive || 0,
    doubleDip: !!b.doubleDip, allocationPct: b.allocationPct != null ? Math.round(+b.allocationPct) : 100, rawDeploymentEnd: b.deploymentEnd,
  };
  // Optional — which Sub-Project (resource/cost-center identity) within this Project the line
  // belongs to. Validated against the chosen project so a stale/foreign id can't leak through;
  // applied as a follow-up update rather than threaded through computeLineForMonth/LineComputeCtx
  // since it's a pure tag with no effect on cost/billing math.
  const subProjectId = b.subProjectId
    ? (await prisma.subProject.findFirst({ where: { id: Number(b.subProjectId), projectId: proj.id } }))?.id ?? null
    : null;
  const mk = (sheetId: number, fyL: string, mi: number, useManual: boolean) => computeLineForMonth(ctx, sheetId, fyL, mi, useManual);
  let line = await prisma.monthlyLine.create({ data: (await mk(sheet.id, sheet.fiscalYear, sheet.monthIndex, true))! });
  if (subProjectId) line = await prisma.monthlyLine.update({ where: { id: line.id }, data: { subProjectId } });
  await auditMonthlyLineChange(actorUserId, "ADD", sheet, null, line);
  let propagated = 0, benched = 0;
  const touched = [sheet.id];
  // Days this month the person is active but outside this deployment window (e.g. an end-of-month
  // deployment end, or — for a brand-new joiner whose window starts on their own joining date —
  // correctly none, since totalCost and the window-clipped deployedCost are then the same days).
  if (hasWindow && curFrac < 1 && await benchAfterWindow(sheet.id, emp.id, emp.name, sheet.fiscalYear, sheet.monthIndex, dStart, dEnd, line.id)) benched++;
  // Assigned for the whole month → any bench row this person still had here is absorbed.
  let benchRemoved = 0;
  if ((!hasWindow || curFrac >= 1) && await absorbBenchOnAssign(sheet.id, emp.id, line.id)) benchRemoved++;
  if (b.applyFuture) {
    for (const s of await editableFutureSheets(sheet.id)) {
      const exists = await prisma.monthlyLine.findFirst({ where: { monthlySheetId: s.id, isExpense: false, employeeId: emp.id, projectId: proj.id } });
      const frac = hasWindow ? deployedFraction(s.fiscalYear, s.monthIndex, dStart, dEnd).fraction : 1;
      if (exists) { // don't duplicate a resource already on that month — but still absorb a stale bench row
        if (frac >= 1 && await absorbBenchOnAssign(s.id, emp.id, exists.id)) { benchRemoved++; touched.push(s.id); }
        continue;
      }
      const data = await mk(s.id, s.fiscalYear, s.monthIndex, false);
      let lineId: number | undefined;
      if (data) {
        const c = await prisma.monthlyLine.create({ data: subProjectId ? { ...data, subProjectId } : data });
        propagated++; touched.push(s.id); lineId = c.id;
      }
      // Deployed the whole month → the bench row is absorbed; a part month keeps the remainder below.
      if (data && (!hasWindow || frac >= 1) && await absorbBenchOnAssign(s.id, emp.id, lineId)) benchRemoved++;
      // Outside / past the window: bench (cost only, no estimate, no invoice) until the exit date.
      if (hasWindow && frac < 1 && await benchAfterWindow(s.id, emp.id, emp.name, s.fiscalYear, s.monthIndex, dStart, dEnd, lineId)) benched++;
    }
  }
  // a new billable line may make the resource a double-dip → split their CTC across projects
  for (const sid of touched) await splitDoubleDipCost(sid, emp.id);
  // a new billable resource changes any PER_BILLABLE incentive expense for the month(s)
  if (billable) for (const sid of touched) await recomputeIncentiveLines(sid);
  return { ok: true, line, propagated, benched, benchRemoved };
}

// Read-only dry run of what createMonthlyLine (with applyFuture) would actually produce, month by
// month, WITHOUT writing anything — so Finance can see cost/hours/billing/invoice for every
// affected month (from the deployment window) before ever clicking Approve on a CTC request, and
// correct the Project/Rate/Deployment dates first if something looks wrong. Deliberately reuses
// computeLineForMonth (the exact function createMonthlyLine itself calls) rather than a second,
// hand-written formula, so this can never show a forecast that doesn't match what Approve actually
// creates. Only covers the deployed-project line itself, same scope as createMonthlyLine's own
// applyFuture loop (current fiscal year forward) — it does not also simulate the Bench-complement
// rows benchAfterWindow would add for a partial month, which stay cost-only and are secondary to
// what Finance is reviewing here (the billable engagement itself).
export async function previewMonthlyLineImpact(sheetId: number, b: any): Promise<
  | { ok: true; months: { sheetId: number; month: string; fiscalYear: string; monthIndex: number; costUsd: number; estimateHours: number; actualHours: number; billingAmount: number; invoiceAmount: number; rateUsd: number; isBillable: boolean; locked?: boolean }[] }
  | { ok: false; status: number; error: string }
> {
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: sheetId } });
  if (!sheet) return { ok: false, status: 404, error: "Sheet not found" };
  // createMonthlyLine hard-rejects (and creates NOTHING, not even future months) the instant its
  // own anchor sheet is locked — same check here so the preview shows that up front instead of a
  // confident-looking cost table for a month Approve will actually refuse to touch at all.
  if (sheet.status === "LOCKED") return { ok: false, status: 423, error: `${sheet.month} ${sheet.fiscalYear} is locked — unlock it first, or nothing will be added to Monthly Forecast for this deployment.` };
  const emp = b.employeeId ? await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } }) : null;
  const proj = b.projectId ? await prisma.project.findUnique({ where: { id: Number(b.projectId) } }) : null;
  if (!emp) return { ok: false, status: 400, error: "Employee is required" };
  if (!proj) return { ok: false, status: 400, error: "Project is required" };
  const billable = !(b.isBillable === false || b.isBillable === "false" || b.isBillable === "NON_BILLABLE");
  const fx = +b.fxMultiplier || 1;
  const hpd = proj.billingHoursPerDay || 8;
  const country = emp.location || null;
  const businessUnitId = (emp as any).businessUnitId ?? null;
  const mode = ["DAILY", "MONTHLY", "HOURLY"].includes(b.billingMode) ? b.billingMode : "HOURLY";
  const anchorRate = mode === "DAILY" ? (+b.dayRate || 0) / hpd : (+b.rateUsd || 0);
  const anchorMonthly = +b.monthlyAmount || 0;
  const clientCost = b.costUsd != null && +b.costUsd > 0 ? +b.costUsd : null;
  const cc = await computeEmployeeCost(emp.id);
  const isHourlyCtc = !!cc && (cc.usEngagement === "VENDOR" || cc.usEngagement === "W2_NO_BENEFIT");
  const ctcDaily = isHourlyCtc && (cc as any).rateBasis === "DAILY" && ((cc as any).dayRateUsd || 0) > 0;
  const ctcDayRate = ctcDaily ? ((cc as any).dayRateUsd || 0) : 0;
  const ctcHourlyRate = (isHourlyCtc && !ctcDaily) ? ((cc as any).hourlyCostUsd || 0) : 0;
  const addOns = (+b.bonus || 0) + (+b.doubleDipIncentive || 0);
  const dStart = b.deploymentStart ? new Date(b.deploymentStart) : null;
  const dEnd = effectiveEnd(b.deploymentEnd, emp.exitDate);
  const hasWindow = !!(dStart || dEnd);
  const curFrac = hasWindow ? deployedFraction(sheet.fiscalYear, sheet.monthIndex, dStart, dEnd).fraction : 1;
  if (hasWindow && curFrac <= 0) return { ok: false, status: 400, error: `The deployment window doesn't cover ${sheet.month} ${sheet.fiscalYear} — pick a Deployment Start on or before this month, or move the starting month.` };
  // A pending CtcApprovalRequest has no real CtcRecord yet — it's only created inside POST
  // /approve, before createMonthlyLine runs — so computeMonthlyEmployeeCostUsd would otherwise
  // read zero CTC history here and show $0 cost for every month. b.virtualCtc, when the caller
  // supplies it (the forecast-preview route below, from the pending request's own proposed CTC
  // fields), stands in for that not-yet-real record — shaped exactly like a CtcRecord row.
  const virtualCtc = b.virtualCtc ? [b.virtualCtc] : undefined;
  const ctx: LineComputeCtx = {
    emp, proj, billable, fx, hpd, country, businessUnitId, mode, anchorRate, anchorMonthly, manualDays: null,
    clientCost, curFrac, dStart, dEnd, hasWindow, ctcDaily, ctcDayRate, ctcHourlyRate, addOns, wdCache: new Map(),
    manualEst: null, manualAct: null, manualBillDays: null, hasManualHours: false, bonus: +b.bonus || 0, doubleDipIncentive: +b.doubleDipIncentive || 0,
    doubleDip: !!b.doubleDip, allocationPct: b.allocationPct != null ? Math.round(+b.allocationPct) : 100, rawDeploymentEnd: b.deploymentEnd, virtualCtc,
  };
  // Separate read-only call, preview-only — never touches what createMonthlyLine actually writes
  // (computeLineForMonth's own return is spread straight into prisma.monthlyLine.create(), so it
  // can only ever carry real MonthlyLine columns). This exists purely so Finance can see WHY a
  // given month's cost is what it is — e.g. "6 of 30 days" — instead of a bare dollar figure with
  // no visible derivation, especially when the employee's real joining date, the CTC's own
  // Effective From/Till, and the deployment window don't all line up (a very real, easy mistake at
  // data-entry time — three separate date fields any one of which can silently clip a month's
  // active days to less than what Finance was expecting).
  const daysFor = async (fyL: string, mi: number) => {
    const { segments, dim } = await computeMonthlyCostBreakdown(emp.id, fyL, mi, dStart, dEnd, virtualCtc);
    return { costDays: segments.reduce((s, x) => s + x.days, 0), costDaysOf: dim };
  };
  const months: any[] = [];
  const first = await computeLineForMonth(ctx, sheet.id, sheet.fiscalYear, sheet.monthIndex, true);
  if (first) months.push({ sheetId: sheet.id, month: sheet.month, fiscalYear: sheet.fiscalYear, monthIndex: sheet.monthIndex, ...first, ...(await daysFor(sheet.fiscalYear, sheet.monthIndex)) });
  // Same scope as createMonthlyLine's own applyFuture loop — the rest of THIS fiscal year, forward
  // of the anchor month. Deployment windows spanning into a not-yet-open next fiscal year are
  // simply not previewed past that boundary, matching what applyFuture itself would (not) do.
  //
  // Unlike editableFutureSheets (which createMonthlyLine's own applyFuture loop uses, and which
  // silently excludes LOCKED sheets), this reads EVERY sheet in that range including locked ones —
  // a locked month still inside the deployment window is flagged (locked: true, no cost/billing
  // computed for it) instead of just vanishing from the table with no explanation. Approve itself
  // still only ever writes to unlocked months (createMonthlyLine's own applyFuture skips locked
  // ones the same as before) — this only changes what the preview SHOWS Finance beforehand.
  const laterSheets = await prisma.monthlySheet.findMany({ where: { fiscalYear: sheet.fiscalYear, monthIndex: { gt: sheet.monthIndex } }, orderBy: { monthIndex: "asc" } });
  for (const s of laterSheets) {
    if (s.status === "LOCKED") {
      const frac = ctx.hasWindow ? deployedFraction(s.fiscalYear, s.monthIndex, ctx.dStart, ctx.dEnd).fraction : 1;
      if (frac > 0) months.push({ sheetId: s.id, month: s.month, fiscalYear: s.fiscalYear, monthIndex: s.monthIndex, locked: true, costUsd: 0, estimateHours: 0, actualHours: 0, billingAmount: 0, invoiceAmount: 0, rateUsd: 0, isBillable: ctx.billable });
      continue;
    }
    const data = await computeLineForMonth(ctx, s.id, s.fiscalYear, s.monthIndex, false);
    if (data) { months.push({ sheetId: s.id, month: s.month, fiscalYear: s.fiscalYear, monthIndex: s.monthIndex, ...data, ...(await daysFor(s.fiscalYear, s.monthIndex)) }); continue; }
    // computeLineForMonth returns null once the deployment window has ended (frac <= 0) — every
    // sheet in THIS loop is chronologically after the anchor month, so for a later sheet that can
    // only mean "past Deployment End", never "before Deployment Start" (ctcApprovals.ts's own gap
    // preview already covers that earlier case separately). createMonthlyLine's own applyFuture
    // loop doesn't just stop there either — benchAfterWindow gives the person a real Bench row for
    // the rest of their CTC cost. Without mirroring that here, Finance's preview silently ended at
    // Deployment End with no hint that Approve will actually keep producing (Bench) months after
    // it — which is exactly what made a real Deployment End date look like a bug the first time.
    if (ctx.hasWindow && ctx.dEnd) {
      const benchCost = round2(await computeMonthlyEmployeeCostUsd(emp.id, s.fiscalYear, s.monthIndex, undefined, undefined, virtualCtc));
      if (benchCost > 0) months.push({ sheetId: s.id, month: s.month, fiscalYear: s.fiscalYear, monthIndex: s.monthIndex, costUsd: benchCost, estimateHours: 0, actualHours: 0, billingAmount: 0, invoiceAmount: 0, rateUsd: 0, isBillable: false, isBenchAfterEnd: true });
    }
  }
  return { ok: true, months };
}

// add a new line to a sheet (pick an existing employee + an existing project)
router.post("/:id/lines", requireAdmin, async (req, res) => {
  const result = await createMonthlyLine(Number(req.params.id), req.body, req.user!.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ ...result.line, propagated: result.propagated, benched: result.benched, benchRemoved: result.benchRemoved });
});

// add an expense / overhead line (no revenue) — reflected in dashboard internalCost
router.post("/:id/expense-lines", requireAdmin, async (req, res) => {
  const b = req.body;
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!sheet) return res.status(404).json({ error: "Sheet not found" });
  if (await blockedIfLocked(sheet.id, res)) return;
  if (!b.category) return res.status(400).json({ error: "Category is required" });
  const resourceName = b.description || b.category;
  const expenseType = b.expenseType === "FIXED" ? "FIXED" : "VARIABLE";
  const region = b.region ? String(b.region).toUpperCase() : null;
  // Allocation: PROJECT requires a valid target projectId so it factors into that project's margin.
  let allocProjectId: number | null = null;
  if (b.expenseScope === "PROJECT" && b.projectId) {
    const proj = await prisma.project.findUnique({ where: { id: Number(b.projectId) } });
    if (proj) allocProjectId = proj.id;
  }
  const expenseScope = allocProjectId ? "PROJECT" : "ORG";
  // Calculation: PER_BILLABLE = perResourceInr × offshore billable headcount (INR→USD);
  // DYNAMIC = percentValue% of the month's total employee cost (USD); PCT_PREV_INVOICE =
  // percentValue% of the PREVIOUS month's invoice total across commissionProjectIds (USD).
  const calc = b.expenseCalc === "PER_BILLABLE" ? "PER_BILLABLE" : b.expenseCalc === "DYNAMIC" ? "DYNAMIC" : b.expenseCalc === "PCT_PREV_INVOICE" ? "PCT_PREV_INVOICE" : "FIXED";
  const perResourceInr = calc === "PER_BILLABLE" ? (+b.perResourceInr || 0) : null;
  const percentValue = (calc === "DYNAMIC" || calc === "PCT_PREV_INVOICE") ? (+b.percentValue || 0) : null;
  // PER_BILLABLE manual headcount override (null = auto-track the month's live offshore count).
  const headcountOverride = calc === "PER_BILLABLE" && b.headcountOverride != null && b.headcountOverride !== ""
    ? Math.round(+b.headcountOverride) : null;
  const commissionProjectIds = calc === "PCT_PREV_INVOICE" ? parseCommissionProjectIds(b.commissionProjectIds) : [];
  const mk = async (sheetId: number) => {
    let currency = b.currency || "USD";
    let nativeAmount = b.amount != null ? +b.amount : (+b.costUsd || 0);
    if (calc === "PER_BILLABLE") { currency = "INR"; nativeAmount = (perResourceInr || 0) * (headcountOverride ?? await offshoreBillableHeadcount(sheetId)); }
    else if (calc === "DYNAMIC") { currency = "USD"; nativeAmount = ((percentValue || 0) / 100) * (await totalEmployeeCostUsd(sheetId)); }
    else if (calc === "PCT_PREV_INVOICE") { currency = "USD"; nativeAmount = ((percentValue || 0) / 100) * (await prevMonthProjectInvoiceUsdForSheet(sheetId, commissionProjectIds || [])); }
    return {
      monthlySheetId: sheetId, employeeId: null, projectId: allocProjectId,
      resourceName, projectName: b.category,
      rateUsd: 0, estimateHours: 0, actualHours: 0, fxMultiplier: 1,
      billingAmount: 0, invoiceAmount: 0, currency, nativeAmount, costUsd: await toUsd(nativeAmount, currency),
      isExpense: true, expenseType, region, expenseScope, expenseCalc: calc, perResourceInr, percentValue, headcountOverride, commissionProjectIds,
    };
  };
  const line = await prisma.monthlyLine.create({ data: await mk(sheet.id) });
  await auditMonthlyLineChange(req.user!.id, "ADD", sheet, null, line);
  let propagated = 0;
  if (b.applyFuture) {
    for (const s of await editableFutureSheets(sheet.id)) {
      const exists = await prisma.monthlyLine.findFirst({ where: { monthlySheetId: s.id, isExpense: true, projectName: b.category, resourceName } });
      if (exists) continue;
      await prisma.monthlyLine.create({ data: await mk(s.id) }); propagated++;
    }
  }
  res.status(201).json({ ...line, propagated });
});

// Add every ACTIVE employee not already planned this month (no resource line) as a
// Non-billable bench resource under "GenAquarius (Bench)", with cost from their CTC.
// List the bench candidates (active employees not yet on the sheet) with their cost.
router.get("/:id/bench-candidates", requireAdmin, async (req, res) => {
  const { sheet, candidates } = await benchCandidates(Number(req.params.id));
  res.json({ locked: sheet?.status === "LOCKED", candidates });
});

// Add selected employees (employeeIds) to the bench; omit to add all candidates.
router.post("/:id/bench", requireAdmin, async (req, res) => {
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!sheet) return res.status(404).json({ error: "Sheet not found" });
  if (await blockedIfLocked(sheet.id, res)) return;
  const ids = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds.map(Number) : undefined;
  const added = await addBenchLines(sheet.id, ids);
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "ADD_BENCH", entity: "MonthlySheet", entityId: String(sheet.id), after: { month: sheet.month, fiscalYear: sheet.fiscalYear, added } } }).catch(() => {});
  res.json({ added, project: BENCH_PROJECT });
});

// remove a line. ?applyFuture=true also removes the matching row from every later
// editable month already forecasted in this fiscal year.
router.delete("/lines/:id", requireAdmin, async (req, res) => {
  const line = await prisma.monthlyLine.findUnique({ where: { id: Number(req.params.id) } });
  if (!line) return res.status(404).json({ error: "Not found" });
  if (await blockedIfLocked(line.monthlySheetId, res)) return;
  const sheet = await prisma.monthlySheet.findUnique({ where: { id: line.monthlySheetId } });
  let propagated = 0;
  const touched = [line.monthlySheetId];
  if (req.query.applyFuture === "true") {
    for (const s of await editableFutureSheets(line.monthlySheetId)) {
      const m = await findMatchInSheet(s.id, line);
      if (m) { await prisma.monthlyLine.delete({ where: { id: m.id } }); await auditMonthlyLineChange(req.user!.id, "REMOVE", s, m, null); propagated++; touched.push(s.id); }
    }
  }
  await prisma.monthlyLine.delete({ where: { id: line.id } });
  if (sheet) await auditMonthlyLineChange(req.user!.id, "REMOVE", sheet, line, null);
  // removing a billable line may end a double-dip → restore/resplit the resource's CTC
  if (!line.isExpense && line.isBillable) for (const sid of touched) await splitDoubleDipCost(sid, line.employeeId, true);
  // removing a billable resource changes the month's PER_BILLABLE incentive
  if (!line.isExpense && line.isBillable) for (const sid of touched) await recomputeIncentiveLines(sid);
  res.json({ ok: true, propagated });
});

// clear ALL lines of a month. ?allFuture=true also clears every later editable month in
// the same fiscal year (selected month → March), so you don't clear each month by hand.
router.delete("/:id/lines", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (await blockedIfLocked(id, res)) return;
  const targetSheets = [await prisma.monthlySheet.findUnique({ where: { id } })].filter(Boolean) as any[];
  if (req.query.allFuture === "true") targetSheets.push(...(await editableFutureSheets(id)));
  const targets = targetSheets.map((s) => s.id);
  const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: { in: targets } } });
  const sheetById = new Map(targetSheets.map((s) => [s.id, s]));
  const r = await prisma.monthlyLine.deleteMany({ where: { monthlySheetId: { in: targets } } });
  for (const l of lines) { const s = sheetById.get(l.monthlySheetId); if (s) await auditMonthlyLineChange(req.user!.id, "REMOVE", s, l, null); }
  res.json({ ok: true, deleted: r.count, months: targets.length });
});

const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
function nextMonth(fy: string, monthIndex: number) {
  if (monthIndex < 12) return { fiscalYear: fy, month: MONTHS[monthIndex], monthIndex: monthIndex + 1 };
  const m = fy.match(/FY(\d+)-(\d+)/);
  const nf = m ? `FY${+m[1] + 1}-${+m[2] + 1}` : fy;
  return { fiscalYear: nf, month: "Apr", monthIndex: 1 };
}

// Build the cloned lines for one target sheet, deriving billing for THAT month's working
// days (HOURLY/DAILY keep rate, MONTHLY keeps revenue). Returns the rows to createMany.
async function buildClonedLines(srcLines: any[], src: { fiscalYear: string; monthIndex: number }, targetFiscalYear: string, targetIndex: number, targetSheetId: number, cache: Map<string, number>) {
  const lines: any[] = [];
  const ended = new Set<any>();                               // project rows cut short by their window
  const benchFor = new Map<number, { name: string; fraction: number }>(); // employee → bench share of target month
  for (const l of srcLines) {
    let rate = l.rateUsd, est = l.estimateHours, act = l.actualHours, billing = l.billingAmount, invoice = l.invoiceAmount, cost = l.costUsd;
    // Deployment window (line start/end, and the employee's exit date): skip months the resource
    // isn't deployed in, prorate partial months (un-prorating the source month first), and bench
    // the person for the rest. Bench rows are re-costed for the target month (exit-date aware).
    const dEnd = l.isExpense ? null : effectiveEnd(l.deploymentEnd, l.employee?.exitDate);
    const bench = isBenchLine(l);
    if (bench && l.employeeId) {
      if (dEnd && deployedFraction(targetFiscalYear, targetIndex, null, dEnd).fraction <= 0) continue; // exited
      cost = round2(await computeMonthlyEmployeeCostUsd(l.employeeId, targetFiscalYear, targetIndex));
      if (cost <= 0) continue;
    }
    const hasWindow = !l.isExpense && !bench && !!(l.deploymentStart || dEnd);
    const tgtFrac = hasWindow ? deployedFraction(targetFiscalYear, targetIndex, l.deploymentStart, dEnd).fraction : 1;
    if (hasWindow && tgtFrac < 1 && l.employeeId) benchFor.set(l.employeeId, { name: l.resourceName, fraction: 1 - tgtFrac });
    if (tgtFrac <= 0) continue;
    const srcFrac = hasWindow ? deployedFraction(src.fiscalYear, src.monthIndex, l.deploymentStart, dEnd).fraction : 1;
    let hoursFrom = srcFrac;
    if (!l.isExpense && l.isBillable && l.projectId) {
      hoursFrom = 1; // re-derived below for the full target month
      const hpd = l.project?.billingHoursPerDay || 8;
      const wd = await workingDaysInMonth(targetFiscalYear, targetIndex, l.employee?.location || null, l.employee?.businessUnitId, cache);
      const d = deriveBillable({ mode: l.billingMode || "HOURLY", rateUsd: l.rateUsd, monthlyAmount: l.billingAmount, workingDays: wd, hpd, fx: l.fxMultiplier });
      rate = d.rateUsd; est = d.estimateHours; act = d.actualHours; billing = d.billingAmount; invoice = d.invoiceAmount;
    }
    const row = {
      monthlySheetId: targetSheetId, employeeId: l.employeeId, projectId: l.projectId,
      resourceName: l.resourceName, projectName: l.projectName,
      rateUsd: rate, estimateHours: est, actualHours: act,
      fxMultiplier: l.fxMultiplier, billingAmount: billing, invoiceAmount: invoice,
      costUsd: cost, adjustment: l.adjustment, isExpense: l.isExpense, isBillable: l.isBillable, billingMode: l.billingMode || "HOURLY",
      // preserve expense metadata so cloned expenses keep currency/category/allocation/calc —
      // percentValue/headcountOverride/commissionProjectIds must travel too, or a cloned DYNAMIC /
      // PCT_PREV_INVOICE commission line loses its % and recomputes to $0 in the target month.
      currency: l.currency, nativeAmount: l.nativeAmount, expenseType: l.expenseType, region: l.region,
      expenseScope: l.expenseScope, expenseCalc: l.expenseCalc, perResourceInr: l.perResourceInr,
      percentValue: l.percentValue, headcountOverride: (l as any).headcountOverride, commissionProjectIds: (l as any).commissionProjectIds ?? [],
      // resource add-ons + deployment window travel with the line
      bonus: l.bonus, doubleDipIncentive: l.doubleDipIncentive, doubleDip: !!l.doubleDip, allocationPct: l.allocationPct ?? 100,
      deploymentStart: l.isExpense ? null : l.deploymentStart, deploymentEnd: l.isExpense ? null : l.deploymentEnd,
    };
    const out = hasWindow ? scaleToWindow(row, { hoursFrom, costFrom: srcFrac, to: tgtFrac }) : row;
    if (hasWindow && tgtFrac < 1) ended.add(out);
    lines.push(out);
  }
  // Bench the people whose window ended (unless they have another row that month): cost only.
  for (const [employeeId, b] of benchFor) {
    if (lines.some((r) => r.employeeId === employeeId && !ended.has(r))) continue; // elsewhere / already benched
    const cost = round2((await computeMonthlyEmployeeCostUsd(employeeId, targetFiscalYear, targetIndex)) * b.fraction);
    if (cost <= 0) continue;
    lines.push({ monthlySheetId: targetSheetId, employeeId, projectId: null, resourceName: b.name, projectName: BENCH_PROJECT,
      rateUsd: 0, estimateHours: 0, actualHours: 0, fxMultiplier: 1, billingAmount: 0, invoiceAmount: 0, costUsd: cost, isExpense: false, isBillable: false, billingMode: "HOURLY" });
  }
  return lines;
}

// After cloning, rebalance each double-dip whose billable lines carry a deployment window (or whose
// employee exited): a project row dropped by the window hands its CTC share to the surviving row.
async function fixDoubleDipAfterClone(targetSheetId: number, srcLines: any[]): Promise<void> {
  const byEmp = new Map<number, any[]>();
  for (const l of srcLines) if (!l.isExpense && l.isBillable && l.employeeId) { const a = byEmp.get(l.employeeId) || []; a.push(l); byEmp.set(l.employeeId, a); }
  for (const [empId, ls] of byEmp) {
    if (!ls.some((l) => l.deploymentStart || l.deploymentEnd || l.employee?.exitDate)) continue; // no windows → cloned costs already right
    const tgt = await prisma.monthlyLine.count({ where: { monthlySheetId: targetSheetId, employeeId: empId, isExpense: false, isBillable: true } });
    if (tgt >= 2) await splitDoubleDipCost(targetSheetId, empId);
    else if (tgt === 1 && ls.length > 1) await splitDoubleDipCost(targetSheetId, empId, true);
  }
}

// Clone a sheet's lines into a target month (default = next month) as a DRAFT — or, with
// spreadFuture:true, into EVERY later editable month of the same fiscal year (→ March).
router.post("/:id/clone", requireAdmin, async (req, res) => {
  const src = await prisma.monthlySheet.findUnique({
    where: { id: Number(req.params.id) },
    include: { lines: { include: { employee: { select: { location: true, exitDate: true, businessUnitId: true } }, project: { select: { billingHoursPerDay: true } } } } },
  });
  if (!src) return res.status(404).json({ error: "Source sheet not found" });
  const cache = new Map<string, number>();

  // Spread to all later editable months in the same fiscal year (overwrites each).
  if (req.body?.spreadFuture) {
    const targets = await editableFutureSheets(src.id); // same FY, monthIndex > src, not LOCKED
    let totalLines = 0;
    for (const t of targets) {
      await prisma.monthlyLine.deleteMany({ where: { monthlySheetId: t.id } });
      await prisma.monthlySheet.update({ where: { id: t.id }, data: { status: "DRAFT" } }).catch(() => {});
      const lines = await buildClonedLines(src.lines, src, t.fiscalYear, t.monthIndex, t.id, cache);
      if (lines.length) await prisma.monthlyLine.createMany({ data: lines });
      await fixDoubleDipAfterClone(t.id, src.lines);
      await recomputeIncentiveLines(t.id);
      totalLines += lines.length;
    }
    await prisma.auditLog.create({ data: { userId: req.user!.id, action: "CLONE_SHEET_SPREAD", entity: "MonthlySheet", entityId: String(src.id), after: { from: `${src.month} ${src.fiscalYear}`, months: targets.length, totalLines } } }).catch(() => {});
    return res.json({ spread: true, months: targets.length, monthNames: targets.map((t) => t.month), totalLines });
  }

  let { targetFiscalYear, targetMonth, overwrite } = req.body || {};
  if (!targetMonth) { const n = nextMonth(src.fiscalYear, src.monthIndex); targetFiscalYear = n.fiscalYear; targetMonth = n.month; }
  const targetIndex = MONTHS.indexOf(targetMonth) + 1;
  if (targetIndex < 1) return res.status(400).json({ error: "Invalid target month" });

  let target = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear: targetFiscalYear, month: targetMonth } } });
  if (target && !overwrite) return res.status(409).json({ error: `${targetMonth} ${targetFiscalYear} already exists. Enable "replace" to overwrite it.` });
  if (target && target.status === "LOCKED") return res.status(423).json({ error: `${targetMonth} ${targetFiscalYear} is locked. Unlock it before overwriting.` });
  if (target) {
    await prisma.monthlyLine.deleteMany({ where: { monthlySheetId: target.id } });
    await prisma.monthlySheet.update({ where: { id: target.id }, data: { status: "DRAFT" } });
  } else {
    target = await prisma.monthlySheet.create({ data: { fiscalYear: targetFiscalYear, month: targetMonth, monthIndex: targetIndex, status: "DRAFT", createdById: req.user!.id } });
  }

  const lines = await buildClonedLines(src.lines, src, targetFiscalYear, targetIndex, target.id, cache);
  if (lines.length) await prisma.monthlyLine.createMany({ data: lines });
  await fixDoubleDipAfterClone(target.id, src.lines);
  await recomputeIncentiveLines(target.id);
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "CLONE_SHEET", entity: "MonthlySheet", entityId: String(target.id), after: { from: `${src.month} ${src.fiscalYear}`, to: `${targetMonth} ${targetFiscalYear}`, lines: lines.length } } }).catch(() => {});
  res.json({ id: target.id, fiscalYear: targetFiscalYear, month: targetMonth, clonedLines: lines.length });
});

// lock — finalize the month (blocks all edits until unlocked)
router.post("/:id/lock", requireAdmin, async (req, res) => {
  const s = await prisma.monthlySheet.update({ where: { id: Number(req.params.id) }, data: { status: "LOCKED", lockedAt: new Date() } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "LOCK_SHEET", entity: "MonthlySheet", entityId: String(s.id) } }).catch(() => {});
  res.json(s);
});

// unlock — re-open the month for editing (admin)
router.post("/:id/unlock", requireAdmin, async (req, res) => {
  const s = await prisma.monthlySheet.update({ where: { id: Number(req.params.id) }, data: { status: "DRAFT", lockedAt: null } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "UNLOCK_SHEET", entity: "MonthlySheet", entityId: String(s.id) } }).catch(() => {});
  res.json(s);
});

// ---- Classify expense/overhead lines as FIXED vs VARIABLE ----
// Default classification (by expense description) provided by Finance. The endpoint
// applies it to EVERY expense line across all months/years (matched on description,
// case/space-insensitive). Re-runnable; pass {fixed:[],variable:[]} to extend.
const DEFAULT_FIXED = [
  "Anil singh (Network Engi)", "Vivek Kaw", "Manoj (Recruiter salary) & LinkedIn", "Vishal Ganju",
  "India Health Insurance", "Office space (India)", "Greyt (HRMS)", "Accountant Cost (India)", "Kumar",
];
const DEFAULT_VARIABLE = [
  "Sandeep Commision_Billable", "3.Vishal", "4.Vivek", "11.Prasha Solutions", "13. Manoj",
  "Incentive 2% Arun", "Loading 5%", "Laptop", "Techprayag", "Other expense", "Credit Card Expense",
  "Tax 26% of 15% for Transfer Pricing", "US Health Insurance", "Canada Health Insurance", "US Payroll Tax - 9%",
  "Accountant Cost (US & Canada )", "Travel", "2.36% Clarien Meeta", "DJ (commission for Cozzini)",
  "US other expense", "US Laptops", "Cost _Website Linkdin_Proposal(Arup)",
];
const norm = (s: string) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();

router.post("/classify-expenses", requireAdmin, async (req, res) => {
  const fixedSet = new Set([...DEFAULT_FIXED, ...((req.body?.fixed as string[]) || [])].map(norm));
  const varSet = new Set([...DEFAULT_VARIABLE, ...((req.body?.variable as string[]) || [])].map(norm));
  const lines = await prisma.monthlyLine.findMany({ where: { isExpense: true }, select: { id: true, resourceName: true } });
  let fixed = 0, variable = 0;
  for (const l of lines) {
    const n = norm(l.resourceName);
    if (fixedSet.has(n)) { await prisma.monthlyLine.update({ where: { id: l.id }, data: { expenseType: "FIXED" } }); fixed++; }
    else if (varSet.has(n)) { await prisma.monthlyLine.update({ where: { id: l.id }, data: { expenseType: "VARIABLE" } }); variable++; }
  }
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "CLASSIFY_EXPENSES", entity: "MonthlyLine", after: { scanned: lines.length, fixed, variable } } }).catch(() => {});
  res.json({ scanned: lines.length, fixed, variable });
});

export default router;
