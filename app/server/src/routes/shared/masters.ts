import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin, requireRole, ADMIN_ROLES } from "../../auth/auth";
import { Role } from "@prisma/client";
import { requirePermission, isAllowed } from "../../engine/permissions";
import { computeEmployeeCost, computeMonthlyEmployeeCostUsd, computeMonthlyCostBreakdown, toUsd, ctcAnnualUsd } from "../../engine/calc";
import { deployedFraction, effectiveEnd } from "../../engine/workdays";
import { isBenchLine } from "../finance/monthly";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { computeFnfSuggestion, buildFnfPdfData } from "../../engine/leave";
import { renderFnfPdf } from "../../engine/hrPdf";
import { renderFnfDocxBuffer, fnfDocxFileName } from "../../engine/fnfDocx";
import { emitHelpdeskUpdate, emitAttention } from "../../engine/realtime";
import { fmtDate } from "../../engine/dateFormat";

const router = Router();
// Masters expose employees, CTC, salary and other confidential data — every route
// is admin-only (this router is mounted at /api, so we guard per-route, not blanket).

// ---- Geographies (dropdown data for the Clients page only) ----
router.get("/geographies", requireAdmin, requirePermission("clients"), async (_req, res) => res.json(await prisma.geography.findMany()));

// ---- Expense categories (managed from the Monthly Forecast "Add Expense" dialog) ----
router.get("/expense-categories", requireAdmin, requirePermission("monthly-forecast"), async (_req, res) => res.json(await prisma.expenseCategory.findMany({ orderBy: { name: "asc" } })));
router.post("/expense-categories", requireAdmin, requirePermission("monthly-forecast"), async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  res.status(201).json(await prisma.expenseCategory.upsert({ where: { name }, update: {}, create: { name } }));
});
router.put("/expense-categories/:id", requireAdmin, requirePermission("monthly-forecast"), async (req, res) => {
  res.json(await prisma.expenseCategory.update({ where: { id: Number(req.params.id) }, data: { name: String(req.body.name || "").trim() } }));
});
router.delete("/expense-categories/:id", requireAdmin, requirePermission("monthly-forecast"), async (req, res) => {
  await prisma.expenseCategory.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// ---- Employees ----
// Read access also extends to HR (HR's own /api/hr routes handle the offer/appointment mutations
// that create these rows in the first place). HR can now Edit too (see PUT /employees/:id below),
// except a Confidential employee's record — hidden from HR here, and off-limits to edit there,
// either way only CEO/CTO/Finance. Add/Delete/Terminate stay requireAdmin-only.
router.get("/employees", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  // Confidential employees (flagged by CEO/CTO/FINANCE — see PUT /employees/:id/confidential
  // below) never appear in an HR-role request at all — not even a count, name or ID.
  const isHrRole = req.user!.role === Role.HR;
  const employees = await prisma.employee.findMany({
    where: isHrRole ? { confidential: false } : undefined,
    include: {
      projects: { include: { project: true } }, ctcRecords: { orderBy: { effectiveFrom: "desc" } },
      // Onboarding provenance — populated only for employees created via Confirm Joining.
      offer: { select: { id: true, offerRef: true, status: true, ctc: true, role: true, designation: true, offerDate: true, acceptedAt: true, employmentType: true, signedOfferFileName: true, businessUnit: { select: { name: true } }, appointmentLetter: { select: { status: true, issuedAt: true, signedFileName: true } }, serviceAgreement: { select: { status: true, signedFileName: true } } } },
      // Fallback project source (see below) — only the fields needed to pick the latest month.
      monthlyLines: { where: { projectId: { not: null } }, select: { projectId: true, project: { select: { id: true, name: true } }, monthlySheet: { select: { fiscalYear: true, monthIndex: true } } } },
    },
    orderBy: { name: "asc" },
  });
  // Employee Master's CTC column shows the annual CTC in its own currency AND in USD — USD derived
  // exactly like the rest of the app (ctcAnnualUsd: INR ÷ latest USD_INR FX; CAD × CANADA_FACTOR).
  {
    const fxInr = await prisma.fxRate.findFirst({ where: { context: "USD_INR" }, orderBy: { effectiveFrom: "desc" } });
    const fxCad = await prisma.fxRate.findFirst({ where: { context: "CANADA_FACTOR" }, orderBy: { effectiveFrom: "desc" } });
    for (const e of employees as any[]) {
      const c = e.ctcRecords?.[0];
      if (!c) continue;
      let usd = ctcAnnualUsd(c, fxInr?.rate || 93);
      if (c.currency === "CAD" && c.annualCostOverride != null && c.annualCostOverride > 0) usd = c.annualCostOverride * (fxCad?.rate || 0.71);
      e.ctcAnnualUsd = Math.round(usd);
    }
  }
  // Surfaces the "mid-termination, not yet on Past/Terminated" gap explicitly instead of silently
  // showing these people as plain Active: employeeId.exitDate stays null until Finance's final
  // Approve & Terminate (step two — see terminationApprovals.ts), but for anyone whose Deployment
  // End Date has already been approved (step one — cost/project impact already applied, access
  // already cut unless they went to Bench) they are no longer genuinely "Active" either. Every
  // employment type moves to Past/Terminated on the exact same trigger (exitDate set at step two,
  // i.e. once FnF is finalized) — this only adds a visible in-between state, it changes no data.
  const pendingReqs = await prisma.terminationApprovalRequest.findMany({
    where: { status: "PENDING" },
    select: { employeeId: true, deploymentEndDate: true, deploymentEndApprovedAt: true, fnfFinalizationDate: true, noBenchMovement: true },
  });
  const pendingByEmp = new Map(pendingReqs.map((r) => [r.employeeId, r]));
  for (const e of employees as any[]) {
    const p = pendingByEmp.get(e.id);
    e.pendingTermination = p ? { deactivated: !!p.deploymentEndApprovedAt, deploymentEndDate: p.deploymentEndDate, fnfFinalizationDate: p.fnfFinalizationDate } : null;
  }
  // `EmployeeProject` (the `projects` relation above) is only ever populated by the new HR
  // "Confirm Joining" flow — every employee imported from the golden-master billing data predates
  // that flow and has no row there, which is why most rows showed a blank Projects column. Their
  // real project association lives in `MonthlyLine` (the actual per-employee-per-project billing
  // rows the cost engine itself reads — verified populated for 83 employees, unlike the empty
  // `EmployeeCostAllocation` table), so fall back to that employee's most recent month's project(s)
  // when EmployeeProject is empty — read-only for display, never touches any assignment table.
  for (const e of employees as any[]) {
    if (!e.projects?.length && e.monthlyLines?.length) {
      const latestIdx = e.monthlyLines.reduce((best: string, l: any) => {
        const key = `${l.monthlySheet.fiscalYear}|${l.monthlySheet.monthIndex}`;
        return key > best ? key : best;
      }, "");
      const latestProjects = e.monthlyLines.filter((l: any) => `${l.monthlySheet.fiscalYear}|${l.monthlySheet.monthIndex}` === latestIdx).map((l: any) => l.project);
      const seen = new Set<number>();
      e.projects = latestProjects.filter((p: any) => p && (seen.has(p.id) ? false : (seen.add(p.id), true))).map((p: any) => ({ project: p }));
    }
    delete e.monthlyLines;
  }
  res.json(employees);
});
router.post("/employees", requireAdmin, requirePermission("employees"), async (req, res) => {
  const { name, empNo, email, joiningDate, location, empType, isBillable, projectIds, designation, department, reportingManager, emergencyContactName, emergencyContactPhone, businessUnitId, noticePeriod, probationPeriod, workLocation, phone, officialPhone, personalEmail, gender, maritalStatus, marriageAnniversary, address, city, landmark, state, pincode, residentAddress, residentCity, residentLandmark, residentState, residentPincode, dateOfBirth } = req.body;
  if (!String(email || "").trim()) return res.status(400).json({ error: "Email is required." });
  if (!joiningDate) return res.status(400).json({ error: "Joining Date is required." });
  if (!String(designation || "").trim()) return res.status(400).json({ error: "Designation is required." });
  if (!String(department || "").trim()) return res.status(400).json({ error: "Department is required." });
  if (!String(reportingManager || "").trim()) return res.status(400).json({ error: "Reporting Manager is required." });
  if (!String(emergencyContactName || "").trim()) return res.status(400).json({ error: "Emergency Contact Name is required." });
  if (!String(emergencyContactPhone || "").trim()) return res.status(400).json({ error: "Emergency Contact Number is required." });
  if (empNo && (await prisma.employee.findFirst({ where: { empNo } }))) {
    return res.status(400).json({ error: `Employee Code "${empNo}" is already in use — choose a different one.` });
  }
  const emp = await prisma.employee.create({
    data: {
      name, empNo, email: email || null, location, empType: empType || "FULL_TIME",
      isBillable: isBillable ?? true,
      joiningDate: joiningDate ? new Date(joiningDate) : null,
      designation: designation || null, department: department || null, reportingManager: reportingManager || null,
      emergencyContactName: emergencyContactName || null, emergencyContactPhone: emergencyContactPhone || null,
      businessUnitId: businessUnitId ? Number(businessUnitId) : null,
      noticePeriod: noticePeriod || null, probationPeriod: probationPeriod || null, workLocation: workLocation || null, phone: phone || null, officialPhone: officialPhone || null,
      personalEmail: personalEmail || null, gender: gender || null, maritalStatus: maritalStatus || null,
      marriageAnniversary: marriageAnniversary ? new Date(marriageAnniversary) : null,
      address: address || null, city: city || null, landmark: landmark || null, state: state || null, pincode: pincode || null,
      residentAddress: residentAddress || null, residentCity: residentCity || null, residentLandmark: residentLandmark || null,
      residentState: residentState || null, residentPincode: residentPincode || null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      projects: projectIds?.length ? { create: projectIds.map((id: number) => ({ projectId: id })) } : undefined,
    },
  });
  // Adding an existing employee directly here (no Offer/IT-provisioning flow behind them) still
  // deserves the same auto-link as Confirm Joining gets — an already-existing, still-unlinked
  // User account with this same email gets connected immediately, not left for someone to notice
  // and fix by hand later.
  if (emp.email) {
    const user = await prisma.user.findUnique({ where: { email: emp.email.toLowerCase() } });
    if (user && !user.employeeId) await prisma.user.update({ where: { id: user.id }, data: { employeeId: emp.id } });
  }
  res.status(201).json(emp);
});
// A person's name is denormalized in a few places — MonthlyLine.resourceName is a verbatim
// copy of the workbook cell (not a join on Employee), and invoice annexures snapshot it at
// generation time. Renaming the master record alone leaves those showing the old spelling,
// so push the new name out to every row that refers to this person.
//
// Two kinds of rows are updated: those linked by employeeId (unambiguous), and workbook-
// imported rows that carry only the name. The sheets also use a "Name -1", "Name -2" suffix
// for a second/third seat of the same person on another project — those follow the rename
// too, keeping their suffix. Annexures are only touched on DRAFT invoices: an issued invoice
// is a historical document and must keep the name it was sent with.
const SEAT_SUFFIX = /^\s*-\s*\d+$/; // matches the " -1" tail of "Asheesh Dabra -1"

async function cascadeEmployeeRename(employeeId: number, oldName: string, newName: string, userId: number) {
  const linked = await prisma.monthlyLine.updateMany({ where: { employeeId }, data: { resourceName: newName } });

  // Name-only rows. MySQL string comparison is case-insensitive, so this also sweeps up
  // casing variants ("asheesh dabral" vs "Asheesh Dabral") that would otherwise be missed.
  const byName = await prisma.monthlyLine.updateMany({
    where: { employeeId: null, isExpense: false, resourceName: oldName },
    data: { resourceName: newName },
  });

  // Seat rows: "<oldName> -1" -> "<newName> -1". Fetched first so the suffix is preserved.
  const seats = await prisma.monthlyLine.findMany({
    where: { isExpense: false, resourceName: { startsWith: oldName }, NOT: { resourceName: oldName } },
    select: { id: true, resourceName: true },
  });
  let seatCount = 0;
  for (const s of seats) {
    const tail = s.resourceName.slice(oldName.length);
    if (!SEAT_SUFFIX.test(tail)) continue; // a different person whose name merely starts the same
    await prisma.monthlyLine.update({ where: { id: s.id }, data: { resourceName: `${newName}${tail}` } });
    seatCount++;
  }

  const annexure = await prisma.invoiceAnnexure.updateMany({
    where: { resourceName: oldName, invoice: { status: "DRAFT" } },
    data: { resourceName: newName },
  });

  const counts = { monthlyLinesLinked: linked.count, monthlyLinesByName: byName.count, monthlyLineSeats: seatCount, draftAnnexureRows: annexure.count };
  await prisma.auditLog.create({
    data: { userId, action: "RENAME_EMPLOYEE", entity: "Employee", entityId: String(employeeId), before: { name: oldName }, after: { name: newName, ...counts } },
  }).catch(() => {});
  return counts;
}

// HR can now edit the Employee master too (explicit request — was previously requireAdmin-only,
// see the comment near GET /employees above, now stale) — EXCEPT a Confidential employee's record
// stays fully off-limits to HR here, same as it already is in the list above: hidden from HR, only
// CEO/CTO/Finance can edit it. HR also can never set/clear the confidential flag itself, even on a
// non-confidential employee — that stays an admin-only lever.
router.put("/employees/:id", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const isHrRole = req.user!.role === Role.HR;
  if (isHrRole) {
    const target = await prisma.employee.findUnique({ where: { id }, select: { confidential: true } });
    if (target?.confidential) return res.status(403).json({ error: "This employee's record is confidential — only CEO/CTO/Finance can edit it." });
  }
  // empNo is now editable here too (was previously permanent once created) — explicit request to
  // let Admin correct a wrong/incomplete code (e.g. a contractor missing their "C" prefix) without
  // having to delete and recreate the whole employee record. Still checked for uniqueness, same
  // as the create route, excluding this employee's own current row.
  const { name, empNo, email, joiningDate, exitDate, location, empType, isBillable, designation, department, reportingManager, emergencyContactName, emergencyContactPhone, confidential, businessUnitId, noticePeriod, probationPeriod, workLocation, phone, officialPhone, personalEmail, gender, maritalStatus, marriageAnniversary, address, city, landmark, state, pincode, residentAddress, residentCity, residentLandmark, residentState, residentPincode, dateOfBirth } = req.body;
  if (email !== undefined && !String(email || "").trim()) return res.status(400).json({ error: "Email is required." });
  if (empNo !== undefined && !String(empNo || "").trim()) return res.status(400).json({ error: "Employee Code is required." });
  if (empNo) {
    const clash = await prisma.employee.findFirst({ where: { empNo, NOT: { id } } });
    if (clash) return res.status(400).json({ error: `Employee Code "${empNo}" is already in use — choose a different one.` });
  }
  const before = await prisma.employee.findUnique({ where: { id }, select: { name: true } });
  const emp = await prisma.employee.update({
    where: { id },
    data: {
      name, location, empType, isBillable,
      empNo: empNo !== undefined ? empNo : undefined,
      email: email !== undefined ? (email || null) : undefined,
      joiningDate: joiningDate ? new Date(joiningDate) : undefined,
      exitDate: exitDate ? new Date(exitDate) : undefined,
      designation: designation !== undefined ? (designation || null) : undefined,
      department: department !== undefined ? (department || null) : undefined,
      reportingManager: reportingManager !== undefined ? (reportingManager || null) : undefined,
      emergencyContactName: emergencyContactName !== undefined ? (emergencyContactName || null) : undefined,
      emergencyContactPhone: emergencyContactPhone !== undefined ? (emergencyContactPhone || null) : undefined,
      businessUnitId: businessUnitId !== undefined ? (businessUnitId ? Number(businessUnitId) : null) : undefined,
      noticePeriod: noticePeriod !== undefined ? (noticePeriod || null) : undefined,
      probationPeriod: probationPeriod !== undefined ? (probationPeriod || null) : undefined,
      workLocation: workLocation !== undefined ? (workLocation || null) : undefined,
      phone: phone !== undefined ? (phone || null) : undefined,
      officialPhone: officialPhone !== undefined ? (officialPhone || null) : undefined,
      personalEmail: personalEmail !== undefined ? (personalEmail || null) : undefined,
      gender: gender !== undefined ? (gender || null) : undefined,
      maritalStatus: maritalStatus !== undefined ? (maritalStatus || null) : undefined,
      marriageAnniversary: marriageAnniversary !== undefined ? (marriageAnniversary ? new Date(marriageAnniversary) : null) : undefined,
      address: address !== undefined ? (address || null) : undefined,
      city: city !== undefined ? (city || null) : undefined,
      landmark: landmark !== undefined ? (landmark || null) : undefined,
      state: state !== undefined ? (state || null) : undefined,
      pincode: pincode !== undefined ? (pincode || null) : undefined,
      residentAddress: residentAddress !== undefined ? (residentAddress || null) : undefined,
      residentCity: residentCity !== undefined ? (residentCity || null) : undefined,
      residentLandmark: residentLandmark !== undefined ? (residentLandmark || null) : undefined,
      residentState: residentState !== undefined ? (residentState || null) : undefined,
      residentPincode: residentPincode !== undefined ? (residentPincode || null) : undefined,
      dateOfBirth: dateOfBirth !== undefined ? (dateOfBirth ? new Date(dateOfBirth) : null) : undefined,
      // HR can reach this route now (see above) but must never be able to set/clear this flag
      // itself — stays an admin-only lever, silently ignored if an HR request sends it.
      confidential: confidential !== undefined && !isHrRole ? !!confidential : undefined,
    },
  });
  const oldName = (before?.name || "").trim();
  const newName = (emp.name || "").trim();
  const renamed = oldName && newName && oldName !== newName
    ? await cascadeEmployeeRename(id, oldName, newName, req.user!.id)
    : null;
  res.json({ ...emp, renamed });
});

