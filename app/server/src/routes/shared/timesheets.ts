import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole, ADMIN_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { Role } from "@prisma/client";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { emitPendingActionsUpdate, emitAttention } from "../../engine/realtime";
import { fiscalOfDate, deployedFraction } from "../../engine/workdays";

const router = Router();
const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const isAdmin = (role: Role) => ADMIN_ROLES.includes(role);

const audit = (userId: number, action: string, id: number, after?: any) =>
  prisma.auditLog.create({ data: { userId, action, entity: "Timesheet", entityId: String(id), after } }).catch(() => {});

// Holding the global PROJECT_MANAGER role is NOT enough to review a timesheet — explicit
// requirement: a PM can only see/approve/reject timesheets for projects they're actually assigned
// to as PM (ProjectManager — see schema.prisma's own comment). Admin roles bypass this (they can
// act on anything, same as every other approval in the app).
async function isAssignedPm(employeeId: number | null, projectId: number): Promise<boolean> {
  if (!employeeId) return false;
  const row = await prisma.projectManager.findUnique({ where: { projectId_employeeId: { projectId, employeeId } } });
  return !!row;
}

// Projects the logged-in user may log a timesheet against for a given CALENDAR period (?month=&
// year=, same numbering as Timesheet.periodMonth/periodYear). For a plain EMPLOYEE, the period is
// REQUIRED and is the single source of truth: a project only shows if Monthly Forecast actually
// has them deployed there that month (a resource line, deployment window covering at least part
// of it) — matching what the PM/Finance "Timesheet Approvals → By Month" view already uses
// Monthly Forecast for, instead of the separate, easily-stale EmployeeProject assignment table.
// Admin/PM roles are UNCHANGED/unscoped on purpose — "act on behalf of" needs to be able to enter
// a timesheet for any employee against any project (e.g. backfilling a project that predates that
// employee's current Monthly Forecast assignment), so month/employeeId are ignored for them.
router.get("/my-projects", async (req, res) => {
  const u = req.user!;
  if (isAdmin(u.role) || u.role === Role.PROJECT_MANAGER) {
    return res.json(await prisma.project.findMany({ include: { client: true }, orderBy: { name: "asc" } }));
  }
  if (!u.employeeId) return res.json([]);
  const month = Number(req.query.month), year = Number(req.query.year);
  if (!month || !year) return res.json([]); // month comes first — nothing to show before a period is picked
  const { fiscalYear, monthIndex } = fiscalOfDate(new Date(Date.UTC(year, month - 1, 1)));
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: MONTHS[monthIndex - 1] } } });
  if (!sheet) return res.json([]);
  const lines = await prisma.monthlyLine.findMany({
    where: { monthlySheetId: sheet.id, employeeId: u.employeeId, isExpense: false, projectId: { not: null } },
    include: { project: { include: { client: true } } },
  });
  const byId = new Map<number, any>();
  for (const l of lines) {
    if (!l.project) continue;
    if (deployedFraction(fiscalYear, monthIndex, l.deploymentStart, l.deploymentEnd).fraction > 0) byId.set(l.project.id, l.project);
  }
  res.json([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
});

// Projects the Approvals page's client/project selector should offer — admin/Finance sees
// everything, a PM only the projects they're actually assigned to as PM (ProjectManager), never
// the full company list. Unlike /my-projects above (which deliberately shows a PM every project
// so they can log their OWN hours against any of them), reviewing/approving someone else's
// timesheet is scoped to real PM assignment everywhere else in this file (see isAssignedPm) — the
// dropdown that drives those calls needs the same scoping, or a PM sees an empty/wrong picker.
router.get("/managed-projects", async (req, res) => {
  const u = req.user!;
  if (isAdmin(u.role)) return res.json(await prisma.project.findMany({ include: { client: true }, orderBy: { name: "asc" } }));
  if (u.role !== Role.PROJECT_MANAGER || !u.employeeId) return res.json([]);
  const assigned = await prisma.projectManager.findMany({
    where: { employeeId: u.employeeId },
    include: { project: { include: { client: true } } },
  });
  res.json(assigned.map((a) => a.project));
});

// admins: full employee list, for entering / testing a timesheet on someone's behalf
router.get("/employees", requireRole(...ADMIN_ROLES), requirePermission("my-timesheet"), async (_req, res) => {
  res.json(await prisma.employee.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }));
});

// the employee whose sheet we read/write: admins may target anyone via employeeId
function targetEmp(req: any): number | null {
  const u = req.user!;
  const ov = Number(req.body?.employeeId ?? req.query?.employeeId);
  if (ov && isAdmin(u.role)) return ov;
  return u.employeeId ?? null;
}

// my (or, for admins, the selected employee's) timesheets — calendar entries included
router.get("/mine", async (req, res) => {
  const empId = targetEmp(req);
  if (!empId) return res.json([]);
  res.json(await prisma.timesheet.findMany({
    where: { employeeId: empId },
    include: { project: true, entries: true },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  }));
});

