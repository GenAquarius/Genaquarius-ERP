// Leave engine — GenAquarius Leave Policy (2026), India. Every rule (entitlement, accrual
// rate, carry-forward cap, consecutive-day cap, sandwich rule, probation length, comp-off
// expiry, EL encashment) is DATA (HrLeaveType / HrLeavePolicyConfig rows) — this file only
// implements the arithmetic, never a hard-coded quota. Mirrors the engine/hr.ts pattern.
import { prisma } from "../prisma";
import { buFirst, buRows, getHrSignature } from "./hr";
import { FnfPdfData, FnfLineItem } from "./hrPdf";

const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnly = (d: Date | string) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Default policy config for a country (or a Business Unit's own override, if one exists —
 * falls back to the country default otherwise), materialized on first read (upsert-on-read,
 * like other HR config). The country-default row itself is always businessUnitId: null. */
export async function getPolicyConfig(countryCode = "INDIA", businessUnitId?: number | null) {
  const existing = await buFirst(businessUnitId, (bu) => prisma.hrLeavePolicyConfig.findFirst({ where: { countryCode, ...bu } }));
  if (existing) return existing;
  return prisma.hrLeavePolicyConfig.create({ data: { countryCode } });
}

/** The date an employee becomes eligible to accrue probation-gated leave types. */
export function probationCompleteDate(joiningDate: Date | null, probationDays: number): Date | null {
  if (!joiningDate) return null;
  const d = new Date(joiningDate);
  d.setDate(d.getDate() + probationDays);
  return d;
}

export function isProbationComplete(joiningDate: Date | null, probationDays: number, asOf = new Date()): boolean {
  const pc = probationCompleteDate(joiningDate, probationDays);
  return !pc || pc <= asOf;
}

/**
 * Day count for a leave request, applying the Fri+Mon sandwich rule when enabled for this
 * leave type: normal days = weekdays (Mon-Fri) in the range; if a Friday in the range is
 * followed by a Monday also in the range, Sat+Sun are added too (so a Fri..Mon request
 * deducts 4 days total, not 2).
 */
export function computeLeaveDays(fromDate: Date, toDate: Date, sandwichEnabled: boolean) {
  const from = dateOnly(fromDate), to = dateOnly(toDate);
  if (to < from) throw new Error("To Date cannot be before From Date");
  const days: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) days.push(new Date(t));
  const isWeekday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;
  const baseDays = days.filter(isWeekday).length;
  let sandwichDeducted = 0;
  if (sandwichEnabled) {
    for (const d of days) {
      if (d.getDay() === 5) { // Friday
        const followingMonday = new Date(d.getTime() + 3 * DAY_MS);
        if (followingMonday.getTime() <= to.getTime()) sandwichDeducted += 2; // Sat + Sun
      }
    }
  }
  return { baseDays, sandwichDeducted, totalDays: baseDays + sandwichDeducted, calendarDays: days.length };
}

/** Completed calendar months between two dates (partial months don't count), capped at 0..12. */
function completedMonthsBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1; // partial final month doesn't count
  return Math.max(0, Math.min(12, months));
}

/**
 * Recompute (upsert) the accrued balance for one employee/leave-type/year from first
 * principles — safe to call repeatedly (e.g. every time a balance is viewed or a leave is
 * applied), never double-accrues. Accrual-based types (accrualPerMonth > 0, e.g. Earned
 * Leave) accrue per completed month of service since the later of (Jan 1 of `year`, joining
 * date, probation-complete date). Flat-entitlement types (annualQuota, e.g. General,
 * Bereavement, Birthday, Marriage Anniversary, Floating/Restricted) are granted in full as
 * soon as the leave year starts. Comp-Off is NOT synced here — its balance lives in
 * CompOffCredit (earn-on-approval + 30-day expiry), not a flat/accrual formula.
 */
