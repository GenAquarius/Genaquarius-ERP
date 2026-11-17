import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin, requireRole, hashPassword } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { listDirectoryUsers } from "../../engine/tenantDirectory";
import { Role } from "@prisma/client";

const router = Router();
router.use(requireAdmin); // user/role/tenant/audit administration is admin-tier only

// ---- Users & roles ----
router.get("/users", requireAdmin, requirePermission("users-roles"), async (_req, res) => {
  res.json(await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, isActive: true, employeeId: true } }));
});
router.post("/users", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const b = req.body;
  const user = await prisma.user.create({
    data: {
      name: b.name, email: String(b.email).toLowerCase(), role: b.role,
      passwordHash: hashPassword(b.password || "password123"),
      employeeId: b.employeeId ? Number(b.employeeId) : null,
    },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  res.status(201).json(user);
});
const VALID_ROLES = ["CEO", "CTO", "FINANCE", "PROJECT_MANAGER", "EMPLOYEE", "CONTRACTOR", "INTERN", "HR", "QA"];
router.put("/users/:id", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const b = req.body;
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id }, select: { role: true, employeeId: true } });
  // Only set fields that were provided & valid — never write an empty/unknown role (the `role`
  // column is a MySQL ENUM and an invalid value triggers a "Data truncated" error).
  const data: any = {};
  if (b.name !== undefined) data.name = String(b.name);
  if (b.role !== undefined && VALID_ROLES.includes(b.role)) data.role = b.role;
  if (b.isActive !== undefined) data.isActive = !!b.isActive;
  if (b.password) data.passwordHash = hashPassword(b.password);
  if (b.employeeId !== undefined) data.employeeId = b.employeeId ? Number(b.employeeId) : null;
  const updated = await prisma.user.update({ where: { id }, data,
    select: { id: true, name: true, email: true, role: true, isActive: true } });
  // Moving OFF the Project Manager role drops every project-level PM assignment too — holding
  // the role is a prerequisite for being assigned as a project's PM (/projects/pm-candidates only
  // lists PROJECT_MANAGER-role users), so losing the role must clear any existing assignments, or
  // a demoted user would stay listed as a project's PM despite no longer being eligible.
  if (existing?.role === "PROJECT_MANAGER" && updated.role !== "PROJECT_MANAGER" && existing.employeeId) {
    await prisma.projectManager.deleteMany({ where: { employeeId: existing.employeeId } });
  }
  res.json(updated);
});

router.delete("/users/:id", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return res.status(400).json({ error: "You can't delete your own account." });
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  await prisma.user.delete({ where: { id } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "DELETE_USER", entity: "User", entityId: String(id), after: { email: user.email, name: user.name } } }).catch(() => {});
  res.json({ ok: true });
});

// ---- Bulk delete (Users & Roles multi-select) ----
router.post("/users/bulk-delete", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const ids: number[] = Array.isArray(req.body.ids) ? req.body.ids.map((n: any) => Number(n)).filter((n: number) => n > 0) : [];
  let deleted = 0, skipped = 0;
  for (const id of ids) {
    if (id === req.user!.id) { skipped++; continue; } // never let an admin delete themselves in bulk
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) { skipped++; continue; }
    await prisma.user.delete({ where: { id } });
    await prisma.auditLog.create({ data: { userId: req.user!.id, action: "DELETE_USER", entity: "User", entityId: String(id), after: { email: user.email, name: user.name } } }).catch(() => {});
    deleted++;
  }
  res.json({ deleted, skipped });
});

// ---- Role assignment (admin picks CEO/CTO/FINANCE/... per user) ----
router.put("/users/:id/role", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const role = req.body.role as Role;
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id }, select: { role: true, employeeId: true } });
  const user = await prisma.user.update({
    where: { id }, data: { role },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  // Same cleanup as the general edit route above — see its own comment.
  if (existing?.role === "PROJECT_MANAGER" && role !== "PROJECT_MANAGER" && existing.employeeId) {
    await prisma.projectManager.deleteMany({ where: { employeeId: existing.employeeId } });
  }
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "ASSIGN_ROLE", entity: "User", entityId: String(user.id), after: { role } } });
  res.json(user);
});