// create/update a month's timesheet from day-level calendar entries (hours / leave + comment)
router.post("/", async (req, res) => {
  const u = req.user!;
  const empId = targetEmp(req);
  if (!empId) return res.status(400).json({ error: "No employee selected" });
  const { projectId, periodMonth, periodYear, entries } = req.body;
  if (u.role === Role.EMPLOYEE || u.role === Role.CONTRACTOR || u.role === Role.INTERN) {
    const link = await prisma.employeeProject.findFirst({ where: { employeeId: empId, projectId: Number(projectId) } });
    if (!link) return res.status(403).json({ error: "Not assigned to this project" });
  }
  const list: any[] = Array.isArray(entries) ? entries : [];
  const totalHours = list.reduce((s, e) => s + (e.leave ? 0 : +e.hours || 0), 0);
  // billable defaults true (unset = billable, the common case) — only an explicit `false` counts
  // as non-billable. This is what Finance's Approve & Reflect actually uses for Actual
  // Hours/Invoice Amount, never totalHours (see applyTimesheet/resolveTimesheetTarget).
  const billableHours = list.reduce((s, e) => s + (e.leave || e.billable === false ? 0 : +e.hours || 0), 0);
  const leaveDays = list.filter((e) => e.leave).length;
  const ts = await prisma.timesheet.upsert({
    where: { employeeId_projectId_periodYear_periodMonth: {
      employeeId: empId, projectId: Number(projectId), periodYear: Number(periodYear), periodMonth: Number(periodMonth),
    } },
    update: { totalHours, billableHours, leaveDays, status: "DRAFT", rejectedReason: null },
    create: { employeeId: empId, projectId: Number(projectId), periodYear: Number(periodYear), periodMonth: Number(periodMonth), totalHours, billableHours, leaveDays },
  });
  await prisma.timesheetEntry.deleteMany({ where: { timesheetId: ts.id } });
  const valid = list.filter((e) => Number(e.day) >= 1 && Number(e.day) <= 31 && ((+e.hours || 0) > 0 || e.leave));
  if (valid.length) {
    await prisma.timesheetEntry.createMany({ data: valid.map((e) => ({
      timesheetId: ts.id, day: Number(e.day), hours: e.leave ? 0 : +e.hours || 0, leave: !!e.leave, comment: e.comment || null,
      head: e.leave ? null : (e.head ? String(e.head).slice(0, 190) : null),
      billable: e.billable !== false,
    })) });
  }
  res.json(await prisma.timesheet.findUnique({ where: { id: ts.id }, include: { entries: true, project: true } }));
});

// employee (or admin) submits a draft/rejected sheet → goes to the PM
router.post("/:id/submit", async (req, res) => {
  const u = req.user!;
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts) return res.status(404).json({ error: "Not found" });
  if (!isAdmin(u.role) && ts.employeeId !== u.employeeId) return res.status(403).json({ error: "Not your timesheet" });
  const out = await prisma.timesheet.update({ where: { id: ts.id }, data: { status: "SUBMITTED", submittedAt: new Date(), rejectedReason: null } });
  await audit(u.id, "SUBMIT_TIMESHEET", ts.id);
  if (ts.employeeId) emitPendingActionsUpdate(ts.employeeId);
  res.json(out);
});

// Employee (or admin) deletes their own DRAFT/REJECTED sheet outright — never a submitted or
// approved one (that would erase the audit trail of a real review decision; a rejected sheet
// isn't gone, it's just back with the employee to fix and resubmit, which is what this is for
// when they'd genuinely rather start over).
router.delete("/:id", async (req, res) => {
  const u = req.user!;
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts) return res.json({ ok: true });
  if (!isAdmin(u.role) && ts.employeeId !== u.employeeId) return res.status(403).json({ error: "Not your timesheet" });
  if (ts.status !== "DRAFT" && ts.status !== "REJECTED") return res.status(400).json({ error: "Only a Draft or Rejected timesheet can be deleted." });
  await prisma.timesheetEntry.deleteMany({ where: { timesheetId: ts.id } });
  await prisma.timesheet.delete({ where: { id: ts.id } });
  await audit(u.id, "DELETE_TIMESHEET", ts.id);
  res.json({ ok: true });
});

// PM queue: awaiting PM approval. Only name/id is needed to render the approval list — never
// the full Employee record (home address, DOB, emergency contact, photo, etc.), which a PM has
// no business reason to see here. A non-admin PM only ever sees projects they're actually
// assigned to as PM (ProjectManager) — holding the role alone shows nothing until assigned.
router.get("/pending", requireRole(Role.PROJECT_MANAGER, ...ADMIN_ROLES), requirePermission("approvals"), async (req, res) => {
  const u = req.user!;
  const where: any = { status: "SUBMITTED" };
  if (!isAdmin(u.role)) {
    if (!u.employeeId) return res.json([]);
    const assigned = await prisma.projectManager.findMany({ where: { employeeId: u.employeeId }, select: { projectId: true } });
    if (!assigned.length) return res.json([]);
    where.projectId = { in: assigned.map((a) => a.projectId) };
  }
  res.json(await prisma.timesheet.findMany({
    where,
    include: { employee: { select: { id: true, name: true } }, project: true, entries: true },
  }));
});

// derive the fiscal-year label (e.g. "FY26-27") from a calendar period
function fyOf(periodMonth: number, periodYear: number) {
  const start = periodMonth >= 4 ? periodYear : periodYear - 1;
  const pad = (n: number) => String(((n % 100) + 100) % 100).padStart(2, "0");
  return `FY${pad(start)}-${pad(start + 1)}`;
}