router.delete("/employees/:id", requireAdmin, requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  try {
    // Remove dependent records, then unlink (don't destroy) historical/multi-party rows so the
    // sheet — or a ticket someone else is still party to — still balances/reads. Timesheets
    // cascade their tasks/entries.
    //
    // This list used to only cover 6 of the ~20 models with a required (non-nullable) employeeId
    // FK — every terminated employee, by definition, has a TerminationApprovalRequest row (that's
    // what marks them terminated) and, once offboarding was queued, an ItOffboardingRequest row
    // too, so deleting a Past/Terminated employee reliably hit whichever of those Prisma tried to
    // enforce first: "Foreign key constraint violated: employeeId". Filling in the rest of this
    // list the same way (delete employee-only operational rows with no standalone meaning once
    // the employee is gone; null out the FK on rows that involve other people/data worth keeping).
    await prisma.$transaction([
      prisma.ctcRecord.deleteMany({ where: { employeeId: id } }),
      prisma.employeeProject.deleteMany({ where: { employeeId: id } }),
      prisma.billingRate.deleteMany({ where: { employeeId: id } }),
      prisma.employeeCostAllocation.deleteMany({ where: { employeeId: id } }),
      prisma.timesheet.deleteMany({ where: { employeeId: id } }),
      prisma.ctcApprovalRequest.deleteMany({ where: { employeeId: id } }),
      prisma.appraisal.deleteMany({ where: { employeeId: id } }),
      prisma.terminationApprovalRequest.deleteMany({ where: { employeeId: id } }),
      prisma.itOffboardingRequest.deleteMany({ where: { employeeId: id } }),
      prisma.compOffCredit.deleteMany({ where: { employeeId: id } }),
      prisma.leaveBalance.deleteMany({ where: { employeeId: id } }),
      prisma.leaveRequest.deleteMany({ where: { employeeId: id } }),
      prisma.attendanceRecord.deleteMany({ where: { employeeId: id } }),
      prisma.attendanceRegularizationRequest.deleteMany({ where: { employeeId: id } }),
      prisma.permissionRequest.deleteMany({ where: { employeeId: id } }),
      prisma.employeeProfileSubmission.deleteMany({ where: { employeeId: id } }),
      prisma.employeeOnboardingDocument.deleteMany({ where: { employeeId: id } }),
      prisma.employeeAction.deleteMany({ where: { employeeId: id } }),
      prisma.reminderLog.deleteMany({ where: { employeeId: id } }),
      prisma.itAssetAssignmentHistory.deleteMany({ where: { employeeId: id } }),
      prisma.itAsset.updateMany({ where: { assignedEmployeeId: id }, data: { assignedEmployeeId: null } }),
      prisma.helpdeskTicket.updateMany({ where: { employeeId: id }, data: { employeeId: null } }),
      prisma.user.updateMany({ where: { employeeId: id }, data: { employeeId: null } }),
      prisma.monthlyLine.updateMany({ where: { employeeId: id }, data: { employeeId: null } }),
      prisma.employee.delete({ where: { id } }),
    ]);
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e?.message || "Cannot delete employee" }); }
});

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

