// IT Helpdesk — employee self-service ticketing + IT's console (see schema.prisma's
// "IT Helpdesk" block). Any signed-in user can raise tickets, request catalog assets, request
// elevated access, read the knowledge base and see the assets assigned to them; the /admin/*
// endpoints are the IT queue (IT_ADMIN + ADMIN_ROLES).
import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";
import ExcelJS from "exceljs";
import { prisma } from "../../prisma";
import { ADMIN_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { emitHelpdeskUpdate, emitHelpdeskUpdateToUser } from "../../engine/realtime";
import { findManagedDeviceByHostname, getLapsCredential, rotateLapsPassword, lapsConfigured } from "../../engine/intuneLaps";
import { encryptSecret, decryptSecret } from "../../engine/credentialCrypto";

async function auditEA(userId: number, action: string, ticketId: number, after?: any) {
  await prisma.auditLog.create({ data: { userId, action, entity: "HelpdeskTicket", entityId: String(ticketId), after } }).catch(() => {});
}

// req.user.employeeId comes straight from the JWT issued at login (see auth.ts) — it never
// reflects a link made (or a manager relationship that started applying) after that. Every
// manager/approval check in this file used to trust it directly, so someone linked to an Employee
// record after their last login kept failing "am I a manager" / "show me my team's approvals"
// correctly in the DB, wrongly here — until they happened to log out and back in. This re-resolves
// it fresh from the DB only when the JWT's own claim is missing, so it costs nothing for the
// normal (already-correct) case.
async function myEmployeeId(req: Request): Promise<number | null> {
  if (req.user!.employeeId) return req.user!.employeeId;
  return (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { employeeId: true } }))?.employeeId ?? null;
}

const router = Router();
const IT_ROLES: Role[] = [Role.IT_ADMIN, ...ADMIN_ROLES];
const isIt = (req: Request) => IT_ROLES.includes(req.user!.role);
function requireIt(req: Request, res: Response, next: NextFunction) {
  if (!isIt(req)) return res.status(403).json({ error: "IT Helpdesk console is limited to IT Admin." });
  next();
}

export const CATEGORIES = ["Hardware", "Software", "Network", "Access & Permissions", "Email & Collaboration", "Other"];
export const ASSET_TYPES = ["Laptop", "Monitor", "Mouse", "Headphones", "Type C Connector", "Keyboard", "Other"];
export const ASSET_STATUSES = ["IN_STOCK", "ASSIGNED", "IN_REPAIR", "RETIRED", "MISSING"];
export const KB_CATEGORIES = ["Security", "IT Policy", "Networking", "Software", "Hardware", "General"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUSES = ["PENDING_MANAGER", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"];
const PREFIX: Record<string, string> = { INCIDENT: "INC", ASSET_REQUEST: "AR", ELEVATED_ACCESS: "EA" };
export const ticketNo = (t: { id: number; type: string }) => `${PREFIX[t.type] || "INC"}-${1000 + t.id}`;

// ---- Admin-configurable settings (SLA hours, category/asset-type lists, approval requirement,
// elevated-access max duration) — Admin Settings -> Helpdesk Console -> Settings. Singleton row
// (id 1), created on first read, cached in memory and invalidated on every write.
const DEFAULT_SLA_HOURS: Record<string, number> = { LOW: 72, MEDIUM: 24, HIGH: 8, CRITICAL: 4 };
let settingsCache: any = null;
async function getSettings() {
  if (settingsCache) return settingsCache;
  let s = await prisma.helpdeskSetting.findUnique({ where: { id: 1 } });
  if (!s) s = await prisma.helpdeskSetting.create({ data: { id: 1 } }).catch(async () => (await prisma.helpdeskSetting.findUnique({ where: { id: 1 } }))!);
  settingsCache = s;
  return s;
}
function invalidateSettings() { settingsCache = null; }
const activeCategories = (s: any) => (Array.isArray(s.categories) && s.categories.length ? s.categories : CATEGORIES);
const activeAssetTypes = (s: any) => (Array.isArray(s.assetTypes) && s.assetTypes.length ? s.assetTypes : ASSET_TYPES);
const slaHoursFor = (s: any, priority: string) => Number(s.slaHours?.[priority]) || DEFAULT_SLA_HOURS[priority] || 24;
const approvalRequired = (s: any, type: string) => s.managerApprovalRequired?.[type] !== false;

// Every permission toggle here gates a REAL code path below — nothing decorative. IT_ADMIN/
// ADMIN_ROLES can never be locked out by these (see requireIt, which every /admin/* route sits
// behind regardless of this config) — only the extra, optional access these toggles control.
const PERMISSION_DEFAULTS: Record<string, Record<string, boolean>> = {
  INCIDENT: { requireResolutionNote: true, employeeCanReopen: true, employeeCanWithdraw: true },
  ASSET_REQUEST: { itCanApprove: true, employeeCanWithdraw: true },
  ELEVATED_ACCESS: { itCanApprove: true, employeeCanWithdraw: true },
};
const perm = (s: any, type: string, key: string): boolean => {
  const v = s.permissions?.[type]?.[key];
  return v !== undefined ? !!v : PERMISSION_DEFAULTS[type]?.[key] !== false;
};

// Display-only stage labels, keyed by request type then internal status — the internal status
// string itself never changes (stable key, per the spec's "separate internal key from display
// label"), only what's shown to users. Defaults exactly match the previous hardcoded copy so
// nothing changes visually until an admin actually edits Helpdesk Settings.
const DEFAULT_STAGE_LABELS: Record<string, Record<string, string>> = {
  INCIDENT: { PENDING_MANAGER: "Pending Manager Approval", OPEN: "Open", IN_PROGRESS: "In Progress", ON_HOLD: "On Hold", RESOLVED: "Resolved", CLOSED: "Closed", REJECTED: "Rejected", CANCELLED: "Cancelled" },
  ASSET_REQUEST: { PENDING_MANAGER: "Pending Manager Approval", OPEN: "Approved · With IT", RESOLVED: "Assigned", CLOSED: "Closed", REJECTED: "Rejected", CANCELLED: "Cancelled" },
  ELEVATED_ACCESS: { PENDING_MANAGER: "Pending Manager Approval", OPEN: "Approved · With IT", RESOLVED: "Access Granted", REJECTED: "Rejected", CANCELLED: "Cancelled" },
};
const stageLabel = (s: any, type: string, status: string): string => s.stageLabels?.[type]?.[status] || DEFAULT_STAGE_LABELS[type]?.[status] || DEFAULT_STAGE_LABELS.INCIDENT[status] || status;

// Field-level show/hide toggles for the real Raise Ticket / Request an Asset / Elevated Access
// forms — every key here is wired into the actual form component below AND the client form, and
// only covers fields that already have a safe default when hidden (no server validation change
// needed: priority already defaults to MEDIUM, attachment was already optional, catalog browsing
// is a pure UI convenience over manually typing an item, start time already defaults to "now").
// Core identity fields (subject/description/category/justification) are never toggleable — hiding
// those would break ticket routing or approval quality. attachmentFieldRequired is the one real
// required/optional toggle (enforced below in POST /tickets) — the others don't have a safe
// "required" meaning (priority/start-time already default silently; catalog browsing is optional
// by nature).
const FIELD_DEFAULTS: Record<string, Record<string, boolean>> = {
  INCIDENT: { priorityFieldVisible: true, attachmentFieldVisible: true, attachmentFieldRequired: false },
  ASSET_REQUEST: { catalogBrowseVisible: true },
  ELEVATED_ACCESS: { startDateTimeFieldVisible: true },
};
const fieldOn = (s: any, type: string, key: string): boolean => {
  const v = s.fields?.[type]?.[key];
  return v !== undefined ? !!v : FIELD_DEFAULTS[type]?.[key] !== false;
};
// Admin-editable display label per toggleable field — e.g. rename "Priority" to "Urgency". Keyed
// by the same field key as FIELD_DEFAULTS so one lookup covers both visibility and label.
const DEFAULT_FIELD_LABELS: Record<string, Record<string, string>> = {
  INCIDENT: { priorityFieldVisible: "Priority", attachmentFieldVisible: "Attachment" },
  ASSET_REQUEST: { catalogBrowseVisible: "Catalog Item" },
  ELEVATED_ACCESS: { startDateTimeFieldVisible: "Start Date / Time" },
};
const fieldLabel = (s: any, type: string, key: string): string => s.fieldLabels?.[type]?.[key] || DEFAULT_FIELD_LABELS[type]?.[key] || key;

// Admin-defined custom fields per request type — the "add/delete your own element" escape hatch.
// Rendered generically (text/number/date/textarea inputs only, no arbitrary markup or code), and
// captured into the ticket's own details.customFieldValues at creation. Capped at 10 per type so
// a form can't be configured into something unusable.
const CUSTOM_FIELD_TYPES = ["text", "number", "date", "textarea"];
const customFieldsFor = (s: any, type: string): { key: string; label: string; fieldType: string; required: boolean }[] => {
  const arr = Array.isArray(s.customFields?.[type]) ? s.customFields[type] : [];
  return arr.filter((f: any) => f && f.key && f.label).slice(0, 10).map((f: any) => ({
    key: String(f.key), label: String(f.label).slice(0, 40),
    fieldType: CUSTOM_FIELD_TYPES.includes(f.fieldType) ? f.fieldType : "text", required: !!f.required,
  }));
};
// Validates + coerces submitted custom-field values against the configured definitions for a
// type — unknown keys are dropped, required-but-missing fails, everything else passes through as
// a plain string (dates/numbers are stored as their string form, same as every other free-text
// detail field on a ticket).
function collectCustomFieldValues(defs: ReturnType<typeof customFieldsFor>, submitted: any): { values: Record<string, string>; error?: string } {
  const values: Record<string, string> = {};
  for (const d of defs) {
    const v = submitted?.[d.key];
    const s = v === undefined || v === null ? "" : String(v).trim();
    if (d.required && !s) return { values, error: `${d.label} is required` };
    if (s) values[d.key] = s.slice(0, 2000);
  }
  return { values };
}

// ---- first-run defaults (catalog + a few KB articles) — only when the tables are empty ----
let defaultsChecked = false;
async function ensureDefaults() {
  if (defaultsChecked) return;
  defaultsChecked = true;
  if ((await prisma.assetCatalogItem.count()) === 0) {
    const items = [
      ["Laptop", "Laptop", "💻", "Standard business laptop (new joiner / replacement / upgrade).", true],
      ["External Monitor (24\")", "Monitor", "🖥️", "24-inch full-HD monitor with HDMI cable.", true],
      ["Wireless Mouse", "Mouse", "🖱️", "Standard wireless optical mouse with USB receiver.", true],
      ["Headset with Mic", "Headphones", "🎧", "USB / Bluetooth headset for Teams calls.", true],
      ["USB Type-C Connector / Hub", "Type C Connector", "🔗", "USB-C multiport adapter (HDMI, USB-A, Ethernet).", true],
      ["Keyboard", "Keyboard", "⌨️", "Full-size USB / wireless keyboard.", true],
      ["Laptop Bag", "Other", "🎒", "Padded laptop backpack.", true],
      ["Webcam (1080p)", "Other", "📷", "External HD webcam.", true],
    ] as const;
    await prisma.assetCatalogItem.createMany({ data: items.map(([name, category, icon, description, requiresApproval], i) => ({ name, category, icon, description, requiresApproval, order: i })) });
  }
  if ((await prisma.kbArticle.count()) === 0) {
    await prisma.kbArticle.createMany({ data: [
      { title: "How to reset your Microsoft 365 password", category: "Security", summary: "Self-service password reset for your genaquarius.com account.", tags: "password,o365,sspr",
        body: "1. Go to https://aka.ms/sspr\n2. Enter your genaquarius.com email and complete the captcha.\n3. Verify with your registered phone / authenticator app.\n4. Choose a new password (min 12 characters, not reused).\n\nStill locked out? Raise a ticket under Email & O365 with priority High." },
      { title: "Setting up Microsoft Authenticator (2FA)", category: "Security", summary: "Register the Authenticator app for multi-factor sign-in.", tags: "mfa,2fa,authenticator",
        body: "1. Install Microsoft Authenticator on your phone.\n2. Visit https://aka.ms/mysecurityinfo and sign in.\n3. Add sign-in method → Authenticator app → scan the QR code.\n4. Approve the test notification.\n\nChanged your phone? Raise an Access ticket so IT can reset your MFA registration." },
      { title: "Connecting to the office Wi-Fi", category: "Networking", summary: "Join the corporate SSID with your work account.", tags: "wifi,network",
        body: "Select the corporate SSID, choose PEAP / MSCHAPv2 if prompted, and sign in with your full work email and password. Guest devices must use the Guest network. If the connection keeps dropping, forget the network, reconnect, and raise a Network ticket with your device name if it persists." },
      { title: "Printer not working — quick checks", category: "Hardware", summary: "Things to try before raising a ticket.", tags: "printer,hardware",
        body: "• Check the printer is on and shows Ready.\n• Clear any paper jam and check toner.\n• Remove and re-add the printer from Settings → Printers.\n• Restart your laptop.\nIf it still fails, raise a Hardware ticket with the printer name and a photo of any error." },
      { title: "Requesting software installation", category: "Software", summary: "Why you can't install software yourself and how to request it.", tags: "software,install,admin",
        body: "Standard users don't have local admin rights. For licensed software use Request an Asset → Software Licence. For a free/approved tool, raise a Software ticket with the download link and business reason. For a one-off task that needs admin rights, use Elevated Access." },
    ] });
  }
}

// Resolve names for requester/assignee user ids and employee ids in one go. Also attaches the
// SLA due time (createdAt + configured hours for that priority) and an `overdue` flag for
// incidents still open — the config is read once per call, not per row.
// `viewer` is omitted for contexts that don't need unread counts (e.g. the admin dashboard's
// recentTickets summary) — every list/detail route a person actually reads tickets FROM passes it.
async function hydrate(tickets: any[], viewer?: { userId: number; isIt: boolean }) {
  const userIds = Array.from(new Set(tickets.flatMap((t) => [t.requesterUserId, t.assignedToId]).filter(Boolean)));
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const empIds = Array.from(new Set(tickets.flatMap((t) => [t.managerEmployeeId, t.employeeId]).filter(Boolean)));
  const emps = empIds.length ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true, empNo: true } }) : [];
  const empById = new Map(emps.map((e) => [e.id, e]));
  const settings = await getSettings();
  const now = Date.now();
  // One query for every ticket's comments (id/authorUserId/createdAt only — never the
  // body/attachment here) rather than N+1 — unread is just "how many qualify", not their content.
  const unreadByTicket = new Map<number, number>();
  if (viewer && tickets.length) {
    const ids = tickets.map((t) => t.id);
    const allComments = await prisma.helpdeskComment.findMany({ where: { ticketId: { in: ids } }, select: { ticketId: true, authorUserId: true, createdAt: true } });
    const byTicket = new Map<number, typeof allComments>();
    for (const c of allComments) { const arr = byTicket.get(c.ticketId) || []; arr.push(c); byTicket.set(c.ticketId, arr); }
    for (const t of tickets) {
      const lastRead = (viewer.isIt ? t.itLastReadAt : t.requesterLastReadAt) as Date | null;
      const cutoff = lastRead ? new Date(lastRead).getTime() : 0;
      const mine = byTicket.get(t.id) || [];
      const count = mine.filter((c) => c.authorUserId !== viewer.userId && new Date(c.createdAt).getTime() > cutoff).length;
      if (count) unreadByTicket.set(t.id, count);
    }
  }
  return tickets.map(({ attachmentData, ...t }) => {
    const dueAt = t.type === "INCIDENT" ? new Date(new Date(t.createdAt).getTime() + slaHoursFor(settings, t.priority) * 3600000) : null;
    const overdue = !!dueAt && !["RESOLVED", "CLOSED", "REJECTED", "CANCELLED"].includes(t.status) && dueAt.getTime() < now;
    let details = t.details;
    // Windows/Intune LAPS credential: encrypted at rest in `details.credentialPasswordEnc`. Only
    // ever decrypted into a plaintext `credentialPassword` for the requesting employee, and only
    // while their session is still active — everyone else (including IT, other tickets' viewers,
    // and the response to the manager who just approved it) gets it stripped entirely. Mac's
    // existing plaintext `credentialPassword` field is untouched — out of scope for this change.
    if (t.type === "ELEVATED_ACCESS" && details && (details as any).credentialPasswordEnc) {
      const d: any = details;
      const isOwner = !!viewer && !viewer.isIt && t.requesterUserId === viewer.userId;
      const active = t.status === "RESOLVED" && !!d.expiresAt && new Date(d.expiresAt).getTime() > now && !d.sessionEndedAt;
      const { credentialPasswordEnc, ...rest } = d;
      if (isOwner && active) {
        try { details = { ...rest, credentialPassword: decryptSecret(credentialPasswordEnc) }; }
        catch { details = { ...rest, credentialError: "Could not decrypt the stored credential — contact IT Support." }; }
      } else {
        details = rest;
      }
    }
    return {
      ...t, details, ticketNo: ticketNo(t), hasAttachment: !!t.attachmentName, dueAt, overdue, stageLabelText: stageLabel(settings, t.type, t.status),
      manager: t.managerEmployeeId ? empById.get(t.managerEmployeeId) || null : null, employee: t.employeeId ? empById.get(t.employeeId) || null : null,
      requester: byId.get(t.requesterUserId) || null, assignedTo: t.assignedToId ? byId.get(t.assignedToId) || null : null,
      unreadCount: viewer ? (unreadByTicket.get(t.id) || 0) : undefined,
    };
  });
}

