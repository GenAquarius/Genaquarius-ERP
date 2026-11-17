// Microsoft Graph delegated admin actions — automated O365 mailbox creation + license assignment,
// triggered from IT Admin's "Approve" on a Pending Task. OAuth 2.0 authorization-code flow (one-
// time IT Admin connect), same Integration-row token-storage pattern as engine/adobeSign.ts, but
// DELEGATED permissions (User.ReadWrite.All, Organization.Read.All) — never a standing, tenant-
// wide APPLICATION permission on the background service principal (that's what engine/mailer.ts's
// Mail.Send is, and it stays scoped to just sending mail). The signed-in IT Admin must themselves
// be a Global Admin (or Privileged Role Administrator) in Entra to consent to these admin-
// restricted delegated scopes on Microsoft's own consent screen — this app never holds that power
// on its own, only for as long as the connected admin's refresh token remains valid.
import { prisma } from "../prisma";
import { config } from "../config";

const authority = () => `https://login.microsoftonline.com/${config.azure.tenant}`;
// Group.ReadWrite.All added for the Intune access-group auto-enrollment step (findGroupByName +
// addUserToGroup below) — an admin connected BEFORE this scope existed needs to reconnect once
// (Connect Microsoft Admin Account again) before that step will work; ensureGraphAdminToken's
// refresh alone can't widen an already-granted token's scope.
const GRAPH_SCOPES = "openid profile offline_access User.ReadWrite.All Organization.Read.All Group.ReadWrite.All";

async function getIntegration() {
  return prisma.integration.findUnique({ where: { provider: "GRAPH_ADMIN" } });
}

export async function getGraphAdminConfig() {
  const row = await getIntegration();
  const cfg = (row?.authConfig as any) || {};
  // licenseSkuIds/licenseSkuPartNumbers (arrays) replace the old single licenseSkuId/
  // licenseSkuPartNumber — a saved single value from before multi-select existed is read back as
  // a one-element array so an already-configured tenant doesn't silently lose its license setting.
  const licenseSkuIds: string[] = Array.isArray(cfg.licenseSkuIds) ? cfg.licenseSkuIds : (cfg.licenseSkuId ? [cfg.licenseSkuId] : []);
  const licenseSkuPartNumbers: string[] = Array.isArray(cfg.licenseSkuPartNumbers) ? cfg.licenseSkuPartNumbers : (cfg.licenseSkuPartNumber ? [cfg.licenseSkuPartNumber] : []);
  return {
    accessToken: cfg.accessToken as string | undefined,
    refreshToken: cfg.refreshToken as string | undefined,
    tokenExpiresAt: cfg.tokenExpiresAt as number | undefined,
    connectedByUpn: cfg.connectedByUpn as string | undefined,
    connectedAt: cfg.connectedAt as number | undefined,
    enabled: !!cfg.enabled,
    licenseSkuIds, licenseSkuPartNumbers,
    lastError: cfg.lastError as string | undefined,
    status: (row?.status as string) || "DISCONNECTED",
  };
}

async function saveConfig(patch: Record<string, any>, status: "CONNECTED" | "DISCONNECTED" = "CONNECTED") {
  const row = await getIntegration();
  const authConfig = { ...(row?.authConfig as any), ...patch };
  await prisma.integration.upsert({ where: { provider: "GRAPH_ADMIN" }, update: { authConfig, status }, create: { provider: "GRAPH_ADMIN", authConfig, status } });
}

async function markDisconnected(reason: string) {
  const row = await getIntegration();
  const authConfig = { ...(row?.authConfig as any), lastError: reason };
  await prisma.integration.upsert({ where: { provider: "GRAPH_ADMIN" }, update: { authConfig, status: "DISCONNECTED" }, create: { provider: "GRAPH_ADMIN", authConfig, status: "DISCONNECTED" } });
}

export const graphAdminRedirectUri = () => `${config.clientOrigin}/api/graph-admin/oauth/callback`;

/** Step 1: the URL to send the IT Admin's browser to for Microsoft's consent screen. */
export function buildGraphAdminAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: config.azure.clientId,
    response_type: "code",
    redirect_uri: graphAdminRedirectUri(),
    response_mode: "query",
    scope: GRAPH_SCOPES,
    // Admin-restricted scopes need the explicit "Consent on behalf of your organization" screen —
    // always show it rather than silently reusing a stale/partial prior grant.
    prompt: "consent",
    state,
  });
  return `${authority()}/oauth2/v2.0/authorize?${params}`;
}