// Read-only preview of what terminating this employee will actually do to Monthly Forecast —
// the termination month's prorated cost/billing/invoice per line, PLUS every later editable month
// through the exit date, labeled either "removed" (contractor/vendor — terminateEmployee deletes
// those lines outright) or "bench" (full-time with Bench Movement — the project line's revenue
// goes to zero but they keep costing money on Bench, shown as its own figure). Shared by BOTH
// termination entry points — Employee Master's direct one-shot Terminate button AND Finance's
// two-step approval flow (terminationApprovals.ts) — so the numbers Finance/CTO see before
// committing can never drift from what terminateEmployee below actually produces; a second,
// hand-written copy of this math in each place would be exactly the kind of bug this session kept
// finding and fixing today (see engine/calc.ts's virtualCtc / computeLineForMonth for the same
// principle applied to the CTC-approval preview).
export async function previewTermination(employeeId: number, opts: { deploymentEndDate?: Date | null; exitDate: Date; isFullTime: boolean; noBenchMovement: boolean; payableDaysOverride?: number | null }) {
  const { exitDate, isFullTime, noBenchMovement } = opts;
  const deploymentEndDate = opts.deploymentEndDate || exitDate;
  if (!deploymentEndDate || isNaN(+deploymentEndDate)) return { found: false as const };
  const goesToBench = isFullTime && !noBenchMovement;

  const cm = deploymentEndDate.getMonth() + 1, termIndex = cm >= 4 ? cm - 3 : cm + 9, termStartYear = cm >= 4 ? deploymentEndDate.getFullYear() : deploymentEndDate.getFullYear() - 1;
  const editable = await prisma.monthlySheet.findMany({ where: { status: { not: "LOCKED" } }, select: { id: true, fiscalYear: true, monthIndex: true, month: true } });
  const termSheet = editable.find((s) => fyStartYear(s.fiscalYear) === termStartYear && s.monthIndex === termIndex);
  const activeLines = termSheet
    ? (await prisma.monthlyLine.findMany({ where: { monthlySheetId: termSheet.id, employeeId, isExpense: false } })).filter((l) => !isBenchLine(l))
    : [];
  if (!termSheet || !activeLines.length) return { found: false as const };

  const fullMonthCost = await computeMonthlyEmployeeCostUsd(employeeId, termSheet.fiscalYear, termSheet.monthIndex);
  let estimatedBilling = 0, actualInvoice = 0, cost = 0;
  // Contractor-only: HR/Finance's "Number of Days Worked" override (same one driving the Salary-
  // for-Days-Worked figure on the termination form) replaces the auto-derived deployment-window
  // fraction here too, so this preview (and the Monthly Forecast cost actually applied — see
  // terminateEmployee's own monthCost override, which the client computes using this same number)
  // agrees with what HR saw instead of silently re-deriving its own day count from deployment dates.
  const { dim } = deployedFraction(termSheet.fiscalYear, termSheet.monthIndex);
  const lines = activeLines.map((l) => {
    const frac = opts.payableDaysOverride != null ? opts.payableDaysOverride / dim
      : deployedFraction(termSheet.fiscalYear, termSheet.monthIndex, l.deploymentStart, deploymentEndDate).fraction;
    const lineCost = fullMonthCost * frac / activeLines.length;
    const lineBilling = (l.billingAmount || 0) * frac, lineInvoice = (l.invoiceAmount || 0) * frac;
    estimatedBilling += lineBilling; actualInvoice += lineInvoice; cost += lineCost;
    return { projectName: l.projectName, costUsd: r2(lineCost), billingAmount: r2(lineBilling), invoiceAmount: r2(lineInvoice) };
  });

  // Every editable month strictly after the termination month, up to (and including) the exit
  // date's own month — the same window terminateEmployee's future-line cleanup targets.
  const exitCm = exitDate.getMonth() + 1, exitIndex = exitCm >= 4 ? exitCm - 3 : exitCm + 9, exitStartYear = exitCm >= 4 ? exitDate.getFullYear() : exitDate.getFullYear() - 1;
  const futureSheets = editable.filter((s) => {
    const sy = fyStartYear(s.fiscalYear);
    const afterTerm = sy > termStartYear || (sy === termStartYear && s.monthIndex > termIndex);
    const throughExit = sy < exitStartYear || (sy === exitStartYear && s.monthIndex <= exitIndex);
    return afterTerm && throughExit;
  }).sort((a, b) => fyStartYear(a.fiscalYear) - fyStartYear(b.fiscalYear) || a.monthIndex - b.monthIndex);
  const futureMonths: any[] = [];
  for (const s of futureSheets) {
    const sLines = (await prisma.monthlyLine.findMany({ where: { monthlySheetId: s.id, employeeId, isExpense: false } })).filter((l) => !isBenchLine(l));
    if (!sLines.length) continue;
    const lostBilling = r2(sLines.reduce((a, l) => a + (l.billingAmount || 0), 0));
    const lostInvoice = r2(sLines.reduce((a, l) => a + (l.invoiceAmount || 0), 0));
    const lostCost = r2(sLines.reduce((a, l) => a + (l.costUsd || 0), 0));
    const benchCostUsd = goesToBench ? r2(await computeMonthlyEmployeeCostUsd(employeeId, s.fiscalYear, s.monthIndex)) : 0;
    futureMonths.push({
      month: s.month, fiscalYear: s.fiscalYear, monthIndex: s.monthIndex,
      lines: sLines.map((l) => l.projectName),
      lostBilling, lostInvoice, lostCost,
      outcome: goesToBench ? "bench" : "removed",
      benchCostUsd,
    });
  }

  return {
    found: true as const, month: `${termSheet.fiscalYear} #${termSheet.monthIndex}`, monthLabel: termSheet.month, fiscalYear: termSheet.fiscalYear, isFullTime, goesToBench,
    // fullMonthCost is the termination month's cost BEFORE this termination's own proration (what
    // it would have cost had the employee stayed the whole month) — `cost` below is the AFTER
    // figure actually applied to Monthly Forecast. Both returned so Finance's review can show a
    // clear before/after, same as futureMonths' own lostCost (before) vs benchCostUsd (after).
    fullMonthCost: r2(fullMonthCost),
    estimatedBilling: r2(estimatedBilling), actualInvoice: r2(actualInvoice), cost: r2(cost), lines,
    futureMonths,
  };
}

// Terminate an employee (soft): set exitDate and move them to "Past Employees". Their
// planned resource lines are removed from all EDITABLE (non-locked) months so they drop
// out of headcount / billable / non-billable / bench going forward. Locked (historical)
// months are preserved for reference.
// Factored out so both the direct admin route below AND terminationApprovals.ts's Approve
// action (Finance/CTO/CEO signing off on an HR-requested termination) call the exact same logic.
export async function terminateEmployee(id: number, body: any, userId: number) {
  const emp = await prisma.employee.findUnique({ where: { id } });
  if (!emp) return { ok: false as const, status: 404, error: "Employee not found" };
  const exitDate = body?.exitDate ? new Date(body.exitDate) : new Date();
  // Contractor/vendor path: billing/hours/invoice proration, the termination-month pivot, and
  // each line's deployment-end truncation all follow the deployment end date (last billable day)
  // HR specified — not the administrative exit date (which may close out in a later month once
  // paperwork/FnF catches up). Employee.exitDate below still records the exit date itself.
  const billingEndDate = body?.deploymentEndDate ? new Date(body.deploymentEndDate) : exitDate;
  // Two-step contractor approval (see terminationApprovals.ts): step one approves the Deployment
  // End Date — adjusts Monthly Forecast immediately, no FnF, employee stays active
  // (setExitDate: false). Step two later finalizes the termination — sets Employee.exitDate and
  // tops FnF up onto the ALREADY-prorated termination month rather than re-prorating it a second
  // time (skipProration: true), which would double-shrink the cost.
  const setExitDate = body?.setExitDate !== false;
  const skipProration = !!body?.skipProration;
  const fnf = +body?.fnfAmount || 0; // Full & Final settlement (USD), added to the termination month
  if (setExitDate) await prisma.employee.update({ where: { id }, data: { exitDate } });
  // Clear their planned rows only from months STRICTLY AFTER the termination month —
  // the termination month itself and everything earlier are kept.
  const cm = billingEndDate.getMonth() + 1;                 // calendar month 1-12
  const termIndex = cm >= 4 ? cm - 3 : cm + 9;        // fiscal month index (Apr=1 … Mar=12)
  const termStartYear = cm >= 4 ? billingEndDate.getFullYear() : billingEndDate.getFullYear() - 1;
  const editable = await prisma.monthlySheet.findMany({ where: { status: { not: "LOCKED" } }, select: { id: true, fiscalYear: true, monthIndex: true } });
  const future = editable.filter((s) => {
    const sy = fyStartYear(s.fiscalYear);
    return sy > termStartYear || (sy === termStartYear && s.monthIndex > termIndex);
  });
  const r = await prisma.monthlyLine.deleteMany({ where: { monthlySheetId: { in: future.map((s) => s.id) }, isExpense: false, employeeId: id } });

  // Termination month: set the resource's total cost. The client computes it (prorated salary
  // by the chosen day basis + FULL FNF) and may override it — that exact total is used here,
  // distributed across the employee's lines in proportion to their current cost. Only for an
  // editable (non-locked) termination sheet.
  let appliedMonthCost = null as number | null;
  const monthCostOverride = body?.monthCost;
  const termSheet = editable.find((s) => fyStartYear(s.fiscalYear) === termStartYear && s.monthIndex === termIndex);
  if (termSheet) {
    const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: termSheet.id, employeeId: id, isExpense: false } });
    if (lines.length) {
      let total: number;
      if (monthCostOverride != null && monthCostOverride !== "") {
        total = +monthCostOverride;               // client-specified final cost (incl. FNF)
      } else if (skipProration) {
        // A prior deployment-end approval already shrank costUsd to the prorated amount — just
        // add the FnF top-up, don't re-apply the day fraction (that would double-shrink it).
        const cur = lines.reduce((a, l) => a + (l.costUsd || 0), 0);
        total = cur + fnf;
      } else {
        const daysInMonth = new Date(billingEndDate.getFullYear(), billingEndDate.getMonth() + 1, 0).getDate();
        const dw = Math.max(0, Math.min(daysInMonth, billingEndDate.getDate()));
        const cur = lines.reduce((a, l) => a + (l.costUsd || 0), 0);
        total = cur * (daysInMonth ? dw / daysInMonth : 1) + fnf; // calendar fallback
      }
      const curTot = lines.reduce((a, l) => a + (l.costUsd || 0), 0);
      const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
      // Optional Invoice Amount override from the Terminate dialog: becomes the resource's TOTAL
      // Actual Invoice for the termination month, split across their lines in proportion to each
      // line's prorated invoice (equal split among billable lines when everything prorates to 0).
      const invOverride = body?.invoiceAmount != null && body.invoiceAmount !== "" ? +body.invoiceAmount : null;
      // Revenue stops at the billing end date: hours / billing / invoice are cut to the deployed
      // part of the month (relative to whatever window each line already had), and it becomes
      // the line's deployment end so Clone / apply-future never carry the resource past it.
      const rows = lines.map((l: any) => {
        const prev = deployedFraction(termSheet.fiscalYear, termSheet.monthIndex, l.deploymentStart, l.deploymentEnd).fraction;
        const now = deployedFraction(termSheet.fiscalYear, termSheet.monthIndex, l.deploymentStart, effectiveEnd(l.deploymentEnd, billingEndDate)).fraction;
        const h = prev > 0 ? Math.min(1, now / prev) : 0;
        return { l, h, proratedInv: r2((l.invoiceAmount || 0) * h) };
      });
      const invTot = rows.reduce((a, x) => a + x.proratedInv, 0);
      const billableN = rows.filter((x) => x.l.isBillable !== false).length;
      for (const { l, h, proratedInv } of rows) {
        const share = curTot > 0 ? (l.costUsd || 0) / curTot : 1 / lines.length;
        const invShare = invTot > 0 ? proratedInv / invTot : (billableN ? (l.isBillable !== false ? 1 / billableN : 0) : 1 / rows.length);
        await prisma.monthlyLine.update({ where: { id: l.id }, data: {
          costUsd: total * share, deploymentEnd: effectiveEnd(l.deploymentEnd, billingEndDate),
          estimateHours: r2((l.estimateHours || 0) * h), actualHours: r2((l.actualHours || 0) * h),
          billingAmount: r2((l.billingAmount || 0) * h),
          invoiceAmount: invOverride != null ? r2(invOverride * invShare) : proratedInv,
        } });
      }
      appliedMonthCost = total;
    }
  }
  await prisma.auditLog.create({ data: { userId, action: "TERMINATE_EMPLOYEE", entity: "Employee", entityId: String(id), after: { name: emp.name, exitDate, resignationDate: body?.resignationDate ?? null, deploymentEndDate: body?.deploymentEndDate ?? null, removedLines: r.count, fnf, monthCost: appliedMonthCost, invoiceAmount: body?.invoiceAmount ?? null, basis: body?.basis } } }).catch(() => {});
  return { ok: true as const, exitDate, removedLines: r.count, fnf, monthCost: appliedMonthCost };
}

// Read-only preview for Employee Master's own direct Terminate button — same previewTermination
// engine the two-step Finance approval flow uses (see its own comment above), called with
// noBenchMovement forced true: unlike that two-step flow, this direct one-shot route has no bench-
// transition step at all — terminateEmployee's plain future-line delete runs for EVERY employment
// type here, full-time included, so "moves to Bench" would be a real lie for this specific button;
// everything is genuinely "removed" here, never benched.
router.get("/employees/:id/terminate-preview", requireRole(Role.FINANCE, Role.CTO), requirePermission("employees"), async (req, res) => {
  const employeeId = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { empType: true } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const exitDate = req.query.exitDate ? new Date(String(req.query.exitDate)) : new Date();
  if (isNaN(+exitDate)) return res.json({ found: false });
  const preview = await previewTermination(employeeId, { exitDate, isFullTime: emp.empType === "FULL_TIME", noBenchMovement: true });
  res.json(preview);
});

