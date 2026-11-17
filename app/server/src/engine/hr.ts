// HR — CTC bracket detection, salary breakup, and tax calculation.
// Every rule here is DATA (HrCtcBracket / HrSalaryComponent / HrTaxBracket / HrCountryConfig
// rows) — this file only implements the arithmetic, never a hard-coded percentage or slab.
import { prisma } from "../prisma";

// Fallback name if no bench project exists yet — the SAME canonical name Monthly Forecast's own
// bench flow (addBenchLines/benchAfterWindow in routes/finance/monthly.ts) uses, so there is ever
// only ONE bench bucket system-wide, not a second "Bench" project splitting cost/headcount
// reporting in two (a real production issue found and fixed 2026-10-12 — ensureBenchProject()
// used to fall back to creating a project literally named "Bench" whenever no REAL Project row
// matching its name heuristic existed yet, since Monthly Forecast's own bench lines never had a
// real Project behind them at all — just this same text label with projectId left null).
export const BENCH_PROJECT_NAME = "GenAquarius (Bench)";

// The signatory shown on every generated Offer/Appointment/Appraisal/Service Agreement PDF —
// configurable in HR Admin Settings → Signature (a singleton row, id=1). Falls back to the
// original hard-coded "Vivek Kaw / CHRO" + static asset image wherever nothing's been set yet,
// so this is zero-regression until HR actually configures one.
// Returns null fields when unconfigured (not a hard-coded fallback) — each render*Pdf() function
// has its own original default wording ("Chief Human Resources Officer" vs "CHRO (Authorized
// Signatory)" vs plain "CHRO"), and null lets its own `||` fallback stay authoritative. Field
// names match hrPdf.ts's SignatureFields exactly so a call site can just spread the result in.
export async function getHrSignature(businessUnitId?: number | null): Promise<{ signatoryName: string | null; signatoryTitle: string | null; signatureImageBase64: string | null }> {
  const row = await buFirst(businessUnitId, (bu) => prisma.hrSignature.findFirst({ where: bu }));
  return { signatoryName: row?.signatoryName || null, signatoryTitle: row?.signatoryTitle || null, signatureImageBase64: row?.imageData || null };
}

export interface ComponentLine {
  name: string;
  part: "A" | "B";
  pct: number;
  monthly: number;
  annual: number;
}

export interface SalaryBreakup {
  bracketId: number;
  bracketName: string;
  components: ComponentLine[];
  grossA: number; // Part A (Fixed) monthly total
  grossAAnnual: number;
  grossB: number; // Part B (Flexi) monthly total
  grossBAnnual: number;
  totalMonthly: number;
  totalAnnual: number;
}

export interface TaxCalc {
  countryCode: string;
  regime: string;
  grossAnnual: number;
  standardDeduction: number;
  taxableIncome: number;
  tax: number;
  cess: number;
  totalTax: number;
  monthlyTds: number;
  netMonthly: number;
}

// Business Unit config override fallback: every one of the 8 BU-scopable HR config categories
// (CTC Brackets, Tax Brackets, Offer/Appointment/Service Agreement/Appraisal Templates, Leave
// Policy, Onboarding Document Checklist) follows the same rule — a Business Unit's own rows
// (businessUnitId = that BU's id) win if any exist; otherwise fall back to that BU's Country's
// default rows (businessUnitId = null). Every call site below takes an optional businessUnitId
// and threads it through this helper instead of querying countryCode alone.
export async function buRows<T>(businessUnitId: number | null | undefined, findMany: (where: { businessUnitId: number | null }) => Promise<T[]>): Promise<T[]> {
  if (businessUnitId) {
    const rows = await findMany({ businessUnitId });
    if (rows.length) return rows;
  }
  return findMany({ businessUnitId: null });
}
// Same fallback rule as buRows(), for a single-row (`findFirst`/`findUnique`-style) lookup —
// used by the 4 template categories and Leave Policy Config.
export async function buFirst<T>(businessUnitId: number | null | undefined, findOne: (where: { businessUnitId: number | null }) => Promise<T | null>): Promise<T | null> {
  if (businessUnitId) {
    const row = await findOne({ businessUnitId });
    if (row) return row;
  }
  return findOne({ businessUnitId: null });
}

