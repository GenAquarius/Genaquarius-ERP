import { config } from "../config";

// Microsoft Graph app-only (client-credentials) mailer.
// Emails are sent AS THE LOGGED-IN USER — callers pass fromUpn = req.user.email.
// Requires the Entra app to have the Mail.Send *application* permission with
// tenant admin consent granted.

export interface MailAttachment {
  name: string;
  contentBytes: string; // base64
  contentType: string;
}

export interface SendMailArgs {
  fromUpn: string;
  // A single system-notification recipient is almost always one address (a string, the original
  // shape every existing caller already passes) — invoice emails need several real TO recipients
  // at once, so this also accepts an array without touching any existing call site.
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}

/** Whether Microsoft Graph mail is configured (tenant + client id/secret present). */
export function mailEnabled(): boolean {
  return !!(config.azure.tenant && config.azure.clientId && config.azure.clientSecret);
}

// In-memory token cache (refresh ~60s before expiry).
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;

  const url = `https://login.microsoftonline.com/${config.azure.tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.azure.clientId,
    client_secret: config.azure.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json.error_description || json.error || `Token request failed (${resp.status})`);
  }
  cachedToken = {
    value: json.access_token,
    expiresAt: now + (Number(json.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

/** Send an email via Microsoft Graph as `fromUpn`. Throws on failure. */
export async function sendMail({ fromUpn, to, cc, bcc, subject, html, attachments }: SendMailArgs): Promise<{ sent: true }> {
  // Local safety switch: a dev copy loaded with production data must never email real people.
  // Set MAIL_DISABLED=true in server/.env (never set in Azure App Service settings).
  if (process.env.MAIL_DISABLED === "true") {
    console.log(`[MAIL_DISABLED] suppressed "${subject}" from ${fromUpn} to ${[to].flat().join(", ")}`);
    return { sent: true };
  }
  const token = await getToken();

  const toList = Array.isArray(to) ? to : [to];
  const message: any = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: toList.map((address) => ({ emailAddress: { address } })),
  };
  // De-duped, case-insensitive against `to` — Notification Settings' CC list (Finance/HR by
  // default, per-flow checkable) shouldn't double a recipient who's already a primary `to`.
  const toLower = new Set(toList.map((a) => a.toLowerCase()));
  const ccUnique = [...new Set((cc || []).filter((a) => a && !toLower.has(a.toLowerCase())))];
  if (ccUnique.length) message.ccRecipients = ccUnique.map((address) => ({ emailAddress: { address } }));
  const bccUnique = [...new Set((bcc || []).filter((a) => a && !toLower.has(a.toLowerCase())))];
  if (bccUnique.length) message.bccRecipients = bccUnique.map((address) => ({ emailAddress: { address } }));
  if (attachments?.length) {
    message.attachments = attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType,
      contentBytes: a.contentBytes,
    }));
  }

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromUpn)}/sendMail`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!resp.ok) {
    let msg = `sendMail failed (${resp.status})`;
    try {
      const err: any = await resp.json();
      msg = err?.error?.message || msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  return { sent: true };
}