// ---- GenAquarius tenant (Microsoft Entra) directory ----
router.get("/tenant/status", requireAdmin, requirePermission("users-roles"), async (_req, res) => {
  const integ = await prisma.integration.findUnique({ where: { provider: "ENTRA" } });
  res.json(integ || { provider: "ENTRA", status: "DISCONNECTED" });
});

// Admin grants consent / stores tenant app credentials
router.post("/tenant/consent", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const authConfig = req.body.authConfig || {};
  const ex = await prisma.integration.findUnique({ where: { provider: "ENTRA" } });
  const integ = ex
    ? await prisma.integration.update({ where: { provider: "ENTRA" }, data: { authConfig, status: "CONNECTED" } })
    : await prisma.integration.create({ data: { provider: "ENTRA", authConfig, status: "CONNECTED" } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "TENANT_CONSENT", entity: "Integration", entityId: "ENTRA" } });
  res.json(integ);
});

// Import everyone from the tenant; default role = MEMBER (employee). Admin elevates later.
// Resolves the Employee record for a directory user by EMAIL ONLY — never display name. Display
// name used to be the sole strategy here and silently failed whenever the Entra display name
// ("Vishal") wasn't the exact full name on the Employee record ("Vishal Ganju") — no error, no
// report, just a permanently unlinked login (the vishal.ganju@/vik@genaquarius.com cases). Two
// email sources are tried: the actual O365 email IT Admin used to provision their account (Offer
// -> ItProvisioningRequest.emailIdToCreate, the most reliable signal since Employee.email is
// routinely null/unset in this data), then Employee.email itself if it happens to be set. If
// neither matches, this returns null — the User is created/left unlinked rather than guessed at
// by name; HR can link it explicitly from Users & Roles.
async function findEmployeeByDirectoryUser(email: string) {
  return (await prisma.employee.findFirst({ where: { offer: { itProvisioningRequest: { emailIdToCreate: email } } } }))
    || (await prisma.employee.findFirst({ where: { email } }));
}

router.post("/tenant/import", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const dirUsers = await listDirectoryUsers();
  let created = 0, skipped = 0, linked = 0;
  for (const du of dirUsers) {
    const email = du.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      skipped++;
      // "Sync" — an already-imported User that's still unlinked (the exact display-name bug
      // above) gets a second chance every time Import Employees is re-run, not just on first import.
      if (!existing.employeeId) {
        const emp = await findEmployeeByDirectoryUser(email);
        if (emp) { await prisma.user.update({ where: { id: existing.id }, data: { employeeId: emp.id } }); linked++; }
      }
      continue;
    }
    const emp = await findEmployeeByDirectoryUser(email);
    await prisma.user.create({
      data: { name: du.displayName, email, role: Role.EMPLOYEE, passwordHash: hashPassword("password123"), employeeId: emp?.id || null },
    });
    created++;
  }
  await prisma.integration.update({ where: { provider: "ENTRA" }, data: { lastSyncAt: new Date() } }).catch(() => {});
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "TENANT_IMPORT", entity: "Integration", entityId: "ENTRA", after: { created, skipped, linked } } });
  res.json({ created, skipped, linked, total: dirUsers.length });
});

// Read-only — never writes anything. Suggests Employee.email backfills by comparing the REAL
// Entra directory (name + real email) against Employee Master records that don't have an email
// on file yet, using fuzzy/subset name matching (catches "Vishal" from Entra matching "Vishal
// Ganju" in Employee Master) instead of the exact-string match that caused the original
// vishal.ganju@/vik@genaquarius.com bugs. Every suggestion here is just that — a suggestion for
// a human to confirm or reject in Users & Roles before anything is written (see
// POST /tenant/apply-employee-emails below).
const normalizeNameTokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).filter(Boolean);
router.get("/tenant/match-employees", requireAdmin, requirePermission("users-roles"), async (_req, res) => {
  const dirUsers = await listDirectoryUsers();
  const candidates = await prisma.employee.findMany({ where: { exitDate: null, email: null }, select: { id: true, name: true, empNo: true } });
  const candidateTokens = candidates.map((c) => ({ ...c, tokens: normalizeNameTokens(c.name) }));
  const matches: { entraName: string; entraEmail: string; candidates: { id: number; name: string; empNo: string | null }[] }[] = [];
  for (const du of dirUsers) {
    const duTokens = normalizeNameTokens(du.displayName);
    if (!duTokens.length) continue;
    const duSet = new Set(duTokens);
    const found = candidateTokens.filter((c) => {
      if (!c.tokens.length) return false;
      const cSet = new Set(c.tokens);
      // Subset match, either direction — a short Entra display name ("Vishal") matching a fuller
      // Employee name ("Vishal Ganju"), or vice versa. Every token on the shorter side must appear
      // on the longer side.
      return duTokens.every((t) => cSet.has(t)) || c.tokens.every((t) => duSet.has(t));
    });
    if (found.length) matches.push({ entraName: du.displayName, entraEmail: du.email, candidates: found.map((f) => ({ id: f.id, name: f.name, empNo: f.empNo })) });
  }
  res.json(matches);
});