// Shared lookup — finds the Monthly Forecast sheet + resource line a finance-approved timesheet
// would reflect into, WITHOUT writing anything. Both applyTimesheet (the real write) and the
// read-only preview route below call this exact same resolution, so the preview can never drift
// from what Approve & Reflect actually does.
async function resolveTimesheetTarget(ts: any, fiscalYearOverride?: string) {
  const monthName = MONTHS[(ts.periodMonth + 8) % 12];
  const fiscalYear = fiscalYearOverride || fyOf(ts.periodMonth, ts.periodYear);
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: monthName } }, include: { lines: true } });
  if (!sheet) return { ok: false as const, reason: `No ${monthName} ${fiscalYear} sheet`, month: monthName, fiscalYear };
  if (sheet.status === "LOCKED") return { ok: false as const, reason: `${monthName} ${fiscalYear} is locked`, month: monthName, fiscalYear };
  const project = await prisma.project.findUnique({ where: { id: ts.projectId } });
  const line = sheet.lines.find((l: any) => l.employeeId === ts.employeeId && (l.projectId === ts.projectId || (project && l.projectName === project.name)));
  if (!line) return { ok: false as const, reason: "No matching resource line in that month", month: monthName, fiscalYear };
  return { ok: true as const, line, month: monthName, fiscalYear };
}

// Map a finance-approved sheet's hours onto the matching monthly line: sets Actual Hours
// and recomputes the Invoice amount for that row. Best-effort; skips if locked/not found.
// Uses billableHours, never totalHours — non-billable work is real time logged but must never
// inflate Actual Hours/Invoice Amount on Monthly Forecast (explicit requirement). IMPORTANT: this
// column is new — every Timesheet row that existed before it was added got backfilled to 0 by
// the migration's own column default, NOT recomputed from entries (nothing historical was ever
// marked non-billable, so the correct one-time fix is a straight `billableHours = totalHours`
// backfill for pre-existing rows — see the deploy notes for this change). Do not "fix" that here
// with a fallback — a genuinely all-non-billable month SHOULD show billableHours = 0.
async function applyTimesheet(ts: any, fiscalYearOverride?: string) {
  const target = await resolveTimesheetTarget(ts, fiscalYearOverride);
  if (!target.ok) return { applied: false, reason: target.reason, month: target.month, fiscalYear: target.fiscalYear };
  const { line, month, fiscalYear } = target;
  const billableHours = ts.billableHours;
  await prisma.monthlyLine.update({
    where: { id: line.id },
    data: { actualHours: billableHours, invoiceAmount: line.rateUsd * billableHours * line.fxMultiplier + line.adjustment },
  });
  return { applied: true, lineId: line.id, month, fiscalYear, hours: billableHours };
}

// PM approves → moves to Finance (does NOT yet touch billing)
router.post("/:id/approve", requireRole(Role.PROJECT_MANAGER, ...ADMIN_ROLES), async (req, res) => {
  const u = req.user!;
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts || ts.status !== "SUBMITTED") return res.status(400).json({ error: "Timesheet is not awaiting PM approval" });
  if (!isAdmin(u.role) && !(await isAssignedPm(u.employeeId, ts.projectId))) {
    return res.status(403).json({ error: "You are not the assigned Project Manager for this project." });
  }
  const out = await prisma.timesheet.update({ where: { id: ts.id }, data: { status: "PM_APPROVED", approvedById: req.user!.id } });
  await audit(req.user!.id, "PM_APPROVE_TIMESHEET", ts.id);
  // Closes any open "submit your timesheet" nudge a PM/CTO assigned for this exact period —
  // the employee's Dashboard pending-action badge and daily reminder both stop the moment their
  // timesheet actually clears PM review, not just on submission (a rejected resubmission should
  // still show as open).
  await prisma.employeeAction.updateMany({
    where: { employeeId: ts.employeeId, type: "TIMESHEET", status: "OPEN", periodMonth: ts.periodMonth, periodYear: ts.periodYear },
    data: { status: "CLOSED", closedAt: new Date() },
  }).catch(() => {});
  if (ts.employeeId) emitPendingActionsUpdate(ts.employeeId);
  emitAttention(["FINANCE", "CTO", "CEO", "COO"], "timesheet_finance_approval_pending", { timesheetId: ts.id });
  res.json(out);
});

// PM/CTO explicitly nudges an employee to submit their timesheet for a period — shows as a
// pending-action badge on their Employee Dashboard plus a daily reminder email until either the
// PM approves the submitted sheet (auto-closed above) or a PM/CTO manually closes it.
router.post("/nudge/:employeeId", requireRole(Role.PROJECT_MANAGER, ...ADMIN_ROLES), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const now = new Date();
  const periodMonth = Number(req.body?.periodMonth) || now.getMonth() + 1;
  const periodYear = Number(req.body?.periodYear) || now.getFullYear();
  const existing = await prisma.employeeAction.findFirst({ where: { employeeId, type: "TIMESHEET", status: "OPEN", periodMonth, periodYear } });
  if (existing) return res.json(existing);
  const action = await prisma.employeeAction.create({ data: { employeeId, type: "TIMESHEET", periodMonth, periodYear, assignedById: req.user!.id } });
  emitPendingActionsUpdate(employeeId);
  res.status(201).json(action);
});