// Nav-badge total — every ticket the viewer can see (their own, or every ticket for IT), summed
// the same way hydrate() computes per-ticket unreadCount, but without pulling full ticket rows.
async function unreadTotalFor(viewer: { userId: number; isIt: boolean }): Promise<number> {
  const tickets = await prisma.helpdeskTicket.findMany({
    where: viewer.isIt ? {} : { requesterUserId: viewer.userId },
    select: { id: true, requesterLastReadAt: true, itLastReadAt: true },
  });
  if (!tickets.length) return 0;
  const ids = tickets.map((t) => t.id);
  const comments = await prisma.helpdeskComment.findMany({ where: { ticketId: { in: ids } }, select: { ticketId: true, authorUserId: true, createdAt: true } });
  const byTicket = new Map<number, typeof comments>();
  for (const c of comments) { const arr = byTicket.get(c.ticketId) || []; arr.push(c); byTicket.set(c.ticketId, arr); }
  let total = 0;
  for (const t of tickets) {
    const lastRead = viewer.isIt ? t.itLastReadAt : t.requesterLastReadAt;
    const cutoff = lastRead ? new Date(lastRead).getTime() : 0;
    for (const c of byTicket.get(t.id) || []) {
      if (c.authorUserId !== viewer.userId && new Date(c.createdAt).getTime() > cutoff) total++;
    }
  }
  return total;
}
async function notifyIt(req: Request, subject: string, html: string) {
  if (!mailEnabled() || !req.user?.email) return;
  const agents = await prisma.user.findMany({ where: { role: Role.IT_ADMIN, isActive: true }, select: { email: true } });
  for (const a of agents) notifyMail("HELPDESK_NOTIFY_IT", { fromUpn: req.user.email, to: a.email, subject, html }).catch((e) => console.warn("[helpdesk] mail failed:", e?.message || e));
}
async function notifyRequester(req: Request, t: any, subject: string, html: string) {
  if (!mailEnabled() || !req.user?.email) return;
  const u = await prisma.user.findUnique({ where: { id: t.requesterUserId }, select: { email: true } });
  if (u?.email) notifyMail("HELPDESK_NOTIFY_REQUESTER", { fromUpn: req.user.email, to: u.email, subject, html }).catch((e) => console.warn("[helpdesk] mail failed:", e?.message || e));
}
const esc = (s: any) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

router.use(requirePermission("helpdesk"));

router.get("/meta", async (req, res) => {
  const s = await getSettings();
  const stageLabels: Record<string, Record<string, string>> = {};
  for (const type of Object.keys(DEFAULT_STAGE_LABELS)) { stageLabels[type] = {}; for (const st of Object.keys(DEFAULT_STAGE_LABELS[type])) stageLabels[type][st] = stageLabel(s, type, st); }
  const permissions: Record<string, Record<string, boolean>> = {};
  for (const type of Object.keys(PERMISSION_DEFAULTS)) { permissions[type] = {}; for (const k of Object.keys(PERMISSION_DEFAULTS[type])) permissions[type][k] = perm(s, type, k); }
  const fields: Record<string, Record<string, boolean>> = {};
  const fieldLabels: Record<string, Record<string, string>> = {};
  for (const type of Object.keys(FIELD_DEFAULTS)) {
    fields[type] = {}; fieldLabels[type] = {};
    for (const k of Object.keys(FIELD_DEFAULTS[type])) fields[type][k] = fieldOn(s, type, k);
    for (const k of Object.keys(DEFAULT_FIELD_LABELS[type] || {})) fieldLabels[type][k] = fieldLabel(s, type, k);
  }
  const customFields: Record<string, any[]> = { INCIDENT: customFieldsFor(s, "INCIDENT"), ASSET_REQUEST: customFieldsFor(s, "ASSET_REQUEST"), ELEVATED_ACCESS: customFieldsFor(s, "ELEVATED_ACCESS") };
  res.json({
    categories: activeCategories(s), priorities: PRIORITIES, statuses: STATUSES, assetTypes: activeAssetTypes(s), kbCategories: KB_CATEGORIES,
    slaHours: s.slaHours, elevatedAccessMaxDays: s.elevatedAccessMaxDays, stageLabels, permissions, fields, fieldLabels, customFields,
    managerApprovalRequired: { ASSET_REQUEST: approvalRequired(s, "ASSET_REQUEST"), ELEVATED_ACCESS: approvalRequired(s, "ELEVATED_ACCESS") },
    canApproveOnBehalf: isIt(req),
  });
});

// ---- Employee: dashboard summary ----
router.get("/summary", async (req, res) => {
  const where = { requesterUserId: req.user!.id };
  const rows = await prisma.helpdeskTicket.groupBy({ by: ["status"], where, _count: { _all: true } });
  const c = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
  const recent = await prisma.helpdeskTicket.findMany({ where, orderBy: { createdAt: "desc" }, take: 5 });
  const myId = await myEmployeeId(req);
  const assets = myId ? await prisma.itAsset.count({ where: { assignedEmployeeId: myId, status: "ASSIGNED" } }) : 0;
  res.json({
    open: c(["PENDING_MANAGER", "OPEN", "ON_HOLD"]), inProgress: c(["IN_PROGRESS"]), resolved: c(["RESOLVED", "CLOSED"]), total: c(STATUSES),
    pendingApprovals: myId ? await prisma.helpdeskTicket.count({ where: { managerEmployeeId: myId, approvalStatus: "PENDING" } }) : 0,
    assets, recent: await hydrate(recent, { userId: req.user!.id, isIt: false }),
    unreadTotal: await unreadTotalFor({ userId: req.user!.id, isIt: false }),
  });
});

