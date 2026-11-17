/**
 * Seed importer — loads app/data/seed.json (parsed from the workbooks) into
 * MySQL. Cost/invoice values come from Excel cached cells => zero deviation.
 * Also creates one demo user per role, an invoice template, and integration
 * placeholders.
 *
 * Run:  npm run seed
 */
import fs from "fs";
import { prisma } from "../prisma";
import { config } from "../config";
import { hashPassword } from "../auth/auth";
import { Role, DeliveryModel, Currency } from "@prisma/client";

const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

// Join key for a person's name. The workbook is hand-maintained, so the same person appears
// with different casing and spacing on different tabs; comparing raw strings drops the join.
const nameKey = (s: string) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();

// Refined model: a project whose name ends with "(US)" is the US / onsite team;
// everything else is delivered from India (offshore). No more hybrid split.
function deliveryFor(name: string): DeliveryModel {
  return name.trim().endsWith("(US)") ? DeliveryModel.ONSITE : DeliveryModel.OFFSHORE;
}

async function reset() {
  // order matters (FK)
  await prisma.invoiceAnnexure.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.timesheetTask.deleteMany();
  await prisma.timesheet.deleteMany();
  await prisma.monthlyLine.deleteMany();
  await prisma.monthlySheet.deleteMany();
  await prisma.actualCostSummary.deleteMany();
  await prisma.billingRate.deleteMany();
  await prisma.ctcRecord.deleteMany();
  await prisma.employeeProject.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.externalLedger.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.project.deleteMany();
  await prisma.client.deleteMany();
  await prisma.geography.deleteMany();
  await prisma.invoiceTemplate.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.fxRate.deleteMany();
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(config.seedPath, "utf-8"));
  console.log("Resetting database...");
  await reset();

  // --- Geographies ---
  const geoNames: Record<string, string> = {
    US: "United States", CANADA: "Canada", CARIBBEAN: "Caribbean", INDIA: "India", OTHER: "Other",
  };
  const geoMap = new Map<string, number>();
  for (const code of seed.geographies as string[]) {
    const g = await prisma.geography.create({ data: { code, name: geoNames[code] || code } });
    geoMap.set(code, g.id);
  }

  // --- Invoice templates: US / Canada / India (free-form bank lines, shown verbatim) ---
  const tplUS = await prisma.invoiceTemplate.create({ data: {
    name: "GenAquarius — US",
    issuerBlock: { company: "GenAquarius LLC", addressLines: ["2795 E Bidwell St.", "Suite 100-662, Folsom, CA 95630, USA"], website: "www.GenAquarius.com", contact: "finance@genaquarius.com OR Mandeep@genaquarius.com" },
    bankDetails: { bankName: "Bank of America", terms: "Net 30 Days", lines: [
      "ACCOUNT # 325203479524, ROUTING # 121000358 (Paper & Electronic) Or 026009593 (Wires)",
      "Bank Address: Bank of America N.A. 222 Broadway, New York, NY 10038",
      "Office Address: 2795 E Bidwell St., Suite 100-662, Folsom, CA 95630 USA",
    ] },
    layoutConfig: { region: "US", showAnnexure: true },
  } });
  const tplCA = await prisma.invoiceTemplate.create({ data: {
    name: "GenAquarius — Canada",
    issuerBlock: { company: "Aquarius Technologies Limited", addressLines: ["5343 Dundas Street West", "Suite 601 Etobicoke ON M9B 6H8, Canada"], website: "www.GenAquarius.com", contact: "finance@genaquarius.com" },
    bankDetails: { bankName: "Bank Of Montreal", terms: "Net 30 Days", lines: [
      "ACCOUNT # 1986029, Transit # 23352, Institution # 001",
      "Bank Branch Address: 3835 Bloor St W, Etobicoke, ON M9B 1K9, Canada",
      "Swift Code # BOFMCAM2",
      "Registered Office Address: 46 Haviland Circle, Brampton, Ontario, L6R0Y9, Canada",
      "Current Office Address: 5343 Dundas Street West, Suite 601 Etobicoke ON M9B 6H8, Canada",
    ] },
    layoutConfig: { region: "CANADA", showAnnexure: true },
  } });
  const tplIN = await prisma.invoiceTemplate.create({ data: {
    name: "GenAquarius — India",
    issuerBlock: { company: "GenAquarius Software Pvt. Ltd.", addressLines: ["TBD — edit address in Invoice Templates"], website: "www.GenAquarius.com", contact: "finance@genaquarius.com" },
    bankDetails: { bankName: "TBD — edit bank", terms: "Net 30 Days", lines: ["A/C No.: TBD", "IFSC: TBD", "Bank Address: TBD", "Office Address: TBD"] },
    layoutConfig: { region: "INDIA", showAnnexure: true },
  } });
  const templateForGeo = (geo: string) => (geo === "CANADA" ? tplCA.id : geo === "INDIA" ? tplIN.id : tplUS.id);
  const template = tplUS; // default

  // --- Clients + Projects (1 project per customer group) ---
  const clientMap = new Map<string, number>();
  const projectMap = new Map<string, number>();
  const usedCodes = new Set<string>();
  for (const c of seed.clients as any[]) {
    let code = c.code;
    let n = 2;
    while (usedCodes.has(code)) code = `${c.code}${n++}`;
    usedCodes.add(code);
    const client = await prisma.client.create({
      data: {
        name: c.name, code,
        geographyId: geoMap.get(c.geo) || null,
        currency: c.geo === "CANADA" ? Currency.CAD : Currency.USD,
        invoiceTemplateId: templateForGeo(c.geo),
        billToAddress: null,
      },
    });
    clientMap.set(c.name, client.id);
    const project = await prisma.project.create({
      data: { clientId: client.id, name: c.name, deliveryModel: deliveryFor(c.name) },
    });
    projectMap.set(c.name, project.id);
  }

  // --- Employees + CTC ---
  // The workbook spells the same person differently across tabs ("Asheesh Dabral" on Actual
  // Cost, "Asheesh dabral" on Employee cost/CTC/monthly). Keying these lookups on the raw
  // string made those rows miss silently: the monthly line lost its employee link and its
  // rate/hours, and showed up on the sheet with a blank Location and zeros. Key on a
  // normalized name so casing and stray whitespace can't break the join.
  const empMap = new Map<string, number>();
  for (const e of seed.employees as any[]) {
    const emp = await prisma.employee.create({
      data: {
        name: e.name,
        joiningDate: e.joiningDate ? new Date(e.joiningDate) : null,
        empType: "FULL_TIME",
        location: "INDIA",
      },
    });
    empMap.set(nameKey(e.name), emp.id);
    if (e.project && projectMap.has(e.project)) {
      await prisma.employeeProject.create({
        data: { employeeId: emp.id, projectId: projectMap.get(e.project)! },
      });
    }
  }
  for (const r of seed.ctcRecords as any[]) {
    const eid = empMap.get(nameKey(r.name));
    if (!eid) continue;
    await prisma.ctcRecord.create({
      data: {
        employeeId: eid,
        effectiveFrom: new Date(r.effectiveFrom),
        basic: r.basic, hra: r.hra, otherAllowance: r.otherAllowance, specialAllowance: r.specialAllowance,
        conveyance: r.conveyance, communication: r.communication, meals: r.meals, books: r.books,
        driver: r.driver, uniform: r.uniform,
        annualCostOverride: r.usd ? r.usd : null,
      },
    });
  }

  // --- FX rates ---
  for (const f of seed.fxRates as any[]) {
    await prisma.fxRate.create({
      data: { context: f.context, baseCcy: f.baseCcy, quoteCcy: f.quoteCcy, rate: f.rate, note: f.note },
    });
  }

  // --- Monthly sheets for BOTH fiscal years from the Actual Cost grid (exact cost+invoice) ---
  for (const [fy, ydata] of Object.entries(seed.years as Record<string, any>)) {
    // enrichment lookup from this year's monthly tabs (rate/estimate/actual/billing)
    const enrich = new Map<string, any>();
    for (const ms of ydata.monthlySheets || []) for (const l of ms.lines) enrich.set(`${ms.month}::${nameKey(l.resourceName)}`, l);

    for (let mi = 0; mi < 12; mi++) {
      const month = MONTHS[mi];
      const sheet = await prisma.monthlySheet.create({
        // current year editable (DRAFT); prior year locked (protect historical data)
        data: { fiscalYear: fy, month, monthIndex: mi + 1, status: fy === "FY26-27" ? "DRAFT" : "LOCKED" },
      });
      const lines: any[] = [];
      for (const row of ydata.actualCost as any[]) {
        const cell = row.monthly[month] || { cost: 0, invoice: 0 };
        if (cell.cost === 0 && cell.invoice === 0) continue;
        const en = enrich.get(`${month}::${nameKey(row.resourceName)}`);
        lines.push({
          monthlySheetId: sheet.id,
          employeeId: empMap.get(nameKey(row.resourceName)) || null,
          projectId: projectMap.get(row.project) || null,
          resourceName: row.resourceName, projectName: row.project,
          rateUsd: en?.rateUsd || 0, estimateHours: en?.estimateHours || 0,
          actualHours: en?.actualHours || 0, billingAmount: en?.billingAmount || 0,
          invoiceAmount: cell.invoice, costUsd: cell.cost, isExpense: !row.isCustomer,
        });
      }
      if (lines.length) await prisma.monthlyLine.createMany({ data: lines });
    }
    // headline Actual Cost summary metrics per month
    for (const s of ydata.summary || []) {
      await prisma.actualCostSummary.create({ data: {
        fiscalYear: fy, month: s.month, monthIndex: s.monthIndex,
        salaryExpense: s.salaryExpense, totalCost: s.totalCost, revenue: s.revenue,
        monthlyProfit: s.monthlyProfit, netProfitPct: s.netProfitPct,
        headCount: s.headCount, billableHeadCount: s.billableHeadCount,
        offshoreBillable: s.offshoreBillable, onsiteBillable: s.onsiteBillable,
      } });
    }
    console.log(`  ${fy}: imported 12 monthly sheets + summary`);
  }

  // --- Demo users (one per role) ---
  // Only the canonical admins are seeded. Everyone else signs in via genaquarius.com
  // (Entra SSO + 2FA) and is auto-provisioned as EMPLOYEE; admins elevate roles in Users.
  const users = [
    { name: "Sandeep Minocha", email: "sandeep.minocha@genaquarius.com", role: Role.CTO },
    { name: "Mandeep", email: "mandeep@genaquarius.com", role: Role.CEO },
    { name: "Kumar", email: "kumar@genaquarius.com", role: Role.COO },
    { name: "Finance", email: "finance@genaquarius.com", role: Role.FINANCE },
  ];
  for (const u of users) {
    await prisma.user.create({
      data: { name: u.name, email: u.email, role: u.role, passwordHash: hashPassword("password123") },
    });
  }

  // --- Expense categories ---
  for (const name of ["Internal HR/IT", "Expenses India", "Expenses India - Resourcing", "Expenses US/Canada", "Other"]) {
    await prisma.expenseCategory.create({ data: { name } }).catch(() => {});
  }

  // --- Integrations placeholders ---
  await prisma.integration.create({ data: { provider: "TALLY", status: "DISCONNECTED" } });
  await prisma.integration.create({ data: { provider: "BOA", status: "DISCONNECTED" } });

  // --- Demo external ledger (AR + cash) so CEO tiles render until APIs connected ---
  await prisma.externalLedger.createMany({
    data: [
      { provider: "TALLY", extId: "AR-KIRA-001", type: "AR", customerRef: "Kira", amount: 13572, currency: "USD", asOfDate: new Date("2026-05-01") },
      { provider: "TALLY", extId: "AR-CLARIEN-002", type: "AR", customerRef: "Clarien", amount: 39825, currency: "USD", asOfDate: new Date("2026-05-10") },
      { provider: "BOA", extId: "BAL-MAIN", type: "BALANCE", customerRef: "BoA Current", amount: 248500, currency: "USD", asOfDate: new Date("2026-05-31") },
    ],
  });

  console.log("Seed complete.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
