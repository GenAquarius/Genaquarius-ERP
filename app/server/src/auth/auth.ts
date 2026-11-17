import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "../config";
import { Role } from "@prisma/client";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  employeeId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compareSync(pw, hash);

export const signToken = (u: AuthUser) =>
  jwt.sign(u, config.jwtSecret, { expiresIn: config.jwtExpires } as jwt.SignOptions);

// Set / clear the session as an httpOnly, Secure (in prod), SameSite cookie.
export function setSession(res: Response, u: AuthUser) {
  res.cookie(config.sessionCookie, signToken(u), {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
}
export function clearSession(res: Response) {
  res.clearCookie(config.sessionCookie, { path: "/" });
}

// Full-admin tier: see every page / function.
// QA is included so a QA tester can exercise EVERY feature — this is safe because
// QA users only ever exist in the isolated QA database (the live DB has none, and
// live additionally lists QA in BLOCKED_SIGNIN_ROLES + uses a different JWT secret).
// HR is deliberately NOT included: HR must never see Finance/Executive dashboard data.
export const ADMIN_ROLES: Role[] = [Role.CEO, Role.COO, Role.CTO, Role.FINANCE, Role.QA];

// HR operations (dashboard, offers, appointment letters): HR + the roles that
// already have "everything" access. FINANCE is intentionally excluded here — Finance
// can configure HR Settings (below) but doesn't run day-to-day HR operations.
export const HR_OPS_ROLES: Role[] = [Role.HR, Role.CEO, Role.COO, Role.CTO];

// HR Admin Settings (salary/CTC/tax/offer/appointment/email config): HR, CEO, COO, CTO, FINANCE.
export const HR_SETTINGS_ROLES: Role[] = [Role.HR, Role.CEO, Role.COO, Role.CTO, Role.FINANCE];

// Whether a role is currently permitted to sign in (admin can toggle via env).
export const canSignIn = (role: string) => !config.blockedSignInRoles.includes(role);

export function authenticate(req: Request, res: Response, next: NextFunction) {
  // Prefer the httpOnly session cookie; allow Bearer for API clients; ?token= for inline PDF links.
  const header = req.headers.authorization;
  const cookieToken = (req as any).cookies?.[config.sessionCookie];
  const token = cookieToken
    || (header?.startsWith("Bearer ") ? header.slice(7) : undefined)
    || (req.query.token as string | undefined);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    req.user = { id: payload.id, name: payload.name, email: payload.email, role: payload.role, employeeId: payload.employeeId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// Require one of the given roles (server-side RBAC — never trust the client).
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: "Forbidden for role " + req.user.role });
    next();
  };
}

export const requireAdmin = requireRole(...ADMIN_ROLES);