/** Step 2: exchange the authorization code Microsoft redirected back with for tokens. */
export async function exchangeGraphAdminCode(code: string): Promise<{ upn: string }> {
  const body = new URLSearchParams({
    client_id: config.azure.clientId, client_secret: config.azure.clientSecret,
    grant_type: "authorization_code", code, redirect_uri: graphAdminRedirectUri(), scope: GRAPH_SCOPES,
  });
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `Token exchange failed (HTTP ${res.status})`);
  // Label only ("Connected as x@y.com") — came straight from Microsoft's own token endpoint over
  // TLS using our client secret, unlike a browser-relayed id_token, so a full JWKS re-verification
  // isn't needed just to read this one display claim.
  let upn = "";
  try { upn = JSON.parse(Buffer.from(data.id_token.split(".")[1], "base64").toString()).preferred_username || ""; } catch { /* best-effort label only */ }
  const expiresMs = (Number(data.expires_in) || 3600) * 1000;
  await saveConfig({ accessToken: data.access_token, refreshToken: data.refresh_token, tokenExpiresAt: Date.now() + expiresMs - 60000, connectedByUpn: upn, connectedAt: Date.now(), lastError: null });
  return { upn };
}

/** Returns a currently-valid access token, refreshing if needed. Throws if never connected, or if
 *  the connection has gone stale (refresh token itself expired/was revoked). */
export async function ensureGraphAdminToken(): Promise<string> {
  const cfg = await getGraphAdminConfig();
  if (!cfg.accessToken || !cfg.refreshToken) throw new Error("Microsoft Admin account is not connected — go to IT Admin Dashboard → Automated Provisioning → Connect.");
  if (cfg.tokenExpiresAt && Date.now() < cfg.tokenExpiresAt) return cfg.accessToken;
  const body = new URLSearchParams({ client_id: config.azure.clientId, client_secret: config.azure.clientSecret, grant_type: "refresh_token", refresh_token: cfg.refreshToken, scope: GRAPH_SCOPES });
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || `Token refresh failed (HTTP ${res.status})`;
    await markDisconnected(msg);
    throw new Error(msg);
  }
  const expiresMs = (Number(data.expires_in) || 3600) * 1000;
  await saveConfig({ accessToken: data.access_token, refreshToken: data.refresh_token || cfg.refreshToken, tokenExpiresAt: Date.now() + expiresMs - 60000 });
  return data.access_token;
}

export async function setGraphAdminSettings(patch: { enabled?: boolean; licenseSkuIds?: string[]; licenseSkuPartNumbers?: string[] }) {
  const status = (await getIntegration())?.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED";
  await saveConfig(patch, status as "CONNECTED" | "DISCONNECTED");
}

/** Every license SKU actually available in this tenant, with remaining seat counts — for the
 *  settings dropdown so a SKU is always picked from what's real, never hardcoded/guessed. */
export async function listAvailableLicenseSkus(): Promise<{ skuId: string; skuPartNumber: string; available: number; total: number }[]> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch("https://graph.microsoft.com/v1.0/subscribedSkus", { headers: { Authorization: `Bearer ${token}` } });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `Failed to list license SKUs (HTTP ${resp.status})`);
  return (json.value || []).map((s: any) => ({ skuId: s.skuId, skuPartNumber: s.skuPartNumber, available: (s.prepaidUnits?.enabled || 0) - (s.consumedUnits || 0), total: s.prepaidUnits?.enabled || 0 }));
}