// ---- Employee: my tickets ----
router.get("/tickets", async (req, res) => {
  const type = req.query.type ? String(req.query.type) : undefined;
  const rows = await prisma.helpdeskTicket.findMany({ where: { requesterUserId: req.user!.id, ...(type ? { type } : {}) }, orderBy: { createdAt: "desc" } });
  res.json(await hydrate(rows, { userId: req.user!.id, isIt: false }));
});

// Nav-badge total for whichever side is asking — employee "My Tickets" or IT "Ticket Queue".
router.get("/tickets/unread-summary", async (req, res) => {
  res.json({ unreadTotal: await unreadTotalFor({ userId: req.user!.id, isIt: isIt(req) }) });
});

router.get("/tickets/:id", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) }, include: { comments: { orderBy: { createdAt: "asc" } } } });
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  const it = isIt(req);
  if (t.requesterUserId !== req.user!.id && !it) return res.status(404).json({ error: "Ticket not found" });
  const [h] = await hydrate([t], { userId: req.user!.id, isIt: it });
  res.json({ ...h, comments: t.comments.map(({ attachmentData, ...c }) => ({ ...c, hasAttachment: !!c.attachmentName })) });
});

// Marks everything on this ticket read as of now, for whichever side is calling — the ticket
// detail view calls this on open (and again whenever a new comment arrives while it's open).
router.post("/tickets/:id/mark-read", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  const it = isIt(req);
  if (!t || (t.requesterUserId !== req.user!.id && !it)) return res.status(404).json({ error: "Ticket not found" });
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data: it ? { itLastReadAt: new Date() } : { requesterLastReadAt: new Date() } });
  res.json({ ok: true });
});

const contentTypeFor = (fileName: string) => {
  const ext = (fileName || "").split(".").pop()?.toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "application/octet-stream";
};
router.get("/tickets/:id/attachment", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || !t.attachmentData || (t.requesterUserId !== req.user!.id && !isIt(req))) return res.status(404).json({ error: "Attachment not found" });
  res.setHeader("Content-Type", contentTypeFor(t.attachmentName || ""));
  res.setHeader("Content-Disposition", `inline; filename="${t.attachmentName}"`);
  res.send(Buffer.from(t.attachmentData, "base64"));
});
// Same access control as the ticket-level attachment — anyone who can see the ticket (the
// requester or IT) can fetch any comment's attachment; there's no internal/private distinction.
router.get("/tickets/:id/comments/:commentId/attachment", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  const it = isIt(req);
  if (!t || (t.requesterUserId !== req.user!.id && !it)) return res.status(404).json({ error: "Attachment not found" });
  const c = await prisma.helpdeskComment.findFirst({ where: { id: Number(req.params.commentId), ticketId: t.id } });
  if (!c || !c.attachmentData) return res.status(404).json({ error: "Attachment not found" });
  res.setHeader("Content-Type", contentTypeFor(c.attachmentName || ""));
  res.setHeader("Content-Disposition", `inline; filename="${c.attachmentName}"`);
  res.send(Buffer.from(c.attachmentData, "base64"));
});

async function createTicket(req: Request, data: any) {
  const t = await prisma.helpdeskTicket.create({ data: { requesterUserId: req.user!.id, employeeId: await myEmployeeId(req), ...data } });
  const no = ticketNo(t);
  notifyIt(req, `[${no}] ${t.subject}`, `<p><b>${esc(req.user!.name)}</b> raised ${no} (${esc(t.category)}, ${t.priority}).</p><p>${esc(t.description).replace(/\n/g, "<br>")}</p>`).catch(() => {});
  emitHelpdeskUpdate("ticket_created", { ticketNo: no, subject: t.subject, priority: t.priority });
  return { ...t, ticketNo: no };
}

router.post("/tickets", async (req, res) => {
  const b = req.body || {};
  const settings = await getSettings();
  if (!String(b.subject || "").trim() || !String(b.description || "").trim()) return res.status(400).json({ error: "Subject and description are required" });
  if (!activeCategories(settings).includes(b.category)) return res.status(400).json({ error: "Select a category" });
  if (b.attachmentData && String(b.attachmentData).length > 7_000_000) return res.status(400).json({ error: "Attachment is too large (max 5 MB)" });
  if (fieldOn(settings, "INCIDENT", "attachmentFieldRequired") && !b.attachmentData) return res.status(400).json({ error: `${fieldLabel(settings, "INCIDENT", "attachmentFieldVisible")} is required` });
  const cfDefs = customFieldsFor(settings, "INCIDENT");
  const cf = collectCustomFieldValues(cfDefs, b.customFieldValues);
  if (cf.error) return res.status(400).json({ error: cf.error });
  const t = await createTicket(req, {
    type: "INCIDENT", category: b.category, priority: PRIORITIES.includes(b.priority) ? b.priority : "MEDIUM",
    subject: String(b.subject).trim().slice(0, 190), description: String(b.description).trim(),
    attachmentName: b.attachmentName || null, attachmentData: b.attachmentData || null,
    details: Object.keys(cf.values).length ? { customFieldValues: cf.values } : undefined,
  });
  res.status(201).json(t);
});

router.post("/tickets/:id/comments", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  const it = isIt(req);
  if (!t || (t.requesterUserId !== req.user!.id && !it)) return res.status(404).json({ error: "Ticket not found" });
  const body = String(req.body?.body || "").trim();
  const attachmentName = req.body?.attachmentName ? String(req.body.attachmentName) : null;
  const attachmentData = req.body?.attachmentData ? String(req.body.attachmentData) : null;
  // A message needs text OR an attachment, not necessarily both — this is also how IT's own
  // standalone "upload to ticket" action (spec item 2) works: an attachment with no text.
  if (!body && !attachmentData) return res.status(400).json({ error: "Add a message or an attachment" });
  if (attachmentData && attachmentData.length > 7_000_000) return res.status(400).json({ error: "Attachment is too large (max 5 MB)" });
  // No internal/private note distinction — every comment/attachment is normal ticket activity,
  // visible to the requester and IT alike.
  const c = await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body, attachmentName, attachmentData } });
  // Requester replying to a ticket that's waiting on them re-opens the conversation.
  if (!it && t.status === "ON_HOLD") await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { status: "OPEN" } });
  if (it && t.requesterUserId !== req.user!.id) notifyRequester(req, t, `[${ticketNo(t)}] New update on your ticket`, `<p>${esc(body || "(attachment)").replace(/\n/g, "<br>")}</p>`).catch(() => {});
  emitHelpdeskUpdate("comment_added", { ticketNo: ticketNo(t) });
  // The requester doesn't sit in the IT-only helpdesk:activity room — ping them directly too, so
  // their own "My Tickets" badge/open chat updates live when IT (or their own other tab) replies.
  emitHelpdeskUpdateToUser(t.requesterUserId, "comment_added", { ticketNo: ticketNo(t) });
  const { attachmentData: _omit, ...withoutData } = c;
  res.status(201).json({ ...withoutData, hasAttachment: !!c.attachmentName });
});

// Requester closes a resolved ticket, or re-opens one that isn't really fixed.
router.post("/tickets/:id/close", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || t.requesterUserId !== req.user!.id) return res.status(404).json({ error: "Ticket not found" });
  if (["CLOSED", "REJECTED"].includes(t.status)) return res.status(400).json({ error: `Ticket is already ${t.status}` });
  res.json(await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { status: "CLOSED", closedAt: new Date() } }));
});
router.post("/tickets/:id/reopen", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || t.requesterUserId !== req.user!.id) return res.status(404).json({ error: "Ticket not found" });
  if (!perm(await getSettings(), "INCIDENT", "employeeCanReopen")) return res.status(403).json({ error: "Re-opening resolved tickets has been turned off — raise a new ticket instead." });
  if (t.status !== "RESOLVED") return res.status(400).json({ error: "Only a resolved ticket can be re-opened" });
  const reason = String(req.body?.reason || "").trim();
  if (reason) await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: `Re-opened: ${reason}` } });
  res.json(await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { status: "OPEN", resolvedAt: null } }));
});

// ---- Manager approval step (asset requests + elevated access) ----
// The reporting manager is Employee.reportingManager (stored as the manager's NAME — see
// ess.ts /org-chart), resolved to an active Employee. No resolvable manager ⇒ the request goes
// straight to IT (approvalStatus NOT_REQUIRED) rather than getting stuck.
async function resolveManager(employeeId: number | null) {
  if (!employeeId) return null;
  const me = await prisma.employee.findUnique({ where: { id: employeeId }, select: { reportingManager: true } });
  const name = String(me?.reportingManager || "").trim().replace(/\s+/g, " ");
  if (!name) return null;
  const cands = await prisma.employee.findMany({ where: { exitDate: null, name: { contains: name.split(" ")[0] } }, select: { id: true, name: true, email: true } });
  const m = cands.find((c) => c.name.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase());
  return m && m.id !== employeeId ? m : null;
}
// Reverse of resolveManager() above — does this employee have anyone reporting to them at all?
// Drives the client's "Pending Approval" nav item, which the spec requires stay hidden from
// anyone with no direct reports rather than showing an always-empty menu to everyone.
router.get("/am-i-a-manager", async (req, res) => {
  const employeeId = await myEmployeeId(req);
  if (!employeeId) return res.json({ isManager: false });
  const me = await prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true } });
  const myName = String(me?.name || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!myName) return res.json({ isManager: false });
  const cands = await prisma.employee.findMany({ where: { exitDate: null, reportingManager: { contains: myName.split(" ")[0] } }, select: { reportingManager: true } });
  const isManager = cands.some((c) => String(c.reportingManager || "").trim().replace(/\s+/g, " ").toLowerCase() === myName);
  res.json({ isManager });
});
async function createApprovalRequest(req: Request, data: any, label: string) {
  const settings = await getSettings();
  const myId = await myEmployeeId(req);
  const mgr = approvalRequired(settings, data.type) ? await resolveManager(myId) : null;
  const t = await prisma.helpdeskTicket.create({
    data: {
      requesterUserId: req.user!.id, employeeId: myId, ...data,
      status: mgr ? "PENDING_MANAGER" : "OPEN", approvalStatus: mgr ? "PENDING" : "NOT_REQUIRED", managerEmployeeId: mgr?.id || null,
    },
  });
  const no = ticketNo(t);
  if (mgr?.email && mailEnabled() && req.user?.email) {
    notifyMail("HELPDESK_APPROVAL_NEEDED", { fromUpn: req.user.email, to: mgr.email, subject: `Approval needed: ${label} — ${req.user.name} (${no})`,
      html: `<p><b>${esc(req.user.name)}</b> has requested <b>${esc(label)}</b> and needs your approval.</p><p>${esc(t.description).replace(/\n/g, "<br>")}</p><p>Approve or reject it under IT Helpdesk → Team Approvals.</p>` }).catch((e) => console.warn("[helpdesk] mail failed:", e?.message || e));
  } else if (!mgr) {
    notifyIt(req, `[${no}] ${t.subject}`, `<p><b>${esc(req.user!.name)}</b> raised ${no}.</p><p>${esc(t.description).replace(/\n/g, "<br>")}</p>`).catch(() => {});
  }
  emitHelpdeskUpdate("request_created", { ticketNo: no, type: data.type, subject: t.subject });
  return { ...t, ticketNo: no, manager: mgr ? { id: mgr.id, name: mgr.name } : null };
}

// ---- Asset catalog + asset requests ----
router.get("/catalog", async (_req, res) => {
  await ensureDefaults();
  res.json(await prisma.assetCatalogItem.findMany({ where: { active: true }, orderBy: [{ order: "asc" }, { name: "asc" }] }));
});

