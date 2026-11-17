// Adobe (Acrobat) Sign integration — OAuth 2.0 authorization-code flow (one-time admin
// connect, not per-candidate) plus the Agreements REST API used to send documents for
// e-signature. Endpoint shapes below are Adobe's own documented v6 REST API
// (https://opensource.adobe.com/acrobat-sign/developer_guide/) — not guessed.
//
// Flow: an admin (CTO/CEO) clicks "Connect to Adobe Sign" once → Adobe's consent screen →
// redirects back to our callback with a `code` (+ `api_access_point`, the account's regional
// API shard) → we exchange the code for an access_token + refresh_token and store them,
// alongside the discovered api_access_point, in the ADOBE_SIGN Integration row. Every
// subsequent API call re-reads that row, refreshing the access_token via the refresh_token
// when it's close to expiring — the admin never re-authorizes unless the refresh token itself
// goes stale (60 days of total inactivity, per Adobe's docs).
import { prisma } from "../prisma";
import PDFDocument from "pdfkit";
import { Writable } from "stream";
import { emitEsignUpdate } from "./realtime";

// Adobe accounts live on a specific regional "shard" (na1, na2, eu1, in1, ...) and Adobe does
// NOT transparently redirect an authorize request from the wrong shard to the right one — a
// na1 request against an account whose app actually lives on in1 fails with "invalid_request:
// client configuration is invalid" (reproduced live against GenAquarius's own in1 account).
// Saved as authConfig.shard (editable in Settings → External Integrations → Adobe Sign) instead
// of hardcoded, so a future change of region/account doesn't need a code deploy.
const FALLBACK_SHARD = "in1";
const shardHost = (shard: string) => `secure.${shard}.adobesign.com`;
const shardApiHost = (shard: string) => `https://api.${shard}.adobesign.com`;

// Adobe has been intermittently throttling this account ("high overall load... please try again
// in N seconds" — seen dozens of times in one day) and plain fetch() has NO default timeout, so a
// throttled/slow response could otherwise hang a request (and, transitively, an HR page's reload
// chain — see reconcileAgreement/the /status polling route) indefinitely. Every Adobe Sign call
// below is bounded so a slow/throttled Adobe response fails fast instead of stalling the UI.
const ADOBE_TIMEOUT_MS = 10_000;
const ADOBE_DOWNLOAD_TIMEOUT_MS = 25_000; // combinedDocument download — genuinely larger/slower

async function getIntegration() {
  return prisma.integration.findUnique({ where: { provider: "ADOBE_SIGN" } });
}

export async function getAdobeAuthConfig() {
  const row = await getIntegration();
  const cfg = (row?.authConfig as any) || {};
  const shard = (cfg.shard as string | undefined) || FALLBACK_SHARD;
  return {
    clientId: cfg.clientId as string | undefined,
    clientSecret: cfg.clientSecret as string | undefined,
    accessToken: cfg.accessToken as string | undefined,
    refreshToken: cfg.refreshToken as string | undefined,
    shard,
    apiAccessPoint: (cfg.apiAccessPoint as string | undefined) || shardApiHost(shard),
    tokenExpiresAt: cfg.tokenExpiresAt as number | undefined,
    lastRefreshedAt: cfg.lastRefreshedAt as number | undefined,
  };
}

// `status` mirrors REALITY, not just intent — set CONNECTED only right after a token
// exchange/refresh actually succeeds, and explicitly flipped back to DISCONNECTED the moment a
// refresh attempt fails (see ensureAccessToken), so the settings panel never shows "Connected"
// for a connection that's actually gone stale (e.g. the refresh token itself expired/was revoked).
async function saveAdobeAuthConfig(patch: Record<string, any>, status: "CONNECTED" | "DISCONNECTED" = "CONNECTED") {
  const row = await getIntegration();
  const authConfig = { ...(row?.authConfig as any), ...patch, lastRefreshedAt: Date.now() };
  await prisma.integration.upsert({
    where: { provider: "ADOBE_SIGN" },
    update: { authConfig, status },
    create: { provider: "ADOBE_SIGN", authConfig, status },
  });
}

async function markDisconnected(reason: string) {
  const row = await getIntegration();
  const authConfig = { ...(row?.authConfig as any), lastError: reason };
  await prisma.integration.upsert({
    where: { provider: "ADOBE_SIGN" },
    update: { authConfig, status: "DISCONNECTED" },
    create: { provider: "ADOBE_SIGN", authConfig, status: "DISCONNECTED" },
  });
}

/** Step 1: the URL to send an admin's browser to for Adobe's consent screen. */
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string, shard: string) {
  const scope = ["agreement_read:account", "agreement_write:account", "agreement_send:account", "webhook_read:account", "webhook_write:account"].join(" ");
  const params = new URLSearchParams({ redirect_uri: redirectUri, response_type: "code", client_id: clientId, scope, state });
  return `https://${shardHost(shard)}/public/oauth/v2?${params.toString()}`;
}