// Narrower than requireAdmin (CEO/CTO/FINANCE/QA) — this specific one-shot, no-approval-step
// action (see terminateEmployee's own comment: it finalizes immediately, no Finance review, no
// FnF paperwork trail) is restricted to Finance and CTO only. CEO and QA can still see Employee
// Master and everything else requireAdmin gates; only this direct button is narrower.
router.post("/employees/:id/terminate", requireRole(Role.FINANCE, Role.CTO), requirePermission("employees"), async (req, res) => {
  const employeeId = Number(req.params.id);
  // A two-step request (HR's "Request Termination" -> Finance's Termination Approvals queue) may
  // already be in flight for this person — deployment end already approved, cost/access impact
  // already applied, FnF pending. Letting this direct one-shot route ALSO run would double-process
  // them (a second, conflicting exitDate/FnF/monthly-line pass) with no trace linking the two.
  const pendingReq = await prisma.terminationApprovalRequest.findFirst({ where: { employeeId, status: "PENDING" } });
  if (pendingReq) return res.status(400).json({ error: "A termination request for this employee is already pending Finance approval in Termination Approvals — finish it there instead of using this button." });
  const r = await terminateEmployee(employeeId, req.body, req.user!.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  // Direct one-shot admin Terminate: unlike the two-step Finance-approval flow's step one
  // (deployment-end-only, setExitDate:false — employee stays active), this route always finalizes
  // the exit, so offboarding queues immediately unless the caller explicitly deferred exitDate.
  let offboardingQueued = false;
  if (req.body?.setExitDate !== false) {
    // Same reinstate-then-re-terminate reset as terminationApprovals.ts — a stale COMPLETED row
    // from a prior employment stint must reopen, not silently block this cycle's offboarding task.
    const already = await prisma.itOffboardingRequest.findUnique({ where: { employeeId } });
    if (!already || already.completedAt) {
      const existingUser = await prisma.user.findFirst({ where: { employeeId } });
      if (existingUser) await prisma.user.delete({ where: { id: existingUser.id } }).catch(() => {});
      await prisma.itOffboardingRequest.upsert({
        where: { employeeId },
        update: { completedAt: null, completedById: null, accountDisabled: false, licenseRemoved: false, removedFromGroup: false, error: null, createdAt: new Date(), createdById: req.user!.id },
        create: { employeeId, createdById: req.user!.id },
      });
      offboardingQueued = true;
      const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true } });
      emitHelpdeskUpdate("it_offboarding_queued", { employeeId, employeeName: emp?.name });
    }
  }
  res.json({ ...r, offboardingQueued });
});

// HR-facing "request only" entry point — HR supplies just the exit date; nothing is applied yet.
// Sends a notification to Finance/CTO/CEO, who review the SAME rich Terminate form (day basis,
// FNF, cost/invoice overrides) in terminationApprovals.ts and only then call terminateEmployee()
// above for real. Refuses a second request while one is already pending for this employee.
// Full-time employees give notice/basic/EL/reimbursement inputs for FnF; contractors/vendors
// give a deployment end date instead (billing-based FnF). Mirrors Employee.empType's "FULL_TIME"
// vs. everything-else (CONTRACTOR/VENDOR/W2_NO_BENEFIT) split used across the HR module.
router.get("/employees/:id/termination-fnf-suggestion", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const employeeId = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const isFullTime = emp.empType === "FULL_TIME";
  if (!isFullTime) return res.json({ isFullTime: false });
  const ctc = await prisma.ctcRecord.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: "desc" } });
  // Finance reviewing this (not just HR at request time) may have already overridden Full Pay
  // in their own form — recalculating off the real CTC record only would ignore that override.
  const basicSalary = req.query.basicSalary != null && req.query.basicSalary !== "" ? Number(req.query.basicSalary) : fullPayFor(ctc);
  const basicCurrency = ctc?.currency || "INR";
  const requiredNoticeDays = Number(req.query.requiredNoticeDays) || 0;
  const servedNoticeDays = Number(req.query.servedNoticeDays) || 0;
  const exitDate = req.query.exitDate ? new Date(String(req.query.exitDate)) : new Date();
  const payFullNoticePeriod = req.query.payFullNoticePeriod === "true";
  // Notice Pay always prices off plain Basic (live from the CTC record by default) — never Full
  // Pay, even when Full Pay above has been hand-overridden. See computeFnfSuggestion's own comment.
  const basicOnly = req.query.basicOnly != null && req.query.basicOnly !== "" ? Number(req.query.basicOnly) : (ctc?.basic || 0);
  // Reimbursement is Finance-entered on the form itself (not computed here) — passed through only
  // so TDS's own Gross Total Income base includes whatever's currently on screen.
  const reimbursementAmount = req.query.reimbursementAmount != null && req.query.reimbursementAmount !== "" ? Number(req.query.reimbursementAmount) : 0;
  const suggestion = await computeFnfSuggestion(employeeId, exitDate, basicSalary, requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicOnly, reimbursementAmount);
  res.json({ isFullTime: true, basicSalary, basicOnly, basicCurrency, ...suggestion });
});

// Employee ids with a termination request already PENDING Finance approval — lets the Terminate
// Employee page show "Pending Finance Approval" and block a second request, without giving HR
// access to the full termination-approvals queue (Finance-only, with FnF detail) below.
// Stage mirrors terminationApprovals.ts's own showFnfStage/needsDeploymentEndApproval exactly: a
// two-step request not yet past its Deployment End Date approval is still on the plain
// "Termination Approvals" queue (no FnF involved yet); everything else (single-step, or two-step
// already approved) is on "FNF Pending" instead. Lets HR's own Terminate Employee page show which
// queue a request is actually sitting in, instead of one generic "Pending Finance Approval" label.
router.get("/employees/termination-pending-ids", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (_req, res) => {
  const rows = await prisma.terminationApprovalRequest.findMany({ where: { status: "PENDING" }, select: { employeeId: true, deploymentEndDate: true, deploymentEndApprovedAt: true } });
  res.json(rows.map((r) => ({
    employeeId: r.employeeId,
    stage: (r.deploymentEndDate && !r.deploymentEndApprovedAt) ? "DEPLOYMENT_END" : "FNF",
  })));
});

router.post("/employees/:id/request-termination", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const employeeId = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  if (emp.exitDate) return res.status(400).json({ error: "This employee is already terminated." });
  // Intern termination needs no Finance approval and no FnF settlement at all — remove them from
  // the system directly as of the Termination Date HR specifies, same as the admin's own direct
  // Terminate action, just triggered from this same HR-facing form for a consistent UI.
  if (emp.empType === "INTERN") {
    const result = await terminateEmployee(employeeId, { exitDate: req.body?.exitDate, fnfAmount: 0 }, req.user!.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    // Same "Send to IT" queue the direct admin Terminate route uses, and the same one used during
    // the Intern Activation flow — an intern is genuinely done the moment HR terminates them, so
    // IT Admin gets notified immediately to disable the account, no separate Finance step first.
    const already = await prisma.itOffboardingRequest.findUnique({ where: { employeeId } });
    if (!already || already.completedAt) {
      const existingUser = await prisma.user.findFirst({ where: { employeeId } });
      if (existingUser) await prisma.user.delete({ where: { id: existingUser.id } }).catch(() => {});
      await prisma.itOffboardingRequest.upsert({
        where: { employeeId },
        update: { completedAt: null, completedById: null, accountDisabled: false, licenseRemoved: false, removedFromGroup: false, error: null, createdAt: new Date(), createdById: req.user!.id },
        create: { employeeId, createdById: req.user!.id },
      });
      emitHelpdeskUpdate("it_offboarding_queued", { employeeId, employeeName: emp.name });
    }
    return res.json({ terminatedImmediately: true, employeeId, exitDate: result.exitDate, removedLines: result.removedLines });
  }
  const existing = await prisma.terminationApprovalRequest.findFirst({ where: { employeeId, status: "PENDING" } });
  if (existing) return res.status(400).json({ error: "A termination request for this employee is already pending Finance approval." });
  const b = req.body || {};
  if (!b.fnfFinalizationDate) return res.status(400).json({ error: "FNF Finalization Date is required." });
  const exitDate = req.body?.exitDate ? new Date(req.body.exitDate) : new Date();
  const isFullTime = emp.empType === "FULL_TIME";
  const data: any = {
    employeeId, exitDate, requestedById: req.user!.id,
    resignationDate: b.resignationDate ? new Date(b.resignationDate) : null,
    fnfFinalizationDate: new Date(b.fnfFinalizationDate),
    emailTerminated: !!b.emailTerminated,
  };
  if (isFullTime) {
    const ctc = await prisma.ctcRecord.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: "desc" } });
    const requiredNoticeDays = b.requiredNoticeDays != null ? Number(b.requiredNoticeDays) : 0;
    const servedNoticeDays = b.servedNoticeDays != null ? Number(b.servedNoticeDays) : 0;
    const basicSalary = b.basicSalary != null ? Number(b.basicSalary) : fullPayFor(ctc);
    const payFullNoticePeriod = !!b.payFullNoticePeriod;
    // Notice Pay always prices off plain Basic (live from the CTC record by default) — never Full Pay.
    const basicOnly = b.basicOnly != null ? Number(b.basicOnly) : (ctc?.basic || 0);
    const reimbursementAmount = b.reimbursementAmount != null ? Number(b.reimbursementAmount) : 0;
    const suggestion = await computeFnfSuggestion(employeeId, exitDate, basicSalary, requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicOnly, reimbursementAmount);
    Object.assign(data, {
      requiredNoticeDays, servedNoticeDays, basicSalary, basicOnly, payFullNoticePeriod,
      basicCurrency: ctc?.currency || "INR",
      elEncashmentDays: b.elEncashmentDays != null ? Number(b.elEncashmentDays) : suggestion.elEncashmentDays,
      elEncashmentAmount: b.elEncashmentAmount != null ? Number(b.elEncashmentAmount) : suggestion.elEncashmentAmount,
      noticePayAmount: b.noticePayAmount != null ? Number(b.noticePayAmount) : suggestion.noticePayAmount,
      reimbursementAmount: b.reimbursementAmount != null ? Number(b.reimbursementAmount) : 0,
      daysWorkedSalary: b.daysWorkedSalary != null ? Number(b.daysWorkedSalary) : suggestion.daysWorkedSalary,
      otherFlexiBenefitsAmount: b.otherFlexiBenefitsAmount != null ? Number(b.otherFlexiBenefitsAmount) : suggestion.otherFlexiBenefitsAmount,
      tdsAmount: b.tdsAmount != null ? Number(b.tdsAmount) : suggestion.tdsAmount,
      noBenchMovement: !!b.noBenchMovement,
    });
    // Required for a billable full-time resource (their project's revenue/cost proration depends
    // on it); optional for a non-billable one — set only when the project ends before the actual
    // termination date (the employee sits on Bench in between, per Monthly Forecast's own
    // deployment-window/bench engine — see terminationApprovals.ts's approve-deployment-end).
    if (emp.isBillable !== false && !b.deploymentEndDate) {
      return res.status(400).json({ error: "Deployment End Date is required for a billable employee." });
    }
    if (b.deploymentEndDate) data.deploymentEndDate = new Date(b.deploymentEndDate);
  } else {
    if (!b.deploymentEndDate) return res.status(400).json({ error: "Deployment End Date is required for a contractor/vendor termination." });
    data.deploymentEndDate = new Date(b.deploymentEndDate);
    // Contractor-only FnF document overrides — see their own schema comments. Stored as submitted
    // by HR so Finance sees exactly what HR filled, same as every other field on this request.
    if (b.fnfPrintDate) data.fnfPrintDate = new Date(b.fnfPrintDate);
    if (b.payableDaysOverride != null && b.payableDaysOverride !== "") data.payableDaysOverride = Number(b.payableDaysOverride);
    if (b.leavesCount != null && b.leavesCount !== "") data.leavesCount = Number(b.leavesCount);
    if (b.includeGst != null) data.includeGst = b.includeGst === true || b.includeGst === "true";
    if (b.arrearAmount != null && b.arrearAmount !== "") data.arrearAmount = Number(b.arrearAmount);
    // HR's own override of "Salary for Days Worked This Month" (converted to USD) — when HR hand-
    // types this figure instead of leaving it at the auto-computed value, it becomes the starting
    // FNF Amount Finance's approval panel loads (their own /cost-driven auto-populate only kicks in
    // when finalFnfAmount is still null — see TerminationApprovalDetail's load effect), same as any
    // other field here that's "whatever HR submitted, Finance can still override."
    if (b.finalFnfAmount != null && b.finalFnfAmount !== "") data.finalFnfAmount = Number(b.finalFnfAmount);
  }
  const reqRow = await prisma.terminationApprovalRequest.create({ data });
  emitAttention(["FINANCE", "CTO", "CEO", "COO"], "termination_approval_pending", { employeeName: emp.name });

  const recipients = await prisma.user.findMany({ where: { role: { in: ["FINANCE", "CTO", "CEO"] } }, select: { email: true } });
  const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key: "TERMINATION_APPROVAL_REQUEST", businessUnitId: emp.businessUnitId ?? null } })
    || await prisma.hrEmailTemplate.findFirst({ where: { key: "TERMINATION_APPROVAL_REQUEST", businessUnitId: null } });
  const vals = { EmployeeName: emp.name, EmployeeId: emp.empNo || "", ExitDate: fmtDate(exitDate) };
  const fillTpl = (t: string) => t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => (vals as any)[k] ?? "");
  const subject = fillTpl(tpl?.subject || "Action needed: termination approval for {{EmployeeName}} ({{EmployeeId}})");
  const html = fillTpl(tpl?.body || "HR has requested termination — please review and approve.").replace(/\n/g, "<br>");
  let sentCount = 0;
  if (mailEnabled()) {
    for (const r of recipients) { if (!r.email) continue; try { const rr = await notifyMail("TERMINATION_APPROVAL_REQUEST", { fromUpn: req.user!.email, to: r.email, subject, html }); if (rr.sent) sentCount++; } catch { /* one bad recipient shouldn't block the rest */ } }
  }
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "REQUEST_TERMINATION", entity: "Employee", entityId: String(employeeId), after: { name: emp.name, exitDate, requestId: reqRow.id } } }).catch(() => {});
  res.status(201).json({ request: reqRow, notified: sentCount, totalRecipients: recipients.length });
});

