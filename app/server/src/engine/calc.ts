import { prisma } from "../prisma";

export const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

// Dashboard aggregation (getDashboard/getFinancePnl/getReceivables below) re-walks every
// MonthlyLine for the fiscal year from scratch on every call — correct, but expensive, and the
// CEO/Finance/HR dashboards all hit it repeatedly (FY/month selector changes, multiple viewers,
// React effect re-fetches). A short TTL cache turns repeat calls within the window into an
// in-memory hit instead of a full DB reload + aggregation pass. 30s bounds staleness to roughly
// "the next dashboard refresh" without needing to track every write site that could affect these
// figures (Monthly Forecast, CTC, terminations, invoices, ...) for explicit invalidation.
type Memoized<A extends any[], R> = ((...args: A) => Promise<R>) & { invalidate: () => void };
function memoizeAsync<A extends any[], R>(fn: (...args: A) => Promise<R>, ttlMs: number): Memoized<A, R> {
  const cache = new Map<string, { at: number; promise: Promise<R> }>();
  const wrapped = ((...args: A) => {
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const promise = fn(...args);
    promise.catch(() => cache.delete(key)); // never cache a rejection
    cache.set(key, { at: Date.now(), promise });
    return promise;
  }) as Memoized<A, R>;
  wrapped.invalidate = () => cache.clear();
  return wrapped;
}

export interface ProjectAgg {
  name: string;
  geo: string;
  isCustomer: boolean;
  deliveryModel: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
  monthly: Record<string, { rev: number; cost: number }>;
}

export interface DashboardData {
  fiscalYear: string;
  totalRevenue: number;
  customerCost: number;
  internalCost: number;
  ebitda: number;
  ebitdaMargin: number;
  monthlyRevenue: number[];
  monthlyCost: number[];
  monthlyOnsite: number[];
  monthlyOffshore: number[];
  monthlySalary: number[];
  monthlyHeadcount: number[];
  monthlyBillable: number[];
  monthlyOnsiteHC: number[];
  monthlyOffshoreHC: number[];
  months: string[];
  geoRevenue: Record<string, number>;
  onsiteRevenue: number;
  offshoreRevenue: number;
  projects: ProjectAgg[];
  top3: ProjectAgg[];
  costBreakdown: { category: string; cost: number; monthly: number[] }[];
  costType: { category: string; cost: number; monthly: number[] }[];
  workforce: {
    total: number[]; billableIndia: number[]; billableUS: number[]; billableCanada: number[];
    billableOther: number[]; onsiteBillable: number[]; offshoreBillable: number[]; doubleDip: number[]; bench: number[]; shadow: number[]; assigned: number[];
    rosterByMonth: Record<string, string[]>[];
  };
}

// Order for the Fixed/Variable/Delivery cost-type split.
export const COST_TYPE_ORDER = ["Fixed Overhead", "Variable Overhead", "Resource / Delivery (CTC)"];

// The three billable-CTC buckets are structural (derived from a project's delivery
// model), shown first. Every expense category is DB-driven (ExpenseCategory table) —
// nothing about the expense buckets is hardcoded here.
export const CTC_CAT_ORDER = ["CTC (India · Offshore)", "CTC (US · Onsite)", "CTC (Hybrid)"];

/**
 * Aggregate the imported monthly lines (per resource, per month) into the
 * dashboard model. Cost & invoice values originate from the workbook's cached
 * cells, so these aggregates equal the Excel figures.
 */
