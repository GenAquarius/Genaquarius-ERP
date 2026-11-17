// Adobe Sign OAuth connect flow — a one-time admin authorization (CTO/CEO), not per-candidate.
// Mounted at /api/adobe-sign (see index.ts). The authorize/callback pair here is what the
// "Connect to Adobe Sign" button (client/src/pages/People.tsx AdobeSignSettings) drives.
import { Router } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { prisma } from "../../prisma";
import { config } from "../../config";
import { requireAdmin, requireRole, HR_OPS_ROLES, ADMIN_ROLES } from "../../auth/auth";
import { getAdobeAuthConfig, buildAuthorizeUrl, exchangeCodeForTokens, uploadTransientDocument, createAgreement, getAgreementStatus, getSigningUrl, downloadSignedDocument, renderTestPdf, ensureWebhookRegistered, listWebhooks, cancelAgreement } from "../../engine/adobeSign";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { emitEsignUpdate } from "../../engine/realtime";
import { renderDocPdfBuffer, renderMsaOrSowPdfBuffer, audit } from "../hrms/hrOffers";
import { ensureOfferPinnedToWorkflow, completeStageByType, offerHasOwnAcceptanceStage } from "../../engine/workflow";

const router = Router();

const redirectUri = () => `${config.clientOrigin}/api/adobe-sign/oauth/callback`;
const webhookUrl = () => `${config.clientOrigin}/api/adobe-sign/webhook`;

// Signed, short-lived `state` doubles as CSRF protection — same pattern as the Azure SSO
// login's own state cookie (auth/azure.ts), but passed through Adobe's redirect instead of a
// cookie since Adobe's own redirect chain doesn't reliably round-trip our cookies.
router.get("/oauth/authorize", requireAdmin, async (req, res) => {
  const { clientId, shard } = await getAdobeAuthConfig();
  if (!clientId) return res.status(400).json({ error: "Save a Client ID first (Settings → External Integrations → Adobe Sign)." });
  const state = jwt.sign({ uid: req.user!.id }, config.jwtSecret, { expiresIn: "10m" });
  res.redirect(buildAuthorizeUrl(clientId, redirectUri(), state, shard));
});

router.get("/oauth/callback", requireAdmin, async (req, res) => {
  const { code, state, api_access_point, error, error_description } = req.query as Record<string, string>;
  const fail = (msg: string) => res.redirect(`${config.clientOrigin}/integrations?adobeSignError=${encodeURIComponent(msg)}`);
  if (error) return fail(error_description || error);
  if (!code || !state) return fail("Missing code/state from Adobe");
  try { jwt.verify(state, config.jwtSecret); } catch { return fail("Expired or invalid OAuth state — try connecting again"); }
  try {
    await exchangeCodeForTokens(code, redirectUri(), api_access_point);
    // Registers the webhook automatically so signed documents flow back without the admin having
    // to separately paste the webhook URL into Adobe's console — best-effort: a failure here
    // shouldn't block the connection itself (webhook can be registered manually as a fallback).
    try { await ensureWebhookRegistered(webhookUrl()); } catch { /* connection still succeeded */ }
    res.redirect(`${config.clientOrigin}/integrations?adobeSignConnected=1`);
  } catch (e: any) {
    const cause = e?.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : "";
    fail((e.message || "Token exchange failed") + cause);
  }
});