router.post("/nudge/:employeeId/close", requireRole(Role.PROJECT_MANAGER, ...ADMIN_ROLES), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  await prisma.employeeAction.updateMany({ where: { employeeId, type: "TIMESHEET", status: "OPEN" }, data: { status: "CLOSED", closedAt: new Date() } });
  emitPendingActionsUpdate(employeeId);
  res.json({ ok: true });
});

// Zero out the matching monthly Invoice line for a timesheet (used when a
// finance-approved sheet is later rejected — the billed amount must back out).
async function zeroTimesheetLine(ts: any) {
  const monthName = MONTHS[(ts.periodMonth + 8) % 12];
  const fiscalYear = fyOf(ts.periodMonth, ts.periodYear);
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: monthName } }, include: { lines: true } });
  if (!sheet || sheet.status === "LOCKED") return { applied: false, month: monthName, fiscalYear };
  const project = await prisma.project.findUnique({ where: { id: ts.projectId } });
  const line = sheet.lines.find((l) => l.employeeId === ts.employeeId && (l.projectId === ts.projectId || (project && l.projectName === project.name)));
  if (!line) return { applied: false, month: monthName, fiscalYear };
  await prisma.monthlyLine.update({ where: { id: line.id }, data: { invoiceAmount: 0, actualHours: 0 } });
  return { applied: true, lineId: line.id, month: monthName, fiscalYear };
}

// PM or Finance rejects → back to the employee with a reason.
// If the sheet was already FINANCE_APPROVED, back its billed amount out of the
// monthly Forecast & Actuals (set the matching MonthlyLine invoiceAmount = 0).
router.post("/:id/reject", requireRole(Role.PROJECT_MANAGER, ...ADMIN_ROLES), async (req, res) => {
  const u = req.user!;
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts) return res.status(404).json({ error: "Not found" });
  if (!isAdmin(u.role) && !(await isAssignedPm(u.employeeId, ts.projectId))) {
    return res.status(403).json({ error: "You are not the assigned Project Manager for this project." });
  }
  let billing: any = undefined;
  const wasFinanceApproved = ts.status === "FINANCE_APPROVED";
  if (wasFinanceApproved) billing = await zeroTimesheetLine(ts).catch(() => ({ applied: false }));
  const out = await prisma.timesheet.update({ where: { id: ts.id }, data: { status: "REJECTED", rejectedReason: req.body.reason || "Rejected" } });
  await audit(req.user!.id, "REJECT_TIMESHEET", out.id, { reason: out.rejectedReason, billing });
  // Live-refresh the employee's own dashboard (pending action to refile) and the PM queue
  // (pending:activity); if this undoes an already-Finance-approved sheet, also ping Finance's own
  // "Need your Attention" so their Approved Hours screen reflects the pull-back immediately.
  if (ts.employeeId) emitPendingActionsUpdate(ts.employeeId);
  if (wasFinanceApproved) emitAttention(["FINANCE", "CTO", "CEO", "COO"], "timesheet_rejected_after_finance_approval", { timesheetId: ts.id });
  res.json({ ...out, billing });
});

// Granular reject — PM/Finance flags SPECIFIC day(s)/head(s) instead of the whole sheet, each
// with its own comment, so the employee's calendar can highlight exactly what to fix (see
// TimesheetCalendar.tsx's red-cell rendering) rather than leaving them to guess from one sheet-
// level reason. Still flips the whole Timesheet to REJECTED (there's no "partially rejected"
// status — the employee must still fix+resubmit before it can move forward), but the per-entry
// `rejected`/`rejectionComment` flags are what the UI actually highlights. These flags are
// self-clearing: POST / above deletes and recreates every entry fresh on the employee's next
// save, so a day they've fixed naturally loses its stale `rejected:true` without any extra code.
router.post("/:id/reject-entries", requireRole(Role.PROJECT_MANAGER, ...ADMIN_ROLES), async (req, res) => {
  const u = req.user!;
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts) return res.status(404).json({ error: "Not found" });
  if (!isAdmin(u.role) && !(await isAssignedPm(u.employeeId, ts.projectId))) {
    return res.status(403).json({ error: "You are not the assigned Project Manager for this project." });
  }
  const entries: { day: number; head?: string | null; comment: string }[] = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!entries.length) return res.status(400).json({ error: "At least one entry is required." });
  let billing: any = undefined;
  const wasFinanceApproved = ts.status === "FINANCE_APPROVED";
  if (wasFinanceApproved) billing = await zeroTimesheetLine(ts).catch(() => ({ applied: false }));
  let flagged = 0;
  for (const e of entries) {
    const r = await prisma.timesheetEntry.updateMany({
      where: { timesheetId: ts.id, day: Number(e.day), head: e.head ?? null },
      data: { rejected: true, rejectionComment: e.comment || null },
    });
    flagged += r.count;
  }
  const reason = req.body?.generalReason || `${entries.length} day(s) need correction — see highlighted cells`;
  const out = await prisma.timesheet.update({ where: { id: ts.id }, data: { status: "REJECTED", rejectedReason: reason } });
  await audit(req.user!.id, "REJECT_TIMESHEET_ENTRIES", out.id, { entries, reason, flagged, billing });
  if (ts.employeeId) emitPendingActionsUpdate(ts.employeeId);
  if (wasFinanceApproved) emitAttention(["FINANCE", "CTO", "CEO", "COO"], "timesheet_rejected_after_finance_approval", { timesheetId: ts.id });
  res.json({ ...out, billing, flagged, entries: await prisma.timesheetEntry.findMany({ where: { timesheetId: out.id, rejected: true } }) });
});