export async function syncLeaveBalance(employeeId: number, leaveType: { id: number; key: string; accrualPerMonth: number; annualQuota: number | null; requiresProbationComplete: boolean }, year: number, asOf = new Date()) {
  if (leaveType.key === "COMP_OFF") return prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } } });

  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { joiningDate: true, location: true, businessUnitId: true } });
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);
  const cappedAsOf = asOf > yearEnd ? yearEnd : asOf;

  let accrued = 0;
  if (leaveType.accrualPerMonth > 0) {
    const policy = await getPolicyConfig(employee?.location || "INDIA", employee?.businessUnitId);
    let eligibleFrom = employee?.joiningDate && employee.joiningDate > yearStart ? employee.joiningDate : yearStart;
    if (leaveType.requiresProbationComplete) {
      const pc = probationCompleteDate(employee?.joiningDate || null, policy.probationDays);
      if (pc && pc > eligibleFrom) eligibleFrom = pc;
    }
    accrued = round2(completedMonthsBetween(eligibleFrom, cappedAsOf) * leaveType.accrualPerMonth);
  } else if (leaveType.annualQuota != null) {
    // Flat entitlement — available in full once the leave year has started for this employee.
    accrued = cappedAsOf >= yearStart ? leaveType.annualQuota : 0;
  }

  return prisma.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } },
    update: { accrued },
    create: { employeeId, leaveTypeId: leaveType.id, year, accrued },
  });
}

/** Sync + return every leave-type balance for an employee's country for a given year. */
export async function getLeaveBalances(employeeId: number, year: number) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error("Employee not found");
  const countryCode = employee.location || "INDIA";
  const types = await buRows(employee.businessUnitId, (bu) => prisma.hrLeaveType.findMany({ where: { countryCode, ...bu }, orderBy: { order: "asc" } }));
  const out: any[] = [];
  for (const t of types) {
    if (t.key === "COMP_OFF") {
      const avail = await compOffAvailable(employeeId);
      out.push({ leaveType: t, year, accrued: avail.totalCredited, used: avail.totalConsumed, carriedIn: 0, available: avail.available, expiringSoon: avail.expiringSoon });
      continue;
    }
    if (t.key === "PUBLIC_HOLIDAY") { out.push({ leaveType: t, year, accrued: t.annualQuota || 0, used: 0, carriedIn: 0, available: t.annualQuota || 0, informational: true }); continue; }
    const bal = await syncLeaveBalance(employeeId, t, year);
    const available = round2((bal?.carriedIn || 0) + (bal?.accrued || 0) - (bal?.used || 0));
    out.push({ leaveType: t, year, accrued: bal?.accrued || 0, used: bal?.used || 0, carriedIn: bal?.carriedIn || 0, available });
  }
  return out;
}

function compOffExpiresAt(creditedAt: Date, expiryDays: number) {
  const d = new Date(creditedAt);
  d.setDate(d.getDate() + expiryDays);
  return d;
}

/** Credit comp-off days (earned by working a holiday/weekend) — HR/admin grants on approval. */
export async function creditCompOff(employeeId: number, days: number, grantedById?: number, note?: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error("Employee not found");
  const policy = await getPolicyConfig(employee.location || "INDIA", employee.businessUnitId);
  const creditedAt = new Date();
  const credit = await prisma.compOffCredit.create({
    data: { employeeId, days, creditedAt, expiresAt: compOffExpiresAt(creditedAt, policy.compOffExpiryDays), grantedById, note },
  });
  // Mirror into LeaveBalance for reporting consistency with other leave types.
  const type = await buFirst(employee.businessUnitId, (bu) => prisma.hrLeaveType.findFirst({ where: { countryCode: employee.location || "INDIA", key: "COMP_OFF", ...bu } }));
  if (type) {
    const year = creditedAt.getFullYear();
    await prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: type.id, year } },
      update: { accrued: { increment: days } },
      create: { employeeId, leaveTypeId: type.id, year, accrued: days },
    });
  }
  return credit;
}