// ---- Send a document for signature ----
// Renders the exact same PDF HR already previews, uploads it as an Adobe "transient document",
// and creates an agreement (Adobe emails the signer directly with the signing link — matches
// the user's own described flow of the candidate getting a "Review & Sign" email).
//
// docType "TEST" is a special case, driven by the "Test E-Sign Flow" panel in Settings →
// External Integrations → Adobe Sign: sends a tiny generated PDF to the admin's own email (or
// whichever address they type in) instead of a real Offer document, so the whole send → sign →
// webhook → download pipeline can be verified without touching real candidate data. docId is
// the requesting admin's own user id (one test lane per admin).
router.post("/send/:docType/:docId", requireRole(...HR_OPS_ROLES, ...ADMIN_ROLES), async (req, res) => {
  const docType = req.params.docType.toUpperCase() as "OFFER" | "APPOINTMENT_LETTER" | "SERVICE_AGREEMENT" | "MSA" | "SOW" | "TEST";
  const docId = Number(req.params.docId);
  if (!["OFFER", "APPOINTMENT_LETTER", "SERVICE_AGREEMENT", "MSA", "SOW", "TEST"].includes(docType)) return res.status(400).json({ error: "Unknown document type" });
  // Preview-before-send applies to e-signature the same as the plain-email send button — HR must
  // have actually previewed the document first (see /offers/:id/preview and /appointment/preview).
  if (docType === "OFFER" || docType === "APPOINTMENT_LETTER") {
    const offerCheck = await prisma.offer.findUnique({ where: { id: docId }, select: { status: true } });
    const requiredStatus = docType === "OFFER" ? "PREVIEWED" : "APPOINTMENT_PREVIEWED";
    if (offerCheck?.status !== requiredStatus) {
      return res.status(400).json({ error: `Preview the ${docType === "OFFER" ? "offer" : "appointment letter"} before sending it for e-signature.` });
    }
  }
  try {
    const { buffer, fileName, signerEmail, signerName } = docType === "TEST"
      ? { buffer: await renderTestPdf(req.user!.name), fileName: `AdobeSign_Test_${req.user!.id}.pdf`, signerEmail: String(req.body?.email || req.user!.email), signerName: req.user!.name }
      : (docType === "MSA" || docType === "SOW")
      ? await renderMsaOrSowPdfBuffer(docType, docId)
      : await renderDocPdfBuffer(docType, docId);
    const transientDocumentId = await uploadTransientDocument(buffer, fileName);
    const agreementId = await createAgreement({ name: fileName.replace(/\.pdf$/, ""), transientDocumentId, signerEmail, signerName });
    const row = await prisma.esignAgreement.upsert({
      where: { docType_docId: { docType, docId } },
      update: { agreementId, signerEmail, status: "OUT_FOR_SIGNATURE", signedAt: null, confirmedAt: null, confirmedById: null, createdById: req.user!.id },
      create: { docType, docId, agreementId, signerEmail, createdById: req.user!.id },
    });
    // Sending straight to e-signature (skipping the plain-email "Send Offer"/"Send Appointment
    // Letter"/"Send Service Agreement" button) still has to move the underlying document's own
    // lifecycle forward — otherwise a fully-digital flow that never touches the email button would
    // leave the Offer/Appointment Letter/Service Agreement stuck pre-"sent" forever, and
    // reconcileAgreement's auto-accept (which only fires once the parent is in a "sent" state)
    // would silently no-op even after the candidate signs.
    if (docType === "OFFER") {
      const offer = await prisma.offer.findUnique({ where: { id: docId } });
      if (offer && ["DRAFT", "GENERATED", "PREVIEWED"].includes(offer.status)) {
        await prisma.offer.update({ where: { id: docId }, data: { status: "SENT", sentAt: new Date() } });
        await audit(docId, req.user!.id, "SEND", offer.status, "SENT", "Sent for e-signature via Adobe Sign");
      }
    } else if (docType === "APPOINTMENT_LETTER") {
      const offer = await prisma.offer.findUnique({ where: { id: docId } });
      if (offer && ["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(offer.status)) {
        await prisma.appointmentLetter.update({ where: { offerId: docId }, data: { status: "ISSUED", issuedAt: new Date() } });
        await prisma.offer.update({ where: { id: docId }, data: { status: "APPOINTMENT_ISSUED" } });
        await audit(docId, req.user!.id, "APPOINTMENT_ISSUE", offer.status, "APPOINTMENT_ISSUED", "Sent for e-signature via Adobe Sign");
      }
    } else if (docType === "SERVICE_AGREEMENT") {
      const offer = await prisma.offer.findUnique({ where: { id: docId } });
      if (offer && ["GENERATED", "PREVIEWED"].includes(offer.status)) {
        await prisma.serviceAgreement.update({ where: { offerId: docId }, data: { status: "SENT" } });
        await prisma.offer.update({ where: { id: docId }, data: { status: "SENT", sentAt: new Date() } });
        await audit(docId, req.user!.id, "SERVICE_AGREEMENT_SEND", offer.status, "SENT", "Sent for e-signature via Adobe Sign");
      }
    }
    // Adobe's own invite email is suppressed (createAgreement's emailOption) — GenAquarius sends
    // the "Review & Sign" email itself, with the direct signing link. `fromEmail` lets the sender
    // be picked explicitly (e.g. hr@genaquarius.com) instead of always the requesting admin's own
    // mailbox — useful when that admin's mailbox isn't actually Graph-send-enabled. Any failure
    // here is reported back as `emailWarning`, not silently swallowed — the agreement itself was
    // still created successfully in Adobe, but the admin needs to know the invite didn't go out.
    let emailWarning: string | null = null;
    if (!mailEnabled()) {
      emailWarning = "Email sending is not configured (Microsoft Graph) — the agreement was created in Adobe Sign but no invite email was sent.";
    } else {
      try {
        const signingUrl = await getSigningUrl(agreementId, signerEmail);
        if (!signingUrl) {
          emailWarning = "Adobe Sign did not return a signing URL yet — try Refresh Status, then use Preview/resend once it's available.";
        } else {
          const docLabel = docType === "TEST" ? "Test Document" : fileName.replace(/\.pdf$/, "").replace(/_/g, " ");
          const fromEmail = String(req.body?.fromEmail || req.user!.email);
          await notifyMail("ADOBE_SIGN_INVITE", {
            fromUpn: fromEmail, to: signerEmail,
            subject: `Review & Sign: ${docLabel}`,
            html: `Hi ${signerName || ""},<br><br>Please review and sign the following document: <b>${docLabel}</b>.<br><br><a href="${signingUrl}">Review & Sign Document</a><br><br>Regards,<br>GenAquarius`,
          });
        }
      } catch (e: any) {
        emailWarning = `Invite email failed to send: ${e.message || "unknown error"}`;
      }
    }
    emitEsignUpdate(row.docType, row.docId, row);
    res.json({ ...row, emailWarning });
  } catch (e: any) {
    // Node's fetch() throws a generic "fetch failed" for any network-level error (DNS, TLS,
    // connection refused, timeout) with the real reason nested in `.cause` — surface it, since
    // "fetch failed" alone gives no way to tell an Adobe outage/network block apart from a bad URL.
    const cause = e?.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : "";
    res.status(400).json({ error: (e.message || "Failed to send for signature") + cause });
  }
});

// Delete / start over — lets an admin re-run the Test E-Sign Flow (or re-send a real document)
// without being stuck on a prior attempt's status forever.
router.delete("/status/:docType/:docId", requireRole(...HR_OPS_ROLES, ...ADMIN_ROLES), async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  const docId = Number(req.params.docId);
  // Deleting a genuinely SIGNED record (not just an abandoned OUT_FOR_SIGNATURE attempt) would
  // otherwise leave the Offer/Appointment Letter/Service Agreement's own status stuck at ACCEPTED
  // with no signed document behind it — revert it back to pre-acceptance so "Send Again" is a
  // clean redo, not a desynced state. Only reverts when nothing has moved on since (e.g. HR hasn't
  // already generated the Appointment Letter off the back of this Offer's acceptance) — safer to
  // leave it alone than guess at unwinding further-progressed state.
  const existing = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType, docId } } });
  // Still out for signature — the candidate may still have a live, clickable signing link. Void
  // it on Adobe's side too (best-effort) so "Delete / Send Again" doesn't just hide the local
  // record while leaving a stale document actually signable out in the world.
  if (existing?.status === "OUT_FOR_SIGNATURE") {
    try { await cancelAgreement(existing.agreementId); } catch { /* best-effort — still clean up locally below */ }
  }
  if (existing?.status === "SIGNED") {
    if (docType === "OFFER") {
      const offer = await prisma.offer.findUnique({ where: { id: docId } });
      if (offer?.status === "ACCEPTED") await prisma.offer.update({ where: { id: docId }, data: { status: "SENT", acceptedAt: null, acceptanceMethod: null } });
    } else if (docType === "APPOINTMENT_LETTER") {
      const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: docId } });
      if (appt?.status === "ACCEPTED") await prisma.appointmentLetter.update({ where: { offerId: docId }, data: { status: "ISSUED" } });
    } else if (docType === "SERVICE_AGREEMENT") {
      const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: docId } });
      if (sa?.status === "ACCEPTED") await prisma.serviceAgreement.update({ where: { offerId: docId }, data: { status: "SENT" } });
    }
  }
  await prisma.esignAgreement.deleteMany({ where: { docType, docId } });
  await prisma.attachment.deleteMany({ where: { entityType: `ESIGN_${docType}`, entityId: docId } });
  emitEsignUpdate(docType, docId, { status: "NOT_SENT" });
  res.json({ ok: true });
});