async function getDashboardImpl(fiscalYear: string, month: string = "ALL"): Promise<DashboardData> {
  const scoped = month && month !== "ALL";
  const sheets = await prisma.monthlySheet.findMany({
    where: { fiscalYear },
    include: { lines: { include: { employee: { select: { location: true, empType: true } }, project: { include: { client: { include: { geography: true } } } } } } },
  });
  // Employment type per person, for the Workforce drill-down's "Name · Contractor/Intern/Full-Time"
  // roster suffix — a display-only lookup, never used for any identity/dedup Set/Map key above (so
  // it can't affect head count or billable-composition logic, only how a name is printed at the end).
  const empTypeLabel = (t?: string | null) => (t === "CONTRACTOR" ? "Contractor" : t === "INTERN" ? "Intern" : "Full-Time");
  const nameEmpType = new Map<string, string>();

  const projMap = new Map<string, ProjectAgg>();
  // Workforce composition per month (distinct resources): total, billable by geography,
  // bench (on "GenAquarius (Bench)"), and shadow (non-billable on a real/corporate project).
  const wfTotal: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfBillIndia: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfBillUS: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfBillCanada: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfBillOther: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfBench: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfShadow: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>());
  const wfAssigned: Set<string>[] = Array.from({ length: 12 }, () => new Set<string>()); // non-billable but on a CUSTOMER project
  // Per-month roster: category -> (person -> set of project names) for pie-chart tooltips.
  type Roster = Record<string, Map<string, Set<string>>>;
  const mkRoster = (): Roster => ({ billableIndia: new Map(), billableUS: new Map(), billableCanada: new Map(), billableOther: new Map(), bench: new Map(), shadow: new Map(), assigned: new Map(), onsiteBillable: new Map(), offshoreBillable: new Map(), doubleDip: new Map() });
  const wfRoster: Roster[] = Array.from({ length: 12 }, mkRoster);
  const addRoster = (mi: number, cat: string, name: string, project: string) => {
    const m = wfRoster[mi][cat]; if (!m.has(name)) m.set(name, new Set());
    if (project) m.get(name)!.add(project);
  };
  // A resource is "on the bench" if their project is a bench project — the auto-bench
  // "GenAquarius (Bench)" or any project named "Bench" / "… (Bench)".
  const isBenchName = (n: string) => { const x = (n || "").trim().toLowerCase(); return x === "bench" || x.includes("(bench)"); };
  // Internal corporate projects (the "Corporate" bucket): the "Corporate" project itself or any
  // internal GenAquarius one. A non-billable person on a CUSTOMER project (e.g. an unbilled month
  // on Bastian) is ASSIGNED — they belong to the project team, not to Corporate or the Bench.
  const isCorpName = (n: string) => { const x = (n || "").trim().toLowerCase(); return x.includes("corporate") || x.startsWith("genaquarius"); };
  const monthlyRevenue = new Array(12).fill(0);
  const monthlyCost = new Array(12).fill(0);
  const monthlyOnsite = new Array(12).fill(0);
  const monthlyOffshore = new Array(12).fill(0);
  const monthlySalary = new Array(12).fill(0);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // Every headline count is PEOPLE. TOTAL head count = distinct people with any resource line.
  // BILLABLE / onsite / offshore = distinct people with revenue-earning lines — one person is ONE
  // billable head however many projects they bill on (a 100%+100% double-dip included) and however
  // their allocation is split (50%+50% = 1). Per-project detail lives in the drill-down roster.
  type Seat = { name: string; alloc: number; projects: string[] };
  const onsiteSeats: Map<string, Seat>[] = Array.from({ length: 12 }, () => new Map<string, Seat>());
  const offshoreSeats: Map<string, Seat>[] = Array.from({ length: 12 }, () => new Map<string, Seat>());
  const seatCount = (m: Map<string, Seat>) => m.size; // distinct billable PEOPLE (location fixes each person's bucket)
  // Roster for the Workforce drill-down: one line per PERSON, listing their billable projects
  // (with the % when part-time) and how many seats they count as, so the list visibly adds up to
  // the heading instead of just looking like a different number.
  const seatRoster = (m: Map<string, Seat>) => [...m.values()].map((s) => (s.projects.length ? `${s.name} (${s.projects.join(", ")})` : s.name));
  const headByPerson: Map<string, number>[] = Array.from({ length: 12 }, () => new Map<string, number>());
  const totalByPerson: Map<string, number>[] = Array.from({ length: 12 }, () => new Map<string, number>());
  // Head count is PEOPLE: the map is already keyed per person, so its size is the answer.
  // (It used to sum min(1, allocation), which correctly capped a double-dip at 1 head but also
  // counted someone whose only line is 50%-allocated as half a person — producing fractional
  // head counts like 73.5. A part-time seat is still one human being on the payroll.)
  const distinctPeople = (m: Map<string, number>) => m.size;
  const wfBillIndiaW = new Array(12).fill(0), wfBillUSW = new Array(12).fill(0), wfBillCanadaW = new Array(12).fill(0), wfBillOtherW = new Array(12).fill(0);
  // Per month, per person (keyed by employeeId, name fallback): their BILLABLE lines, projects, and
  // whether a double-dip incentive is set. Double-dip = on 2+ billable projects OR an incentive —
  // matching the Operations "Double Dip" definition (not gated on current revenue).
  const dipByPerson: Map<string, { name: string; lines: number; incentive: boolean; checked: boolean; projects: Set<string> }>[] =
    Array.from({ length: 12 }, () => new Map());
  // cost-center breakdown: category -> 12-month cost array
  const catMonthly = new Map<string, number[]>();
  const addCat = (cat: string, mi: number, cost: number) => {
    if (!catMonthly.has(cat)) catMonthly.set(cat, new Array(12).fill(0));
    catMonthly.get(cat)![mi] += cost;
  };
  // Fixed vs Variable vs Delivery(CTC) cost split — by line.expenseType for overhead
  // lines; billable resource (CTC) cost is its own bucket (not user-classified).
  const typeMonthly = new Map<string, number[]>();
  const addType = (t: string, mi: number, cost: number) => {
    if (!typeMonthly.has(t)) typeMonthly.set(t, new Array(12).fill(0));
    typeMonthly.get(t)![mi] += cost;
  };

  for (const sheet of sheets) {
    const mi = sheet.monthIndex - 1;
    for (const line of sheet.lines) {
      const isCustomer = !line.isExpense;
      // A PROJECT-scoped expense (expenseScope=PROJECT + a real project) is allocated to that
      // customer project's cost bucket so it lowers that project's margin. Org-level expenses
      // stay in their own category bucket (internal cost) as before.
      const allocToProject = line.isExpense && (line as any).expenseScope === "PROJECT" && !!line.project;
      const bucketName = allocToProject ? line.project!.name : (line.projectName || line.project?.name || "Unassigned");
      const bucketIsCustomer = isCustomer || allocToProject;
      const geo = line.project?.client?.geography?.code || (bucketIsCustomer ? "US" : "INTERNAL");
      const dm = line.project?.deliveryModel || "OFFSHORE";
      if (!projMap.has(bucketName)) {
        projMap.set(bucketName, {
          name: bucketName, geo, isCustomer: bucketIsCustomer, deliveryModel: dm,
          revenue: 0, cost: 0, profit: 0, margin: 0,
          monthly: Object.fromEntries(MONTHS.map((m) => [m, { rev: 0, cost: 0 }])),
        });
      }
      const p = projMap.get(bucketName)!;
      const rev = line.invoiceAmount;
      const cost = line.costUsd;
      p.revenue += isCustomer ? rev : 0;
      p.cost += cost;
      p.monthly[sheet.month].rev += isCustomer ? rev : 0;
      p.monthly[sheet.month].cost += cost;
      monthlyCost[mi] += cost;
      // fixed/variable/delivery split
      addType(!isCustomer ? ((line as any).expenseType === "FIXED" ? "Fixed Overhead" : "Variable Overhead") : "Resource / Delivery (CTC)", mi, cost);
      // cost-center categorisation: billable CTC by delivery model; expenses by their bucket name
      if (isCustomer) {
        const cat = dm === "ONSITE" ? "CTC (US · Onsite)" : dm === "HYBRID" ? "CTC (Hybrid)" : "CTC (India · Offshore)";
        addCat(cat, mi, cost);
      } else {
        addCat(line.projectName || "Other", mi, cost);
      }
      // Head count = distinct RESOURCES only. Expense/overhead lines (rent, insurance,
      // subscriptions, vendor fees…) are not people and must never inflate head count.
      const alloc = Math.max(0, ((line as any).allocationPct ?? 100)) / 100; // FTE weight for this line
      const pkey = line.employeeId ? `e${line.employeeId}` : `n:${(line.resourceName || "").toLowerCase()}`;
      if (isCustomer && (cost > 0 || rev > 0)) headByPerson[mi].set(pkey, (headByPerson[mi].get(pkey) || 0) + alloc);
      // Workforce composition (resource lines only — never expense/overhead).
      if (!line.isExpense) {
        const rn = line.resourceName;
        const pn = line.projectName || line.project?.name || "";
        if (!nameEmpType.has(rn)) nameEmpType.set(rn, empTypeLabel(line.employee?.empType));
        wfTotal[mi].add(rn); totalByPerson[mi].set(pkey, (totalByPerson[mi].get(pkey) || 0) + alloc);
        const onBench = isBenchName(line.projectName || "");
        const billable = (line as any).isBillable !== false;
        if (billable) {
          const loc = (line.employee?.location || "").toUpperCase();
          const cat = loc === "INDIA" ? "billableIndia" : loc === "US" ? "billableUS" : loc === "CANADA" ? "billableCanada" : "billableOther";
          (loc === "INDIA" ? wfBillIndia : loc === "US" ? wfBillUS : loc === "CANADA" ? wfBillCanada : wfBillOther)[mi].add(rn);
          (loc === "INDIA" ? wfBillIndiaW : loc === "US" ? wfBillUSW : loc === "CANADA" ? wfBillCanadaW : wfBillOtherW)[mi] += alloc;
          addRoster(mi, cat, rn, pn);
          // double-dip tracking across all billable lines (per person)
          const dk = line.employeeId ? `e${line.employeeId}` : `n:${rn.toLowerCase()}`;
          const dp = dipByPerson[mi].get(dk) || { name: rn, lines: 0, incentive: false, checked: false, projects: new Set<string>() };
          dp.lines++; if (((line as any).doubleDipIncentive || 0) > 0) dp.incentive = true; if ((line as any).doubleDip) dp.checked = true; if (pn) dp.projects.add(pn);
          dipByPerson[mi].set(dk, dp);
        } else if (onBench) { wfBench[mi].add(rn); addRoster(mi, "bench", rn, pn); }
        else if (isCorpName(pn)) { wfShadow[mi].add(rn); addRoster(mi, "shadow", rn, pn); }
        else { wfAssigned[mi].add(rn); addRoster(mi, "assigned", rn, pn); } // deployed on a customer project, just not billed
      }
      if (isCustomer) {
        monthlyRevenue[mi] += rev;
        monthlySalary[mi] += cost;
        // Onsite vs Offshore is by RESOURCE location: Offshore = India only; Onsite = US /
        // Canada / Caribbean. Resources with no/other location fall to Offshore (India).
        const empLoc = (line.employee?.location || "").toUpperCase();
        const isOnsite = empLoc === "US" || empLoc === "CANADA" || empLoc === "CARIBBEAN";
        if (isOnsite) monthlyOnsite[mi] += rev; else monthlyOffshore[mi] += rev;
        if (rev > 0) {
          // Accumulate allocation PER PERSON; the seat count is taken once at the end (see
          // seatCount). An employee's location is fixed, so every one of their seats lands in
          // the same bucket and onsite + offshore always re-add to the billable total.
          const pn2 = line.projectName || line.project?.name || "";
          const bucket = (isOnsite ? onsiteSeats : offshoreSeats)[mi];
          const s = bucket.get(pkey) || { name: line.resourceName, alloc: 0, projects: [] };
          s.alloc += alloc;
          if (pn2) s.projects.push(alloc < 1 ? `${pn2} ${Math.round(alloc * 100)}%` : pn2);
          bucket.set(pkey, s);
        }
      }
    }
  }
  // Locked-month Excel-parity override — moved here (from what used to be getFinancePnl's own
  // copy of this exact logic) so BOTH the Finance and Executive/CEO dashboards read the same
  // frozen-at-import numbers for a LOCKED month, instead of the Executive dashboard silently
  // recomputing live figures that can drift from Finance's once a locked month's underlying
  // lines are edited after the fact. Head count is deliberately NOT overridden — it must always
  // reflect the live rows (see the note above monthlyHeadcount) — only revenue/cost/salary are.
  const summaries = await prisma.actualCostSummary.findMany({ where: { fiscalYear } });
  const summaryByMonth = new Map(summaries.map((s) => [s.month, s]));
  const lockedMonth = new Map(sheets.map((sh) => [sh.month, sh.status === "LOCKED"]));
  for (let mi = 0; mi < 12; mi++) {
    if (!lockedMonth.get(MONTHS[mi])) continue;
    const s = summaryByMonth.get(MONTHS[mi]);
    if (!s) continue;
    if (s.revenue != null) monthlyRevenue[mi] = s.revenue;
    if (s.totalCost != null) monthlyCost[mi] = s.totalCost;
    if (s.salaryExpense != null) monthlySalary[mi] = s.salaryExpense;
  }

  // ONE category per person per month, by precedence: billable > On Project (non-billable) >
  // Corporate > Bench. Someone billable 50% on Providence and non-billable 50% on Stratoscope is
  // ONE billable head — not an extra "On Project"/Corporate/Bench entry. Applies to every month,
  // so future-month assignments (apply-to-future) are classified the same way automatically.
  for (let mi = 0; mi < 12; mi++) {
    const billableNames = new Set<string>([...wfBillIndia[mi], ...wfBillUS[mi], ...wfBillCanada[mi], ...wfBillOther[mi]]);
    for (const n of [...wfAssigned[mi]]) if (billableNames.has(n)) { wfAssigned[mi].delete(n); wfRoster[mi].assigned.delete(n); }
    for (const n of [...wfShadow[mi]]) if (billableNames.has(n) || wfAssigned[mi].has(n)) { wfShadow[mi].delete(n); wfRoster[mi].shadow.delete(n); }
    for (const n of [...wfBench[mi]]) if (billableNames.has(n) || wfAssigned[mi].has(n) || wfShadow[mi].has(n)) { wfBench[mi].delete(n); wfRoster[mi].bench.delete(n); }
  }
  const monthlyHeadcount = headByPerson.map(distinctPeople);  // distinct people billed/costed this month
  const monthlyOnsiteHC = onsiteSeats.map(seatCount);
  const monthlyOffshoreHC = offshoreSeats.map(seatCount);
  // Double-dip = a person on 2+ billable projects OR with a double-dip incentive set. Also list
  // them in the roster so the Workforce drill-down can show exactly who they are.
  const monthlyDoubleDip = dipByPerson.map((m, mi) => {
    let n = 0;
    for (const d of m.values()) {
      // ONLY an explicit mark counts: the Double Dip checkbox, or a saved incentive (which the UI
      // only allows with the checkbox on). Being on 2+ billable projects by itself — e.g. a
      // 50% + 50% split allocation — is NOT double dip; it is one billable person split across
      // projects. Matches the Monthly sheet badge rule.
      if (d.checked || d.incentive) { n++; wfRoster[mi].doubleDip.set(d.name, d.projects); }
    }
    return n;
  });
  // Billable (TB) = onsite people + offshore people + explicitly-marked double dips — a marked
  // double-dip fills a SECOND billable slot, so TB = 58 offshore + 9 onsite + 2 dips = 69.
  const monthlyBillable = monthlyOnsiteHC.map((v, i) => v + monthlyOffshoreHC[i] + monthlyDoubleDip[i]);

  const projects = [...projMap.values()];
  // When a single month is selected, scope every project's revenue/cost to that month.
  for (const p of projects) {
    if (scoped) { p.revenue = p.monthly[month].rev; p.cost = p.monthly[month].cost; }
    p.profit = p.revenue - p.cost;
    p.margin = p.revenue ? (p.profit / p.revenue) * 100 : 0;
  }

  const customers = projects.filter((p) => p.isCustomer);
  const customerCost = customers.reduce((s, p) => s + p.cost, 0);
  const internalCost = projects.filter((p) => !p.isCustomer).reduce((s, p) => s + p.cost, 0);
  // Headline totalRevenue/ebitda are summed from the monthly arrays (which carry the locked-month
  // Excel-parity override above), NOT from the live project rollup — this is what makes a LOCKED
  // month's Executive Dashboard totals agree exactly with Finance's (getFinancePnl sums the same
  // overridden monthly arrays via its own `rows`). The per-project breakdown below stays live,
  // same accepted caveat Finance's own cost/project tables already have for locked months.
  const revenueScope = scoped ? [monthlyRevenue[MONTHS.indexOf(month)] || 0] : monthlyRevenue;
  const costScope = scoped ? [monthlyCost[MONTHS.indexOf(month)] || 0] : monthlyCost;
  const totalRevenue = revenueScope.reduce((a, b) => a + b, 0);
  const ebitda = totalRevenue - costScope.reduce((a, b) => a + b, 0);

  const geoRevenue: Record<string, number> = {};
  for (const p of customers) geoRevenue[p.geo] = (geoRevenue[p.geo] || 0) + p.revenue;

  // Onsite/Offshore revenue is resource-location based (US/Canada/Caribbean = Onsite; India = Offshore),
  // matching the head-count split. When a single month is selected, use that month's arrays.
  const onsiteRevenue = scoped ? (monthlyOnsite[MONTHS.indexOf(month)] || 0) : monthlyOnsite.reduce((s, v) => s + v, 0);
  const offshoreRevenue = scoped ? (monthlyOffshore[MONTHS.indexOf(month)] || 0) : monthlyOffshore.reduce((s, v) => s + v, 0);

  const top3 = [...customers].sort((a, b) => b.revenue - a.revenue).slice(0, 3);

  // Cost breakdown by cost center — scoped to selected month, else full year. Always ties to Total Cost.
  // Ordering is DB-driven: CTC buckets first, then expense categories in ExpenseCategory table order.
  const expenseCats = await prisma.expenseCategory.findMany({ orderBy: { id: "asc" } });
  const catOrder = new Map<string, number>();
  CTC_CAT_ORDER.forEach((c, i) => catOrder.set(c, i));
  expenseCats.forEach((c, i) => catOrder.set(c.name, 100 + i));
  const ord = (c: string) => (catOrder.has(c) ? catOrder.get(c)! : 999);
  const mIdx = scoped ? MONTHS.indexOf(month) : -1;
  const costBreakdown = [...catMonthly.entries()]
    .map(([category, monthly]) => ({
      category, monthly,
      cost: mIdx >= 0 ? monthly[mIdx] : monthly.reduce((a, b) => a + b, 0),
    }))
    .filter((c) => Math.abs(c.cost) > 0.005)
    .sort((a, b) => (ord(a.category) - ord(b.category)) || (b.cost - a.cost));

  const typeOrd = (c: string) => { const i = COST_TYPE_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  const costType = [...typeMonthly.entries()]
    .map(([category, monthly]) => ({ category, monthly, cost: mIdx >= 0 ? monthly[mIdx] : monthly.reduce((a, b) => a + b, 0) }))
    .filter((c) => Math.abs(c.cost) > 0.005)
    .sort((a, b) => typeOrd(a.category) - typeOrd(b.category));

  return {
    fiscalYear, totalRevenue, customerCost, internalCost, ebitda,
    ebitdaMargin: totalRevenue ? (ebitda / totalRevenue) * 100 : 0,
    monthlyRevenue, monthlyCost, monthlyOnsite, monthlyOffshore, monthlySalary,
    monthlyHeadcount, monthlyBillable, monthlyOnsiteHC, monthlyOffshoreHC, months: MONTHS,
    geoRevenue, onsiteRevenue, offshoreRevenue,
    projects: [...customers].sort((a, b) => b.revenue - a.revenue),
    top3, costBreakdown, costType,
    workforce: {
      total: totalByPerson.map(distinctPeople),
      billableIndia: wfBillIndiaW.map(round2),
      billableUS: wfBillUSW.map(round2),
      billableCanada: wfBillCanadaW.map(round2),
      billableOther: wfBillOtherW.map(round2),
      onsiteBillable: monthlyOnsiteHC,   // US/Canada/Caribbean billable
      offshoreBillable: monthlyOffshoreHC, // India billable
      doubleDip: monthlyDoubleDip,       // distinct resources on 2+ billable projects
      bench: wfBench.map((s) => s.size),
      shadow: wfShadow.map((s) => s.size),
      assigned: wfAssigned.map((s) => s.size), // On Project (Non-billable)
      // Per-month roster of "Name · EmploymentType (Project1, Project2)" strings per category, for
      // pie tooltips and the Workforce drill-down. Onsite/Offshore Billable are overridden with
      // their PER-LINE lists so a double-dip resource shows once per project (matching the
      // per-line headcount).
      rosterByMonth: wfRoster.map((month, mi) => {
        const withType = (name: string) => `${name} · ${nameEmpType.get(name) || "Full-Time"}`;
        const base: Record<string, string[]> = Object.fromEntries(
          Object.entries(month).map(([cat, m]) => [cat, [...m.entries()].map(([name, projs]) => projs.size ? `${withType(name)} (${[...projs].join(", ")})` : withType(name))])
        );
        const seatRosterTyped = (m: Map<string, Seat>) => [...m.values()].map((s) => {
          const named = withType(s.name);
          return s.projects.length ? `${named} (${s.projects.join(", ")})` : named;
        });
        base.onsiteBillable = seatRosterTyped(onsiteSeats[mi]);
        base.offshoreBillable = seatRosterTyped(offshoreSeats[mi]);
        return base;
      }),
    },
  };
}