/** Available (non-expired, non-consumed) comp-off balance, FIFO by expiry. */
export async function compOffAvailable(employeeId: number, asOf = new Date()) {
  const credits = await prisma.compOffCredit.findMany({ where: { employeeId }, orderBy: { expiresAt: "asc" } });
  let available = 0, totalCredited = 0, totalConsumed = 0, expiringSoon = 0;
  const soon = new Date(asOf.getTime() + 7 * DAY_MS);
  for (const c of credits) {
    totalCredited += c.days;
    totalConsumed += c.consumedDays;
    const remaining = c.days - c.consumedDays;
    if (remaining > 0 && c.expiresAt >= asOf) {
      available += remaining;
      if (c.expiresAt <= soon) expiringSoon += remaining;
    }
  }
  return { available: round2(available), totalCredited: round2(totalCredited), totalConsumed: round2(totalConsumed), expiringSoon: round2(expiringSoon), credits };
}

/** Consume comp-off credits FIFO by expiry (oldest-expiring first). Throws if insufficient. */
async function consumeCompOff(employeeId: number, days: number) {
  const { available, credits } = await compOffAvailable(employeeId);
  if (days > available) throw new Error(`Insufficient Comp-Off balance: ${available} day(s) available, ${days} requested.`);
  let remaining = days;
  for (const c of credits) {
    if (remaining <= 0) break;
    const avail = c.days - c.consumedDays;
    if (c.expiresAt < new Date() || avail <= 0) continue;
    const take = Math.min(avail, remaining);
    await prisma.compOffCredit.update({ where: { id: c.id }, data: { consumedDays: { increment: take } } });
    remaining -= take;
  }
}

export interface LeaveValidation {
  totalDays: number;
  baseDays: number;
  sandwichDeducted: number;
  available: number | null; // null for types with no tracked balance
  warnings: string[];
}

/** Validate a leave application against the policy + live balance. Throws on hard blocks. */
export async function validateLeaveRequest(employeeId: number, leaveTypeId: number, fromDate: Date, toDate: Date): Promise<LeaveValidation> {
  const leaveType = await prisma.hrLeaveType.findUnique({ where: { id: leaveTypeId } });
  if (!leaveType) throw new Error("Leave type not found");
  if (leaveType.key === "PUBLIC_HOLIDAY") throw new Error("Public Holiday is calendar-driven — it isn't applied for.");

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error("Employee not found");
  const policy = await getPolicyConfig(employee.location || leaveType.countryCode || "INDIA", employee.businessUnitId);

  const sandwichEnabled = leaveType.sandwichEligible && policy.sandwichEnabled;
  const { baseDays, sandwichDeducted, totalDays } = computeLeaveDays(fromDate, toDate, sandwichEnabled);
  const warnings: string[] = [];

  // Consecutive-day cap (e.g. General Leave: max 3) is measured on the calendar span requested.
  const calendarSpanDays = Math.round((dateOnly(toDate).getTime() - dateOnly(fromDate).getTime()) / DAY_MS) + 1;
  if (leaveType.maxConsecutiveDays != null && calendarSpanDays > leaveType.maxConsecutiveDays)
    throw new Error(`${leaveType.name} cannot be applied for more than ${leaveType.maxConsecutiveDays} consecutive days in a single request.`);

  if (leaveType.requiresProbationComplete && !isProbationComplete(employee.joiningDate, policy.probationDays, fromDate))
    throw new Error(`${leaveType.name} is not available until probation is complete (${policy.probationDays} days from joining).`);

  if (leaveType.key === "EARNED") {
    const workingDaysNotice = Math.round((dateOnly(fromDate).getTime() - dateOnly(new Date()).getTime()) / DAY_MS);
    if (workingDaysNotice < 5) warnings.push("Earned Leave should be applied at least 5 working days in advance, except for a genuine emergency.");
  }
  if ((leaveType.key === "BIRTHDAY" && employee.dateOfBirth && employee.dateOfBirth.getMonth() !== fromDate.getMonth()) ||
      (leaveType.key === "MARRIAGE_ANNIVERSARY" && employee.marriageAnniversary && employee.marriageAnniversary.getMonth() !== fromDate.getMonth())) {
    warnings.push(`${leaveType.name} is usually taken in the employee's ${leaveType.key === "BIRTHDAY" ? "birthday" : "anniversary"} month.`);
  }

  let available: number | null = null;
  if (leaveType.key === "COMP_OFF") {
    available = (await compOffAvailable(employeeId, fromDate)).available;
    if (totalDays > available) throw new Error(`Insufficient Comp-Off balance: ${available} day(s) available, ${totalDays} requested.`);
  } else {
    const bal = await syncLeaveBalance(employeeId, leaveType, fromDate.getFullYear());
    available = round2((bal?.carriedIn || 0) + (bal?.accrued || 0) - (bal?.used || 0));
    if (totalDays > available)
      throw new Error(`Insufficient ${leaveType.name} balance: ${available} day(s) available, ${totalDays} requested (including any sandwich-rule days). Apply for Leave Without Pay separately via HR if needed.`);
  }

  return { totalDays, baseDays, sandwichDeducted, available, warnings };
}

