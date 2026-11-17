import React from "react";
import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { useToast } from "./components";
import { loadDateFormatSetting, onDateFormatChange } from "./dateFormat";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import InsightsRoundedIcon from "@mui/icons-material/InsightsRounded";
import AccountBalanceRoundedIcon from "@mui/icons-material/AccountBalanceRounded";
import BusinessRoundedIcon from "@mui/icons-material/BusinessRounded";
import WorkRoundedIcon from "@mui/icons-material/WorkRounded";
import PeopleRoundedIcon from "@mui/icons-material/PeopleRounded";
import PaymentsRoundedIcon from "@mui/icons-material/PaymentsRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import TableChartRoundedIcon from "@mui/icons-material/TableChartRounded";
import FactCheckRoundedIcon from "@mui/icons-material/FactCheckRounded";
import ReceiptLongRoundedIcon from "@mui/icons-material/ReceiptLongRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ManageAccountsRoundedIcon from "@mui/icons-material/ManageAccountsRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import BadgeRoundedIcon from "@mui/icons-material/BadgeRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { useAuth, isAdmin } from "./auth";
import { getMaskNumbers, setMaskNumbers, useMaskNumbers, useFetch } from "./ui";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { usePermissions } from "./permissions";

const ICON = { sx: { fontSize: 18, mr: "10px", verticalAlign: "-4px" } } as const;
import Login from "./pages/shared/Login";
import CandidateDocumentUpload from "./pages/public/CandidateDocumentUpload";
import CeoDashboard from "./pages/finance/CeoDashboard";
import FinanceDashboard from "./pages/finance/FinanceDashboard";
import AiReport from "./pages/shared/AiReport";
import { Employees, PastEmployees, RelievingLetters, Ctc, Clients, Projects } from "./pages/shared/Masters";
import { MonthlySheet, Expenses, Invoices, ExistingInvoices, EmailInvoices } from "./pages/finance/Operations";
import InvoiceReconciliation from "./pages/finance/InvoiceReconciliation";
import ExpenseReconciliation from "./pages/finance/ExpenseReconciliation";
import { Users, Integrations, Audit, Timesheet, CompanySettings } from "./pages/shared/People";
import { Approvals, ApprovedHours, FinanceSettings } from "./pages/shared/Extras";
import { HrDashboard, HrSettings, GenerateOffer, OffersList, OfferDetail, ConfirmJoiningQueue, OnboardingHistory, TerminateEmployeePage } from "./pages/hrms/Hr";
import { CtcApprovals } from "./pages/hrms/CtcApprovals";
import { TerminationApprovals, FnfPendingApprovals } from "./pages/hrms/TerminationApprovals";
import { AppraisalsList, GenerateAppraisal, AppraisalDetail } from "./pages/hrms/Appraisals";
import { AppraisalApprovals } from "./pages/hrms/AppraisalApprovals";
import { AccessMatrix } from "./pages/shared/AccessMatrix";
import { NotificationSettings } from "./pages/shared/NotificationSettings";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import { EmployeeDashboard, MyProfile, HolidayCalendar, LeaveAndAttendance, LeaveApprovals, OnboardingDocumentsReview, ProfileSubmissionsReview } from "./pages/hrms/Ess";
import { ItAdminDashboard, ItOffboardingDashboard } from "./pages/itsm/ItAdmin";
import { HelpdeskHome, MyTickets, RaiseTicket, AssetCatalog, MyAssets, KnowledgeBase, RequestAsset, ElevatedAccess, TeamApprovals, HelpdeskSettingsPage, HelpdeskTicketQueuePage, HelpdeskAssetInventoryPage, HelpdeskAssetCatalogAdminPage, HelpdeskAccessReportsPage, HelpdeskKbAdminPage, HelpdeskDashboardPage } from "./pages/itsm/Helpdesk";
import SupportAgentRoundedIcon from "@mui/icons-material/SupportAgentRounded";
import ConfirmationNumberRoundedIcon from "@mui/icons-material/ConfirmationNumberRounded";
import AddCircleOutlineRoundedIcon from "@mui/icons-material/AddCircleOutlineRounded";
import DevicesRoundedIcon from "@mui/icons-material/DevicesRounded";
import MenuBookRoundedIcon from "@mui/icons-material/MenuBookRounded";
import Inventory2RoundedIcon from "@mui/icons-material/Inventory2Rounded";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import LaptopRoundedIcon from "@mui/icons-material/LaptopRounded";
import ApprovalRoundedIcon from "@mui/icons-material/ApprovalRounded";
import BadgeRoundedIcon2 from "@mui/icons-material/AssignmentIndRounded";
import EventAvailableRoundedIcon from "@mui/icons-material/EventAvailableRounded";
import BeachAccessRoundedIcon from "@mui/icons-material/BeachAccessRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import TaskAltRoundedIcon from "@mui/icons-material/TaskAltRounded";
import PersonAddRoundedIcon from "@mui/icons-material/PersonAddRounded";
import VerifiedRoundedIcon from "@mui/icons-material/VerifiedRounded";
import PersonRemoveRoundedIcon from "@mui/icons-material/PersonRemoveRounded";
import GradeRoundedIcon from "@mui/icons-material/GradeRounded";
import RateReviewRoundedIcon from "@mui/icons-material/RateReviewRounded";