/** Step 2: exchange the authorization code Adobe redirected back with for tokens. */
export async function exchangeCodeForTokens(code: string, redirectUri: string, apiAccessPointFromCallback: string | undefined) {
  const { clientId, clientSecret, shard } = await getAdobeAuthConfig();
  if (!clientId || !clientSecret) throw new Error("Adobe Sign Client ID/Secret not configured");
  const apiHost = apiAccessPointFromCallback || shardApiHost(shard);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
  const res = await fetch(`${apiHost}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `Adobe Sign token exchange failed (HTTP ${res.status})`);
  const expiresMs = Number(data.expires_in) > 100000 ? Number(data.expires_in) : Number(data.expires_in) * 1000; // seconds vs ms, defensively
  await saveAdobeAuthConfig({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    apiAccessPoint: data.api_access_point || apiHost,
    tokenExpiresAt: Date.now() + (expiresMs || 3600000) - 60000, // 60s safety margin
  });
}

/** Returns a currently-valid access token + the account's API base, refreshing if needed. */
export async function ensureAccessToken(): Promise<{ accessToken: string; apiAccessPoint: string }> {
  const cfg = await getAdobeAuthConfig();
  if (!cfg.accessToken || !cfg.refreshToken) throw new Error("Adobe Sign is not connected — use Settings → External Integrations → Adobe Sign → Connect.");
  if (cfg.tokenExpiresAt && Date.now() < cfg.tokenExpiresAt) return { accessToken: cfg.accessToken, apiAccessPoint: cfg.apiAccessPoint };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: cfg.refreshToken, client_id: cfg.clientId!, client_secret: cfg.clientSecret! });
  const res = await fetch(`${cfg.apiAccessPoint}/oauth/v2/refresh`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || `Adobe Sign token refresh failed (HTTP ${res.status})`;
    await markDisconnected(msg);
    throw new Error(msg);
  }
  const expiresMs = Number(data.expires_in) > 100000 ? Number(data.expires_in) : Number(data.expires_in) * 1000;
  await saveAdobeAuthConfig({ accessToken: data.access_token, tokenExpiresAt: Date.now() + (expiresMs || 3600000) - 60000 });
  return { accessToken: data.access_token, apiAccessPoint: cfg.apiAccessPoint };
}

/** Uploads a PDF as a transient document (Adobe holds it 7 days) — the first step of sending an agreement. */
export async function uploadTransientDocument(pdf: Buffer, fileName: string): Promise<string> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const form = new FormData();
  form.append("File-Name", fileName);
  form.append("File", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), fileName);
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/transientDocuments`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form as any, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.transientDocumentId) throw new Error(data.message || `Adobe Sign upload failed (HTTP ${res.status})`);
  return data.transientDocumentId;
}

/** Creates and sends an agreement for signature. Adobe's own notification emails (invite,
 * reminders, completion) are explicitly suppressed (emailOption.sendOptions: all "NONE") — the
 * candidate/employee gets GenAquarius's own email instead (see routes/adobeSign.ts, which fetches
 * the signing URL via getSigningUrl() below and sends it through the app's own mailer), matching
 * the user's own stated flow ("Your Email Service → Candidate receives YOUR email"), not Adobe's
 * generic adobesign@adobesign.com sender. */
export async function createAgreement(opts: { name: string; transientDocumentId: string; signerEmail: string; signerName?: string }): Promise<string> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const body = {
    fileInfos: [{ transientDocumentId: opts.transientDocumentId }],
    name: opts.name,
    participantSetsInfo: [{ memberInfos: [{ email: opts.signerEmail, name: opts.signerName }], order: 1, role: "SIGNER" }],
    signatureType: "ESIGN",
    state: "IN_PROCESS",
    emailOption: { sendOptions: { initEmails: "NONE", inFlightEmails: "NONE", completionEmails: "NONE" } },
  };
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/agreements`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(data.message || `Adobe Sign agreement creation failed (HTTP ${res.status})`);
  return data.id;
}

export async function getAgreementStatus(agreementId: string): Promise<string> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/agreements/${agreementId}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Adobe Sign status check failed (HTTP ${res.status})`);
  return data.status;
}

