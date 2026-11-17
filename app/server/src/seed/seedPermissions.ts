// Idempotent seed for RolePermission — the canonical page catalog that backs the
// CTO-editable Module Access Matrix (see routes/permissions.ts + client pages/AccessMatrix.tsx).
// Seed values reproduce EXACTLY the current static role logic in auth/auth.ts (ADMIN_ROLES,
// HR_OPS_ROLES, HR_SETTINGS_ROLES) and the NAV/Route guards in client/src/App.tsx, so seeding
// this does not change any existing user's access — it only turns today's hardcoded rules into
// editable DB rows (the zero-regression anchor).
//
// Like seedHr.ts, this only fills gaps (update: {}) — re-running it after a CTO has edited the
// matrix in the UI does NOT clobber their edits back to defaults.
// Run with: npm run seed:permissions
import { prisma } from "../prisma";
import { Role } from "@prisma/client";

const ADMIN_ROLES: Role[] = [Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.QA];
const HR_OPS_ROLES: Role[] = [Role.HR, Role.CEO, Role.COO, Role.CTO];
const HR_SETTINGS_ROLES: Role[] = [Role.HR, Role.CEO, Role.COO, Role.CTO, Role.FINANCE];
const ALL_ROLES: Role[] = [Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.PROJECT_MANAGER, Role.EMPLOYEE, Role.INTERN, Role.CONTRACTOR, Role.HR, Role.QA, Role.IT_ADMIN];

interface PageDef { moduleKey: string; pageKey: string; pageLabel: string; roles: Role[]; }