// Live FnF Settlement PDF preview for HR's still-in-progress Terminate Employee form — nothing
// is saved yet (no TerminationApprovalRequest row exists until Submit), so every field comes
// straight off whatever's currently on screen, via query params, mirroring /request-termination's
// own field-merging logic exactly (same suggestion fallback for otherFlexiBenefitsAmount/tdsAmount,
// which this form doesn't expose its own inputs for) so the preview always matches what Finance's
// queue will actually show once HR submits. Contractor/vendor: this form collects no real FnF
// Amount (Finance determines that from billing/invoice at approval) — the client seeds
// `finalFnfAmount` with the Salary-for-Days-Worked estimate already shown on screen instead of
// leaving it 0, purely so the preview looks like a real document rather than a broken one;
// Finance's own screen still starts independent of whatever HR previewed here.
router.get("/employees/:id/fnf-request-preview.pdf", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const employeeId = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const q: any = req.query || {};
  const num = (k: string, fallback = 0) => (q[k] != null && q[k] !== "" ? Number(q[k]) : fallback);
  const exitDate = q.exitDate ? new Date(String(q.exitDate)) : new Date();
  const isFullTime = emp.empType === "FULL_TIME";
  const merged: any = {
    employee: emp, exitDate,
    resignationDate: q.resignationDate ? new Date(String(q.resignationDate)) : null,
    fnfFinalizationDate: q.fnfFinalizationDate ? new Date(String(q.fnfFinalizationDate)) : null,
    deploymentEndDate: q.deploymentEndDate ? new Date(String(q.deploymentEndDate)) : null,
  };
  if (isFullTime) {
    const ctc = await prisma.ctcRecord.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: "desc" } });
    const requiredNoticeDays = num("requiredNoticeDays");
    const servedNoticeDays = num("servedNoticeDays");
    const basicSalary = num("basicSalary", fullPayFor(ctc));
    const payFullNoticePeriod = q.payFullNoticePeriod === "true";
    const basicOnly = num("basicOnly", ctc?.basic || 0);
    const reimbursementAmount = num("reimbursementAmount");
    const suggestion = await computeFnfSuggestion(employeeId, exitDate, basicSalary, requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicOnly, reimbursementAmount);
    Object.assign(merged, {
      requiredNoticeDays, servedNoticeDays, basicSalary, payFullNoticePeriod,
      basicCurrency: ctc?.currency || "INR",
      elEncashmentDays: num("elEncashmentDays", suggestion.elEncashmentDays),
      elEncashmentAmount: num("elEncashmentAmount", suggestion.elEncashmentAmount),
      noticePayAmount: num("noticePayAmount", suggestion.noticePayAmount),
      reimbursementAmount,
      daysWorkedSalary: num("daysWorkedSalary", suggestion.daysWorkedSalary),
      otherFlexiBenefitsAmount: num("otherFlexiBenefitsAmount", suggestion.otherFlexiBenefitsAmount),
      tdsAmount: num("tdsAmount", suggestion.tdsAmount),
    });
  } else {
    Object.assign(merged, {
      basicCurrency: "INR", finalFnfAmount: num("finalFnfAmount"), includeGst: q.includeGst !== "false", gstAmount: q.gstAmount != null && q.gstAmount !== "" ? Number(q.gstAmount) : null,
      fnfPrintDate: q.fnfPrintDate ? new Date(String(q.fnfPrintDate)) : null,
      payableDaysOverride: q.payableDaysOverride != null && q.payableDaysOverride !== "" ? Number(q.payableDaysOverride) : null,
      leavesCount: q.leavesCount != null && q.leavesCount !== "" ? Number(q.leavesCount) : null,
      arrearAmount: q.arrearAmount != null && q.arrearAmount !== "" ? Number(q.arrearAmount) : null,
    });
  }
  const data = await buildFnfPdfData(merged);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="FNF_Preview_${emp.empNo || employeeId}.pdf"`);
  renderFnfPdf(data, res);
});

// Reinstate a terminated employee (clear exitDate) — returns them to the active list.
router.post("/employees/:id/reinstate", requireAdmin, requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const emp = await prisma.employee.update({ where: { id }, data: { exitDate: null } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "REINSTATE_EMPLOYEE", entity: "Employee", entityId: String(id), after: { name: emp.name } } }).catch(() => {});
  res.json({ ok: true });
});

// computed cost (CTC components + FX, with proration override)
router.get("/employees/:id/cost", requireAdmin, requirePermission("employees"), async (req, res) => {
  const c = await computeEmployeeCost(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});
// Full-lifecycle summary for Past Employees — every project ever deployed to, and total
// revenue/cost across every monthly line the employee ever had (all fiscal years, locked or not).
router.get("/employees/:id/lifecycle", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const lines = await prisma.monthlyLine.findMany({ where: { employeeId: id, isExpense: false } });
  const projectNames = [...new Set(lines.map((l) => l.projectName).filter((n) => n && n !== "GenAquarius (Bench)"))];
  const totalRevenue = lines.reduce((a, l) => a + (l.invoiceAmount || 0), 0);
  const totalCost = lines.reduce((a, l) => a + (l.costUsd || 0), 0);
  const lastTermination = await prisma.terminationApprovalRequest.findFirst({ where: { employeeId: id, status: "APPROVED" }, orderBy: { reviewedAt: "desc" } });
  res.json({
    joiningDate: emp.joiningDate, exitDate: emp.exitDate,
    resignationDate: lastTermination?.resignationDate || null,
    deploymentEndDate: lastTermination?.deploymentEndDate || null,
    projects: projectNames,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    monthsTracked: new Set(lines.map((l) => l.monthlySheetId)).size,
    hasFnfDocument: !!lastTermination,
    // Same "always regenerated from current data, no stored binary" convention as the PDF — the
    // .docx is equally available whenever an APPROVED termination request exists.
    hasFnfSettlementDocx: !!lastTermination,
    // Lets Finance Send/Resend the FnF Settlement straight from Past Employees — reuses the same
    // POST /termination-approvals/:id/fnf-settlement/send endpoint FNF Pending's own completed
    // panel calls (already handles an already-APPROVED request as a resend, no server change
    // needed there), just reachable again later instead of only in the one moment right after
    // Approve & Terminate.
    terminationRequestId: lastTermination?.id || null,
  });
});
// Signed Offer/Appointment/Service Agreement documents — via the employee's own Offer record
// (EsignAgreement.docId is always Offer.id, whichever of the three document types it is).
router.get("/employees/:id/esign-documents", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id }, include: { offer: { select: { id: true } } } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  if (!emp.offer) return res.json([]);
  const rows = await prisma.esignAgreement.findMany({ where: { docId: emp.offer.id, docType: { in: ["OFFER", "APPOINTMENT_LETTER", "SERVICE_AGREEMENT"] } } });
  res.json(rows);
});
// Every SYSTEM-GENERATED document for this employee in one list — SLA/Service Agreement or
// Appointment Letter (from their Offer), every Appraisal letter ever issued, the FnF Settlement
// (if terminated), and the Relieving Letter (if issued) — so Employee Master's own Review
// Documents section always shows the full real set, not just the self-uploaded onboarding docs
// EmployeeDocumentsPanel already covers. Existence of each underlying row IS "has this document
// been generated" — nothing here is created, only read.
router.get("/employees/:id/generated-documents", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const emp = await prisma.employee.findUnique({ where: { id }, include: { offer: true } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const docs: { label: string; url: string; generatedAt: Date | null }[] = [];

  if (emp.offer) {
    const offerId = emp.offer.id;
    const isContractor = emp.offer.employmentType !== "EMPLOYEE";
    if (isContractor) {
      const sa = await prisma.serviceAgreement.findUnique({ where: { offerId } });
      if (sa) docs.push({ label: emp.offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement (SLA)", url: `/hr/offers/${offerId}/service-agreement/pdf`, generatedAt: sa.createdAt });
    } else {
      const appt = await prisma.appointmentLetter.findUnique({ where: { offerId } });
      if (appt && appt.status !== "DRAFT") docs.push({ label: "Appointment Letter", url: `/hr/offers/${offerId}/appointment/pdf`, generatedAt: appt.issuedAt });
    }
  }

  const appraisals = await prisma.appraisal.findMany({ where: { employeeId: id, status: { not: "DRAFT" } }, orderBy: { issuedAt: "desc" } });
  for (const a of appraisals) docs.push({ label: `Appraisal Letter (${a.appraisalRef})`, url: `/appraisals/${a.id}/pdf`, generatedAt: a.issuedAt });

  const fnf = await prisma.terminationApprovalRequest.findFirst({ where: { employeeId: id, status: "APPROVED" }, orderBy: { reviewedAt: "desc" } });
  if (fnf) docs.push({ label: "FnF Settlement", url: `/employees/${id}/fnf-document.pdf`, generatedAt: fnf.reviewedAt });

  const relieving = await prisma.relievingLetter.findMany({ where: { employeeId: id }, orderBy: { date: "desc" } });
  for (const r of relieving) docs.push({ label: "Relieving Letter", url: `/relieving-letters/${r.id}/pdf`, generatedAt: r.date });

  res.json(docs);
});

// FNF settlement PDF, keyed by employeeId — used from Past/Terminated Employees' lifecycle
// view (Finance already downloads the same document from Termination Approvals/FNF Pending
// directly by request id; this is the "find it from the employee's own record" entry point).
router.get("/employees/:id/fnf-document.pdf", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const reqRow = await prisma.terminationApprovalRequest.findFirst({
    where: { employeeId: id, status: "APPROVED" },
    orderBy: { reviewedAt: "desc" },
    include: { employee: { select: { name: true, empNo: true, designation: true, department: true, phone: true, empType: true, joiningDate: true, businessUnitId: true } } },
  });
  if (!reqRow) return res.status(404).json({ error: "No finalized FnF settlement found for this employee" });
  const data = await buildFnfPdfData(reqRow);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="FNF_${reqRow.employee?.empNo || id}.pdf"`);
  renderFnfPdf(data, res);
});
// .docx counterpart of the PDF above, same broader HR/Admin access (the FINANCE/CTO/CEO-only
// /termination-approvals/:id/fnf-settlement.docx route requires a role HR doesn't have) — this is
// the "find it from the employee's own record" entry point Past/Terminated Employees uses.
router.get("/employees/:id/fnf-settlement.docx", requireRole(...ADMIN_ROLES, Role.HR), requirePermission("employees"), async (req, res) => {
  const id = Number(req.params.id);
  const reqRow = await prisma.terminationApprovalRequest.findFirst({
    where: { employeeId: id, status: "APPROVED" },
    orderBy: { reviewedAt: "desc" },
    include: { employee: { select: { name: true, empNo: true, designation: true, department: true, phone: true, empType: true, joiningDate: true, businessUnitId: true } } },
  });
  if (!reqRow) return res.status(404).json({ error: "No finalized FnF settlement found for this employee" });
  const data = await buildFnfPdfData(reqRow);
  const empType = reqRow.employee?.empType === "FULL_TIME" ? "FULL_TIME" : "CONTRACTOR";
  const tpl = await prisma.fnfSettlementTemplate.findFirst({ where: { isDefault: true, empType } })
    .then((t) => t || prisma.fnfSettlementTemplate.findFirst({ where: { empType } }));
  const buffer = await renderFnfDocxBuffer(data, tpl?.bodyText || "");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${fnfDocxFileName(data, reqRow.id)}"`);
  res.send(buffer);
});
// Prorated monthly cost for a specific fiscal month, with the per-segment breakdown
// (each (empType, CTC) period split by the days it was in effect — mid-month conversions/joins/exits).
router.get("/employees/:id/monthly-cost", requireAdmin, requirePermission("employees"), async (req, res) => {
  const fiscalYear = String(req.query.fiscalYear || "");
  const monthIndex = Number(req.query.monthIndex);
  if (!fiscalYear || !monthIndex) return res.status(400).json({ error: "fiscalYear and monthIndex are required" });
  const r = await computeMonthlyCostBreakdown(Number(req.params.id), fiscalYear, monthIndex);
  const segments = r.segments.map((s) => ({
    from: new Date(s.fromDay * 86400000).toISOString().slice(0, 10),
    to: new Date(s.toDay * 86400000).toISOString().slice(0, 10),
    days: s.days, empType: s.empType, monthlyUsd: Math.round(s.monthlyUsd), amountUsd: Math.round(s.amountUsd * 100) / 100,
  }));
  res.json({ costUsd: Math.round(r.costUsd * 100) / 100, dim: r.dim, segments });
});
// assign employee to one/many projects
router.post("/employees/:id/projects", requireAdmin, requirePermission("employees"), async (req, res) => {
  const employeeId = Number(req.params.id);
  const projectIds: number[] = req.body.projectIds || [];
  await prisma.employeeProject.deleteMany({ where: { employeeId } });
  if (projectIds.length)
    await prisma.employeeProject.createMany({ data: projectIds.map((projectId) => ({ employeeId, projectId })) });
  res.json(await prisma.employeeProject.findMany({ where: { employeeId }, include: { project: true } }));
});