/** Create a PENDING leave request after validating it against policy + balance. */
export async function createLeaveRequest(employeeId: number, leaveTypeId: number, fromDate: Date, toDate: Date, reason?: string) {
  const v = await validateLeaveRequest(employeeId, leaveTypeId, fromDate, toDate);
  const request = await prisma.leaveRequest.create({
    data: { employeeId, leaveTypeId, fromDate, toDate, days: v.totalDays, sandwichDeducted: v.sandwichDeducted, reason: reason || null },
  });
  return { request, warnings: v.warnings };
}

/** Approve a leave request — deducts the balance (or consumes Comp-Off credits FIFO). */
export async function approveLeaveRequest(requestId: number, approverId: number) {
  const request = await prisma.leaveRequest.findUnique({ where: { id: requestId }, include: { leaveType: true } });
  if (!request) throw new Error("Leave request not found");
  if (request.status !== "PENDING") throw new Error(`Request is already ${request.status}`);

  if (request.leaveType.key === "COMP_OFF") {
    await consumeCompOff(request.employeeId, request.days);
  } else {
    const year = request.fromDate.getFullYear();
    await syncLeaveBalance(request.employeeId, request.leaveType, year); // ensure row exists/current before deducting
    await prisma.leaveBalance.update({
      where: { employeeId_leaveTypeId_year: { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year } },
      data: { used: { increment: request.days } },
    });
  }
  return prisma.leaveRequest.update({ where: { id: requestId }, data: { status: "APPROVED", approvedById: approverId, approvedAt: new Date() } });
}

export async function rejectLeaveRequest(requestId: number, approverId: number) {
  const request = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error("Leave request not found");
  if (request.status !== "PENDING") throw new Error(`Request is already ${request.status}`);
  return prisma.leaveRequest.update({ where: { id: requestId }, data: { status: "REJECTED", approvedById: approverId, approvedAt: new Date() } });
}

export async function cancelLeaveRequest(requestId: number, employeeId: number) {
  const request = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error("Leave request not found");
  if (request.employeeId !== employeeId) throw new Error("Not your leave request");
  if (request.status !== "PENDING") throw new Error("Only a pending request can be cancelled");
  return prisma.leaveRequest.update({ where: { id: requestId }, data: { status: "CANCELLED" } });
}

/**
 * Year-end rollover for Earned Leave: carries forward min(available, maxCarryForward) into
 * next year's opening balance, and returns the excess (which would otherwise lapse) so HR
 * can encash it at elEncashmentRatePerDay. Manually triggered from HR Settings — this repo
 * has no cron infra beyond the daily audit-log rotation, so a scheduled run is out of scope
 * for this pass (documented, not silently skipped).
 */