// Reconciles with Adobe's live status whenever our own row still shows OUT_FOR_SIGNATURE — a
// reliable fallback regardless of whether the account's webhook is actually registered and
// firing (reproduced live: it wasn't, despite auto-registration having run at connect time).
// "Refresh Status" in the UI is what calls this, so it always reflects reality even if the
// webhook path silently never worked for this account.
router.get("/status/:docType/:docId", requireRole(...HR_OPS_ROLES, ...ADMIN_ROLES), async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  const docId = Number(req.params.docId);
  let row = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType, docId } } });
  if (!row) return res.json({ status: "NOT_SENT" });
  if (row.status === "OUT_FOR_SIGNATURE") {
    try {
      await reconcileAgreement(row);
      row = await prisma.esignAgreement.findUnique({ where: { id: row.id } });
    } catch { /* live check failed (e.g. token issue) — fall back to whatever we already have stored */ }
  }
  res.json(row);
});

// Preview the signed PDF (downloaded from Adobe once the webhook confirms completion, stored as
// an Attachment — same generic entity-attachment convention Client/Project attachments use).
router.get("/signed/:docType/:docId", requireRole(...HR_OPS_ROLES, ...ADMIN_ROLES), async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  const docId = Number(req.params.docId);
  const att = await prisma.attachment.findFirst({ where: { entityType: `ESIGN_${docType}`, entityId: docId }, orderBy: { uploadedAt: "desc" } });
  if (!att) return res.status(404).json({ error: "Signed document not available yet" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${att.fileName}"`);
  res.send(Buffer.from(att.fileData, "base64"));
});

// Recent signed/declined activity for HR's Dashboard — docId is always Offer.id (Offer,
// AppointmentLetter and ServiceAgreement all hang off the same Offer record), so a single join
// gets the candidate name/offer ref for every row regardless of which of the three it was.
router.get("/recent-activity", requireRole(...HR_OPS_ROLES), async (_req, res) => {
  const rows = await prisma.esignAgreement.findMany({
    where: { docType: { not: "TEST" }, status: { in: ["SIGNED", "DECLINED"] } },
    orderBy: { updatedAt: "desc" }, take: 10,
  });
  const offers = await prisma.offer.findMany({ where: { id: { in: rows.map((r) => r.docId) } }, select: { id: true, candidateName: true, offerRef: true } });
  const byOfferId = new Map(offers.map((o) => [o.id, o]));
  res.json(rows.map((r) => ({ ...r, offer: byOfferId.get(r.docId) || null })));
});

// Manually (re-)registers the webhook — the auto-registration in the OAuth callback is
// best-effort and its own failure is swallowed there, so this gives an explicit way to retry
// without having to fully disconnect and reconnect the whole integration.
router.post("/register-webhook", requireAdmin, async (_req, res) => {
  try { await ensureWebhookRegistered(webhookUrl()); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Diagnostic — the real Adobe-side status of an agreement + which webhooks are registered on the
// account. Used to tell apart "the webhook never fired" from "it fired but our processing failed"
// when a signed document isn't showing up as expected.
router.get("/debug/:docType/:docId", requireAdmin, async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  const docId = Number(req.params.docId);
  const row = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType, docId } } });
  if (!row) return res.status(404).json({ error: "No agreement found" });
  try {
    const [liveStatus, webhooks] = await Promise.all([getAgreementStatus(row.agreementId), listWebhooks()]);
    res.json({ ourRow: row, adobeLiveStatus: liveStatus, registeredWebhooks: webhooks });
  } catch (e: any) {
    res.status(400).json({ error: e.message, ourRow: row });
  }
});