// Finance queue: PM-approved, awaiting Finance
router.get("/finance-queue", requireRole(...ADMIN_ROLES), requirePermission("approvals"), async (_req, res) => {
  res.json(await prisma.timesheet.findMany({
    where: { status: "PM_APPROVED" },
    include: { employee: true, project: true, entries: true, approvedBy: { select: { name: true } } },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  }));
});

// Read-only — exactly what Approve & Reflect below would do to Monthly Forecast, without
// writing anything. Returns the matching line's CURRENT row (as Monthly Forecast shows it today)
// alongside what each field would become — a real before/after table, not just one summary
// sentence, so Finance can see precisely what's changing (hours AND USD) before committing.
router.get("/:id/finance-approve-preview", requireRole(...ADMIN_ROLES), async (req, res) => {
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts) return res.status(404).json({ error: "Not found" });
  const target = await resolveTimesheetTarget(ts, req.query.fiscalYear as string | undefined);
  if (!target.ok) return res.json({ found: false, reason: target.reason, month: target.month, fiscalYear: target.fiscalYear });
  const { line, month, fiscalYear } = target;
  // Billable hours only — never totalHours (non-billable work is real time logged, but must
  // never inflate Actual Hours/Invoice Amount on Monthly Forecast).
  const newInvoiceAmount = Math.round((line.rateUsd * ts.billableHours * line.fxMultiplier + line.adjustment) * 100) / 100;
  res.json({
    found: true, month, fiscalYear, projectName: line.projectName,
    rateUsd: line.rateUsd, fxMultiplier: line.fxMultiplier,
    currentEstimateHours: line.estimateHours, currentActualHours: line.actualHours || 0, newActualHours: ts.billableHours,
    totalHours: ts.totalHours, billableHours: ts.billableHours,
    currentInvoiceAmount: line.invoiceAmount || 0, newInvoiceAmount,
    currentBillingAmount: line.billingAmount || 0,
  });
});

// Finance approves → reflects hours into the matching monthly Invoice column
router.post("/:id/finance-approve", requireRole(...ADMIN_ROLES), async (req, res) => {
  const ts0 = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts0 || ts0.status !== "PM_APPROVED") return res.status(400).json({ error: "Timesheet is not PM-approved" });
  const ts = await prisma.timesheet.update({ where: { id: ts0.id }, data: { status: "FINANCE_APPROVED", financeApprovedById: req.user!.id }, include: { project: true } });
  const mapping = await applyTimesheet(ts, req.body.fiscalYear).catch(() => ({ applied: false, reason: "apply error" }));
  await audit(req.user!.id, "FINANCE_APPROVE_TIMESHEET", ts.id, mapping);
  // The employee's own dashboard (status now Finance Approved) and the PM queue both live-refresh.
  if (ts.employeeId) emitPendingActionsUpdate(ts.employeeId);
  res.json({ ...ts, mapping });
});

// Finance: list finance-approved (reflected) timesheets
router.get("/approved", requireRole(...ADMIN_ROLES), requirePermission("approvals"), async (_req, res) => {
  res.json(await prisma.timesheet.findMany({
    where: { status: "FINANCE_APPROVED" },
    include: { employee: true, project: true, entries: true, approvedBy: { select: { name: true } } },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  }));
});

// Finance: (re)apply a finance-approved sheet's hours into the matching monthly Invoice row
router.post("/:id/apply-to-sheet", requireRole(...ADMIN_ROLES), requirePermission("approvals"), async (req, res) => {
  const ts = await prisma.timesheet.findUnique({ where: { id: Number(req.params.id) } });
  if (!ts || ts.status !== "FINANCE_APPROVED") return res.status(400).json({ error: "Timesheet not finance-approved" });
  const r = await applyTimesheet(ts, req.body.fiscalYear);
  if (!r.applied) return res.status(409).json({ error: r.reason });
  await audit(req.user!.id, "APPLY_TIMESHEET", ts.id, r);
  res.json({ ok: true, ...r });
});

