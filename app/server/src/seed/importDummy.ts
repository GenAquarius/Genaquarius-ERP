/**
 * QA / DEMO seed — loads FABRICATED data into the ISOLATED QA database (costing_qa).
 *
 * This deliberately does NOT read the real workbook (data/seed.json). Every client,
 * resource, rate and number here is invented, so the QA database never contains real
 * company data. Run against the QA env only:
 *
 *     ENV_FILE=.env.qa  npm run seed:qa          (bash)
 *     npm run seed:qa                            (Windows; the script sets ENV_FILE)
 *
 * Safety guard below refuses to run unless DATABASE_URL points at a *_qa database.
 */
import { config } from "../config"; // imported first → loads dotenv + ENV_FILE override
import { prisma } from "../prisma";
import { hashPassword } from "../auth/auth";
import {
  Role, DeliveryModel, Currency, BillingType, BillingScope,
  SheetStatus, InvoiceStatus, TimesheetStatus,
} from "@prisma/client";

const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const FY = "FY26-27";

// --- Hard safety guard: never let the QA seed touch a non-QA database. ---
const dbUrl = process.env.DATABASE_URL || "";
if (!/_qa(\b|["?/])/i.test(dbUrl)) {
  console.error(
    "REFUSING to run QA seed: DATABASE_URL does not point at a *_qa database.\n" +
    "  Got: " + dbUrl.replace(/:[^:@/]*@/, ":****@") + "\n" +
    "  Run with ENV_FILE=.env.qa so it targets costing_qa."
  );
  process.exit(1);
}

// Fabricated resources. US-team project name ends in "(US)" => ONSITE; the other => OFFSHORE.
const TEAM = [
  { name: "Alice Anderson", project: "Demo Corp (US)",     bill: 110, cost: 70, loc: "US",    monthlyInr: 0 },
  { name: "Bob Brown",      project: "Demo Corp (US)",     bill: 95,  cost: 60, loc: "US",    monthlyInr: 0 },
  { name: "Carol Clark",    project: "Demo Corp (US)",     bill: 85,  cost: 55, loc: "US",    monthlyInr: 0 },
  { name: "Dev Desai",      project: "Globex Solutions",   bill: 45,  cost: 18, loc: "INDIA", monthlyInr: 150000 },
  { name: "Esha Iyer",      project: "Globex Solutions",   bill: 40,  cost: 16, loc: "INDIA", monthlyInr: 130000 },
  { name: "Farhan Khan",    project: "Globex Solutions",   bill: 38,  cost: 15, loc: "INDIA", monthlyInr: 120000 },
];

async function reset() {
  // delete in FK-safe order (same as the live importer)
  await prisma.invoiceAnnexure.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.timesheetEntry.deleteMany();
  await prisma.timesheetTask.deleteMany();
  await prisma.timesheet.deleteMany();
  await prisma.monthlyLine.deleteMany();
  await prisma.monthlySheet.deleteMany();
  await prisma.actualCostSummary.deleteMany();
  await prisma.employeeCostAllocation.deleteMany();
  await prisma.billingRate.deleteMany();
  await prisma.ctcRecord.deleteMany();
  await prisma.employeeProject.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.expenseCategory.deleteMany();
  await prisma.externalLedger.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.project.deleteMany();
  await prisma.client.deleteMany();
  await prisma.invoiceTemplate.deleteMany();
  await prisma.fxRate.deleteMany();
  await prisma.geography.deleteMany();
  await prisma.fiscalYear.deleteMany().catch(() => {});
}

async function main() {
  console.log("QA seed -> " + dbUrl.replace(/:[^:@/]*@/, ":****@"));
  await reset();

  // --- Geographies ---
  const geoMap = new Map<string, number>();
  for (const [code, name] of [["US","United States"],["CANADA","Canada"],["CARIBBEAN","Caribbean"],["INDIA","India"],["OTHER","Other"]] as const) {
    const g = await prisma.geography.create({ data: { code, name } });
    geoMap.set(code, g.id);
  }

  // --- Invoice template (clearly a demo) ---
  const tpl = await prisma.invoiceTemplate.create({ data: {
    name: "DEMO — US",
    issuerBlock: { company: "Demo Issuer LLC (QA)", addressLines: ["123 Sample Street", "Testville, CA 90000, USA"], website: "www.example.com", contact: "billing@example.com" },
    bankDetails: { bankName: "Demo Bank", terms: "Net 30 Days", lines: ["ACCOUNT # 000000000 (demo)", "This is QA/demo data — not a real account."] },
    layoutConfig: { region: "US", showAnnexure: true },
  } });

  // --- Clients + Projects ---
  const demo = await prisma.client.create({ data: {
    name: "Demo Corp", code: "DEMO", email: "ap@democorp.example",
    geographyId: geoMap.get("US"), currency: Currency.USD, invoiceTemplateId: tpl.id,
    billToAddress: "500 Demo Plaza, Testville, CA 90000, USA", attentionContact: "Dana Payable",
  } });
  const globex = await prisma.client.create({ data: {
    name: "Globex", code: "GLBX", email: "finance@globex.example",
    geographyId: geoMap.get("INDIA"), currency: Currency.USD, invoiceTemplateId: tpl.id,
    billToAddress: "1 Globex Tower, Bengaluru, India", attentionContact: "Gita Rao",
  } });
  const projUS = await prisma.project.create({ data: {
    clientId: demo.id, name: "Demo Corp (US)", code: "DEMO-US",
    billingType: BillingType.TNM, billingScope: BillingScope.RESOURCE, deliveryModel: DeliveryModel.ONSITE,
  } });
  const projIN = await prisma.project.create({ data: {
    clientId: globex.id, name: "Globex Solutions", code: "GLBX-IN",
    billingType: BillingType.TNM, billingScope: BillingScope.RESOURCE, deliveryModel: DeliveryModel.OFFSHORE,
  } });
  const projByName = new Map<string, number>([["Demo Corp (US)", projUS.id], ["Globex Solutions", projIN.id]]);

  // --- Employees + CTC + project assignment + billing rate ---
  const empByName = new Map<string, number>();
  for (const t of TEAM) {
    const emp = await prisma.employee.create({ data: {
      name: t.name, email: t.name.toLowerCase().replace(/[^a-z]+/g, ".") + "@demo.test",
      location: t.loc, empType: "FULL_TIME", isBillable: true,
      joiningDate: new Date("2024-04-01"),
    } });
    empByName.set(t.name, emp.id);
    const pid = projByName.get(t.project)!;
    await prisma.employeeProject.create({ data: { employeeId: emp.id, projectId: pid } });
    await prisma.billingRate.create({ data: { projectId: pid, employeeId: emp.id, rateUsd: t.bill, standardHoursPerDay: 8 } });
    if (t.monthlyInr > 0) {
      await prisma.ctcRecord.create({ data: {
        employeeId: emp.id, effectiveFrom: new Date("2026-04-01"), currency: Currency.INR,
        basic: t.monthlyInr * 0.5, hra: t.monthlyInr * 0.3, otherAllowance: t.monthlyInr * 0.2,
        bonusAnnual: t.monthlyInr,
      } });
    } else {
      // onsite resources costed in USD via annual override
      await prisma.ctcRecord.create({ data: {
        employeeId: emp.id, effectiveFrom: new Date("2026-04-01"), currency: Currency.USD,
        annualCostOverride: t.cost * 160 * 12,
      } });
    }
  }

  // --- FX rates (demo, editable) ---
  await prisma.fxRate.create({ data: { context: "USD_INR", baseCcy: "USD", quoteCcy: "INR", rate: 88, note: "QA demo rate" } });
  await prisma.fxRate.create({ data: { context: "CANADA_FACTOR", baseCcy: "CAD", quoteCcy: "USD", rate: 0.71, note: "QA demo factor" } });

  // --- Expense categories ---
  const expCats = ["Internal HR/IT", "Expenses India", "Expenses US/Canada", "Other"];
  for (const name of expCats) await prisma.expenseCategory.create({ data: { name } });

  // --- 12 monthly sheets for FY26-27 with billable lines + a couple of expense lines ---
  let aprUsLines: { name: string; rate: number; hours: number; amount: number }[] = [];
  for (let mi = 0; mi < 12; mi++) {
    const month = MONTHS[mi];
    const sheet = await prisma.monthlySheet.create({ data: { fiscalYear: FY, month, monthIndex: mi + 1, status: SheetStatus.DRAFT } });
    const lines: any[] = [];
    let revenue = 0, salary = 0;
    for (const t of TEAM) {
      const hours = 160 - (mi % 3 === 0 ? 8 : 0); // a little realistic variation
      const invoiceAmount = +(t.bill * hours).toFixed(2);
      const costUsd = +(t.cost * hours).toFixed(2);
      revenue += invoiceAmount; salary += costUsd;
      lines.push({
        monthlySheetId: sheet.id, employeeId: empByName.get(t.name)!, projectId: projByName.get(t.project)!,
        resourceName: t.name, projectName: t.project, rateUsd: t.bill,
        estimateHours: 160, actualHours: hours, billingAmount: +(t.bill * 160).toFixed(2),
        invoiceAmount, costUsd, isExpense: false,
      });
      if (mi === 0 && t.project === "Demo Corp (US)") aprUsLines.push({ name: t.name, rate: t.bill, hours, amount: invoiceAmount });
    }
    // expense / overhead lines (grouped into the cost-center breakdown by projectName)
    const expenses = [
      { projectName: "Internal HR/IT", resourceName: "Cloud Hosting (AWS)", costUsd: 600 },
      { projectName: "Expenses India", resourceName: "Office Rent (India)", costUsd: 400 },
    ];
    for (const e of expenses) {
      lines.push({ monthlySheetId: sheet.id, employeeId: null, projectId: null,
        resourceName: e.resourceName, projectName: e.projectName, rateUsd: 0, estimateHours: 0, actualHours: 0,
        billingAmount: 0, invoiceAmount: 0, costUsd: e.costUsd, isExpense: true });
    }
    await prisma.monthlyLine.createMany({ data: lines });

    const totalCost = salary + 1000; // + the two expense lines
    const profit = revenue - totalCost;
    await prisma.actualCostSummary.create({ data: {
      fiscalYear: FY, month, monthIndex: mi + 1,
      salaryExpense: salary, totalCost, revenue, monthlyProfit: profit,
      netProfitPct: revenue ? profit / revenue : 0, // stored as fraction (×100 on read)
      headCount: TEAM.length, billableHeadCount: TEAM.length, offshoreBillable: 3, onsiteBillable: 3,
    } });
  }

  // --- One SENT invoice (Demo Corp, Apr 2026) so CEO AR/aging + Invoices page render ---
  const total = +aprUsLines.reduce((s, l) => s + l.amount, 0).toFixed(2);
  await prisma.invoice.create({ data: {
    clientId: demo.id, invoiceNo: "GA/2026/DEMO-Apr", seq: 1,
    invoiceDate: new Date("2026-04-30"), dueDate: new Date("2026-05-30"),
    billingPeriodStart: new Date("2026-04-01"), billingPeriodEnd: new Date("2026-04-30"),
    projectDescription: "Software development services — April 2026 (QA demo)",
    currency: Currency.USD, totalAmount: total, status: InvoiceStatus.SENT, templateId: tpl.id,
    lineItems: { create: aprUsLines.map((l) => ({ description: `${l.name} — Apr 2026`, rateUsd: l.rate, hours: l.hours, amount: l.amount })) },
    annexure: { create: aprUsLines.map((l) => ({ resourceName: l.name, leave: "0", billRate: l.rate, hours: l.hours, amount: l.amount })) },
  } });

  // --- Integrations + external ledger (AR + cash) so CEO tiles populate ---
  await prisma.integration.create({ data: { provider: "TALLY", status: "DISCONNECTED" } });
  await prisma.integration.create({ data: { provider: "BOA", status: "DISCONNECTED" } });
  await prisma.externalLedger.createMany({ data: [
    { provider: "TALLY", extId: "AR-GLBX-001", type: "AR", customerRef: "Globex", amount: 12000, currency: "USD", asOfDate: new Date("2026-05-15") },
    { provider: "BOA", extId: "BAL-DEMO", type: "BALANCE", customerRef: "Demo Bank", amount: 85000, currency: "USD", asOfDate: new Date("2026-05-31") },
  ] });

  // --- One submitted timesheet so the PM approval queue has something to test ---
  const devId = empByName.get("Dev Desai")!;
  const ts = await prisma.timesheet.create({ data: {
    employeeId: devId, projectId: projIN.id, periodMonth: 4, periodYear: 2026,
    totalHours: 152, leaveDays: 1, status: TimesheetStatus.SUBMITTED, submittedAt: new Date("2026-05-01"),
    tasks: { create: [{ description: "Feature work + bug fixes (QA demo)", hours: 152 }] },
  } });
  await prisma.timesheetEntry.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ timesheetId: ts.id, day: i + 1, hours: 8, leave: false })) });

  // --- Users (password123) — clearly demo accounts, QA gets full testing access ---
  const users = [
    { name: "QA Tester",       email: "qa@demo.test",      role: Role.QA,              emp: null as string | null },
    { name: "Demo CEO",        email: "ceo@demo.test",     role: Role.CEO,             emp: null },
    { name: "Demo Finance",    email: "finance@demo.test", role: Role.FINANCE,         emp: null },
    { name: "Demo PM",         email: "pm@demo.test",      role: Role.PROJECT_MANAGER, emp: "Alice Anderson" },
    { name: "Demo Employee",   email: "emp@demo.test",     role: Role.EMPLOYEE,        emp: "Dev Desai" },
  ];
  for (const u of users) {
    await prisma.user.create({ data: {
      name: u.name, email: u.email, role: u.role, passwordHash: hashPassword("password123"),
      employeeId: u.emp ? empByName.get(u.emp)! : null,
    } });
  }

  console.log("QA seed complete: 2 projects, 6 resources, 12 months FY26-27, 1 invoice, 5 demo users.");
  console.log("Sign in at the QA app with qa@demo.test / password123 (role QA = full access).");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
