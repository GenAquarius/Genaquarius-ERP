// AI Report — curated tool catalog (Tiers 1–2).
//
// Claude never sees the database or writes SQL. It can only call the safe,
// parameterized functions below, each backed by a Prisma query. Claude maps a
// natural-language prompt to one or more of these tools, we execute them, and
// Claude formats the real numbers into a "report spec" the frontend renders.
//
// To teach the assistant a new metric, add ONE entry to DATA_TOOLS — the page,
// the route and the renderer all stay unchanged. That is the Tier-2 growth path.
import { prisma } from "../prisma";
import { MONTHS } from "./calc";

export interface ToolCtx { fy: string }
export interface DataTool {
  name: string;
  description: string;
  input_schema: any;
  run: (args: any, ctx: ToolCtx) => Promise<any>;
}

// ---------------------------------------------------------------------------
// Shared loader — one read of the fiscal year's monthly lines, flattened so each
// tool can reduce over exactly what it needs (segment, project, expense bucket).
// ---------------------------------------------------------------------------
interface FlatLine {
  mi: number; month: string; resource: string; project: string;
  deliveryModel: string; geo: string; isCustomer: boolean; isExpense: boolean; isBillable: boolean;
  expenseType: string; cost: number; rev: number; currency: string; nativeAmount: number | null;
  empLocation: string | null; empType: string | null;
  client: string; state: string; // the project's client and that client's State (Client.state; "" when not set)
}
async function loadLines(fy: string): Promise<FlatLine[]> {
  const sheets = await prisma.monthlySheet.findMany({
    where: { fiscalYear: fy },
    include: { lines: { include: { employee: { select: { location: true, empType: true } }, project: { include: { client: { include: { geography: true } } } } } } },
  });
  const out: FlatLine[] = [];
  for (const sheet of sheets) {
    const mi = sheet.monthIndex - 1;
    for (const line of sheet.lines) {
      const isCustomer = !line.isExpense;
      out.push({
        mi, month: sheet.month,
        resource: line.resourceName,
        project: line.projectName || line.project?.name || (isCustomer ? "Unassigned" : "Other"),
        deliveryModel: line.project?.deliveryModel || "OFFSHORE",
        geo: line.project?.client?.geography?.code || (isCustomer ? "US" : "INTERNAL"),
        isCustomer, isExpense: line.isExpense, isBillable: (line as any).isBillable !== false,
        expenseType: (line as any).expenseType || "VARIABLE",
        cost: line.costUsd || 0, rev: line.invoiceAmount || 0,
        currency: line.currency || "USD", nativeAmount: line.nativeAmount ?? null,
        empLocation: line.employee?.location || null, empType: line.employee?.empType || null,
        client: line.project?.client?.name || "", state: ((line.project?.client as any)?.state || "").trim(),
      });
    }
  }
  return out;
}

const z12 = () => new Array(12).fill(0);
const sets12 = () => Array.from({ length: 12 }, () => new Set<string>());
const round = (n: number) => Math.round((n || 0) * 100) / 100;
const matchMonth = (m: string | undefined) => {
  if (!m || m.toUpperCase() === "ALL") return -1;
  const i = MONTHS.findIndex((x) => x.toLowerCase() === m.toLowerCase());
  return i; // -1 if not found
};

// ---------------------------------------------------------------------------
// Formula knowledge base — grounds "explain how X is calculated" answers in the
// actual engine logic (calc.ts) instead of letting the model guess.
// ---------------------------------------------------------------------------
export const FORMULA_KB: Record<string, string> = {
  "billing amount": "Billing Amount = Rate (USD) × Estimated Hours. It is the planned/forecast bill for the month (sheet column G).",
  "invoice amount": "Invoice Amount = Rate (USD) × Actual Hours (× FX multiplier for Canada). This is the real revenue recognised for a billable resource line (sheet column I).",
  "revenue": "Revenue = sum of Invoice Amounts across all billable (customer) resource lines for the period. Internal/expense lines never add revenue.",
  "cost": "Cost (USD) for a billable resource = the resource's monthly CTC cost (Actual Cost sheet, stored in USD). For an expense line it is the vendor/overhead amount converted to USD via the dated FX rate.",
  "ctc": "Monthly CTC = basic + hra + otherAllowance + specialAllowance + conveyance + communication + meals + books + driver + uniform. Annual CTC = monthly × 12 + bonusAnnual. USD = annualCostOverride if set, else annualINR ÷ USD_INR rate.",
  "profit": "Monthly Profit = Revenue − Total Cost. Margin % = Profit ÷ Revenue × 100.",
  "ebitda": "EBITDA = Total Revenue − Customer (delivery) Cost − Internal/overhead Cost. EBITDA Margin = EBITDA ÷ Total Revenue × 100.",
  "transfer pricing": "Transfer Pricing = Total Revenue × 15% (intra-company charge assumption).",
  "tax": "Tax = Transfer Pricing × 26%. Net Profit After Tax = Year Profit − Tax.",
  "fixed vs variable": "Cost is split into Fixed Overhead and Variable Overhead (by each expense line's expenseType) plus Resource/Delivery (CTC) for billable resources.",
  "fx": "USD conversion uses the latest dated FxRate: INR amounts ÷ USD_INR rate; CAD amounts × CANADA_FACTOR (CAD→USD).",
  "receivables": "Accounts Receivable = open invoices (SENT/OVERDUE) totals + external AR ledger (Tally). Cash Position = sum of BALANCE rows (Bank of America).",
};