// ---- CTC ----
// Build the CTC data from the form body. India = INR salary components; US = either
// a W2 annual USD salary or a vendor hourly rate (annualized = rate × hours/day × days/yr).
// For India we deliberately omit annualCostOverride so imported (workbook-parity) values
// are never clobbered on edit; for US we set it to the resolved annual USD cost.
// Resolve the effective-dated employment type carried on a CTC record. US types follow the
// engagement; India is Full-Time unless the form explicitly marks it Contractor.
function empTypeFor(b: any): string {
  if (String(b.location || "").toUpperCase() === "US") {
    const eng = b.usEngagement;
    return eng === "VENDOR" ? "VENDOR" : eng === "W2_NO_BENEFIT" ? "W2_NO_BENEFIT" : "FULL_TIME";
  }
  return b.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME";
}
async function ctcData(b: any): Promise<any> {
  const empType = empTypeFor(b);
  // Canada — a straight annual salary like US-W2, but entered in CAD (what Finance actually sees
  // the offer letter/paystub in) and converted to its USD-equivalent here via the same
  // CANADA_FACTOR rate every other CAD amount in the app uses (toUsd), since ctcAnnualUsd() /
  // computeEmployeeCost() read annualCostOverride as an already-USD figure — unlike India's own
  // INR-components path, there's no later re-conversion step for this field. currency stays "CAD"
  // purely so the record remembers what it was actually entered in.
  if (String(b.location || "").toUpperCase() === "CANADA") {
    const annualCad = +b.annualSalaryCad || 0;
    return {
      currency: "CAD",
      basic: 0, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0,
      communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0,
      annualCostOverride: await toUsd(annualCad, "CAD"),
      usEngagement: null, rateBasis: null, hourlyRateUsd: null, dayRateUsd: null,
      hoursPerDay: null, workingDaysPerYear: null, empType,
    };
  }
  if (String(b.location || "").toUpperCase() === "US") {
    // W2 = annual salary (with benefits); VENDOR and W2_NO_BENEFIT = hourly engagements that
    // bill either by HOURLY rate (rate × hours/day × days/yr) or by DAILY rate (day rate × days/yr).
    const eng = ["VENDOR", "W2_NO_BENEFIT", "W2"].includes(b.usEngagement) ? b.usEngagement : "W2";
    const hourly = eng === "VENDOR" || eng === "W2_NO_BENEFIT";
    if (!hourly) {
      return {
        currency: "USD",
        basic: 0, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0,
        communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0,
        annualCostOverride: +b.annualSalaryUsd || 0,
        usEngagement: eng, rateBasis: null, hourlyRateUsd: null, dayRateUsd: null,
        hoursPerDay: null, workingDaysPerYear: null, empType,
      };
    }
    // Billing basis: DAILY = day rate × working days; HOURLY = hourly rate × hours/day × working days.
    const basis = String(b.rateBasis || "").toUpperCase() === "DAILY" ? "DAILY" : "HOURLY";
    const hoursPerDay = Math.round(+b.hoursPerDay) || 8;
    const workingDaysPerYear = Math.round(+b.workingDaysPerYear) || 260;
    let hourlyRateUsd: number, dayRateUsd: number, annual: number;
    if (basis === "DAILY") {
      dayRateUsd = +b.dayRateUsd || 0;
      // Keep an hourly-equivalent so the cost engine (cost = hourly × billable hours) still works.
      hourlyRateUsd = hoursPerDay > 0 ? dayRateUsd / hoursPerDay : 0;
      annual = dayRateUsd * workingDaysPerYear;
    } else {
      hourlyRateUsd = +b.hourlyRateUsd || 0;
      dayRateUsd = hourlyRateUsd * hoursPerDay;
      annual = hourlyRateUsd * hoursPerDay * workingDaysPerYear;
    }
    return {
      currency: "USD",
      basic: 0, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0,
      communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0,
      annualCostOverride: annual,
      usEngagement: eng, rateBasis: basis, hourlyRateUsd, dayRateUsd, hoursPerDay, workingDaysPerYear, empType,
    };
  }
  return {
    currency: b.currency || "INR",
    basic: +b.basic || 0, hra: +b.hra || 0, otherAllowance: +b.otherAllowance || 0,
    specialAllowance: +b.specialAllowance || 0, conveyance: +b.conveyance || 0,
    communication: +b.communication || 0, meals: +b.meals || 0, books: +b.books || 0,
    driver: +b.driver || 0, uniform: +b.uniform || 0, bonusAnnual: +b.bonusAnnual || 0,
    // India CTC is driven by its INR components (monthly cost). Clear any stale annual
    // override so an edited monthly cost actually takes effect — the /ctc endpoint reads
    // the override first, so leaving it set would silently ignore the new value.
    annualCostOverride: null,
    usEngagement: null, rateBasis: null, hourlyRateUsd: null, dayRateUsd: null, hoursPerDay: null, workingDaysPerYear: null, empType,
  };
}

// "Full Pay" for FnF day-rate purposes (Salary for Days Worked, and Notice Pay) — the FIXED CTC
// bracket components (Basic + HRA + Special/Other Allowance), never the variable/reimbursement
// components (Conveyance, Communication, Meals, Books, Driver, Uniform) or the annual Bonus — per
// explicit business rule: those are reimbursements, not part of what "full pay per day" means.
function fullPayFor(ctc: { basic?: number | null; hra?: number | null; otherAllowance?: number | null; specialAllowance?: number | null } | null | undefined): number {
  return (ctc?.basic || 0) + (ctc?.hra || 0) + (ctc?.otherAllowance || 0) + (ctc?.specialAllowance || 0);
}

// Parse a fiscal-year label ("FY26-27") → its calendar start year (2026).
function fyStartYear(label: string): number {
  const m = /FY(\d{2})/i.exec(label || "");
  return m ? 2000 + Number(m[1]) : new Date().getFullYear();
}
// Last day of a fiscal month — used as the as-of date for picking the effective CTC.
function monthAsOf(fyLabel: string, monthIndex: number): Date {
  const startYear = fyStartYear(fyLabel);
  const calMonth = ((monthIndex - 1 + 3) % 12) + 1;        // Apr(1)→4 … Mar(12)→3
  const year = monthIndex <= 9 ? startYear : startYear + 1; // Apr–Dec = start year; Jan–Mar = next
  return new Date(year, calMonth, 0);
}
// Re-cost an employee's resource lines in every EDITABLE (non-locked) monthly sheet so the
// Cost column reflects their new/edited CTC. Existing split proportions across projects are
// preserved (allocation-aware); a single line just gets the full monthly cost. LOCKED months
// are never touched (they keep workbook-parity values). Exported for appraisalApprovals.ts too —
// approving a revised-CTC appraisal creates a new CtcRecord exactly like the direct Admin CTC
// routes here do, and must reflect it into Monthly Forecast the same way, not just add the record.
// Each line's stored costUsd = its CTC share + per-line add-ons (doubleDipIncentive + bonus) — see
// monthly.ts's own cost writer. Re-costing must only touch the CTC part and carry the add-ons over.
// fromDate (optional): months that END before it are skipped (an appraisal effective 8 Oct must not
// re-price Jul–Sep). Day-rate/hourly vendor lines are skipped — their cost is billable-day based,
// not CTC-derived (same rule monthly.ts applies).
export const lineAddon = (l: any) => (Number(l.doubleDipIncentive) || 0) + (Number(l.bonus) || 0);
export async function applyCtcToMonthlyLines(employeeId: number, fromDate?: Date | null): Promise<number> {
  const cc = await computeEmployeeCost(employeeId);
  if (cc && (cc.usEngagement === "VENDOR" || cc.usEngagement === "W2_NO_BENEFIT")) return 0;
  const sheets = await prisma.monthlySheet.findMany({
    where: { status: { not: "LOCKED" } },
    include: { lines: { where: { employeeId, isExpense: false } } },
  });
  let updated = 0;
  for (const sheet of sheets) {
    if (!sheet.lines.length) continue;
    if (fromDate && monthAsOf(sheet.fiscalYear, sheet.monthIndex).getTime() < new Date(fromDate).setHours(0, 0, 0, 0)) continue;
    // Prorated monthly cost — sums each (empType, CTC) segment by the days in effect this month
    // (mid-month conversions/joins/exits are split automatically).
    const monthlyCost = await computeMonthlyEmployeeCostUsd(employeeId, sheet.fiscalYear, sheet.monthIndex);
    const ctcPart = (l: any) => Math.max(0, (l.costUsd || 0) - lineAddon(l));
    const existingTotal = sheet.lines.reduce((s, l) => s + ctcPart(l), 0);
    for (const l of sheet.lines) {
      const share = existingTotal > 0 ? ctcPart(l) / existingTotal : 1 / sheet.lines.length;
      await prisma.monthlyLine.update({ where: { id: l.id }, data: { costUsd: monthlyCost * share + lineAddon(l) } });
      updated++;
    }
  }
  return updated;
}