export async function runYearEndRollover(year: number, countryCode = "INDIA") {
  // Country-default policy/leave-type only — this admin-triggered, whole-country rollover doesn't
  // vary per Business Unit (a future pass could run it once per BU if that's ever needed).
  const policy = await getPolicyConfig(countryCode);
  const elType = await prisma.hrLeaveType.findFirst({ where: { countryCode, key: "EARNED", businessUnitId: null } });
  if (!elType) return { processed: 0, results: [] };
  const balances = await prisma.leaveBalance.findMany({ where: { leaveTypeId: elType.id, year } });
  const results: any[] = [];
  for (const b of balances) {
    const available = round2(b.carriedIn + b.accrued - b.used);
    const carryForward = Math.min(available, elType.maxCarryForward ?? policy.elEncashmentCapDays);
    const encashDays = Math.max(0, round2(available - carryForward));
    const encashAmount = round2(encashDays * policy.elEncashmentRatePerDay);
    await prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId: b.employeeId, leaveTypeId: elType.id, year: year + 1 } },
      update: { carriedIn: carryForward },
      create: { employeeId: b.employeeId, leaveTypeId: elType.id, year: year + 1, carriedIn: carryForward, accrued: 0, used: 0 },
    });
    results.push({ employeeId: b.employeeId, available, carryForward, encashDays, encashAmount });
  }
  return { processed: results.length, results };
}

/** Suggested FnF (Full & Final) inputs for a full-time employee's termination: EL encashment off
 * the live leave balance, priced at plain BASIC ÷ actual calendar days in the FnF (termination)
 * month × days available — NOT the HR-settings flat elEncashmentRatePerDay (that flat rate is only
 * for the separate year-end rollover encashment, runYearEndRollover, above); notice pay per
 * requiredNoticeDays/servedNoticeDays ALSO priced off plain BASIC salary alone (`basicOnly` — the
 * CTC record's `basic` field, NOT Full Pay); and days-worked-this-month salary priced off "Full
 * Pay" (Basic + HRA + Special/Other Allowance, the fixed CTC bracket components — see
 * routes/shared/masters.ts's fullPayFor(), which is what callers should pass in as `basicSalary`
 * here despite the parameter's name — kept as-is to avoid an unrelated rename). Conveyance/
 * Communication/Meals/Books/Driver/Uniform are reimbursements and never enter any of these calcs.
 * EL Encashment and Notice Pay are priced off Basic; Days-Worked-Salary off Full Pay — deliberately
 * different figures per explicit business rule; do not collapse them back to one. HR sees these as
 * editable defaults on the termination request; Finance can override them again at approval.
 * Contractor termination uses billing/invoice proration (deploymentEndDate) instead — this has no
 * bearing there. */