/** Convert a native-currency amount to USD using the dated FX rates. */
export async function toUsd(amount: number, currency: string): Promise<number> {
  const a = Number(amount) || 0;
  if (!currency || currency === "USD") return a;
  if (currency === "INR") {
    const fx = await prisma.fxRate.findFirst({ where: { context: "USD_INR" }, orderBy: { effectiveFrom: "desc" } });
    return a / (fx?.rate || 93);
  }
  if (currency === "CAD") {
    const fx = await prisma.fxRate.findFirst({ where: { context: "CANADA_FACTOR" }, orderBy: { effectiveFrom: "desc" } });
    return a * (fx?.rate || 0.71); // CANADA_FACTOR = CAD→USD
  }
  return a;
}

/** Compute monthly & annual cost for an employee from CTC components + FX. */
// --- Effective-dated cost helpers (intra-month proration) -------------------
// A single CTC record's annual USD, mirroring the /ctc precedence:
//  1. annualCostOverride (US W2 salary / explicit)   2. hourly/day-rate engagements
//  3. India INR components ÷ USD_INR FX.
export function ctcAnnualUsd(ctc: any, fxRate: number): number {
  if (ctc.annualCostOverride != null && ctc.annualCostOverride > 0) return ctc.annualCostOverride;
  if (ctc.usEngagement === "VENDOR" || ctc.usEngagement === "W2_NO_BENEFIT") {
    if (ctc.rateBasis === "DAILY" && ctc.dayRateUsd) return (ctc.dayRateUsd || 0) * (ctc.workingDaysPerYear || 260);
    if (ctc.hourlyRateUsd) return (ctc.hourlyRateUsd || 0) * (ctc.hoursPerDay || 8) * (ctc.workingDaysPerYear || 260);
  }
  const monthlyInr = (ctc.basic || 0) + (ctc.hra || 0) + (ctc.otherAllowance || 0) + (ctc.specialAllowance || 0)
    + (ctc.conveyance || 0) + (ctc.communication || 0) + (ctc.meals || 0) + (ctc.books || 0) + (ctc.driver || 0) + (ctc.uniform || 0);
  return (monthlyInr * 12 + (ctc.bonusAnnual || 0)) / fxRate;
}