const PW_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
// Exported — reused by itAdmin.ts to generate this app's own (Users & Roles) temporary password
// for the "Email ID Already Created" path, where there's no fresh createO365Mailbox() result to
// reuse a password from.
export function genTempPassword(len = 16) {
  let out = "";
  for (let i = 0; i < len; i++) out += PW_CHARS[Math.floor(Math.random() * PW_CHARS.length)];
  return out;
}
// Resolves an existing account's Graph object id from its email/UPN — needed wherever a call
// takes a bare object id in a path segment that Graph does NOT resolve a UPN against (unlike the
// `/users/{id-or-upn}/...` endpoints below, which accept either interchangeably).
// addUserToGroup's `@odata.id: directoryObjects/{id}` body is exactly that case.
export async function resolveGraphUserId(emailOrUpn: string): Promise<string> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(emailOrUpn)}?$select=id`, { headers: { Authorization: `Bearer ${token}` } });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `Could not find an existing Microsoft 365 account for ${emailOrUpn} (HTTP ${resp.status})`);
  return json.id;
}
const USAGE_LOCATION: Record<string, string> = { INDIA: "IN", US: "US", CANADA: "CA" };

/** Creates the real O365 mailbox via Graph. Throws on failure — caller decides how to surface
 *  that (a warning, not a hard block, same treatment as every other email-send failure here). */
export async function createO365Mailbox(opts: { userPrincipalName: string; displayName: string; mailNickname: string; countryCode?: string; firstName?: string; lastName?: string; mobilePhone?: string; jobTitle?: string; department?: string }): Promise<{ graphUserId: string; temporaryPassword: string }> {
  const token = await ensureGraphAdminToken();
  const temporaryPassword = genTempPassword();
  const body: any = {
    accountEnabled: true,
    displayName: opts.displayName,
    mailNickname: (opts.mailNickname.replace(/[^A-Za-z0-9._-]/g, "") || "user").slice(0, 60),
    userPrincipalName: opts.userPrincipalName,
    usageLocation: USAGE_LOCATION[opts.countryCode || "INDIA"] || "IN",
    passwordProfile: { password: temporaryPassword, forceChangePasswordNextSignIn: true },
  };
  // Profile fields already known from the IT Provisioning Request — fill them in on creation so
  // the M365 profile isn't left blank, rather than making IT Admin re-type them by hand afterward.
  if (opts.firstName) body.givenName = opts.firstName;
  if (opts.lastName) body.surname = opts.lastName;
  if (opts.mobilePhone) body.mobilePhone = opts.mobilePhone;
  if (opts.jobTitle) body.jobTitle = opts.jobTitle;
  if (opts.department) body.department = opts.department;
  const resp = await fetch("https://graph.microsoft.com/v1.0/users", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `Failed to create mailbox (HTTP ${resp.status})`);
  return { graphUserId: json.id, temporaryPassword };
}

// Graph's assignLicense endpoint natively accepts several SKUs in addLicenses, so a multi-select
// still assigns everything in one call rather than one request per license.
export async function assignLicenseToUser(graphUserId: string, skuIds: string[]): Promise<void> {
  if (!skuIds.length) return;
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${graphUserId}/assignLicense`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLicenses: skuIds.map((skuId) => ({ skuId })), removeLicenses: [] }),
  });
  if (!resp.ok) { const json: any = await resp.json().catch(() => ({})); throw new Error(json?.error?.message || `Failed to assign license(s) (HTTP ${resp.status})`); }
}