export async function computeFnfSuggestion(
  employeeId: number, exitDate: Date, basicSalary: number,
  requiredNoticeDays?: number | null, servedNoticeDays?: number | null,
  payFullNoticePeriod?: boolean, basicOnly?: number, reimbursementAmount?: number,
) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error("Employee not found");
  const year = exitDate.getFullYear();
  const balances = await getLeaveBalances(employeeId, year);
  const el = balances.find((b) => b.leaveType.key === "EARNED");
  const elEncashmentDays = Math.max(0, round2(el?.available || 0));
  // Priced off plain Basic (basicOnly) — same basis as Notice Pay below, NOT Full Pay — divided by
  // the actual number of calendar days in the FnF month (the termination/exit month), not the
  // policy's flat per-day rate or a hardcoded 30. Falls back to basicSalary only if a caller
  // doesn't pass basicOnly. elEncashmentRatePerDay here is this EFFECTIVE per-day rate (for the
  // client's own "edit EL Days → recompute EL Amount" convenience) — the year-end rollover's own
  // encashment (runYearEndRollover, above) is unrelated and still uses policy.elEncashmentRatePerDay.
  const noticeBasis = basicOnly != null ? basicOnly : basicSalary;
  const daysInFnfMonth = new Date(exitDate.getFullYear(), exitDate.getMonth() + 1, 0).getDate();
  const elEncashmentRatePerDay = daysInFnfMonth ? round2(noticeBasis / daysInFnfMonth) : 0;
  const elEncashmentAmount = round2(elEncashmentDays * elEncashmentRatePerDay);
  // Default: Notice Pay is compensation for the notice period actually SERVED (Basic/30 × served
  // days) — not a shortfall buyout. payFullNoticePeriod is "Notice Served Waiver": the company
  // waives the requirement that notice actually be served and pays out the FULL required notice
  // period instead (Basic/30 × required days), regardless of how many days were actually served.
  const noticePayDays = payFullNoticePeriod ? (requiredNoticeDays || 0) : (servedNoticeDays || 0);
  const noticePayAmount = round2((noticeBasis / 30) * noticePayDays);
  // Salary already earned this month, up to and including the termination date (e.g. terminating
  // on the 4th pays Full Pay/30 × 4 days, at the employee's normal undiscounted daily rate) — folds
  // into FnF alongside EL/notice-pay/reimbursement.
  // exitDate.getDate() alone only works when the employee had already been employed since the 1st
  // of that month — someone who JOINED that same month (an employee terminated the same month, or
  // even the same day, they joined — a real case: HR activates then immediately has to reverse a
  // bad hire) would otherwise be paid as if they'd worked the whole month up to the exit date,
  // wildly overcounting (joining and exiting on the 29th once showed ~29 days' pay for 1 actual
  // day worked). Clip to days-since-joining when joining falls in the same calendar month.
  const joiningDate = employee.joiningDate;
  const sameMonthJoin = !!joiningDate && joiningDate.getFullYear() === exitDate.getFullYear() && joiningDate.getMonth() === exitDate.getMonth();
  // Joined and terminated on the EXACT same calendar day (e.g. HR activates then immediately has
  // to reverse a same-day bad hire): zero days worked, not one — explicit per business rule, since
  // the inclusive day-count below (which correctly counts both endpoints as worked for any other
  // span) would otherwise floor at 1 for this specific case.
  const sameDay = sameMonthJoin && joiningDate!.getDate() === exitDate.getDate();
  const daysWorkedInMonth = sameDay ? 0 : sameMonthJoin ? Math.max(1, exitDate.getDate() - joiningDate!.getDate() + 1) : exitDate.getDate();
  const daysWorkedSalary = round2(((basicSalary || 0) / 30) * daysWorkedInMonth);
  // Other Flexi Benefits has no clean auto-source (LTA/medical/special-allowance payout varies by
  // policy) — always starts at 0, purely Finance-entered. TDS is a rough 9.9% estimate on the FULL
  // Gross Total Income (Full Salary + Basic/Notice Pay + Leave Encashment + Other Flexi Benefits +
  // Reimbursement — matching the reference FnF Settlement template's "Gross Total Income" exactly),
  // shown as an editable starting point only — actual tax liability is Finance's own determination,
  // never computed as law here (same spirit as the Finance Dashboard's own simplified "26% of 15%"
  // tax approximation elsewhere in this app). reimbursementAmount is Finance-entered on the form
  // itself (not computed by this suggestion engine), so callers pass whatever's currently on screen.
  const otherFlexiBenefitsAmount = 0;
  const grossTotalIncome = round2(daysWorkedSalary + noticePayAmount + elEncashmentAmount + otherFlexiBenefitsAmount + (reimbursementAmount || 0));
  const tdsAmount = round2(grossTotalIncome * 0.099);
  return { elEncashmentDays, elEncashmentRatePerDay, elEncashmentAmount, noticePayDays, noticePayAmount, noticeBasis, daysWorkedInMonth, daysWorkedSalary, otherFlexiBenefitsAmount, tdsAmount };
}