router.post("/asset-requests", async (req, res) => {
  const b = req.body || {};
  const settings = await getSettings();
  const types = activeAssetTypes(settings);
  const item = b.catalogItemId ? await prisma.assetCatalogItem.findUnique({ where: { id: Number(b.catalogItemId) } }) : null;
  if (b.catalogItemId && (!item || !item.active)) return res.status(400).json({ error: "That catalog item is no longer available" });
  const assetType = item ? (types.includes(item.category) ? item.category : "Other") : String(b.assetType || "");
  if (!types.includes(assetType)) return res.status(400).json({ error: "Select an asset type" });
  const justification = String(b.justification || "").trim();
  if (!justification) return res.status(400).json({ error: "Reason / justification is required" });
  const itemName = item?.name || (assetType === "Other" ? String(b.otherItem || "").trim() || "Other" : assetType);
  const cf = collectCustomFieldValues(customFieldsFor(settings, "ASSET_REQUEST"), b.customFieldValues);
  if (cf.error) return res.status(400).json({ error: cf.error });
  const t = await createApprovalRequest(req, {
    type: "ASSET_REQUEST", category: "Hardware", priority: PRIORITIES.includes(b.priority) ? b.priority : "LOW",
    subject: `Asset request: ${itemName}`, description: justification,
    details: { assetType, itemName, catalogItemId: item?.id || null, quantity: 1, ...(Object.keys(cf.values).length ? { customFieldValues: cf.values } : {}) },
  }, itemName);
  res.status(201).json(t);
});

router.get("/my-assets", async (req, res) => {
  const myId = await myEmployeeId(req);
  if (!myId) return res.json([]);
  res.json(await prisma.itAsset.findMany({ where: { assignedEmployeeId: myId, status: { in: ["ASSIGNED", "IN_REPAIR"] } }, orderBy: { assignedAt: "desc" } }));
});

// ---- Elevated access (temporary local admin) ----
// Credential is issued the moment the manager approves — see the approval-decision route below —
// not here at request time.
//
// Mac: no live Mac-LAPS/Graph integration exists for this device type (out of scope for the
// Windows/Intune LAPS project — left exactly as it was), so a generated fallback credential is
// still issued for Mac requests only. NEVER used for Windows — see issueWindowsCredential() below.
const PW_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
function genPassword(len = 16) {
  let out = "";
  for (let i = 0; i < len; i++) out += PW_CHARS[Math.floor(Math.random() * PW_CHARS.length)];
  return out;
}
function genCredential(hostname: string, deviceType: string) {
  const clean = hostname.replace(/[^A-Za-z0-9-]/g, "").slice(0, 15) || "device";
  return { username: deviceType === "Mac" ? "ga_admin" : `${clean}\\ga_admin`, password: genPassword(), source: "MAC_LAPS_FALLBACK" };
}
// A ticket has a credential issued if either the (Mac-only) plaintext field or the (Windows-only)
// encrypted field is present — the two device types never populate the same field.
function hasCredential(d: any) {
  return !!(d?.credentialPassword || d?.credentialPasswordEnc);
}
// Real Windows LAPS credential retrieval via Intune/Graph — never fabricates a password. Throws
// with a clear, specific message (surfaced as-is to the caller) if Intune/Graph can't produce a
// real one; the Windows flow must never fall back to genCredential().
async function issueWindowsCredential(hostname: string) {
  if (!lapsConfigured()) throw new Error("Windows LAPS integration is not configured — contact IT Support before requesting Windows elevated access.");
  const device = await findManagedDeviceByHostname(hostname);
  if (!device) throw new Error(`No Intune-managed device named "${hostname}" was found. Check the hostname matches the device's name in Intune exactly.`);
  if (!device.azureADDeviceId) throw new Error(`Device "${hostname}" is enrolled in Intune but has no linked Microsoft Entra device record yet — Windows LAPS credentials can't be read until it does.`);
  const cred = await getLapsCredential(device.azureADDeviceId);
  return {
    username: cred.accountName, passwordEnc: encryptSecret(cred.password), source: "INTUNE_LAPS",
    // Two different id spaces for the same device — lapsDeviceId (Intune managedDevice id) is what
    // rotateLapsPassword() needs; lapsAzureAdDeviceId (Entra device-object id) is what
    // getLapsCredential() needs. Keeping both distinct here so a future re-fetch/rotate never
    // accidentally reuses the wrong one (see engine/intuneLaps.ts for why they can't be mixed up).
    lapsDeviceId: device.id, lapsAzureAdDeviceId: device.azureADDeviceId, lapsBackupDateTime: cred.backupDateTime,
  };
}
// Shared by both grant paths (manager approval, and IT granting directly when no manager was
// involved) so the credential is always issued the same way. Throws (never returns fake data) if
// a Windows credential can't be retrieved for real — callers must not resolve the ticket in that case.
async function credentialData(t: any) {
  const d: any = t.details || {};
  if (d.deviceType === "Windows") {
    const cred = await issueWindowsCredential(d.hostname);
    return {
      approvalStatus: "APPROVED", status: "RESOLVED", resolvedAt: new Date(),
      details: { ...d, credentialUsername: cred.username, credentialPasswordEnc: cred.passwordEnc, credentialSource: cred.source, lapsDeviceId: cred.lapsDeviceId, lapsAzureAdDeviceId: cred.lapsAzureAdDeviceId, lapsBackupDateTime: cred.lapsBackupDateTime, grantedAt: new Date().toISOString() },
    };
  }
  const cred = genCredential(d.hostname, d.deviceType);
  return {
    approvalStatus: "APPROVED", status: "RESOLVED", resolvedAt: new Date(),
    details: { ...d, credentialUsername: cred.username, credentialPassword: cred.password, credentialSource: cred.source, grantedAt: new Date().toISOString() },
  };
}

router.post("/elevated-access", async (req, res) => {
  const b = req.body || {};
  const settings = await getSettings();
  const maxDays = settings.elevatedAccessMaxDays || 7;
  const deviceType = ["Windows", "Mac"].includes(b.deviceType) ? b.deviceType : null;
  const hostname = String(b.hostname || "").trim();
  const justification = String(b.justification || "").trim();
  const days = Number(b.durationDays);
  const startAt = b.startAt ? new Date(b.startAt) : null;
  if (!deviceType) return res.status(400).json({ error: "Select the device type" });
  if (!hostname) return res.status(400).json({ error: "System name / hostname is required" });
  if (!justification) return res.status(400).json({ error: "Justification is required" });
  if (!startAt || isNaN(startAt.getTime())) return res.status(400).json({ error: "Start date and time are required" });
  if (!Number.isInteger(days) || days < 1 || days > maxDays) return res.status(400).json({ error: `Access duration must be 1–${maxDays} days` });
  // A pending request or a still-active (not yet expired) approved session already exists — only
  // one at a time, matching the guide's "cannot submit another request while pending/active".
  const existing = await prisma.helpdeskTicket.findMany({ where: { requesterUserId: req.user!.id, type: "ELEVATED_ACCESS", status: { in: ["PENDING_MANAGER", "OPEN", "RESOLVED"] } } });
  const blocking = existing.find((t) => ["PENDING_MANAGER", "OPEN"].includes(t.status) || (t.status === "RESOLVED" && (t.details as any)?.expiresAt && new Date((t.details as any).expiresAt) > new Date() && !(t.details as any)?.sessionEndedAt));
  if (blocking) return res.status(400).json({ error: `You already have a ${blocking.status === "RESOLVED" ? "active" : "pending"} elevated-access request (${ticketNo(blocking)}). Cancel or wait for it to finish first.` });
  const expiresAt = new Date(startAt.getTime() + days * 86400000);
  const cf = collectCustomFieldValues(customFieldsFor(settings, "ELEVATED_ACCESS"), b.customFieldValues);
  if (cf.error) return res.status(400).json({ error: cf.error });
  const t = await createApprovalRequest(req, {
    type: "ELEVATED_ACCESS", category: "Access & Permissions", priority: "HIGH",
    subject: `Elevated access: ${deviceType} administrator on ${hostname}`.slice(0, 190), description: justification,
    details: { deviceType, accessLevel: `${deviceType} Administrator account`, hostname, startAt: startAt.toISOString(), durationDays: days, expiresAt: expiresAt.toISOString(), ...(Object.keys(cf.values).length ? { customFieldValues: cf.values } : {}) },
  }, `${deviceType} admin access on ${hostname} for ${days} day(s)`);
  res.status(201).json(t);
});

// Employee ends their own active session immediately instead of waiting for natural expiry.
router.post("/tickets/:id/elevated-access/end", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || t.requesterUserId !== req.user!.id || t.type !== "ELEVATED_ACCESS") return res.status(404).json({ error: "Request not found" });
  const d: any = t.details || {};
  if (t.status !== "RESOLVED" || !hasCredential(d)) return res.status(400).json({ error: "No active session to end" });
  if (d.expiresAt && new Date(d.expiresAt) < new Date()) return res.status(400).json({ error: "Session has already expired" });
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { details: { ...d, sessionEndedAt: new Date().toISOString(), expiresAt: new Date().toISOString() } } });
  await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: "Session ended early by the employee." } });
  await auditEA(req.user!.id, "ELEVATED_ACCESS_SESSION_ENDED", t.id);
  // Rotate the password after the session ends, per policy — Windows only (real Intune LAPS);
  // Mac's fallback credential has no live rotation integration and is left as-is (unchanged scope).
  if (d.credentialSource === "INTUNE_LAPS" && d.lapsDeviceId) {
    rotateLapsPassword(d.lapsDeviceId).then(() => auditEA(req.user!.id, "ELEVATED_ACCESS_ROTATION_TRIGGERED", t.id)).catch((e) => auditEA(req.user!.id, "ELEVATED_ACCESS_ROTATION_FAILED", t.id, { error: String(e?.message || e) }));
  }
  res.json({ ok: true });
});

// Requester withdraws an asset / elevated-access request (or an incident) that nobody has acted on yet.
router.post("/tickets/:id/cancel", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || t.requesterUserId !== req.user!.id) return res.status(404).json({ error: "Request not found" });
  if (!perm(await getSettings(), t.type, "employeeCanWithdraw")) return res.status(403).json({ error: "Withdrawing this type of request has been turned off — contact IT Support." });
  if (!["PENDING_MANAGER", "OPEN"].includes(t.status)) return res.status(400).json({ error: "Only a request that hasn't been picked up yet can be cancelled" });
  const reason = String(req.body?.reason || "").trim();
  const updated = await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { status: "CANCELLED", closedAt: new Date(), approvalStatus: t.approvalStatus === "PENDING" ? null : t.approvalStatus } });
  if (reason) await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: `Withdrawn by requester: ${reason}` } });
  if (t.managerEmployeeId) notifyIt(req, `[${ticketNo(t)}] Withdrawn by requester`, `<p>${esc(req.user!.name)} withdrew ${ticketNo(t)}.</p>${reason ? `<p>${esc(reason)}</p>` : ""}`).catch(() => {});
  res.json(updated);
});