// HR is intentionally its own tier: never bundled into ADMIN_ROLES (Executive/Finance
// dashboards stay off-limits), but CEO/CTO can still see HR operations too.
const HR_OPS_ROLES = ["HR", "CEO", "COO", "CTO"];
const HR_SETTINGS_ROLES = ["HR", "CEO", "COO", "CTO", "FINANCE"];
const ALL_APP_ROLES = ["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"];

// The QMS portal is a separate existing system, integrated here as a plain external link once
// its URL is provided — set this one constant then swap the "#qms" placeholder item below for a
// real <a href={QMS_PORTAL_URL} target="_blank"> in the sidebar render. Empty today = "coming soon".
const QMS_PORTAL_URL = "";

// pageKey on each item matches the RolePermission catalog seeded by server/src/seed/seedPermissions.ts
// (Module Access Matrix). It's consulted ADDITIONALLY to roles/admin below via can(pageKey) — never
// instead of them — so a page nobody has toggled off in the matrix behaves exactly as before.
// One accent color per nav group — gives the sidebar an at-a-glance color code (like the colorful
// stat/action tiles on Helpdesk pages) instead of every icon reading as the same flat muted tone.
// Applied to each item's icon in Shell's render (cloneElement), not baked into the icon JSX below,
// so this stays a single place to retune the palette.
const GROUP_COLOR: Record<string, string> = {
  Dashboards: "#6366f1", HR: "#ec4899", Employee: "#14b8a6", "IT Helpdesk": "#f97316",
  "IT Admin": "#ef4444", "Quality Management": "#8b5cf6", Finance: "#eab308", Administration: "#64748b",
};