export default router;

// ---- Webhook: Adobe notifies us when an agreement's status changes ----
// Exported separately and mounted BEFORE the global `authenticate` gate (see index.ts) — Adobe's
// servers call this with no session of ours to present. GET is Adobe's one-time verification
// handshake when the webhook is first registered; POST is the actual event notification. Both
// echo back X-AdobeSign-ClientId to prove this URL is under our control — Adobe's own documented
// verification mechanism (no shared secret/HMAC involved).
export const adobeSignWebhookRouter = Router();

// Public post-signing confirmation pages — set these as Adobe's "Post Agreement Completion URL
// Redirect" (Account Settings → Account Setup, separate fields for completing vs. declining)
// instead of leaving recipients on Adobe's own generic pages. No auth (the recipient is an
// external candidate, never logged into this app) and no data lookup — the actual signed
// document is already retrieved automatically via the webhook, independent of this page.
function confirmationPage(opts: { badgeColor: string; icon: string; title: string; body: string }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} — GenAquarius</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0b0d12; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#e6e8ee; }
  .card { text-align:center; padding:40px 32px; max-width:420px; }
  .badge { width:56px; height:56px; border-radius:50%; background:${opts.badgeColor}; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#9aa3b2; font-size:14px; line-height:1.5; }
  img { max-height:40px; margin-bottom:24px; }
</style></head>
<body>
  <div class="card">
    <img src="/genaquarius.png" alt="GenAquarius" />
    <div class="badge">${opts.icon}</div>
    <h1>${opts.title}</h1>
    <p>${opts.body}</p>
  </div>
</body></html>`;
}

const CHECK_ICON = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const X_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="white" stroke-width="3" stroke-linecap="round"/></svg>`;

adobeSignWebhookRouter.get("/thank-you", (_req, res) => {
  res.set("Content-Type", "text/html").send(confirmationPage({
    badgeColor: "#22c55e", icon: CHECK_ICON, title: "Document Signed Successfully",
    body: "Thank you — your signature has been recorded. GenAquarius has automatically received a copy of the completed document and will follow up if any further action is needed.",
  }));
});

adobeSignWebhookRouter.get("/declined", (_req, res) => {
  res.set("Content-Type", "text/html").send(confirmationPage({
    badgeColor: "#e5484d", icon: X_ICON, title: "Signing Declined",
    body: "You've declined to sign this document. GenAquarius HR has been notified — if this was a mistake or you have questions, please reach out to HR directly.",
  }));
});

adobeSignWebhookRouter.get("/webhook", async (req, res) => {
  const clientIdHeader = req.header("X-AdobeSign-ClientId");
  if (clientIdHeader) res.set("X-AdobeSign-ClientId", clientIdHeader);
  res.json({ xAdobeSignClientId: clientIdHeader });
});

// Adobe's terminal statuses for a completed vs. declined agreement — ABORTED is the current name
// for what used to be reported as CANCELLED (both sender-cancel and recipient-decline land here;
// https://developer.adobe.com/acrobat-sign/docs/overview/techblog/tldr/api-agreement-statuses).
const DECLINED_STATUSES = new Set(["ABORTED", "CANCELLED"]);

function notifyRecipientsFor(row: { docType: string }): Role[] {
  return row.docType === "TEST" ? [] : [Role.HR, Role.CEO, Role.CTO];
}

// Reconciles one row against Adobe's live status — downloads+stores the signed PDF and marks
// SIGNED, or marks DECLINED — and sends GenAquarius's own notification either way. Shared by the
// webhook (the normal path) and the /status polling fallback below (in case the webhook was
// never actually registered on this Adobe account, or a specific notification was dropped —
// reproduced live: webhook list came back empty despite ensureWebhookRegistered() having run at
// connect time). No-ops if the row is already in a terminal state.
async function reconcileAgreement(row: { id: number; docType: string; docId: number; agreementId: string; signerEmail: string; createdById: number | null }, liveStatusHint?: string) {
  if (row.docType !== "TEST" && ["SIGNED", "DECLINED"].includes((await prisma.esignAgreement.findUnique({ where: { id: row.id }, select: { status: true } }))?.status || "")) return;
  const liveStatus = liveStatusHint ?? (await getAgreementStatus(row.agreementId));
  const isSigned = liveStatus === "SIGNED";
  const isDeclined = DECLINED_STATUSES.has(liveStatus);
  if (!isSigned && !isDeclined) return;

  const requester = row.createdById ? await prisma.user.findUnique({ where: { id: row.createdById }, select: { email: true } }) : null;
  const roleRecipients = notifyRecipientsFor(row).length
    ? (await prisma.user.findMany({ where: { role: { in: notifyRecipientsFor(row) } }, select: { email: true } })).map((r) => r.email)
    : [];
  const recipients = [...new Set([requester?.email, ...roleRecipients].filter(Boolean) as string[])];
  const docLabel = row.docType === "TEST" ? "test document" : row.docType.replace("_", " ").toLowerCase();

  if (isSigned) {
    const pdf = await downloadSignedDocument(row.agreementId);
    await prisma.attachment.create({ data: { entityType: `ESIGN_${row.docType}`, entityId: row.docId, fileName: `Signed_${row.docType}_${row.docId}.pdf`, fileData: pdf.toString("base64"), note: "Downloaded from Adobe Sign on completion" } });
    // Digitally signing IS the candidate's confirmation — unlike the plain-email flow (where
    // nothing electronic proves agreement, so HR has to manually check off "Confirm Acceptance"),
    // an Adobe Sign completion needs no separate manual confirmation click from HR — EXCEPT when
    // this offer's workflow has no dedicated OFFER_ACCEPTANCE stage of its own (Intern's collapsed
    // workflow: OFFER_GENERATION IS the acceptance-tracking stage). There, auto-completing that
    // SAME stage the instant the webhook fires would jump the wizard straight past it — before HR
    // ever opened the signed document — so completeStageByType is deliberately skipped and left for
    // HR's own explicit "Reviewed — Proceed" click (POST /offers/:id/acknowledge-acceptance) instead.
    await prisma.esignAgreement.update({ where: { id: row.id }, data: { status: "SIGNED", signedAt: new Date(), confirmedAt: new Date() } });
    // Auto-advances the underlying document's own lifecycle — a candidate e-signing IS their
    // acceptance, so it moves straight to ACCEPTED instead of waiting on HR to separately confirm
    // something already confirmed electronically. Same treatment for all three signable documents.
    if (row.docType === "OFFER") {
      const offer = await prisma.offer.findUnique({ where: { id: row.docId } });
      if (offer?.status === "SENT") {
        await prisma.offer.update({ where: { id: row.docId }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptanceMethod: "ADOBE_SIGN" } });
        await prisma.offerAuditLog.create({ data: { offerId: row.docId, action: "ACCEPT", fromStatus: "SENT", toStatus: "ACCEPTED", note: "Signed via Adobe Sign" } }).catch(() => {});
        await ensureOfferPinnedToWorkflow(row.docId);
        if (await offerHasOwnAcceptanceStage(row.docId)) await completeStageByType(row.docId, "OFFER_ACCEPTANCE");
      }
    } else if (row.docType === "APPOINTMENT_LETTER") {
      const letter = await prisma.appointmentLetter.findUnique({ where: { offerId: row.docId } });
      if (letter && !["ACCEPTED", "DECLINED"].includes(letter.status)) {
        await prisma.appointmentLetter.update({ where: { offerId: row.docId }, data: { status: "ACCEPTED" } });
        await completeStageByType(row.docId, "APPOINTMENT_ACCEPTANCE");
      }
    } else if (row.docType === "SERVICE_AGREEMENT") {
      const agreement = await prisma.serviceAgreement.findUnique({ where: { offerId: row.docId } });
      if (agreement && !["ACCEPTED", "DECLINED"].includes(agreement.status)) {
        await prisma.serviceAgreement.update({ where: { offerId: row.docId }, data: { status: "ACCEPTED" } });
      }
      // A Contractor has no separate Offer Letter — the Service Agreement IS the document that
      // was "sent" (Offer.status SENT), so signing it digitally is also the Offer's own
      // acceptance. Without this, "Record Candidate Acceptance" would still sit there needing a
      // manual click even though the candidate already confirmed electronically.
      const offer = await prisma.offer.findUnique({ where: { id: row.docId } });
      if (offer?.status === "SENT") {
        await prisma.offer.update({ where: { id: row.docId }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptanceMethod: "ADOBE_SIGN" } });
        await prisma.offerAuditLog.create({ data: { offerId: row.docId, action: "ACCEPT", fromStatus: "SENT", toStatus: "ACCEPTED", note: "Service Agreement signed via Adobe Sign" } }).catch(() => {});
        // Was missing (unlike the OFFER/APPOINTMENT_LETTER branches above) — without this, the
        // OFFER_ACCEPTANCE stage never reaches COMPLETED for a Contractor's e-signed Service
        // Agreement, so the wizard stayed stuck on Stage 2 and Document Collection/IT
        // Provisioning never unlocked, even though the offer itself had already moved to ACCEPTED.
        // Skipped for a collapsed workflow (Intern) with no own acceptance stage — see the OFFER
        // branch's comment above; HR's explicit acknowledge-acceptance click completes it instead.
        await ensureOfferPinnedToWorkflow(row.docId);
        if (await offerHasOwnAcceptanceStage(row.docId)) await completeStageByType(row.docId, "OFFER_ACCEPTANCE");
      }
    } else if (row.docType === "MSA" || row.docType === "SOW") {
      // US/Canada Vendor/Contractor engagement: both MSA and SOW must be signed before the
      // "Agreement & Signature" stage completes and Stage 3 (Onboarding Activation) unlocks.
      const [msa, sow] = await Promise.all([
        prisma.esignAgreement.findUnique({ where: { docType_docId: { docType: "MSA", docId: row.docId } } }),
        prisma.esignAgreement.findUnique({ where: { docType_docId: { docType: "SOW", docId: row.docId } } }),
      ]);
      const otherSigned = row.docType === "MSA" ? sow?.status === "SIGNED" : msa?.status === "SIGNED";
      if (otherSigned) await completeStageByType(row.docId, "AGREEMENT_SIGNATURE");
    }
    if (mailEnabled()) {
      const subject = row.docType === "TEST" ? "Adobe Sign test document signed" : `Signed: ${row.docType.replace("_", " ")}`;
      const html = `The ${docLabel} for signer ${row.signerEmail} has been signed via Adobe Sign. Preview it in the app.`;
      for (const to of recipients) { try { await notifyMail("ADOBE_SIGN_SIGNED_NOTICE", { fromUpn: "hr@genaquarius.com", to, subject, html }); } catch { /* one bad recipient shouldn't block */ } }
    }
  } else {
    await prisma.esignAgreement.update({ where: { id: row.id }, data: { status: "DECLINED" } });
    if (row.docType === "OFFER") {
      const offer = await prisma.offer.findUnique({ where: { id: row.docId } });
      if (offer && ["SENT", "GENERATED", "PREVIEWED"].includes(offer.status)) {
        await prisma.offer.update({ where: { id: row.docId }, data: { status: "DECLINED" } });
        await prisma.offerAuditLog.create({ data: { offerId: row.docId, action: "DECLINED", fromStatus: offer.status, toStatus: "DECLINED", note: "Declined via Adobe Sign" } }).catch(() => {});
      }
    } else if (row.docType === "APPOINTMENT_LETTER") {
      const letter = await prisma.appointmentLetter.findUnique({ where: { offerId: row.docId } });
      if (letter && !["ACCEPTED", "DECLINED"].includes(letter.status)) {
        await prisma.appointmentLetter.update({ where: { offerId: row.docId }, data: { status: "DECLINED" } });
      }
    } else if (row.docType === "SERVICE_AGREEMENT") {
      const agreement = await prisma.serviceAgreement.findUnique({ where: { offerId: row.docId } });
      if (agreement && !["ACCEPTED", "DECLINED"].includes(agreement.status)) {
        await prisma.serviceAgreement.update({ where: { offerId: row.docId }, data: { status: "DECLINED" } });
      }
      // Same reasoning as the signed branch above — the Service Agreement IS the Contractor's
      // "sent" document, so declining it digitally is also the Offer's own decline.
      const offer = await prisma.offer.findUnique({ where: { id: row.docId } });
      if (offer && ["SENT", "GENERATED", "PREVIEWED"].includes(offer.status)) {
        await prisma.offer.update({ where: { id: row.docId }, data: { status: "DECLINED" } });
        await prisma.offerAuditLog.create({ data: { offerId: row.docId, action: "DECLINED", fromStatus: offer.status, toStatus: "DECLINED", note: "Service Agreement declined via Adobe Sign" } }).catch(() => {});
      }
    }
    if (mailEnabled()) {
      const subject = row.docType === "TEST" ? "Adobe Sign test document declined" : `Declined: ${row.docType.replace("_", " ")}`;
      const html = `The ${docLabel} for signer ${row.signerEmail} was declined via Adobe Sign. You can resend it (Delete / Send Again) once ready.`;
      for (const to of recipients) { try { await notifyMail("ADOBE_SIGN_DECLINED_NOTICE", { fromUpn: "hr@genaquarius.com", to, subject, html }); } catch { /* one bad recipient shouldn't block */ } }
    }
  }
  // Push the fresh row to anyone watching this document in real time (EsignPanel) or the HR
  // Dashboard's live activity feed — no polling needed on the client.
  const fresh = await prisma.esignAgreement.findUnique({ where: { id: row.id } });
  if (fresh) emitEsignUpdate(fresh.docType, fresh.docId, fresh);
}

adobeSignWebhookRouter.post("/webhook", async (req, res) => {
  const clientIdHeader = req.header("X-AdobeSign-ClientId");
  if (clientIdHeader) res.set("X-AdobeSign-ClientId", clientIdHeader);
  res.status(200).json({ received: true }); // ack immediately; Adobe retries on non-2xx
  try {
    const event = req.body || {};
    const agreementId: string | undefined = event?.agreement?.id || event?.agreementId;
    if (!agreementId) return;
    const row = await prisma.esignAgreement.findFirst({ where: { agreementId } });
    if (!row) return;
    await reconcileAgreement(row);
  } catch (e) {
    // Already acked to Adobe (200 was sent above) — this is our own processing failing after the
    // fact. Logging it (instead of a bare swallow) is what let us catch the earlier silent
    // "signed document never showed up in the app" gap — check App Service logs if this recurs.
    console.error("Adobe Sign webhook processing failed:", e);
  }
});