/** Find the CTC bracket an annual CTC falls into for a country (lowest matching `order` wins). */
export async function detectBracket(ctc: number, countryCode = "INDIA", businessUnitId?: number | null) {
  const brackets = await buRows(businessUnitId, (bu) => prisma.hrCtcBracket.findMany({ where: { countryCode, ...bu }, orderBy: { order: "asc" } }));
  return (
    brackets.find((b) => ctc >= b.minCtc && (b.maxCtc == null || ctc <= b.maxCtc)) ||
    brackets[brackets.length - 1] ||
    null
  );
}

/**
 * Build the Part A (Fixed) / Part B (Flexi) salary breakup for a CTC using a bracket's
 * configured components. `overrides` (offer-specific, never touches the master bracket)
 * maps a component name to a replacement { pct } — used by "Customize Offer".
 */
export async function computeSalaryBreakup(
  bracketId: number,
  ctc: number,
  overrides?: Record<string, { pct: number }> | null
): Promise<SalaryBreakup> {
  const bracket = await prisma.hrCtcBracket.findUnique({
    where: { id: bracketId },
    include: { components: { orderBy: { order: "asc" } } },
  });
  if (!bracket) throw new Error("CTC bracket not found");

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const components: ComponentLine[] = bracket.components.map((c) => {
    const pct = overrides?.[c.name]?.pct ?? c.pct;
    const annual = round2((ctc * pct) / 100);
    const monthly = round2(annual / 12);
    return { name: c.name, part: c.part as "A" | "B", pct, monthly, annual };
  });

  const partA = components.filter((c) => c.part === "A");
  const partB = components.filter((c) => c.part === "B");
  const grossAAnnual = round2(partA.reduce((s, c) => s + c.annual, 0));
  const grossBAnnual = round2(partB.reduce((s, c) => s + c.annual, 0));
  const grossA = round2(grossAAnnual / 12);
  const grossB = round2(grossBAnnual / 12);

  return {
    bracketId: bracket.id,
    bracketName: bracket.name,
    components,
    grossA,
    grossAAnnual,
    grossB,
    grossBAnnual,
    totalMonthly: round2(grossA + grossB),
    totalAnnual: round2(grossAAnnual + grossBAnnual),
  };
}

// Maps an offer's salary breakup (India only — component names are the bracket's own, defined
// in HR Settings) onto CtcRecord's INR component fields. Used both by Confirm Joining (to create
// the real record) and by the read-only CTC preview it shows HR beforehand — one function, so
// the preview can never drift from what actually gets written.
export function buildCtcComponentsFromBreakup(breakup: any) {
  const comp = (name: string) => breakup?.components?.find((c: any) => c.name === name)?.monthly || 0;
  return {
    basic: comp("Basic Salary"), hra: comp("HRA"), otherAllowance: 0, specialAllowance: comp("Special / Other Allowance"),
    conveyance: comp("Conveyance / Fuel Allowance") + comp("Vehicle Maintenance Allowance"),
    communication: comp("Communication Allowance"), meals: comp("Meals & Entertainment Exp."),
    books: comp("Magazine (Books & Periodicals)"), driver: comp("Driver Allowance"), uniform: comp("Uniform Allowance"),
    bonusAnnual: 0,
  };
}

