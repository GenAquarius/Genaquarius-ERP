import express from "express";
import "express-async-errors"; // make async route errors reach the error handler (Express 4)
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import authRoutes from "./routes/shared/auth";
import mastersRoutes from "./routes/shared/masters";
import monthlyRoutes from "./routes/finance/monthly";
import timesheetRoutes from "./routes/shared/timesheets";
import expenseRoutes from "./routes/finance/expenses";
import invoiceRoutes from "./routes/finance/invoices";
import invoiceReconciliationRoutes from "./routes/finance/invoiceReconciliation";
import dashboardRoutes from "./routes/shared/dashboard";
import attentionRoutes from "./routes/shared/attention";
import companySettingsRoutes from "./routes/shared/companySettings";
import integrationRoutes from "./routes/shared/integrations";
import adminRoutes from "./routes/shared/admin";
import allocationRoutes from "./routes/finance/allocations";
import fiscalYearRoutes from "./routes/finance/fiscalYear";
import excelExportRoutes from "./routes/finance/excelExport";
import emailTemplateRoutes from "./routes/finance/emailTemplates";
import invoiceLayoutRoutes from "./routes/finance/invoiceLayouts";
import timesheetTemplateRoutes from "./routes/finance/timesheetTemplates";
import importTimesheetRoutes from "./routes/finance/importTimesheet";
import aiReportRoutes from "./routes/shared/aiReport";
import holidayRoutes from "./routes/hrms/holidays";
import hrSettingsRoutes from "./routes/hrms/hrSettings";
import hrOffersRoutes from "./routes/hrms/hrOffers";
import workflowSettingsRoutes from "./routes/hrms/workflowSettings";
import leavePolicyRoutes from "./routes/hrms/leavePolicy";
import essRoutes from "./routes/hrms/ess";
import permissionsRoutes from "./routes/shared/permissions";
import notificationSettingsRoutes from "./routes/shared/notificationSettings";
import ctcApprovalsRoutes from "./routes/approvals/ctcApprovals";
import terminationApprovalsRoutes from "./routes/approvals/terminationApprovals";
import appraisalsRoutes from "./routes/hrms/appraisals";
import appraisalApprovalsRoutes from "./routes/approvals/appraisalApprovals";
import relievingLettersRoutes from "./routes/hrms/relievingLetters";
import itAdminRoutes from "./routes/itsm/itAdmin";
import helpdeskRoutes from "./routes/itsm/helpdesk";
import adobeSignRoutes, { adobeSignWebhookRouter } from "./routes/shared/adobeSign";
import graphAdminRoutes from "./routes/shared/graphAdmin";
import publicDocumentUploadRoutes from "./routes/public/documentUpload";
import { reminderTick } from "./engine/reminders";
import { seedDefaultWorkflowIfMissing, normalizeRenamedStageNames } from "./seed/seedWorkflow";
import { initRealtime } from "./engine/realtime";
import { loadDateTimeFormatSetting } from "./engine/dateFormat";
import { authenticate } from "./auth/auth";
import http from "http";