router.get("/ctc", requireAdmin, requirePermission("ctc"), async (_req, res) => {
  const rows = await prisma.ctcRecord.findMany({ include: { employee: true }, orderBy: { effectiveFrom: "desc" } });
  // Attach a computed Annual USD to every record so the list shows a real figure for
  // all employees — not just the ones with an explicit annualCostOverride. Precedence:
  //   1. annualCostOverride (W2 salary / any explicit override)
  //   2. hourly engagements (W2/No-Benefit, Vendor): hourly × hours/day × working-days/year
  //   3. India INR components: (monthly INR × 12 + annual bonus) ÷ USD_INR FX rate
  const fx = await prisma.fxRate.findFirst({ where: { context: "USD_INR" }, orderBy: { effectiveFrom: "desc" } });
  const rate = fx?.rate || 93;
  const withUsd = rows.map((c: any) => {
    let annualUsd: number, src: string;
    if (c.annualCostOverride != null && c.annualCostOverride > 0) { annualUsd = c.annualCostOverride; src = "override"; }
    else if ((c.usEngagement === "VENDOR" || c.usEngagement === "W2_NO_BENEFIT") && c.rateBasis === "DAILY" && c.dayRateUsd) {
      annualUsd = (c.dayRateUsd || 0) * (c.workingDaysPerYear || 260); src = "daily";
    }
    else if ((c.usEngagement === "VENDOR" || c.usEngagement === "W2_NO_BENEFIT") && c.hourlyRateUsd) {
      annualUsd = (c.hourlyRateUsd || 0) * (c.hoursPerDay || 8) * (c.workingDaysPerYear || 260); src = "hourly";
    } else {
      const monthlyInr = (c.basic || 0) + (c.hra || 0) + (c.otherAllowance || 0) + (c.specialAllowance || 0)
        + (c.conveyance || 0) + (c.communication || 0) + (c.meals || 0) + (c.books || 0) + (c.driver || 0) + (c.uniform || 0);
      annualUsd = (monthlyInr * 12 + (c.bonusAnnual || 0)) / rate; src = "inr";
    }
    return { ...c, annualUsd: Math.round(annualUsd), monthlyUsd: Math.round(annualUsd / 12), annualUsdSource: src, fxRate: rate };
  });
  res.json(withUsd);
});
// Keep Employee.empType in sync with the latest-effective CTC record's empType (the employee's
// "current" employment type), so the roster reflects the most recent conversion.
async function syncEmployeeEmpType(employeeId: number): Promise<void> {
  const latest = await prisma.ctcRecord.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: "desc" } });
  if (latest && (latest as any).empType) {
    await prisma.employee.update({ where: { id: employeeId }, data: { empType: (latest as any).empType } });
  }
}
router.post("/ctc", requireAdmin, requirePermission("ctc"), async (req, res) => {
  const b = req.body;
  const rec = await prisma.ctcRecord.create({
    data: { employeeId: Number(b.employeeId), effectiveFrom: new Date(b.effectiveFrom), effectiveTill: b.effectiveTill ? new Date(b.effectiveTill) : null, ...(await ctcData(b)) },
  });
  await syncEmployeeEmpType(rec.employeeId);
  const reflected = await applyCtcToMonthlyLines(rec.employeeId);
  res.status(201).json({ ...rec, reflected });
});

router.put("/ctc/:id", requireAdmin, requirePermission("ctc"), async (req, res) => {
  const b = req.body;
  const rec = await prisma.ctcRecord.update({ where: { id: Number(req.params.id) }, data: {
    ...(await ctcData(b)),
    effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : undefined,
    effectiveTill: b.effectiveTill !== undefined ? (b.effectiveTill ? new Date(b.effectiveTill) : null) : undefined,
  } });
  await syncEmployeeEmpType(rec.employeeId);
  const reflected = await applyCtcToMonthlyLines(rec.employeeId);
  res.json({ ...rec, reflected });
});
router.delete("/ctc/:id", requireAdmin, requirePermission("ctc"), async (req, res) => {
  const rec = await prisma.ctcRecord.findUnique({ where: { id: Number(req.params.id) } });
  await prisma.ctcRecord.delete({ where: { id: Number(req.params.id) } });
  if (rec) { await syncEmployeeEmpType(rec.employeeId); await applyCtcToMonthlyLines(rec.employeeId); }
  res.json({ ok: true });
});

// ---- Clients ----
router.get("/clients", requireAdmin, async (_req, res) => {
  res.json(await prisma.client.findMany({ include: { geography: true, projects: true }, orderBy: { name: "asc" } }));
});
router.post("/clients", requireAdmin, requirePermission("clients"), async (req, res) => {
  const b = req.body;
  const client = await prisma.client.create({
    data: {
      name: b.name, legalEntityName: (b.legalEntityName && b.legalEntityName.trim()) || b.name, code: b.code, email: b.email || null, ccEmail: b.ccEmail || null, bccEmail: b.bccEmail || null, addressTo: b.addressTo || null,
      geographyId: b.geographyId ? Number(b.geographyId) : null,
      state: (b.state && String(b.state).trim()) || null,
      billToAddress: b.billToAddress, attentionContact: b.attentionContact, logo: b.logo || null,
      currency: b.currency || "USD", paymentTermsDays: +b.paymentTermsDays || 30,
      invoiceTemplateId: b.invoiceTemplateId ? Number(b.invoiceTemplateId) : null,
    },
  });
  res.status(201).json(client);
});
router.put("/clients/:id", requireAdmin, requirePermission("clients"), async (req, res) => {
  const b = req.body;
  res.json(await prisma.client.update({ where: { id: Number(req.params.id) }, data: {
    name: b.name, legalEntityName: b.legalEntityName !== undefined ? ((b.legalEntityName && b.legalEntityName.trim()) || b.name || null) : undefined,
    billToAddress: b.billToAddress, attentionContact: b.attentionContact,
    email: b.email !== undefined ? (b.email || null) : undefined,
    ccEmail: b.ccEmail !== undefined ? (b.ccEmail || null) : undefined,
    bccEmail: b.bccEmail !== undefined ? (b.bccEmail || null) : undefined,
    addressTo: b.addressTo !== undefined ? (b.addressTo || null) : undefined,
    logo: b.logo !== undefined ? (b.logo || null) : undefined,
    currency: b.currency, paymentTermsDays: b.paymentTermsDays ? +b.paymentTermsDays : undefined,
    geographyId: b.geographyId ? Number(b.geographyId) : undefined,
    state: b.state !== undefined ? ((b.state && String(b.state).trim()) || null) : undefined,
    invoiceTemplateId: b.invoiceTemplateId !== undefined ? (b.invoiceTemplateId ? Number(b.invoiceTemplateId) : null) : undefined,
  } }));
});

router.delete("/clients/:id", requireAdmin, requirePermission("clients"), async (req, res) => {
  try { await prisma.client.delete({ where: { id: Number(req.params.id) } }); res.json({ ok: true }); }
  catch { res.status(400).json({ error: "Cannot delete — client has projects/invoices." }); }
});

// ---- Projects ----
router.get("/projects", requireAdmin, async (_req, res) => {
  res.json(await prisma.project.findMany({
    include: {
      client: { include: { geography: true } }, invoiceTemplates: { select: { id: true, name: true } },
      managers: { include: { employee: { select: { id: true, name: true, empNo: true } } } },
      subProjects: { orderBy: { name: "asc" } },
    },
    orderBy: { name: "asc" },
  }));
});

// ---- Sub-Projects — a lightweight named child of a Project holding exactly the fields that vary
// per resource/cost-center (PO Number, Code, Customer Ref No, Title/Description). See the model's
// own schema comment. Gated on the same "projects" permission as the parent Project itself.
router.get("/projects/:id/sub-projects", requireAdmin, requirePermission("projects"), async (req, res) => {
  res.json(await prisma.subProject.findMany({ where: { projectId: Number(req.params.id) }, orderBy: { name: "asc" } }));
});
router.post("/projects/:id/sub-projects", requireAdmin, requirePermission("projects"), async (req, res) => {
  const b = req.body;
  if (!b.name?.trim()) return res.status(400).json({ error: "Name is required." });
  try {
    const sp = await prisma.subProject.create({ data: {
      projectId: Number(req.params.id), name: b.name.trim(),
      code: b.code || null, poNumber: b.poNumber || null, customerRefNo: b.customerRefNo || null,
      title: b.title || null, attentionContact: b.attentionContact || null, description: b.description || null, status: b.status || "ACTIVE",
    } });
    res.status(201).json(sp);
  } catch { res.status(400).json({ error: "A Sub-Project with this name already exists on this Project." }); }
});
router.put("/sub-projects/:id", requireAdmin, requirePermission("projects"), async (req, res) => {
  const b = req.body;
  res.json(await prisma.subProject.update({ where: { id: Number(req.params.id) }, data: {
    name: b.name !== undefined ? b.name.trim() : undefined,
    code: b.code !== undefined ? (b.code || null) : undefined,
    poNumber: b.poNumber !== undefined ? (b.poNumber || null) : undefined,
    customerRefNo: b.customerRefNo !== undefined ? (b.customerRefNo || null) : undefined,
    title: b.title !== undefined ? (b.title || null) : undefined,
    attentionContact: b.attentionContact !== undefined ? (b.attentionContact || null) : undefined,
    description: b.description !== undefined ? (b.description || null) : undefined,
    status: b.status !== undefined ? b.status : undefined,
  } }));
});
router.delete("/sub-projects/:id", requireAdmin, requirePermission("projects"), async (req, res) => {
  try { await prisma.subProject.delete({ where: { id: Number(req.params.id) } }); res.json({ ok: true }); }
  catch { res.status(400).json({ error: "Cannot delete — Sub-Project has forecast lines/invoices attached to it." }); }
});

// People eligible to be a Project Manager — Users with Role.PROJECT_MANAGER, resolved to their
// linked Employee (ProjectManager rows point at Employee, same as EmployeeProject). Gated on the
// "projects" permission (not "users-roles") since this is just a picker for the Project form, not
// user administration.
router.get("/projects/pm-candidates", requireAdmin, requirePermission("projects"), async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { role: "PROJECT_MANAGER", isActive: true, employeeId: { not: null } },
    select: { employeeId: true, employee: { select: { name: true, empNo: true } } },
  });
  res.json(users.filter((u) => u.employeeId != null).map((u) => ({ employeeId: u.employeeId, name: u.employee?.name, empNo: u.employee?.empNo })));
});