// ---------------------------------------------------------------------------
// DATA TOOLS
// ---------------------------------------------------------------------------
export const DATA_TOOLS: DataTool[] = [
  {
    name: "get_average_salary",
    description:
      "Average monthly salary/CTC cost (USD) per billable resource, optionally split by delivery segment (offshore/onsite) or per project, monthly and/or annually. Use for questions like 'average salary for offshore for the current financial year, monthly and annually'.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string", description: "Fiscal year label, e.g. FY26-27. Omit to use the current one." },
        segment: { type: "string", enum: ["OFFSHORE", "ONSITE", "ALL"], description: "Delivery segment filter. Default ALL." },
        byProject: { type: "boolean", description: "If true, also break the average down per project." },
      },
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const seg = (args.segment || "ALL").toUpperCase();
      const lines = (await loadLines(fy)).filter((l) => l.isCustomer);
      const inSeg = (l: FlatLine) => seg === "ALL" || (seg === "ONSITE" ? l.deliveryModel === "ONSITE" : l.deliveryModel !== "ONSITE");
      const scoped = lines.filter(inSeg);
      const costM = z12(); const hcM = sets12();
      for (const l of scoped) { costM[l.mi] += l.cost; if (l.cost > 0) hcM[l.mi].add(l.resource); }
      const avgMonthly = costM.map((c, i) => round(hcM[i].size ? c / hcM[i].size : 0));
      const totalCost = costM.reduce((a, b) => a + b, 0);
      const allRes = new Set(scoped.filter((l) => l.cost > 0).map((l) => l.resource));
      const avgAnnualPerResource = round(allRes.size ? totalCost / allRes.size : 0);
      const result: any = {
        fiscalYear: fy, segment: seg, months: MONTHS,
        avgMonthlySalaryByMonth: avgMonthly,
        headcountByMonth: hcM.map((s) => s.size),
        totalSalaryCost: round(totalCost),
        distinctResources: allRes.size,
        avgAnnualSalaryPerResource: avgAnnualPerResource,
      };
      if (args.byProject) {
        const byProj = new Map<string, { cost: number; res: Set<string> }>();
        for (const l of scoped) {
          if (!byProj.has(l.project)) byProj.set(l.project, { cost: 0, res: new Set() });
          const p = byProj.get(l.project)!; p.cost += l.cost; if (l.cost > 0) p.res.add(l.resource);
        }
        result.byProject = [...byProj.entries()].map(([project, v]) => ({
          project, totalCost: round(v.cost), resources: v.res.size,
          avgAnnualPerResource: round(v.res.size ? v.cost / v.res.size : 0),
        })).sort((a, b) => b.totalCost - a.totalCost);
      }
      return result;
    },
  },

  {
    name: "get_project_revenue",
    description:
      "Per-project (customer) revenue, cost, profit and margin for the fiscal year, with monthly revenue arrays. Use for 'project-wise revenue' style reports.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        month: { type: "string", description: "A single month (Apr..Mar) to scope to, or ALL for the full year. Default ALL." },
      },
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const mi = matchMonth(args.month);
      const lines = (await loadLines(fy)).filter((l) => l.isCustomer);
      const map = new Map<string, { project: string; geo: string; deliveryModel: string; rev: number[]; cost: number[] }>();
      for (const l of lines) {
        if (!map.has(l.project)) map.set(l.project, { project: l.project, geo: l.geo, deliveryModel: l.deliveryModel, rev: z12(), cost: z12() });
        const p = map.get(l.project)!; p.rev[l.mi] += l.rev; p.cost[l.mi] += l.cost;
      }
      const rows = [...map.values()].map((p) => {
        const revenue = mi < 0 ? p.rev.reduce((a, b) => a + b, 0) : p.rev[mi];
        const cost = mi < 0 ? p.cost.reduce((a, b) => a + b, 0) : p.cost[mi];
        const profit = revenue - cost;
        return {
          project: p.project, geo: p.geo,
          deliveryModel: p.deliveryModel === "ONSITE" ? "Onsite" : "Offshore",
          revenue: round(revenue), cost: round(cost), profit: round(profit),
          margin: round(revenue ? (profit / revenue) * 100 : 0),
          monthlyRevenue: p.rev.map(round),
        };
      }).filter((r) => r.revenue !== 0 || r.cost !== 0).sort((a, b) => b.revenue - a.revenue);
      return {
        fiscalYear: fy, scope: mi < 0 ? "Full Year" : args.month, months: MONTHS,
        projects: rows,
        totals: {
          revenue: round(rows.reduce((s, r) => s + r.revenue, 0)),
          cost: round(rows.reduce((s, r) => s + r.cost, 0)),
          profit: round(rows.reduce((s, r) => s + r.profit, 0)),
        },
      };
    },
  },

  {
    name: "get_revenue_by_state",
    description:
      "STATE-wise revenue report: all customer revenue (plus cost, profit, margin) grouped by the State set on each Client (Clients page → State), with the clients/projects that make up each state and monthly revenue arrays. A client's whole revenue is listed under its one state (e.g. Station Casinos → Nevada, Bastian → Kentucky). Clients with no State set are grouped under 'No state set' — mention that so the user can fill it in. Use for 'state wise revenue', 'revenue by state/province'. Render a bar chart of revenue per state AND a table (state, clients, revenue, cost, profit, margin).",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string", description: "Fiscal year label, e.g. FY26-27. Omit to use the one selected on the page." },
        month: { type: "string", description: "A single month (Apr..Mar) to scope to, or ALL for the full year. Default ALL." },
      },
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const mi = matchMonth(args.month);
      const lines = (await loadLines(fy)).filter((l) => l.isCustomer);
      // alignRevenue (optional, 12 values Apr..Mar): the Finance Dashboard's own monthly revenue. For
      // months where it differs from the sum of invoice lines (locked months show saved workbook
      // figures), each client's revenue that month is scaled by the same factor, so the state rows add
      // up to the dashboard exactly while keeping every client's share of the month.
      const align: number[] | null = Array.isArray(args.alignRevenue) && args.alignRevenue.length === 12 ? args.alignRevenue.map(Number) : null;
      let revenueAdjustment = 0;
      if (align) {
        const lineRev = z12(); for (const l of lines) lineRev[l.mi] += l.rev;
        const factor = lineRev.map((v, i) => (v > 0 && Number.isFinite(align[i]) ? align[i] / v : 1));
        const before = lines.reduce((s, l) => s + l.rev, 0);
        for (const l of lines) l.rev *= factor[l.mi];
        revenueAdjustment = round(lines.reduce((s, l) => s + l.rev, 0) - before);
      }
      type Agg = { state: string; rev: number[]; cost: number[]; clients: Map<string, { rev: number; cost: number; projects: Set<string> }> };
      const byState = new Map<string, Agg>();
      for (const l of lines) {
        const key = l.state || "No state set";
        if (!byState.has(key)) byState.set(key, { state: key, rev: z12(), cost: z12(), clients: new Map() });
        const s = byState.get(key)!;
        s.rev[l.mi] += l.rev; s.cost[l.mi] += l.cost;
        const cname = l.client || "(no client)";
        if (!s.clients.has(cname)) s.clients.set(cname, { rev: 0, cost: 0, projects: new Set() });
        const c = s.clients.get(cname)!;
        if (mi < 0 || l.mi === mi) { c.rev += l.rev; c.cost += l.cost; }
        c.projects.add(l.project);
      }
      const rows = [...byState.values()].map((s) => {
        const revenue = mi < 0 ? s.rev.reduce((a, b) => a + b, 0) : s.rev[mi];
        const cost = mi < 0 ? s.cost.reduce((a, b) => a + b, 0) : s.cost[mi];
        const profit = revenue - cost;
        return {
          state: s.state,
          clients: [...s.clients.entries()].map(([client, v]) => ({ client, revenue: round(v.rev), cost: round(v.cost), projects: [...v.projects] })).sort((a, b) => b.revenue - a.revenue),
          revenue: round(revenue), cost: round(cost), profit: round(profit),
          margin: round(revenue ? (profit / revenue) * 100 : 0),
          monthlyRevenue: s.rev.map(round),
        };
      }).filter((r) => r.revenue !== 0 || r.cost !== 0).sort((a, b) => b.revenue - a.revenue);
      return {
        fiscalYear: fy, scope: mi < 0 ? "Full Year" : args.month, months: MONTHS,
        states: rows, revenueAdjustment,
        clientsWithoutState: rows.find((r) => r.state === "No state set")?.clients.map((c) => c.client) || [],
        totals: {
          revenue: round(rows.reduce((s, r) => s + r.revenue, 0)),
          cost: round(rows.reduce((s, r) => s + r.cost, 0)),
          profit: round(rows.reduce((s, r) => s + r.profit, 0)),
        },
      };
    },
  },

  {
    name: "compare_month_over_month",
    description:
      "Explains WHY a month's revenue/expense moved vs the previous month: per-project revenue delta and per-expense-bucket delta, each tagged ADDED/REMOVED/INCREASED/DECREASED/UNCHANGED, plus the net revenue/cost/profit change. Use for 'why is this month's revenue/expense more or less than last month', 'explain the increase/decrease vs previous month by project'. Always render this as a chart (e.g. a bar of each project's delta) AND a table, never text alone — the whole point is a visual line-by-line breakdown.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        month: { type: "string", description: "The month to explain (Apr..Mar) — compared against the month immediately before it (wrapping to the previous fiscal year's March if this is April)." },
      },
      required: ["month"],
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const mi = matchMonth(args.month);
      if (mi < 0) throw new Error("A specific month (not ALL) is required to compare against the previous month.");
      let prevFy = fy, prevMi = mi - 1;
      if (prevMi < 0) {
        const m = /FY(\d+)-(\d+)/.exec(fy);
        prevFy = m ? `FY${(+m[1] - 1).toString().padStart(2, "0")}-${(+m[2] - 1).toString().padStart(2, "0")}` : fy;
        prevMi = 11;
      }
      const curLines = (await loadLines(fy)).filter((l) => l.mi === mi);
      const prevLines = prevFy === fy ? (await loadLines(fy)).filter((l) => l.mi === prevMi) : (await loadLines(prevFy)).filter((l) => l.mi === prevMi);
      const byKey = (lines: FlatLine[], isCustomer: boolean) => {
        const m = new Map<string, number>();
        for (const l of lines.filter((x) => x.isCustomer === isCustomer)) m.set(l.project, (m.get(l.project) || 0) + (isCustomer ? l.rev : l.cost));
        return m;
      };
      const diffRows = (curMap: Map<string, number>, prevMap: Map<string, number>) => {
        const keys = new Set([...curMap.keys(), ...prevMap.keys()]);
        return [...keys].map((k) => {
          const cur = round(curMap.get(k) || 0), prev = round(prevMap.get(k) || 0), delta = round(cur - prev);
          const status = !prevMap.has(k) ? "ADDED" : !curMap.has(k) ? "REMOVED" : delta > 0.005 ? "INCREASED" : delta < -0.005 ? "DECREASED" : "UNCHANGED";
          return { name: k, current: cur, previous: prev, delta, status };
        }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      };
      const revenueByProject = diffRows(byKey(curLines, true), byKey(prevLines, true));
      const expenseByBucket = diffRows(byKey(curLines, false), byKey(prevLines, false));
      const sum = (rows: { current: number; previous: number }[], key: "current" | "previous") => round(rows.reduce((s, r) => s + r[key], 0));
      const curRev = sum(revenueByProject, "current"), prevRev = sum(revenueByProject, "previous");
      const curCost = sum(expenseByBucket, "current") + curLines.filter((l) => l.isCustomer).reduce((s, l) => s + l.cost, 0);
      const prevCost = sum(expenseByBucket, "previous") + prevLines.filter((l) => l.isCustomer).reduce((s, l) => s + l.cost, 0);
      return {
        month: args.month, fiscalYear: fy, previousMonth: prevFy === fy ? MONTHS[prevMi] : `${MONTHS[prevMi]} ${prevFy}`,
        revenueByProject, expenseByBucket,
        summary: {
          revenue: { current: curRev, previous: prevRev, delta: round(curRev - prevRev) },
          cost: { current: round(curCost), previous: round(prevCost), delta: round(curCost - prevCost) },
          profit: { current: round(curRev - curCost), previous: round(prevRev - prevCost), delta: round((curRev - curCost) - (prevRev - prevCost)) },
        },
      };
    },
  },

  {
    name: "list_expenses",
    description:
      "List expense / overhead lines (non-billable) for the fiscal year, grouped by expense bucket with monthly amounts. Use for 'show all expenses'. Optionally scope to a month or filter by a name fragment.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        month: { type: "string", description: "Single month or ALL. Default ALL." },
        nameContains: { type: "string", description: "Optional case-insensitive filter on the expense bucket name." },
      },
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const mi = matchMonth(args.month);
      const filter = (args.nameContains || "").toLowerCase();
      const lines = (await loadLines(fy)).filter((l) => l.isExpense && (!filter || l.project.toLowerCase().includes(filter)));
      const map = new Map<string, { name: string; type: string; monthly: number[] }>();
      for (const l of lines) {
        if (!map.has(l.project)) map.set(l.project, { name: l.project, type: l.expenseType, monthly: z12() });
        map.get(l.project)!.monthly[l.mi] += l.cost;
      }
      const rows = [...map.values()].map((e) => ({
        name: e.name, type: e.type === "FIXED" ? "Fixed" : "Variable",
        amount: round(mi < 0 ? e.monthly.reduce((a, b) => a + b, 0) : e.monthly[mi]),
        monthly: e.monthly.map(round),
      })).filter((r) => Math.abs(r.amount) > 0.005).sort((a, b) => b.amount - a.amount);
      return {
        fiscalYear: fy, scope: mi < 0 ? "Full Year" : args.month, months: MONTHS,
        expenses: rows, totalExpense: round(rows.reduce((s, r) => s + r.amount, 0)),
      };
    },
  },

  {
    name: "get_expense_detail",
    description:
      "Detailed monthly breakdown of ONE named expense bucket for the fiscal year, including which months it occurs and its currency. Use for 'show and explain the detail of <expense> for a month/year'.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        name: { type: "string", description: "Expense bucket name or fragment to look up (e.g. 'Rent', 'Insurance')." },
        month: { type: "string", description: "Optional single month to highlight." },
      },
      required: ["name"],
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const frag = (args.name || "").toLowerCase();
      const lines = (await loadLines(fy)).filter((l) => l.isExpense && l.project.toLowerCase().includes(frag));
      if (!lines.length) return { fiscalYear: fy, name: args.name, found: false, message: `No expense bucket matching "${args.name}" in ${fy}.` };
      const monthly = z12();
      const native: Record<string, { currency: string; amount: number }> = {};
      let type = "VARIABLE";
      for (const l of lines) {
        monthly[l.mi] += l.cost; type = l.expenseType;
        if (l.nativeAmount != null && l.currency !== "USD") {
          native[l.month] = { currency: l.currency, amount: round((native[l.month]?.amount || 0) + l.nativeAmount) };
        }
      }
      const detail = MONTHS.map((m, i) => ({ month: m, amountUsd: round(monthly[i]), native: native[m] || null }))
        .filter((d) => Math.abs(d.amountUsd) > 0.005 || d.native);
      return {
        fiscalYear: fy, name: lines[0].project, found: true,
        type: type === "FIXED" ? "Fixed" : "Variable",
        totalUsd: round(monthly.reduce((a, b) => a + b, 0)),
        monthlyDetail: detail,
        derivation: FORMULA_KB.cost + " " + FORMULA_KB.fx,
      };
    },
  },

  {
    name: "explain_formula",
    description:
      "Explain how a metric or expense is calculated in this platform (the real engine formula). Use for 'explain how the formula of <expense/metric> works'. Returns the grounded formula text to base the explanation on.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to explain, e.g. 'cost', 'EBITDA', 'invoice amount', 'CTC', 'tax', 'transfer pricing', 'FX'." },
      },
      required: ["topic"],
    },
    run: async (args) => {
      const t = (args.topic || "").toLowerCase();
      const hits = Object.entries(FORMULA_KB).filter(([k]) => t.includes(k) || k.includes(t));
      return {
        topic: args.topic,
        formulas: (hits.length ? hits : Object.entries(FORMULA_KB)).map(([key, text]) => ({ key, text })),
        note: hits.length ? "Grounded formula(s) for the requested topic." : "No exact match — full formula reference returned; explain the most relevant.",
      };
    },
  },

  {
    name: "get_timesheet_non_submitters",
    description:
      "List employees who did NOT submit a timesheet for a given calendar month and year (across all their assigned projects). Use for 'who all did not submit timesheet for <month>'.",
    input_schema: {
      type: "object",
      properties: {
        month: { type: "number", description: "Calendar month 1-12 (e.g. 11 for November)." },
        year: { type: "number", description: "Calendar year, e.g. 2025." },
      },
      required: ["month", "year"],
    },
    run: async (args) => {
      const month = Number(args.month); const year = Number(args.year);
      const employees = await prisma.employee.findMany({
        where: { exitDate: null },
        include: { projects: { include: { project: true } } },
      });
      const sheets = await prisma.timesheet.findMany({
        where: { periodMonth: month, periodYear: year, status: { not: "DRAFT" } },
        select: { employeeId: true },
      });
      const submitted = new Set(sheets.map((s) => s.employeeId));
      const assigned = employees.filter((e) => e.projects.length > 0);
      const nonSubmitters = assigned.filter((e) => !submitted.has(e.id)).map((e) => ({
        name: e.name, email: e.email || "—",
        projects: e.projects.map((p) => p.project.name).join(", ") || "—",
      }));
      return {
        month, year, totalAssigned: assigned.length,
        submittedCount: assigned.length - nonSubmitters.length,
        nonSubmitterCount: nonSubmitters.length,
        nonSubmitters,
      };
    },
  },

  {
    name: "forecast_revenue",
    description:
      "What-if revenue forecast: take the fiscal year's baseline monthly revenue and add hypothetical resources starting in given months, each billing at an assumed monthly rate. Use for 'forecast revenue if I add 5 resources in Nov and 5 in Dec'. If monthlyRatePerResource is omitted, the current average revenue per billable resource is used.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        additions: {
          type: "array",
          description: "Hypothetical headcount additions.",
          items: {
            type: "object",
            properties: {
              month: { type: "string", description: "Fiscal month the resources join (Apr..Mar)." },
              count: { type: "number" },
              segment: { type: "string", enum: ["OFFSHORE", "ONSITE"], description: "Optional — picks the segment's avg rate. Default OFFSHORE." },
            },
            required: ["month", "count"],
          },
        },
        monthlyRatePerResource: { type: "number", description: "Optional assumed billing per added resource per month (USD)." },
      },
      required: ["additions"],
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      const lines = (await loadLines(fy)).filter((l) => l.isCustomer);
      const baseRev = z12();
      const billSets = sets12(); const onsiteSets = sets12(); const offSets = sets12();
      for (const l of lines) {
        baseRev[l.mi] += l.rev;
        if (l.rev > 0) { billSets[l.mi].add(l.resource); (l.deliveryModel === "ONSITE" ? onsiteSets : offSets)[l.mi].add(l.resource); }
      }
      // average revenue per billable resource (overall + per segment), used when no explicit rate given
      const avgPerResource = (sets: Set<string>[], rev: number[]) => {
        let r = 0, c = 0; for (let i = 0; i < 12; i++) { r += rev[i]; c += sets[i].size; }
        return c ? r / c : 0;
      };
      const onsiteRev = z12(), offRev = z12();
      for (const l of lines) { (l.deliveryModel === "ONSITE" ? onsiteRev : offRev)[l.mi] += l.rev; }
      const avgAll = avgPerResource(billSets, baseRev);
      const avgOnsite = avgPerResource(onsiteSets, onsiteRev) || avgAll;
      const avgOffshore = avgPerResource(offSets, offRev) || avgAll;

      const added = z12();
      const assumptions: any[] = [];
      for (const a of args.additions || []) {
        const mi = matchMonth(a.month);
        if (mi < 0) continue;
        const seg = (a.segment || "OFFSHORE").toUpperCase();
        const rate = args.monthlyRatePerResource || (seg === "ONSITE" ? avgOnsite : avgOffshore);
        const count = Number(a.count) || 0;
        for (let i = mi; i < 12; i++) added[i] += count * rate; // bill from join month to year-end
        assumptions.push({ month: a.month, count, segment: seg, monthlyRatePerResource: round(rate) });
      }
      const forecast = baseRev.map((b, i) => round(b + added[i]));
      return {
        fiscalYear: fy, months: MONTHS,
        baselineRevenue: baseRev.map(round),
        addedRevenue: added.map(round),
        forecastRevenue: forecast,
        baselineTotal: round(baseRev.reduce((a, b) => a + b, 0)),
        forecastTotal: round(forecast.reduce((a, b) => a + b, 0)),
        upliftTotal: round(added.reduce((a, b) => a + b, 0)),
        assumptions,
        ratesUsed: { avgAll: round(avgAll), avgOnsite: round(avgOnsite), avgOffshore: round(avgOffshore) },
      };
    },
  },

  {
    name: "get_headcount_by_project",
    description:
      "Headcount for a single month, broken down per project by delivery segment (onsite/offshore) and billable vs non-billable, plus company totals. Use for 'project-wise headcount — onsite, offshore, billable, non-billable and total'. Billable/Non-billable uses each resource's billable flag.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        month: { type: "string", description: "Fiscal month name (Apr..Mar). Omit to use the current calendar month." },
      },
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      let mi = matchMonth(args.month);
      if (mi < 0) mi = (new Date().getMonth() - 3 + 12) % 12; // current calendar month → fiscal index (Apr=0)
      const month = MONTHS[mi];
      const lines = (await loadLines(fy)).filter((l) => l.isCustomer && l.mi === mi && (l.cost > 0 || l.rev > 0));

      // Per-project resource ledger; a resource is billable if any of its lines is billable.
      const projs = new Map<string, { project: string; geo: string; segment: string; res: Map<string, boolean> }>();
      for (const l of lines) {
        if (!projs.has(l.project)) projs.set(l.project, { project: l.project, geo: l.geo, segment: l.deliveryModel === "ONSITE" ? "Onsite" : "Offshore", res: new Map() });
        const g = projs.get(l.project)!;
        g.res.set(l.resource, (g.res.get(l.resource) || false) || l.isBillable);
      }
      const classify = (res: Map<string, boolean>) => {
        let bill = 0, non = 0;
        for (const isB of res.values()) { if (isB) bill++; else non++; }
        return { billable: bill, nonBillable: non, total: bill + non };
      };
      const projects = [...projs.values()]
        .map((g) => ({ project: g.project, geo: g.geo, segment: g.segment, ...classify(g.res) }))
        .filter((r) => r.total > 0).sort((a, b) => b.total - a.total);

      // Company totals — count each person once (primary segment = onsite if any onsite work).
      const person = new Map<string, { billable: boolean; onsite: boolean; offshore: boolean }>();
      for (const l of lines) {
        const p = person.get(l.resource) || { billable: false, onsite: false, offshore: false };
        p.billable = p.billable || l.isBillable;
        if (l.deliveryModel === "ONSITE") p.onsite = true; else p.offshore = true;
        person.set(l.resource, p);
      }
      let totalBillable = 0, totalNonBillable = 0, onsiteBillable = 0, onsiteNonBillable = 0, offshoreBillable = 0, offshoreNonBillable = 0;
      for (const p of person.values()) {
        if (p.billable) totalBillable++; else totalNonBillable++;
        if (p.onsite) { if (p.billable) onsiteBillable++; else onsiteNonBillable++; }
        else { if (p.billable) offshoreBillable++; else offshoreNonBillable++; }
      }
      return {
        fiscalYear: fy, month, scope: `${month} · ${fy}`,
        projects,
        totals: {
          onsiteBillable, onsiteNonBillable, offshoreBillable, offshoreNonBillable,
          totalBillable, totalNonBillable, totalHeadcount: totalBillable + totalNonBillable,
        },
        note: "Billable/Non-billable per each resource's billable flag. Company totals count each person once (segment = onsite if they have any onsite work).",
      };
    },
  },

  {
    name: "get_headcount_by_geography",
    description:
      "Headcount for a single month grouped by employee geography/country (India, US, Canada, …), broken down by employment type (Full-time, Contractor, Vendor, W2/No-Benefit) and billable vs non-billable, with company totals. Use for 'headcount by country/location' or 'how many full-time vs contractors in India'.",
    input_schema: {
      type: "object",
      properties: {
        fy: { type: "string" },
        month: { type: "string", description: "Fiscal month name (Apr..Mar). Omit to use the current calendar month." },
      },
    },
    run: async (args, ctx) => {
      const fy = args.fy || ctx.fy;
      let mi = matchMonth(args.month);
      if (mi < 0) mi = (new Date().getMonth() - 3 + 12) % 12;
      const month = MONTHS[mi];
      const GEO: Record<string, string> = { INDIA: "India", US: "US", CANADA: "Canada", OTHER: "Other" };
      const lines = (await loadLines(fy)).filter((l) => l.isCustomer && l.mi === mi && (l.cost > 0 || l.rev > 0));

      // One record per distinct person: their geography, employment type, and billable flag.
      const person = new Map<string, { geo: string; empType: string; billable: boolean }>();
      for (const l of lines) {
        const cur = person.get(l.resource) || { geo: "Unknown", empType: "Unknown", billable: false };
        if (l.empLocation) cur.geo = GEO[l.empLocation] || l.empLocation;
        if (l.empType) cur.empType = l.empType;
        cur.billable = cur.billable || l.isBillable;
        person.set(l.resource, cur);
      }

      const geos = new Map<string, { geography: string; billable: number; nonBillable: number; total: number; byEmploymentType: Record<string, number> }>();
      const totalByType: Record<string, number> = {};
      let totBill = 0, totNon = 0;
      for (const p of person.values()) {
        if (!geos.has(p.geo)) geos.set(p.geo, { geography: p.geo, billable: 0, nonBillable: 0, total: 0, byEmploymentType: {} });
        const g = geos.get(p.geo)!;
        g.total++; if (p.billable) { g.billable++; totBill++; } else { g.nonBillable++; totNon++; }
        g.byEmploymentType[p.empType] = (g.byEmploymentType[p.empType] || 0) + 1;
        totalByType[p.empType] = (totalByType[p.empType] || 0) + 1;
      }
      return {
        fiscalYear: fy, month, scope: `${month} · ${fy}`,
        geographies: [...geos.values()].sort((a, b) => b.total - a.total),
        totals: { totalHeadcount: totBill + totNon, totalBillable: totBill, totalNonBillable: totNon, byEmploymentType: totalByType },
        note: "Geography & employment type come from the linked Employee record (location/empType); rows whose resource isn't linked to an employee show as 'Unknown'. Billable uses each resource's billable flag.",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Terminal tools — Claude calls exactly one of these to finish.
// ---------------------------------------------------------------------------
export const RENDER_REPORT_TOOL = {
  name: "render_report",
  description:
    "Render the final dashboard report. Call this ONCE, after gathering data, with a polished spec. Put currency figures as formatted strings (e.g. \"$12,400\") in kpis/insights; chart series data must be raw numbers.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      subtitle: { type: "string" },
      narrative: { type: "string", description: "1–3 sentence plain-language summary." },
      kpis: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, sub: { type: "string" } }, required: ["label", "value"] },
      },
      charts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["bar", "line", "doughnut"] },
            title: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, data: { type: "array", items: { type: "number" } } }, required: ["data"] } },
          },
          required: ["type", "labels", "series"],
        },
      },
      tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            columns: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, num: { type: "boolean" } }, required: ["key", "label"] } },
            rows: { type: "array", items: { type: "object" } },
          },
          required: ["columns", "rows"],
        },
      },
      insights: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
  },
};