// ---- Team approvals (reporting manager) ----
// IT Support can also act as a fallback decision-maker (a slow/unavailable manager shouldn't be
// able to block the IT admin dashboard from handling something an employee raised) — not just the
// actual reporting manager or a full admin.
const canDecide = async (req: Request, t: any, settings: any) => {
  const myId = await myEmployeeId(req);
  return (t.managerEmployeeId && myId === t.managerEmployeeId) || (IT_ROLES.includes(req.user!.role) && (ADMIN_ROLES.includes(req.user!.role) || perm(settings, t.type, "itCanApprove")));
};
router.get("/approvals", async (req, res) => {
  const mine = await myEmployeeId(req);
  const status = req.query.history === "1" ? { in: ["APPROVED", "REJECTED"] } : "PENDING";
  const where: any = { approvalStatus: status, ...(mine ? { managerEmployeeId: mine } : { id: -1 }) };
  const rows = await prisma.helpdeskTicket.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  res.json(await hydrate(rows));
});
router.post("/approvals/:id/:decision", async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  const settings = await getSettings();
  if (!t || !(await canDecide(req, t, settings))) return res.status(404).json({ error: "Request not found" });
  if (t.approvalStatus !== "PENDING" || t.status !== "PENDING_MANAGER") return res.status(400).json({ error: "This request is no longer awaiting approval" });
  const approve = req.params.decision === "approve";
  const note = String(req.body?.note || "").trim() || null;
  if (!approve && !note) return res.status(400).json({ error: "Add a reason for rejecting" });
  // Elevated access has no separate IT-fulfilment step — approval itself grants the credential
  // immediately, which is why it goes straight to RESOLVED ("Access Granted") instead of OPEN
  // ("waiting on IT"). Asset requests still go to OPEN for IT to assign/procure as before.
  let data: any;
  if (approve && t.type === "ELEVATED_ACCESS") {
    // Windows credential retrieval can genuinely fail (device not enrolled, no LAPS backup on
    // file, Graph unreachable) — the manager's decision must not silently "succeed" with no
    // credential behind it. Leave the ticket exactly as it was (still PENDING_MANAGER) so the
    // manager can see the real error and retry once the underlying issue is fixed, instead of
    // ever substituting a fake password.
    let cd: any;
    try { cd = await credentialData(t); }
    catch (e: any) {
      await auditEA(req.user!.id, "ELEVATED_ACCESS_GRANT_FAILED", t.id, { error: String(e?.message || e) });
      return res.status(502).json({ error: e?.message || "Could not retrieve the administrator credential from Intune. The request has not been approved — try again once the issue is resolved." });
    }
    data = { ...cd, managerDecisionById: req.user!.id, managerDecisionAt: new Date(), managerNote: note };
  } else {
    data = approve
      ? { approvalStatus: "APPROVED", status: "OPEN", managerDecisionById: req.user!.id, managerDecisionAt: new Date(), managerNote: note }
      : { approvalStatus: "REJECTED", status: "REJECTED", rejectedBy: "MANAGER", managerDecisionById: req.user!.id, managerDecisionAt: new Date(), managerNote: note, closedAt: new Date() };
  }
  const updated = await prisma.helpdeskTicket.update({ where: { id: t.id }, data });
  await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: `${approve ? "Approved" : "Rejected"} by manager${note ? `: ${note}` : ""}${approve && t.type === "ELEVATED_ACCESS" ? " — credential retrieved." : ""}` } });
  if (approve && t.type === "ELEVATED_ACCESS") await auditEA(req.user!.id, "ELEVATED_ACCESS_APPROVED", t.id, { deviceType: (t.details as any)?.deviceType, hostname: (t.details as any)?.hostname });
  if (approve && t.type !== "ELEVATED_ACCESS") notifyIt(req, `[${ticketNo(t)}] ${t.subject} — manager approved`, `<p>${esc(t.subject)} was approved by ${esc(req.user!.name)} and is ready for IT.</p>`).catch(() => {});
  // Never put the credential itself in an email/log — the requester picks it up from their own
  // Elevated Access page (server-rendered, over HTTPS, behind auth) only.
  notifyRequester(req, t, `[${ticketNo(t)}] ${approve ? "Approved by your manager" : "Rejected by your manager"}`,
    `<p>${esc(t.subject)}</p>${note ? `<p>${esc(note)}</p>` : ""}${approve && t.type === "ELEVATED_ACCESS" ? "<p>Your temporary administrator credential is ready — open Elevated Access in the app to view it.</p>" : ""}`).catch(() => {});
  emitHelpdeskUpdate("approval_decided", { ticketNo: ticketNo(t), approve });
  const [h] = await hydrate([updated]);
  res.json(h);
});