// UTC day-number (timezone-safe integer) for date-only comparisons.
const dayNum = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
function fyStartYearOf(label: string): number {
  const m = /FY(\d{2})/i.exec(label || "");
  return m ? 2000 + Number(m[1]) : new Date().getUTCFullYear();
}
// Calendar bounds (UTC day numbers) of a fiscal month. monthIndex 1=Apr … 12=Mar.
export function monthBounds(fiscalYear: string, monthIndex: number) {
  const startYear = fyStartYearOf(fiscalYear);
  const calMonth = ((monthIndex - 1 + 3) % 12) + 1;          // Apr(1)→4 … Mar(12)→3
  const year = monthIndex <= 9 ? startYear : startYear + 1;   // Apr–Dec = start year; Jan–Mar = next
  const startNum = Math.floor(Date.UTC(year, calMonth - 1, 1) / 86400000);
  const endNum = Math.floor(Date.UTC(year, calMonth, 0) / 86400000); // last day of month
  return { year, month0: calMonth - 1, startNum, endNum, dim: endNum - startNum + 1 };
}

export type CostSegment = { fromDay: number; toDay: number; days: number; empType: string | null; monthlyUsd: number; amountUsd: number };
// Prorated employee cost for ONE fiscal month — sums each (empType, CTC) period by the days it
// was in effect within the month, bounded by joining/exit dates. Calendar-day basis: a segment of
// d days costs (record annual ÷ 12) × d ÷ days-in-month. Multiple changes in a month are supported.
//
// windowStart/windowEnd (optional) — a specific deployment window (a project's own Deployment
// Start/End) to ALSO clip against, in the SAME pass as the joining/exit clip below, instead of
// the caller multiplying this function's result by a separate window fraction afterward. Doing it
// that way used to double-prorate: a new joiner's first monthly line has deploymentStart equal to
// their joiningDate, so computeMonthlyCostBreakdown already clipped to (joiningDate … month end)
// for the CTC segment AND createMonthlyLine's own deployedFraction() clipped to the identical
// (deploymentStart … month end) window again — squaring an ~8/30 fraction into ~0.27 × 0.27 and
// showing a few-dollar cost for a mid-month joiner instead of the correct partial-month amount.
// Passing the window in here bounds the day range exactly once.
// virtualCtcRecords (optional) — used ONLY by the CTC-approval forecast preview (GET /ctc-
// approvals/:id/forecast-preview): a real CtcRecord doesn't exist yet at preview time (it's only
// created inside POST /approve, before createMonthlyLine runs), so without this the preview always
// read zero CTC history for the employee and showed Cost as $0 for every month — Billing/Invoice/
// Est. Hours still came out right because those are derived from rateUsd/working-days, not CTC.
// Shaped exactly like a real CtcRecord (same fields ctcAnnualUsd reads); when provided, it's used
// in place of whatever's actually in the DB.
export async function computeMonthlyCostBreakdown(employeeId: number, fiscalYear: string, monthIndex: number, windowStart?: Date | string | null, windowEnd?: Date | string | null, virtualCtcRecords?: any[]):
  Promise<{ costUsd: number; segments: CostSegment[]; dim: number }> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { ctcRecords: { orderBy: { effectiveFrom: "asc" } } },
  });
  const { startNum, endNum, dim } = monthBounds(fiscalYear, monthIndex);
  const ctcRecords = virtualCtcRecords && virtualCtcRecords.length ? virtualCtcRecords : emp?.ctcRecords;
  if (!emp || !ctcRecords?.length) return { costUsd: 0, segments: [], dim };
  const fx = await prisma.fxRate.findFirst({ where: { context: "USD_INR" }, orderBy: { effectiveFrom: "desc" } });
  const rate = fx?.rate || 93;
  // Clip the month to the employee's active window (joining … exit) AND, if given, the specific
  // deployment window this cost is being computed for.
  let start = startNum, end = endNum;
  if (emp.joiningDate) start = Math.max(start, dayNum(emp.joiningDate));
  if (emp.exitDate) end = Math.min(end, dayNum(emp.exitDate));
  if (windowStart) start = Math.max(start, dayNum(new Date(windowStart)));
  if (windowEnd) end = Math.min(end, dayNum(new Date(windowEnd)));
  if (start > end) return { costUsd: 0, segments: [], dim };
  // Each record covers [effectiveFrom, effectiveTill]; effectiveTill null = open-ended. A record is
  // "active" on a day if the day is inside that window. When several overlap, the one with the
  // latest effectiveFrom wins. Days with no active record cost nothing (a gap).
  const recs = ctcRecords.map((r) => ({ rec: r, from: dayNum(r.effectiveFrom), till: r.effectiveTill ? dayNum(r.effectiveTill) : Infinity }));
  const pickFor = (d: number): any => {
    let pick: any = null, pickFrom = -Infinity;
    for (const x of recs) { if (x.from <= d && d <= x.till && x.from >= pickFrom) { pick = x.rec; pickFrom = x.from; } }
    return pick;
  };
  // Walk the active window day-by-day, grouping consecutive days under the same record into segments.
  const segments: CostSegment[] = [];
  let cur: { rec: any; fromDay: number; toDay: number } | null = null;
  for (let d = start; d <= end; d++) {
    const rec = pickFor(d);
    const id = rec ? rec.id : 0;
    if (cur && (cur.rec ? cur.rec.id : 0) === id) { cur.toDay = d; continue; }
    if (cur && cur.rec) {
      const days = cur.toDay - cur.fromDay + 1; const monthlyUsd = ctcAnnualUsd(cur.rec, rate) / 12;
      segments.push({ fromDay: cur.fromDay, toDay: cur.toDay, days, empType: cur.rec.empType || emp.empType || null, monthlyUsd, amountUsd: monthlyUsd * (days / dim) });
    }
    cur = { rec, fromDay: d, toDay: d };
  }
  if (cur && cur.rec) {
    const days = cur.toDay - cur.fromDay + 1; const monthlyUsd = ctcAnnualUsd(cur.rec, rate) / 12;
    segments.push({ fromDay: cur.fromDay, toDay: cur.toDay, days, empType: cur.rec.empType || emp.empType || null, monthlyUsd, amountUsd: monthlyUsd * (days / dim) });
  }
  const costUsd = segments.reduce((s, x) => s + x.amountUsd, 0);
  return { costUsd, segments, dim };
}
export async function computeMonthlyEmployeeCostUsd(employeeId: number, fiscalYear: string, monthIndex: number, windowStart?: Date | string | null, windowEnd?: Date | string | null, virtualCtcRecords?: any[]): Promise<number> {
  return (await computeMonthlyCostBreakdown(employeeId, fiscalYear, monthIndex, windowStart, windowEnd, virtualCtcRecords)).costUsd;
}