export const UNSUPPORTED_TOOL = {
  name: "unsupported_request",
  description:
    "Call this when the question CANNOT be answered with the available data tools. Explain what is missing so a developer can add the capability (Tier-1 graceful gap).",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why it can't be answered with current tools." },
      suggestedTool: { type: "string", description: "Name of a new tool/metric that would satisfy it." },
      neededData: { type: "array", items: { type: "string" }, description: "Data fields/sources required." },
    },
    required: ["reason"],
  },
};

export function buildSystemPrompt(fy: string, today: string): string {
  return [
    "You are the AI Report builder for the GenAquarius ERP platform.",
    "Turn the user's request into a polished dashboard report.",
    "",
    "Rules:",
    "1. NEVER invent numbers. Get every figure by calling the data tools.",
    "2. You may call several data tools (in sequence) to gather what you need.",
    "3. When you have the data, call `render_report` exactly once with a clear, well-structured spec (KPIs + charts + tables + insights as appropriate).",
    "4. If the request cannot be satisfied with the available data tools, call `unsupported_request` instead — do not guess.",
    "5. Format currency figures (USD) as readable strings in KPIs/insights/tables; chart `data` arrays must be raw numbers.",
    "6. Prefer the right visual: time series → line/bar over months; composition/share → doughnut; detailed rows → a table.",
    "",
    `Context: today is ${today}. The current/default fiscal year is ${fy} (fiscal months run Apr → Mar). `,
    "If the user says 'current financial year' use the default unless they name another.",
  ].join("\n");
}
