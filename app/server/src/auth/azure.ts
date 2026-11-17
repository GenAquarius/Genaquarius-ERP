/**
 * Microsoft Entra (Azure AD) SSO — OAuth2 Authorization Code flow with PKCE-less
 * confidential client. 2FA/MFA is enforced by Azure Conditional Access; this app
 * never handles the second factor.
 *
 * Security:
 *  - CSRF protection via a signed `state` stored in an httpOnly cookie.
 *  - The returned id_token's signature is verified against Microsoft's JWKS,
 *    and issuer + audience are validated before we trust any claim.
 */
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { config } from "../config";
import { prisma } from "../prisma";
import { setSession, canSignIn, AuthUser } from "./auth";
import { Role } from "@prisma/client";

const authority = () => `https://login.microsoftonline.com/${config.azure.tenant}`;
const STATE_COOKIE = "ga_oauth_state";

let _jwks: ReturnType<typeof jwksClient> | null = null;
const jwks = () => (_jwks ||= jwksClient({ jwksUri: `${authority()}/discovery/v2.0/keys`, cache: true, rateLimit: true }));

function getKey(header: any, cb: any) {
  jwks().getSigningKey(header.kid, (err, key) => {
    if (err) return cb(err);
    cb(null, key!.getPublicKey());
  });
}

/** Step 1: redirect the browser to Microsoft to sign in (and complete MFA). */
export function azureLogin(_req: Request, res: Response) {
  if (!config.azure.enabled) return res.status(400).json({ error: "Entra SSO is not configured" });
  const state = jwt.sign({ t: Date.now() }, config.jwtSecret, { expiresIn: "10m" });
  res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: config.isProd, sameSite: "lax", maxAge: 600000, path: "/" });
  const params = new URLSearchParams({
    client_id: config.azure.clientId,
    response_type: "code",
    redirect_uri: config.azure.redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    // Force the Microsoft account picker so that after signing out the user is
    // not silently re-authenticated by a lingering Entra SSO session.
    prompt: "select_account",
    state,
  });
  res.redirect(`${authority()}/oauth2/v2.0/authorize?${params}`);
}

/** Step 2: handle Microsoft's redirect, verify everything, start our session. */
export async function azureCallback(req: Request, res: Response) {
  if (!config.azure.enabled) return res.status(400).json({ error: "Entra SSO is not configured" });
  const { code, state } = req.query as Record<string, string>;
  const stateCookie = (req as any).cookies?.[STATE_COOKIE];

  // CSRF: state must match the signed cookie and verify.
  if (!code || !state || !stateCookie || state !== stateCookie) return fail(res, "Invalid OAuth state");
  try { jwt.verify(state, config.jwtSecret); } catch { return fail(res, "Expired OAuth state"); }
  res.clearCookie(STATE_COOKIE, { path: "/" });

  // Exchange the code for tokens (confidential client, over TLS).
  const body = new URLSearchParams({
    client_id: config.azure.clientId,
    client_secret: config.azure.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.azure.redirectUri,
    scope: "openid profile email",
  });
  const tokRes = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!tokRes.ok) return fail(res, "Token exchange failed");
  const tokens: any = await tokRes.json();
  if (!tokens.id_token) return fail(res, "No id_token returned");

  // Verify id_token signature (JWKS) + issuer + audience.
  const claims = await verifyIdToken(tokens.id_token).catch(() => null);
  if (!claims) return fail(res, "id_token verification failed");

  const email = String(claims.preferred_username || claims.email || "").toLowerCase();
  const name = claims.name || email;
  if (!email) return fail(res, "No email claim");

  // Group gate: only members of the authorized Entra security group may enter.
  // Being a tenant Global Admin does NOT grant access — only group membership does.
  if (config.azure.allowedGroupId) {
    const groups: string[] = Array.isArray(claims.groups) ? claims.groups : [];
    if (!groups.includes(config.azure.allowedGroupId)) return fail(res, "Access denied — you are not in the authorized group");
  }

  // Find the provisioned user; optionally auto-provision as MEMBER.
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    if (!config.azure.autoProvision) return fail(res, "User not provisioned");
    // Match by work email first — exact name matching is too fragile against real Employee Master
    // data (designations sometimes get concatenated into the name field, casing varies, etc.); a
    // real user reproduced exactly this ("Anil singh (Network Engi)" vs SSO's "Anil Singh") and
    // ended up auto-provisioned with no employeeId link at all, which the Employee Dashboard then
    // reports as "No employee record is linked to this user account."
    const emp = (email && await prisma.employee.findFirst({ where: { email } })) || await prisma.employee.findFirst({ where: { name } });
    user = await prisma.user.create({
      data: { name, email, role: Role.EMPLOYEE, passwordHash: "SSO", employeeId: emp?.id || null },
    });
  }
  if (!user.isActive) return fail(res, "Account disabled");
  if (!canSignIn(user.role)) return fail(res, "Sign-in is currently disabled for your role");

  const authUser: AuthUser = { id: user.id, name: user.name, email: user.email, role: user.role, employeeId: user.employeeId };
  setSession(res, authUser);
  await prisma.auditLog.create({ data: { userId: user.id, action: "LOGIN_SSO", entity: "User", entityId: String(user.id) } }).catch(() => {});
  res.redirect(config.clientOrigin);
}

function verifyIdToken(idToken: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(idToken, getKey, {
      algorithms: ["RS256"],
      audience: config.azure.clientId,
      issuer: `${authority()}/v2.0`,
    }, (err, decoded) => (err ? reject(err) : resolve(decoded)));
  });
}

function fail(res: Response, msg: string) {
  res.redirect(`${config.clientOrigin}/login?error=${encodeURIComponent(msg)}`);
}
