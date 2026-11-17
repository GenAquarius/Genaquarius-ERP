// Windows Elevated Access — real Microsoft Intune Windows LAPS credential retrieval via Microsoft
// Graph, application-permission (client-credentials) flow on the SAME app registration
// graphAdmin.ts uses for the delegated O365-provisioning flow, but a SEPARATE token: this one
// needs standing Application permissions (DeviceManagementManagedDevices.Read.All,
// DeviceLocalCredential.Read.All, DeviceManagementManagedDevices.PrivilegedOperations.All),
// granted with tenant admin consent directly on the service principal — not something any one
// signed-in IT Admin delegates by connecting their own account. Credentials read from
// GRAPH_LAPS_TENANT_ID / GRAPH_LAPS_CLIENT_ID / GRAPH_LAPS_CLIENT_SECRET (App Service settings —
// never hardcoded, never logged).
//
// This module NEVER fabricates a credential. Every function throws a clear, specific error when
// Intune/Graph can't produce a real one (not configured, device not found, no LAPS backup on
// file, permission denied) — the caller (helpdesk.ts) must surface that error as-is, never
// substitute a generated fallback for a Windows request.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function lapsConfigured() {
  return !!(process.env.GRAPH_LAPS_TENANT_ID && process.env.GRAPH_LAPS_CLIENT_ID && process.env.GRAPH_LAPS_CLIENT_SECRET);
}

let cachedToken: { token: string; expiresAt: number } | null = null;
async function getAppOnlyToken(): Promise<string> {
  if (!lapsConfigured()) throw new Error("Windows LAPS integration is not configured (GRAPH_LAPS_TENANT_ID/CLIENT_ID/CLIENT_SECRET) — contact IT to set it up.");
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.GRAPH_LAPS_CLIENT_ID!,
    client_secret: process.env.GRAPH_LAPS_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
  });
  const resp = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_LAPS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) throw new Error(json.error_description || json.error || `Failed to authenticate to Microsoft Graph for LAPS (HTTP ${resp.status})`);
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60000 };
  return json.access_token;
}

// Intune's managedDevice.id and its Microsoft Entra ID device-object id (azureADDeviceId) are two
// DIFFERENT id spaces for the same physical device — verified against Microsoft's own Graph docs.
// deviceLocalCredentials (LAPS read) is keyed by the Entra device id; rotateLocalAdminPassword
// (the Intune action) is keyed by the managedDevice id. Mixing them up silently 404s. Both are
// captured here so callers never have to guess which one a given function needs.
export type ManagedDevice = { id: string; azureADDeviceId: string | null; deviceName: string; operatingSystem: string };

/** Finds the Intune-managed device whose deviceName exactly matches the given hostname. Throws
 *  (never returns a fabricated match) if Graph can't be reached; returns null if genuinely no
 *  device with that exact name is enrolled. */
export async function findManagedDeviceByHostname(hostname: string): Promise<ManagedDevice | null> {
  const token = await getAppOnlyToken();
  const filter = `deviceName eq '${hostname.replace(/'/g, "''")}'`;
  const resp = await fetch(`${GRAPH_BASE}/deviceManagement/managedDevices?$filter=${encodeURIComponent(filter)}&$select=id,azureADDeviceId,deviceName,operatingSystem`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `Failed to search Intune for device "${hostname}" (HTTP ${resp.status})`);
  const match = (json.value || [])[0];
  return match ? { id: match.id, azureADDeviceId: match.azureADDeviceId || null, deviceName: match.deviceName, operatingSystem: match.operatingSystem } : null;
}

export type LapsCredential = { accountName: string; password: string; backupDateTime: string };

/** Retrieves the CURRENT Windows LAPS local administrator credential for a device, via Graph's
 *  deviceLocalCredentials endpoint (GET /directory/deviceLocalCredentials/{azureADDeviceId} —
 *  note: the Entra AD device-object id, NOT the Intune managedDevice id; see ManagedDevice above).
 *  $select=credentials is required to get the actual password back (Microsoft audits every call
 *  that includes it) — omitting it only returns metadata, never a password. The response wraps
 *  the object in a top-level "value" property (verified against Microsoft's own example — this is
 *  NOT a value array despite the name). Throws with a clear message if the device has no LAPS
 *  backup on file — never returns/invents a password in that case. */
export async function getLapsCredential(azureADDeviceId: string): Promise<LapsCredential> {
  const token = await getAppOnlyToken();
  const resp = await fetch(`${GRAPH_BASE}/directory/deviceLocalCredentials/${azureADDeviceId}?$select=credentials`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: any = await resp.json().catch(() => ({}));
  if (resp.status === 404) throw new Error("No Windows LAPS credential is on file for this device — check that the Windows LAPS policy is assigned and has backed up a password for it yet.");
  if (!resp.ok) throw new Error(json?.error?.message || `Failed to retrieve the LAPS credential from Intune (HTTP ${resp.status})`);
  const cred = (json.value?.credentials || [])[0];
  if (!cred || !cred.passwordBase64) throw new Error("Intune returned no LAPS credential for this device — it may not have backed up a password yet.");
  let password: string;
  try { password = Buffer.from(cred.passwordBase64, "base64").toString("utf8"); }
  catch { throw new Error("Could not decode the LAPS credential returned by Intune."); }
  return { accountName: cred.accountName || "Administrator", password, backupDateTime: cred.backupDateTime };
}

/** Triggers Intune to rotate (regenerate) the device's local admin password immediately — the
 *  actual Graph action for Windows LAPS rotation, keyed by the Intune managedDevice id (NOT the
 *  Entra device id — see ManagedDevice above). This action is beta-only in Microsoft Graph as of
 *  writing (verified: the v1.0 docs page for it redirects to the same beta-only reference, no
 *  v1.0 variant exists yet) — deliberately calls the beta endpoint rather than v1.0 for this one
 *  request; every other call in this module stays on v1.0. Does NOT return the new password
 *  directly (rotation is asynchronous on the device's next check-in); callers should re-fetch via
 *  getLapsCredential() once the rotation has actually completed, not assume it's immediate. */
export async function rotateLapsPassword(managedDeviceId: string): Promise<void> {
  const token = await getAppOnlyToken();
  const resp = await fetch(`https://graph.microsoft.com/beta/deviceManagement/managedDevices/${managedDeviceId}/rotateLocalAdminPassword`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok && resp.status !== 204) {
    const json: any = await resp.json().catch(() => ({}));
    throw new Error(json?.error?.message || `Failed to trigger LAPS password rotation (HTTP ${resp.status})`);
  }
}

export { lapsConfigured };
