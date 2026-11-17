/**
 * GenAquarius tenant directory adapter (Microsoft Entra ID / Azure AD).
 *
 * Admin gives consent (OAuth admin-consent flow) which yields a tenant token;
 * we then read the org's users from Microsoft Graph (/users) and import them.
 * Every imported person defaults to the MEMBER (employee) role — an admin then
 * elevates CEO/CTO/FINANCE from the Users admin page.
 *
 * If Graph credentials are not configured, listDirectoryUsers() falls back to
 * the employees already in the system so the import flow is demonstrable.
 */
import { prisma } from "../prisma";

export interface DirectoryUser {
  displayName: string;
  email: string;
  jobTitle?: string;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Acquire a tenant token via client credentials (admin-consented app). */
async function getTenantToken(cfg: any): Promise<string | null> {
  if (!cfg?.tenantId || !cfg?.clientId || !cfg?.clientSecret) return null;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  return j.access_token || null;
}

export async function listDirectoryUsers(): Promise<DirectoryUser[]> {
  const integ = await prisma.integration.findUnique({ where: { provider: "ENTRA" } });
  const token = await getTenantToken(integ?.authConfig as any);

  if (token) {
    const res = await fetch(`${GRAPH_BASE}/users?$select=displayName,mail,userPrincipalName,jobTitle&$top=999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const j: any = await res.json();
      return (j.value || [])
        .map((u: any) => ({ displayName: u.displayName, email: u.mail || u.userPrincipalName, jobTitle: u.jobTitle }))
        .filter((u: DirectoryUser) => u.email);
    }
  }

  // Fallback: derive a directory from existing employees (demo without Graph creds)
  const emps = await prisma.employee.findMany({ orderBy: { name: "asc" } });
  return emps.map((e) => ({
    displayName: e.name,
    email: `${e.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}@genaquarius.com`,
    jobTitle: e.empType,
  }));
}