// Finance — Approved Hours "by Project": every Project x Month that has at least one SUBMITTED-
// or-later timesheet (DRAFTs never surface here — nothing to act on yet), rolled up into one row
// per project/month with a Pending-vs-Approved split, so Finance can see project-level status at a
// glance instead of hunting through the resource-level queue above for every row on one project.
router.get("/project-month-overview", requireRole(...ADMIN_ROLES), requirePermission("approvals"), async (_req, res) => {
  const rows = await prisma.timesheet.findMany({
    where: { status: { not: "DRAFT" } },
    select: { projectId: true, project: { select: { name: true } }, periodMonth: true, periodYear: true, status: true },
  });
  const groups = new Map<string, { projectId: number; projectName: string; periodMonth: number; periodYear: number; approved: number; pending: number; rejected: number; total: number }>();
  for (const r of rows) {
    const key = `${r.projectId}-${r.periodYear}-${r.periodMonth}`;
    if (!groups.has(key)) groups.set(key, { projectId: r.projectId, projectName: r.project?.name || "—", periodMonth: r.periodMonth, periodYear: r.periodYear, approved: 0, pending: 0, rejected: 0, total: 0 });
    const g = groups.get(key)!;
    g.total++;
    if (r.status === "FINANCE_APPROVED") g.approved++;
    else if (r.status === "REJECTED") g.rejected++;
    else g.pending++; // SUBMITTED or PM_APPROVED
  }
  const out = [...groups.values()].map((g) => ({ ...g, status: g.pending > 0 ? "PENDING" : g.rejected > 0 && g.approved === 0 ? "REJECTED" : "APPROVED" }));
  out.sort((a, b) => b.periodYear - a.periodYear || b.periodMonth - a.periodMonth || a.projectName.localeCompare(b.projectName));
  res.json(out);
});

// Resource-level cross-reference for one Project x Month: every person Monthly Forecast actually
// shows deployed there THAT month (MonthlyLine, not the static EmployeeProject assignment table —
// Monthly Forecast is the authoritative "who's really billed here this month" source, honoring
// deployment start/end and bench movements) against whether/how far their timesheet has gotten.
router.get("/project-month-detail", requireRole(...ADMIN_ROLES), requirePermission("approvals"), async (req, res) => {
  const projectId = Number(req.query.projectId);
  const periodMonth = Number(req.query.periodMonth);
  const periodYear = Number(req.query.periodYear);
  if (!projectId || !periodMonth || !periodYear) return res.status(400).json({ error: "projectId, periodMonth and periodYear are required" });

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const fiscalYear = fyOf(periodMonth, periodYear);
  const monthName = MONTHS[(periodMonth + 8) % 12];
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: monthName } }, include: { lines: true } });
  const deployedLines = (sheet?.lines || []).filter((l) => !l.isExpense && (l.projectId === projectId || (project && l.projectName === project.name)));

  const sheets = await prisma.timesheet.findMany({
    where: { projectId, periodMonth, periodYear },
    include: { employee: { select: { id: true, name: true } }, entries: true },
  });
  const tsByEmployeeId = new Map(sheets.map((s) => [s.employeeId, s]));
  const tsByName = new Map(sheets.map((s) => [s.employee.name, s]));

  // Union of Monthly Forecast's deployed roster and anyone who filed a timesheet even without a
  // matching forecast line (e.g. added to the project after the sheet was built) — same
  // "ad-hoc filers still show up" principle as the per-project /approvals roster above. `entries`
  // travels with each row (when a timesheet exists) so the client can show day-by-day detail
  // without a second round-trip — there's no standalone GET /timesheets/:id route today.
  const seen = new Set<number>();
  const rows: any[] = [];
  for (const l of deployedLines) {
    const ts = l.employeeId ? tsByEmployeeId.get(l.employeeId) : tsByName.get(l.resourceName);
    if (l.employeeId) seen.add(l.employeeId);
    rows.push({
      employeeId: l.employeeId, resourceName: l.resourceName || undefined, // resolved below if still missing
      timesheetId: ts?.id || null, status: ts?.status || "NOT_SUBMITTED", totalHours: ts?.totalHours ?? null, leaveDays: ts?.leaveDays ?? null, entries: ts?.entries || null,
    });
  }
  for (const s of sheets) {
    if (s.employeeId && seen.has(s.employeeId)) continue;
    rows.push({ employeeId: s.employeeId, resourceName: s.employee.name, timesheetId: s.id, status: s.status, totalHours: s.totalHours, leaveDays: s.leaveDays, entries: s.entries });
  }
  // Resolve resourceName for the Monthly-Forecast-sourced rows (employeeId present, name needs an
  // employee lookup) in one batch rather than N queries.
  const empIds = rows.filter((r) => r.employeeId && !r.resourceName).map((r) => r.employeeId);
  const emps = empIds.length ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true } }) : [];
  const empNameById = new Map(emps.map((e) => [e.id, e.name]));
  for (const r of rows) {
    if (!r.resourceName) r.resourceName = r.employeeId ? (empNameById.get(r.employeeId) || deployedLines.find((l) => l.employeeId === r.employeeId)?.resourceName || "—") : "—";
  }
  rows.sort((a, b) => a.resourceName.localeCompare(b.resourceName));
  res.json({ projectName: project?.name || "—", periodMonth, periodYear, fiscalYear, month: monthName, sheetFound: !!sheet, rows });
});

// ---------------------------------------------------------------------------
// F8 — Timesheet Approvals: per-project filed vs missing, reminders, proxy entry
// ---------------------------------------------------------------------------
const APPROVAL_ROLES: Role[] = [Role.PROJECT_MANAGER, ...ADMIN_ROLES];