// Replaces the full set of PMs on a project in one call — never touches EmployeeProject or
// MonthlyLine (see ProjectManager's own schema comment). Server-side re-validates every id against
// the same PROJECT_MANAGER-role eligibility /pm-candidates enforces, so a direct API call can't
// assign someone who isn't actually a PM even if the client-side picker were bypassed.
router.put("/projects/:id/managers", requireAdmin, requirePermission("projects"), async (req, res) => {
  const projectId = Number(req.params.id);
  const requested: number[] = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds.map(Number) : [];
  const eligible = new Set(
    (await prisma.user.findMany({ where: { role: "PROJECT_MANAGER", isActive: true, employeeId: { not: null } }, select: { employeeId: true } }))
      .map((u) => u.employeeId as number)
  );
  const employeeIds = [...new Set(requested.filter((id) => eligible.has(id)))];
  await prisma.$transaction([
    prisma.projectManager.deleteMany({ where: { projectId } }),
    ...(employeeIds.length ? [prisma.projectManager.createMany({ data: employeeIds.map((employeeId) => ({ projectId, employeeId })) })] : []),
  ]);
  const managers = await prisma.projectManager.findMany({ where: { projectId }, include: { employee: { select: { id: true, name: true, empNo: true } } } });
  res.json({ ok: true, managers });
});
router.post("/projects", requireAdmin, requirePermission("projects"), async (req, res) => {
  const b = req.body;
  const proj = await prisma.project.create({
    data: {
      clientId: Number(b.clientId), name: b.name, code: b.code,
      title: b.title || null, invoiceCode: b.invoiceCode || null, invoiceNoFormat: b.invoiceNoFormat || null, invoiceNameIncludeResource: !!b.invoiceNameIncludeResource, annexureHideLeaveRate: !!b.annexureHideLeaveRate, annexureHideLeave: !!b.annexureHideLeave, annexureHideBillRate: !!b.annexureHideBillRate, annexureHideHours: !!b.annexureHideHours, annexureHideRole: !!b.annexureHideRole, annexureHide: !!b.annexureHide, lineItemsHideHours: !!b.lineItemsHideHours, lineItemsHideRate: !!b.lineItemsHideRate, lineItemsDayBasis: !!b.lineItemsDayBasis, lineItemsPerResource: !!b.lineItemsPerResource, lineItemsSumAll: !!b.lineItemsSumAll, annexureDayBasis: !!b.annexureDayBasis, annexureSumTotal: !!b.annexureSumTotal, lineItemsAddGst: !!b.lineItemsAddGst, gstPercent: b.gstPercent != null ? +b.gstPercent : 5, poNumber: b.poNumber || null, customerRefNo: b.customerRefNo || null, paymentTerms: b.paymentTerms || null, description: b.description || null,
      billingEmail: b.billingEmail || null, ccEmail: b.ccEmail || null, bccEmail: b.bccEmail || null, addressTo: b.addressTo || null,
      attentionContact: b.attentionContact || null, billToAddress: b.billToAddress || null,
      currency: b.currency || "USD", paymentTermsDays: b.paymentTermsDays != null ? Number(b.paymentTermsDays) : 30,
      billingType: b.billingType || "TNM", billingScope: b.billingScope || "RESOURCE",
      deliveryModel: b.deliveryModel || "OFFSHORE", status: b.status || "ACTIVE",
      billingHoursPerDay: b.billingHoursPerDay != null ? Number(b.billingHoursPerDay) : 8,
      startDate: b.startDate ? new Date(b.startDate) : null,
      endDate: b.endDate ? new Date(b.endDate) : null,
      ...(b.invoiceTemplateId ? { invoiceTemplates: { connect: { id: Number(b.invoiceTemplateId) } } } : {}),
      timesheetTemplateId: b.timesheetTemplateId ? Number(b.timesheetTemplateId) : null,
    },
  });
  res.status(201).json(proj);
});
router.put("/projects/:id", requireAdmin, requirePermission("projects"), async (req, res) => {
  const b = req.body;
  res.json(await prisma.project.update({ where: { id: Number(req.params.id) }, data: {
    ...(b.clientId ? { clientId: Number(b.clientId) } : {}),
    name: b.name, billingType: b.billingType, billingScope: b.billingScope,
    deliveryModel: b.deliveryModel, status: b.status,
    currency: b.currency !== undefined ? b.currency : undefined,
    paymentTermsDays: b.paymentTermsDays !== undefined ? Number(b.paymentTermsDays) : undefined,
    code: b.code !== undefined ? (b.code || null) : undefined,
    title: b.title !== undefined ? (b.title || null) : undefined,
    invoiceCode: b.invoiceCode !== undefined ? (b.invoiceCode || null) : undefined,
    invoiceNoFormat: b.invoiceNoFormat !== undefined ? (b.invoiceNoFormat || null) : undefined,
    annexureHideLeaveRate: b.annexureHideLeaveRate !== undefined ? !!b.annexureHideLeaveRate : undefined,
    invoiceNameIncludeResource: b.invoiceNameIncludeResource !== undefined ? !!b.invoiceNameIncludeResource : undefined,
    annexureHideLeave: b.annexureHideLeave !== undefined ? !!b.annexureHideLeave : undefined,
    annexureHideBillRate: b.annexureHideBillRate !== undefined ? !!b.annexureHideBillRate : undefined,
    annexureHideHours: b.annexureHideHours !== undefined ? !!b.annexureHideHours : undefined,
    annexureHideRole: b.annexureHideRole !== undefined ? !!b.annexureHideRole : undefined,
    annexureHide: b.annexureHide !== undefined ? !!b.annexureHide : undefined,
    lineItemsHideHours: b.lineItemsHideHours !== undefined ? !!b.lineItemsHideHours : undefined,
    annexureDayBasis: b.annexureDayBasis !== undefined ? !!b.annexureDayBasis : undefined,
    lineItemsHideRate: b.lineItemsHideRate !== undefined ? !!b.lineItemsHideRate : undefined,
    lineItemsDayBasis: b.lineItemsDayBasis !== undefined ? !!b.lineItemsDayBasis : undefined,
    lineItemsPerResource: b.lineItemsPerResource !== undefined ? !!b.lineItemsPerResource : undefined,
    lineItemsSumAll: b.lineItemsSumAll !== undefined ? !!b.lineItemsSumAll : undefined,
    annexureSumTotal: b.annexureSumTotal !== undefined ? !!b.annexureSumTotal : undefined,
    lineItemsAddGst: b.lineItemsAddGst !== undefined ? !!b.lineItemsAddGst : undefined,
    gstPercent: b.gstPercent !== undefined ? +b.gstPercent : undefined,
    poNumber: b.poNumber !== undefined ? (b.poNumber || null) : undefined,
    customerRefNo: b.customerRefNo !== undefined ? (b.customerRefNo || null) : undefined,
    paymentTerms: b.paymentTerms !== undefined ? (b.paymentTerms || null) : undefined,
    description: b.description !== undefined ? (b.description || null) : undefined,
    billingEmail: b.billingEmail !== undefined ? (b.billingEmail || null) : undefined,
    ccEmail: b.ccEmail !== undefined ? (b.ccEmail || null) : undefined,
    bccEmail: b.bccEmail !== undefined ? (b.bccEmail || null) : undefined,
    addressTo: b.addressTo !== undefined ? (b.addressTo || null) : undefined,
    attentionContact: b.attentionContact !== undefined ? (b.attentionContact || null) : undefined,
    billToAddress: b.billToAddress !== undefined ? (b.billToAddress || null) : undefined,
    ...(b.billingHoursPerDay != null ? { billingHoursPerDay: Number(b.billingHoursPerDay) } : {}),
    ...(b.invoiceTemplateId !== undefined ? { invoiceTemplates: { set: b.invoiceTemplateId ? [{ id: Number(b.invoiceTemplateId) }] : [] } } : {}),
    timesheetTemplateId: b.timesheetTemplateId !== undefined ? (b.timesheetTemplateId ? Number(b.timesheetTemplateId) : null) : undefined,
  } }));
});

router.delete("/projects/:id", requireAdmin, requirePermission("projects"), async (req, res) => {
  try { await prisma.project.delete({ where: { id: Number(req.params.id) } }); res.json({ ok: true }); }
  catch { res.status(400).json({ error: "Cannot delete — project has rates/lines/timesheets." }); }
});

// ---- Supporting documents (MSA/SOW/etc.) — generic Attachment store shared by Clients & Projects ----
// List/upload are scoped per entity ("clients"/"projects" permission — same tier that can edit the
// record itself); list never returns the base64 payload, only /attachments/:id/file does.
function attachmentRoutes(entityType: "CLIENT" | "PROJECT", basePath: string, permissionKey: "clients" | "projects") {
  router.get(`/${basePath}/:id/attachments`, requireAdmin, requirePermission(permissionKey), async (req, res) => {
    const items = await prisma.attachment.findMany({ where: { entityType, entityId: Number(req.params.id) }, orderBy: { uploadedAt: "desc" } });
    res.json(items.map(({ fileData, ...rest }) => rest));
  });
  router.post(`/${basePath}/:id/attachments`, requireAdmin, requirePermission(permissionKey), async (req, res) => {
    const { fileName, fileData, note } = req.body || {};
    if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
    const a = await prisma.attachment.create({ data: { entityType, entityId: Number(req.params.id), fileName, fileData, note: note || null, uploadedById: req.user!.id } });
    const { fileData: _omit, ...rest } = a;
    res.status(201).json(rest);
  });
}
attachmentRoutes("CLIENT", "clients", "clients");
attachmentRoutes("PROJECT", "projects", "projects");

router.get("/attachments/:id/file", requireAdmin, async (req, res) => {
  const a = await prisma.attachment.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: "File not found" });
  const permissionKey = a.entityType === "CLIENT" ? "clients" : "projects";
  if (!(await isAllowed(req.user!.role, permissionKey))) return res.status(403).json({ error: "Forbidden" });
  const ext = (a.fileName || "").split(".").pop()?.toLowerCase();
  const contentType = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : (ext === "jpg" || ext === "jpeg") ? "image/jpeg"
    : ext === "doc" ? "application/msword" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : ext === "xls" ? "application/vnd.ms-excel" : ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename="${a.fileName}"`);
  res.send(Buffer.from(a.fileData, "base64"));
});
router.delete("/attachments/:id", requireAdmin, async (req, res) => {
  const a = await prisma.attachment.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.json({ ok: true });
  const permissionKey = a.entityType === "CLIENT" ? "clients" : "projects";
  if (!(await isAllowed(req.user!.role, permissionKey))) return res.status(403).json({ error: "Forbidden" });
  await prisma.attachment.delete({ where: { id: a.id } });
  res.json({ ok: true });
});

// ---- Billing rates ----
router.get("/billing-rates", requireAdmin, async (_req, res) => {
  res.json(await prisma.billingRate.findMany({ include: { project: true, employee: true }, orderBy: { effectiveFrom: "desc" } }));
});
router.post("/billing-rates", requireAdmin, async (req, res) => {
  const b = req.body;
  const rate = await prisma.billingRate.create({
    data: {
      projectId: Number(b.projectId), employeeId: b.employeeId ? Number(b.employeeId) : null,
      rateUsd: +b.rateUsd, rateBasis: b.rateBasis || "HOURLY",
      standardHoursPerDay: +b.standardHoursPerDay || 8,
      effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : new Date(),
    },
  });
  res.status(201).json(rate);
});

router.put("/billing-rates/:id", requireAdmin, async (req, res) => {
  const b = req.body;
  res.json(await prisma.billingRate.update({ where: { id: Number(req.params.id) }, data: {
    rateUsd: b.rateUsd != null ? +b.rateUsd : undefined, rateBasis: b.rateBasis,
    standardHoursPerDay: b.standardHoursPerDay ? +b.standardHoursPerDay : undefined,
    employeeId: b.employeeId !== undefined ? (b.employeeId ? Number(b.employeeId) : null) : undefined,
  } }));
});
router.delete("/billing-rates/:id", requireAdmin, async (req, res) => {
  await prisma.billingRate.delete({ where: { id: Number(req.params.id) } }); res.json({ ok: true });
});

// ---- FX rates ----
router.get("/fx-rates", requireAdmin, async (_req, res) => res.json(await prisma.fxRate.findMany({ orderBy: { effectiveFrom: "desc" } })));
router.post("/fx-rates", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.fxRate.create({ data: {
    context: b.context || "DEFAULT", baseCcy: b.baseCcy, quoteCcy: b.quoteCcy,
    rate: +b.rate, note: b.note, effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : new Date(),
  } }));
});
router.put("/fx-rates/:id", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  const b = req.body;
  res.json(await prisma.fxRate.update({ where: { id: Number(req.params.id) }, data: {
    context: b.context, baseCcy: b.baseCcy, quoteCcy: b.quoteCcy,
    rate: b.rate != null ? +b.rate : undefined, note: b.note,
  } }));
});
router.delete("/fx-rates/:id", requireAdmin, requirePermission("fx-settings"), async (req, res) => {
  await prisma.fxRate.delete({ where: { id: Number(req.params.id) } }); res.json({ ok: true });
});

export default router;