// Applies a human-confirmed batch of Employee.email backfills — only ever called with exactly
// what the reviewer checked/picked in the Match Employee Emails modal, never auto-triggered.
router.post("/tenant/apply-employee-emails", requireAdmin, requirePermission("users-roles"), async (req, res) => {
  const updates: { employeeId: number; email: string }[] = Array.isArray(req.body?.updates) ? req.body.updates : [];
  let applied = 0;
  const detail: { employeeId: number; email: string }[] = [];
  for (const u of updates) {
    const employeeId = Number(u.employeeId);
    const email = String(u.email || "").trim().toLowerCase();
    if (!employeeId || !email) continue;
    await prisma.employee.update({ where: { id: employeeId }, data: { email } });
    detail.push({ employeeId, email });
    applied++;
  }
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "BACKFILL_EMPLOYEE_EMAILS", entity: "Employee", entityId: "bulk", after: { applied, detail } } }).catch(() => {});
  res.json({ applied });
});

// ---- Invoice templates (per-client configurable format) ----
const invTplProjectIds = (b: any): number[] =>
  Array.isArray(b?.projectIds) ? b.projectIds.map((id: any) => Number(id)).filter((n: number) => n > 0) : [];

router.get("/invoice-templates", requireAdmin, requirePermission("invoice-templates"), async (_req, res) => res.json(await prisma.invoiceTemplate.findMany({ include: { clients: { select: { id: true, name: true } }, projects: { select: { id: true, name: true } } } })));
router.post("/invoice-templates", requireAdmin, requirePermission("invoice-templates"), async (req, res) => {
  const b = req.body;
  const projectIds = invTplProjectIds(b);
  res.status(201).json(await prisma.invoiceTemplate.create({
    data: {
      name: b.name, issuerBlock: b.issuerBlock || {}, bankDetails: b.bankDetails || {}, layoutConfig: b.layoutConfig || {},
      projects: { connect: projectIds.map((id) => ({ id })) },
    },
    include: { clients: { select: { id: true, name: true } }, projects: { select: { id: true, name: true } } },
  }));
});
router.put("/invoice-templates/:id", requireAdmin, requirePermission("invoice-templates"), async (req, res) => {
  const b = req.body;
  const projectIds = invTplProjectIds(b);
  res.json(await prisma.invoiceTemplate.update({ where: { id: Number(req.params.id) }, data: {
    name: b.name, issuerBlock: b.issuerBlock, bankDetails: b.bankDetails, layoutConfig: b.layoutConfig,
    projects: { set: projectIds.map((id) => ({ id })) },
  }, include: { clients: { select: { id: true, name: true } }, projects: { select: { id: true, name: true } } } }));
});

// ---- Audit log ----
router.get("/audit", requireAdmin, requirePermission("audit-log"), async (_req, res) => {
  // Volume is bounded by retention rotation (see index.ts), so we can return the
  // whole window for client-side search + pagination.
  res.json(await prisma.auditLog.findMany({ orderBy: { at: "desc" }, take: 10000, include: { user: { select: { name: true } } } }));
});
// Wipes the entire audit trail — deliberately restricted to CTO only (stricter than the general
// admin-tier read above) since this is destructive and irreversible.
router.delete("/audit", requireRole(Role.CTO), requirePermission("audit-log"), async (_req, res) => {
  const { count } = await prisma.auditLog.deleteMany({});
  res.json({ ok: true, deleted: count });
});

export default router;