// "Just pick a month" mode for the panel below — every project Monthly Forecast actually shows
// deployed (a real resource line, not an expense/overhead line) for the given calendar month,
// instead of having to cascade Client -> Project first. Scoped the same way /managed-projects is
// (a PM sees only their own assigned projects; admins see everything) so this can't be used to
// discover projects a PM has no business seeing.
router.get("/projects-with-forecast", requireRole(...APPROVAL_ROLES), requirePermission("approvals"), async (req, res) => {
  const u = req.user!;
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (!month || !year) return res.status(400).json({ error: "month and year are required" });
  const fiscalYear = fyOf(month, year);
  const monthName = MONTHS[(month + 8) % 12];
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: monthName } }, include: { lines: { where: { isExpense: false } } } });
  if (!sheet) return res.json([]);
  const projectIds = new Set((sheet.lines.filter((l) => l.projectId != null)).map((l) => l.projectId as number));
  if (!projectIds.size) return res.json([]);

  let allowedProjectIds = [...projectIds];
  if (!isAdmin(u.role)) {
    if (u.role !== Role.PROJECT_MANAGER || !u.employeeId) return res.json([]);
    const assigned = await prisma.projectManager.findMany({ where: { employeeId: u.employeeId }, select: { projectId: true } });
    const allowed = new Set(assigned.map((a) => a.projectId));
    allowedProjectIds = allowedProjectIds.filter((id) => allowed.has(id));
  }
  if (!allowedProjectIds.length) return res.json([]);
  const projects = await prisma.project.findMany({ where: { id: { in: allowedProjectIds } }, include: { client: true }, orderBy: { name: "asc" } });
  res.json(projects.map((p) => ({ id: p.id, name: p.name, clientName: p.client?.name || null })));
});

// All APPROVED (PM_APPROVED or FINANCE_APPROVED) timesheets for a Client's projects in one
// period — a cross-project, approved-only view, as opposed to /approvals (one project, every
// status) and /projects-with-forecast (every status, listed per project). A PM only sees their
// own assigned projects within that client, same scoping as every other route here.
router.get("/approved-by-client", requireRole(...APPROVAL_ROLES), requirePermission("approvals"), async (req, res) => {
  const u = req.user!;
  const clientId = Number(req.query.clientId);
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (!clientId || !month || !year) return res.status(400).json({ error: "clientId, month and year are required" });
  let projectIds = (await prisma.project.findMany({ where: { clientId }, select: { id: true } })).map((p) => p.id);
  if (!projectIds.length) return res.json([]);
  if (!isAdmin(u.role)) {
    if (u.role !== Role.PROJECT_MANAGER || !u.employeeId) return res.json([]);
    const assigned = await prisma.projectManager.findMany({ where: { employeeId: u.employeeId }, select: { projectId: true } });
    const allowed = new Set(assigned.map((a) => a.projectId));
    projectIds = projectIds.filter((id) => allowed.has(id));
  }
  if (!projectIds.length) return res.json([]);
  const rows = await prisma.timesheet.findMany({
    where: { projectId: { in: projectIds }, periodMonth: month, periodYear: year, status: { in: ["PM_APPROVED", "FINANCE_APPROVED"] } },
    include: { employee: { select: { id: true, name: true } }, project: { select: { id: true, name: true } }, approvedBy: { select: { name: true } } },
    orderBy: [{ project: { name: "asc" } }, { employee: { name: "asc" } }],
  });
  res.json(rows.map((t) => ({
    id: t.id, employeeId: t.employee?.id, employeeName: t.employee?.name, projectId: t.project?.id, projectName: t.project?.name,
    totalHours: t.totalHours, billableHours: t.billableHours, leaveDays: t.leaveDays, status: t.status, approvedByName: t.approvedBy?.name || null,
  })));
});

// Who is on a project + who has / hasn't filed a timesheet for a given period.
// Team = employees linked via EmployeeProject (plus anyone who already filed).
router.get("/approvals", requireRole(...APPROVAL_ROLES), requirePermission("approvals"), async (req, res) => {
  const u = req.user!;
  const projectId = Number(req.query.projectId);
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (!projectId || !month || !year) return res.status(400).json({ error: "projectId, month and year are required" });
  if (!isAdmin(u.role) && !(await isAssignedPm(u.employeeId, projectId))) {
    return res.status(403).json({ error: "You are not the assigned Project Manager for this project." });
  }

  // Only name/id — the member/missing roster below never needs more than that, and a PM has no
  // business reason to see another employee's address/DOB/emergency contact/photo via this list.
  const links = await prisma.employeeProject.findMany({ where: { projectId }, include: { employee: { select: { id: true, name: true } } } });
  const sheets = await prisma.timesheet.findMany({
    where: { projectId, periodMonth: month, periodYear: year },
    include: { employee: { select: { id: true, name: true } }, project: true, entries: true, approvedBy: { select: { name: true } } },
  });
  const filedByEmp = new Map(sheets.map((s) => [s.employeeId, s]));

  // union of assigned members and anyone who already filed (covers ad-hoc filers)
  const members = new Map<number, { id: number; name: string }>();
  for (const l of links) members.set(l.employeeId, { id: l.employee.id, name: l.employee.name });
  for (const s of sheets) if (!members.has(s.employeeId)) members.set(s.employeeId, { id: s.employee.id, name: s.employee.name });

  const filed = sheets;
  const missing = [...members.values()].filter((m) => !filedByEmp.has(m.id));
  res.json({ filed, missing });
});