/** Slab-based tax on a gross annual income, using the country+regime's configured brackets/deduction. */
export async function computeTax(grossAnnual: number, countryCode = "INDIA", regime = "NEW", businessUnitId?: number | null): Promise<TaxCalc> {
  const regimeConfig = await prisma.hrTaxRegimeConfig.findUnique({ where: { countryCode_regime: { countryCode, regime } } });
  const standardDeduction = regimeConfig?.standardDeduction || 0;
  const cessPct = regimeConfig?.cessPct || 0;
  const slabs = await buRows(businessUnitId, (bu) => prisma.hrTaxBracket.findMany({ where: { countryCode, regime, ...bu }, orderBy: { order: "asc" } }));

  const taxableIncome = Math.max(0, grossAnnual - standardDeduction);
  let tax = 0;
  for (const s of slabs) {
    const lo = s.minIncome;
    const hi = s.maxIncome == null ? Infinity : s.maxIncome;
    if (taxableIncome <= lo) continue;
    const slice = Math.min(taxableIncome, hi) - lo;
    if (slice > 0) tax += (slice * s.ratePct) / 100;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  tax = round2(tax);
  const cess = round2((tax * cessPct) / 100);
  const totalTax = round2(tax + cess);
  const monthlyTds = round2(totalTax / 12);
  const netMonthly = round2(grossAnnual / 12 - monthlyTds);

  return { countryCode, regime, grossAnnual, standardDeduction, taxableIncome, tax, cess, totalTax, monthlyTds, netMonthly };
}

/** Next sequential offer reference, e.g. OFR-2026-0142 (year of offerDate + a running counter). */
// Scans every existing offerRef for this year's highest sequence number in use and increments —
// same scan-and-increment shape as nextEmpNo()/nextContractorCode() below, deliberately not a
// plain prisma.offer.count(): a bulk-deleted offer permanently desyncs a row count from the
// highest ref actually in use, and the next "count+1" ref then collides with a survivor's ref
// (Offer_offerRef_key unique constraint failure) — this can never collide since it always looks
// at what's really on file.
export async function nextOfferRef(offerDate: Date): Promise<string> {
  const year = offerDate.getFullYear();
  const offers = await prisma.offer.findMany({ where: { offerRef: { startsWith: `OFR-${year}-` } }, select: { offerRef: true } });
  let max = 0;
  for (const o of offers) {
    const m = /^OFR-\d{4}-(\d+)$/.exec(o.offerRef || "");
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  return `OFR-${year}-${String(max + 1).padStart(4, "0")}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Appraisal reference, e.g. GenAquarius/July/1039 — the trailing number is the employee's own
 * Employee ID, not a sequence counter, so the ref itself identifies who it's for. Always exactly
 * "GenAquarius/{Month}/{EmpNo}" — no collision suffix, even if the same employee gets a second
 * appraisal in the same month (appraisalRef is no longer a unique column; see schema comment). */
export async function nextAppraisalRef(date: Date, empNo?: string | null): Promise<string> {
  return `GenAquarius/${MONTH_NAMES[date.getMonth()]}/${empNo || "0000"}`;
}

/**
 * Next Employee ID — a plain number, 1000+, no prefix (contractors keep their own "C####"
 * prefix — see nextContractorCode below). Scans every existing Employee.empNo / Offer.
 * reservedEmpNo for the highest number already in use (including legacy "GA-####" records, with
 * the prefix stripped) and increments — no schema change, no new counter table, and it can never
 * collide with a manually-entered code since it's always strictly ahead of everything on file.
 */
export async function nextEmpNo(): Promise<string> {
  const emps = await prisma.employee.findMany({ select: { empNo: true } });
  const offers = await prisma.offer.findMany({ where: { reservedEmpNo: { not: null } }, select: { reservedEmpNo: true } });
  let max = 999; // first generated is 1000
  const scan = (v: string | null | undefined) => {
    if (!v) return;
    const digits = String(v).replace(/^GA-/, "");
    if (/^\d+$/.test(digits)) { const n = parseInt(digits, 10); if (n > max) max = n; }
  };
  emps.forEach((e) => scan(e.empNo));
  offers.forEach((o) => scan(o.reservedEmpNo));
  return String(max + 1);
}

/**
 * Next Contractor code in the "C1500", "C1501", … numbering — same scan-and-increment shape as
 * nextEmpNo() (scans Employee.empNo AND Offer.reservedEmpNo, +1, no DB unique constraint relied
 * on), just a different prefix/base so the two numbering spaces never collide with each other or
 * with a GA-#### employee code. Base 1499 so the FIRST contractor generated is exactly C1500.
 */
export async function nextContractorCode(): Promise<string> {
  const emps = await prisma.employee.findMany({ where: { empNo: { startsWith: "C" } }, select: { empNo: true } });
  const offers = await prisma.offer.findMany({ where: { reservedEmpNo: { startsWith: "C" } }, select: { reservedEmpNo: true } });
  let max = 1499;
  const scan = (v: string | null | undefined) => {
    const m = /^C(\d+)$/.exec(String(v || ""));
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  };
  emps.forEach((e) => scan(e.empNo));
  offers.forEach((o) => scan(o.reservedEmpNo));
  return `C${max + 1}`;
}

export interface ContractorPay {
  monthlyCompensation: number;
  tax: number;
  netMonthly: number;
  annualCompensation: number;
}

/**
 * Flat 10% TDS on the monthly amount — intentionally NOT computeTax(): a contractor's Service
 * Agreement (see engine/hrPdf.ts renderServiceAgreementPdf) has no CTC-bracket/tax-regime engine
 * involved at all, just the one flat rate the real reference document states ("10% taxes will be
 * deducted at source").
 */
export function computeContractorPay(monthlyCompensation: number): ContractorPay {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const tax = round2(monthlyCompensation * 0.1);
  return { monthlyCompensation, tax, netMonthly: round2(monthlyCompensation - tax), annualCompensation: round2(monthlyCompensation * 12) };
}


// Contractor compensation structure (Stage 1 / Service Agreement / Employee & CTC Approval).
// Everything downstream (CtcApprovalRequest.basic, CtcRecord, Monthly Forecast) stores the
// MONTHLY equivalent in `basic` and computes annual as monthly x 12, so Annual / Monthly / Daily
// all collapse to one figure here. Daily annualizes over a fixed 260 working days/year (same
// default as CtcRecord.workingDaysPerYear).
export type CompensationType = "ANNUAL" | "MONTHLY" | "DAILY";
export const DAILY_WORKING_DAYS = 260;
export function normalizeCompensationType(t: any): CompensationType {
  return t === "ANNUAL" || t === "DAILY" ? t : "MONTHLY";
}
export function computeCompensation(type: any, amount: number): { type: CompensationType; amount: number; annual: number; monthly: number } {
  const t = normalizeCompensationType(type);
  const a = Number(amount) || 0;
  const annual = t === "ANNUAL" ? a : t === "DAILY" ? a * DAILY_WORKING_DAYS : a * 12;
  const monthly = t === "MONTHLY" ? a : annual / 12;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { type: t, amount: a, annual: r2(annual), monthly: r2(monthly) };
}

// US / Canada engagement compensation — Annual / Monthly / Daily / Hourly. `rate` is the amount in
// the chosen basis' own unit. Hours/day and working days/year are per-offer editable (defaults 8 /
// 260, same defaults CtcRecord uses), which is how they stay configurable per country/engagement.
export type EngagementBasis = "ANNUAL" | "MONTHLY" | "DAILY" | "HOURLY";
export interface EngagementComp { basis: EngagementBasis; rate: number; hoursPerDay: number; workingDays: number; annual: number; monthly: number; dayRate: number; hourlyRate: number }
export function computeEngagementComp(basis: any, rate: number, hoursPerDay?: any, workingDays?: any): EngagementComp {
  const b: EngagementBasis = basis === "MONTHLY" || basis === "DAILY" || basis === "HOURLY" ? basis : "ANNUAL";
  const r = Number(rate) || 0;
  const hours = Math.round(Number(hoursPerDay)) || 8;
  const days = Math.round(Number(workingDays)) || 260;
  const annual = b === "ANNUAL" ? r : b === "MONTHLY" ? r * 12 : b === "DAILY" ? r * days : r * hours * days;
  const dayRate = b === "DAILY" ? r : b === "HOURLY" ? r * hours : annual / days;
  const hourlyRate = b === "HOURLY" ? r : dayRate / hours;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { basis: b, rate: r, hoursPerDay: hours, workingDays: days, annual: r2(annual), monthly: r2(annual / 12), dayRate: r2(dayRate), hourlyRate: r2(hourlyRate) };
}
/** The comp an Offer was created with: customFields.usComp if present, else the legacy
 * billingBasis/hourlyRateUsd/hoursPerDay columns, else a plain annual `ctc`. */
export function offerEngagementComp(offer: any): EngagementComp {
  const u = (offer?.customFields as any)?.usComp;
  if (u?.basis) return computeEngagementComp(u.basis, u.rate, u.hoursPerDay, u.workingDays);
  if (offer?.billingBasis === "HOURLY" && offer?.hourlyRateUsd) return computeEngagementComp("HOURLY", offer.hourlyRateUsd, offer.hoursPerDay, 260);
  return computeEngagementComp("ANNUAL", offer?.ctc || 0);
}
/** Document tokens for a US/Canada offer — the correct terminology/rate/payment-frequency for the
 * selected basis, so an hourly engagement never prints a monthly-salary clause. */
export function engagementDocVars(offer: any): Record<string, string> {
  const cur = offer?.countryCode === "CANADA" ? "CAD" : "USD";
  const c = offerEngagementComp(offer);
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const rateText = c.basis === "HOURLY" ? `${cur} ${n(c.rate)} per hour` : c.basis === "DAILY" ? `${cur} ${n(c.rate)} per day`
    : c.basis === "MONTHLY" ? `${cur} ${n(c.rate)} per month` : `${cur} ${n(c.rate)} per annum`;
  const label = c.basis === "HOURLY" ? "Hourly Rate" : c.basis === "DAILY" ? "Daily Rate" : c.basis === "MONTHLY" ? "Monthly Salary" : "Annual Salary";
  const terms = c.basis === "HOURLY" ? `Payment will be calculated at the agreed hourly rate of ${rateText} for the hours actually worked (standard ${c.hoursPerDay} hours per day) and invoiced/paid monthly in arrears.`
    : c.basis === "DAILY" ? `Payment will be calculated at the agreed daily rate of ${rateText} for each day actually worked and invoiced/paid monthly in arrears.`
    : c.basis === "MONTHLY" ? `Compensation of ${rateText} will be paid monthly, by the last working day of each month.`
    : `Compensation of ${rateText} will be paid in equal instalments per the company's payroll schedule.`;
  return {
    HourlyRate: rateText, CompensationRate: rateText, CompensationBasis: label, PaymentTerms: terms,
    AnnualizedCtc: `${cur} ${n(c.annual)}`, HoursPerDay: String(c.hoursPerDay), WorkingDaysPerYear: String(c.workingDays), Currency: cur,
  };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigitsToWords(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}
function threeDigitsToWords(n: number): string {
  if (n >= 100) return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + twoDigitsToWords(n % 100) : "");
  return twoDigitsToWords(n);
}
/** Indian numbering (Crore/Lakh/Thousand) amount-in-words, e.g. 45000 -> "Forty Five Thousand Only" —
 * used for the Service Agreement's "{{MonthlyCompensationWords}}" token. Whole rupees only (no paise). */
export function amountToWordsIndia(amount: number): string {
  let n = Math.round(Math.abs(amount || 0));
  if (n === 0) return "Zero Only";
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const rest = n;
  const parts: string[] = [];
  if (crore) parts.push(threeDigitsToWords(crore) + " Crore");
  if (lakh) parts.push(threeDigitsToWords(lakh) + " Lakh");
  if (thousand) parts.push(threeDigitsToWords(thousand) + " Thousand");
  if (rest) parts.push(threeDigitsToWords(rest));
  return parts.join(" ") + " Only";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (n: number) => { const v = n % 100, s = ["th", "st", "nd", "rd"]; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

/** Fill {{Token}} placeholders in a template string from a flat key/value map. A Date value
 * (e.g. offer.proposedJoiningDate straight from Prisma) is formatted "6th Jul 2026" — the same
 * shape every PDF date uses — never a raw `Date.toString()` dump. */
export function fillTemplate(tpl: string, vals: Record<string, any>): string {
  return String(tpl || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const v = vals[key];
    if (v === undefined || v === null) return "";
    if (v instanceof Date) return `${ordinal(v.getDate())} ${MONTHS[v.getMonth()]} ${v.getFullYear()}`;
    return String(v);
  });
}

/**
 * Find the Bench project Confirm Joining should default to. Reuses whatever project already
 * satisfies calc.ts's own "on the bench" match (name is exactly "bench" or ends "…(bench)") —
 * never creates a second one that would split existing Bench headcount reporting. Only if the
 * live data truly has none yet does it create a fresh internal "Bench" project.
 */
export async function ensureBenchProject() {
  const candidates = await prisma.project.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true } });
  const existing = candidates.find((p) => {
    const n = (p.name || "").trim().toLowerCase();
    return n === "bench" || n.endsWith("(bench)");
  });
  if (existing) return prisma.project.findUnique({ where: { id: existing.id } });

  let internalClient = await prisma.client.findFirst({ where: { OR: [{ code: "CORPORATE" }, { name: { startsWith: "GenAquarius" } }] } });
  if (!internalClient) internalClient = await prisma.client.create({ data: { name: "GenAquarius", code: "CORPORATE" } });
  return prisma.project.create({
    data: { name: BENCH_PROJECT_NAME, clientId: internalClient.id, status: "ACTIVE", billingType: "TNM", billingScope: "RESOURCE" },
  });
}
