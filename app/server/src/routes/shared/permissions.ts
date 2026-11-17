// Module Access Matrix API — backs the CTO-editable RBAC grid (RolePermission table).
// GET /mine is open to any authenticated user (self-lookup only); everything else is CEO/CTO-only.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { Role } from "@prisma/client";

const router = Router();

// ---- GET /mine — any authenticated user's own role permissions, {pageKey: boolean} ----
// Registered before the CEO/CTO guard below so every signed-in user can call it for themselves;
// drives client/src/permissions.ts's usePermissions()/can() (nav filtering + route guards).
router.get("/mine", async (req, res) => {
  const rows = await prisma.rolePermission.findMany({ where: { role: req.user!.role }, select: { pageKey: true, allowed: true } });
  const map: Record<string, boolean> = {};
  for (const r of rows) map[r.pageKey] = r.allowed;
  res.json(map);
});

// ---- Everything below: CEO/CTO only ----
router.use(requireRole(Role.CEO, Role.CTO));
router.use(requirePermission("access-matrix"));

// GET / — full matrix grouped by moduleKey: [{ moduleKey, pages: [{ pageKey, pageLabel, roles: {ROLE: bool} }] }]
router.get("/", async (_req, res) => {
  const rows = await prisma.rolePermission.findMany({ orderBy: [{ moduleKey: "asc" }, { id: "asc" }, { role: "asc" }] });
  const moduleOrder: string[] = [];
  const modules: Record<string, { order: string[]; pages: Record<string, { pageKey: string; pageLabel: string; roles: Record<string, boolean> }> }> = {};
  for (const r of rows) {
    if (!modules[r.moduleKey]) { modules[r.moduleKey] = { order: [], pages: {} }; moduleOrder.push(r.moduleKey); }
    const mod = modules[r.moduleKey];
    if (!mod.pages[r.pageKey]) { mod.pages[r.pageKey] = { pageKey: r.pageKey, pageLabel: r.pageLabel, roles: {} }; mod.order.push(r.pageKey); }
    mod.pages[r.pageKey].roles[r.role] = r.allowed;
  }
  const result = moduleOrder.map((moduleKey) => ({
    moduleKey,
    pages: modules[moduleKey].order.map((pageKey) => modules[moduleKey].pages[pageKey]),
  }));
  res.json(result);
});

// PUT / — bulk upsert: body is an array of { role, pageKey, moduleKey, pageLabel, allowed }.
// Only CTO is forced to `allowed: true` server-side, even if the client sent false — the one
// remaining guardrail is against a CTO ever locking THEMSELVES out of the matrix (and everything
// else). CEO/COO are deliberately NOT protected here any more — the explicit ask was for CTO to be
// able to freely check/uncheck exactly which modules every other role, including CEO and COO, can
// reach, with CTO retaining final say over the whole system.
router.put("/", async (req, res) => {
  const changes: Array<{ role: string; pageKey: string; moduleKey?: string; pageLabel?: string; allowed: boolean }> =
    Array.isArray(req.body) ? req.body : [];
  if (!changes.length) return res.json({ ok: true, updated: 0 });

  const before: any[] = [];
  const after: any[] = [];
  for (const c of changes) {
    if (!c || !c.role || !c.pageKey) continue;
    const existing = await prisma.rolePermission.findUnique({ where: { role_pageKey: { role: c.role as Role, pageKey: c.pageKey } } });
    const forcedAllowed = c.role === Role.CTO ? true : !!c.allowed;
    before.push(existing ? { role: existing.role, pageKey: existing.pageKey, allowed: existing.allowed } : null);
    const updated = await prisma.rolePermission.upsert({
      where: { role_pageKey: { role: c.role as Role, pageKey: c.pageKey } },
      update: { allowed: forcedAllowed },
      create: {
        role: c.role as Role,
        pageKey: c.pageKey,
        moduleKey: c.moduleKey || existing?.moduleKey || "Unassigned",
        pageLabel: c.pageLabel || existing?.pageLabel || c.pageKey,
        allowed: forcedAllowed,
      },
    });
    after.push({ role: updated.role, pageKey: updated.pageKey, allowed: updated.allowed });
  }

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "MODULE_ACCESS_MATRIX_UPDATE", entity: "RolePermission", before, after },
  }).catch(() => {});

  res.json({ ok: true, updated: after.length });
});

export default router;
