// Dynamic RBAC engine backing the Module Access Matrix (RolePermission table).
// See routes/permissions.ts (CEO/CTO-editable matrix API + GET /mine) and
// client/src/permissions.ts (usePermissions/can() consumed by App.tsx).
import { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma";

// Looks up whether `role` may access `pageKey`.
// Zero-regression fallback: if NO row exists at all for this pageKey (any role), the page
// hasn't been migrated into the matrix yet — fail OPEN (allow) rather than silently locking
// everyone out. If a role-specific row exists, its `allowed` value is authoritative. If other
// roles have rows for this pageKey but this role doesn't, that role has no explicit grant → deny.
export async function isAllowed(role: string, pageKey: string): Promise<boolean> {
  const row = await prisma.rolePermission.findUnique({ where: { role_pageKey: { role: role as any, pageKey } } });
  if (row) return row.allowed;
  const anyForPage = await prisma.rolePermission.findFirst({ where: { pageKey } });
  if (!anyForPage) return true; // page not migrated into the matrix yet — fail open
  return false;
}

// Additive guard: use alongside (never instead of) the existing requireRole/requireAdmin
// checks on a router. Only wired into a handful of representative routers for now — see
// the PR/report for the exact list.
export function requirePermission(pageKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    const ok = await isAllowed(req.user.role, pageKey);
    if (!ok) return res.status(403).json({ error: `Access to "${pageKey}" is disabled for role ${req.user.role}` });
    next();
  };
}