const NAV = [
  { group: "Dashboards", items: [
    { to: "/ceo", label: "Executive Dashboard", admin: true, pageKey: "ceo-dashboard", icon: <InsightsRoundedIcon {...ICON} /> },
    { to: "/finance", label: "Finance Dashboard", admin: true, pageKey: "finance-dashboard", icon: <AccountBalanceRoundedIcon {...ICON} /> },
    { to: "/ai-report", label: "AI Report", admin: true, pageKey: "ai-report", icon: <AutoAwesomeRoundedIcon {...ICON} /> },
  ]},
  { group: "HR", items: [
    { to: "/hr", label: "HR Dashboard", roles: HR_OPS_ROLES, pageKey: "hr-dashboard", icon: <BadgeRoundedIcon {...ICON} /> },
    { to: "/hr/offers", label: "Onboarding Flow", roles: HR_OPS_ROLES, pageKey: "hr-offers", icon: <ReceiptLongRoundedIcon {...ICON} /> },
    { to: "/hr/onboarding-history", label: "Onboarding History", roles: HR_OPS_ROLES, pageKey: "hr-onboarding-history", icon: <HistoryRoundedIcon {...ICON} /> },
    { to: "/hr/confirm-joining", label: "Onboarding Activation", roles: HR_OPS_ROLES, pageKey: "hr-confirm-joining", icon: <PersonAddRoundedIcon {...ICON} /> },
    { to: "/hr/appraisals", label: "Appraisals", roles: HR_OPS_ROLES, pageKey: "hr-appraisals", icon: <GradeRoundedIcon {...ICON} /> },
    { to: "/hr/terminate", label: "Terminate Employee", roles: HR_OPS_ROLES, pageKey: "hr-terminate", icon: <PersonRemoveRoundedIcon {...ICON} /> },
    { to: "/hr/settings?tab=holidays", label: "Annual Leaves (Holiday)", roles: HR_SETTINGS_ROLES, pageKey: "hr-settings", icon: <CalendarMonthRoundedIcon {...ICON} /> },
    { to: "/hr/onboarding-documents", label: "Onboarding Documents", roles: HR_SETTINGS_ROLES, pageKey: "hr-onboarding-documents", icon: <TaskAltRoundedIcon {...ICON} /> },
    { to: "/hr/profile-submissions", label: "Additional Profile Details", roles: HR_SETTINGS_ROLES, pageKey: "hr-profile-submissions", icon: <TaskAltRoundedIcon {...ICON} /> },
    { to: "/employees", label: "Employee Master", roles: ["HR", "CTO", "CEO", "COO"], pageKey: "employees", icon: <PeopleRoundedIcon {...ICON} /> },
    { to: "/past-employees", label: "Past / Terminated Employees", roles: ["HR", "CTO", "FINANCE"], pageKey: "employees", icon: <PersonRemoveRoundedIcon {...ICON} /> },
    { to: "/hr/relieving-letters", label: "Relieving Letter", roles: HR_OPS_ROLES, pageKey: "hr-relieving-letters", icon: <DescriptionRoundedIcon {...ICON} /> },
  ]},
  { group: "Employee", items: [
    { to: "/employee-dashboard", label: "Employee Dashboard", roles: ["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"], pageKey: "employee-dashboard", icon: <InsightsRoundedIcon {...ICON} /> },
    { to: "/timesheet", label: "My Timesheet", roles: ["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "my-timesheet", icon: <CalendarMonthRoundedIcon {...ICON} /> },
    // Also surfaced under Finance for FINANCE/CEO/CTO/QA (same pageKey "approvals" — the Module
    // Access Matrix toggle governs both spots at once). A Project Manager's day-to-day is the
    // Employee-tier nav, so their own approvals queue lives there too instead of only under Finance.
    { to: "/approvals", label: "Timesheet Approvals", roles: ["PROJECT_MANAGER"], pageKey: "approvals", icon: <RuleRoundedIcon {...ICON} /> },
    { to: "/my-profile", label: "My Profile", roles: ["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"], pageKey: "my-profile", icon: <BadgeRoundedIcon2 {...ICON} /> },
    { to: "/my-profile?tab=additional", label: "Additional Profile Details", roles: ["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"], pageKey: "my-profile", icon: <TaskAltRoundedIcon {...ICON} /> },
    { to: "/holiday-calendar", label: "Holiday Calendar", roles: ["EMPLOYEE", "INTERN", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"], pageKey: "holiday-calendar", icon: <EventAvailableRoundedIcon {...ICON} /> },
    { to: "/leave-attendance", label: "Leave & Attendance", roles: ["EMPLOYEE", "INTERN", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"], pageKey: "leave-attendance", icon: <BeachAccessRoundedIcon {...ICON} /> },
    { to: "/leave-approvals", label: "Leave Approvals", roles: ["PROJECT_MANAGER", "HR", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "leave-approvals", icon: <HowToRegRoundedIcon {...ICON} /> },
  ]},
  { group: "IT Helpdesk", items: [
    { to: "/helpdesk", label: "Helpdesk Dashboard", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <SupportAgentRoundedIcon {...ICON} /> },
    { to: "/helpdesk/tickets", label: "My Tickets", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <ConfirmationNumberRoundedIcon {...ICON} /> },
    { to: "/helpdesk/raise", label: "Raise Ticket", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <AddCircleOutlineRoundedIcon {...ICON} /> },
    { to: "/helpdesk/catalog", label: "Asset Catalog", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <DevicesRoundedIcon {...ICON} /> },
    { to: "/helpdesk/my-assets", label: "My Assigned Assets", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <LaptopRoundedIcon {...ICON} /> },
    { to: "/helpdesk/kb", label: "Knowledge Base", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <MenuBookRoundedIcon {...ICON} /> },
    { to: "/helpdesk/request-asset", label: "Request an Asset", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <Inventory2RoundedIcon {...ICON} /> },
    { to: "/helpdesk/elevated-access", label: "Elevated Access", roles: ALL_APP_ROLES, pageKey: "helpdesk", icon: <KeyRoundedIcon {...ICON} /> },
    // "Ensure the Pending Approval menu is displayed only to employees with reporting
    // employees" — requiresManager is resolved live in useVisibleNav() below via
    // GET /helpdesk/am-i-a-manager (Employee.reportingManager name-matched, same resolution
    // convention createApprovalRequest() already uses for routing a request TO a manager).
    { to: "/helpdesk/approvals", label: "Pending Approval", roles: ALL_APP_ROLES, pageKey: "helpdesk", requiresManager: true, icon: <ApprovalRoundedIcon {...ICON} /> },
  ]},
  { group: "IT Admin", items: [
    // Operational screens live here (like HR Dashboard/Offers live under "HR"). The module's
    // SETTINGS page follows this app's own convention instead — every module's settings page
    // (HR Settings, Finance Settings, Company Settings) lives under "Administration" below, so
    // Helpdesk Settings is listed there, not duplicated here.
    { to: "/it-admin/dashboard", label: "IT Admin Dashboard", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <InsightsRoundedIcon {...ICON} /> },
    { to: "/it-admin/tickets", label: "Ticket Queue", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <ConfirmationNumberRoundedIcon {...ICON} /> },
    { to: "/it-admin/assets", label: "Asset Inventory", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <Inventory2RoundedIcon {...ICON} /> },
    { to: "/it-admin/catalog", label: "Asset Catalog (Admin)", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <DevicesRoundedIcon {...ICON} /> },
    { to: "/it-admin/access-reports", label: "Access Reports", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <KeyRoundedIcon {...ICON} /> },
    { to: "/it-admin/kb", label: "Knowledge Base (Admin)", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <MenuBookRoundedIcon {...ICON} /> },
    { to: "/it-admin", label: "Pending Tasks", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "it-admin", icon: <SettingsRoundedIcon {...ICON} /> },
    { to: "/it-admin/offboarding", label: "Offboarding", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "it-admin", icon: <SettingsRoundedIcon {...ICON} /> },
  ]},
  // Separate external portal, integrated tomorrow (see QMS_PORTAL_URL above). Placeholder link
  // only — no local module/schema built here per explicit product decision.
  { group: "Quality Management", items: [
    { to: "#qms", label: "Quality Management (Coming Soon)", roles: ["CEO", "COO", "CTO", "FINANCE", "QA", "HR"], pageKey: "qms-portal-link", icon: <VerifiedRoundedIcon {...ICON} /> },
  ]},
  { group: "Finance", items: [
    { to: "/approvals", label: "Timesheet Approvals", roles: ["PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "approvals", icon: <RuleRoundedIcon {...ICON} /> },
    { to: "/ctc-approvals", label: "Employee & CTC Approval", roles: ["FINANCE", "CTO", "CEO", "COO"], pageKey: "ctc-approvals", icon: <VerifiedRoundedIcon {...ICON} /> },
    { to: "/termination-approvals", label: "Termination Approvals", roles: ["FINANCE", "CTO", "CEO", "COO"], pageKey: "termination-approvals", icon: <PersonRemoveRoundedIcon {...ICON} /> },
    { to: "/fnf-pending", label: "FnF", roles: ["FINANCE", "CTO", "CEO", "COO"], pageKey: "termination-approvals", icon: <PersonRemoveRoundedIcon {...ICON} /> },
    { to: "/appraisal-approvals", label: "Appraisal Approvals", roles: ["FINANCE", "CTO", "CEO", "COO"], pageKey: "appraisal-approvals", icon: <RateReviewRoundedIcon {...ICON} /> },
    { to: "/employees", label: "Employee Master", roles: ["FINANCE"], pageKey: "employees", icon: <PeopleRoundedIcon {...ICON} /> },
    // Also surfaced under HR for HR/CTO (same pageKey "employees" and route — the Module Access
    // Matrix toggle governs both spots at once). Finance can already open the route via its HR-group
    // entry's roles, but it only listed there, in the HR section — Finance couldn't find it without
    // opening the HR group, same reasoning as Employee Master's own duplication just above.
    { to: "/past-employees", label: "Past / Terminated Employees", roles: ["FINANCE"], pageKey: "employees", icon: <PersonRemoveRoundedIcon {...ICON} /> },
    { to: "/clients", label: "Clients", admin: true, pageKey: "clients", icon: <BusinessRoundedIcon {...ICON} /> },
    { to: "/projects", label: "Projects", admin: true, pageKey: "projects", icon: <WorkRoundedIcon {...ICON} /> },
    { to: "/ctc", label: "CTC Management", admin: true, pageKey: "ctc", icon: <PaymentsRoundedIcon {...ICON} /> },
    { to: "/monthly", label: "Forecast Monthly Revenue & Expenses", admin: true, pageKey: "monthly-forecast", icon: <TableChartRoundedIcon {...ICON} /> },
    { to: "/approved-hours", label: "Approved Hours", admin: true, pageKey: "approved-hours", icon: <FactCheckRoundedIcon {...ICON} /> },
    { to: "/invoices", label: "Generate Invoice", admin: true, pageKey: "invoices-generate", icon: <ReceiptLongRoundedIcon {...ICON} /> },
    { to: "/invoices-generated", label: "Existing Invoice", admin: true, pageKey: "invoices-existing", icon: <ReceiptLongRoundedIcon {...ICON} /> },
    { to: "/email-invoices", label: "Email Invoices", admin: true, pageKey: "email-invoices", icon: <ReceiptLongRoundedIcon {...ICON} /> },
    { to: "/invoice-reconciliation", label: "Invoice Reconciliation", admin: true, pageKey: "invoice-reconciliation", icon: <ReceiptLongRoundedIcon {...ICON} /> },
    { to: "/expense-reconciliation", label: "Expense Reconciliation", admin: true, pageKey: "expense-reconciliation", icon: <ReceiptLongRoundedIcon {...ICON} /> },
  ]},
  { group: "Administration", items: [
    { to: "/company-settings", label: "Company Settings", admin: true, pageKey: "company-settings", icon: <TuneRoundedIcon {...ICON} /> },
    { to: "/hr/settings", label: "HR Settings", roles: HR_SETTINGS_ROLES, pageKey: "hr-settings", icon: <TuneRoundedIcon {...ICON} /> },
    { to: "/finance/settings", label: "Finance Settings", admin: true, pageKey: "finance-settings", icon: <SettingsRoundedIcon {...ICON} /> },
    // Workflow stages, form fields, permissions, SLA, categories — with the live real-screen
    // preview. Same convention as every other module's settings page here.
    { to: "/it-admin/helpdesk", label: "Helpdesk Settings", roles: ["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"], pageKey: "helpdesk-console", icon: <TuneRoundedIcon {...ICON} /> },
    { to: "/users", label: "Users & Roles", admin: true, pageKey: "users-roles", icon: <ManageAccountsRoundedIcon {...ICON} /> },
    { to: "/access-matrix", label: "Module Access Matrix", roles: ["CEO", "COO", "CTO"], pageKey: "access-matrix", icon: <TuneRoundedIcon {...ICON} /> },
    { to: "/notification-settings", label: "Notification Settings", roles: ["CEO", "COO", "CTO"], pageKey: "notification-settings", icon: <NotificationsActiveRoundedIcon {...ICON} /> },
    { to: "/integrations", label: "Integrations", admin: true, pageKey: "integrations", icon: <HubRoundedIcon {...ICON} /> },
    { to: "/audit", label: "Audit Log", admin: true, pageKey: "audit-log", icon: <HistoryRoundedIcon {...ICON} /> },
  ]},
];

function ThemeToggle() {
  const [theme, setTheme] = React.useState(localStorage.getItem("theme") || "dark");
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
    window.dispatchEvent(new Event("themechange")); // keep MUI palette in sync
  }, [theme]);
  return (
    <Tooltip title={theme === "dark" ? "Switch to light" : "Switch to dark"} arrow>
      <IconButton size="small" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} sx={{ color: "var(--muted)", "&:hover": { color: "var(--accent)" } }}>
        {theme === "dark" ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

// One per-person toggle for CTC/financial figures across the whole app (CTC Management, Monthly
// Forecast & Actuals, Invoice Generated, dashboards, etc.) — defaults to masked. Persisted per
// user id, not per page, so it's a single consistent choice wherever that person goes.
function MaskToggle() {
  const { user } = useAuth();
  const masked = useMaskNumbers(user?.id);
  return (
    <Tooltip title={masked ? "Numbers hidden — click to show" : "Numbers visible — click to hide"} arrow>
      <IconButton size="small" onClick={() => setMaskNumbers(!masked, user?.id)} sx={{ color: "var(--muted)", "&:hover": { color: "var(--accent)" } }}>
        {masked ? <VisibilityOffRoundedIcon fontSize="small" /> : <VisibilityRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = React.useState(false);
  const initials = (user?.name || "?").split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{ position: "relative" }}>
      <button className="ghost" onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--accent)", color: "#06101f", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12 }}>{initials}</span>
        <span>{user?.name}</span>
        <span style={{ color: "var(--muted)" }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: 42, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, minWidth: 220, padding: 12, zIndex: 50, boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>
          <div style={{ fontWeight: 600 }}>{user?.name}</div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>{user?.email}</div>
          <div style={{ marginTop: 6 }}><span className="pill">{user?.role}</span></div>
          <button onClick={logout} style={{ width: "100%", marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><LogoutRoundedIcon fontSize="small" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

// Flat list of every NAV item this user can actually see (same roles/admin/can() filter the
// sidebar already applies), with its group attached — the single source both the sidebar and
// the top search bar filter from, so a search result can never point somewhere the sidebar
// itself wouldn't show.
function useVisibleNav() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const admin = isAdmin(user?.role);
  // Always calls through — user?.employeeId here is a claim baked into the JWT at login, which
  // goes stale the moment someone is linked to an Employee record (or made a manager) afterward;
  // gating the fetch on it meant the nav item stayed hidden until that stale login happened to
  // expire. The endpoint itself re-resolves employeeId from the DB and safely returns
  // isManager:false for a real not-linked user, so calling it unconditionally is harmless.
  const { data: managerStatus } = useFetch<{ isManager: boolean }>(user ? "/helpdesk/am-i-a-manager" : "/health");
  const isManager = !!managerStatus?.isManager;
  return NAV.map((g) => ({
    group: g.group,
    items: g.items.filter((i: any) => (i.roles ? i.roles.includes(user?.role) : i.admin ? admin : true) && can(i.pageKey) && (!i.requiresManager || isManager)),
  })).filter((g) => g.items.length > 0);
}

// Per-viewer sidebar-group collapse state — client-only UI convenience (not shared state),
// same localStorage-preference pattern as hrSettingsBusinessUnitId etc. Every group starts
// expanded unless a saved preference says otherwise; the app keeps growing new nav groups
// (IT Admin, IT Helpdesk, Quality Management, ...) so this keeps the sidebar manageable.
function useCollapsedNavGroups() {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("navCollapsedGroups");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const toggle = (group: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      try { localStorage.setItem("navCollapsedGroups", JSON.stringify([...next])); } catch { /* ignore (private mode, etc.) */ }
      return next;
    });
  };
  const expand = (group: string) => {
    setCollapsed((prev) => {
      if (!prev.has(group)) return prev;
      const next = new Set(prev);
      next.delete(group);
      try { localStorage.setItem("navCollapsedGroups", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  return { collapsed, toggle, expand };
}

// External-portal placeholder nav item — real navigation once QMS_PORTAL_URL is set, a toast
// ("integration pending") until then. Swap to a plain <a target="_blank"> once the URL exists.
function ComingSoonNavItem({ icon, label, url }: { icon: React.ReactNode; label: string; url: string }) {
  const { show } = useToast();
  if (url) return <a href={url} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center" }}>{icon}{label}</a>;
  return (
    <div onClick={() => show("QMS portal integration pending — link will go live once configured.")} style={{ display: "flex", alignItems: "center", cursor: "pointer", opacity: 0.7 }}>
      {icon}{label}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const visibleNav = useVisibleNav();
  // Forces the current page to remount on mask toggle — simplest way to guarantee every number
  // on screen (most of which are computed once per render via fmt()/fmtK()/etc., not reactive
  // hooks) picks up the new state immediately, without wiring every single page individually.
  const [maskTick, setMaskTick] = React.useState(0);
  React.useEffect(() => {
    const h = () => setMaskTick((t) => t + 1);
    window.addEventListener("masknumberschange", h);
    return () => window.removeEventListener("masknumberschange", h);
  }, []);
  // Company-wide date format — same "remount on change" approach as maskTick above, since
  // fmtDate() is a plain function most pages call once per render, not a reactive hook.
  const [dateFormatTick, setDateFormatTick] = React.useState(0);
  React.useEffect(() => {
    loadDateFormatSetting();
    return onDateFormatChange(() => setDateFormatTick((t) => t + 1));
  }, []);
  const { collapsed, toggle, expand } = useCollapsedNavGroups();
  // If the active route belongs to a collapsed group, auto-expand that group so users never
  // get stranded looking at a collapsed section that contains the page they're actually on.
  React.useEffect(() => {
    const activeGroup = visibleNav.find((g) => g.items.some((i: any) => i.to === loc.pathname))?.group;
    if (activeGroup) expand(activeGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <img src="/genaquarius.png" alt="GenAquarius" style={{ maxHeight: 38, maxWidth: 190, objectFit: "contain", alignSelf: "flex-start" }} />
        </div>
        <nav className="nav">
          {visibleNav.map((g) => {
            const isCollapsed = collapsed.has(g.group);
            const groupColor = GROUP_COLOR[g.group] || "var(--accent)";
            return (
              <div key={g.group}>
                <div className="nav-group nav-group-toggle" onClick={() => toggle(g.group)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: groupColor, flexShrink: 0 }} />
                    {g.group}
                  </span>
                  <ChevronRightRoundedIcon className={isCollapsed ? "" : "nav-group-chevron-open"} sx={{ fontSize: 16 }} />
                </div>
                {!isCollapsed && g.items.map((i: any) =>
                  i.to === "#qms" ? (
                    <ComingSoonNavItem key={i.to} icon={React.cloneElement(i.icon, { sx: { ...ICON.sx, color: groupColor } })} label={i.label} url={QMS_PORTAL_URL} />
                  ) : (
                    <NavLink key={i.to} to={i.to} end className={loc.pathname === i.to ? "active" : ""} style={{ display: "flex", alignItems: "center", borderLeft: loc.pathname === i.to ? `3px solid ${groupColor}` : "3px solid transparent" }}>
                      {React.cloneElement(i.icon, { sx: { ...ICON.sx, color: loc.pathname === i.to ? groupColor : `color-mix(in srgb, ${groupColor} 65%, var(--muted))` } })}{i.label}
                    </NavLink>
                  )
                )}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        <div className="topbar">
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginLeft: "auto" }}>
            <MaskToggle />
            <ThemeToggle />
            <ProfileMenu />
          </div>
        </div>
        <div key={`${maskTick}-${dateFormatTick}`}>{children}</div>
      </main>
    </div>
  );
}

function AdminRoute({ pageKey, children }: { pageKey?: string; children: React.ReactNode }) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return isAdmin(user?.role) && can(pageKey) ? <>{children}</> : <Navigate to="/timesheet" />;
}
function RoleRoute({ roles, pageKey, children }: { roles: string[]; pageKey?: string; children: React.ReactNode }) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return user && roles.includes(user.role) && can(pageKey) ? <>{children}</> : <Navigate to="/timesheet" />;
}

export default function App() {
  const { user, loading } = useAuth();
  // Candidate-facing, token-authenticated (no login) — must be reachable before the auth gate
  // below, same reasoning as the server mounting its API routes outside `authenticate`.
  if (window.location.pathname.startsWith("/document-upload/")) {
    return <Routes><Route path="/document-upload/:token" element={<CandidateDocumentUpload />} /></Routes>;
  }
  if (loading) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;

  const admin = isAdmin(user.role);
  const home = admin ? "/ceo" : user.role === "HR" ? "/hr" : user.role === "PROJECT_MANAGER" ? "/approvals" : user.role === "EMPLOYEE" || user.role === "CONTRACTOR" || user.role === "INTERN" || user.role === "IT_ADMIN" ? "/employee-dashboard" : "/timesheet";

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to={home} />} />
        <Route path="/login" element={<Navigate to={home} />} />
        <Route path="/ceo" element={<AdminRoute pageKey="ceo-dashboard"><CeoDashboard /></AdminRoute>} />
        <Route path="/finance" element={<AdminRoute pageKey="finance-dashboard"><FinanceDashboard /></AdminRoute>} />
        <Route path="/hr" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-dashboard"><HrDashboard /></RoleRoute>} />
        <Route path="/hr/offers" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-offers"><OffersList /></RoleRoute>} />
        <Route path="/hr/onboarding-history" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-onboarding-history"><OnboardingHistory /></RoleRoute>} />
        <Route path="/hr/offers/new" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-offers"><GenerateOffer /></RoleRoute>} />
        <Route path="/hr/offers/:id" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-offers"><OfferDetail /></RoleRoute>} />
        <Route path="/hr/offers/:id/regenerate" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-offers"><GenerateOffer /></RoleRoute>} />
        <Route path="/hr/confirm-joining" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-confirm-joining"><ConfirmJoiningQueue /></RoleRoute>} />
        <Route path="/hr/terminate" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-terminate"><TerminateEmployeePage /></RoleRoute>} />
        <Route path="/hr/appraisals" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-appraisals"><AppraisalsList /></RoleRoute>} />
        <Route path="/hr/appraisals/new" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-appraisals"><GenerateAppraisal /></RoleRoute>} />
        <Route path="/hr/appraisals/:id" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-appraisals"><AppraisalDetail /></RoleRoute>} />
        <Route path="/hr/settings" element={<RoleRoute roles={HR_SETTINGS_ROLES} pageKey="hr-settings"><HrSettings /></RoleRoute>} />
        <Route path="/finance/settings" element={<AdminRoute pageKey="finance-settings"><FinanceSettings /></AdminRoute>} />
        <Route path="/company-settings" element={<AdminRoute pageKey="company-settings"><CompanySettings /></AdminRoute>} />
        <Route path="/hr/onboarding-documents" element={<RoleRoute roles={HR_SETTINGS_ROLES} pageKey="hr-onboarding-documents"><OnboardingDocumentsReview /></RoleRoute>} />
        <Route path="/hr/profile-submissions" element={<RoleRoute roles={HR_SETTINGS_ROLES} pageKey="hr-profile-submissions"><ProfileSubmissionsReview /></RoleRoute>} />
        <Route path="/ai-report" element={<AdminRoute pageKey="ai-report"><AiReport /></AdminRoute>} />
        <Route path="/employees" element={<RoleRoute roles={["HR", "FINANCE", "CTO", "CEO", "COO"]} pageKey="employees"><Employees /></RoleRoute>} />
        <Route path="/past-employees" element={<RoleRoute roles={["HR", "FINANCE", "CTO", "CEO", "COO"]} pageKey="employees"><PastEmployees /></RoleRoute>} />
        <Route path="/hr/relieving-letters" element={<RoleRoute roles={HR_OPS_ROLES} pageKey="hr-relieving-letters"><RelievingLetters /></RoleRoute>} />
        <Route path="/ctc" element={<AdminRoute pageKey="ctc"><Ctc /></AdminRoute>} />
        <Route path="/clients" element={<AdminRoute pageKey="clients"><Clients /></AdminRoute>} />
        <Route path="/projects" element={<AdminRoute pageKey="projects"><Projects /></AdminRoute>} />
        <Route path="/monthly" element={<AdminRoute pageKey="monthly-forecast"><MonthlySheet /></AdminRoute>} />
        <Route path="/expenses" element={<AdminRoute><Expenses /></AdminRoute>} />
        <Route path="/invoices" element={<AdminRoute pageKey="invoices-generate"><Invoices /></AdminRoute>} />
        <Route path="/invoices-generated" element={<AdminRoute pageKey="invoices-existing"><ExistingInvoices /></AdminRoute>} />
        <Route path="/email-invoices" element={<AdminRoute pageKey="email-invoices"><EmailInvoices /></AdminRoute>} />
        <Route path="/invoice-reconciliation" element={<AdminRoute pageKey="invoice-reconciliation"><InvoiceReconciliation /></AdminRoute>} />
        <Route path="/expense-reconciliation" element={<AdminRoute pageKey="expense-reconciliation"><ExpenseReconciliation /></AdminRoute>} />
        <Route path="/approved-hours" element={<AdminRoute pageKey="approved-hours"><ApprovedHours /></AdminRoute>} />
        <Route path="/approvals" element={<RoleRoute roles={["PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="approvals"><Approvals /></RoleRoute>} />
        <Route path="/ctc-approvals" element={<RoleRoute roles={["FINANCE", "CTO", "CEO", "COO"]} pageKey="ctc-approvals"><CtcApprovals /></RoleRoute>} />
        <Route path="/termination-approvals" element={<RoleRoute roles={["FINANCE", "CTO", "CEO", "COO"]} pageKey="termination-approvals"><TerminationApprovals /></RoleRoute>} />
        <Route path="/fnf-pending" element={<RoleRoute roles={["FINANCE", "CTO", "CEO", "COO"]} pageKey="termination-approvals"><FnfPendingApprovals /></RoleRoute>} />
        <Route path="/appraisal-approvals" element={<RoleRoute roles={["FINANCE", "CTO", "CEO", "COO"]} pageKey="appraisal-approvals"><AppraisalApprovals /></RoleRoute>} />
        <Route path="/users" element={<AdminRoute pageKey="users-roles"><Users /></AdminRoute>} />
        <Route path="/access-matrix" element={<RoleRoute roles={["CEO", "COO", "CTO"]} pageKey="access-matrix"><AccessMatrix /></RoleRoute>} />
        <Route path="/notification-settings" element={<RoleRoute roles={["CEO", "COO", "CTO"]} pageKey="notification-settings"><NotificationSettings /></RoleRoute>} />
        <Route path="/integrations" element={<AdminRoute pageKey="integrations"><Integrations /></AdminRoute>} />
        <Route path="/audit" element={<AdminRoute pageKey="audit-log"><Audit /></AdminRoute>} />
        <Route path="/timesheet" element={<Timesheet />} />
        <Route path="/employee-dashboard" element={<RoleRoute roles={["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"]} pageKey="employee-dashboard"><EmployeeDashboard /></RoleRoute>} />
        <Route path="/my-profile" element={<RoleRoute roles={["EMPLOYEE", "INTERN", "CONTRACTOR", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"]} pageKey="my-profile"><MyProfile /></RoleRoute>} />
        <Route path="/holiday-calendar" element={<RoleRoute roles={["EMPLOYEE", "INTERN", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"]} pageKey="holiday-calendar"><HolidayCalendar /></RoleRoute>} />
        <Route path="/leave-attendance" element={<RoleRoute roles={["EMPLOYEE", "INTERN", "IT_ADMIN", "PROJECT_MANAGER", "CEO", "COO", "CTO", "FINANCE", "HR", "QA"]} pageKey="leave-attendance"><LeaveAndAttendance /></RoleRoute>} />
        <Route path="/it-admin" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="it-admin"><ItAdminDashboard /></RoleRoute>} />
        <Route path="/it-admin/offboarding" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="it-admin"><ItOffboardingDashboard /></RoleRoute>} />
        <Route path="/leave-approvals" element={<RoleRoute roles={["PROJECT_MANAGER", "HR", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="leave-approvals"><LeaveApprovals /></RoleRoute>} />
        <Route path="/helpdesk" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><HelpdeskHome /></RoleRoute>} />
        <Route path="/helpdesk/tickets" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><MyTickets /></RoleRoute>} />
        <Route path="/helpdesk/raise" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><RaiseTicket /></RoleRoute>} />
        <Route path="/helpdesk/catalog" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><AssetCatalog /></RoleRoute>} />
        <Route path="/helpdesk/my-assets" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><MyAssets /></RoleRoute>} />
        <Route path="/helpdesk/kb" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><KnowledgeBase /></RoleRoute>} />
        <Route path="/helpdesk/request-asset" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><RequestAsset /></RoleRoute>} />
        <Route path="/helpdesk/elevated-access" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><ElevatedAccess /></RoleRoute>} />
        <Route path="/helpdesk/approvals" element={<RoleRoute roles={ALL_APP_ROLES} pageKey="helpdesk"><TeamApprovals /></RoleRoute>} />
        <Route path="/it-admin/helpdesk" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskSettingsPage /></RoleRoute>} />
        <Route path="/it-admin/dashboard" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskDashboardPage /></RoleRoute>} />
        <Route path="/it-admin/tickets" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskTicketQueuePage /></RoleRoute>} />
        <Route path="/it-admin/assets" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskAssetInventoryPage /></RoleRoute>} />
        <Route path="/it-admin/catalog" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskAssetCatalogAdminPage /></RoleRoute>} />
        <Route path="/it-admin/access-reports" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskAccessReportsPage /></RoleRoute>} />
        <Route path="/it-admin/kb" element={<RoleRoute roles={["IT_ADMIN", "CEO", "COO", "CTO", "FINANCE", "QA"]} pageKey="helpdesk-console"><HelpdeskKbAdminPage /></RoleRoute>} />
        <Route path="*" element={<Navigate to={home} />} />
      </Routes>
    </Shell>
  );
}