// Send a reminder to a member who hasn't filed. Records an audit entry and, when
// Microsoft Graph mail is configured and the employee has an email, sends a real
// reminder email AS the logged-in user (PM/Finance).
router.post("/remind", requireRole(...APPROVAL_ROLES), requirePermission("approvals"), async (req, res) => {
  const { employeeId, projectId, month, year } = req.body || {};
  if (!employeeId || !projectId || !month || !year) return res.status(400).json({ error: "employeeId, projectId, month and year are required" });
  const emp = await prisma.employee.findUnique({ where: { id: Number(employeeId) } });
  const project = await prisma.project.findUnique({ where: { id: Number(projectId) } });
  const monthName = MONTHS[(Number(month) + 8) % 12];
  const period = `${monthName} ${year}`;
  const empName = emp?.name || `#${employeeId}`;

  const writeAudit = (extra?: any) => prisma.auditLog.create({
    data: { userId: req.user!.id, action: "REMIND_TIMESHEET", entity: "Employee", entityId: String(employeeId),
      after: { projectId: Number(projectId), period, employee: emp?.name, ...extra } },
  }).catch(() => {});

  // No email on file → don't fail, just report.
  if (!emp?.email) {
    await writeAudit({ sent: false, reason: "No email on file" });
    return res.json({ ok: true, sent: false, reason: `No email on file for ${empName}`, reminded: empName, period });
  }

  // Mail not configured → audit + report.
  if (!mailEnabled()) {
    await writeAudit({ sent: false, reason: "Email not configured" });
    return res.json({ ok: true, sent: false, reason: "Email not configured", reminded: empName, period });
  }

  const subject = `Timesheet reminder — ${period}`;
  const projName = project?.name || "your project";
  const html = `<p>Hi ${empName},</p>
<p>This is a friendly reminder to please fill in your timesheet for <strong>${projName}</strong> for <strong>${period}</strong>.</p>
<p>Kindly submit it at your earliest convenience so approvals and billing can proceed on time.</p>
<p>Thank you!</p>`;

  try {
    const r = await notifyMail("TIMESHEET_MANUAL_REMINDER", { fromUpn: req.user!.email, to: emp.email, subject, html });
    if (!r.sent) { await writeAudit({ sent: false, reason: r.reason || "Not sent" }); return res.json({ ok: true, sent: false, reason: r.reason, reminded: empName, period }); }
    await writeAudit({ sent: true, to: emp.email });
    return res.json({ ok: true, sent: true, to: emp.email, reminded: empName, period });
  } catch (e: any) {
    await writeAudit({ sent: false, reason: e?.message || "Send failed" });
    return res.status(502).json({ ok: false, sent: false, error: e?.message || "Failed to send reminder", reminded: empName, period });
  }
});

// PM/admin fills a timesheet on a member's behalf (proxy). Upserts the month's
// sheet from day-level entries; optional submit forwards it for approval.
router.post("/proxy", requireRole(...APPROVAL_ROLES), requirePermission("approvals"), async (req, res) => {
  const u = req.user!;
  const { employeeId, projectId, periodMonth, periodYear, entries, submit } = req.body || {};
  if (!employeeId || !projectId || !periodMonth || !periodYear) return res.status(400).json({ error: "employeeId, projectId, periodMonth and periodYear are required" });
  const list: any[] = Array.isArray(entries) ? entries : [];
  const totalHours = list.reduce((s, e) => s + (e.leave ? 0 : +e.hours || 0), 0);
  const billableHours = list.reduce((s, e) => s + (e.leave || e.billable === false ? 0 : +e.hours || 0), 0);
  const leaveDays = list.filter((e) => e.leave).length;
  const ts = await prisma.timesheet.upsert({
    where: { employeeId_projectId_periodYear_periodMonth: {
      employeeId: Number(employeeId), projectId: Number(projectId), periodYear: Number(periodYear), periodMonth: Number(periodMonth),
    } },
    update: { totalHours, billableHours, leaveDays, status: "DRAFT", rejectedReason: null },
    create: { employeeId: Number(employeeId), projectId: Number(projectId), periodYear: Number(periodYear), periodMonth: Number(periodMonth), totalHours, billableHours, leaveDays },
  });
  await prisma.timesheetEntry.deleteMany({ where: { timesheetId: ts.id } });
  const valid = list.filter((e) => Number(e.day) >= 1 && Number(e.day) <= 31 && ((+e.hours || 0) > 0 || e.leave));
  if (valid.length) {
    await prisma.timesheetEntry.createMany({ data: valid.map((e) => ({
      timesheetId: ts.id, day: Number(e.day), hours: e.leave ? 0 : +e.hours || 0, leave: !!e.leave, comment: e.comment || null,
      head: e.leave ? null : (e.head ? String(e.head).slice(0, 190) : null),
      billable: e.billable !== false,
    })) });
  }
  let out = ts;
  if (submit) out = await prisma.timesheet.update({ where: { id: ts.id }, data: { status: "SUBMITTED", submittedAt: new Date(), rejectedReason: null } });
  await audit(u.id, submit ? "PROXY_SUBMIT_TIMESHEET" : "PROXY_TIMESHEET", ts.id, { onBehalfOf: Number(employeeId) });
  res.json(await prisma.timesheet.findUnique({ where: { id: ts.id }, include: { entries: true, project: true, employee: { select: { id: true, name: true } } } }));
});

export default router;