// Resolves a group's Graph object id from its exact display name — used to find the Intune-
// policy-triggering access group ("gacostingtest2a4c-access") before adding a new hire to it.
// Returns null (not a throw) when nothing matches, so the caller can surface a clear "group not
// found — check the name in Entra" warning instead of a generic Graph error.
export async function findGroupByName(displayName: string): Promise<{ id: string; displayName: string } | null> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/groups?$filter=${encodeURIComponent(`displayName eq '${displayName.replace(/'/g, "''")}'`)}`, { headers: { Authorization: `Bearer ${token}` } });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `Failed to look up group "${displayName}" (HTTP ${resp.status})`);
  const g = (json.value || [])[0];
  return g ? { id: g.id, displayName: g.displayName } : null;
}

// Adds a user to a group by object id — the standard mechanism for group-based Intune policy
// (device compliance, app protection, conditional access, etc.) to apply to them automatically,
// the instant their mailbox is created, with no separate manual step in Intune/Entra.
export async function addUserToGroup(groupId: string, graphUserId: string): Promise<void> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members/$ref`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${graphUserId}` }),
  });
  if (!resp.ok && resp.status !== 204) { const json: any = await resp.json().catch(() => ({})); throw new Error(json?.error?.message || `Failed to add user to group (HTTP ${resp.status})`); }
}

// ---- Offboarding — the reverse of createO365Mailbox/assignLicenseToUser/addUserToGroup above ----
// All three accept a UPN/email directly in place of the Graph object id — Graph resolves either
// interchangeably in the /users/{id} path — so there's no need to have stored graphUserId
// anywhere for an employee who was never onboarded through this app's own automated flow.

// Disables sign-in on the O365 account — the actual, immediate "kill switch" (an already-signed-in
// session survives until its token expires, same as any IdP, but no new sign-in succeeds after
// this). Does not delete the mailbox/data, matching how offboarding is normally done (data stays
// recoverable) — only account deletion in the M365 Admin Center would do that, and this
// deliberately doesn't go that far automatically.
export async function disableO365Account(userEmailOrId: string): Promise<void> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmailOrId)}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ accountEnabled: false }),
  });
  if (!resp.ok) { const json: any = await resp.json().catch(() => ({})); throw new Error(json?.error?.message || `Failed to disable account (HTTP ${resp.status})`); }
}

// Frees every license currently on the account (reads assignedLicenses first, then removes all of
// them in one assignLicense call) — returns the SKU ids that were removed, purely for the
// completed-task record/audit trail.
export async function removeAllLicenses(userEmailOrId: string): Promise<string[]> {
  const token = await ensureGraphAdminToken();
  const getResp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmailOrId)}?$select=assignedLicenses`, { headers: { Authorization: `Bearer ${token}` } });
  const getJson: any = await getResp.json().catch(() => ({}));
  if (!getResp.ok) throw new Error(getJson?.error?.message || `Failed to read current licenses (HTTP ${getResp.status})`);
  const skuIds: string[] = (getJson.assignedLicenses || []).map((l: any) => l.skuId);
  if (!skuIds.length) return [];
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmailOrId)}/assignLicense`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLicenses: [], removeLicenses: skuIds }),
  });
  if (!resp.ok) { const json: any = await resp.json().catch(() => ({})); throw new Error(json?.error?.message || `Failed to remove license(s) (HTTP ${resp.status})`); }
  return skuIds;
}

// Lists the groups a user is CURRENTLY a member of — used to populate the Offboarding
// Deactivation Checklist (only show groups they're actually in, per the spec) and to skip a
// redundant add on the onboarding Group Assignment Checklist ("Already a Member"). `$select` is
// deliberately minimal (id/displayName only) — memberOf can also return directory roles and other
// object types; the filter below keeps only entries that look like real security/M365 groups.
export async function getUserGroupMemberships(userEmailOrId: string): Promise<{ id: string; displayName: string }[]> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmailOrId)}/memberOf?$select=id,displayName`, { headers: { Authorization: `Bearer ${token}` } });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `Failed to fetch group memberships (HTTP ${resp.status})`);
  return (json.value || []).filter((g: any) => g.displayName).map((g: any) => ({ id: g.id, displayName: g.displayName }));
}

// Removes a user from a group by email/UPN — the DELETE endpoint needs the user's own object id
// (unlike the ADD endpoint's $ref body, a path segment can't take a UPN here), so this resolves it
// first. 404 is treated as success — already not a member is the same end state as "removed".
export async function removeUserFromGroup(groupId: string, userEmailOrId: string): Promise<void> {
  const token = await ensureGraphAdminToken();
  const idResp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmailOrId)}?$select=id`, { headers: { Authorization: `Bearer ${token}` } });
  const idJson: any = await idResp.json().catch(() => ({}));
  if (!idResp.ok) throw new Error(idJson?.error?.message || `Failed to resolve user (HTTP ${idResp.status})`);
  const resp = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members/${idJson.id}/$ref`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok && resp.status !== 204 && resp.status !== 404) { const json: any = await resp.json().catch(() => ({})); throw new Error(json?.error?.message || `Failed to remove from group (HTTP ${resp.status})`); }
}

// Sets the M365 profile's "Manager" field — a separate Graph call from user creation itself.
// `managerUpnOrId` can be either the manager's real UPN/email or their Graph object id; Graph
// resolves either the same way via this $ref reference.
export async function setUserManager(graphUserId: string, managerUpnOrId: string): Promise<void> {
  const token = await ensureGraphAdminToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${graphUserId}/manager/$ref`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ "@odata.id": `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(managerUpnOrId)}` }),
  });
  if (!resp.ok) { const json: any = await resp.json().catch(() => ({})); throw new Error(json?.error?.message || `Failed to set manager (HTTP ${resp.status})`); }
}