const app = express();
app.set("trust proxy", 1);
// Express auto-generates a weak ETag on every res.json() by default. For a dynamic, per-user,
// authenticated API this is actively harmful: the browser sends If-None-Match on a repeat GET
// (e.g. revisiting a dashboard page), the server's freshness check answers 304 with an EMPTY
// body, and — in some browser/network setups (was reproduced by a real user going through a
// corporate network) — the browser fails to transparently reconstruct the original 200 from its
// own cache and hands the bare 304 straight to fetch(). Since 304 is outside the 200-299 range,
// api.ts's `res.ok` check treats it as a failure ("HTTP 304"), and any dashboard whose data fetch
// fails this way sits stuck loading. Disabling etag app-wide, plus an explicit Cache-Control:
// no-store on every /api response, stops the browser from ever caching or conditionally
// revalidating these calls in the first place.
app.set("etag", false);
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
// Helmet defaults, except frames may load same-origin/blob: content — the Advanced Invoice
// Builder shows the PDF preview in an <iframe src="blob:…"> which default CSP (frame-src → default-src
// 'self') blocks ("This content is blocked").
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { "frame-src": ["'self'", "blob:"], "object-src": ["'self'", "blob:"] } } }));
app.use(cors({ origin: config.clientOrigin, credentials: true }));
// IT Helpdesk carries base64 attachments (tickets ≤5 MB, KB documents ≤10 MB) — parsed here first with a
// larger limit; body-parser skips re-parsing, so the global 2 MB limit below still applies everywhere else.
app.use("/api/helpdesk", express.json({ limit: "20mb" }));
// Candidate document uploads (PAN/education certificate/photo/3 salary slips, base64) — same
// larger-limit-before-the-blanket-one pattern as Helpdesk attachments above.
app.use("/api/public/document-collection", express.json({ limit: "20mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "genaquarius-erp-api" }));

// Throttle auth endpoints to slow brute-force / abuse.
// Only throttle credential POSTs — never the /auth/config GET or the Microsoft SSO redirect/callback GETs
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, skip: (req) => req.method === "GET", standardHeaders: true, legacyHeaders: false });
app.use("/api/auth", authLimiter, authRoutes);
// Adobe Sign's webhook — Adobe's own servers call this with no session cookie of ours to
// present, so (like /api/auth above) it must sit outside the authenticate gate below.
app.use("/api/adobe-sign", adobeSignWebhookRouter);
// Candidate-facing Mandatory Document Collection portal — the opaque token in the URL IS the
// credential, there is no login (candidates aren't app users at this stage), so this too must sit
// outside the authenticate gate below. See routes/public/documentUpload.ts.
app.use("/api/public/document-collection", publicDocumentUploadRoutes);
// everything below requires a valid token (RBAC enforced per-route inside)
app.use("/api", authenticate);
app.use("/api", mastersRoutes);
app.use("/api", attentionRoutes);                                  // "Need your Attention" — role-scoped pending-approval summary, every dashboard
app.use("/api", companySettingsRoutes);
app.use("/api/monthly", monthlyRoutes);
app.use("/api/timesheets", timesheetRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/invoice-reconciliation", invoiceReconciliationRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/allocations", allocationRoutes);     // F4 — employee cost allocation
app.use("/api/fiscal-years", fiscalYearRoutes);    // F5 — fiscal year lifecycle
app.use("/api/excel-export", excelExportRoutes);   // F6 — Excel workbook export
app.use("/api/email-templates", emailTemplateRoutes); // F7 — invoice email templates
app.use("/api/invoice-layouts", invoiceLayoutRoutes); // configurable invoice PDF layouts
app.use("/api/timesheet-templates", timesheetTemplateRoutes); // Timesheet Template Management (library, builder, assignment, versioning)
app.use("/api/import-timesheet", importTimesheetRoutes);      // Finance's Import Timesheet → Approved Hours → Invoice bridge
app.use("/api/ai-report", aiReportRoutes);            // AI Report — prompt → dashboard report (Claude)
app.use("/api/holidays", holidayRoutes);              // Annual leave / holiday calendar per country
app.use("/api/hr-settings", hrSettingsRoutes);        // HR Admin Settings — CTC/tax/offer/appointment/email config
app.use("/api/hr-workflow", workflowSettingsRoutes);  // Workflow & Stage Configuration — HR Workflow Engine
app.use("/api/hr", hrOffersRoutes);                   // HR Dashboard, Offer lifecycle, Appointment Letters, Confirm Joining
app.use("/api/hr-settings/leave", leavePolicyRoutes); // Leave Policy config (types, sandwich rule, onboarding doc types)
app.use("/api/ess", essRoutes);                       // Employee Self-Service — profile, onboarding docs, holidays, leave, attendance
app.use("/api/permissions", permissionsRoutes);       // Module Access Matrix — dynamic RBAC (RolePermission)
app.use("/api/notification-settings", notificationSettingsRoutes); // per-flow email on/off + CC + reminder cadence
app.use("/api/ctc-approvals", ctcApprovalsRoutes);    // Finance review/approve of HR's Confirm Joining CTC + Monthly Sheet line proposals
app.use("/api/termination-approvals", terminationApprovalsRoutes); // Finance review/approve of HR's termination requests
app.use("/api/appraisals", appraisalsRoutes);                      // HR's Appraisal / Annual Performance Review letter flow
app.use("/api/appraisal-approvals", appraisalApprovalsRoutes);     // Finance review/approve of an issued appraisal's revised CTC
app.use("/api/relieving-letters", relievingLettersRoutes);         // HR's Relieving & Experience Certificate flow, issued once FNF is finalized
app.use("/api/helpdesk", helpdeskRoutes);                          // IT Helpdesk — tickets, asset catalog/requests, assigned assets, KB, elevated access
app.use("/api/it-admin", itAdminRoutes);                           // IT Admin module — new-hire O365 provisioning task queue
app.use("/api/adobe-sign", adobeSignRoutes);                       // Adobe Sign OAuth connect + send-for-signature (webhook is mounted separately above)
app.use("/api/graph-admin", graphAdminRoutes);                     // Microsoft Graph delegated admin OAuth connect + settings — automated O365 provisioning

// In production, serve the built React app from this same service (single App Service).
// CLIENT_DIST points at the copied client build (default ./client-dist).
import path from "path";
import fs from "fs";
const clientDist = path.resolve(__dirname, "..", process.env.CLIENT_DIST || "client-dist");
if (fs.existsSync(clientDist)) {
  // index.html must NEVER be cached: it is the only file whose name doesn't change between deploys,
  // so a cached copy keeps pointing at the previous build's hashed bundle and users sit on stale code
  // until they hard-refresh. The hashed assets themselves are immutable and cached for a year.
  const noStore = { "Cache-Control": "no-store, must-revalidate", Pragma: "no-cache", Expires: "0" };
  app.use(express.static(clientDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) res.set(noStore);
      else if (/[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpg|svg)$/.test(filePath)) res.set("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.get(/^(?!\/api).*/, (_req, res) => res.set(noStore).sendFile(path.join(clientDist, "index.html")));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

// --- Audit log rotation: purge entries older than the retention window ---
import { prisma } from "./prisma";
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 7); // default 7 days
async function rotateAuditLog() {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000);
  try {
    const { count } = await prisma.auditLog.deleteMany({ where: { at: { lt: cutoff } } });
    if (count) console.log(`Audit rotation: purged ${count} entr(ies) older than ${AUDIT_RETENTION_DAYS} day(s).`);
  } catch (e) { console.error("Audit rotation failed:", e); }
}

// --- Self-healing schema: additive columns the deployed code needs, applied on boot.
// MySQL has no "ADD COLUMN IF NOT EXISTS", so we check information_schema first. This
// lets schema additions reach environments whose DB we can't run `prisma db push`
// against (e.g. the VNet-private production DB) — the app migrates itself.
async function ensureSchema() {
  const ensureColumn = async (table: string, column: string, ddl: string): Promise<boolean> => {
    try {
      const r: any = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        table, column
      );
      const exists = Array.isArray(r) && Number(r[0]?.c) > 0;
      if (!exists) { await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`); console.log(`Schema: added ${table}.${column}`); return true; }
    } catch (e) { console.error(`ensureColumn ${table}.${column} failed:`, e); }
    return false;
  };
  await ensureColumn("MonthlyLine", "expenseType", "`expenseType` VARCHAR(191) NOT NULL DEFAULT 'VARIABLE'");
  // Billable flag for resource lines; existing rows default to billable (1).
  await ensureColumn("MonthlyLine", "isBillable", "`isBillable` TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("MonthlyLine", "region", "`region` VARCHAR(191) NULL");
  await ensureColumn("MonthlyLine", "expenseScope", "`expenseScope` VARCHAR(191) NULL DEFAULT 'ORG'");
  await ensureColumn("MonthlyLine", "billingMode", "`billingMode` VARCHAR(191) NULL DEFAULT 'HOURLY'");
  await ensureColumn("MonthlyLine", "doubleDipIncentive", "`doubleDipIncentive` DOUBLE NULL DEFAULT 0");
  await ensureColumn("MonthlyLine", "bonus", "`bonus` DOUBLE NULL DEFAULT 0");
  await ensureColumn("TerminationApprovalRequest", "emailTerminated", "`emailTerminated` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("TerminationApprovalRequest", "emailTerminatedNotifiedAt", "`emailTerminatedNotifiedAt` DATETIME(3) NULL");
  await ensureColumn("Offer", "ctcRejectedAt", "`ctcRejectedAt` DATETIME(3) NULL");
  await ensureColumn("Offer", "ctcRejectionNote", "`ctcRejectionNote` TEXT NULL");
  await ensureColumn("Offer", "residentSameAsPermanent", "`residentSameAsPermanent` TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("Offer", "residentAddress", "`residentAddress` TEXT NULL");
  await ensureColumn("Offer", "residentCity", "`residentCity` VARCHAR(191) NULL");
  await ensureColumn("Offer", "residentLandmark", "`residentLandmark` VARCHAR(191) NULL");
  await ensureColumn("Offer", "residentState", "`residentState` VARCHAR(191) NULL");
  await ensureColumn("Offer", "residentPincode", "`residentPincode` VARCHAR(191) NULL");
  await ensureColumn("Employee", "residentAddress", "`residentAddress` TEXT NULL");
  await ensureColumn("Employee", "residentCity", "`residentCity` VARCHAR(191) NULL");
  await ensureColumn("Employee", "residentLandmark", "`residentLandmark` VARCHAR(191) NULL");
  await ensureColumn("Employee", "residentState", "`residentState` VARCHAR(191) NULL");
  await ensureColumn("Employee", "residentPincode", "`residentPincode` VARCHAR(191) NULL");
  await ensureColumn("Offer", "gender", "`gender` VARCHAR(191) NULL");
  await ensureColumn("Offer", "maritalStatus", "`maritalStatus` VARCHAR(191) NULL");
  await ensureColumn("Offer", "dateOfBirth", "`dateOfBirth` DATETIME(3) NULL");
  await ensureColumn("Employee", "gender", "`gender` VARCHAR(191) NULL");
  await ensureColumn("Employee", "maritalStatus", "`maritalStatus` VARCHAR(191) NULL");
  await ensureColumn("Offer", "resumeFileName", "`resumeFileName` VARCHAR(191) NULL");
  await ensureColumn("Offer", "resumeFileData", "`resumeFileData` LONGTEXT NULL");
  await ensureColumn("Offer", "resumeUploadedAt", "`resumeUploadedAt` DATETIME(3) NULL");
  await ensureColumn("Employee", "photoFileName", "`photoFileName` VARCHAR(191) NULL");
  await ensureColumn("Employee", "photoFileData", "`photoFileData` LONGTEXT NULL");
  await ensureColumn("Employee", "photoUploadedAt", "`photoUploadedAt` DATETIME(3) NULL");
  await ensureColumn("ItProvisioningRequest", "emailCreatedAt", "`emailCreatedAt` DATETIME(3) NULL");
  await ensureColumn("ItProvisioningRequest", "emailCreatedById", "`emailCreatedById` INT NULL");
  await ensureColumn("ItProvisioningRequest", "welcomeEmailSentAt", "`welcomeEmailSentAt` DATETIME(3) NULL");
  // Widens the native User.role ENUM to include IT_ADMIN — additive only (never drops an existing
  // value), so this is safe to run on every boot; the idempotency check just avoids a needless
  // ALTER once it's already been widened.
  try {
    const roleColumn: any = await prisma.$queryRawUnsafe(
      "SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'User' AND column_name = 'role'"
    );
    const columnType = String(roleColumn?.[0]?.t || "");
    if (columnType && !columnType.includes("IT_ADMIN")) {
      await prisma.$executeRawUnsafe("ALTER TABLE `User` MODIFY COLUMN `role` ENUM('CEO','CTO','FINANCE','PROJECT_MANAGER','EMPLOYEE','HR','QA','IT_ADMIN') NOT NULL");
      console.log("Schema: widened User.role to include IT_ADMIN");
    }
  } catch (e) { console.error("widen User.role enum failed:", e); }
  // Seeds the company-wide default Welcome Email template once — sent when IT Admin marks a new
  // hire's O365 mailbox created. Never a dangerous full reseed (unlike `npm run seed`), just a
  // single upsert-if-missing row, same self-healing convention as everything else here.
  try {
    const existing = await prisma.hrEmailTemplate.findFirst({ where: { key: "WELCOME_EMAIL", businessUnitId: null } });
    if (!existing) {
      await prisma.hrEmailTemplate.create({ data: {
        key: "WELCOME_EMAIL", businessUnitId: null, subject: "Welcome to GenAquarius, {{EmployeeName}}!",
        body: "Dear {{EmployeeName}},\n\nWelcome to GenAquarius! Your Office 365 account has been created:\n\nEmail: {{EmailId}}\nEmployee ID: {{EmployeeId}}\n\nWe're excited to have you on the team and look forward to working with you.\n\nWarm regards,\nHR Team, GenAquarius",
      } });
      console.log("Schema: seeded default WELCOME_EMAIL template");
    }
  } catch (e) { console.error("seed WELCOME_EMAIL template failed:", e); }
  // Laptop Handover email — Helpdesk Settings-managed template (IT Admin's own, separate from
  // HR's email templates), auto-filled from the assets actually assigned to the employee. Content
  // mirrors "Laptop Template 7.pdf" (a GenAquarius laptop-receipt form): the data-table fields
  // below become {{...}} placeholders, {{AssetsTable}} renders one table row per assigned asset.
  try {
    const existing = await prisma.hrEmailTemplate.findFirst({ where: { key: "LAPTOP_HANDOVER_EMAIL", businessUnitId: null } });
    if (!existing) {
      await prisma.hrEmailTemplate.create({ data: {
        key: "LAPTOP_HANDOVER_EMAIL", businessUnitId: null, subject: "Issuance of Laptop & Accessories — {{EmployeeName}}",
        body: "Dear {{EmployeeName}},\n\nPlease find below the laptop and accessories issued to you for official use. Kindly review the details and retain this email for your records.\n\nName: {{EmployeeName}}\nEmployee No: {{EmployeeId}}\nDepartment: {{Department}}\nDesignation: {{Designation}}\nLocation / Building: {{Location}}\nMobile No.: {{MobileNo}}\nEmail-ID: {{EmailId}}\n\n{{AssetsTable}}\n\nTerms & Conditions:\n- The laptop must be surrendered in good working condition during Resignation.\n- In case of damage to the laptop, leaving behind power adaptors, mouse, etc., Repair/Replacement cost will be borne by the Employee.\n- In case of loss/theft, the respective staff is responsible and owes it to the company, and must lodge an FIR with the local Police Station immediately.\n- In case the laptop is stolen, the employee is responsible for replacing it. The replacement cost of the new laptop + GST will be recovered from the Employee.\n- This laptop has been given only for official use. Installation & use of unauthorized/pirated software is not allowed.\n\nBy using this equipment, you agree to the above Terms & Conditions.",
        signature: "Regards,\nIT Team, GenAquarius",
      } });
      console.log("Schema: seeded default LAPTOP_HANDOVER_EMAIL template");
    }
  } catch (e) { console.error("seed LAPTOP_HANDOVER_EMAIL template failed:", e); }
  await ensureColumn("ItProvisioningRequest", "laptopHandoverEmailSentAt", "`laptopHandoverEmailSentAt` DATETIME(3) NULL");
  await ensureColumn("ItProvisioningRequest", "laptopHandoverEmailSentById", "`laptopHandoverEmailSentById` INT NULL");
  await ensureColumn("MonthlyLine", "deploymentStart", "`deploymentStart` DATETIME(3) NULL");
  await ensureColumn("MonthlyLine", "deploymentEnd", "`deploymentEnd` DATETIME(3) NULL");
  await ensureColumn("MonthlyLine", "expenseCalc", "`expenseCalc` VARCHAR(191) NULL DEFAULT 'FIXED'");
  await ensureColumn("MonthlyLine", "perResourceInr", "`perResourceInr` DOUBLE NULL");
  await ensureColumn("MonthlyLine", "percentValue", "`percentValue` DOUBLE NULL");
  await ensureColumn("MonthlyLine", "headcountOverride", "`headcountOverride` INT NULL");
  await ensureColumn("Project", "billingHoursPerDay", "`billingHoursPerDay` INT NOT NULL DEFAULT 8");
  // US engagement fields on CTC records (W2 salaried / vendor hourly).
  await ensureColumn("CtcRecord", "usEngagement", "`usEngagement` VARCHAR(191) NULL");
  await ensureColumn("CtcRecord", "hourlyRateUsd", "`hourlyRateUsd` DOUBLE NULL");
  await ensureColumn("CtcRecord", "hoursPerDay", "`hoursPerDay` INT NULL");
  await ensureColumn("CtcRecord", "workingDaysPerYear", "`workingDaysPerYear` INT NULL");
  // Hourly engagements pick a billing basis: HOURLY (hourly rate) or DAILY (day rate).
  await ensureColumn("CtcRecord", "rateBasis", "`rateBasis` VARCHAR(191) NULL");
  await ensureColumn("CtcRecord", "dayRateUsd", "`dayRateUsd` DOUBLE NULL");
  // Effective-dated employment type per comp segment (for intra-month proration).
  await ensureColumn("CtcRecord", "empType", "`empType` VARCHAR(191) NULL");
  await ensureColumn("CtcRecord", "effectiveTill", "`effectiveTill` DATETIME(3) NULL");
  await ensureColumn("EmailTemplate", "subject", "`subject` VARCHAR(191) NULL");
  await ensureColumn("Client", "ccEmail", "`ccEmail` VARCHAR(191) NULL");
  await ensureColumn("Client", "bccEmail", "`bccEmail` VARCHAR(191) NULL");
  await ensureColumn("Client", "legalEntityName", "`legalEntityName` VARCHAR(191) NULL");
  await ensureColumn("MonthlyLine", "doubleDip", "`doubleDip` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("MonthlyLine", "allocationPct", "`allocationPct` INT NOT NULL DEFAULT 100");
  await ensureColumn("Invoice", "month", "`month` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "fiscalYear", "`fiscalYear` VARCHAR(191) NULL");
  await ensureColumn("Project", "lineItemsDayBasis", "`lineItemsDayBasis` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "invoiceNameIncludeResource", "`invoiceNameIncludeResource` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "invoiceCode", "`invoiceCode` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "lineItemsDayBasis", "`lineItemsDayBasis` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("InvoiceLineItem", "dayRate", "`dayRate` DOUBLE NULL");
  await ensureColumn("InvoiceLineItem", "days", "`days` DOUBLE NULL");
  await ensureColumn("Client", "addressTo", "`addressTo` VARCHAR(191) NULL");
  await ensureColumn("Project", "poNumber", "`poNumber` VARCHAR(191) NULL");
  await ensureColumn("Project", "description", "`description` TEXT NULL");
  await ensureColumn("Project", "title", "`title` VARCHAR(191) NULL");
  await ensureColumn("Project", "invoiceNoFormat", "`invoiceNoFormat` VARCHAR(191) NULL");
  await ensureColumn("Project", "annexureHideLeaveRate", "`annexureHideLeaveRate` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureHideHours", "`annexureHideHours` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsHideHours", "`lineItemsHideHours` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureDayBasis", "`annexureDayBasis` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsHideRate", "`lineItemsHideRate` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsHideRate", "`lineItemsHideRate` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureHideLeave", "`annexureHideLeave` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureHideBillRate", "`annexureHideBillRate` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "annexureHideLeave", "`annexureHideLeave` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "annexureHideBillRate", "`annexureHideBillRate` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureSumTotal", "`annexureSumTotal` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsAddGst", "`lineItemsAddGst` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "gstPercent", "`gstPercent` DOUBLE NOT NULL DEFAULT 5");
  await ensureColumn("Invoice", "annexureSumTotal", "`annexureSumTotal` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsAddGst", "`lineItemsAddGst` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "gstPercent", "`gstPercent` DOUBLE NOT NULL DEFAULT 5");
  await ensureColumn("Invoice", "annexureHideLeaveRate", "`annexureHideLeaveRate` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "annexureHideHours", "`annexureHideHours` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsHideHours", "`lineItemsHideHours` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "annexureDayBasis", "`annexureDayBasis` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("InvoiceAnnexure", "dayRate", "`dayRate` DOUBLE NULL");
  await ensureColumn("InvoiceAnnexure", "days", "`days` DOUBLE NULL");
  await ensureColumn("InvoiceAnnexure", "timeLoggedOn", "`timeLoggedOn` VARCHAR(191) NULL");
  await ensureColumn("InvoiceAnnexure", "role", "`role` VARCHAR(191) NULL");
  await ensureColumn("Project", "lineItemsPerResource", "`lineItemsPerResource` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsSumAll", "`lineItemsSumAll` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureHideRole", "`annexureHideRole` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "annexureHide", "`annexureHide` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "annexureHideRole", "`annexureHideRole` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsShowDesc", "`lineItemsShowDesc` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsMergeDesc", "`lineItemsMergeDesc` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsDesc", "`lineItemsDesc` TEXT NULL");
  await ensureColumn("InvoiceLineItem", "detail", "`detail` VARCHAR(500) NULL");
  await ensureColumn("InvoiceLineItem", "resourceName", "`resourceName` VARCHAR(200) NULL");
  await ensureColumn("Invoice", "lineItemsShowResource", "`lineItemsShowResource` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsHideRole", "`lineItemsHideRole` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "lineItemsSumTotal", "`lineItemsSumTotal` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "columnLabels", "`columnLabels` TEXT NULL");
  await ensureColumn("Project", "columnLabels", "`columnLabels` TEXT NULL");
  await ensureColumn("Invoice", "gstExclusive", "`gstExclusive` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "gstExclusive", "`gstExclusive` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Invoice", "annexureHide", "`annexureHide` TINYINT(1) NOT NULL DEFAULT 0");
  // Timesheet entries can now split hours across "Time Logged On" heads (several entries per day).
  await ensureColumn("TimesheetEntry", "head", "`head` VARCHAR(191) NULL");
  try { await prisma.$executeRawUnsafe("ALTER TABLE `TimesheetEntry` DROP INDEX `TimesheetEntry_timesheetId_day_key`"); } catch { /* already dropped */ }
  try { await prisma.$executeRawUnsafe("ALTER TABLE `TimesheetEntry` ADD UNIQUE INDEX `TimesheetEntry_timesheetId_day_head_key` (`timesheetId`, `day`, `head`)"); } catch { /* already exists */ }
  await ensureColumn("Project", "customerRefNo", "`customerRefNo` VARCHAR(191) NULL");
  await ensureColumn("Project", "paymentTerms", "`paymentTerms` VARCHAR(191) NULL");
  // Currency + payment-term days moved from Client → Project. Backfill from the parent client the
  // ONE time each column is created, so existing CAD/INR projects keep the correct billing currency
  // (running only on creation means later per-project edits are never overwritten).
  const addedCurrency = await ensureColumn("Project", "currency", "`currency` ENUM('USD','INR','CAD') NOT NULL DEFAULT 'USD'");
  const addedTermsDays = await ensureColumn("Project", "paymentTermsDays", "`paymentTermsDays` INT NOT NULL DEFAULT 30");
  if (addedCurrency || addedTermsDays) {
    const sets = [addedCurrency ? "p.`currency` = c.`currency`" : "", addedTermsDays ? "p.`paymentTermsDays` = c.`paymentTermsDays`" : ""].filter(Boolean).join(", ");
    try { await prisma.$executeRawUnsafe("UPDATE `Project` p JOIN `Client` c ON p.`clientId` = c.`id` SET " + sets); console.log(`Schema: backfilled Project ${sets} from Client`); }
    catch (e) { console.error("backfill Project currency/paymentTermsDays failed:", e); }
  }
  await ensureColumn("Project", "billingEmail", "`billingEmail` VARCHAR(191) NULL");
  await ensureColumn("Project", "ccEmail", "`ccEmail` VARCHAR(191) NULL");
  await ensureColumn("Project", "bccEmail", "`bccEmail` VARCHAR(191) NULL");
  await ensureColumn("Project", "addressTo", "`addressTo` VARCHAR(191) NULL");
  await ensureColumn("Project", "attentionContact", "`attentionContact` VARCHAR(191) NULL");
  await ensureColumn("Project", "billToAddress", "`billToAddress` TEXT NULL");
  await ensureColumn("Invoice", "poNumber", "`poNumber` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "customerRefNo", "`customerRefNo` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "paymentTerms", "`paymentTerms` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "projectCode", "`projectCode` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "projectTitle", "`projectTitle` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "billingEmail", "`billingEmail` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "ccEmail", "`ccEmail` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "bccEmail", "`bccEmail` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "addressTo", "`addressTo` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "attentionContact", "`attentionContact` VARCHAR(191) NULL");
  await ensureColumn("Invoice", "billToAddress", "`billToAddress` TEXT NULL");
  await ensureColumn("Invoice", "layoutConfig", "`layoutConfig` TEXT NULL");
  await ensureColumn("Project", "invoiceLayoutId", "`invoiceLayoutId` INT NULL");
  await ensureColumn("Project", "lineItemsShowDesc", "`lineItemsShowDesc` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsMergeDesc", "`lineItemsMergeDesc` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsDesc", "`lineItemsDesc` TEXT NULL");
  await ensureColumn("Project", "lineItemsShowResource", "`lineItemsShowResource` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsHideRole", "`lineItemsHideRole` TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("Project", "lineItemsSumTotal", "`lineItemsSumTotal` TINYINT(1) NOT NULL DEFAULT 0");
  // Configurable invoice layout table (new table — runtime has no Prisma CLI).
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `InvoiceLayout` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `name` VARCHAR(191) NOT NULL, `isDefault` TINYINT(1) NOT NULL DEFAULT 0, " +
      "`config` TEXT NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure InvoiceLayout table failed:", e); }
  // Backfill Invoice.month for invoices created before the column existed (derive from billing period
  // start) so the bulk "bundle by month + client" email tool can find them.
  try {
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const miss = await prisma.invoice.findMany({ where: { month: null }, select: { id: true, billingPeriodStart: true } });
    for (const inv of miss) { if (inv.billingPeriodStart) await prisma.invoice.update({ where: { id: inv.id }, data: { month: M[inv.billingPeriodStart.getMonth()] } }); }
    if (miss.length) console.log(`Backfilled month on ${miss.length} invoice(s)`);
  } catch (e) { console.error("backfill Invoice.month failed:", e); }
  // Migrate the old default invoice-name format to use {InvoiceCode} (falls back to code when unset).
  try {
    const r: any = await prisma.$executeRawUnsafe("UPDATE `Project` SET `invoiceNoFormat` = '{InvoiceCode}{Year}{Month}' WHERE `invoiceNoFormat` = '{ProjectCode}{Year}{Month}'");
    if (r) console.log(`Migrated invoice-name format on ${r} project(s)`);
  } catch (e) { console.error("migrate Project.invoiceNoFormat failed:", e); }
  // Employee.empType was a native ENUM; widen it to VARCHAR so location-specific
  // employment types (W2_NO_BENEFIT, CONTRACTOR, VENDOR) can be stored. Only converts
  // while still an enum, so it's a no-op on subsequent boots.
  try {
    const r: any = await prisma.$queryRawUnsafe(
      `SELECT DATA_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'Employee' AND column_name = 'empType'`
    );
    const dtype = Array.isArray(r) ? String(r[0]?.t || "").toLowerCase() : "";
    if (dtype === "enum") {
      await prisma.$executeRawUnsafe("ALTER TABLE `Employee` MODIFY `empType` VARCHAR(191) NOT NULL DEFAULT 'FULL_TIME'");
      console.log("Schema: Employee.empType ENUM → VARCHAR");
    }
  } catch (e) { console.error("empType widen failed:", e); }
  // Holiday calendar table (new table — created here since the runtime has no Prisma CLI).
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `Holiday` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `country` VARCHAR(191) NOT NULL, `date` DATETIME(3) NOT NULL, " +
      "`name` VARCHAR(191) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`), INDEX `Holiday_country_date_idx` (`country`, `date`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure Holiday table failed:", e); }

  // ---- Employee Self-Service (onboarding docs, leave, attendance) — additive columns + new
  // tables. Same self-healing pattern as above: safe against the VNet-private production DB
  // that never gets a `prisma db push`. Every statement is independently try/caught.
  await ensureColumn("Employee", "phone", "`phone` VARCHAR(191) NULL");
  await ensureColumn("Employee", "dateOfBirth", "`dateOfBirth` DATETIME(3) NULL");
  await ensureColumn("Employee", "marriageAnniversary", "`marriageAnniversary` DATETIME(3) NULL");
  await ensureColumn("Employee", "emergencyContactName", "`emergencyContactName` VARCHAR(191) NULL");
  await ensureColumn("Employee", "emergencyContactPhone", "`emergencyContactPhone` VARCHAR(191) NULL");
  await ensureColumn("Offer", "uanPfDetails", "`uanPfDetails` VARCHAR(191) NULL");
  await ensureColumn("Employee", "uanPfDetails", "`uanPfDetails` VARCHAR(191) NULL");
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `HrLeaveType` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `countryCode` VARCHAR(191) NOT NULL DEFAULT 'INDIA', `key` VARCHAR(191) NOT NULL, " +
      "`name` VARCHAR(191) NOT NULL, `accrualPerMonth` DOUBLE NOT NULL DEFAULT 0, `annualQuota` DOUBLE NULL, " +
      "`maxCarryForward` DOUBLE NULL, `maxApplyPerYear` DOUBLE NULL, `maxConsecutiveDays` INT NULL, " +
      "`requiresProbationComplete` TINYINT(1) NOT NULL DEFAULT 0, `lapsesAtYearEnd` TINYINT(1) NOT NULL DEFAULT 0, " +
      "`sandwichEligible` TINYINT(1) NOT NULL DEFAULT 0, `order` INT NOT NULL DEFAULT 0, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `HrLeaveType_countryCode_key_key` (`countryCode`, `key`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure HrLeaveType table failed:", e); }
  await ensureColumn("HrLeaveType", "maxConsecutiveDays", "`maxConsecutiveDays` INT NULL");
  await ensureColumn("HrLeaveType", "requiresProbationComplete", "`requiresProbationComplete` TINYINT(1) NOT NULL DEFAULT 0");
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `HrLeavePolicyConfig` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `countryCode` VARCHAR(191) NOT NULL, `sandwichEnabled` TINYINT(1) NOT NULL DEFAULT 0, " +
      "`sandwichDays` INT NOT NULL DEFAULT 4, `probationDays` INT NOT NULL DEFAULT 90, `elEncashmentCapDays` DOUBLE NOT NULL DEFAULT 30, " +
      "`elEncashmentRatePerDay` DOUBLE NOT NULL DEFAULT 2000, `compOffExpiryDays` INT NOT NULL DEFAULT 30, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `HrLeavePolicyConfig_countryCode_key` (`countryCode`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure HrLeavePolicyConfig table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `LeaveBalance` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `leaveTypeId` INT NOT NULL, `year` INT NOT NULL, " +
      "`accrued` DOUBLE NOT NULL DEFAULT 0, `used` DOUBLE NOT NULL DEFAULT 0, `carriedIn` DOUBLE NOT NULL DEFAULT 0, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `LeaveBalance_employeeId_leaveTypeId_year_key` (`employeeId`, `leaveTypeId`, `year`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure LeaveBalance table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `LeaveRequest` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `leaveTypeId` INT NOT NULL, `fromDate` DATETIME(3) NOT NULL, " +
      "`toDate` DATETIME(3) NOT NULL, `days` DOUBLE NOT NULL, `sandwichDeducted` DOUBLE NOT NULL DEFAULT 0, `reason` TEXT NULL, " +
      "`status` ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING', `approvedById` INT NULL, " +
      "`approvedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`), INDEX `LeaveRequest_employeeId_status_idx` (`employeeId`, `status`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure LeaveRequest table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `AttendanceRecord` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `date` DATETIME(3) NOT NULL, " +
      "`status` VARCHAR(191) NOT NULL DEFAULT 'PRESENT', `markedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `AttendanceRecord_employeeId_date_key` (`employeeId`, `date`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure AttendanceRecord table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `OnboardingDocumentType` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `name` VARCHAR(191) NOT NULL, `required` TINYINT(1) NOT NULL DEFAULT 1, " +
      "`order` INT NOT NULL DEFAULT 0, PRIMARY KEY (`id`), UNIQUE INDEX `OnboardingDocumentType_name_key` (`name`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure OnboardingDocumentType table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `EmployeeOnboardingDocument` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `docTypeId` INT NOT NULL, `fileName` VARCHAR(191) NULL, " +
      "`fileData` LONGTEXT NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING', `submittedAt` DATETIME(3) NULL, " +
      "`reviewedById` INT NULL, `reviewedAt` DATETIME(3) NULL, `note` TEXT NULL, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `EmployeeOnboardingDocument_employeeId_docTypeId_key` (`employeeId`, `docTypeId`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure EmployeeOnboardingDocument table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `CompOffCredit` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `days` DOUBLE NOT NULL, " +
      "`creditedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `expiresAt` DATETIME(3) NOT NULL, " +
      "`consumedDays` DOUBLE NOT NULL DEFAULT 0, `note` TEXT NULL, `grantedById` INT NULL, " +
      "`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`), INDEX `CompOffCredit_employeeId_expiresAt_idx` (`employeeId`, `expiresAt`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure CompOffCredit table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `EmployeeAction` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `type` VARCHAR(191) NOT NULL, " +
      "`status` VARCHAR(191) NOT NULL DEFAULT 'OPEN', `periodMonth` INT NULL, `periodYear` INT NULL, `note` TEXT NULL, " +
      "`assignedById` INT NULL, `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `closedAt` DATETIME(3) NULL, " +
      "PRIMARY KEY (`id`), INDEX `EmployeeAction_employeeId_status_idx` (`employeeId`, `status`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure EmployeeAction table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `ReminderLog` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `actionType` VARCHAR(191) NOT NULL, " +
      "`sentDate` VARCHAR(191) NOT NULL, `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `ReminderLog_employeeId_actionType_sentDate_key` (`employeeId`, `actionType`, `sentDate`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure ReminderLog table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `ItProvisioningRequest` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `offerId` INT NOT NULL, `laptopConfiguration` TEXT NOT NULL, " +
      "`osRequirement` VARCHAR(191) NOT NULL, `emailIdToCreate` VARCHAR(191) NOT NULL, `phoneNumber` VARCHAR(191) NULL, " +
      "`requestedById` INT NULL, `sentAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "`updatedAt` DATETIME(3) NOT NULL, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `ItProvisioningRequest_offerId_key` (`offerId`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure ItProvisioningRequest table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `EmployeeProfileFieldConfig` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `section` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, `label` VARCHAR(191) NOT NULL, " +
      "`fieldType` VARCHAR(191) NOT NULL, `options` JSON NULL, `required` TINYINT(1) NOT NULL DEFAULT 0, " +
      "`order` INT NOT NULL DEFAULT 0, `enabled` TINYINT(1) NOT NULL DEFAULT 1, " +
      "`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `EmployeeProfileFieldConfig_key_key` (`key`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure EmployeeProfileFieldConfig table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `EmployeeProfileSubmission` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `employeeId` INT NOT NULL, `values` JSON NOT NULL, " +
      "`education` JSON NULL, `family` JSON NULL, `nomination` JSON NULL, " +
      "`status` VARCHAR(191) NOT NULL DEFAULT 'PENDING', `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "`reviewedById` INT NULL, `reviewedAt` DATETIME(3) NULL, `reviewNote` TEXT NULL, `updatedAt` DATETIME(3) NOT NULL, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `EmployeeProfileSubmission_employeeId_key` (`employeeId`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure EmployeeProfileSubmission table failed:", e); }
  // Seeds the default field catalog once — HR can then edit/reorder/disable/add from HR Settings.
  // Never re-seeds if HR has already added/removed anything (checked via a simple row count).
  try {
    const existingFieldCount = await prisma.employeeProfileFieldConfig.count();
    if (existingFieldCount === 0) {
      const defaults: { section: string; key: string; label: string; fieldType: string; options?: string[]; required?: boolean; order: number }[] = [
        { section: "PERSONAL", key: "bloodGroup", label: "Blood Group", fieldType: "SELECT", options: ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"], order: 1 },
        { section: "PERSONAL", key: "nationality", label: "Nationality", fieldType: "TEXT", order: 2 },
        { section: "PERSONAL", key: "placeOfBirth", label: "Place of Birth", fieldType: "TEXT", order: 3 },
        { section: "PERSONAL", key: "residentialStatus", label: "Residential Status", fieldType: "SELECT", options: ["Resident", "Non-Resident"], order: 4 },
        { section: "PERSONAL", key: "fatherName", label: "Father's Name", fieldType: "TEXT", order: 5 },
        { section: "PERSONAL", key: "religion", label: "Religion", fieldType: "TEXT", order: 6 },
        { section: "PERSONAL", key: "physicallyChallenged", label: "Physically Challenged", fieldType: "BOOLEAN", order: 7 },
        { section: "PERSONAL", key: "internationalEmployee", label: "International Employee", fieldType: "BOOLEAN", order: 8 },
        { section: "PERSONAL", key: "height", label: "Height", fieldType: "TEXT", order: 9 },
        { section: "PERSONAL", key: "weight", label: "Weight", fieldType: "TEXT", order: 10 },
        { section: "PERSONAL", key: "identificationMark", label: "Identification Mark", fieldType: "TEXT", order: 11 },
        { section: "PERSONAL", key: "spouseName", label: "Spouse Name", fieldType: "TEXT", order: 12 },
        { section: "PERSONAL", key: "spouseDateOfBirth", label: "Spouse Date of Birth", fieldType: "DATE", order: 13 },
        { section: "ADDRESS", key: "correspondenceAddress", label: "Correspondence Address (if different from Resident)", fieldType: "TEXT", order: 1 },
        { section: "BANK", key: "bankName", label: "Bank Name", fieldType: "TEXT", order: 1 },
        { section: "BANK", key: "bankAccountNumber", label: "Bank Account Number", fieldType: "TEXT", order: 2 },
        { section: "BANK", key: "bankBranch", label: "Bank Branch", fieldType: "TEXT", order: 3 },
        { section: "BANK", key: "bankIfsc", label: "Bank IFSC", fieldType: "TEXT", order: 4 },
        { section: "PF", key: "pfNumber", label: "PF Number", fieldType: "TEXT", order: 1 },
        { section: "PF", key: "uan", label: "UAN", fieldType: "TEXT", order: 2 },
        { section: "PF", key: "pfJoinDate", label: "PF Join Date", fieldType: "DATE", order: 3 },
        { section: "PF", key: "pfEligibility", label: "Eligibility", fieldType: "SELECT", options: ["Eligible", "Not Eligible"], order: 4 },
        { section: "KYC", key: "aadhaarNumber", label: "Aadhaar Number", fieldType: "TEXT", order: 1 },
        { section: "KYC", key: "panNumber", label: "PAN Number", fieldType: "TEXT", order: 2 },
      ];
      for (const d of defaults) {
        await prisma.employeeProfileFieldConfig.create({ data: { section: d.section, key: d.key, label: d.label, fieldType: d.fieldType, options: d.options ? (d.options as any) : undefined, required: !!d.required, order: d.order } });
      }
      console.log(`Schema: seeded ${defaults.length} default EmployeeProfileFieldConfig rows`);
    }
  } catch (e) { console.error("seed EmployeeProfileFieldConfig defaults failed:", e); }
  // Attendance Regularization & Permission — batch-apply extras added alongside the IT Helpdesk
  // work (routes/ess.ts references these; the tables themselves already existed pre-dating this
  // session, only these columns are new).
  await ensureColumn("AttendanceRegularizationRequest", "remarks", "`remarks` TEXT NULL");
  await ensureColumn("AttendanceRegularizationRequest", "ccEmails", "`ccEmails` TEXT NULL");
  await ensureColumn("PermissionRequest", "permissionType", "`permissionType` VARCHAR(191) NULL");
  await ensureColumn("PermissionRequest", "remarks", "`remarks` TEXT NULL");
  await ensureColumn("PermissionRequest", "ccEmails", "`ccEmails` TEXT NULL");
  // IT Helpdesk — tickets, comments, asset catalog, assigned IT assets, knowledge base. Routes
  // already exist (routes/helpdesk.ts) but had no self-healing schema entry yet — without this,
  // every /api/helpdesk endpoint would 500 in production ("table doesn't exist").
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `HelpdeskTicket` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `type` VARCHAR(191) NOT NULL DEFAULT 'INCIDENT', `requesterUserId` INT NOT NULL, `employeeId` INT NULL, " +
      "`category` VARCHAR(191) NOT NULL, `priority` VARCHAR(191) NOT NULL DEFAULT 'MEDIUM', `subject` VARCHAR(191) NOT NULL, `description` TEXT NOT NULL, " +
      "`details` JSON NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN', `approvalStatus` VARCHAR(191) NULL, `managerEmployeeId` INT NULL, " +
      "`managerDecisionById` INT NULL, `managerDecisionAt` DATETIME(3) NULL, `managerNote` TEXT NULL, `rejectedBy` VARCHAR(191) NULL, " +
      "`assignedToId` INT NULL, `resolution` TEXT NULL, `attachmentName` VARCHAR(191) NULL, `attachmentData` LONGTEXT NULL, " +
      "`resolvedAt` DATETIME(3) NULL, `closedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
      "PRIMARY KEY (`id`), INDEX `HelpdeskTicket_requesterUserId_status_idx` (`requesterUserId`, `status`), " +
      "INDEX `HelpdeskTicket_status_type_idx` (`status`, `type`), INDEX `HelpdeskTicket_managerEmployeeId_approvalStatus_idx` (`managerEmployeeId`, `approvalStatus`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure HelpdeskTicket table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `HelpdeskComment` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `ticketId` INT NOT NULL, `authorUserId` INT NOT NULL, `authorName` VARCHAR(191) NOT NULL, " +
      "`body` TEXT NOT NULL, `isInternal` TINYINT(1) NOT NULL DEFAULT 0, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`), INDEX `HelpdeskComment_ticketId_idx` (`ticketId`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure HelpdeskComment table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `AssetCatalogItem` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `name` VARCHAR(191) NOT NULL, `category` VARCHAR(191) NOT NULL, `description` TEXT NULL, " +
      "`icon` VARCHAR(191) NULL, `requiresApproval` TINYINT(1) NOT NULL DEFAULT 0, `active` TINYINT(1) NOT NULL DEFAULT 1, " +
      "`order` INT NOT NULL DEFAULT 0, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
      "PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure AssetCatalogItem table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `ItAsset` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `assetTag` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `category` VARCHAR(191) NOT NULL, " +
      "`make` VARCHAR(191) NULL, `model` VARCHAR(191) NULL, `serialNo` VARCHAR(191) NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'IN_STOCK', " +
      "`assignedEmployeeId` INT NULL, `assignedAt` DATETIME(3) NULL, `purchaseDate` DATETIME(3) NULL, `warrantyTill` DATETIME(3) NULL, `notes` TEXT NULL, " +
      "`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
      "PRIMARY KEY (`id`), UNIQUE INDEX `ItAsset_assetTag_key` (`assetTag`), INDEX `ItAsset_assignedEmployeeId_idx` (`assignedEmployeeId`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure ItAsset table failed:", e); }
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `KbArticle` (" +
      "`id` INT NOT NULL AUTO_INCREMENT, `title` VARCHAR(191) NOT NULL, `category` VARCHAR(191) NOT NULL, `summary` TEXT NULL, " +
      "`body` LONGTEXT NULL, `fileName` VARCHAR(191) NULL, `fileSize` INT NULL, `fileData` LONGTEXT NULL, `tags` VARCHAR(191) NULL, " +
      "`published` TINYINT(1) NOT NULL DEFAULT 1, `views` INT NOT NULL DEFAULT 0, `createdById` INT NULL, " +
      "`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
      "PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure KbArticle table failed:", e); }
  // Company Settings -> Date & Time Format — self-healing safety net in case the Prisma schema
  // push is ever missed (see [[deploy-order-schema-before-code]] memory): without this,
  // loadDateTimeFormatSetting() below would just silently keep the hardcoded default, which is
  // harmless, but creating the row-of-one table here means a save from the UI works immediately
  // even on a fresh environment.
  try {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS `CompanyDateTimeSetting` (" +
      "`id` INT NOT NULL, `dateFormat` VARCHAR(191) NOT NULL DEFAULT 'MMM_D_ORD_YYYY', `timeFormat` VARCHAR(191) NOT NULL DEFAULT 'H12', " +
      "`updatedById` INT NULL, `updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4"
    );
  } catch (e) { console.error("ensure CompanyDateTimeSetting table failed:", e); }
}

ensureSchema().finally(() => {
  const server = http.createServer(app);
  initRealtime(server);
  server.listen(config.port, () => {
    console.log(`GenAquarius ERP API listening on http://localhost:${config.port}`);
    rotateAuditLog();                                    // purge on boot
    setInterval(rotateAuditLog, 24 * 60 * 60 * 1000);    // and once a day
    seedDefaultWorkflowIfMissing().catch((e) => console.error("Workflow seed failed:", e)); // no-op once one's published
    normalizeRenamedStageNames().catch((e) => console.error("Stage name normalization failed:", e)); // no-op once run
    // Reminder cadence (how many times/day, at what times) is configurable per flow from
    // Notification Settings, so this ticks every 15 min rather than once a day — reminderTick()
    // itself is a no-op unless "now" matches one of a flow's configured send times.
    reminderTick();
    setInterval(reminderTick, 15 * 60 * 1000);
    loadDateTimeFormatSetting().catch((e) => console.error("Date/Time format load failed:", e));
  });
});
