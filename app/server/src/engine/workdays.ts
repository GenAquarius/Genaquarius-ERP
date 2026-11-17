// Working-day / holiday math shared by the monthly sheet (clone + apply-future) and the
// holiday calendar (recompute existing rows when a holiday changes).
import { prisma } from "../prisma";
import { buRows } from "./hr";

const MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

export function fyStart(label: string): number {
  const m = /FY(\d{2})/i.exec(label || "");
  return m ? 2000 + Number(m[1]) : new Date().getUTCFullYear();
}
export function calOf(fiscalYear: string, monthIndex: number) {
  const sy = fyStart(fiscalYear);
  const calMonth = ((monthIndex - 1 + 3) % 12) + 1; // Apr(1)→4 … Mar(12)→3
  return { year: monthIndex <= 9 ? sy : sy + 1, month0: calMonth - 1 };
}
// Map a calendar date → its fiscal year label, month index (Apr=1) and month name.
export function fiscalOfDate(date: Date) {
  const cm = date.getUTCMonth() + 1, cy = date.getUTCFullYear();
  const monthIndex = cm >= 4 ? cm - 3 : cm + 9;
  const startYear = cm >= 4 ? cy : cy - 1;
  const fiscalYear = `FY${String(startYear % 100).padStart(2, "0")}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  return { fiscalYear, monthIndex, month: MONTHS[monthIndex - 1] };
}

// Deployment window → how much of a fiscal month a resource is deployed, by calendar days
// (1 = whole month, 0 = not deployed that month at all). Both dates inclusive; null = open.
export function deployedFraction(fiscalYear: string, monthIndex: number, start?: Date | string | null, end?: Date | string | null) {
  const { year, month0 } = calOf(fiscalYear, monthIndex);
  const dim = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const first = Math.floor(Date.UTC(year, month0, 1) / 86400000), last = first + dim - 1;
  const num = (d: any) => { if (!d) return null; const x = new Date(d); return isNaN(+x) ? null : Math.floor(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 86400000); };
  const s = num(start), e = num(end);
  const from = Math.max(first, s ?? first), to = Math.min(last, e ?? last);
  const days = Math.max(0, to - from + 1);
  return { fraction: days / dim, days, dim };
}
// The earlier of a line's deployment end and the employee's exit date (either may be null).
export function effectiveEnd(deploymentEnd?: Date | string | null, exitDate?: Date | string | null): Date | null {
  const a = deploymentEnd ? new Date(deploymentEnd) : null, b = exitDate ? new Date(exitDate) : null;
  if (a && b) return a < b ? a : b;
  return a || b;
}
// Rescale a resource line to a deployment window. `hoursFrom` / `costFrom` say what fraction of a
// month the line's hours/revenue and base cost currently represent (1 = a full month); `to` is the
// target fraction. Add-ons (bonus, double-dip incentive) are flat and are not scaled.
export function scaleToWindow<T extends Record<string, any>>(line: T, opts: { hoursFrom: number; costFrom: number; to: number }): T {
  const { hoursFrom, costFrom, to } = opts;
  if (hoursFrom === to && costFrom === to) return line;
  const h = hoursFrom > 0 ? to / hoursFrom : 0, c = costFrom > 0 ? to / costFrom : 0;
  const addOns = (line.bonus || 0) + (line.doubleDipIncentive || 0);
  const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
  return { ...line,
    estimateHours: r2((line.estimateHours || 0) * h), actualHours: r2((line.actualHours || 0) * h),
    billingAmount: r2((line.billingAmount || 0) * h), invoiceAmount: r2((line.invoiceAmount || 0) * h),
    costUsd: r2(((line.costUsd || 0) - addOns) * c + addOns) };
}

// Forecast leave buffer: subtract this many days per month for expected employee leave,
// on top of weekends + public holidays.
export const FORECAST_LEAVE_DAYS = 1;

// Net billable working days = weekdays (Mon–Fri) − that country's (or Business Unit's own
// override calendar's) weekday public holidays − a forecast leave buffer (1 day). UTC-based
// to avoid timezone drift. `businessUnitId`: if that BU has its own holiday rows for this
// country+month, they're used instead of the Country-default calendar (buRows() fallback —
// same rule every other BU-scoped category in this codebase follows).
export async function workingDaysInMonth(fiscalYear: string, monthIndex: number, country: string | null, businessUnitId?: number | null, cache?: Map<string, number>): Promise<number> {
  const key = `${fiscalYear}:${monthIndex}:${country || ""}:${businessUnitId ?? ""}`;
  if (cache?.has(key)) return cache.get(key)!;
  const { year, month0 } = calOf(fiscalYear, monthIndex);
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  let wd = 0;
  for (let d = 1; d <= days; d++) { const dow = new Date(Date.UTC(year, month0, d)).getUTCDay(); if (dow !== 0 && dow !== 6) wd++; }
  if (country) {
    const start = new Date(Date.UTC(year, month0, 1)), end = new Date(Date.UTC(year, month0 + 1, 1));
    const cc = country.toUpperCase();
    const hols = await buRows(businessUnitId, (bu) => prisma.holiday.findMany({ where: { country: cc, date: { gte: start, lt: end }, ...bu } }));
    for (const h of hols) { const dow = new Date(h.date).getUTCDay(); if (dow !== 0 && dow !== 6) wd--; }
  }
  const out = Math.max(0, wd - FORECAST_LEAVE_DAYS); // forecast leave allowance
  cache?.set(key, out);
  return out;
}

// Derive a billable resource line's stored values for a given month's working days.
//  • HOURLY / DAILY → the per-hour rate is the fixed anchor; hours scale with working
//    days, so revenue varies month-to-month (more billable days = more revenue).
//  • MONTHLY → the monthly amount is the fixed anchor; hours still follow working days
//    but the rate flexes so revenue stays constant every month.
// (DAILY is stored as an hourly rate = dayRate ÷ hrs/day, so it behaves like HOURLY here.)
export function deriveBillable(opts: { mode: string; rateUsd: number; monthlyAmount: number; workingDays: number; hpd: number; fx: number; }) {
  const { mode, rateUsd, monthlyAmount, workingDays, hpd, fx } = opts;
  const hours = workingDays * hpd;
  if (mode === "MONTHLY") {
    const rate = hours ? monthlyAmount / hours : 0;
    return { rateUsd: rate, estimateHours: hours, actualHours: hours, billingAmount: monthlyAmount, invoiceAmount: monthlyAmount };
  }
  const amt = rateUsd * hours * fx;
  return { rateUsd, estimateHours: hours, actualHours: hours, billingAmount: amt, invoiceAmount: amt };
}

// Recompute Estimate/Actual hours + billing/invoice for billable resource lines of ONE
// country in ONE fiscal month (used when a holiday is added/edited/deleted, regardless of
// whether that holiday was a Country default or a specific Business Unit's own override —
// every line picks up ITS OWN employee's effective calendar via workingDaysInMonth()'s BU
// fallback, so recomputing the whole country is always correct no matter which holiday
// changed). Skips locked/missing sheets. Returns rows updated.
export async function recomputeMonthCountry(fiscalYear: string, monthIndex: number, country: string): Promise<number> {
  const month = MONTHS[monthIndex - 1];
  const sheet = await prisma.monthlySheet.findUnique({
    where: { fiscalYear_month: { fiscalYear, month } },
    include: { lines: { include: { employee: { select: { location: true, businessUnitId: true } }, project: { select: { billingHoursPerDay: true } } } } },
  });
  if (!sheet || sheet.status === "LOCKED") return 0;
  const cache = new Map<string, number>();
  let updated = 0;
  for (const l of sheet.lines) {
    if (l.isExpense || !l.isBillable || !l.projectId) continue;
    if ((l.employee?.location || "").toUpperCase() !== country.toUpperCase()) continue;
    const wd = await workingDaysInMonth(fiscalYear, monthIndex, country, l.employee?.businessUnitId, cache);
    const hpd = l.project?.billingHoursPerDay || 8;
    // MONTHLY lines keep their fixed monthly revenue (anchor = current invoiceAmount); others
    // keep their fixed rate and let revenue scale with the new working-day count.
    const d = deriveBillable({ mode: (l as any).billingMode || "HOURLY", rateUsd: l.rateUsd, monthlyAmount: l.billingAmount, workingDays: wd, hpd, fx: l.fxMultiplier });
    await prisma.monthlyLine.update({ where: { id: l.id }, data: d });
    updated++;
  }
  return updated;
}