// Turns an APPROVED TerminationApprovalRequest row (with its `employee` relation selected —
// name/empNo/designation/department/empType/joiningDate/businessUnitId) into the data the FNF
// settlement PDF needs. Shared by routes/terminationApprovals.ts's own PDF route and
// routes/masters.ts's employee-lifecycle PDF route (kept here, not in either route file, so
// neither has to import the other and create a circular require).
export async function buildFnfPdfData(reqRow: any): Promise<FnfPdfData> {
  const emp = reqRow.employee;
  const isFullTime = emp?.empType === "FULL_TIME";
  // A contractor's finalFnfAmount is stored in USD (Monthly Forecast's own canonical currency,
  // same as the termination form's FNF Amount field) — converted to INR here to match the
  // reference FnF Settlement template's own ₹/INR display, same as full-time's basicCurrency.
  const fx = !isFullTime ? await prisma.fxRate.findFirst({ where: { context: "USD_INR" }, orderBy: { effectiveFrom: "desc" } }) : null;
  const fxRate = fx?.rate || 93;
  const currency = isFullTime ? (reqRow.basicCurrency || "USD") : "INR";
  const exitDate = new Date(reqRow.exitDate);
  // Day-count reference for what PRINTS as "Last Day of Working"/"No. of Days Worked" — display
  // only, never feeds back into daysWorkedSalary/EL/notice-pay math (those stay driven by the
  // already-computed/stored dollar amounts above regardless of what's chosen here). Priority:
  // 1) fnfPrintDate, an explicit HR/Finance override (either employment type). 2) For a
  // contractor/vendor, Deployment End Date — their actual last BILLABLE day, which is what the
  // printed day-count should reflect by default, not the administrative Termination Date. 3) The
  // Termination Date itself, same as before this field existed (full-time's unconditional default).
  const lastWorkingDate = reqRow.fnfPrintDate ? new Date(reqRow.fnfPrintDate)
    : (!isFullTime && reqRow.deploymentEndDate) ? new Date(reqRow.deploymentEndDate)
    : exitDate;
  const joiningDate = emp?.joiningDate ? new Date(emp.joiningDate) : null;
  const sameMonthRef = !!joiningDate && joiningDate.getFullYear() === lastWorkingDate.getFullYear() && joiningDate.getMonth() === lastWorkingDate.getMonth();
  const sameDay = sameMonthRef && joiningDate!.getDate() === lastWorkingDate.getDate();
  // payableDaysOverride bypasses the date-based count entirely — same number the Salary-for-Days-
  // Worked dollar amount was computed from (client-side, before this request was ever saved), so
  // the printed count and the money always agree even though "Last Day of Working" above doesn't
  // move to match it.
  const daysWorkedInMonth = reqRow.payableDaysOverride != null ? reqRow.payableDaysOverride
    : sameDay ? 0 : sameMonthRef ? Math.max(1, lastWorkingDate.getDate() - joiningDate!.getDate() + 1) : lastWorkingDate.getDate();
  // Earned/Deductions split and exact field set/labels match the reference FnF Settlement template
  // (Full Salary (N Days) / Basic (N Days) / Leave Encashment / Other Flexi Benefits / Gross Total
  // Income / TDS / Gross Total Deduction / Grand Total) — Reimbursement has no line of its own there,
  // so it's folded into Other Flexi Benefits (summed) rather than shown separately.
  const lineItems: FnfLineItem[] = [];
  const deductionItems: FnfLineItem[] = [];
  if (isFullTime) {
    if (reqRow.daysWorkedSalary) lineItems.push({ label: `Full Salary (${daysWorkedInMonth} Day${daysWorkedInMonth === 1 ? "" : "s"})`, amount: reqRow.daysWorkedSalary });
    if (reqRow.noticePayAmount) {
      const noticeDaysUsed = reqRow.payFullNoticePeriod ? (reqRow.requiredNoticeDays || 0) : (reqRow.servedNoticeDays || 0);
      lineItems.push({ label: `Basic (${noticeDaysUsed} Day${noticeDaysUsed === 1 ? "" : "s"})`, amount: reqRow.noticePayAmount });
    }
    if (reqRow.elEncashmentAmount) {
      const elDays = reqRow.elEncashmentDays || 0;
      lineItems.push({ label: `Leave Encashment (${elDays} Day${elDays === 1 ? "" : "s"})`, amount: reqRow.elEncashmentAmount });
    }
    const otherFlexiCombined = round2((reqRow.otherFlexiBenefitsAmount || 0) + (reqRow.reimbursementAmount || 0));
    if (otherFlexiCombined) lineItems.push({ label: "Other Flexi Benefits", amount: otherFlexiCombined });
    if (reqRow.tdsAmount) deductionItems.push({ label: "TDS", amount: reqRow.tdsAmount });
  } else {
    // Contractor FnF, matching the reference FnF Settlement template's own Gross Payable Amount /
    // GST@18% / TDS@10% breakdown exactly: GST is added ON TOP of the settlement (contractors
    // invoice with GST, unlike an employee's salary), while TDS is deducted off the Gross Payable
    // Amount ALONE — never off the GST-inclusive Gross Total Income, since GST is a pass-through
    // tax collected for the government, not taxable income. GST is optional (not every contractor
    // is GST-registered) and its amount is Finance-overridable — see includeGst/gstAmount's own
    // schema comment.
    const grossPayable = round2((reqRow.finalFnfAmount || 0) * fxRate);
    // Previous-month unpaid amount, carried into THIS settlement — when set, splits the single
    // "Gross Payable Amount" line into an Arrear line + a This-Month line, and GST/TDS are both
    // computed on the COMBINED total (the whole amount actually being paid out now), not This
    // Month alone.
    const arrear = round2(reqRow.arrearAmount || 0);
    const combinedGross = round2(grossPayable + arrear);
    const includeGst = reqRow.includeGst !== false;
    const gst = includeGst ? round2(reqRow.gstAmount != null ? reqRow.gstAmount : combinedGross * 0.18) : 0;
    const tds = round2(combinedGross * 0.1);
    if (arrear) {
      lineItems.push({ label: "Gross Payable Amount (Arrear - Previous Month)", amount: arrear });
      lineItems.push({ label: "Gross Payable Amount (This Month)", amount: grossPayable });
    } else {
      lineItems.push({ label: "Gross Payable Amount", amount: grossPayable });
    }
    if (includeGst) lineItems.push({ label: "GST@18%", amount: gst });
    deductionItems.push({ label: "TDS @ 10%", amount: tds });
  }
  const grossEarned = round2(lineItems.reduce((s, li) => s + (li.amount || 0), 0));
  const grossDeduction = round2(deductionItems.reduce((s, li) => s + (li.amount || 0), 0));
  const totalAmount = round2(grossEarned - grossDeduction);
  const reviewer = reqRow.reviewedById ? await prisma.user.findUnique({ where: { id: reqRow.reviewedById }, select: { name: true } }) : null;
  return {
    ...(await getHrSignature(emp?.businessUnitId)),
    employeeName: emp?.name || "", empNo: emp?.empNo, designation: emp?.designation, department: emp?.department, phone: emp?.phone,
    empType: emp?.empType || "", joiningDate: emp?.joiningDate, resignationDate: reqRow.resignationDate,
    deploymentEndDate: reqRow.deploymentEndDate, exitDate: reqRow.exitDate, fnfFinalizationDate: reqRow.fnfFinalizationDate,
    requiredNoticeDays: reqRow.requiredNoticeDays, servedNoticeDays: reqRow.servedNoticeDays, daysWorkedInMonth,
    lastWorkingDate, leavesCount: reqRow.leavesCount,
    currency, lineItems, deductionItems, grossEarned, grossDeduction, totalAmount,
    // The reference FnF Settlement template's own body deliberately omits an FNF Finalization Date
    // row (see renderFnfPdf's kvRows comment) — the top-right "Date:" field is the ONLY place a
    // date other than "Last Day of Working" prints, so it must BE the FNF Finalization Date, not
    // today's date (the document is dated as of settlement, not as of whenever it's re-previewed).
    note: reqRow.fnfNote, reviewedByName: reviewer?.name || null, generatedAt: reqRow.fnfFinalizationDate || new Date(),
  };
}