// ---- Knowledge base (documents: read & download only) ----
const KB_LIST_SELECT = { id: true, title: true, category: true, summary: true, tags: true, views: true, published: true, fileName: true, fileSize: true, createdAt: true, updatedAt: true } as const;
router.get("/kb", async (req, res) => {
  await ensureDefaults();
  const q = String(req.query.q || "").trim();
  const category = req.query.category ? String(req.query.category) : undefined;
  const rows = await prisma.kbArticle.findMany({
    where: {
      ...(isIt(req) && req.query.all ? {} : { published: true }),
      ...(category ? { category } : {}),
      ...(q ? { OR: [{ title: { contains: q } }, { summary: { contains: q } }, { tags: { contains: q } }, { fileName: { contains: q } }] } : {}),
    },
    select: KB_LIST_SELECT, orderBy: [{ title: "asc" }],
  });
  res.json(rows);
});
router.get("/kb/:id", async (req, res) => {
  const a = await prisma.kbArticle.findUnique({ where: { id: Number(req.params.id) }, select: { ...KB_LIST_SELECT, body: true } });
  if (!a || (!a.published && !isIt(req))) return res.status(404).json({ error: "Document not found" });
  await prisma.kbArticle.update({ where: { id: a.id }, data: { views: { increment: 1 } } });
  res.json(a);
});
router.get("/kb/:id/file", async (req, res) => {
  const a = await prisma.kbArticle.findUnique({ where: { id: Number(req.params.id) } });
  if (!a || !a.fileData || (!a.published && !isIt(req))) return res.status(404).json({ error: "Document not found" });
  const ext = (a.fileName || "").split(".").pop()?.toLowerCase();
  const types: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  res.setHeader("Content-Type", types[ext || ""] || "application/octet-stream");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${String(a.fileName).replace(/"/g, "")}"`);
  res.send(Buffer.from(a.fileData, "base64"));
});

// =====================================================================================
// IT console
// =====================================================================================
router.get("/admin/summary", requireIt, async (_req, res) => {
  const rows = await prisma.helpdeskTicket.groupBy({ by: ["status", "type"], _count: { _all: true } });
  const assets = await prisma.itAsset.groupBy({ by: ["status"], _count: { _all: true } });
  res.json({ tickets: rows.map((r) => ({ status: r.status, type: r.type, count: r._count._all })), assets: assets.map((a) => ({ status: a.status, count: a._count._all })) });
});

// ---- IT Admin Dashboard — real metrics from real tables, no placeholder data. Everything here
// is either a groupBy over HelpdeskTicket/ItAsset/RolePermission-adjacent live data, or computed
// from the same SLA/rotation logic already used elsewhere (hydrate(), Access Reports). The client
// joins the "helpdesk:activity" socket room and refetches this on any emitHelpdeskUpdate() ping —
// see engine/realtime.ts — so it updates live without polling. ----
router.get("/admin/dashboard", requireIt, async (_req, res) => {
  const settings = await getSettings();
  const [byStatus, byPriority, byCategory, assetsByStatus, agentRows, recentComments, recentTickets] = await Promise.all([
    prisma.helpdeskTicket.groupBy({ by: ["status", "type"], _count: { _all: true } }),
    prisma.helpdeskTicket.groupBy({ by: ["priority"], where: { type: "INCIDENT" }, _count: { _all: true } }),
    prisma.helpdeskTicket.groupBy({ by: ["category"], where: { type: "INCIDENT" }, _count: { _all: true } }),
    prisma.itAsset.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.helpdeskTicket.groupBy({ by: ["assignedToId"], where: { type: "INCIDENT", status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] }, assignedToId: { not: null } }, _count: { _all: true } }),
    prisma.helpdeskComment.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { ticket: { select: { type: true, subject: true, id: true } } } }),
    prisma.helpdeskTicket.findMany({ where: { type: "INCIDENT", status: { notIn: ["RESOLVED", "CLOSED", "REJECTED", "CANCELLED"] } }, select: { id: true, type: true, priority: true, createdAt: true, status: true } }),
  ]);

  const now = Date.now();
  let slaOverdue = 0, slaOnTrack = 0;
  for (const t of recentTickets) {
    const due = new Date(t.createdAt).getTime() + slaHoursFor(settings, t.priority) * 3600000;
    if (due < now) slaOverdue++; else slaOnTrack++;
  }

  const agentIds = agentRows.map((r) => r.assignedToId).filter((x): x is number => x != null);
  const agents = agentIds.length ? await prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : [];
  const agentById = new Map(agents.map((a) => [a.id, a.name]));

  const eaTickets = await prisma.helpdeskTicket.findMany({ where: { type: "ELEVATED_ACCESS" }, select: { status: true, details: true } });
  let activeAccess = 0, rotationNeeded = 0;
  for (const t of eaTickets) {
    const d: any = t.details || {};
    if (t.status !== "RESOLVED" || !hasCredential(d)) continue;
    const expired = !!d.expiresAt && new Date(d.expiresAt).getTime() < now;
    if (!expired) activeAccess++;
    else if (!String(d.credentialSource || "").startsWith("MAC_LAPS") && (!d.passwordRotatedAt || new Date(d.passwordRotatedAt) < new Date(d.expiresAt))) rotationNeeded++;
  }
  const pendingApprovals = await prisma.helpdeskTicket.count({ where: { approvalStatus: "PENDING" } });

  res.json({
    ticketsByStatus: byStatus.map((r) => ({ status: r.status, type: r.type, count: r._count._all })),
    ticketsByPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count._all })),
    ticketsByCategory: byCategory.map((r) => ({ category: r.category, count: r._count._all })).sort((a, b) => b.count - a.count).slice(0, 8),
    assetsByStatus: assetsByStatus.map((r) => ({ status: r.status, count: r._count._all })),
    agentWorkload: agentRows.map((r) => ({ agent: agentById.get(r.assignedToId!) || "Unknown", count: r._count._all })).sort((a, b) => b.count - a.count),
    sla: { overdue: slaOverdue, onTrack: slaOnTrack },
    elevatedAccess: { active: activeAccess, rotationNeeded },
    pendingApprovals,
    recentActivity: recentComments.map((c) => ({ id: c.id, at: c.createdAt, authorName: c.authorName, body: c.body.slice(0, 160), ticketNo: c.ticket ? ticketNo(c.ticket) : null, subject: c.ticket?.subject })),
  });
});

router.get("/admin/tickets", requireIt, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const type = req.query.type ? String(req.query.type) : undefined;
  const active = req.query.active === "1";
  // approvalStatus: deep-linked from the IT Admin Dashboard's "Pending Approvals" card — same
  // field `pendingApprovals` there counts globally (approvalStatus:"PENDING"), unscoped to a
  // manager (unlike the manager-facing Pending Approval page, which is scoped to their reports).
  const approvalStatus = req.query.approvalStatus ? String(req.query.approvalStatus) : undefined;
  const rows = await prisma.helpdeskTicket.findMany({
    where: { ...(status ? { status } : {}), ...(type ? { type } : {}), ...(active ? { status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] } } : {}), ...(approvalStatus ? { approvalStatus } : {}) },
    orderBy: [{ createdAt: "desc" }], take: 500,
  });
  res.json(await hydrate(rows, { userId: req.user!.id, isIt: true }));
});

router.put("/admin/tickets/:id", requireIt, async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  const b = req.body || {};
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: "Invalid status" });
  if (b.priority && !PRIORITIES.includes(b.priority)) return res.status(400).json({ error: "Invalid priority" });
  // Elevated access can only reach RESOLVED via the dedicated Grant Access / manager-approval
  // path — those are what actually generate the credential. The generic status editor bypassing
  // that would leave the ticket showing "Access Granted" with no real password behind it.
  if (b.status === "RESOLVED" && t.type === "ELEVATED_ACCESS" && !hasCredential((t.details as any) || {})) return res.status(400).json({ error: "Use \"Grant Access\" to resolve an elevated-access request — it issues the credential." });
  if (b.status === "RESOLVED" && perm(await getSettings(), t.type, "requireResolutionNote") && !String(b.resolution ?? t.resolution ?? "").trim()) return res.status(400).json({ error: "Add a resolution note before resolving" });
  const data: any = {
    status: b.status ?? undefined, priority: b.priority ?? undefined,
    assignedToId: b.assignedToId !== undefined ? (b.assignedToId ? Number(b.assignedToId) : null) : undefined,
    resolution: b.resolution !== undefined ? (String(b.resolution).trim() || null) : undefined,
  };
  if (t.status === "PENDING_MANAGER" && b.status && b.status !== "PENDING_MANAGER" && !ADMIN_ROLES.includes(req.user!.role)) return res.status(400).json({ error: "Waiting on the reporting manager's approval first" });
  if (b.status === "REJECTED" && !String(b.resolution ?? "").trim()) return res.status(400).json({ error: "Add a reason for rejecting" });
  if (b.status === "REJECTED") data.rejectedBy = "IT";
  if (b.status === "PENDING_MANAGER") return res.status(400).json({ error: "Invalid status" });
  if (b.status === "RESOLVED" && t.status !== "RESOLVED") data.resolvedAt = new Date();
  if (["CLOSED", "REJECTED", "CANCELLED"].includes(b.status) && !t.closedAt) data.closedAt = new Date();
  if (b.status && ["OPEN", "IN_PROGRESS", "ON_HOLD"].includes(b.status)) { data.resolvedAt = null; data.closedAt = null; }
  const updated = await prisma.helpdeskTicket.update({ where: { id: t.id }, data });
  if (b.status && b.status !== t.status) {
    await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: `Status changed ${t.status} → ${b.status}${b.status === "RESOLVED" && data.resolution ? `\nResolution: ${data.resolution}` : ""}` } });
    notifyRequester(req, t, `[${ticketNo(t)}] ${b.status.replace("_", " ")}`, `<p>Your ticket <b>${esc(t.subject)}</b> is now <b>${b.status.replace("_", " ")}</b>.</p>${data.resolution ? `<p>${esc(data.resolution)}</p>` : ""}`).catch(() => {});
    emitHelpdeskUpdate("ticket_updated", { ticketNo: ticketNo(t), status: b.status });
  }
  const [h] = await hydrate([updated], { userId: req.user!.id, isIt: true });
  res.json(h);
});

// IT grants elevated access directly — covers requests that never had a manager in the loop
// (no resolvable manager, or manager-approval turned off in Settings for this type) and so never
// show up in Team Approvals. Without this, IT had no way to complete those requests at all.
router.post("/admin/tickets/:id/elevated-access/grant", requireIt, async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || t.type !== "ELEVATED_ACCESS") return res.status(404).json({ error: "Request not found" });
  if (t.status === "PENDING_MANAGER") return res.status(400).json({ error: "Still awaiting manager approval — decide it from Team Approvals, or reject it there first." });
  if (hasCredential((t.details as any) || {})) return res.status(400).json({ error: "Access has already been granted for this request" });
  if (!["OPEN"].includes(t.status)) return res.status(400).json({ error: "This request is no longer open" });
  let data: any;
  try { data = await credentialData(t); }
  catch (e: any) {
    await auditEA(req.user!.id, "ELEVATED_ACCESS_GRANT_FAILED", t.id, { error: String(e?.message || e) });
    return res.status(502).json({ error: e?.message || "Could not retrieve the administrator credential from Intune." });
  }
  const updated = await prisma.helpdeskTicket.update({ where: { id: t.id }, data });
  await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: "Access granted directly by IT Support — credential retrieved." } });
  await auditEA(req.user!.id, "ELEVATED_ACCESS_GRANTED", t.id, { deviceType: (t.details as any)?.deviceType, hostname: (t.details as any)?.hostname });
  notifyRequester(req, t, `[${ticketNo(t)}] Access granted`, `<p>Your temporary administrator credential is ready — open Elevated Access in the app to view it.</p>`).catch(() => {});
  emitHelpdeskUpdate("access_granted", { ticketNo: ticketNo(t) });
  const [h] = await hydrate([updated]);
  res.json(h);
});

// ---- Access Reports (elevated access) — history + rotation ----
router.get("/admin/access-reports", requireIt, async (_req, res) => {
  const rows = await prisma.helpdeskTicket.findMany({ where: { type: "ELEVATED_ACCESS" }, orderBy: { createdAt: "desc" }, take: 500 });
  // active/expired/rotationNeeded must be computed from the RAW (un-hydrated) rows — hydrate()
  // strips the credential fields from anyone but the owning employee's own active session, and IT
  // (viewing this report) is never that viewer, by design (see hydrate()'s redaction).
  const now = Date.now();
  const flagsById = new Map(rows.map((t) => {
    const d: any = t.details || {};
    const expired = !!d.expiresAt && new Date(d.expiresAt).getTime() < now;
    const active = t.status === "RESOLVED" && hasCredential(d) && !expired;
    // Rotation applies only to a credential that has actually expired and hasn't been rotated
    // since — a real Mac LAPS-managed credential rotates on its own.
    const rotationNeeded = t.status === "RESOLVED" && expired && !String(d.credentialSource || "").startsWith("MAC_LAPS") && (!d.passwordRotatedAt || new Date(d.passwordRotatedAt) < new Date(d.expiresAt));
    return [t.id, { active, expired, rotationNeeded }];
  }));
  const hydrated = await hydrate(rows);
  res.json(hydrated.map((t: any) => ({ ...t, ...(flagsById.get(t.id) || { active: false, expired: false, rotationNeeded: false }) })));
});
router.post("/admin/tickets/:id/rotate", requireIt, async (req, res) => {
  const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.params.id) } });
  if (!t || t.type !== "ELEVATED_ACCESS") return res.status(404).json({ error: "Request not found" });
  const d: any = t.details || {};
  if (!hasCredential(d)) return res.status(400).json({ error: "No credential has been issued for this request" });
  if (d.credentialSource === "INTUNE_LAPS") {
    if (!d.lapsDeviceId) return res.status(400).json({ error: "This request has no linked Intune device — cannot rotate." });
    try {
      await rotateLapsPassword(d.lapsDeviceId);
    } catch (e: any) {
      await auditEA(req.user!.id, "ELEVATED_ACCESS_ROTATION_FAILED", t.id, { error: String(e?.message || e) });
      return res.status(502).json({ error: e?.message || "Failed to trigger LAPS password rotation via Intune." });
    }
    // Intune's LAPS rotation is asynchronous — the new password is only available after the
    // device's next scheduled check-in, not immediately after this call returns. Try an immediate
    // re-fetch (in case the device happens to already be current); if Graph still reports the same
    // backup as before, clear the now-invalidated password rather than keep serving a credential
    // Intune has just discarded — never substitute a fake one while waiting.
    const oldBackup = d.lapsBackupDateTime;
    let fresh: { accountName: string; password: string; backupDateTime: string } | null = null;
    // lapsAzureAdDeviceId (Entra device id), NOT lapsDeviceId (Intune managedDevice id, used just
    // above for the rotate call itself) — see engine/intuneLaps.ts for why these can't be mixed up.
    if (d.lapsAzureAdDeviceId) {
      try { fresh = await getLapsCredential(d.lapsAzureAdDeviceId); } catch { /* expected immediately after triggering rotation, before the device has checked in */ }
    }
    const rotationComplete = !!fresh && fresh.backupDateTime && fresh.backupDateTime !== oldBackup;
    const { credentialPasswordEnc, ...rest } = d;
    await prisma.helpdeskTicket.update({
      where: { id: t.id },
      data: { details: rotationComplete
        ? { ...rest, credentialUsername: fresh!.accountName, credentialPasswordEnc: encryptSecret(fresh!.password), lapsBackupDateTime: fresh!.backupDateTime, passwordRotatedAt: new Date().toISOString(), rotatedById: req.user!.id, rotationPending: false }
        : { ...rest, passwordRotatedAt: new Date().toISOString(), rotatedById: req.user!.id, rotationPending: true } },
    });
    await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: rotationComplete ? "Administrator password rotated by IT Support (Intune LAPS)." : "Password rotation triggered via Intune LAPS — the new password is not available yet; it will be issued once the device checks in, and can be re-fetched with Rotate again afterward." } });
    await auditEA(req.user!.id, "ELEVATED_ACCESS_ROTATED", t.id, { pending: !rotationComplete });
    emitHelpdeskUpdate("password_rotated", { ticketNo: ticketNo(t) });
    return res.json({ ok: true, pending: !rotationComplete });
  }
  // Mac — unchanged existing fallback-rotation behavior (out of scope for this change).
  const cred = genCredential(d.hostname, d.deviceType);
  await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { details: { ...d, credentialPassword: cred.password, credentialSource: cred.source, passwordRotatedAt: new Date().toISOString(), rotatedById: req.user!.id } } });
  await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: "Administrator password rotated by IT Support." } });
  emitHelpdeskUpdate("password_rotated", { ticketNo: ticketNo(t) });
  res.json({ ok: true });
});

// ---- Helpdesk settings (Admin Settings -> Helpdesk Console -> Settings) ----
router.get("/admin/settings", requireIt, async (_req, res) => res.json(await getSettings()));
router.put("/admin/settings", requireIt, async (req, res) => {
  const b = req.body || {};
  const slaHours: Record<string, number> = { ...DEFAULT_SLA_HOURS };
  for (const p of PRIORITIES) if (b.slaHours?.[p] != null && Number(b.slaHours[p]) > 0) slaHours[p] = Number(b.slaHours[p]);
  const categories = Array.isArray(b.categories) ? b.categories.map((c: any) => String(c).trim()).filter(Boolean) : undefined;
  const assetTypes = Array.isArray(b.assetTypes) ? b.assetTypes.map((c: any) => String(c).trim()).filter(Boolean) : undefined;
  const managerApprovalRequired = { ASSET_REQUEST: b.managerApprovalRequired?.ASSET_REQUEST !== false, ELEVATED_ACCESS: b.managerApprovalRequired?.ELEVATED_ACCESS !== false };
  const elevatedAccessMaxDays = Math.max(1, Math.min(30, Number(b.elevatedAccessMaxDays) || 7));
  // Stage labels — only known internal keys are accepted, text sanitized/length-capped; an admin
  // can rename what's shown but can't introduce a stage the engine doesn't actually have.
  const stageLabels: Record<string, Record<string, string>> = {};
  for (const type of Object.keys(DEFAULT_STAGE_LABELS)) {
    stageLabels[type] = {};
    for (const st of Object.keys(DEFAULT_STAGE_LABELS[type])) {
      const v = String(b.stageLabels?.[type]?.[st] ?? "").trim().slice(0, 60);
      stageLabels[type][st] = v || DEFAULT_STAGE_LABELS[type][st];
    }
  }
  // Permission toggles — only known keys, coerced to boolean; IT_ADMIN/ADMIN access to /admin/*
  // itself is never controlled by this (requireIt is a separate, fixed gate).
  const permissions: Record<string, Record<string, boolean>> = {};
  for (const type of Object.keys(PERMISSION_DEFAULTS)) {
    permissions[type] = {};
    for (const k of Object.keys(PERMISSION_DEFAULTS[type])) permissions[type][k] = b.permissions?.[type]?.[k] !== false;
  }
  // Field visibility toggles — same known-keys-only pattern. Falls back to each field's own
  // default (not a blanket true) when omitted, since attachmentFieldRequired defaults to false —
  // a blanket "!== false" would silently flip an omitted false-default field to true.
  const fields: Record<string, Record<string, boolean>> = {};
  for (const type of Object.keys(FIELD_DEFAULTS)) {
    fields[type] = {};
    for (const k of Object.keys(FIELD_DEFAULTS[type])) fields[type][k] = b.fields?.[type]?.[k] !== undefined ? !!b.fields[type][k] : FIELD_DEFAULTS[type][k];
  }
  // Field labels — only known keys, sanitized/length-capped, same pattern as stage labels.
  const fieldLabels: Record<string, Record<string, string>> = {};
  for (const type of Object.keys(DEFAULT_FIELD_LABELS)) {
    fieldLabels[type] = {};
    for (const k of Object.keys(DEFAULT_FIELD_LABELS[type])) {
      const v = String(b.fieldLabels?.[type]?.[k] ?? "").trim().slice(0, 40);
      fieldLabels[type][k] = v || DEFAULT_FIELD_LABELS[type][k];
    }
  }
  // Custom fields — sanitized, capped at 10/type, only the fixed set of safe input types.
  // Duplicate keys within a type are dropped (keeps the second occurrence's edits, matches how
  // the client's array-by-index editing naturally produces unique keys anyway).
  const customFields: Record<string, any[]> = {};
  for (const type of ["INCIDENT", "ASSET_REQUEST", "ELEVATED_ACCESS"]) {
    const arr = Array.isArray(b.customFields?.[type]) ? b.customFields[type] : [];
    const seen = new Set<string>();
    customFields[type] = arr.slice(0, 10).map((f: any, i: number) => ({
      key: String(f?.key || `cf_${i}`).slice(0, 40),
      label: String(f?.label || "Field").trim().slice(0, 40) || "Field",
      fieldType: CUSTOM_FIELD_TYPES.includes(f?.fieldType) ? f.fieldType : "text",
      required: !!f?.required,
    })).filter((f: any) => { if (seen.has(f.key)) return false; seen.add(f.key); return true; });
  }
  const updated = await prisma.helpdeskSetting.upsert({
    where: { id: 1 },
    create: { id: 1, slaHours, categories, assetTypes, managerApprovalRequired, elevatedAccessMaxDays, stageLabels, permissions, fields, fieldLabels, customFields, updatedById: req.user!.id },
    update: { slaHours, categories, assetTypes, managerApprovalRequired, elevatedAccessMaxDays, stageLabels, permissions, fields, fieldLabels, customFields, updatedById: req.user!.id },
  });
  invalidateSettings();
  res.json(updated);
});

router.get("/admin/agents", requireIt, async (_req, res) => {
  res.json(await prisma.user.findMany({ where: { isActive: true, role: { in: IT_ROLES } }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: "asc" } }));
});
router.get("/admin/employees", requireIt, async (_req, res) => {
  res.json(await prisma.employee.findMany({ where: { exitDate: null }, select: { id: true, name: true, empNo: true, email: true }, orderBy: { name: "asc" } }));
});

// ---- Asset inventory ----
router.get("/admin/assets", requireIt, async (_req, res) => {
  const rows = await prisma.itAsset.findMany({ orderBy: [{ status: "asc" }, { assetTag: "asc" }] });
  const empIds = Array.from(new Set(rows.map((r) => r.assignedEmployeeId).filter(Boolean))) as number[];
  const userIds = Array.from(new Set(rows.map((r) => r.assignedById).filter(Boolean))) as number[];
  const [emps, users] = await Promise.all([
    empIds.length ? prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true, empNo: true } }) : Promise.resolve([]),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  res.json(rows.map((r) => ({ ...r, assignedEmployee: r.assignedEmployeeId ? byId.get(r.assignedEmployeeId) || null : null, assignedByName: r.assignedById ? userById.get(r.assignedById) || null : null })));
});
const assetData = (b: any) => ({
  assetTag: String(b.assetTag || "").trim(), name: String(b.name || "").trim(), category: String(b.category || "Other").trim(),
  make: b.make || null, model: b.model || null, serialNo: b.serialNo || null, notes: b.notes || null,
  purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : null, warrantyTill: b.warrantyTill ? new Date(b.warrantyTill) : null,
});
router.post("/admin/assets", requireIt, async (req, res) => {
  const d = assetData(req.body || {});
  if (!d.assetTag || !d.name) return res.status(400).json({ error: "Asset tag and name are required" });
  if (await prisma.itAsset.findUnique({ where: { assetTag: d.assetTag } })) return res.status(400).json({ error: `Asset tag ${d.assetTag} already exists` });
  res.status(201).json(await prisma.itAsset.create({ data: d }));
});
router.put("/admin/assets/:id", requireIt, async (req, res) => {
  const d = assetData(req.body || {});
  if (!d.assetTag || !d.name) return res.status(400).json({ error: "Asset tag and name are required" });
  const dup = await prisma.itAsset.findUnique({ where: { assetTag: d.assetTag } });
  if (dup && dup.id !== Number(req.params.id)) return res.status(400).json({ error: `Asset tag ${d.assetTag} already exists` });
  const status = req.body?.status;
  res.json(await prisma.itAsset.update({ where: { id: Number(req.params.id) }, data: { ...d, ...(ASSET_STATUSES.includes(status) ? { status } : {}) } }));
});
// Assign to an employee (optionally closing the asset-request ticket that asked for it) / return to stock.
router.post("/admin/assets/:id/assign", requireIt, async (req, res) => {
  const employeeId = Number(req.body?.employeeId);
  if (!employeeId) return res.status(400).json({ error: "Select an employee" });
  const assetId = Number(req.params.id);
  const assignedAt = new Date();
  const a = await prisma.itAsset.update({ where: { id: assetId }, data: { assignedEmployeeId: employeeId, assignedAt, assignedById: req.user!.id, status: "ASSIGNED" } });
  // Opens a brand-new lifecycle row for THIS assignment — see ItAssetAssignmentHistory's own
  // comment for why this is never merged into or overwrites a prior row.
  await prisma.itAssetAssignmentHistory.create({ data: { assetId, employeeId, assignedAt, assignedById: req.user!.id } });
  if (req.body?.ticketId) {
    const t = await prisma.helpdeskTicket.findUnique({ where: { id: Number(req.body.ticketId) } });
    if (t && !["RESOLVED", "CLOSED", "REJECTED"].includes(t.status)) {
      await prisma.helpdeskTicket.update({ where: { id: t.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolution: `Asset ${a.assetTag} (${a.name}) assigned to you.` } });
      await prisma.helpdeskComment.create({ data: { ticketId: t.id, authorUserId: req.user!.id, authorName: req.user!.name, body: `Asset ${a.assetTag} (${a.name}) assigned — ticket resolved.` } });
    }
  }
  emitHelpdeskUpdate("asset_assigned", { assetTag: a.assetTag });
  res.json(a);
});
// Mandatory Return Remark — the client's confirmation prompt collects it before ever calling this,
// but it's re-validated here too since this is a real state-changing action, not just a UI nicety.
router.post("/admin/assets/:id/unassign", requireIt, async (req, res) => {
  const returnRemark = String(req.body?.returnRemark || "").trim();
  if (!returnRemark) return res.status(400).json({ error: "A return remark is required." });
  const assetId = Number(req.params.id);
  const open = await prisma.itAssetAssignmentHistory.findFirst({ where: { assetId, returnedAt: null }, orderBy: { assignedAt: "desc" } });
  if (open) await prisma.itAssetAssignmentHistory.update({ where: { id: open.id }, data: { returnedAt: new Date(), returnedById: req.user!.id, returnRemark } });
  res.json(await prisma.itAsset.update({ where: { id: assetId }, data: { assignedEmployeeId: null, assignedAt: null, status: "IN_STOCK" } }));
});
// Full assign→return lifecycle for this asset — every previous employee, assignment/return dates,
// who performed each side, and why it was returned. Nothing here is ever overwritten by a later
// reassignment (see ItAssetAssignmentHistory).
router.get("/admin/assets/:id/history", requireIt, async (req, res) => {
  const rows = await prisma.itAssetAssignmentHistory.findMany({ where: { assetId: Number(req.params.id) }, orderBy: { assignedAt: "desc" } });
  const empIds = Array.from(new Set(rows.map((r) => r.employeeId)));
  const userIds = Array.from(new Set(rows.flatMap((r) => [r.assignedById, r.returnedById]).filter((x): x is number => !!x)));
  const [emps, users] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true, empNo: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
  ]);
  const empById = new Map(emps.map((e) => [e.id, e]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  res.json(rows.map((r) => ({
    ...r, employee: empById.get(r.employeeId) || null,
    assignedByName: r.assignedById ? userById.get(r.assignedById) || null : null,
    returnedByName: r.returnedById ? userById.get(r.returnedById) || null : null,
  })));
});

// ---- Asset inventory: Export to Excel ----
// Column order/labels match the spec exactly: Asset ID, Name, Type, Make / Model, Serial No,
// Status, AssignedTo, MissingRemark — so a round-trip export -> edit -> import needs no remapping.
router.get("/admin/assets/export", requireIt, async (_req, res) => {
  const rows = await prisma.itAsset.findMany({ orderBy: [{ status: "asc" }, { assetTag: "asc" }] });
  const empIds = Array.from(new Set(rows.map((r) => r.assignedEmployeeId).filter(Boolean))) as number[];
  const emps = empIds.length ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true, empNo: true } }) : [];
  // "Name (EmpNo)" — same format the Assign picker and the on-screen Assigned To column use, so
  // names that repeat across employees are still unambiguous in the exported file.
  const labelById = new Map(emps.map((e) => [e.id, e.empNo ? `${e.name} (${e.empNo})` : e.name]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Asset Inventory");
  ws.columns = [
    { header: "Asset ID", key: "assetTag", width: 16 },
    { header: "Name", key: "name", width: 26 },
    { header: "Type", key: "category", width: 14 },
    { header: "Make / Model", key: "makeModel", width: 24 },
    { header: "Serial No", key: "serialNo", width: 18 },
    { header: "Status", key: "status", width: 14 },
    { header: "AssignedTo", key: "assignedTo", width: 22 },
    { header: "MissingRemark", key: "missingRemark", width: 32 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      assetTag: r.assetTag, name: r.name, category: r.category,
      makeModel: [r.make, r.model].filter(Boolean).join(" "),
      serialNo: r.serialNo || "", status: r.status,
      assignedTo: r.assignedEmployeeId ? labelById.get(r.assignedEmployeeId) || "" : "",
      missingRemark: r.notes || "",
    });
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Asset_Inventory_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---- Asset inventory: Import from Excel ----
// Upserts by Asset ID (assetTag) — a row whose Asset ID already exists updates that asset in
// place (so re-exporting, editing a few cells and re-importing is a safe round-trip), otherwise
// creates a new one. AssignedTo is matched against active Employee names (best-effort, case-
// insensitive); an unmatched name is left unassigned and reported back as a warning rather than
// silently dropped or failing the whole import.
router.post("/admin/assets/import", requireIt, async (req, res) => {
  const b64 = String(req.body?.fileData || "");
  if (!b64) return res.status(400).json({ error: "No file uploaded" });
  let wb: ExcelJS.Workbook;
  try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(b64, "base64") as any); }
  catch { return res.status(400).json({ error: "Could not read this file — make sure it's a valid .xlsx workbook" }); }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) return res.status(400).json({ error: "The worksheet has no data rows" });

  const norm = (s: any) => String(s || "").trim().toLowerCase().replace(/[\s/]+/g, "");
  const colIndex: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, idx) => { colIndex[norm(cell.value)] = idx; });
  const find = (...names: string[]) => { for (const n of names) { const i = colIndex[norm(n)]; if (i) return i; } return 0; };
  const idxAssetId = find("Asset ID", "AssetID", "AssetTag");
  // Name is optional — real inventory exports (e.g. from other asset trackers) often have no
  // dedicated Name column at all, just Asset ID/Type/Make-Model/Serial. When absent, the asset's
  // Name falls back to Make/Model, then Type, rather than rejecting every row.
  const idxName = find("Name");
  const idxType = find("Type", "Category");
  const idxMakeModel = find("Make / Model", "MakeModel", "Make");
  const idxSerial = find("Serial No", "SerialNo", "Serial");
  const idxStatus = find("Status");
  const idxAssignedTo = find("AssignedTo", "Assigned To");
  const idxRemark = find("MissingRemark", "Remark", "Notes");
  if (!idxAssetId) return res.status(400).json({ error: "The Excel file must include an Asset ID column" });

  // Import only ever matches against EXISTING active employees/users (these two findMany results)
  // — it never creates or updates an Employee/User record. An AssignedTo that doesn't resolve to a
  // real employee is left unassigned and flagged, never used to conjure up a new employee row.
  const activeEmps = await prisma.employee.findMany({ where: { exitDate: null }, select: { id: true, name: true, empNo: true, email: true } });
  const empIdByName = new Map(activeEmps.map((e) => [e.name.trim().toLowerCase(), e.id]));
  const empIdByEmpNo = new Map(activeEmps.filter((e) => e.empNo).map((e) => [e.empNo!.trim().toLowerCase(), e.id]));
  // Employee.email is routinely null/unset in this data (see the Reporting Manager M365 fix
  // earlier) — the User table has the real, reliable login emails, so that's checked first, with
  // Employee.email as a fallback for a deployment that does populate it.
  const [usersWithEmp, empIdByEmail] = await Promise.all([
    prisma.user.findMany({ where: { employeeId: { not: null } }, select: { email: true, employeeId: true } }),
    Promise.resolve(new Map(activeEmps.filter((e) => e.email).map((e) => [e.email!.trim().toLowerCase(), e.id]))),
  ]);
  const activeEmpIds = new Set(activeEmps.map((e) => e.id));
  for (const u of usersWithEmp) {
    // Only wire up the User-table email if that employeeId is actually one of our active
    // employees — an inactive/exited employee's stale login shouldn't resurrect a match.
    if (u.employeeId && activeEmpIds.has(u.employeeId) && !empIdByEmail.has(u.email.trim().toLowerCase())) {
      empIdByEmail.set(u.email.trim().toLowerCase(), u.employeeId);
    }
  }
  // AssignedTo may be an email ("anil.singh@genaquarius.com" — the real export's own format), a
  // plain name ("Anil Singh"), or the "Name (EmpNo)" format the app's own export/Assign picker use
  // ("Anil Singh (013)"). Outcomes:
  //  - clean match: resolves unambiguously to one existing active employee
  //  - conflict: a "Name (EmpNo)" pair resolves to two DIFFERENT employees, or the name written
  //    doesn't match the actual name on record for that employee number — genuinely ambiguous, so
  //    we do NOT guess; flagged back for HR to correct by hand
  //  - no match: nothing on file resolves at all
  const matchEmployee = (raw: string): { employeeId: number | null; conflict?: string } => {
    const trimmed = raw.trim();
    if (trimmed.includes("@")) {
      const byEmail = empIdByEmail.get(trimmed.toLowerCase());
      if (byEmail) return { employeeId: byEmail };
      return { employeeId: null, conflict: `No existing employee found for email "${trimmed}" — verify and correct.` };
    }
    const m = trimmed.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (m) {
      const namePart = m[1].trim(), noPart = m[2].trim();
      const byNo = empIdByEmpNo.get(noPart.toLowerCase());
      const byName = namePart ? empIdByName.get(namePart.toLowerCase()) : undefined;
      if (byNo && byName && byNo !== byName) {
        return { employeeId: null, conflict: `"${namePart}" and employee number "${noPart}" belong to two different employees on record — verify and correct.` };
      }
      if (byNo) {
        const emp = activeEmps.find((e) => e.id === byNo)!;
        if (namePart && emp.name.trim().toLowerCase() !== namePart.toLowerCase()) {
          return { employeeId: null, conflict: `Employee number "${noPart}" belongs to "${emp.name}" on record, not "${namePart}" as written — verify and correct.` };
        }
        return { employeeId: byNo };
      }
      if (byName) return { employeeId: byName };
      return { employeeId: null, conflict: `No existing employee matches "${namePart}" or employee number "${noPart}" — verify and correct.` };
    }
    const byName = empIdByName.get(trimmed.toLowerCase());
    if (byName) return { employeeId: byName };
    return { employeeId: null, conflict: `No existing employee named "${trimmed}" — verify and correct.` };
  };
  // Real-world status wording ("Available", "In Use", "Not Assigned"...) doesn't always match this
  // app's own IN_STOCK/ASSIGNED/IN_REPAIR/RETIRED/MISSING vocabulary — map the common synonyms
  // before falling back to IN_STOCK, instead of silently defaulting anything unrecognized.
  const STATUS_SYNONYMS: Record<string, string> = {
    AVAILABLE: "IN_STOCK", UNASSIGNED: "IN_STOCK", NOT_ASSIGNED: "IN_STOCK", INSTOCK: "IN_STOCK",
    ASSIGNED: "ASSIGNED", IN_USE: "ASSIGNED",
    IN_REPAIR: "IN_REPAIR", REPAIR: "IN_REPAIR", UNDER_REPAIR: "IN_REPAIR",
    RETIRED: "RETIRED", DECOMMISSIONED: "RETIRED",
    MISSING: "MISSING", LOST: "MISSING",
  };
  const cell = (row: ExcelJS.Row, idx: number) => (idx ? String(row.getCell(idx).value ?? "").trim() : "");

  let created = 0, updated = 0;
  const warnings: { row: number; assetTag: string; message: string }[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const assetTag = cell(row, idxAssetId);
    if (!assetTag) continue; // blank spacer row
    const category = cell(row, idxType) || "Other";
    const makeModel = cell(row, idxMakeModel);
    const [make, ...modelRest] = makeModel.split(" ").filter(Boolean);
    // Name falls back to Make/Model, then Type — only a row with genuinely nothing to call the
    // asset (no Name column, no Make/Model, no Type either) gets skipped.
    const name = cell(row, idxName) || makeModel || category;
    if (!name) { warnings.push({ row: r, assetTag, message: "No Name, Make/Model or Type given — nothing to call this asset, row skipped." }); continue; }
    const serialNo = cell(row, idxSerial) || null;
    const notes = cell(row, idxRemark) || null;
    const rawStatus = cell(row, idxStatus).toUpperCase().replace(/[\s-]+/g, "_");
    let status = STATUS_SYNONYMS[rawStatus] || (ASSET_STATUSES.includes(rawStatus) ? rawStatus : "IN_STOCK");
    const assignedToName = cell(row, idxAssignedTo);
    let assignedEmployeeId: number | null = null;
    if (assignedToName) {
      const match = matchEmployee(assignedToName);
      assignedEmployeeId = match.employeeId;
      if (match.conflict) warnings.push({ row: r, assetTag, message: `AssignedTo "${assignedToName}": ${match.conflict}` });
      else if (assignedEmployeeId) status = "ASSIGNED";
    }
    const now = new Date();
    const data = { name, category, make: make || null, model: modelRest.join(" ") || null, serialNo, notes, status, assignedEmployeeId, assignedAt: assignedEmployeeId ? now : null };
    const existing = await prisma.itAsset.findUnique({ where: { assetTag } });
    // Only opens a new history row for a GENUINELY new assignment (new asset, or reassigned to a
    // different employee than before) — re-importing the same sheet every week must never spam
    // duplicate rows for an assignment that hasn't actually changed.
    const isNewAssignment = assignedEmployeeId && (!existing || existing.assignedEmployeeId !== assignedEmployeeId);
    if (existing) { await prisma.itAsset.update({ where: { assetTag }, data }); updated++; }
    else { await prisma.itAsset.create({ data: { assetTag, ...data } }); created++; }
    if (isNewAssignment) {
      const asset = existing || await prisma.itAsset.findUnique({ where: { assetTag } });
      if (asset) await prisma.itAssetAssignmentHistory.create({ data: { assetId: asset.id, employeeId: assignedEmployeeId!, assignedAt: now } });
    }
  }
  emitHelpdeskUpdate("asset_import", { created, updated });
  res.json({ created, updated, warnings });
});

router.delete("/admin/assets/:id", requireIt, async (req, res) => {
  await prisma.itAsset.delete({ where: { id: Number(req.params.id) } });
  emitHelpdeskUpdate("asset_deleted", {});
  res.json({ ok: true });
});
// Bulk delete — backs "Select All" + "Delete Selected" in the Asset Inventory table. deleteMany
// silently skips any id that's already gone (e.g. a double-click) rather than erroring the batch.
router.post("/admin/assets/bulk-delete", requireIt, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: "No assets selected" });
  const { count } = await prisma.itAsset.deleteMany({ where: { id: { in: ids } } });
  emitHelpdeskUpdate("asset_deleted", { count });
  res.json({ ok: true, deleted: count });
});

// ---- Catalog admin ----
router.get("/admin/catalog", requireIt, async (_req, res) => {
  await ensureDefaults();
  res.json(await prisma.assetCatalogItem.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }));
});
const catData = (b: any) => ({ name: String(b.name || "").trim(), category: String(b.category || "Peripheral"), description: b.description || null, icon: b.icon || null, requiresApproval: !!b.requiresApproval, active: b.active !== false, order: Number(b.order) || 0 });
router.post("/admin/catalog", requireIt, async (req, res) => {
  const d = catData(req.body || {}); if (!d.name) return res.status(400).json({ error: "Name is required" });
  res.status(201).json(await prisma.assetCatalogItem.create({ data: d }));
});
router.put("/admin/catalog/:id", requireIt, async (req, res) => {
  const d = catData(req.body || {}); if (!d.name) return res.status(400).json({ error: "Name is required" });
  res.json(await prisma.assetCatalogItem.update({ where: { id: Number(req.params.id) }, data: d }));
});

// ---- KB admin (document upload) ----
function kbData(b: any, requireFile: boolean) {
  const d: any = { title: String(b.title || "").trim(), category: KB_CATEGORIES.includes(b.category) ? b.category : "General", summary: b.summary || null, body: b.body || null, tags: b.tags || null, published: b.published !== false };
  if (b.fileData) {
    if (String(b.fileData).length > 14_000_000) throw new Error("Document is too large (max 10 MB)");
    d.fileData = b.fileData; d.fileName = String(b.fileName || "document").slice(0, 190); d.fileSize = Math.round(String(b.fileData).length * 0.75);
  }
  if (!d.title) throw new Error("Title is required");
  if (requireFile && !d.fileData && !String(d.body || "").trim()) throw new Error("Upload a document (or enter the article text)");
  return d;
}
router.get("/admin/kb", requireIt, async (_req, res) => {
  await ensureDefaults();
  res.json(await prisma.kbArticle.findMany({ select: { ...KB_LIST_SELECT, body: true }, orderBy: { title: "asc" } }));
});
router.post("/admin/kb", requireIt, async (req, res) => {
  try { res.status(201).json(await prisma.kbArticle.create({ data: { ...kbData(req.body || {}, true), createdById: req.user!.id }, select: KB_LIST_SELECT })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
router.put("/admin/kb/:id", requireIt, async (req, res) => {
  try { res.json(await prisma.kbArticle.update({ where: { id: Number(req.params.id) }, data: kbData(req.body || {}, false), select: KB_LIST_SELECT })); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
router.delete("/admin/kb/:id", requireIt, async (req, res) => {
  await prisma.kbArticle.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

export default router;