export async function computeEmployeeCost(employeeId: number, asOf?: Date) {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { ctcRecords: { orderBy: { effectiveFrom: "desc" } } },
  });
  if (!emp) return null;
  const ctc = emp.ctcRecords.find((c) => !asOf || c.effectiveFrom <= asOf) || emp.ctcRecords[0];
  const fx = await prisma.fxRate.findFirst({ where: { context: "USD_INR" }, orderBy: { effectiveFrom: "desc" } });
  const rate = fx?.rate || 93;
  if (!ctc) return { employeeId, name: emp.name, monthlyInr: 0, annualInr: 0, annualUsd: 0, usEngagement: null, rateBasis: null, hourlyCostUsd: null, dayRateUsd: null, hoursPerDay: null };
  const fixed = ctc.basic + ctc.hra + ctc.otherAllowance + ctc.specialAllowance;
  const flexi = ctc.conveyance + ctc.communication + ctc.meals + ctc.books + ctc.driver + ctc.uniform;
  const monthlyInr = fixed + flexi;
  const annualInr = monthlyInr * 12 + ctc.bonusAnnual;
  const annualUsd = ctc.annualCostOverride ?? annualInr / rate;
  // Hourly-CTC engagements (US W2/No-Benefit, Vendor) expose their cost hourly rate so a
  // resource line's cost can be computed as hourlyCost × billable hours instead of annual/12.
  return {
    employeeId, name: emp.name, monthlyInr, annualInr, annualUsd, fxRate: rate,
    usEngagement: (ctc as any).usEngagement || null,
    rateBasis: (ctc as any).rateBasis || null,
    hourlyCostUsd: (ctc as any).hourlyRateUsd ?? null,
    dayRateUsd: (ctc as any).dayRateUsd ?? null,
    hoursPerDay: (ctc as any).hoursPerDay ?? null,
  };
}