// Matches the NAV array in app/client/src/App.tsx exactly, group for group, item for item.
const CATALOG: PageDef[] = [
  { moduleKey: "Dashboards", pageKey: "ceo-dashboard", pageLabel: "Executive Dashboard", roles: ADMIN_ROLES },
  { moduleKey: "Dashboards", pageKey: "finance-dashboard", pageLabel: "Finance Dashboard", roles: ADMIN_ROLES },
  { moduleKey: "Dashboards", pageKey: "ai-report", pageLabel: "AI Report", roles: ADMIN_ROLES },

  { moduleKey: "HR", pageKey: "hr-dashboard", pageLabel: "HR Dashboard", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-offers", pageLabel: "Offers & Lifecycle", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-onboarding-history", pageLabel: "Onboarding History", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-confirm-joining", pageLabel: "Confirm Joining — Employee Activation", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-appraisals", pageLabel: "Appraisals", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-relieving-letters", pageLabel: "Relieving & Experience Letters", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-terminate", pageLabel: "Terminate Employee", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-settings", pageLabel: "HR Admin Settings", roles: HR_SETTINGS_ROLES },
  { moduleKey: "HR", pageKey: "hr-workflow-settings", pageLabel: "Workflow & Stage Configuration", roles: HR_OPS_ROLES },
  { moduleKey: "HR", pageKey: "hr-onboarding-documents", pageLabel: "Onboarding Documents", roles: HR_SETTINGS_ROLES },
  { moduleKey: "HR", pageKey: "hr-profile-submissions", pageLabel: "Additional Profile Details", roles: HR_SETTINGS_ROLES },

  { moduleKey: "Employee", pageKey: "employee-dashboard", pageLabel: "Employee Dashboard", roles: [Role.EMPLOYEE, Role.INTERN, Role.CONTRACTOR, Role.PROJECT_MANAGER, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.HR, Role.QA] },
  { moduleKey: "Employee", pageKey: "employees", pageLabel: "Employee Master", roles: [Role.HR, Role.FINANCE, Role.CTO, Role.CEO, Role.COO] },

  { moduleKey: "Finance", pageKey: "approvals", pageLabel: "Timesheet Approvals", roles: [Role.PROJECT_MANAGER, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.QA] },
  { moduleKey: "Finance", pageKey: "ctc-approvals", pageLabel: "CTC Approvals", roles: [Role.FINANCE, Role.CEO, Role.COO, Role.CTO] },
  { moduleKey: "Finance", pageKey: "termination-approvals", pageLabel: "Termination Approvals", roles: [Role.FINANCE, Role.CEO, Role.COO, Role.CTO] },
  { moduleKey: "Finance", pageKey: "appraisal-approvals", pageLabel: "Appraisal Approvals", roles: [Role.FINANCE, Role.CEO, Role.COO, Role.CTO] },
  { moduleKey: "Finance", pageKey: "clients", pageLabel: "Clients", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "projects", pageLabel: "Projects", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "ctc", pageLabel: "CTC Management", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "holidays", pageLabel: "Annual Leaves (Holiday)", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "monthly-forecast", pageLabel: "Forecast Monthly Revenue & Expenses", roles: ADMIN_ROLES },
  // Reachable at /expenses (no NAV entry / no client-side pageKey yet — AdminRoute with no
  // pageKey prop in App.tsx), but its own API (/api/expenses) is now matrix-gated on the server;
  // roles mirror the route's current requireAdmin (ADMIN_ROLES) exactly, so this is zero-regression.
  { moduleKey: "Finance", pageKey: "expenses", pageLabel: "Expenses & Vendors", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "timesheet-templates", pageLabel: "Timesheet Templates & Import", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "approved-hours", pageLabel: "Approved Hours", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "invoices-generate", pageLabel: "Generate Invoice", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "invoices-existing", pageLabel: "Existing Invoice", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "email-invoices", pageLabel: "Email Invoices", roles: ADMIN_ROLES },
  { moduleKey: "Finance", pageKey: "invoice-reconciliation", pageLabel: "Invoice Reconciliation", roles: ADMIN_ROLES },

  { moduleKey: "Administration", pageKey: "company-settings", pageLabel: "Company Settings (Country, Business Unit, Designation & Department)", roles: ADMIN_ROLES },
  { moduleKey: "Administration", pageKey: "finance-settings", pageLabel: "Finance Settings (Tax, FX Rates, Invoice & Email Templates)", roles: ADMIN_ROLES },
  { moduleKey: "Administration", pageKey: "users-roles", pageLabel: "Users & Roles", roles: ADMIN_ROLES },
  { moduleKey: "Administration", pageKey: "access-matrix", pageLabel: "Module Access Matrix", roles: [Role.CEO, Role.COO, Role.CTO] },
  { moduleKey: "Administration", pageKey: "notification-settings", pageLabel: "Notification Settings", roles: [Role.CEO, Role.COO, Role.CTO] },
  { moduleKey: "Administration", pageKey: "integrations", pageLabel: "Integrations", roles: ADMIN_ROLES },
  { moduleKey: "Administration", pageKey: "audit-log", pageLabel: "Audit Log", roles: ADMIN_ROLES },

  { moduleKey: "Employee", pageKey: "my-timesheet", pageLabel: "My Timesheet", roles: [Role.EMPLOYEE, Role.INTERN, Role.CONTRACTOR, Role.PROJECT_MANAGER, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.QA] },
  { moduleKey: "Employee", pageKey: "my-profile", pageLabel: "My Profile", roles: [Role.EMPLOYEE, Role.INTERN, Role.CONTRACTOR, Role.PROJECT_MANAGER, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.HR, Role.QA] },
  // Deliberately NOT given to CONTRACTOR (see the Role enum's own comment) — Holiday Calendar and
  // Leave & Attendance stay Employee-only by default.
  { moduleKey: "Employee", pageKey: "holiday-calendar", pageLabel: "Holiday Calendar", roles: [Role.EMPLOYEE, Role.INTERN, Role.PROJECT_MANAGER, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.HR, Role.QA] },
  { moduleKey: "Employee", pageKey: "leave-attendance", pageLabel: "Leave & Attendance", roles: [Role.EMPLOYEE, Role.INTERN, Role.PROJECT_MANAGER, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.HR, Role.QA] },
  { moduleKey: "IT Helpdesk", pageKey: "helpdesk", pageLabel: "IT Helpdesk (tickets, assets, knowledge base, elevated access)", roles: ALL_ROLES },
  { moduleKey: "IT Helpdesk", pageKey: "helpdesk-console", pageLabel: "Helpdesk Console (IT)", roles: [Role.IT_ADMIN, ...ADMIN_ROLES] },
  { moduleKey: "Employee", pageKey: "leave-approvals", pageLabel: "Leave Approvals", roles: [Role.PROJECT_MANAGER, Role.HR, Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.QA] },
  { moduleKey: "IT Admin", pageKey: "it-admin", pageLabel: "IT Admin (new-hire provisioning queue)", roles: [Role.IT_ADMIN, ...ADMIN_ROLES] },
  { moduleKey: "Quality Management", pageKey: "qms-portal-link", pageLabel: "Quality Management (external portal link)", roles: [Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.QA, Role.HR] },
];

// Exported (not just self-executing) so this idempotent seed can also be triggered in-process
// from a running server (e.g. a one-off admin route) without disconnecting the shared Prisma
// client — only the standalone `npm run seed:permissions` CLI path disconnects, below.
export async function main() {
  let created = 0, skipped = 0;
  for (const page of CATALOG) {
    for (const role of ALL_ROLES) {
      const allowed = page.roles.includes(role);
      const existing = await prisma.rolePermission.findUnique({ where: { role_pageKey: { role, pageKey: page.pageKey } } });
      if (existing) { skipped++; continue; }
      await prisma.rolePermission.create({
        data: { role, pageKey: page.pageKey, moduleKey: page.moduleKey, pageLabel: page.pageLabel, allowed },
      });
      created++;
    }
  }
  const msg = `RolePermission seed: created ${created}, already present ${skipped} (catalog: ${CATALOG.length} pages x ${ALL_ROLES.length} roles).`;
  console.log(msg);
  return msg;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