// Voids an in-flight agreement on Adobe's side so the recipient's signing link stops working —
// used when the underlying Offer/Appointment Letter/Service Agreement is cancelled/withdrawn on
// our end, so a candidate can never sign something GenAquarius has already withdrawn.
export async function cancelAgreement(agreementId: string, comment?: string): Promise<void> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/agreements/${agreementId}/state`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: "CANCELLED", agreementCancellationInfo: { comment: comment || "Withdrawn in GenAquarius HR", notifyOthers: false } }),
    signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS),
  });
  if (!res.ok) { const data: any = await res.json().catch(() => ({})); throw new Error(data.message || `Adobe Sign cancel failed (HTTP ${res.status})`); }
}

// Voids every still-in-flight EsignAgreement (Offer, Appointment Letter and/or Service Agreement)
// tied to one offer — called when the Offer itself is Cancelled/Declined/Withdrawn/Expired via the
// plain HR flow, so a candidate can never go sign something GenAquarius has already withdrawn.
// Best-effort on the Adobe side: if that call fails (expired token, Adobe outage), the row is
// still marked CANCELLED locally so the app's own state never shows a live agreement for a dead
// offer, even if Adobe's copy is technically still open.
export async function voidInFlightAgreements(offerId: number) {
  const rows = await prisma.esignAgreement.findMany({ where: { docId: offerId, docType: { in: ["OFFER", "APPOINTMENT_LETTER", "SERVICE_AGREEMENT"] }, status: "OUT_FOR_SIGNATURE" } });
  for (const row of rows) {
    try { await cancelAgreement(row.agreementId); } catch { /* best-effort */ }
    const updated = await prisma.esignAgreement.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
    emitEsignUpdate(updated.docType, updated.docId, updated);
  }
}

/** The direct signing URL for a recipient — embedded in GenAquarius's own "Review & Sign" email
 * instead of relying on Adobe's suppressed invite email. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Adobe has a brief eventual-consistency window right after createAgreement() — calling
 * signingUrls immediately can fail with "The agreement has not yet been exposed to the requested
 * participant" (reproduced live). Retries with backoff before giving up. */
export async function getSigningUrl(agreementId: string, signerEmail: string, attempt = 1): Promise<string | null> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/agreements/${agreementId}/signingUrls`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg: string = data.message || "";
    if (/not yet been exposed/i.test(msg) && attempt < 5) {
      await sleep(attempt * 1500); // 1.5s, 3s, 4.5s, 6s
      return getSigningUrl(agreementId, signerEmail, attempt + 1);
    }
    throw new Error(msg || `Adobe Sign signing-URL lookup failed (HTTP ${res.status})`);
  }
  for (const set of data.signingUrlSetInfos || []) {
    const match = (set.signingUrls || []).find((u: any) => u.email?.toLowerCase() === signerEmail.toLowerCase());
    if (match) return match.esignUrl;
  }
  return (data.signingUrlSetInfos?.[0]?.signingUrls?.[0]?.esignUrl) || null;
}

/** Registers our webhook with Adobe once, right after a successful OAuth connect, so the signed
 * document flows back automatically without the admin needing to paste anything into Adobe's own
 * console — only the OAuth redirect URI still needs manual registration there (Adobe requires
 * that one to be pre-approved before the authorize step will even work). Safe to call repeatedly:
 * skips if a webhook for this exact URL already exists. */
export async function ensureWebhookRegistered(webhookUrl: string): Promise<void> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const listRes = await fetch(`${apiAccessPoint}/api/rest/v6/webhooks`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const list: any = await listRes.json().catch(() => ({}));
  const exists = (list.userWebhookList || list.webhooks || []).some((w: any) => w.webhookUrlInfo?.url === webhookUrl);
  if (exists) return;
  const body = {
    name: "GenAquarius ERP — signature completion",
    scope: "ACCOUNT",
    state: "ACTIVE",
    webhookSubscriptionEvents: ["AGREEMENT_ALL"],
    webhookUrlInfo: { url: webhookUrl },
  };
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/webhooks`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  if (!res.ok) { const d: any = await res.json().catch(() => ({})); throw new Error(d.message || `Webhook registration failed (HTTP ${res.status})`); }
}

/** Diagnostic — lists webhooks currently registered on the connected Adobe Sign account. */
export async function listWebhooks(): Promise<any[]> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/webhooks`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(ADOBE_TIMEOUT_MS) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Webhook list failed (HTTP ${res.status})`);
  return data.userWebhookList || data.webhooks || [];
}

/** A minimal one-page PDF for the "Test E-Sign Flow" button (Settings → Adobe Sign) — lets an
 * admin verify send → sign → webhook → download end-to-end without touching a real Offer. */
export function renderTestPdf(requestedBy: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 72 });
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    sink.on("finish", () => resolve(Buffer.concat(chunks)));
    sink.on("error", reject);
    doc.pipe(sink);
    doc.fontSize(18).text("GenAquarius — Adobe Sign Test Document", { align: "center" });
    doc.moveDown(1.5);
    doc.fontSize(11).text(`This is a test document generated by ${requestedBy} to verify the Adobe Sign integration end-to-end (send, sign, webhook notification, signed-document download).`);
    doc.moveDown(1);
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown(2);
    doc.text("Please sign below to complete the test.");
    doc.moveDown(1);
    // Adobe Sign's text-tag syntax — auto-detected on upload and converted into a real, clickable
    // signature field at this exact spot. Without this, Adobe has nothing to attach a signature
    // widget to, and "Start → Submit" completes with no actual signing step at all (reproduced
    // live — the missing tag was the root cause, not an Adobe/account setting).
    doc.fontSize(9).fillColor("#888").text("{{Sig_es_:signer1:signature}}");
    doc.end();
  });
}

export async function downloadSignedDocument(agreementId: string): Promise<Buffer> {
  const { accessToken, apiAccessPoint } = await ensureAccessToken();
  const res = await fetch(`${apiAccessPoint}/api/rest/v6/agreements/${agreementId}/combinedDocument`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(ADOBE_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Adobe Sign document download failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