/**
 * Finance P&L — mirrors the Actual Cost summary block (rows 1-7) per month.
 * Each metric uses the workbook's summary cell when valid, else a computed
 * fallback (for cells the source left as #REF!/blank, e.g. projection months).
 */
export const getDashboard = memoizeAsync(getDashboardImpl, 30_000);

async function getFinancePnlImpl(fiscalYear: string, month: string = "ALL") {
  // getDashboard() already applies the locked-month Excel-parity override to monthlyRevenue/
  // monthlyCost/monthlySalary (see the comment there) — the Executive/CEO dashboard reads the
  // exact same arrays, so this is the ONE place that override logic lives now. Only
  // monthlyProfit/netProfitPct are Finance-specific stored fields getDashboard() doesn't carry,
  // so those two alone still need their own lock-aware lookup here.
  const d = await getDashboard(fiscalYear);  // full-year arrays for the table/charts
  const summaries = await prisma.actualCostSummary.findMany({ where: { fiscalYear }, orderBy: { monthIndex: "asc" } });
  const byMonth = new Map(summaries.map((s) => [s.month, s]));
  const sheets = await prisma.monthlySheet.findMany({ where: { fiscalYear }, select: { month: true, status: true } });
  const lockedMonth = new Map(sheets.map((sh) => [sh.month, sh.status === "LOCKED"]));

  const rows = d.months.map((m, i) => {
    const s = lockedMonth.get(m) ? byMonth.get(m) : undefined;
    const salaryExpense = d.monthlySalary[i];
    const totalCost = d.monthlyCost[i];
    const revenue = d.monthlyRevenue[i];
    const monthlyProfit = s?.monthlyProfit ?? (revenue - totalCost);
    const netProfitPct = (s?.netProfitPct != null ? s.netProfitPct * 100 : (revenue ? (monthlyProfit / revenue) * 100 : 0));
    return {
      month: m, monthIndex: i,
      // Head counts are ALWAYS computed from the month's lines, locked or not. The stored
      // summary freezes the workbook's MONEY cells for Excel parity, but its headcount cells
      // were a one-time import that nothing updates — so a locked month kept reporting the
      // original workbook figure while its own resource rows said otherwise, and the Workforce
      // drill-down (which always lists the live rows) disagreed with its own heading.
      // Counting the rows that actually exist is the only answer that can't drift.
      headCount: d.monthlyHeadcount[i],
      billableHeadCount: d.monthlyBillable[i],
      offshoreBillable: d.monthlyOffshoreHC[i],
      onsiteBillable: d.monthlyOnsiteHC[i],
      nonBillableAssigned: d.workforce.assigned[i], // non-billable but ASSIGNED to a customer project (e.g. Harsh Mittal on Bastian)
      bench: d.workforce.bench[i],          // bench resources (non-billable on GenAquarius Bench)
      corporate: d.workforce.shadow[i],     // non-billable resources on a real/corporate project
      doubleDip: d.workforce.doubleDip[i],  // resources on 2+ billable projects
      salaryExpense, totalCost, revenue, monthlyProfit, netProfitPct,
    };
  });

  const scoped = rows.filter((r) => month === "ALL" || r.month === month);
  const sum = (k: keyof (typeof rows)[number]) => scoped.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totalRevenue = sum("revenue");

  // Per-project breakdown — scope to the selected month (else full year)
  const projects = month === "ALL"
    ? d.projects
    : d.projects
        .map((p) => {
          const mm = p.monthly[month] || { rev: 0, cost: 0 };
          const profit = mm.rev - mm.cost;
          return { ...p, revenue: mm.rev, cost: mm.cost, profit, margin: mm.rev ? (profit / mm.rev) * 100 : 0 };
        })
        .filter((p) => p.revenue !== 0 || p.cost !== 0)
        .sort((a, b) => b.revenue - a.revenue);
  // Cost-center breakdown scoped to the selected month (else full year), ties to grid Total Cost.
  const mi = month === "ALL" ? -1 : d.months.indexOf(month);
  const costBreakdown = d.costBreakdown
    .map((c) => ({ category: c.category, cost: mi < 0 ? c.monthly.reduce((a, b) => a + b, 0) : c.monthly[mi] }))
    .filter((c) => Math.abs(c.cost) > 0.005);
  const costType = d.costType
    .map((c) => ({ category: c.category, cost: mi < 0 ? c.monthly.reduce((a, b) => a + b, 0) : c.monthly[mi] }))
    .filter((c) => Math.abs(c.cost) > 0.005);

  const totalCost = sum("totalCost");
  const totalSalary = sum("salaryExpense");
  const yearProfit = sum("monthlyProfit");
  const transferPricing = totalRevenue * 0.15;
  const tax = transferPricing * 0.26;

  // Reference month for the roll-up tiles: the selected month (else Apr). This makes
  // Revenue Run-Rate, Cash Flow 30/60 and Internal Cost reflect the chosen month
  // instead of always showing Apr/May / full-year.
  const rmi = month === "ALL" ? 0 : Math.max(0, d.months.indexOf(month));
  const refRev = rows[rmi]?.revenue || 0;
  const refCost = rows[rmi]?.totalCost || 0;
  const nextRev = rows[rmi + 1]?.revenue || 0;
  const nextCost = rows[rmi + 1]?.totalCost || 0;
  // Internal/overhead cost scoped to the selected month (full year when ALL).
  const internalCostScoped = month === "ALL"
    ? d.internalCost
    : d.costBreakdown.filter((c) => !CTC_CAT_ORDER.includes(c.category)).reduce((s, c) => s + (c.monthly[rmi] || 0), 0);

  return {
    fiscalYear, month, months: d.months,
    rows,
    // arrays for charts
    monthlyRevenue: rows.map((r) => r.revenue),
    monthlyCost: rows.map((r) => r.totalCost),
    monthlySalary: rows.map((r) => r.salaryExpense),
    monthlyProfit: rows.map((r) => r.monthlyProfit),
    monthlyHeadcount: rows.map((r) => r.headCount),
    monthlyBillable: rows.map((r) => r.billableHeadCount),
    // year (or scoped) totals
    totalRevenue, totalCost, totalSalary, yearProfit,
    revenueRunRate: refRev * 12,
    transferPricing, tax,
    netProfitAfterTax: yearProfit - tax,
    cashFlow30: refRev - refCost,
    cashFlow60: refRev + nextRev - refCost - nextCost,
    projects,
    internalCost: internalCostScoped,
    // per-month roster of "Name (Project)" strings per category, for the row drill-down popup
    rosterByMonth: d.workforce.rosterByMonth,
    costBreakdown, costType,
  };
}

export const getFinancePnl = memoizeAsync(getFinancePnlImpl, 30_000);

/** Accounts Receivable + cash from external ledger (Tally/BoA). */
async function getReceivablesImpl() {
  const ledger = await prisma.externalLedger.findMany({ where: { type: "AR" } });
  const balances = await prisma.externalLedger.findMany({ where: { type: "BALANCE" } });
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ["SENT", "OVERDUE"] } },
    include: { client: true },
  });
  const today = new Date();
  const aging = invoices.map((inv) => {
    const days = Math.floor((today.getTime() - new Date(inv.dueDate).getTime()) / 86400000);
    return {
      invoiceNo: inv.invoiceNo, client: inv.client.name, amount: inv.totalAmount,
      currency: inv.currency, dueDate: inv.dueDate, daysPastDue: days, past30: days > 0,
    };
  });
  const cashPosition = balances.reduce((s, b) => s + b.amount, 0);
  const totalAR = ledger.reduce((s, l) => s + l.amount, 0) + aging.reduce((s, a) => s + a.amount, 0);
  return { totalAR, cashPosition, aging: aging.sort((a, b) => b.daysPastDue - a.daysPastDue), externalAR: ledger };
}

export const getReceivables = memoizeAsync(getReceivablesImpl, 30_000);
