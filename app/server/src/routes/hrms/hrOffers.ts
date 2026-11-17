// HR operations — Dashboard, Offer generation/lifecycle, Appointment Letters, Confirm Joining.
// Visible to HR, CEO, CTO (HR_OPS_ROLES) — never FINANCE (settings-only) or PROJECT_MANAGER/EMPLOYEE.
import { Router } from "express";
import { Writable } from "stream";
import { prisma } from "../../prisma";
import { requireRole, HR_OPS_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { detectBracket, computeSalaryBreakup, computeTax, nextOfferRef, nextEmpNo, nextContractorCode, computeContractorPay, computeCompensation, computeEngagementComp, engagementDocVars, offerEngagementComp, amountToWordsIndia, fillTemplate, ensureBenchProject, buildCtcComponentsFromBreakup, getHrSignature, buFirst } from "../../engine/hr";
import { renderOfferPdf, renderAppointmentPdf, renderServiceAgreementPdf, renderInternshipLetterPdf, renderMsaSowPdf, renderToBuffer, ServiceAgreementClause } from "../../engine/hrPdf";
import { mailEnabled, sendMail } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { requireStageUnlocked, completeStageByType, ensureOfferPinnedToWorkflow, unmetMandatoryOfferFields, resolveRequiredDocuments, getFunnelCounts, resolveOfferFieldConfig, getOfferStageStatus, resolveStageFieldConfig, resolveCustomFieldsForStage, applyCustomFieldValues, getPublishedWorkflow, workflowBucketFor } from "../../engine/workflow";
import { fmtDate } from "../../engine/dateFormat";
import crypto from "crypto";
import { config } from "../../config";
import { emitEsignUpdate, emitHelpdeskUpdate, emitAttention } from "../../engine/realtime";
import { voidInFlightAgreements } from "../../engine/adobeSign";
import { itAdminEmails } from "../../engine/itAdmin";
import { fiscalOfDate } from "../../engine/workdays";
import { createMonthlyLine } from "../finance/monthly";
import { cleanUanPf } from "../../engine/uanPf";

// Find (or seed) the MonthlySheet that a given calendar date falls in, creating the FiscalYear
// row too if this is the first time that year is touched — mirrors fiscalYear.ts's own seeding,
// but only the ONE month actually needed here rather than all 12. Reused by ctcApprovals.ts
// once Finance approves a pending request.
export async function ensureSheetForDate(date: Date) {
  const { fiscalYear, monthIndex, month } = fiscalOfDate(date);
  await prisma.fiscalYear.upsert({ where: { label: fiscalYear }, update: {}, create: { label: fiscalYear, startMonth: 4, status: "OPEN" } });
  return prisma.monthlySheet.upsert({
    where: { fiscalYear_month: { fiscalYear, month } },
    update: {},
    create: { fiscalYear, month, monthIndex, status: "DRAFT" },
  });
}

// INTERN reuses the exact same Service-Agreement-only onboarding path as CONTRACTOR (no Offer
// Letter, no Appointment Letter — one document, Generated -> Sent -> Accepted -> Joined) per the
// user's explicit "use SLA flow but design much simpler onboard flow" choice, rather than a third
// parallel document/stage system. Every gate that used to check employmentType === "CONTRACTOR"
// to mean "this offer only ever gets a Service Agreement" now checks this instead.
const usesServiceAgreement = (et?: string | null) => et === "CONTRACTOR" || et === "INTERN";

const router = Router();
router.use(requireRole(...HR_OPS_ROLES));
// Additive dynamic gate on top of the static role check above — a CTO can further disable
// "hr-offers" for a whole role via the Module Access Matrix without touching this file.
router.use(requirePermission("hr-offers"));

const money = (n: number, ccy = "INR") => (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹") + Math.round(n || 0).toLocaleString("en-IN");
// "Rs 45,000/-" — the Service Agreement's own amount format (matches the real reference document
// exactly), distinct from money()'s "₹" symbol used by the Offer/Appointment letters.
const rsAmount = (n: number) => `Rs ${Math.round(n || 0).toLocaleString("en-IN")}/-`;
const firstName = (s: string) => String(s || "").trim().split(/\s+/)[0] || s;
const dstr = fmtDate;
// Section 1.1 — First/Middle/Last are the only candidate-name fields HR actually fills in; the
// single `candidateName` column every PDF/email/list template already keys off is always derived
// from these, never accepted directly from client input.
const composeFullName = (first?: string | null, middle?: string | null, last?: string | null) =>
  [first, middle, last].map((s) => String(s || "").trim()).filter(Boolean).join(" ");

const OFFER_INCLUDE = { businessUnit: true, versions: { orderBy: { versionNo: "asc" as const } }, appointmentLetter: true, serviceAgreement: true, itProvisioningRequest: true, auditLogs: { orderBy: { at: "desc" as const } }, documents: { select: { docType: true, label: true, fileName: true, uploadedAt: true } } };

// Offer/Appointment/Service Agreement each move to ACCEPTED/DECLINED either automatically (the
// candidate e-signed or declined via Adobe Sign — see reconcileAgreement in routes/adobeSign.ts)
// or manually (HR confirms what came back over email). Surfaced everywhere as one small
// {status, method} badge so Offers & Lifecycle, the Confirm Joining queue and the Offer Detail
// screen all show the same "Accepted (Digital)" / "Accepted (Email)" / "Declined" / "Pending"
// story instead of each guessing it from raw status strings independently.
type AcceptanceBadge = { status: "PENDING" | "ACCEPTED" | "DECLINED"; method: "ADOBE_SIGN" | "EMAIL" | null };
function acceptanceBadge(rawStatus: string | undefined, esignRow: { status: string } | undefined, opts?: { accepted?: boolean; method?: string | null }): AcceptanceBadge {
  const status: AcceptanceBadge["status"] = opts?.accepted ? "ACCEPTED" : rawStatus === "DECLINED" ? "DECLINED" : rawStatus === "ACCEPTED" ? "ACCEPTED" : "PENDING";
  if (status === "PENDING") return { status, method: null };
  const method: AcceptanceBadge["method"] = opts?.method
    ? (opts.method === "ADOBE_SIGN" ? "ADOBE_SIGN" : "EMAIL")
    : esignRow && ["SIGNED", "DECLINED"].includes(esignRow.status) ? "ADOBE_SIGN" : "EMAIL";
  return { status, method };
}
async function withAcceptanceBadges<T extends { id: number; status: string; acceptedAt?: Date | null; acceptanceMethod?: string | null; appointmentLetter?: { status: string } | null; serviceAgreement?: { status: string } | null }>(offers: T[]) {
  const ids = offers.map((o) => o.id);
  const esignRows = ids.length ? await prisma.esignAgreement.findMany({ where: { docId: { in: ids }, docType: { in: ["OFFER", "APPOINTMENT_LETTER", "SERVICE_AGREEMENT"] } } }) : [];
  const esignByKey = new Map(esignRows.map((r) => [`${r.docType}:${r.docId}`, r]));
  return offers.map((o) => ({
    ...o,
    // `acceptedAt`/`acceptanceMethod` are used (not raw offer.status) because a Contractor's
    // offer.status is reused afterward for the Service Agreement's own GENERATED/PREVIEWED/SENT
    // lifecycle — raw status alone would wrongly read back as "still pending" once that reuse
    // happens, even though the Offer itself was genuinely accepted earlier.
    offerAcceptance: acceptanceBadge(o.status, esignByKey.get(`OFFER:${o.id}`), { accepted: !!o.acceptedAt, method: o.acceptanceMethod }),
    appointmentAcceptance: o.appointmentLetter ? acceptanceBadge(o.appointmentLetter.status, esignByKey.get(`APPOINTMENT_LETTER:${o.id}`)) : null,
    serviceAgreementAcceptance: o.serviceAgreement ? acceptanceBadge(o.serviceAgreement.status, esignByKey.get(`SERVICE_AGREEMENT:${o.id}`)) : null,
  }));
}

function activeVersionOf(offer: any) {
  return offer.versions?.find((v: any) => v.versionNo === offer.activeVersion) || offer.versions?.[offer.versions.length - 1] || null;
}

export async function audit(offerId: number, byUserId: number | undefined, action: string, fromStatus: string | null, toStatus: string | null, note?: string) {
  await prisma.offerAuditLog.create({ data: { offerId, byUserId, action, fromStatus, toStatus, note } }).catch(() => {});
}

// If HR rejects/cancels/declines an onboarding that already has a "Send to IT" request sitting in
// IT Admin's Pending Tasks queue, that task must not just sit there — IT Admin has no way to know
// the hire fell through, and could go ahead and provision a mailbox/laptop for someone who was
// never hired. Only removes it while it's still genuinely PENDING (emailCreatedAt null) — once IT
// Admin has already approved it, the offer can no longer reach any of these termination paths
// anyway (they all require no Employee/JOINING_CONFIRMED yet, and Approve only ever runs after
// Confirm Joining's own itReq.sentAt gate).
async function cancelPendingItProvisioning(offerId: number, reason: string, byUserId: number, byUserEmail?: string) {
  const reqRow = await prisma.itProvisioningRequest.findUnique({ where: { offerId }, include: { offer: { select: { candidateName: true } } } });
  if (!reqRow || reqRow.emailCreatedAt) return;
  await prisma.itProvisioningRequest.delete({ where: { offerId } });
  await audit(offerId, byUserId, "IT_PROVISIONING_CANCELLED", null, null, `Pending IT provisioning task cancelled — ${reason}`);
  emitHelpdeskUpdate("it_provisioning_cancelled", { offerId });
  if (mailEnabled()) {
    const recipients = await itAdminEmails();
    const subject = `IT provisioning cancelled: ${reqRow.offer.candidateName}`;
    const html = `Hi,<br><br>The pending IT provisioning request for <b>${reqRow.offer.candidateName}</b> has been cancelled — ${reason} — and removed from your Pending Tasks.<br><br>No action needed — please do not proceed with setting up their laptop or email account.<br><br>Regards,<br>GenAquarius HR`;
    for (const to of recipients) { try { await notifyMail("IT_PROVISIONING_CANCELLED", { fromUpn: byUserEmail || "hr@genaquarius.com", to, subject, html }); } catch { /* one bad recipient shouldn't block the rest */ } }
  }
}

// Closes the loop on the User<->Employee link regardless of which stage order HR has configured
// (IT Provisioning before Employee Activation is the default, but either can run first).
// IT Admin's Approve creates the login the moment the O365 mailbox exists — at that point, if
// Activation hasn't run yet, there's no Employee to link to, so it's created with employeeId
// null. This runs the OTHER direction: the instant this Employee record is created, look for a
// User already sitting there unlinked with the matching email (checked against the IT
// Provisioning Request's real O365 email first — Employee.email is routinely null/unreliable in
// this data, see the Reporting Manager fix — falling back to Employee.email itself) and link it.
// Without this, "Confirm Joining" running after "IT Admin Approve" (the default order) leaves
// every new hire's login permanently unlinked until someone notices and fixes it by hand.
async function linkUserToEmployee(offerId: number, employeeId: number, employeeEmail: string | null) {
  const itReq = await prisma.itProvisioningRequest.findUnique({ where: { offerId }, select: { emailIdToCreate: true } });
  const candidateEmails = [itReq?.emailIdToCreate, employeeEmail].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  for (const email of candidateEmails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.employeeId) {
      await prisma.user.update({ where: { id: user.id }, data: { employeeId } });
      return;
    }
  }
}

// Renders any of the three signable HR documents to a PDF Buffer, keyed by the SAME Offer
// record all three hang off of — reused by this file's own PDF/email routes AND by
// routes/adobeSign.ts's "send for signature" flow, so Adobe always gets byte-identical content
// to what HR already previewed. offerId is Offer.id in every case (AppointmentLetter/
// ServiceAgreement are 1:1 with it), NOT AppointmentLetter.id/ServiceAgreement.id.
export async function renderDocPdfBuffer(docType: "OFFER" | "APPOINTMENT_LETTER" | "SERVICE_AGREEMENT", offerId: number): Promise<{ buffer: Buffer; fileName: string; signerEmail: string; signerName: string }> {
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: OFFER_INCLUDE });
  if (!offer) throw new Error("Offer not found");
  const signerEmail = offer.candidateEmail, signerName = offer.candidateName;
  if (docType === "OFFER") {
    const version = activeVersionOf(offer);
    if (!version) throw new Error("Generate the offer first.");
    const tpl = version.offerTemplateId ? await prisma.hrOfferTemplate.findUnique({ where: { id: version.offerTemplateId } }) : null;
    const body = fillTemplate(tpl?.bodyText || "Dear {{CandidateFirstName}},\n\nWe are pleased to offer you the position of {{Role}}.", {
      CandidateFirstName: firstName(offer.candidateName), Role: offer.role, Designation: offer.designation,
      OfferRef: offer.offerRef, ProposedJoiningDate: dstr(offer.proposedJoiningDate) || "To be confirmed",
      Business: offer.businessUnit?.name || "", Ctc: money(offer.ctc, offer.countryCode === "US" ? "USD" : offer.countryCode === "CANADA" ? "CAD" : "INR"),
      ...(offer.countryCode && offer.countryCode !== "INDIA" ? engagementDocVars(offer) : {}),
    });
    const sig = await getHrSignature(offer.businessUnitId);
    const buffer = await renderToBuffer((out) => renderOfferPdf({ offerRef: offer.offerRef, candidateName: offer.candidateName, role: offer.role, designation: offer.designation, ctc: offer.ctc, offerDate: offer.offerDate, proposedJoiningDate: offer.proposedJoiningDate, businessName: offer.businessUnit?.name, countryCode: offer.countryCode, reportingManager: offer.reportingManager, probationPeriod: offer.probationPeriod, noticePeriod: offer.noticePeriod, acceptanceDeadline: offer.acceptanceDeadline, documentChecklist: offer.documentChecklist as any, phone: offer.candidatePhone, templateBody: body, breakup: version.salaryBreakup as any, ...sig }, out));
    return { buffer, fileName: `Offer_${offer.offerRef}.pdf`, signerEmail, signerName };
  }
  if (docType === "APPOINTMENT_LETTER") {
    const appt = await prisma.appointmentLetter.findUnique({ where: { offerId } });
    if (!appt) throw new Error("Appointment letter not found — generate it first.");
    const sig = await getHrSignature(offer.businessUnitId);
    const buffer = await renderToBuffer((out) => renderAppointmentPdf({ empNo: appt.empNo, dynamicFields: appt.dynamicFields as any, clauses: appt.clauses as any, ...sig }, out));
    return { buffer, fileName: `Appointment_${appt.empNo}.pdf`, signerEmail, signerName };
  }
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId } });
  if (!sa) throw new Error("Service Agreement not found — generate it first.");
  const sig = await getHrSignature(offer.businessUnitId);
  const buffer = await renderToBuffer((out) => renderServiceAgreementPdf({ dynamicFields: sa.dynamicFields as any, clauses: sa.clauses as any as ServiceAgreementClause[], ...sig }, out));
  return { buffer, fileName: `ServiceAgreement_${offerId}.pdf`, signerEmail, signerName };
}

// ---- MSA / SOW (US/Canada Vendor/Contractor engagements) — reuses the same per-BU signatory as
// the other documents (getHrSignature) but is NOT part of the Offer/AppointmentLetter/
// ServiceAgreement trio: it's generated directly from Offer's own vendor/engagement fields +
// MsaTemplate/SowTemplate (one row per Business Unit), with no separate lifecycle-status model of
// its own — EsignAgreement(docType:"MSA"|"SOW", docId: offerId) + Attachment(entityType:
// "ESIGN_MSA"|"ESIGN_SOW") already cover status + stored signed copy, same convention as the three
// documents above.
async function msaSowTemplateFor(docType: "MSA" | "SOW", businessUnitId: number | null) {
  const model = docType === "MSA" ? prisma.msaTemplate : prisma.sowTemplate;
  return (await buFirst(businessUnitId, (bu) => (model as any).findFirst({ where: { isDefault: true, ...bu } })))
    || (await (model as any).findFirst({ where: { isDefault: true } }))
    || (await (model as any).findFirst());
}

export async function renderMsaOrSowPdfBuffer(docType: "MSA" | "SOW", offerId: number): Promise<{ buffer: Buffer; fileName: string; signerEmail: string; signerName: string }> {
  const offer = await prisma.offer.findUnique({ where: { id: offerId } });
  if (!offer) throw new Error("Offer not found");
  if (!offer.vendorName) throw new Error(`This offer has no Vendor/Service Provider captured — ${docType} only applies to Vendor/Contractor engagements.`);
  const tpl: any = await msaSowTemplateFor(docType, offer.businessUnitId);
  if (!tpl) throw new Error(`No ${docType === "MSA" ? "MSA" : "SOW"} Template configured for this Business Unit yet (HR Settings).`);
  const sig = await getHrSignature(offer.businessUnitId);
  const vars = {
    EntityName: tpl.entityName, EntityAddress: tpl.entityAddress || "", GoverningLaw: docType === "MSA" ? (tpl as any).governingLaw || "" : "",
    VendorName: offer.vendorName, VendorEin: offer.vendorEin || "", VendorAddress: offer.vendorAddress || "",
    EffectiveDate: offer.proposedJoiningDate || offer.offerDate, ConsultantName: offer.candidateName,
    StartDate: offer.proposedJoiningDate, ClientName: offer.endClientName || "",
    ...engagementDocVars(offer), EngagementDescription: offer.engagementDescription || "",
  };
  const body = fillTemplate(tpl.bodyText || "", vars);
  const buffer = await renderToBuffer((out) => renderMsaSowPdf({
    title: docType === "MSA" ? "MASTER SERVICES AGREEMENT" : "STATEMENT OF WORK",
    entityName: tpl.entityName, bodyText: body, counterpartyName: offer.vendorName!,
    entitySignerName: sig.signatoryName, entitySignerTitle: sig.signatoryTitle, signatureImageBase64: sig.signatureImageBase64,
  }, out));
  return { buffer, fileName: `${docType}_${offer.offerRef}.pdf`, signerEmail: offer.candidateEmail, signerName: offer.candidateName };
}

// Preview (no send, no status change) — GET so it can open directly in a browser tab/new window,
// same as the existing Offer/Appointment preview-pdf pattern.
router.get("/offers/:id/preview/:docType", async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  if (docType !== "MSA" && docType !== "SOW") return res.status(400).json({ error: "Unknown document type" });
  try {
    const { buffer, fileName } = await renderMsaOrSowPdfBuffer(docType, Number(req.params.id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.send(buffer);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Email the generated MSA/SOW as a PDF attachment — distinct from "Send for Digital Signature"
// (Adobe Sign, routes/shared/adobeSign.ts): this is a plain informational/for-review send, sent
// from the requesting HR user's own mailbox, never auto-advancing any stage/status.
router.post("/offers/:id/email/:docType", async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  if (docType !== "MSA" && docType !== "SOW") return res.status(400).json({ error: "Unknown document type" });
  const to = String(req.body?.to || "").trim();
  if (!to) return res.status(400).json({ error: "Recipient email is required" });
  if (!mailEnabled()) return res.status(400).json({ error: "Email sending is not configured (Microsoft Graph)." });
  try {
    const { buffer, fileName } = await renderMsaOrSowPdfBuffer(docType, Number(req.params.id));
    await sendMail({
      fromUpn: req.user!.email, to,
      subject: `${docType === "MSA" ? "Master Services Agreement" : "Statement of Work"} — ${fileName.replace(/\.pdf$/, "")}`,
      html: `Please find attached the ${docType === "MSA" ? "Master Services Agreement" : "Statement of Work"} for your review.<br><br>Regards,<br>GenAquarius`,
      attachments: [{ name: fileName, contentType: "application/pdf", contentBytes: buffer.toString("base64") }],
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Manual "Upload Signed Copy" fallback (wet-signed or externally-signed file HR already has) —
// same convention as /offers/:id/signed-offer, generalized to MSA/SOW and storing into the
// generic Attachment table (entityType ESIGN_MSA|ESIGN_SOW) rather than new Offer columns, so a
// manual upload and an Adobe Sign completion end up in the exact same place.
router.post("/offers/:id/signed/:docType", async (req, res) => {
  const docType = req.params.docType.toUpperCase();
  if (docType !== "MSA" && docType !== "SOW") return res.status(400).json({ error: "Unknown document type" });
  const offerId = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData are required" });
  const offer = await prisma.offer.findUnique({ where: { id: offerId } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  await prisma.attachment.create({ data: { entityType: `ESIGN_${docType}`, entityId: offerId, fileName, fileData, note: "Manually uploaded signed copy", uploadedById: req.user!.id } });
  await prisma.esignAgreement.upsert({
    where: { docType_docId: { docType, docId: offerId } },
    update: { status: "SIGNED", signedAt: new Date(), confirmedAt: new Date(), confirmedById: req.user!.id },
    create: { docType, docId: offerId, agreementId: `MANUAL-${Date.now()}`, signerEmail: offer.candidateEmail, status: "SIGNED", signedAt: new Date(), confirmedAt: new Date(), confirmedById: req.user!.id, createdById: req.user!.id },
  });
  // Same "both MSA and SOW signed" gate the Adobe Sign webhook uses (routes/shared/adobeSign.ts) —
  // a manual upload of the second-to-complete document must advance the stage exactly the same way.
  const otherType = docType === "MSA" ? "SOW" : "MSA";
  const other = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType: otherType, docId: offerId } } });
  if (other?.status === "SIGNED") await completeStageByType(offerId, "AGREEMENT_SIGNATURE");
  emitEsignUpdate(docType, offerId, { status: "SIGNED" });
  res.json({ ok: true });
});

// Lightweight project list for the Confirm Joining project picker — masters.ts's /projects is
// requireAdmin-only (Finance/CEO/CTO/QA), which HR is deliberately not part of, so HR needs its
// own minimal read here rather than being added to ADMIN_ROLES.
router.get("/projects", async (_req, res) => {
  // currency included so CAD-aware rate inputs (CtcApprovals.tsx) can tell a CAD-billed project
  // apart from a USD one — omitted before, which silently made every project look non-CAD there.
  res.json(await prisma.project.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true, currency: true }, orderBy: { name: "asc" } }));
});

// ------------------------------------------------------------------ Dashboard ----
router.get("/dashboard", async (_req, res) => {
  const [totalEmployees, activeEmployees, offers, benchProject] = await Promise.all([
    prisma.employee.count({ where: { noCostToCompany: false } }),
    prisma.employee.count({ where: { exitDate: null, noCostToCompany: false } }),
    prisma.offer.findMany({ select: { status: true, ctcRejectedAt: true, employeeId: true, employmentType: true, appointmentLetter: { select: { status: true } } } }),
    ensureBenchProject().catch(() => null),
  ]);

  const now = new Date();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const endNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const [newJoiners, joiningNextMonth, onBench] = await Promise.all([
    prisma.employee.count({ where: { joiningDate: { gte: startMonth, lt: startNextMonth } } }),
    prisma.employee.count({ where: { joiningDate: { gte: startNextMonth, lt: endNextMonth } } }),
    benchProject ? prisma.employeeProject.count({ where: { projectId: benchProject.id } }) : Promise.resolve(0),
  ]);

  const c = (pred: (s: string) => boolean) => offers.filter((o) => pred(o.status) && !o.ctcRejectedAt).length;
  // Offer/Appointment/Joining chart (client Bar widget) needs Employee vs Contractor separated —
  // Contractor has no Appointment step at all (SLA flow: Generated -> Sent -> Accepted -> Joined),
  // so a combined count previously made that bar chart mix the two incompatible flows together.
  const empOffers = offers.filter((o) => !usesServiceAgreement(o.employmentType));
  const contractorOffers = offers.filter((o) => usesServiceAgreement(o.employmentType));
  const cEmp = (pred: (s: string) => boolean) => empOffers.filter((o) => pred(o.status) && !o.ctcRejectedAt).length;
  const cSla = (pred: (s: string) => boolean) => contractorOffers.filter((o) => pred(o.status) && !o.ctcRejectedAt).length;
  const kpi = {
    totalEmployees, activeEmployees, newJoiners, joiningNextMonth,
    deployedOnProjects: Math.max(0, activeEmployees - onBench),
    onBench,
    offersGenerated: c((s) => s !== "DRAFT"),
    offersSent: c((s) => ["SENT", "ACCEPTED", "DECLINED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"].includes(s)),
    offersPendingAcceptance: c((s) => s === "SENT"),
    offersAccepted: c((s) => ["ACCEPTED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"].includes(s)),
    // Excludes anything Finance has rejected the CTC for — those sit at the SAME raw status
    // (ACCEPTED for a Contractor, APPOINTMENT_ISSUED for an Employee) since Confirm Joining
    // reverts to it on rejection, but "awaiting joining confirmation" is the wrong story for them
    // (they were already confirmed once and bounced back) — see `ctcRejected` below instead.
    appointmentPending: c((s) => s === "ACCEPTED"),
    appointmentGenerated: c((s) => ["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(s)),
    appointmentIssued: c((s) => s === "APPOINTMENT_ISSUED"),
    awaitingJoiningConfirmation: c((s) => s === "APPOINTMENT_ISSUED"),
    // employeeId (not status) is the durable "activated" signal — status keeps advancing through
    // APPOINTMENT_* after activation when Appointment is configured to run after Employee
    // Activation (the default order — see engine/workflow.ts). See also /funnel below for the
    // full, workflow-driven stage breakdown (Sections 11-13/21-22).
    joined: offers.filter((o) => !!o.employeeId && !o.ctcRejectedAt).length,
    declined: c((s) => s === "DECLINED"), expired: c((s) => s === "EXPIRED"),
    withdrawn: c((s) => s === "WITHDRAWN"), cancelled: c((s) => s === "CANCELLED"),
    ctcRejected: offers.filter((o) => !!o.ctcRejectedAt).length,
    // Employee-only breakdown for the "Offer / Appointment / Joining" chart's Offer series.
    empGenerated: cEmp((s) => s !== "DRAFT"),
    empSent: cEmp((s) => ["SENT", "ACCEPTED", "DECLINED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"].includes(s)),
    empAccepted: cEmp((s) => ["ACCEPTED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"].includes(s)),
    empAppointmentGenerated: cEmp((s) => ["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(s)),
    empAppointmentIssued: cEmp((s) => s === "APPOINTMENT_ISSUED"),
    empJoined: empOffers.filter((o) => !!o.employeeId && !o.ctcRejectedAt).length,
    // AppointmentLetter.status is the durable "candidate confirmed the appointment" signal (set
    // either by an Adobe Sign completion or HR's manual "Confirm Acceptance" for the plain-email
    // path) — read off that relation rather than Offer.status, since Offer.status keeps advancing
    // past it (to JOINING_CONFIRMED) once Confirm Joining runs, which would otherwise make this
    // count drop back to 0 for every already-joined employee.
    empAppointmentAccepted: empOffers.filter((o) => o.appointmentLetter?.status === "ACCEPTED" && !o.ctcRejectedAt).length,
    // Contractor/SLA breakdown for the same chart's SLA series — no Appointment step at all.
    slaGenerated: cSla((s) => s !== "DRAFT"),
    slaSent: cSla((s) => ["SENT", "ACCEPTED", "DECLINED", "JOINING_CONFIRMED"].includes(s)),
    slaAccepted: cSla((s) => ["ACCEPTED", "JOINING_CONFIRMED"].includes(s)),
    slaJoined: contractorOffers.filter((o) => !!o.employeeId && !o.ctcRejectedAt).length,
  };
  const pendingHrActions = kpi.appointmentPending + kpi.appointmentGenerated + kpi.appointmentIssued;
  res.json({ ...kpi, pendingHrActions, note: "Attendance / project-release KPIs are not included yet — this build has no Attendance module in the schema; Timesheet is a separate feature." });
});

// Workflow-driven Offer/Appointment/Joining funnel (Sections 11-13/21-22) — stage order and
// membership come entirely from whatever's PUBLISHED (engine/workflow.ts), not a fixed list here.
router.get("/dashboard/funnel", async (req, res) => {
  res.json(await getFunnelCounts(String(req.query.employmentType || "EMPLOYEE")));
});

// Drill-down behind each clickable Dashboard tile — same filtering logic as the counts above,
// returned as an actual row list (name / employee ID / joining date / project / status) instead
// of just a number.
router.get("/dashboard/drilldown", async (req, res) => {
  const kind = String(req.query.kind || "");
  const now = new Date();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const endNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const empRow = (e: any, extra?: any) => ({ id: e.id, name: e.name, empNo: e.empNo, joiningDate: e.joiningDate, exitDate: e.exitDate, location: e.location, empType: e.empType, ...extra });
  const empSelect = { id: true, name: true, empNo: true, joiningDate: true, exitDate: true, location: true, empType: true, projects: { select: { project: { select: { name: true } } } } } as const;
  const withProject = (e: any) => empRow(e, { project: e.projects?.map((p: any) => p.project.name).join(", ") || "—" });

  switch (kind) {
    case "totalEmployees": {
      const rows = await prisma.employee.findMany({ select: empSelect, orderBy: { name: "asc" } });
      return res.json({ title: "Total Employees", rows: rows.map(withProject) });
    }
    case "activeEmployees": {
      const rows = await prisma.employee.findMany({ where: { exitDate: null }, select: empSelect, orderBy: { name: "asc" } });
      return res.json({ title: "Active Employees", rows: rows.map(withProject) });
    }
    case "onBench": {
      // Read-only drill-down — matches the SAME canonical bench project ensureBenchProject() uses
      // (now "GenAquarius (Bench)"), without its side effect of creating one if none exists yet.
      const bench = await prisma.project.findFirst({ where: { OR: [{ name: "Bench" }, { name: { endsWith: "(Bench)" } }] } });
      const rows = bench ? await prisma.employee.findMany({ where: { exitDate: null, projects: { some: { projectId: bench.id } } }, select: empSelect, orderBy: { name: "asc" } }) : [];
      return res.json({ title: "On Bench", rows: rows.map(withProject) });
    }
    case "deployedOnProjects": {
      const bench = await prisma.project.findFirst({ where: { OR: [{ name: "Bench" }, { name: { endsWith: "(Bench)" } }] } });
      const rows = await prisma.employee.findMany({
        where: { exitDate: null, projects: { some: bench ? { projectId: { not: bench.id } } : {} } },
        select: empSelect, orderBy: { name: "asc" },
      });
      return res.json({ title: "Deployed on Projects", rows: rows.map(withProject) });
    }
    case "newJoiners": {
      const rows = await prisma.employee.findMany({ where: { joiningDate: { gte: startMonth, lt: startNextMonth } }, select: empSelect, orderBy: { joiningDate: "asc" } });
      return res.json({ title: "New Joiners (MTD)", rows: rows.map(withProject) });
    }
    case "joiningNextMonth": {
      const rows = await prisma.employee.findMany({ where: { joiningDate: { gte: startNextMonth, lt: endNextMonth } }, select: empSelect, orderBy: { joiningDate: "asc" } });
      return res.json({ title: "Joining Next Month", rows: rows.map(withProject) });
    }
    case "ctcRejected": {
      const offers = await prisma.offer.findMany({
        where: { ctcRejectedAt: { not: null }, employeeId: null },
        select: { id: true, candidateName: true, reservedEmpNo: true, role: true, status: true, proposedJoiningDate: true, ctcRejectionNote: true },
        orderBy: { proposedJoiningDate: "asc" },
      });
      return res.json({
        title: "CTC Rejected by Finance — Needs Correction", isOffers: true,
        rows: offers.map((o) => ({ id: o.id, name: o.candidateName, empNo: o.reservedEmpNo, joiningDate: o.proposedJoiningDate, status: o.ctcRejectionNote || "Rejected — fix CTC and re-confirm joining", project: o.role })),
      });
    }
    case "pendingHrActions": {
      const offers = await prisma.offer.findMany({
        where: { status: { in: ["ACCEPTED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED"] } },
        select: { id: true, candidateName: true, reservedEmpNo: true, role: true, status: true, proposedJoiningDate: true },
        orderBy: { proposedJoiningDate: "asc" },
      });
      return res.json({
        title: "Pending HR Actions", isOffers: true,
        rows: offers.map((o) => ({ id: o.id, name: o.candidateName, empNo: o.reservedEmpNo, joiningDate: o.proposedJoiningDate, status: STATUS_LABEL_SERVER[o.status] || o.status, project: o.role })),
      });
    }
    default:
      return res.status(400).json({ error: "Unknown drilldown kind" });
  }
});
const STATUS_LABEL_SERVER: Record<string, string> = {
  ACCEPTED: "Accepted — appointment letter not generated", APPOINTMENT_GENERATED: "Appointment generated",
  APPOINTMENT_PREVIEWED: "Appointment previewed", APPOINTMENT_ISSUED: "Issued — awaiting joining confirmation",
};

// ------------------------------------------------------------------ Offers CRUD ----
router.get("/offers", async (req, res) => {
  const { status, q } = req.query as any;
  const where: any = {};
  if (status) where.status = status;
  if (q) where.OR = [{ candidateName: { contains: String(q) } }, { candidateEmail: { contains: String(q) } }, { offerRef: { contains: String(q) } }];
  const offers = await prisma.offer.findMany({
    where, orderBy: { createdAt: "desc" },
    include: { businessUnit: true, appointmentLetter: { select: { status: true, signedFileName: true } }, serviceAgreement: { select: { id: true, status: true, signedFileName: true } }, itProvisioningRequest: { select: { sentAt: true } }, employee: { select: { ctcApprovalRequest: { select: { status: true } }, noCostToCompany: true } } },
  });
  // Flattened onto the offer itself (not everyone who reads this list has permission on
  // /ctc-approvals) — Onboarding History uses this to show whether Finance has signed off yet.
  const withBadges = await withAcceptanceBadges(offers as any);
  // Whether Employee Activation is actually unlocked yet — workflow-engine-gated for EMPLOYEE
  // offers (Confirm Joining's "Awaiting Activation" queue used to just check status ===
  // APPOINTMENT_ISSUED, which never fires once Appointment is configured to run AFTER activation,
  // the new default order — see engine/workflow.ts). Computed only for rows that could plausibly
  // need it, to keep this list cheap for everyone else.
  const TERMINAL = ["DRAFT", "GENERATED", "PREVIEWED", "SENT", "DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"];
  const withActivation = await Promise.all(withBadges.map(async (o: any) => {
    const base = o.employeeId || usesServiceAgreement(o.employmentType) || TERMINAL.includes(o.status)
      ? { ...o, employeeActivationReady: null }
      : { ...o, employeeActivationReady: (await requireStageUnlocked(o.id, "EMPLOYEE_ACTIVATION")).ok };
    // Full stage progress (not just the current one) per the published Workflow & Stage
    // Configuration — Offers & Lifecycle renders every configured stage, in configured order and
    // with its configured name, exactly as HR set it up (not a guess from raw status).
    if (usesServiceAgreement(o.employmentType) || TERMINAL.includes(o.status)) return { ...base, currentStage: null, stages: [] };
    const stages = await getOfferStageStatus(o.id);
    const current = stages.find((s: any) => s.current);
    return {
      ...base,
      currentStage: current ? { key: current.key, name: current.name, stageType: current.stageType, order: current.order } : null,
      stages: stages.map((s: any) => ({ key: s.key, name: s.name, order: s.order, status: s.status, current: s.current })),
    };
  }));
  // Falls back to a synthesized "REJECTED" once the Employee/CtcApprovalRequest rows themselves
  // are gone (rejecting a CTC removes the Employee entirely — see ctcApprovals.ts /:id/reject) —
  // ctcRejectedAt on the Offer itself is the only enduring record of that at that point. A
  // Contractor/Intern activated as "No Cost to Company" never gets a CtcApprovalRequest at all —
  // see hrOffers.ts's own sa.noCostToCompany branch — so this used to fall all the way through to
  // null ("—" on Onboarding History), reading as if CTC approval were still outstanding when there
  // was never any cost to approve in the first place.
  res.json(withActivation.map((o: any) => ({ ...o, ctcApprovalStatus: o.employee?.ctcApprovalRequest?.status || (o.ctcRejectedAt ? "REJECTED" : (o.employee?.noCostToCompany ? "NO_COST_TO_COMPANY" : null)), employee: undefined })));
});

router.get("/offers/:id", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, include: OFFER_INCLUDE as any });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const [withBadges] = await withAcceptanceBadges([offer as any]);
  res.json({ ...withBadges, activeVersionData: activeVersionOf(offer) });
});

// Which fields even show up on Generate Offer, and which are required — config-driven (HR Settings
// -> Workflow & Stage Configuration), so the real form and its live preview there can never drift.
router.get("/offer-field-config", async (req, res) => {
  res.json(await resolveOfferFieldConfig(undefined, String(req.query.employmentType || "EMPLOYEE"), req.query.countryCode ? String(req.query.countryCode) : undefined));
});

// The real name/order of "Stage 1" as HR has it configured right now — Generate Offer's own page
// heading follows this exactly instead of a hardcoded "Generate Offer" label. Falls back to the
// first enabled stage of any of the three offer-generation-ish types if none is named OFFER_GENERATION.
router.get("/offer-generation-stage-name", async (req, res) => {
  const wf = await getPublishedWorkflow(workflowBucketFor({ employmentType: String(req.query.employmentType || "EMPLOYEE"), countryCode: req.query.countryCode ? String(req.query.countryCode) : undefined }));
  const stage = (wf?.stages || []).find((s: any) => s.enabled && ["OFFER_GENERATION", "DATA_COLLECTION", "CANDIDATE_INFO"].includes(s.stageType));
  res.json(stage ? { order: stage.order, name: stage.name } : null);
});

// Per-stage status for THIS offer, in configured order — "the exact stages and flow specified in
// Workflow & Stage Configuration" as the single thing every UI (Offer Detail's dynamic Current
// Stage panel, HR Dashboard funnel) reads instead of hardcoding its own sequence.
router.get("/offers/:id/stage-status", async (req, res) => {
  res.json(await getOfferStageStatus(Number(req.params.id)));
});

// Same idea as /offer-field-config, for the Appointment Generation / IT Provisioning / Confirm
// Joining-Employee Activation forms — each real form on its own stage type reads this instead of
// hardcoding which fields show up or are required, so Workflow & Stage Configuration genuinely
// drives every stage's real form, not just Offer Generation.
router.get("/offers/:id/stage-field-config/:stageType", async (req, res) => {
  res.json(await resolveStageFieldConfig(req.params.stageType, Number(req.params.id)));
});

// HR-defined Custom Fields (added purely from the Workflow Builder, no code change) — keyed by
// stage KEY, not stageType, since a workflow can have several Custom Stages each with their own.
router.get("/offers/:id/custom-fields/:stageKey", async (req, res) => {
  const id = Number(req.params.id);
  const [defs, offer] = await Promise.all([
    resolveCustomFieldsForStage(req.params.stageKey, id),
    prisma.offer.findUnique({ where: { id }, select: { customFields: true } }),
  ]);
  const values = (offer?.customFields as any) || {};
  res.json(defs.map((d) => ({ ...d, value: values[d.key] ?? "" })));
});
router.post("/offers/:id/custom-fields/:stageKey", async (req, res) => {
  const r = await applyCustomFieldValues(Number(req.params.id), req.params.stageKey, req.body?.values || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

// Bulk delete (Offers & Lifecycle multi-select) — refuses any offer whose employee is already
// active (JOINING_CONFIRMED created a real Employee row; deleting the offer must never orphan
// or silently disconnect that record). AppointmentLetter/ServiceAgreement/ItProvisioningRequest
// have no onDelete:Cascade to Offer (all `@unique offerId` FKs, RESTRICT by default), so they're
// deleted explicitly first; OfferVersion/OfferAuditLog cascade automatically.
router.post("/offers/bulk-delete", async (req, res) => {
  const ids: number[] = Array.isArray(req.body.ids) ? req.body.ids.map((n: any) => Number(n)).filter((n: number) => n > 0) : [];
  let deleted = 0, skipped = 0;
  for (const id of ids) {
    const offer = await prisma.offer.findUnique({ where: { id } });
    if (!offer || offer.employeeId) { skipped++; continue; }
    await prisma.$transaction([
      prisma.appointmentLetter.deleteMany({ where: { offerId: id } }),
      prisma.serviceAgreement.deleteMany({ where: { offerId: id } }),
      prisma.itProvisioningRequest.deleteMany({ where: { offerId: id } }),
      prisma.offer.delete({ where: { id } }),
    ]);
    deleted++;
  }
  res.json({ deleted, skipped });
});

// Delete from Onboarding History (multi-select on that page) — an active employee/contractor's
// history record is PERMANENT and must never be deletable (even though it's "just the paper
// trail" and the Employee row itself is never touched) — explicit instruction, since Onboarding
// History is the durable record of who was actually brought on. The only rows this endpoint will
// ever actually delete are CTC-rejected ones with no employeeId (the Employee row was already
// removed at rejection time — see ctcApprovals.ts /:id/reject — so there's no live employee to
// protect there).
router.post("/offers/bulk-delete-history", async (req, res) => {
  const ids: number[] = Array.isArray(req.body.ids) ? req.body.ids.map((n: any) => Number(n)).filter((n: number) => n > 0) : [];
  let deleted = 0, skipped = 0;
  for (const id of ids) {
    const offer = await prisma.offer.findUnique({ where: { id } });
    if (!offer || offer.employeeId) { skipped++; continue; } // active employee/contractor — never deletable from history
    await prisma.$transaction([
      prisma.appointmentLetter.deleteMany({ where: { offerId: id } }),
      prisma.serviceAgreement.deleteMany({ where: { offerId: id } }),
      prisma.itProvisioningRequest.deleteMany({ where: { offerId: id } }),
      prisma.offer.delete({ where: { id } }),
    ]);
    deleted++;
  }
  res.json({ deleted, skipped });
});

// "Save & Continue Later" — a half-filled Create Candidate form, saved with zero validation so
// HR can leave at any point and resume. Scoped to whoever saved it (their own list only).
router.get("/offer-drafts", async (req, res) => {
  res.json(await prisma.offerDraftSave.findMany({ where: { createdById: req.user!.id }, orderBy: { updatedAt: "desc" } }));
});
router.get("/offer-drafts/:id", async (req, res) => {
  const d = await prisma.offerDraftSave.findFirst({ where: { id: Number(req.params.id), createdById: req.user!.id } });
  if (!d) return res.status(404).json({ error: "Draft not found" });
  res.json(d);
});
router.post("/offer-drafts", async (req, res) => {
  const b = req.body || {};
  const label = [b.candidateFirstName, b.candidateLastName].filter(Boolean).join(" ") || "Untitled draft";
  const draft = await prisma.offerDraftSave.create({ data: { createdById: req.user!.id, label, formData: b } });
  res.status(201).json(draft);
});
router.put("/offer-drafts/:id", async (req, res) => {
  const existing = await prisma.offerDraftSave.findFirst({ where: { id: Number(req.params.id), createdById: req.user!.id } });
  if (!existing) return res.status(404).json({ error: "Draft not found" });
  const b = req.body || {};
  const label = [b.candidateFirstName, b.candidateLastName].filter(Boolean).join(" ") || "Untitled draft";
  const draft = await prisma.offerDraftSave.update({ where: { id: existing.id }, data: { label, formData: b } });
  res.json(draft);
});
router.delete("/offer-drafts/:id", async (req, res) => {
  await prisma.offerDraftSave.deleteMany({ where: { id: Number(req.params.id), createdById: req.user!.id } });
  res.json({ ok: true });
});

// Candidate Created — DRAFT, no calculation yet.
const PHONE_RE = /^[0-9+\-\s()]{7,15}$/;
router.post("/offers", async (req, res) => {
  const b = req.body;
  // ctc: `!b.ctc` treats an explicit 0 the same as missing, which blocked a genuinely no-cost
  // Contractor/Intern from ever being created. 0 is only permitted when the "No Cost to Company"
  // checkbox is explicitly checked (not merely because the type is Contractor/Intern) — everyone
  // else, and any Contractor/Intern who hasn't checked it, still needs a real value.
  const isNoCost = !!b.noCostToCompany && (b.employmentType === "CONTRACTOR" || b.employmentType === "INTERN");
  // Contractor Annual/Monthly/Daily structure (Stage 1) — annualized into Offer.ctc; the chosen
  // structure itself rides in Offer.customFields so Service Agreement generation can default to it.
  const contractorComp = b.employmentType === "CONTRACTOR" && !isNoCost && b.compensationType && b.compensationAmount != null && b.compensationAmount !== ""
    ? computeCompensation(b.compensationType, Number(b.compensationAmount)) : null;
  const ctcMissing = b.ctc === undefined || b.ctc === null || b.ctc === "" || Number.isNaN(Number(b.ctc))
    || (Number(b.ctc) === 0 && !isNoCost);
  if (!b.candidateFirstName || !b.candidateLastName || !b.candidateEmail || ctcMissing || !b.designation || !b.offerDate || !b.proposedJoiningDate || !b.reportingManager || !b.department) {
    return res.status(400).json({ error: "candidateFirstName, candidateLastName, candidateEmail, ctc, designation, offerDate, proposedJoiningDate, reportingManager and department are required" });
  }
  if (b.candidatePhone && !PHONE_RE.test(b.candidatePhone)) {
    return res.status(400).json({ error: "Phone number format is invalid" });
  }
  const offerDate = new Date(b.offerDate);
  const offer = await prisma.offer.create({
    data: {
      offerRef: await nextOfferRef(offerDate),
      candidateFirstName: b.candidateFirstName, candidateMiddleName: b.candidateMiddleName || null, candidateLastName: b.candidateLastName,
      candidateName: composeFullName(b.candidateFirstName, b.candidateMiddleName, b.candidateLastName),
      candidateEmail: b.candidateEmail, candidatePhone: b.candidatePhone || null, candidateOfficialPhone: b.candidateOfficialPhone || null, candidatePersonalEmail: b.candidatePersonalEmail || null, candidateAddress: b.candidateAddress || null,
      candidateCity: b.candidateCity || null, candidateLandmark: b.candidateLandmark || null, candidateState: b.candidateState || null, candidatePincode: b.candidatePincode || null,
      residentSameAsPermanent: b.residentSameAsPermanent !== false,
      residentAddress: b.residentSameAsPermanent === false ? (b.residentAddress || null) : null,
      residentCity: b.residentSameAsPermanent === false ? (b.residentCity || null) : null,
      residentLandmark: b.residentSameAsPermanent === false ? (b.residentLandmark || null) : null,
      residentState: b.residentSameAsPermanent === false ? (b.residentState || null) : null,
      residentPincode: b.residentSameAsPermanent === false ? (b.residentPincode || null) : null,
      gender: b.gender || null, maritalStatus: b.maritalStatus || null,
      dateOfBirth: b.dateOfBirth ? new Date(b.dateOfBirth) : null,
      uanPfDetails: cleanUanPf(b.uanPfDetails) ?? null,
      // Role field removed from Generate Offer's form (Designation covers the same purpose) —
      // always mirror Designation here so every existing role-based renderer keeps working.
      role: b.designation, designation: b.designation,
      employmentType: b.employmentType === "CONTRACTOR" ? "CONTRACTOR" : b.employmentType === "INTERN" ? "INTERN" : "EMPLOYEE",
      businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null,
      countryCode: b.countryCode || "INDIA",
      ctc: contractorComp ? contractorComp.annual : Number(b.ctc), noCostToCompany: isNoCost, offerDate,
      customFields: contractorComp ? { compensationType: contractorComp.type, compensationAmount: contractorComp.amount } : undefined,
      ...(usCompPatch(null, b) || {}),
      proposedJoiningDate: b.proposedJoiningDate ? new Date(b.proposedJoiningDate) : null,
      reportingManager: b.reportingManager || null,
      workLocation: b.workLocation || "Office",
      department: b.department || null,
      employmentBasis: b.employmentBasis || "Full Time",
      probationPeriod: b.probationPeriod || "2 Months",
      noticePeriod: b.noticePeriod || "2 Months",
      acceptanceDeadline: b.acceptanceDeadline ? new Date(b.acceptanceDeadline) : new Date(offerDate.getTime() + 3 * 86400000),
      documentChecklist: Array.isArray(b.documentChecklist) ? b.documentChecklist : [],
      // US/Canada simplified onboarding — all null/no-op for India (see schema.prisma's comment on
      // these fields) and for US/Canada Full-Time Salaried engagements (ctc above already covers it).
      usEngagementType: b.usEngagementType || null, billingBasis: b.billingBasis || null,
      hourlyRateUsd: b.hourlyRateUsd != null && b.hourlyRateUsd !== "" ? Number(b.hourlyRateUsd) : null,
      hoursPerDay: b.hoursPerDay != null && b.hoursPerDay !== "" ? Number(b.hoursPerDay) : null,
      vendorName: b.vendorName || null, vendorEin: b.vendorEin || null, vendorAddress: b.vendorAddress || null,
      endClientName: b.endClientName || null, engagementDescription: b.engagementDescription || null,
      createdById: req.user!.id,
    },
  });
  // Pin the workflow right away, not deferred to some later action (Accept, etc.) — every engine
  // helper that reads stage config (resolveRequiredDocuments, resolveOfferFieldConfig,
  // requireStageUnlocked...) silently falls back to generic defaults when offer.workflowId is
  // still null, which is exactly what made an Intern's Document Collection show the generic
  // 4-item default list (including Salary Slips) instead of Intern's own configured 2 items —
  // for the entire stretch between candidate creation and whatever later action happened to pin
  // it first. Never overwrites an already-pinned offer (matches ensureOfferPinnedToWorkflow's own
  // no-op-if-already-set behavior).
  await ensureOfferPinnedToWorkflow(offer.id);
  // US/Canada's simplified pipeline's "Agreement & Signature" stage only has a real action for a
  // Vendor/Contractor engagement (MSA+SOW — see MsaSowAgreementPanel, gated on offer.vendorName).
  // A direct-hire US/Canada Employee has nothing to sign there at all — it gets auto-completed once
  // Stage 1 (Capture Information) is actually sent (see /offers/:id/send), NOT here at creation —
  // completing it this early marked it done before Stage 1 itself ever did, so the stage tracker
  // showed Stage 2 green while HR was still filling out Stage 1 (reported bug).
  await audit(offer.id, req.user!.id, "CREATE", null, "DRAFT", "Candidate created");
  res.status(201).json(offer);
});

router.put("/offers/:id", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  // Contractor/Intern's only editable window for their base candidate/engagement fields (see
  // client's "Edit Candidate Information") — SENT (SLA emailed/out-for-signature but not yet
  // actually signed) is deliberately still editable; ACCEPTED (signed) and beyond is not, since
  // the candidate already has the terms in hand by then. EMPLOYEE never calls this route (it uses
  // POST /offers/:id/regenerate instead, with its own stricter pre-Send-only gate).
  if (!["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status)) return res.status(400).json({ error: `Cannot edit — ${offer.status === "ACCEPTED" ? "the Service Agreement has already been signed." : `already ${offer.status}.`}` });
  const b = req.body;
  const putComp = offer.employmentType === "CONTRACTOR" && b.compensationType && b.compensationAmount != null && b.compensationAmount !== "" && !b.noCostToCompany ? computeCompensation(b.compensationType, Number(b.compensationAmount)) : null;
  const nextFirst = b.candidateFirstName !== undefined ? b.candidateFirstName : offer.candidateFirstName;
  const nextMiddle = b.candidateMiddleName !== undefined ? b.candidateMiddleName : offer.candidateMiddleName;
  const nextLast = b.candidateLastName !== undefined ? b.candidateLastName : offer.candidateLastName;
  const updated = await prisma.offer.update({
    where: { id },
    data: {
      candidateFirstName: b.candidateFirstName !== undefined ? b.candidateFirstName : undefined,
      candidateMiddleName: b.candidateMiddleName !== undefined ? (b.candidateMiddleName || null) : undefined,
      candidateLastName: b.candidateLastName !== undefined ? b.candidateLastName : undefined,
      candidateName: (b.candidateFirstName !== undefined || b.candidateMiddleName !== undefined || b.candidateLastName !== undefined)
        ? composeFullName(nextFirst, nextMiddle, nextLast) : undefined,
      candidateEmail: b.candidateEmail, candidatePhone: b.candidatePhone,
      candidateOfficialPhone: b.candidateOfficialPhone,
      candidatePersonalEmail: b.candidatePersonalEmail,
      candidateAddress: b.candidateAddress !== undefined ? (b.candidateAddress || null) : undefined,
      candidateCity: b.candidateCity !== undefined ? (b.candidateCity || null) : undefined,
      candidateLandmark: b.candidateLandmark !== undefined ? (b.candidateLandmark || null) : undefined,
      candidateState: b.candidateState !== undefined ? (b.candidateState || null) : undefined,
      candidatePincode: b.candidatePincode !== undefined ? (b.candidatePincode || null) : undefined,
      residentSameAsPermanent: b.residentSameAsPermanent !== undefined ? b.residentSameAsPermanent !== false : undefined,
      residentAddress: b.residentSameAsPermanent !== undefined ? (b.residentSameAsPermanent === false ? (b.residentAddress || null) : null) : undefined,
      residentCity: b.residentSameAsPermanent !== undefined ? (b.residentSameAsPermanent === false ? (b.residentCity || null) : null) : undefined,
      residentLandmark: b.residentSameAsPermanent !== undefined ? (b.residentSameAsPermanent === false ? (b.residentLandmark || null) : null) : undefined,
      residentState: b.residentSameAsPermanent !== undefined ? (b.residentSameAsPermanent === false ? (b.residentState || null) : null) : undefined,
      residentPincode: b.residentSameAsPermanent !== undefined ? (b.residentSameAsPermanent === false ? (b.residentPincode || null) : null) : undefined,
      gender: b.gender !== undefined ? (b.gender || null) : undefined,
      maritalStatus: b.maritalStatus !== undefined ? (b.maritalStatus || null) : undefined,
      dateOfBirth: b.dateOfBirth !== undefined ? (b.dateOfBirth ? new Date(b.dateOfBirth) : null) : undefined,
      uanPfDetails: cleanUanPf(b.uanPfDetails),
      role: b.designation !== undefined ? b.designation : b.role, designation: b.designation,
      businessUnitId: b.businessUnitId !== undefined ? (b.businessUnitId ? Number(b.businessUnitId) : null) : undefined,
      countryCode: b.countryCode,
      ctc: putComp ? putComp.annual : b.ctc != null ? Number(b.ctc) : undefined,
      customFields: putComp ? { ...((offer.customFields as any) || {}), compensationType: putComp.type, compensationAmount: putComp.amount } : undefined,
      noCostToCompany: b.noCostToCompany !== undefined
        ? (!!b.noCostToCompany && (offer.employmentType === "CONTRACTOR" || offer.employmentType === "INTERN")) : undefined,
      offerDate: b.offerDate ? new Date(b.offerDate) : undefined,
      proposedJoiningDate: b.proposedJoiningDate !== undefined ? (b.proposedJoiningDate ? new Date(b.proposedJoiningDate) : null) : undefined,
      reportingManager: b.reportingManager !== undefined ? (b.reportingManager || null) : undefined,
      workLocation: b.workLocation,
      department: b.department !== undefined ? (b.department || null) : undefined,
      employmentBasis: b.employmentBasis,
      probationPeriod: b.probationPeriod,
      noticePeriod: b.noticePeriod,
      acceptanceDeadline: b.acceptanceDeadline !== undefined ? (b.acceptanceDeadline ? new Date(b.acceptanceDeadline) : null) : undefined,
      documentChecklist: Array.isArray(b.documentChecklist) ? b.documentChecklist : undefined,
      usEngagementType: b.usEngagementType !== undefined ? (b.usEngagementType || null) : undefined,
      billingBasis: b.billingBasis !== undefined ? (b.billingBasis || null) : undefined,
      ...(usCompPatch(offer.customFields, b) || {}),
      hourlyRateUsd: b.hourlyRateUsd !== undefined ? (b.hourlyRateUsd !== "" && b.hourlyRateUsd != null ? Number(b.hourlyRateUsd) : null) : undefined,
      hoursPerDay: b.hoursPerDay !== undefined ? (b.hoursPerDay !== "" && b.hoursPerDay != null ? Number(b.hoursPerDay) : null) : undefined,
      vendorName: b.vendorName !== undefined ? (b.vendorName || null) : undefined,
      vendorEin: b.vendorEin !== undefined ? (b.vendorEin || null) : undefined,
      vendorAddress: b.vendorAddress !== undefined ? (b.vendorAddress || null) : undefined,
      endClientName: b.endClientName !== undefined ? (b.endClientName || null) : undefined,
      engagementDescription: b.engagementDescription !== undefined ? (b.engagementDescription || null) : undefined,
    },
  });
  res.json(updated);
});

/** Shared calculation step used by both Generate and Regenerate. */
async function calcVersion(offer: any) {
  const buId = offer.businessUnitId ?? null;
  const bracket = await detectBracket(offer.ctc, offer.countryCode, buId);
  let breakup;
  let bracketName: string;
  if (bracket) {
    breakup = await computeSalaryBreakup(bracket.id, offer.ctc);
    bracketName = bracket.name;
  } else {
    const flat = Math.round(offer.ctc / 12);
    breakup = { bracketId: 0, bracketName: "Not modeled", components: [{ name: "Total Compensation", part: "A", pct: 100, monthly: flat, annual: offer.ctc }], grossA: flat, grossAAnnual: offer.ctc, grossB: 0, grossBAnnual: 0, totalMonthly: flat, totalAnnual: offer.ctc };
    bracketName = "Not modeled for this country yet";
  }
  const tax = await computeTax(breakup.totalAnnual, offer.countryCode, "NEW", buId);
  const tpl = await buFirst(buId, (bu) => prisma.hrOfferTemplate.findFirst({ where: { countryCode: offer.countryCode, minCtc: { lte: offer.ctc }, OR: [{ maxCtc: null }, { maxCtc: { gte: offer.ctc } }], ...bu }, orderBy: { isDefault: "desc" } }))
    || await prisma.hrOfferTemplate.findFirst({ where: { isDefault: true } }) || await prisma.hrOfferTemplate.findFirst();
  return { breakup, tax, bracketName, offerTemplateId: tpl?.id || null };
}

router.post("/offers/:id/generate", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { versions: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Contractors/Interns don't get an Offer Letter — use Generate Service Agreement instead." });
  const missingFields = await unmetMandatoryOfferFields(id);
  if (missingFields.length) return res.status(400).json({ error: `Complete the following before generating the offer: ${missingFields.map((f) => f.label).join(", ")}.` });
  const { breakup, tax, bracketName, offerTemplateId } = await calcVersion(offer);
  const versionNo = (offer.versions.length ? Math.max(...offer.versions.map((v) => v.versionNo)) : 0) + 1;
  await prisma.offerVersion.create({ data: { offerId: id, versionNo, ctc: offer.ctc, bracketName, salaryBreakup: breakup as any, taxCalc: tax as any, offerTemplateId } });
  const updated = await prisma.offer.update({ where: { id }, data: { activeVersion: versionNo, status: "GENERATED" }, include: OFFER_INCLUDE as any });
  await audit(id, req.user!.id, "GENERATE", offer.status, "GENERATED", `v${versionNo} · ${bracketName}`);
  res.json({ ...updated, activeVersionData: activeVersionOf(updated) });
});

// Regenerate: recompute from the CURRENT offer fields into a brand-new version; the old
// version(s) are kept untouched for history — only `activeVersion` on Offer moves forward.
router.post("/offers/:id/regenerate", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { versions: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Contractors/Interns don't get an Offer Letter — use Regenerate Service Agreement instead." });
  // A closed offer (Declined/Expired/Withdrawn/Cancelled) is the ONE case regeneration should
  // still allow — it's HR's escape hatch to restart the same candidate record as a fresh revision
  // instead of being permanently dead-ended. Forward progress (Accepted onward) is still blocked —
  // regenerating the Offer Letter itself makes no sense once the Appointment Letter or an active
  // Employee already exists off the back of it.
  if (["ACCEPTED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"].includes(offer.status)) {
    return res.status(400).json({ error: `Cannot regenerate — offer is already ${offer.status}.` });
  }
  const b = req.body || {};
  // Candidate identity/engagement basics (name/email/phone/gender/marital/DOB/business unit/
  // country/offer date) used to be silently dropped here — accepted by the client's Employee-flow
  // regenerate form but never actually persisted, matching neither HR's expectation nor what a
  // Contractor/Intern's own "Edit Candidate Information" regenerate already allowed. Now accepted
  // the same way for every employment type — only Employment Type itself stays fixed (changing it
  // means a fundamentally different document/workflow, not a field edit — HR cancels and re-creates
  // the candidate under the correct type instead, per the client's own note).
  if (b.candidateEmail !== undefined && String(b.candidateEmail || "").trim()) {
    const dupe = await prisma.offer.findFirst({ where: { candidateEmail: String(b.candidateEmail).trim(), id: { not: id } } });
    if (dupe) return res.status(400).json({ error: `Another candidate already uses ${b.candidateEmail}.` });
  }
  // candidateName is always server-computed from the three name parts, never accepted directly —
  // recompute it here too (same helper the PUT /offers/:id route uses) whenever any of them change,
  // or it would silently go stale the moment an Employee's regenerate edits a name.
  const nextFirst = b.candidateFirstName !== undefined ? String(b.candidateFirstName || "").trim() : offer.candidateFirstName;
  const nextMiddle = b.candidateMiddleName !== undefined ? (String(b.candidateMiddleName || "").trim() || null) : offer.candidateMiddleName;
  const nextLast = b.candidateLastName !== undefined ? String(b.candidateLastName || "").trim() : offer.candidateLastName;
  const merged = await prisma.offer.update({ where: { id }, data: {
    candidateFirstName: nextFirst, candidateMiddleName: nextMiddle, candidateLastName: nextLast,
    candidateName: (b.candidateFirstName !== undefined || b.candidateMiddleName !== undefined || b.candidateLastName !== undefined)
      ? composeFullName(nextFirst, nextMiddle, nextLast) : offer.candidateName,
    candidateEmail: b.candidateEmail !== undefined ? String(b.candidateEmail || "").trim() : offer.candidateEmail,
    candidatePhone: b.candidatePhone !== undefined ? (b.candidatePhone || null) : offer.candidatePhone,
    candidateOfficialPhone: b.candidateOfficialPhone !== undefined ? (b.candidateOfficialPhone || null) : offer.candidateOfficialPhone,
    candidatePersonalEmail: b.candidatePersonalEmail !== undefined ? (b.candidatePersonalEmail || null) : offer.candidatePersonalEmail,
    candidateAddress: b.candidateAddress !== undefined ? (b.candidateAddress || null) : offer.candidateAddress,
    gender: b.gender !== undefined ? (b.gender || null) : offer.gender,
    maritalStatus: b.maritalStatus !== undefined ? (b.maritalStatus || null) : offer.maritalStatus,
    dateOfBirth: b.dateOfBirth !== undefined ? (b.dateOfBirth ? new Date(b.dateOfBirth) : null) : offer.dateOfBirth,
    uanPfDetails: b.uanPfDetails !== undefined ? (cleanUanPf(b.uanPfDetails) ?? null) : offer.uanPfDetails,
    countryCode: b.countryCode ?? offer.countryCode,
    offerDate: b.offerDate !== undefined ? (b.offerDate ? new Date(b.offerDate) : offer.offerDate) : offer.offerDate,
    role: b.designation ?? offer.role, designation: b.designation ?? offer.designation,
    ctc: b.ctc != null ? Number(b.ctc) : offer.ctc,
    businessUnitId: b.businessUnitId !== undefined ? (b.businessUnitId ? Number(b.businessUnitId) : null) : offer.businessUnitId,
    proposedJoiningDate: b.proposedJoiningDate !== undefined ? (b.proposedJoiningDate ? new Date(b.proposedJoiningDate) : null) : offer.proposedJoiningDate,
    reportingManager: b.reportingManager !== undefined ? (b.reportingManager || null) : offer.reportingManager,
    workLocation: b.workLocation ?? offer.workLocation,
    department: b.department !== undefined ? (b.department || null) : offer.department,
    employmentBasis: b.employmentBasis ?? offer.employmentBasis,
    probationPeriod: b.probationPeriod ?? offer.probationPeriod,
    noticePeriod: b.noticePeriod ?? offer.noticePeriod,
    acceptanceDeadline: b.acceptanceDeadline !== undefined ? (b.acceptanceDeadline ? new Date(b.acceptanceDeadline) : null) : offer.acceptanceDeadline,
    documentChecklist: Array.isArray(b.documentChecklist) ? b.documentChecklist : (offer.documentChecklist as any),
    // US/Canada Compensation (see Offer model's own comment) — a W2 US offer's regenerate can
    // still edit engagement type/billing basis/hourly rate the same way everything else here does.
    usEngagementType: b.usEngagementType !== undefined ? (b.usEngagementType || null) : offer.usEngagementType,
    billingBasis: b.billingBasis !== undefined ? (b.billingBasis || null) : offer.billingBasis,
    hourlyRateUsd: b.hourlyRateUsd !== undefined ? (b.hourlyRateUsd !== "" && b.hourlyRateUsd != null ? Number(b.hourlyRateUsd) : null) : offer.hourlyRateUsd,
    hoursPerDay: b.hoursPerDay !== undefined ? (b.hoursPerDay !== "" && b.hoursPerDay != null ? Number(b.hoursPerDay) : null) : offer.hoursPerDay,
    ...(usCompPatch(offer.customFields, b) || {}),
  } });
  const { breakup, tax, bracketName, offerTemplateId } = await calcVersion(merged);
  const versions = await prisma.offerVersion.findMany({ where: { offerId: id } });
  const versionNo = Math.max(...versions.map((v) => v.versionNo)) + 1;
  await prisma.offerVersion.create({ data: { offerId: id, versionNo, ctc: merged.ctc, bracketName, salaryBreakup: breakup as any, taxCalc: tax as any, offerTemplateId } });
  const updated = await prisma.offer.update({ where: { id }, data: { activeVersion: versionNo, status: "GENERATED" }, include: OFFER_INCLUDE as any });
  await audit(id, req.user!.id, "REGENERATE", offer.status, "GENERATED", `v${versionNo} created (v${versionNo - 1} preserved) — ${b.reason || "HR-requested change"}`);
  // A new revision means anything previously sent for e-signature (or that a candidate had
  // already declined) points at stale content now — void it so nothing old is still signable.
  await voidInFlightAgreements(id).catch(() => {});
  res.json({ ...updated, activeVersionData: activeVersionOf(updated) });
});

// Customize Offer: per-employee component overrides applied to the CURRENT version in place
// (never touches the HR Settings master bracket) — recorded in that version's `overrides`.
router.put("/offers/:id/customize", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { versions: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const version = offer.versions.find((v) => v.versionNo === offer.activeVersion);
  if (!version) return res.status(400).json({ error: "Generate the offer before customizing it." });
  const overrides = req.body?.overrides || {};
  const bracketId = (version.salaryBreakup as any)?.bracketId;
  let breakup = version.salaryBreakup as any;
  if (bracketId) {
    const { computeSalaryBreakup: recompute } = await import("../../engine/hr");
    breakup = await recompute(bracketId, offer.ctc, overrides);
  }
  const tax = await computeTax(breakup.totalAnnual, offer.countryCode, "NEW");
  const updatedVersion = await prisma.offerVersion.update({ where: { id: version.id }, data: { salaryBreakup: breakup, taxCalc: tax as any, overrides } });
  await audit(id, req.user!.id, "CUSTOMIZE", offer.status, offer.status, "Component override applied to this offer only");
  res.json(updatedVersion);
});

router.get("/offers/:id/pdf", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, include: { versions: true, businessUnit: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  // Once HR has uploaded a signed copy (see /signed-offer), THAT is the real, authoritative
  // document from here on — every "View Offer" link across the app goes through this one route,
  // so serving the signed file here (instead of re-rendering the unsigned draft) is what makes it
  // replace the generated document everywhere at once, with no separate client-side logic needed.
  if (offer.signedOfferFileData) {
    res.setHeader("Content-Type", signedDocContentType(offer.signedOfferFileName || ""));
    res.setHeader("Content-Disposition", `inline; filename="${offer.signedOfferFileName}"`);
    return res.send(Buffer.from(offer.signedOfferFileData, "base64"));
  }
  if (usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Contractors/Interns don't have an Offer Letter — use the Service Agreement PDF instead." });
  const version = activeVersionOf(offer);
  if (!version) return res.status(400).json({ error: "Generate the offer first." });
  const tpl = version.offerTemplateId ? await prisma.hrOfferTemplate.findUnique({ where: { id: version.offerTemplateId } }) : null;
  const body = fillTemplate(tpl?.bodyText || "Dear {{CandidateFirstName}},\n\nWe are pleased to offer you the position of {{Role}}.", {
    CandidateFirstName: firstName(offer.candidateName), Role: offer.role, Designation: offer.designation,
    OfferRef: offer.offerRef, ProposedJoiningDate: dstr(offer.proposedJoiningDate) || "To be confirmed",
    Business: offer.businessUnit?.name || "", Ctc: money(offer.ctc, offer.countryCode === "US" ? "USD" : offer.countryCode === "CANADA" ? "CAD" : "INR"),
    ...(offer.countryCode && offer.countryCode !== "INDIA" ? engagementDocVars(offer) : {}),
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Offer_${offer.offerRef}.pdf"`);
  renderOfferPdf({ offerRef: offer.offerRef, candidateName: offer.candidateName, role: offer.role, designation: offer.designation, ctc: offer.ctc, offerDate: offer.offerDate, proposedJoiningDate: offer.proposedJoiningDate, businessName: offer.businessUnit?.name, countryCode: offer.countryCode, reportingManager: offer.reportingManager, probationPeriod: offer.probationPeriod, noticePeriod: offer.noticePeriod, acceptanceDeadline: offer.acceptanceDeadline, documentChecklist: offer.documentChecklist as any, phone: offer.candidatePhone, templateBody: body, breakup: version.salaryBreakup as any, ...(await getHrSignature(offer.businessUnitId)) }, res);
});

router.post("/offers/:id/preview", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (offer.status === "GENERATED") {
    await prisma.offer.update({ where: { id }, data: { status: "PREVIEWED" } });
    await audit(id, req.user!.id, "PREVIEW", "GENERATED", "PREVIEWED");
  }
  res.json({ ok: true });
});

router.post("/offers/:id/send", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { versions: true, businessUnit: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Contractors/Interns don't have an Offer Letter — use Send Service Agreement instead." });
  const version = activeVersionOf(offer);
  if (!version) return res.status(400).json({ error: "Generate the offer before sending it." });
  if (offer.status !== "PREVIEWED") return res.status(400).json({ error: "Preview the offer before sending it." });

  const tplMail = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "OFFER_EMAIL", ...bu } }));
  const vals = {
    CandidateFirstName: firstName(offer.candidateName), Role: offer.role, Designation: offer.designation,
    Business: offer.businessUnit?.name || "", ProposedJoiningDate: dstr(offer.proposedJoiningDate) || "To be confirmed",
    OfferRef: offer.offerRef, OfferDate: dstr(offer.offerDate),
  };
  const subject = fillTemplate(tplMail?.subject || "Your Offer from GenAquarius", vals);
  const html = fillTemplate(tplMail?.body || "Please find your offer attached.", vals).replace(/\n/g, "<br>");

  let sent = false, reason = "";
  if (!mailEnabled()) reason = "Email not configured (Microsoft Graph)";
  else {
    try {
      const sig = await getHrSignature(offer.businessUnitId);
      const pdf = await renderToBuffer((out: Writable) => {
        const tpl2 = version.offerTemplateId ? null : null; // body already built once below
        renderOfferPdf({ offerRef: offer.offerRef, candidateName: offer.candidateName, role: offer.role, designation: offer.designation, ctc: offer.ctc, offerDate: offer.offerDate, proposedJoiningDate: offer.proposedJoiningDate, businessName: offer.businessUnit?.name, countryCode: offer.countryCode, reportingManager: offer.reportingManager, probationPeriod: offer.probationPeriod, noticePeriod: offer.noticePeriod, acceptanceDeadline: offer.acceptanceDeadline, documentChecklist: offer.documentChecklist as any, phone: offer.candidatePhone, templateBody: html.replace(/<br>/g, "\n"), breakup: version.salaryBreakup as any, ...sig }, out);
      });
      const r = await notifyMail("OFFER_SEND", { fromUpn: req.user!.email, to: offer.candidateEmail, subject, html, attachments: [{ name: `Offer_${offer.offerRef}.pdf`, contentBytes: pdf.toString("base64"), contentType: "application/pdf" }] });
      sent = r.sent; if (!r.sent) reason = r.reason || "Not sent";
    } catch (e: any) { reason = e?.message || "Send failed"; }
  }

  const updated = await prisma.offer.update({ where: { id }, data: { status: "SENT", sentAt: new Date() }, include: OFFER_INCLUDE as any });
  // US/Canada direct-hire Employee (no vendor): Stage 2 (Agreement & Signature) has nothing to
  // sign, so auto-complete it now that Stage 1 has actually been sent — see the creation route for
  // why this can't happen at creation time instead.
  if (workflowBucketFor(updated) === "US_CANADA" && !updated.vendorName) {
    await completeStageByType(id, "AGREEMENT_SIGNATURE");
  }
  await audit(id, req.user!.id, "SEND", offer.status, "SENT", sent ? `Emailed to ${offer.candidateEmail}` : `Not emailed — ${reason}`);
  emitEsignUpdate("OFFER", id, updated);
  res.json({ ...updated, activeVersionData: activeVersionOf(updated), emailSent: sent, emailReason: sent ? undefined : reason });
});

router.post("/offers/:id/resend", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (!offer.sentAt) return res.status(400).json({ error: "This offer hasn't been sent yet — use Send Offer." });
  await audit(id, req.user!.id, "RESEND", offer.status, offer.status, `Re-emailed to ${offer.candidateEmail}`);
  res.json({ ok: true });
});

router.post("/offers/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  // employeeId (not status) is the durable "already joined" signal for an EMPLOYEE offer — status
  // keeps advancing through APPOINTMENT_* after activation now that Appointment can run after
  // Employee Activation (see the 2026-09-23 workflow reorder); CONTRACTOR status does stay fixed
  // at JOINING_CONFIRMED, so this still also covers that case.
  if (offer.employeeId || offer.status === "JOINING_CONFIRMED") return res.status(400).json({ error: "Cannot cancel — the employee has already joined." });
  const updated = await prisma.offer.update({ where: { id }, data: { status: "CANCELLED" } });

  // Notify the candidate the offer has been withdrawn — same DB-driven template pattern as
  // Send Offer; only actually mails once the offer has been generated (a bare DRAFT candidate
  // was never told about an offer in the first place, so there's nothing to "withdraw" for them).
  // CONTRACTOR gets Service-Agreement-appropriate wording (a second, dedicated email template
  // key) rather than the Offer's own "your offer has been withdrawn" copy — same DB-driven
  // template pattern either way, just a different key/default text per employment type.
  const isContractor = usesServiceAgreement(offer.employmentType);
  let sent = false, reason = "";
  if (!offer.sentAt && !["GENERATED", "PREVIEWED"].includes(offer.status)) reason = `${isContractor ? "Service Agreement" : "Offer"} was never generated/sent — nothing to notify the candidate about`;
  else if (!mailEnabled()) reason = "Email not configured (Microsoft Graph)";
  else {
    try {
      const tplKey = isContractor ? "SERVICE_AGREEMENT_WITHDRAWN_EMAIL" : "OFFER_WITHDRAWN_EMAIL";
      const tplMail = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: tplKey, ...bu } }));
      const vals = { CandidateFirstName: firstName(offer.candidateName), Role: offer.role, Designation: offer.designation, OfferRef: offer.offerRef };
      const subject = fillTemplate(tplMail?.subject || (isContractor ? "Update on your Service Agreement from GenAquarius" : "Update on your offer from GenAquarius"), vals);
      const html = fillTemplate(tplMail?.body || (isContractor ? "Your Service Agreement has been withdrawn." : "Your offer has been withdrawn."), vals).replace(/\n/g, "<br>");
      const r = await notifyMail(isContractor ? "SERVICE_AGREEMENT_WITHDRAWN" : "OFFER_WITHDRAWN", { fromUpn: req.user!.email, to: offer.candidateEmail, subject, html });
      sent = r.sent; if (!r.sent) reason = r.reason || "Not sent";
    } catch (e: any) { reason = e?.message || "Send failed"; }
  }

  await audit(id, req.user!.id, "CANCEL", offer.status, "CANCELLED", `${req.body?.reason || "Cancelled"} — ${sent ? `withdrawal emailed to ${offer.candidateEmail}` : `not emailed (${reason})`}`);
  emitEsignUpdate("OFFER", id, updated);
  // A cancelled offer must not leave a live, signable Adobe Sign agreement behind — void anything
  // still OUT_FOR_SIGNATURE (Offer/Appointment Letter/Service Agreement) so the candidate's signing
  // link stops working the moment HR withdraws it.
  await voidInFlightAgreements(id).catch(() => {});
  await cancelPendingItProvisioning(id, "offer cancelled by HR", req.user!.id, req.user!.email).catch(() => {});
  res.json({ ...updated, emailSent: sent, emailReason: sent ? undefined : reason });
});

// Declined / Withdrawn / Expired — reachable from SENT (or ACCEPTED for withdraw).
for (const [path, status] of [["decline", "DECLINED"], ["withdraw", "WITHDRAWN"], ["expire", "EXPIRED"]] as const) {
  router.post(`/offers/:id/${path}`, async (req, res) => {
    const id = Number(req.params.id);
    const offer = await prisma.offer.findUnique({ where: { id } });
    if (!offer) return res.status(404).json({ error: "Offer not found" });
    const updated = await prisma.offer.update({ where: { id }, data: { status } });
    await audit(id, req.user!.id, status, offer.status, status, req.body?.reason);
    emitEsignUpdate("OFFER", id, updated);
    await voidInFlightAgreements(id).catch(() => {});
    await cancelPendingItProvisioning(id, `offer ${status.toLowerCase()}`, req.user!.id, req.user!.email).catch(() => {});
    res.json(updated);
  });
}

// Section 12/13 — the plain-email delivery path requires HR to upload the candidate's countersigned
// offer letter before Confirm Acceptance is allowed at all; the Adobe Sign path never hits this
// (the signed document there is already captured automatically by the e-sign completion itself, so
// an OFFER EsignAgreement row existing for this offer is what exempts it from the requirement).
router.post("/offers/:id/signed-offer", async (req, res) => {
  const id = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const offer = await prisma.offer.update({ where: { id }, data: { signedOfferFileName: fileName, signedOfferFileData: fileData, signedOfferUploadedAt: new Date() } });
  await audit(id, req.user!.id, "SIGNED_OFFER_UPLOAD", offer.status, offer.status, `Signed offer letter uploaded (${fileName})`);
  emitEsignUpdate("OFFER", id, { signedOfferUploaded: true });
  res.json({ signedOfferFileName: offer.signedOfferFileName, signedOfferUploadedAt: offer.signedOfferUploadedAt });
});
router.get("/offers/:id/signed-offer", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, select: { signedOfferFileName: true, signedOfferFileData: true } });
  if (!offer?.signedOfferFileData) return res.status(404).json({ error: "No signed offer letter on file" });
  const ext = (offer.signedOfferFileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${offer.signedOfferFileName}"`);
  res.send(Buffer.from(offer.signedOfferFileData, "base64"));
});

// Delete a mistakenly-uploaded signed copy (wrong file, wrong candidate, etc.) — only while still
// unaccepted; once ACCEPTED the uploaded file is the acceptance proof itself and stays permanent.
router.delete("/offers/:id/signed-offer", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (!["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status)) return res.status(400).json({ error: `Cannot remove — offer is already ${offer.status}.` });
  await prisma.offer.update({ where: { id }, data: { signedOfferFileName: null, signedOfferFileData: null, signedOfferUploadedAt: null } });
  await audit(id, req.user!.id, "SIGNED_OFFER_DELETE", offer.status, offer.status, "Signed offer letter removed");
  res.json({ ok: true });
});
function signedDocContentType(fileName: string) {
  const ext = (fileName || "").split(".").pop()?.toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
}
// Same "upload a copy signed outside this app, skip Issue" mechanism as the Offer Letter's own
// signed-offer upload above — lets HR go straight to Confirm Acceptance from
// APPOINTMENT_GENERATED/PREVIEWED instead of Issuing (emailing) it first.
router.post("/offers/:id/appointment/signed", async (req, res) => {
  const id = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const appt = await prisma.appointmentLetter.update({ where: { offerId: id }, data: { signedFileName: fileName, signedFileData: fileData, signedUploadedAt: new Date() } });
  await audit(id, req.user!.id, "SIGNED_APPOINTMENT_UPLOAD", null, null, `Signed appointment letter uploaded (${fileName})`);
  emitEsignUpdate("APPOINTMENT_LETTER", id, { signedUploaded: true });
  res.json({ signedFileName: appt.signedFileName, signedUploadedAt: appt.signedUploadedAt });
});
router.get("/offers/:id/appointment/signed", async (req, res) => {
  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: Number(req.params.id) }, select: { signedFileName: true, signedFileData: true } });
  if (!appt?.signedFileData) return res.status(404).json({ error: "No signed appointment letter on file" });
  res.setHeader("Content-Type", signedDocContentType(appt.signedFileName || ""));
  res.setHeader("Content-Disposition", `inline; filename="${appt.signedFileName}"`);
  res.send(Buffer.from(appt.signedFileData, "base64"));
});
router.delete("/offers/:id/appointment/signed", async (req, res) => {
  const id = Number(req.params.id);
  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: id } });
  if (!appt) return res.status(404).json({ error: "Appointment letter not found" });
  if (appt.status === "ACCEPTED") return res.status(400).json({ error: "Cannot remove — already accepted." });
  await prisma.appointmentLetter.update({ where: { offerId: id }, data: { signedFileName: null, signedFileData: null, signedUploadedAt: null } });
  await audit(id, req.user!.id, "SIGNED_APPOINTMENT_DELETE", null, null, "Signed appointment letter removed");
  res.json({ ok: true });
});
// Same again for the Service Agreement (Contractor/Intern) — skip Send from
// GENERATED/PREVIEWED straight to Confirm Acceptance.
router.post("/offers/:id/service-agreement/signed", async (req, res) => {
  const id = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const sa = await prisma.serviceAgreement.update({ where: { offerId: id }, data: { signedFileName: fileName, signedFileData: fileData, signedUploadedAt: new Date() } });
  await audit(id, req.user!.id, "SIGNED_SERVICE_AGREEMENT_UPLOAD", null, null, `Signed Service Agreement uploaded (${fileName})`);
  emitEsignUpdate("SERVICE_AGREEMENT", id, { signedUploaded: true });
  res.json({ signedFileName: sa.signedFileName, signedUploadedAt: sa.signedUploadedAt });
});
router.get("/offers/:id/service-agreement/signed", async (req, res) => {
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: Number(req.params.id) }, select: { signedFileName: true, signedFileData: true } });
  if (!sa?.signedFileData) return res.status(404).json({ error: "No signed Service Agreement on file" });
  res.setHeader("Content-Type", signedDocContentType(sa.signedFileName || ""));
  res.setHeader("Content-Disposition", `inline; filename="${sa.signedFileName}"`);
  res.send(Buffer.from(sa.signedFileData, "base64"));
});
router.delete("/offers/:id/service-agreement/signed", async (req, res) => {
  const id = Number(req.params.id);
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  if (!sa) return res.status(404).json({ error: "Service Agreement not found" });
  if (sa.status === "ACCEPTED") return res.status(400).json({ error: "Cannot remove — already accepted." });
  await prisma.serviceAgreement.update({ where: { offerId: id }, data: { signedFileName: null, signedFileData: null, signedUploadedAt: null } });
  await audit(id, req.user!.id, "SIGNED_SERVICE_AGREEMENT_DELETE", null, null, "Signed Service Agreement removed");
  res.json({ ok: true });
});

// HR can skip Send/e-sign entirely when a signed copy already exists (e.g. signed on paper
// outside this app) — Upload Signed Offer Letter, then this directly from GENERATED/PREVIEWED,
// no Send required first. Still requires an uploaded signed file when skipping Send this way
// (an already-signed document is exactly the point); SENT keeps its existing, looser rule
// (esign OR upload) since a real send did happen there.
router.post("/offers/:id/accept", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (!["GENERATED", "PREVIEWED", "SENT"].includes(offer.status)) return res.status(400).json({ error: `Cannot accept — offer is already ${offer.status}.` });
  const viaEsign = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType: "OFFER", docId: id } } });
  if (!viaEsign && !offer.signedOfferFileData) {
    return res.status(400).json({ error: "Upload the candidate's signed offer letter before confirming acceptance." });
  }
  const wasSent = offer.status === "SENT";
  const b = req.body || {};
  const updated = await prisma.offer.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: b.acceptedAt ? new Date(b.acceptedAt) : new Date(), acceptanceMethod: b.acceptanceMethod || (wasSent ? "EMAIL_REPLY" : "SIGNED_COPY"), acceptanceNote: b.acceptanceNote || null } });
  await audit(id, req.user!.id, "ACCEPT", offer.status, "ACCEPTED", wasSent ? b.acceptanceNote : `Signed offer letter uploaded directly — Send skipped. ${b.acceptanceNote || ""}`.trim());
  await ensureOfferPinnedToWorkflow(id);
  await completeStageByType(id, "OFFER_ACCEPTANCE", req.user!.id);
  emitEsignUpdate("OFFER", id, updated);
  res.json(updated);
});

// ------------------------------------------------------------------ Service Agreement (CONTRACTOR) ----
// Fully parallel to the Offer Letter's own generate/regenerate/preview/pdf/send set above, but for
// CONTRACTOR offers: ONE document (no Offer Letter, no Appointment Letter step at all), a flat
// 10%-TDS pay calc (computeContractorPay — no CTC bracket/tax regime engine), and a "C1500"-style
// reserved code (nextContractorCode) instead of "GA-####".
// US/Canada Stage 1 compensation (usComp: { basis, rate, hoursPerDay, workingDays }) -> the Offer
// columns it drives. ctc is the computed ANNUALIZED figure everything downstream already reads;
// the chosen basis + rate ride in customFields.usComp (and the legacy billingBasis/hourly columns
// are kept in sync so older readers still work).
function usCompPatch(existingCustom: any, b: any) {
  const u = b?.usComp;
  if (!u || !u.basis) return null;
  const c = computeEngagementComp(u.basis, Number(u.rate), u.hoursPerDay, u.workingDays);
  return {
    ctc: c.annual,
    billingBasis: c.basis,
    hourlyRateUsd: c.basis === "HOURLY" ? c.rate : null,
    hoursPerDay: c.basis === "HOURLY" || c.basis === "DAILY" ? c.hoursPerDay : null,
    customFields: { ...(existingCustom || {}), usComp: { basis: c.basis, rate: c.rate, hoursPerDay: c.hoursPerDay, workingDays: c.workingDays } },
  };
}

// Keep the Offer's own compensation structure (Stage 1) in step with what the Service Agreement was
// actually generated with, so the next Regenerate defaults to it instead of a stale value.
function offerCompSync(offer: any, fields: any) {
  const df = fields?.dynamicFields || {};
  if (offer.employmentType !== "CONTRACTOR" || fields.noCostToCompany || !df.CompensationType) return {};
  return { ctc: df.AnnualizedCtc, customFields: { ...((offer.customFields as any) || {}), compensationType: df.CompensationType, compensationAmount: df.CompensationAmount } };
}

async function buildServiceAgreementFields(offer: any, tpl: any, b: any) {
  const noCostToCompany = !!b.noCostToCompany;
  // Contractor compensation structure — Annual / Monthly / Daily. monthlyCompensation (the column
  // everything downstream reads) is always the monthly equivalent; legacy callers that only send
  // monthlyCompensation behave as MONTHLY exactly like before.
  const comp = computeCompensation(b.compensationType, b.compensationAmount != null && b.compensationAmount !== "" ? Number(b.compensationAmount) : Number(b.monthlyCompensation));
  const monthlyCompensation = noCostToCompany ? 0 : comp.monthly;
  const effectiveDate = b.effectiveDate ? new Date(b.effectiveDate) : offer.proposedJoiningDate || new Date();

  // INTERN gets the simple Internship Letter instead of the Contractor SLA's Bank Details/Aadhar/
  // SLA-Name-Address/clause-based document — per explicit decision ("Replace it for Interns").
  // monthlyCompensation/noCostToCompany still flow through the same field (read by Confirm
  // Joining's CTC-approval branch below) even though the letter itself never states a stipend.
  if (offer.employmentType === "INTERN") {
    const startDate = offer.proposedJoiningDate || new Date();
    const endDate = b.internshipEndDate ? new Date(b.internshipEndDate) : new Date(new Date(startDate).getTime() + 60 * 86400000); // default 2 months
    return {
      templateId: null,
      clauses: [],
      monthlyCompensation,
      noCostToCompany,
      dynamicFields: {
        EffectiveDate: dstr(effectiveDate),
        StartDate: dstr(startDate), EndDate: dstr(endDate), EndDateRaw: endDate.toISOString(),
        DurationText: durationText(startDate, endDate),
        Location: b.internshipLocation || offer.workLocation || "Hybrid",
        Phone: offer.candidatePhone || "",
      },
    };
  }

  const compAmountStr = rsAmount(comp.amount), compWords = amountToWordsIndia(comp.amount);
  const payClause = comp.type === "ANNUAL"
    ? `The payment for the contract duration will be calculated based on an annual compensation of **${compAmountStr} (Rupees ${compWords})**, payable in equal monthly instalments of **${rsAmount(comp.monthly)}**, and will be paid by the last working day of each month.`
    : comp.type === "DAILY"
    ? `The payment for the contract duration will be calculated based on a daily compensation of **${compAmountStr} (Rupees ${compWords})** for each working day, for the number of days worked in the month, and will be paid by the last working day of each month.`
    : `The payment for the contract duration will be calculated based on a monthly compensation of **${compAmountStr} (Rupees ${compWords})** and will be paid by the last working day of each month.`;
  // Swap ONLY the payment-terms point of the (DB-stored) template's clauses, wherever it sits, so
  // existing templates pick up the selected structure without being re-seeded.
  const clauses = JSON.parse(JSON.stringify((tpl?.clauses as any) || [])).map((c: any) => {
    if (Array.isArray(c?.points)) c.points = c.points.map((p: any) => (typeof p?.text === "string" && p.text.includes("{{MonthlyCompensationAmount}}") ? { ...p, text: payClause } : p));
    // HR-edited wording that introduces the numbered Services list (per-agreement override).
    const svcIntro = typeof b.servicesIntro === "string" ? b.servicesIntro.trim() : "";
    if (svcIntro && Array.isArray(c?.points)) c.points = c.points.map((p: any) => (p?.servicesList ? { ...p, text: svcIntro } : p));
    return c;
  });
  return {
    templateId: tpl?.id || null,
    clauses,
    monthlyCompensation,
    noCostToCompany,
    dynamicFields: {
      // Formatted to a plain date string here — same fix as the Appointment Letter's
      // DateOfAppointment/JoiningDate: dynamicFields is a Json column, and a raw Date value gets
      // serialized through JSON.stringify (Date.toJSON() -> full ISO timestamp) the moment this
      // record is saved, permanently losing fillTemplate's `instanceof Date` formatting the next
      // time it's read back — every {{EffectiveDate}} in the SLA clause text (opening paragraph,
      // payment terms, signature block) would print the raw timestamp instead of a date.
      EffectiveDate: dstr(effectiveDate),
      // The SLA's own Name field — deliberately NOT offer.candidateName/First+Last (Candidate
      // Information section) per explicit request; a contractor's legal/billing name on the
      // Service Agreement can differ from their candidate profile name. Falls back to
      // candidateName only as a last-resort safety net if SLA Name was somehow left blank, so a
      // document is never generated with a literally empty name.
      ContractorName: (b.slaName || "").trim() || offer.candidateName,
      Phone: offer.candidatePhone || "",
      AadharNumber: b.aadharNumber || "",
      ContractorAddress: b.contractorAddress || "",
      CompensationType: comp.type, CompensationAmount: noCostToCompany ? 0 : comp.amount, AnnualizedCtc: noCostToCompany ? 0 : comp.annual,
      MonthlyCompensationAmount: rsAmount(monthlyCompensation),
      MonthlyCompensationWords: amountToWordsIndia(monthlyCompensation),
      BankAccountNumber: b.bankAccountNumber || "",
      BankName: b.bankName || "",
      BankIFSC: b.bankIfsc || "",
      BankBranchName: b.bankBranchName || "",
      // HR can override the numbered services list per agreement on the generate form; blank rows dropped.
      ServicesIntro: typeof b.servicesIntro === "string" ? b.servicesIntro.trim() : "",
      Services: (Array.isArray(b.services) && b.services.map((x: any) => String(x).trim()).filter(Boolean).length
        ? b.services.map((x: any) => String(x).trim()).filter(Boolean)
        : (tpl?.services as any)) || ["Technical Analysis", "Data Analysis", "QA", "Professional Services"],
    },
  };
}

// "2 months (1st June 2026 to 31st July 2026)" — matches the reference Internship Letter's own
// wording exactly (whole months when the span lines up, otherwise falls back to a day count).
function durationText(start: Date, end: Date): string {
  const s = new Date(start), e = new Date(end);
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  const wholeMonths = months > 0 && e.getDate() >= s.getDate() - 1;
  const label = wholeMonths ? `${months} month${months === 1 ? "" : "s"}` : `${Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000))} days`;
  return `${label} (${dstr(s)} to ${dstr(e)})`;
}

async function defaultSaTemplate(countryCode: string, businessUnitId?: number | null) {
  return (
    (await buFirst(businessUnitId, (bu) => prisma.hrServiceAgreementTemplate.findFirst({ where: { countryCode, ...bu }, orderBy: { isDefault: "desc" } }))) ||
    (await prisma.hrServiceAgreementTemplate.findFirst({ where: { isDefault: true } })) ||
    (await prisma.hrServiceAgreementTemplate.findFirst())
  );
}

router.post("/offers/:id/service-agreement/generate", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (!usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Service Agreement is only for CONTRACTOR/INTERN offers." });
  if (!["DRAFT", "GENERATED", "PREVIEWED"].includes(offer.status)) return res.status(400).json({ error: `Cannot generate — offer is already ${offer.status}.` });
  const b = req.body || {};
  // "No Cost to Company" — explicit checkbox (Contractor or Intern): CTC/monthly compensation
  // becomes optional and is stored as 0; Confirm Joining below skips creating any
  // CtcApprovalRequest for this offer, so it never reaches Finance approval or a CtcRecord, and
  // Employee.noCostToCompany (set at Confirm Joining) excludes them from headcount/cost everywhere.
  const noCostToCompany = !!b.noCostToCompany;
  if (!noCostToCompany && !b.monthlyCompensation && !b.compensationAmount) return res.status(400).json({ error: "monthlyCompensation is required (or check \"No Cost to Company\")." });

  const code = offer.reservedEmpNo || (await nextContractorCode());
  const tpl = await defaultSaTemplate(offer.countryCode, offer.businessUnitId);
  const fields = await buildServiceAgreementFields(offer, tpl, b);
  const sa = await prisma.serviceAgreement.upsert({
    where: { offerId: id },
    update: { templateId: fields.templateId, dynamicFields: fields.dynamicFields as any, clauses: fields.clauses as any, monthlyCompensation: fields.monthlyCompensation, noCostToCompany: fields.noCostToCompany, status: "GENERATED" },
    create: { offerId: id, templateId: fields.templateId, dynamicFields: fields.dynamicFields as any, clauses: fields.clauses as any, monthlyCompensation: fields.monthlyCompensation, noCostToCompany: fields.noCostToCompany, status: "GENERATED" },
  });
  const updated = await prisma.offer.update({ where: { id }, data: { reservedEmpNo: code, status: "GENERATED", ...offerCompSync(offer, fields) }, include: OFFER_INCLUDE as any });
  await audit(id, req.user!.id, "SERVICE_AGREEMENT_GENERATE", offer.status, "GENERATED", `Contractor code ${code} reserved (hidden until joining is confirmed)`);
  emitEsignUpdate("SERVICE_AGREEMENT", id, sa);
  res.json({ offer: updated, serviceAgreement: sa });
});

// Regenerate: same shape as the Offer's own /regenerate — recompute + replace in place (unlike
// the Offer Letter, a Service Agreement has no version history table; it's one row per offer,
// same as AppointmentLetter's own upsert-in-place pattern).
router.post("/offers/:id/service-agreement/regenerate", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (!usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Service Agreement is only for CONTRACTOR/INTERN offers." });
  const existing = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  if (!existing) return res.status(400).json({ error: "Generate the Service Agreement first." });
  // Same escape hatch as the Offer's own /regenerate — a closed (Declined/Expired/Withdrawn/
  // Cancelled) Service Agreement can still be regenerated as HR's restart path; only real forward
  // progress (an active Employee already exists) is blocked.
  if (["JOINING_CONFIRMED"].includes(offer.status)) {
    return res.status(400).json({ error: `Cannot regenerate — offer is already ${offer.status}.` });
  }
  const b = req.body || {};
  const tpl = await defaultSaTemplate(offer.countryCode, offer.businessUnitId);
  const merged = { ...b, services: b.services ?? (existing.dynamicFields as any)?.Services, servicesIntro: b.servicesIntro ?? (existing.dynamicFields as any)?.ServicesIntro, noCostToCompany: b.noCostToCompany ?? existing.noCostToCompany, compensationType: b.compensationType ?? (existing.dynamicFields as any)?.CompensationType, compensationAmount: b.compensationAmount ?? (b.monthlyCompensation != null ? undefined : (existing.dynamicFields as any)?.CompensationAmount), monthlyCompensation: b.monthlyCompensation ?? existing.monthlyCompensation, slaName: b.slaName ?? (existing.dynamicFields as any)?.ContractorName, aadharNumber: b.aadharNumber ?? (existing.dynamicFields as any)?.AadharNumber, contractorAddress: b.contractorAddress ?? (existing.dynamicFields as any)?.ContractorAddress, bankAccountNumber: b.bankAccountNumber ?? (existing.dynamicFields as any)?.BankAccountNumber, bankName: b.bankName ?? (existing.dynamicFields as any)?.BankName, bankIfsc: b.bankIfsc ?? (existing.dynamicFields as any)?.BankIFSC, bankBranchName: b.bankBranchName ?? (existing.dynamicFields as any)?.BankBranchName, effectiveDate: b.effectiveDate ?? (existing.dynamicFields as any)?.EffectiveDate, internshipEndDate: b.internshipEndDate ?? (existing.dynamicFields as any)?.EndDateRaw, internshipLocation: b.internshipLocation ?? (existing.dynamicFields as any)?.Location };
  const fields = await buildServiceAgreementFields(offer, tpl, merged);
  const sa = await prisma.serviceAgreement.update({ where: { offerId: id }, data: { templateId: fields.templateId, dynamicFields: fields.dynamicFields as any, clauses: fields.clauses as any, monthlyCompensation: fields.monthlyCompensation, noCostToCompany: fields.noCostToCompany, status: "GENERATED" } });
  const updated = await prisma.offer.update({ where: { id }, data: { status: "GENERATED", ...offerCompSync(offer, fields) }, include: OFFER_INCLUDE as any });
  await audit(id, req.user!.id, "SERVICE_AGREEMENT_REGENERATE", offer.status, "GENERATED", `Contractor code ${offer.reservedEmpNo} kept — ${b.reason || "HR-requested change"}`);
  emitEsignUpdate("SERVICE_AGREEMENT", id, sa);
  // A new revision means anything previously sent for e-signature (or already declined) points at
  // stale content now — void it so nothing old is still signable.
  await voidInFlightAgreements(id).catch(() => {});
  res.json({ offer: updated, serviceAgreement: sa });
});

router.post("/offers/:id/service-agreement/preview", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  if (!offer || !sa) return res.status(404).json({ error: "Service Agreement not found — generate it first." });
  if (offer.status === "GENERATED") {
    await prisma.offer.update({ where: { id }, data: { status: "PREVIEWED" } });
    await prisma.serviceAgreement.update({ where: { offerId: id }, data: { status: "PREVIEWED" } });
    await audit(id, req.user!.id, "SERVICE_AGREEMENT_PREVIEW", "GENERATED", "PREVIEWED");
    emitEsignUpdate("SERVICE_AGREEMENT", id, { status: "PREVIEWED" });
  }
  res.json({ ok: true });
});

// INTERN's Internship Letter fields (fillTemplate vals) — candidate/offer info the letter itself
// mentions, plus the dates/duration/location captured on the Service Agreement stage.
function internshipLetterVals(offer: any, sa: any) {
  const f = (sa.dynamicFields || {}) as any;
  return {
    CandidateName: offer.candidateName, EmployeeName: offer.candidateName,
    Department: offer.department || "", Designation: offer.designation || "", Position: offer.designation || "",
    ReportingManager: offer.reportingManager || "", Location: f.Location || "",
    StartDate: f.StartDate || "", EndDate: f.EndDate || "", DurationText: f.DurationText || "",
    Date: dstr(new Date()),
  };
}
async function renderServiceAgreementOrLetterPdf(offer: any, sa: any, out: any) {
  const sig = await getHrSignature(offer.businessUnitId);
  if (offer.employmentType === "INTERN") {
    const tpl = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "INTERNSHIP_LETTER", ...bu } }));
    const vals = internshipLetterVals(offer, sa);
    const subject = fillTemplate(tpl?.subject || "Internship Confirmation — {{CandidateName}}", vals);
    const body = fillTemplate(tpl?.body || "", vals);
    renderInternshipLetterPdf({ subject, body, ...sig }, out);
    return;
  }
  renderServiceAgreementPdf({ dynamicFields: sa.dynamicFields as any, clauses: sa.clauses as any as ServiceAgreementClause[], ...sig }, out);
}

router.get("/offers/:id/service-agreement/pdf", async (req, res) => {
  const id = Number(req.params.id);
  const [sa, offer] = await Promise.all([
    prisma.serviceAgreement.findUnique({ where: { offerId: id } }),
    prisma.offer.findUnique({ where: { id } }),
  ]);
  if (!sa || !offer) return res.status(404).json({ error: "Service Agreement not found" });
  // Signed copy replaces the generated draft everywhere this route is linked from, same as the
  // Offer Letter's own /pdf above.
  if (sa.signedFileData) {
    res.setHeader("Content-Type", signedDocContentType(sa.signedFileName || ""));
    res.setHeader("Content-Disposition", `inline; filename="${sa.signedFileName}"`);
    return res.send(Buffer.from(sa.signedFileData, "base64"));
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="ServiceAgreement_${id}.pdf"`);
  await renderServiceAgreementOrLetterPdf(offer, sa, res);
});

router.post("/offers/:id/service-agreement/send", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  if (!offer || !sa) return res.status(404).json({ error: "Service Agreement not found — generate it first." });

  const isInternLetter = offer.employmentType === "INTERN";
  const tplMail = isInternLetter
    ? await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "INTERNSHIP_LETTER", ...bu } }))
    : await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "SERVICE_AGREEMENT_EMAIL", ...bu } }));
  const f = sa.dynamicFields as any;
  const vals = isInternLetter ? internshipLetterVals(offer, sa)
    : { ContractorFirstName: firstName(offer.candidateName), ContractorName: offer.candidateName, EffectiveDate: dstr(f.EffectiveDate), MonthlyCompensationAmount: f.MonthlyCompensationAmount, OfferRef: offer.offerRef,
      // Structure chosen at generation (Annual / Monthly / Daily) — the email must quote that, not always monthly.
      ...(() => { const t = f.CompensationType, amt = f.CompensationAmount != null ? rsAmount(Number(f.CompensationAmount)) : f.MonthlyCompensationAmount;
        return t === "DAILY" ? { CompensationLabel: "Daily Compensation", CompensationDisplay: `${amt} per working day` }
          : t === "ANNUAL" ? { CompensationLabel: "Annual Compensation", CompensationDisplay: `${amt} per annum` }
          : { CompensationLabel: "Monthly Compensation", CompensationDisplay: f.MonthlyCompensationAmount }; })() };
  const subject = fillTemplate(tplMail?.subject || (isInternLetter ? "Internship Confirmation — {{CandidateName}}" : "Your Service Agreement from GenAquarius"), vals);
  const mailBody = (tplMail?.body || (isInternLetter ? "" : "Please find your Service Agreement attached."))
    // Stored templates hardcode "Monthly Compensation: {{MonthlyCompensationAmount}}" — swap in the chosen structure.
    .replace(/Monthly Compensation:\s*\{\{\s*MonthlyCompensationAmount\s*\}\}/g, "{{CompensationLabel}}: {{CompensationDisplay}}");
  const html = fillTemplate(mailBody, vals).replace(/\n/g, "<br>");
  let sent = false, reason = "";
  if (!mailEnabled()) reason = "Email not configured (Microsoft Graph)";
  else {
    try {
      const fileLabel = isInternLetter ? "InternshipLetter" : "ServiceAgreement";
      const pdf = await renderToBuffer((out) => renderServiceAgreementOrLetterPdf(offer, sa, out));
      const r = await notifyMail("SERVICE_AGREEMENT_SEND", { fromUpn: req.user!.email, to: offer.candidateEmail, subject, html, attachments: [{ name: `${fileLabel}_${offer.offerRef}.pdf`, contentBytes: pdf.toString("base64"), contentType: "application/pdf" }] });
      sent = r.sent; if (!r.sent) reason = r.reason || "Not sent";
    } catch (e: any) { reason = e?.message || "Send failed"; }
  }

  await prisma.serviceAgreement.update({ where: { offerId: id }, data: { status: "SENT" } });
  const updated = await prisma.offer.update({ where: { id }, data: { status: "SENT", sentAt: new Date() }, include: OFFER_INCLUDE as any });
  await audit(id, req.user!.id, "SERVICE_AGREEMENT_SEND", offer.status, "SENT", sent ? `Emailed to ${offer.candidateEmail}` : `Not emailed — ${reason}`);
  emitEsignUpdate("SERVICE_AGREEMENT", id, { status: "SENT" });
  res.json({ ...updated, emailSent: sent, emailReason: sent ? undefined : reason });
});

// HR's manual "the contractor confirmed over email" step for the Service Agreement — the
// plain-email-flow equivalent of what Adobe Sign captures automatically. Confirm Joining for a
// Contractor is gated on this (or the Adobe Sign equivalent), not just on a Service Agreement
// having been generated — generating/sending one is not the same as the contractor confirming it.
// Confirm Acceptance always requires proof — either an Adobe Sign completion, or the signed copy
// uploaded manually (see /service-agreement/signed) — whether HR sent it for signature, emailed
// it plainly, or is skipping Send entirely. Same rule regardless of how it got to this point,
// matching the Offer Letter's own /accept (which has always required this unconditionally).
router.post("/offers/:id/service-agreement/confirm-acceptance", async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const offer = await prisma.offer.findUnique({ where: { id } });
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  if (!offer || !sa) return res.status(404).json({ error: "Service Agreement not found" });
  if (sa.status === "ACCEPTED" || sa.status === "DECLINED") return res.status(400).json({ error: "Already recorded." });
  const wasSent = offer.status === "SENT";
  const viaEsign = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType: "SERVICE_AGREEMENT", docId: id } } });
  if (!viaEsign && !sa.signedFileData) return res.status(400).json({ error: "Upload the signed Service Agreement before confirming acceptance." });
  await prisma.serviceAgreement.update({ where: { offerId: id }, data: { status: "ACCEPTED" } });
  await audit(id, req.user!.id, "SERVICE_AGREEMENT_ACCEPT", sa.status, "ACCEPTED", wasSent ? "Confirmed manually by HR (email flow)" : "Signed Service Agreement uploaded directly — Send skipped.");
  // A Contractor has no separate Offer Letter — the Service Agreement IS the "sent" document, so
  // confirming its acceptance is also the Offer's own acceptance (mirrors AcceptancePanel's
  // "Record Candidate Acceptance" for the email flow, and reconcileAgreement's digital path).
  // Also applies when skipping Send (offer.status still GENERATED/PREVIEWED) — every downstream
  // gate keying off offer.status === "ACCEPTED"/"SENT" needs this regardless of which path got here.
  if (["SENT", "GENERATED", "PREVIEWED"].includes(offer.status)) {
    await prisma.offer.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptanceMethod: b.acceptanceMethod || (wasSent ? "EMAIL_REPLY" : "SIGNED_COPY"), acceptanceNote: b.acceptanceNote || null } });
    await prisma.offerAuditLog.create({ data: { offerId: id, action: "ACCEPT", fromStatus: offer.status, toStatus: "ACCEPTED", note: "Service Agreement confirmed manually by HR" } }).catch(() => {});
    // Was missing here (unlike the Adobe Sign webhook's equivalent branch) — without this, the
    // manual "HR confirms over email" path never marked the acceptance stage COMPLETED, so
    // IT Provisioning stayed locked forever for anyone using the plain-email flow instead of
    // Adobe Sign, even though the offer itself had already moved to ACCEPTED.
    await ensureOfferPinnedToWorkflow(id);
    await completeStageByType(id, "OFFER_ACCEPTANCE", req.user!.id);
  }
  emitEsignUpdate("SERVICE_AGREEMENT", id, { status: "ACCEPTED" });
  res.json({ ok: true });
});

// HR's explicit "I opened and reviewed the signed document" click for a workflow with no
// dedicated OFFER_ACCEPTANCE stage of its own (Intern's collapsed workflow — see
// reconcileAgreement in routes/shared/adobeSign.ts, which deliberately skips auto-completing
// this same stage on signature so the wizard doesn't jump past HR's review). Requires the
// candidate to have actually accepted (Adobe Sign or manual) first — this only advances the
// stage, it never records acceptance itself.
router.post("/offers/:id/acknowledge-acceptance", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (!["ACCEPTED"].includes(offer.status) && !["JOINING_CONFIRMED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED"].includes(offer.status)) {
    return res.status(400).json({ error: "Candidate has not accepted yet." });
  }
  await ensureOfferPinnedToWorkflow(id);
  await completeStageByType(id, "OFFER_ACCEPTANCE", req.user!.id);
  await audit(id, req.user!.id, "ACKNOWLEDGE_ACCEPTANCE", offer.status, offer.status, "HR reviewed the signed document and proceeded");
  res.json({ ok: true });
});

router.post("/offers/:id/service-agreement/decline", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const sa = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  if (!offer || !sa) return res.status(404).json({ error: "Service Agreement not found" });
  if (sa.status === "ACCEPTED" || sa.status === "DECLINED") return res.status(400).json({ error: "Already recorded." });
  await prisma.serviceAgreement.update({ where: { offerId: id }, data: { status: "DECLINED" } });
  await audit(id, req.user!.id, "SERVICE_AGREEMENT_DECLINE", sa.status, "DECLINED", "Recorded manually by HR (email flow)");
  if (["SENT", "GENERATED", "PREVIEWED"].includes(offer.status)) {
    await prisma.offer.update({ where: { id }, data: { status: "DECLINED" } });
    await prisma.offerAuditLog.create({ data: { offerId: id, action: "DECLINED", fromStatus: offer.status, toStatus: "DECLINED", note: "Service Agreement declined manually by HR" } }).catch(() => {});
  }
  emitEsignUpdate("SERVICE_AGREEMENT", id, { status: "DECLINED" });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ Appointment Letter ----
// Read-only preview of the next auto-generated Employee ID — shown in the Generate Appointment
// Letter form's Employee ID text box before HR submits (doesn't reserve anything; the real
// reservation still happens in /appointment/generate below, same as before).
router.get("/offers/:id/next-emp-no", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, select: { reservedEmpNo: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  res.json({ empNo: offer.reservedEmpNo || (await nextEmpNo()) });
});

router.post("/offers/:id/appointment/generate", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { businessUnit: true, employee: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (usesServiceAgreement(offer.employmentType)) return res.status(400).json({ error: "Contractors/Interns don't get an Appointment Letter — Confirm Joining directly after acceptance." });
  if (["DRAFT", "GENERATED", "PREVIEWED", "SENT", "DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"].includes(offer.status)) {
    return res.status(400).json({ error: "The candidate must accept the offer before an appointment letter can be generated." });
  }
  // The workflow engine is the source of truth for WHEN (relative to Document Collection/IT
  // Provisioning/Employee Activation, all HR-reorderable) — see engine/workflow.ts.
  const gate = await requireStageUnlocked(id, "APPOINTMENT_GENERATION");
  if (!gate.ok) return res.status(400).json({ error: gate.error });
  if (!offer.resumeFileData) return res.status(400).json({ error: "Upload the candidate's resume before generating the Appointment Letter." });

  const b = req.body || {};
  // If Employee Activation already ran (the default order), this offer already has a real
  // Employee — reuse that empNo, no new reservation. Otherwise (HR configured Appointment before
  // Activation) fall back to the original reserve-now-confirm-later behavior.
  let empNo = offer.employee?.empNo || offer.reservedEmpNo || (await nextEmpNo());
  const requestedEmpNo = String(b.empNo || "").trim();
  if (!offer.employee && requestedEmpNo && requestedEmpNo !== offer.reservedEmpNo) {
    const [dupEmployee, dupOffer] = await Promise.all([
      prisma.employee.findFirst({ where: { empNo: requestedEmpNo } }),
      prisma.offer.findFirst({ where: { reservedEmpNo: requestedEmpNo, id: { not: id } } }),
    ]);
    if (dupEmployee || dupOffer) return res.status(400).json({ error: `Employee ID "${requestedEmpNo}" is already in use — choose a different one.` });
    empNo = requestedEmpNo;
  }
  if (!String(b.emergencyContactPhone || "").trim()) return res.status(400).json({ error: "Emergency Contact Number is required." });
  const tpl = await buFirst(offer.businessUnitId, (bu) => prisma.hrAppointmentTemplate.findFirst({ where: { countryCode: offer.countryCode, ...bu }, orderBy: { isDefault: "desc" } }))
    || await prisma.hrAppointmentTemplate.findFirst({ where: { isDefault: true } }) || await prisma.hrAppointmentTemplate.findFirst();
  // Falls back to whatever was already captured on Generate Offer — HR isn't asked twice for the
  // same terms unless they want to change something at this later stage.
  const dynamicFields = {
    EmployeeName: offer.candidateName, EmployeeId: empNo,
    // Formatted to a plain date string ("04 Oct 2026") BEFORE storage — dynamicFields is a Json
    // column, and Prisma serializes a raw Date value through JSON.stringify (Date.toJSON() ->
    // ISO string with the time component), which permanently loses fillTemplate's `instanceof
    // Date` formatting path the moment this record is saved and re-read. Pre-formatting here is
    // what actually survives the round-trip, not just what renders correctly on first generate.
    DateOfAppointment: dstr(b.dateOfAppointment || offer.proposedJoiningDate), JoiningDate: dstr(b.joiningDate || offer.proposedJoiningDate),
    JobTitle: offer.role, Designation: offer.designation, Department: b.department || offer.department || "",
    BusinessUnit: offer.businessUnit?.name || "", ReportingManager: b.reportingManager || offer.reportingManager || "",
    WorkLocation: b.workLocation || offer.workLocation || "Office", Ctc: money(offer.ctc, offer.countryCode === "US" ? "USD" : offer.countryCode === "CANADA" ? "CAD" : "INR"),
    EmploymentType: b.employmentType || offer.employmentBasis || "Full Time", NoticePeriod: b.noticePeriod || offer.noticePeriod || "2 months", ProbationPeriod: b.probationPeriod || offer.probationPeriod || "2 months",
    EmergencyContactPhone: b.emergencyContactPhone,
    Phone: offer.candidatePhone || "",
  };
  const appt = await prisma.appointmentLetter.upsert({
    where: { offerId: id },
    update: { empNo, templateId: tpl?.id, dynamicFields: dynamicFields as any, clauses: (tpl?.clauses as any) || [], issuanceTiming: b.issuanceTiming || "ON_JOINING", status: "DRAFT" },
    create: { offerId: id, empNo, templateId: tpl?.id, dynamicFields: dynamicFields as any, clauses: (tpl?.clauses as any) || [], issuanceTiming: b.issuanceTiming || "ON_JOINING", status: "DRAFT" },
  });
  const updated = await prisma.offer.update({ where: { id }, data: { reservedEmpNo: empNo, status: "APPOINTMENT_GENERATED" } });
  await audit(id, req.user!.id, "APPOINTMENT_GENERATE", "ACCEPTED", "APPOINTMENT_GENERATED", `Employee ID ${empNo} reserved (hidden until joining is confirmed)`);
  emitEsignUpdate("APPOINTMENT_LETTER", id, appt);
  res.json({ offer: updated, appointmentLetter: appt });
});

router.post("/offers/:id/appointment/preview", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: id } });
  if (!offer || !appt) return res.status(404).json({ error: "Appointment letter not found — generate it first." });
  if (offer.status === "APPOINTMENT_GENERATED") {
    await prisma.offer.update({ where: { id }, data: { status: "APPOINTMENT_PREVIEWED" } });
    await prisma.appointmentLetter.update({ where: { offerId: id }, data: { status: "PREVIEWED" } });
    await audit(id, req.user!.id, "APPOINTMENT_PREVIEW", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED");
    emitEsignUpdate("APPOINTMENT_LETTER", id, { status: "PREVIEWED" });
  }
  res.json({ ok: true });
});

router.get("/offers/:id/appointment/pdf", async (req, res) => {
  const id = Number(req.params.id);
  const [appt, offer] = await Promise.all([
    prisma.appointmentLetter.findUnique({ where: { offerId: id } }),
    prisma.offer.findUnique({ where: { id }, select: { businessUnitId: true } }),
  ]);
  if (!appt) return res.status(404).json({ error: "Appointment letter not found" });
  // Signed copy replaces the generated draft everywhere this route is linked from, same as the
  // Offer Letter's own /pdf above.
  if (appt.signedFileData) {
    res.setHeader("Content-Type", signedDocContentType(appt.signedFileName || ""));
    res.setHeader("Content-Disposition", `inline; filename="${appt.signedFileName}"`);
    return res.send(Buffer.from(appt.signedFileData, "base64"));
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Appointment_${appt.empNo}.pdf"`);
  renderAppointmentPdf({ empNo: appt.empNo, dynamicFields: appt.dynamicFields as any, clauses: appt.clauses as any, ...(await getHrSignature(offer?.businessUnitId)) }, res);
});

router.post("/offers/:id/appointment/issue", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: id } });
  if (!offer || !appt) return res.status(404).json({ error: "Appointment letter not found" });

  const tplMail = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "APPOINTMENT_EMAIL", ...bu } }));
  const fields = appt.dynamicFields as any;
  const subject = fillTemplate(tplMail?.subject || "Your Appointment Letter", fields);
  const html = fillTemplate(tplMail?.body || "Please find your appointment letter attached.", fields).replace(/\n/g, "<br>");
  let sent = false, reason = "";
  if (!mailEnabled()) reason = "Email not configured (Microsoft Graph)";
  else {
    try {
      const sig = await getHrSignature(offer.businessUnitId);
      const pdf = await renderToBuffer((out) => renderAppointmentPdf({ empNo: appt.empNo, dynamicFields: fields, clauses: appt.clauses as any, ...sig }, out));
      const r = await notifyMail("APPOINTMENT_SEND", { fromUpn: req.user!.email, to: offer.candidateEmail, subject, html, attachments: [{ name: `Appointment_${appt.empNo}.pdf`, contentBytes: pdf.toString("base64"), contentType: "application/pdf" }] });
      sent = r.sent; if (!r.sent) reason = r.reason || "Not sent";
    } catch (e: any) { reason = e?.message || "Send failed"; }
  }

  await prisma.appointmentLetter.update({ where: { offerId: id }, data: { status: "ISSUED", issuedAt: new Date() } });
  const updated = await prisma.offer.update({ where: { id }, data: { status: "APPOINTMENT_ISSUED" } });
  await audit(id, req.user!.id, "APPOINTMENT_ISSUE", offer.status, "APPOINTMENT_ISSUED", sent ? `Emailed to ${offer.candidateEmail}` : `Not emailed — ${reason}. Employee ${appt.empNo} still hidden — not active until joining is confirmed.`);
  emitEsignUpdate("APPOINTMENT_LETTER", id, { status: "ISSUED" });
  res.json({ offer: updated, emailSent: sent, emailReason: sent ? undefined : reason });
});

// HR's manual "the candidate confirmed over email" step for the Appointment Letter — the
// plain-email-flow equivalent of what Adobe Sign captures automatically in reconcileAgreement()
// when the letter is sent for e-signature instead. Confirm Joining is gated on this (or the
// Adobe Sign equivalent) so activation never happens before the candidate has actually confirmed.
// Skips Issue (emailing it) entirely when a signed copy already exists — straight from
// APPOINTMENT_GENERATED/PREVIEWED to ACCEPTED, requiring the uploaded signed file as proof (same
// rule as the Offer Letter's own skip-Send path above). Still also sets offer.status to
// APPOINTMENT_ISSUED alongside ACCEPTED so every existing downstream gate that checks for it
// (Confirm Joining, dashboards, etc.) keeps working unchanged — issuance is a formality being
// backfilled here, not skipped in spirit (the candidate genuinely does have the letter, on paper).
router.post("/offers/:id/appointment/confirm-acceptance", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: id } });
  if (!offer || !appt) return res.status(404).json({ error: "Appointment letter not found" });
  const wasIssued = offer.status === "APPOINTMENT_ISSUED";
  if (!wasIssued && !["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(offer.status)) {
    return res.status(400).json({ error: `Cannot accept — offer is already ${offer.status}.` });
  }
  if (appt.status === "ACCEPTED" || appt.status === "DECLINED") return res.status(400).json({ error: "Already recorded." });
  // Required unconditionally — issued-and-emailed or skipping Issue entirely, same rule either
  // way (matches the Offer Letter's and Service Agreement's own confirm-acceptance routes).
  const viaEsign = await prisma.esignAgreement.findUnique({ where: { docType_docId: { docType: "APPOINTMENT_LETTER", docId: id } } });
  if (!viaEsign && !appt.signedFileData) {
    return res.status(400).json({ error: "Upload the signed appointment letter before confirming acceptance." });
  }
  await prisma.appointmentLetter.update({ where: { offerId: id }, data: { status: "ACCEPTED" } });
  if (!wasIssued) await prisma.offer.update({ where: { id }, data: { status: "APPOINTMENT_ISSUED" } });
  await audit(id, req.user!.id, "APPOINTMENT_ACCEPT", appt.status, "ACCEPTED", wasIssued ? "Confirmed manually by HR (email flow)" : "Signed appointment letter uploaded directly — Issue skipped.");
  await completeStageByType(id, "APPOINTMENT_ACCEPTANCE", req.user!.id);
  emitEsignUpdate("APPOINTMENT_LETTER", id, { status: "ACCEPTED" });
  res.json({ ok: true });
});

router.post("/offers/:id/appointment/decline", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: id } });
  if (!offer || !appt) return res.status(404).json({ error: "Appointment letter not found" });
  if (appt.status === "ACCEPTED" || appt.status === "DECLINED") return res.status(400).json({ error: "Already recorded." });
  await prisma.appointmentLetter.update({ where: { offerId: id }, data: { status: "DECLINED" } });
  await audit(id, req.user!.id, "APPOINTMENT_DECLINE", appt.status, "DECLINED", "Recorded manually by HR (email flow)");
  emitEsignUpdate("APPOINTMENT_LETTER", id, { status: "DECLINED" });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ Mandatory Document Collection ----
// HR sends a secure, unauthenticated upload link to the candidate's personal email
// (Offer.candidateEmail) once the Offer is Accepted. The candidate-facing side lives in
// routes/public/documentUpload.ts (mounted OUTSIDE the auth gate, token-only). Required doc types
// come from the workflow engine (resolveRequiredDocuments) — configurable, Aadhaar always
// excluded, PAN skipped if already captured.
// Auto-creates/seeds the request (no email sent) so HR always sees the document list ready for
// either manual upload or Send — the candidate-email link is one option, not a prerequisite.
router.get("/offers/:id/document-collection", async (req, res) => {
  const id = Number(req.params.id);
  const gate = await requireStageUnlocked(id, "DOCUMENT_COLLECTION");
  if (!gate.ok) return res.json(null);
  await ensureDocumentCollectionRequest(id);
  const request = await prisma.documentCollectionRequest.findUnique({ where: { offerId: id }, include: { documents: true } });
  res.json(request);
});

// Creates the request (if missing) and seeds/reconciles its per-doc-type rows against whatever's
// currently required — shared by the candidate-email path (/send) and HR's own manual-upload path,
// so either can be used first ("both options should be there" — HR request). A re-send/re-touch
// (e.g. after HR unchecks a document in the Workflow Builder) keeps whatever's already uploaded for
// still-required types and drops rows no longer required.
async function ensureDocumentCollectionRequest(id: number) {
  const requiredDocs = await resolveRequiredDocuments(id);
  const request = await prisma.documentCollectionRequest.upsert({
    where: { offerId: id },
    update: {},
    create: { offerId: id, token: crypto.randomBytes(24).toString("hex") },
  });
  await prisma.candidateDocument.deleteMany({ where: { requestId: request.id, docType: { notIn: requiredDocs.map((d) => d.docType) } } });
  for (const d of requiredDocs) {
    await prisma.candidateDocument.upsert({
      where: { requestId_docType: { requestId: request.id, docType: d.docType } },
      update: { label: d.label, multipleFiles: d.multipleFiles, required: d.required },
      create: { requestId: request.id, docType: d.docType, label: d.label, multipleFiles: d.multipleFiles, required: d.required, status: "PENDING", files: [] },
    });
  }
  return { request, requiredDocs };
}

router.post("/offers/:id/document-collection/send", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const gate = await requireStageUnlocked(id, "DOCUMENT_COLLECTION");
  if (!gate.ok) return res.status(400).json({ error: gate.error });

  const { requiredDocs } = await ensureDocumentCollectionRequest(id);
  const request = await prisma.documentCollectionRequest.update({ where: { offerId: id }, data: { sentAt: new Date(), sentById: req.user!.id } });

  // Editable in HR Settings -> Email Templates (key DOCUMENT_COLLECTION_REQUEST_EMAIL), same
  // {{Placeholder}}/fillTemplate pattern as every other HR email — falls back to a sensible default
  // when no template row exists yet (e.g. on a fresh install before seedHr.ts's default runs).
  const publicUrl = `${config.clientOrigin}/document-upload/${request.token}`;
  const tplMail = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "DOCUMENT_COLLECTION_REQUEST_EMAIL", ...bu } }));
  const vals = {
    CandidateFirstName: firstName(offer.candidateName), OfferRef: offer.offerRef,
    DocumentList: requiredDocs.map((d) => `• ${d.label}${d.required ? "" : " (optional)"}`).join("<br>"),
    UploadLink: `<a href="${publicUrl}">Upload Documents</a>`,
  };
  const subject = fillTemplate(tplMail?.subject || "Action required: submit your onboarding documents", vals);
  const html = fillTemplate(
    tplMail?.body || "Hi {{CandidateFirstName}},<br><br>Please submit the following documents using the secure link below:<br><br>{{DocumentList}}<br><br>{{UploadLink}}<br><br>Regards,<br>GenAquarius HR",
    vals,
  );
  const r = await notifyMail("DOCUMENT_COLLECTION_REQUEST", { fromUpn: req.user!.email, to: offer.candidateEmail, subject, html });
  await audit(id, req.user!.id, "DOCUMENT_COLLECTION_SEND", offer.status, offer.status, r.sent ? `Emailed to ${offer.candidateEmail}` : `Not emailed — ${r.reason || "unknown"}`);
  emitEsignUpdate("OFFER", id, { documentCollectionSent: true });
  res.json({ ...request, emailSent: r.sent, emailReason: r.sent ? undefined : r.reason, requiredDocs });
});

// Section 17 — "IF all required documents = APPROVED THEN move to Stage 4". Called after every
// VERIFY (candidate-review path) and every HR direct-upload (self-verified) — a no-op unless every
// currently-required document (resolveRequiredDocuments, so an HR-added/removed doc type is always
// re-checked against the live config) is VERIFIED. Idempotent — completeStageByType/`completedAt`
// are themselves no-ops once already done.
async function maybeAutoCompleteDocumentCollection(id: number, byUserId?: number) {
  const request = await prisma.documentCollectionRequest.findUnique({ where: { offerId: id }, include: { documents: true } });
  if (!request || request.completedAt) return;
  const requiredDocs = await resolveRequiredDocuments(id);
  const requiredTypes = new Set(requiredDocs.filter((d) => d.required).map((d) => d.docType));
  // Optional documents (e.g. Contractor's Salary Slips) never block — only required ones need to
  // be VERIFIED for the stage to auto-complete.
  const relevant = request.documents.filter((d) => requiredTypes.has(d.docType));
  if (!relevant.length || relevant.some((d) => d.status !== "VERIFIED")) return;
  await prisma.documentCollectionRequest.update({ where: { id: request.id }, data: { completedAt: new Date() } });
  await completeStageByType(id, "DOCUMENT_COLLECTION", byUserId);
  await audit(id, byUserId || undefined, "DOCUMENT_COLLECTION_COMPLETE", null, null, "All required documents approved — auto-advanced.");
  emitEsignUpdate("OFFER", id, { documentCollectionCompleted: true });
}

router.post("/offers/:id/document-collection/verify", async (req, res) => {
  const id = Number(req.params.id);
  const { candidateDocumentId, action, note } = req.body || {};
  const doc = await prisma.candidateDocument.findFirst({ where: { id: Number(candidateDocumentId), request: { offerId: id } } });
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (!["VERIFY", "REJECT"].includes(action)) return res.status(400).json({ error: "action must be VERIFY or REJECT" });
  const updated = await prisma.candidateDocument.update({
    where: { id: doc.id },
    data: action === "VERIFY"
      ? { status: "VERIFIED", verifiedById: req.user!.id, verifiedAt: new Date(), rejectionNote: null }
      : { status: "REJECTED", verifiedById: req.user!.id, verifiedAt: new Date(), rejectionNote: note || "Please re-upload." },
  });
  await audit(id, req.user!.id, action === "VERIFY" ? "DOCUMENT_APPROVE" : "DOCUMENT_REJECT", null, null, `${updated.label}${action === "REJECT" ? ` — ${updated.rejectionNote}` : ""}`);
  if (action === "VERIFY") await maybeAutoCompleteDocumentCollection(id, req.user!.id);
  emitEsignUpdate("OFFER", id, { documentVerified: updated.docType, status: updated.status });
  res.json(updated);
});

// Section 5.3 — one consolidated email listing every currently-REJECTED document + its reason,
// rather than one email per rejection. HR triggers this explicitly once they're done reviewing a
// batch (they may reject several documents across a few /verify clicks before sending one notice).
router.post("/offers/:id/document-collection/notify-rejections", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const request = await prisma.documentCollectionRequest.findUnique({ where: { offerId: id }, include: { documents: true } });
  const rejected = (request?.documents || []).filter((d) => d.status === "REJECTED");
  if (!rejected.length) return res.status(400).json({ error: "No rejected documents to notify the candidate about." });

  const publicUrl = `${config.clientOrigin}/document-upload/${request!.token}`;
  const listHtml = rejected.map((d, i) => `${i + 1}. ${d.label}<br>&nbsp;&nbsp;&nbsp;Reason: ${d.rejectionNote || "Please re-upload."}`).join("<br>");
  const tplMail = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "DOCUMENT_REJECTION_EMAIL", ...bu } }));
  const vals = {
    CandidateFirstName: firstName(offer.candidateName), OfferRef: offer.offerRef,
    RejectedDocumentsList: listHtml, UploadLink: `<a href="${publicUrl}">Upload Documents</a>`,
  };
  const subject = fillTemplate(tplMail?.subject || "Action required: documents needing re-upload", vals);
  const html = fillTemplate(
    tplMail?.body || "Hi {{CandidateFirstName}},<br><br>A few documents need to be re-uploaded:<br><br>Documents Requiring Re-upload:<br>{{RejectedDocumentsList}}<br><br>{{UploadLink}}<br><br>Regards,<br>GenAquarius HR",
    vals,
  );
  const r = await notifyMail("DOCUMENT_REJECTION", { fromUpn: req.user!.email, to: offer.candidateEmail, subject, html });
  await audit(id, req.user!.id, "DOCUMENT_REJECTION_NOTIFY", null, null, r.sent ? `Emailed to ${offer.candidateEmail} — ${rejected.map((d) => d.label).join(", ")}` : `Not emailed — ${r.reason || "unknown"}`);
  res.json({ ok: true, emailSent: r.sent, emailReason: r.sent ? undefined : r.reason, rejectedCount: rejected.length });
});

// HR uploading a document directly on the candidate's behalf (e.g. handed over in person, or via
// a channel outside the email-link flow) — the manual-upload path that coexists with the candidate
// self-serve email link; either (or both) can be used for the same offer. Auto-creates the request
// if HR never sent the email at all. HR-uploaded files are self-verified immediately (no separate
// Verify click) — HR handled the document directly, unlike a candidate's own upload.
const MAX_FILES_PER_DOC = 5;
router.post("/offers/:id/document-collection/upload", async (req, res) => {
  const id = Number(req.params.id);
  const gate = await requireStageUnlocked(id, "DOCUMENT_COLLECTION");
  if (!gate.ok) return res.status(400).json({ error: gate.error });
  const { docType, fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const { request } = await ensureDocumentCollectionRequest(id);
  const doc = await prisma.candidateDocument.findUnique({ where: { requestId_docType: { requestId: request.id, docType } } });
  if (!doc) return res.status(404).json({ error: "Unknown/no-longer-required document type." });
  const existing = Array.isArray(doc.files) ? (doc.files as any[]) : [];
  const nextFiles = doc.multipleFiles
    ? (existing.length >= MAX_FILES_PER_DOC ? existing : [...existing, { fileName, fileData, uploadedAt: new Date() }])
    : [{ fileName, fileData, uploadedAt: new Date() }];
  const updated = await prisma.candidateDocument.update({
    where: { id: doc.id },
    data: { files: nextFiles as any, status: "VERIFIED", verifiedById: req.user!.id, verifiedAt: new Date(), rejectionNote: null },
  });
  await audit(id, req.user!.id, "DOCUMENT_HR_UPLOAD", null, null, updated.label);
  // Section 5.4 — HR-uploaded documents move straight to Stage 4 once complete, no review cycle.
  await maybeAutoCompleteDocumentCollection(id, req.user!.id);
  emitEsignUpdate("OFFER", id, { documentVerified: updated.docType, status: updated.status });
  res.json({ docType: updated.docType, status: updated.status, fileCount: nextFiles.length });
});
// HR-side preview of an uploaded file (candidate's own upload OR HR's own manual upload) —
// authenticated equivalent of the public token-based file route.
router.get("/offers/:id/document-collection/file/:docType/:index", async (req, res) => {
  const id = Number(req.params.id);
  const doc = await prisma.candidateDocument.findFirst({ where: { docType: req.params.docType, request: { offerId: id } } });
  const file = doc && (Array.isArray(doc.files) ? (doc.files as any[]) : [])[Number(req.params.index)];
  if (!file) return res.status(404).json({ error: "File not found" });
  const ext = (file.fileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
  res.send(Buffer.from(file.fileData, "base64"));
});
// Manual "move to next stage" override — HR can complete Document Collection whenever they decide
// it's done, independent of whether the candidate ever clicked Submit on the email-link flow (both
// the automatic candidate-submit path and this manual HR override complete the same stage).
router.post("/offers/:id/document-collection/complete", async (req, res) => {
  const id = Number(req.params.id);
  await ensureDocumentCollectionRequest(id);
  await prisma.documentCollectionRequest.update({ where: { offerId: id }, data: { completedAt: new Date() } });
  await completeStageByType(id, "DOCUMENT_COLLECTION", req.user!.id);
  await audit(id, req.user!.id, "DOCUMENT_COLLECTION_COMPLETE", null, null, "Marked complete manually by HR.");
  emitEsignUpdate("OFFER", id, { documentCollectionCompleted: true });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ IT Provisioning ----
// HR's new-hire IT setup request — available once the Appointment Letter (Employee) or Service
// Agreement (Contractor) acceptance has been confirmed (digitally or manually), same gate as
// Confirm Joining itself. Emails everyone holding the IT_ADMIN role (see engine/itAdmin.ts —
// replaces the old free-text itAdminEmail setting) with the hardware/OS/email-id request plus the
// candidate's already-known details (name, designation, reporting manager, phone, joining date).
// The same request also appears as a task in the IT Admin module (routes/itAdmin.ts) for whoever
// holds that role to action and mark complete.
router.post("/offers/:id/it-provisioning", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { appointmentLetter: true, serviceAgreement: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const isContractor = usesServiceAgreement(offer.employmentType);
  // Both Employee and Contractor are workflow-engine-gated now, each on its own configured
  // template (default: after Mandatory Document Collection) — this used to be Employee-only
  // ("Contractors have no configurable stages"), which is what left the stage stuck and never
  // advancing to Confirm Joining for a Contractor. The Service Agreement acceptance check stays as
  // an extra Contractor-specific safety net alongside the generic stage gate, not instead of it.
  if (isContractor && offer.serviceAgreement?.status !== "ACCEPTED") {
    return res.status(400).json({ error: "IT provisioning can only be requested once the Service Agreement acceptance has been confirmed." });
  }
  const gate = await requireStageUnlocked(id, "IT_PROVISIONING");
  if (!gate.ok) return res.status(400).json({ error: gate.error });
  const b = req.body || {};
  if (!b.laptopConfiguration || !b.osRequirement || !b.emailIdToCreate) {
    return res.status(400).json({ error: "Laptop configuration, OS requirement and Email ID to create are required." });
  }
  const reqRow = await prisma.itProvisioningRequest.upsert({
    where: { offerId: id },
    update: {
      laptopConfiguration: b.laptopConfiguration, osRequirement: b.osRequirement, emailIdToCreate: b.emailIdToCreate,
      phoneNumber: b.phoneNumber || offer.candidatePhone || null, requestedById: req.user!.id,
      requiredApplications: b.requiredApplications || null, requiredAccess: b.requiredAccess || null, otherRequirements: b.otherRequirements || null,
    },
    create: {
      offerId: id, laptopConfiguration: b.laptopConfiguration, osRequirement: b.osRequirement, emailIdToCreate: b.emailIdToCreate,
      phoneNumber: b.phoneNumber || offer.candidatePhone || null, requestedById: req.user!.id,
      requiredApplications: b.requiredApplications || null, requiredAccess: b.requiredAccess || null, otherRequirements: b.otherRequirements || null,
    },
  });

  let emailWarning: string | null = null;
  const itAdminRecipients = await itAdminEmails();
  if (!itAdminRecipients.length) emailWarning = "No one holds the IT/Network Admin role yet — assign it to someone in Users & Roles.";
  else if (!mailEnabled()) emailWarning = "Email sending is not configured (Microsoft Graph).";
  else {
    try {
      // Section 10.1 — configurable IT Admin notification template, same {{Placeholder}}/fillTemplate
      // pattern as every other HR email, with the dynamic variables the spec names.
      const tplMail = await buFirst(offer.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "IT_PROVISIONING_NOTIFICATION", ...bu } }));
      // Where IT should ship the laptop/accessories — the Resident (current) Address, since
      // that's explicitly "where equipment ships"; falls back to the Permanent Address when the
      // candidate left Resident blank (the onboarding form's own "same as Permanent" default).
      // Was missing from this email entirely — IT Admin had no shipping address to act on.
      const shipLine1 = offer.residentAddress || offer.candidateAddress || "";
      const shipLandmark = offer.residentLandmark || offer.candidateLandmark || "";
      const shipCity = offer.residentCity || offer.candidateCity || "";
      const shipState = offer.residentState || offer.candidateState || "";
      const shipPincode = offer.residentPincode || offer.candidatePincode || "";
      const shippingAddress = [shipLine1, shipLandmark, shipCity, shipState, shipPincode].filter(Boolean).join(", ") || "Not provided";
      const vals = {
        firstName: offer.candidateFirstName || firstName(offer.candidateName), lastName: offer.candidateLastName || "",
        displayName: reqRow.displayName || "", personalEmail: offer.candidateEmail, jobTitle: offer.designation, department: offer.department || "",
        // {{ram}} stays available for the already-seeded email template text — RAM is now part of
        // the free-text Laptop Configuration itself (defaults to "16 GB", HR can edit/extend it)
        // rather than its own separate field, so it just mirrors that value.
        requestId: String(reqRow.id), laptopConfiguration: reqRow.laptopConfiguration, ram: reqRow.laptopConfiguration,
        EmployeeName: offer.candidateName, ReportingManager: offer.reportingManager || "—",
        shippingAddress,
      };
      const subject = fillTemplate(tplMail?.subject || "New IT Provisioning Request – {{EmployeeName}}", vals);
      const html = fillTemplate(
        tplMail?.body ||
        "A new IT provisioning request has been created and is waiting for your action.<br><br>" +
        "Employee: {{EmployeeName}}<br>Department: {{department}}<br>Job Title: {{jobTitle}}<br>Official Email: {{personalEmail}}<br><br>" +
        "Laptop Configuration: {{laptopConfiguration}}<br>RAM: {{ram}}<br><br>" +
        "Shipping Address: {{shippingAddress}}<br><br>" +
        "Please open the IT Admin Dashboard to review and approve the request.",
        vals,
      ).replace(/\n/g, "<br>");
      for (const to of itAdminRecipients) await notifyMail("IT_PROVISIONING_REQUEST", { fromUpn: req.user!.email, to, subject, html });
    } catch (e: any) { emailWarning = `Failed to send: ${e.message || "unknown error"}`; }
  }
  // sentAt gates whether this task appears at all in IT Admin's Pending Tasks queue (see
  // itAdmin.ts GET /tasks: sentAt: { not: null }) — it must be set unconditionally, not just on
  // the notification email's own success path. Previously, any email failure (or nobody holding
  // IT_ADMIN at that instant, or mail simply not configured) silently left sentAt null forever:
  // the ItProvisioningRequest row existed, but IT Admin never saw a task for it at all, even
  // though HR had genuinely clicked Send to IT and the request was real. The email is a best-
  // effort notification on top of a task that's real either way, same as every other "warn, don't
  // block" step in this route.
  await prisma.itProvisioningRequest.update({ where: { offerId: id }, data: { sentAt: new Date() } });
  await completeStageByType(id, "IT_PROVISIONING", req.user!.id);
  await audit(id, req.user!.id, "IT_PROVISIONING_REQUEST", offer.status, offer.status, emailWarning ? `Not emailed — ${emailWarning}` : `Emailed to IT admin(s) (${itAdminRecipients.join(", ")})`);
  const fresh = await prisma.itProvisioningRequest.findUnique({ where: { offerId: id } });
  // Live-refreshes the Confirm Joining panel for anyone else watching this offer — the Activate
  // button's gating depends on itProvisioningRequest.sentAt, so this needs to be as real-time as
  // every other Confirm Joining precondition.
  emitEsignUpdate("OFFER", id, { itProvisioningSent: !!fresh?.sentAt });
  // Was missing — the new Pending Task never showed up on the IT Admin Dashboard in real time,
  // only after a manual refresh. Same room/ping the Helpdesk Console already live-updates from.
  emitHelpdeskUpdate("it_provisioning_request", { offerId: id, candidateName: offer.candidateName });
  res.json({ ...fresh, emailWarning });
});

// ------------------------------------------------------------------ Resume ----
// Mandatory before Appointment Letter generation (see the guard above) — HR uploads whatever
// resume/CV the candidate originally submitted, kept on the Offer record itself (one file, no
// separate table needed, same base64-in-column convention as onboarding documents).
router.post("/offers/:id/resume", async (req, res) => {
  const id = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const offer = await prisma.offer.update({ where: { id }, data: { resumeFileName: fileName, resumeFileData: fileData, resumeUploadedAt: new Date() } });
  emitEsignUpdate("OFFER", id, { resumeUploaded: true });
  res.json({ resumeFileName: offer.resumeFileName, resumeUploadedAt: offer.resumeUploadedAt });
});
router.get("/offers/:id/resume", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, select: { resumeFileName: true, resumeFileData: true } });
  if (!offer?.resumeFileData) return res.status(404).json({ error: "No resume on file" });
  const ext = (offer.resumeFileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "doc" ? "application/msword" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${offer.resumeFileName}"`);
  res.send(Buffer.from(offer.resumeFileData, "base64"));
});

// ------------------------------------------------------------------ Education Certificate / Photo ----
// Intern's Stage 1 captures these up front too, alongside Resume/Aadhaar above — same
// HR-uploads-directly convention (not the candidate-facing Document Collection link flow).
router.post("/offers/:id/education-certificate", async (req, res) => {
  const id = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const offer = await prisma.offer.update({ where: { id }, data: { educationCertificateFileName: fileName, educationCertificateFileData: fileData, educationCertificateUploadedAt: new Date() } });
  emitEsignUpdate("OFFER", id, { educationCertificateUploaded: true });
  res.json({ educationCertificateFileName: offer.educationCertificateFileName, educationCertificateUploadedAt: offer.educationCertificateUploadedAt });
});
router.get("/offers/:id/education-certificate", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, select: { educationCertificateFileName: true, educationCertificateFileData: true } });
  if (!offer?.educationCertificateFileData) return res.status(404).json({ error: "No education certificate on file" });
  const ext = (offer.educationCertificateFileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${offer.educationCertificateFileName}"`);
  res.send(Buffer.from(offer.educationCertificateFileData, "base64"));
});
router.post("/offers/:id/photo", async (req, res) => {
  const id = Number(req.params.id);
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const offer = await prisma.offer.update({ where: { id }, data: { photoFileName: fileName, photoFileData: fileData, photoUploadedAt: new Date() } });
  emitEsignUpdate("OFFER", id, { photoUploaded: true });
  res.json({ photoFileName: offer.photoFileName, photoUploadedAt: offer.photoUploadedAt });
});
router.get("/offers/:id/photo", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, select: { photoFileName: true, photoFileData: true } });
  if (!offer?.photoFileData) return res.status(404).json({ error: "No photo on file" });
  const ext = (offer.photoFileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${offer.photoFileName}"`);
  res.send(Buffer.from(offer.photoFileData, "base64"));
});

// ------------------------------------------------------------------ Generic Offer Documents (US/Canada) ----
// Stage 1's "Supporting Documents" for US/Canada (SSN/SIN, Work Authorization, Driver's License,
// W-9, Void Cheque, and any "+ Add Additional Document" entry) — one generic HR-uploads-directly
// slot per docType, upserted so re-uploading the same docType replaces it (see @@unique on the model).
router.post("/offers/:id/documents", async (req, res) => {
  const id = Number(req.params.id);
  const { docType, label, fileName, fileData } = req.body || {};
  if (!docType || !label || !fileName || !fileData) return res.status(400).json({ error: "docType, label, fileName and fileData (base64) are required" });
  const doc = await prisma.offerDocument.upsert({
    where: { offerId_docType: { offerId: id, docType } },
    update: { label, fileName, fileData, uploadedAt: new Date() },
    create: { offerId: id, docType, label, fileName, fileData },
  });
  emitEsignUpdate("OFFER", id, { documentUploaded: docType });
  res.json({ id: doc.id, docType: doc.docType, label: doc.label, fileName: doc.fileName, uploadedAt: doc.uploadedAt });
});
router.get("/offers/:id/documents/:docType", async (req, res) => {
  const doc = await prisma.offerDocument.findUnique({ where: { offerId_docType: { offerId: Number(req.params.id), docType: req.params.docType } } });
  if (!doc) return res.status(404).json({ error: "No document on file for this type" });
  const ext = (doc.fileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${doc.fileName}"`);
  res.send(Buffer.from(doc.fileData, "base64"));
});

// ------------------------------------------------------------------ Aadhaar ----
// Mandatory before Offer Generation (see the guard there) — number AND scanned image captured
// together, once, here — never asked for again later (Mandatory Document Collection explicitly
// excludes Aadhaar, see resolveRequiredDocuments). fileName/fileData (base64) are optional on this
// route so the number can still be saved/updated alone (e.g. a correction) without re-uploading.
router.post("/offers/:id/aadhaar", async (req, res) => {
  const id = Number(req.params.id);
  const aadhaarNumber = String(req.body?.aadhaarNumber || "").trim();
  if (!/^\d{12}$/.test(aadhaarNumber)) return res.status(400).json({ error: "Aadhaar number must be 12 digits." });
  const { fileName, fileData } = req.body || {};
  const offer = await prisma.offer.update({ where: { id }, data: {
    aadhaarNumber, aadhaarUpdatedAt: new Date(),
    ...(fileName && fileData ? { aadhaarFileName: fileName, aadhaarFileData: fileData } : {}),
  } });
  emitEsignUpdate("OFFER", id, { aadhaarCaptured: true });
  res.json({ aadhaarNumber: offer.aadhaarNumber, aadhaarFileName: offer.aadhaarFileName, aadhaarUpdatedAt: offer.aadhaarUpdatedAt });
});
router.get("/offers/:id/aadhaar", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, select: { aadhaarFileName: true, aadhaarFileData: true } });
  if (!offer?.aadhaarFileData) return res.status(404).json({ error: "No Aadhaar image on file" });
  const ext = (offer.aadhaarFileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${offer.aadhaarFileName}"`);
  res.send(Buffer.from(offer.aadhaarFileData, "base64"));
});
// Optional — if already known, Mandatory Document Collection skips re-requesting the PAN Card.
router.post("/offers/:id/pan", async (req, res) => {
  const id = Number(req.params.id);
  const panNumber = String(req.body?.panNumber || "").trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(panNumber)) return res.status(400).json({ error: "PAN must be in the format ABCDE1234F." });
  const offer = await prisma.offer.update({ where: { id }, data: { panNumber } });
  res.json({ panNumber: offer.panNumber });
});

// ------------------------------------------------------------------ Confirm Joining ----
// The ONE action that activates the employee: creates the Employee master row (reusing the
// already-reserved Employee ID), an opening CtcRecord from the offer's salary breakup, and a
// Bench (or chosen project) allocation from the joining date. Nothing before this point ever
// touches the Employee table, so every existing employee-driven report is unaffected until here.
// Read-only preview of the CTC Record Confirm Joining is about to create — shown to HR before
// activation exactly as it will be written (same buildCtcComponentsFromBreakup() call the real
// creation below uses), so nothing here can silently diverge from the actual record.
router.get("/offers/:id/ctc-preview", async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: Number(req.params.id) }, include: { versions: true, serviceAgreement: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const location = offer.countryCode === "US" ? "US" : offer.countryCode === "CANADA" ? "CANADA" : "INDIA";
  if (usesServiceAgreement(offer.employmentType)) {
    return res.json({ mode: offer.employmentType, location, currency: "INR", empType: offer.employmentType, noCostToCompany: !!offer.serviceAgreement?.noCostToCompany, basic: offer.serviceAgreement?.monthlyCompensation || 0, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0, communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0 });
  }
  const version = offer.versions.find((v) => v.versionNo === offer.activeVersion);
  const breakup = version?.salaryBreakup as any;
  if (breakup && offer.countryCode === "INDIA") {
    return res.json({ mode: "INDIA_COMPONENTS", location, currency: "INR", empType: "FULL_TIME", ...buildCtcComponentsFromBreakup(breakup) });
  }
  return res.json({ mode: "ANNUAL_OVERRIDE", location, currency: offer.countryCode === "US" ? "USD" : "CAD", empType: "FULL_TIME", annualCostOverride: offer.ctc, engagement: offer.countryCode !== "INDIA" ? offerEngagementComp(offer) : undefined });
});

// Email Finance/CTO/CEO that a new hire's CTC is waiting for their review — sent right after the
// pending CtcApprovalRequest is created below. Never blocks activation: an unconfigured mailer
// or a send failure just leaves sentCount at 0 (reported back to HR, not thrown).
async function notifyFinanceOfCtcApproval(vals: Record<string, string>, fromEmail: string) {
  const recipients = await prisma.user.findMany({ where: { role: { in: ["FINANCE", "CTO", "CEO"] } }, select: { email: true } });
  const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key: "NEW_EMPLOYEE_CTC_APPROVAL", businessUnitId: null } });
  const subject = fillTemplate(tpl?.subject || "Action needed: CTC approval for {{EmployeeName}} ({{EmployeeId}})", vals);
  const html = fillTemplate(tpl?.body || "New employee CTC awaiting approval.", vals).replace(/\n/g, "<br>");
  let sentCount = 0;
  if (mailEnabled()) {
    for (const r of recipients) {
      if (!r.email) continue;
      try { const rr = await notifyMail("CTC_APPROVAL_NOTIFY", { fromUpn: fromEmail, to: r.email, subject, html }); if (rr.sent) sentCount++; } catch { /* one bad recipient shouldn't block the rest */ }
    }
  }
  return { sentCount, totalRecipients: recipients.length };
}

// The ONE action that activates the employee: creates the Employee master row (reusing the
// already-reserved Employee ID) right away, but the CTC record and Monthly Sheet line are NOT
// created yet — they're staged as a PENDING CtcApprovalRequest for Finance to review, so a new
// hire never affects cost/revenue reporting until Finance signs off. Finance approves from
// /ctc-approvals, which is what actually creates the CtcRecord + EmployeeProject + MonthlyLine.
router.post("/offers/:id/confirm-joining", async (req, res) => {
  const id = Number(req.params.id);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { versions: true } });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  const b = req.body || {};
  const joiningDate = b.actualJoiningDate ? new Date(b.actualJoiningDate) : new Date();
  const location = offer.countryCode === "US" ? "US" : offer.countryCode === "CANADA" ? "CANADA" : "INDIA";
  const ctcEffectiveFrom = b.ctcEffectiveFrom ? new Date(b.ctcEffectiveFrom) : joiningDate;
  const ctcEffectiveTill = b.ctcEffectiveTill ? new Date(b.ctcEffectiveTill) : null;
  // Effective Till stays optional. Deployment Start/End are mandatory only when a real Project is
  // selected — Bench (no projectId) has no deployment window to bound, and Confirm Joining /
  // Activate Employee must not be blocked waiting on dates that don't apply.
  if (b.projectId && (!b.deploymentStart || !b.deploymentEnd)) return res.status(400).json({ error: "Deployment Start and Deployment End are required when a Project is selected." });
  const project = b.projectId ? await prisma.project.findUnique({ where: { id: Number(b.projectId) } }) : null;
  const isBillable = b.isBillable !== false && b.isBillable !== "false" && b.isBillable !== "NON_BILLABLE";
  const deploymentStart = b.deploymentStart ? new Date(b.deploymentStart) : null;
  const deploymentEnd = b.deploymentEnd ? new Date(b.deploymentEnd) : null;

  // CONTRACTOR/INTERN: no appointment letter exists (never generated for this employmentType —
  // see the guards above), so this branches BEFORE any of the EMPLOYEE path's own
  // appointmentLetter/salary-breakup logic below runs — that logic is completely untouched for
  // EMPLOYEE offers.
  const saForJoin = await prisma.serviceAgreement.findUnique({ where: { offerId: id } });
  // US/Canada vendor/contractor engagements sign an MSA + SOW (no Service Agreement exists) and are
  // priced in USD/CAD — they take the employee-style path below, which writes the approved
  // hourly/daily/annual CTC to the approval request, not the India INR Service Agreement branch.
  const usesSaPath = usesServiceAgreement(offer.employmentType) && !(offer.countryCode && offer.countryCode !== "INDIA" && !saForJoin);
  if (usesSaPath) {
    const sa = saForJoin;
    const label = offer.employmentType === "INTERN" ? "Intern" : "Contractor";
    if (offer.status !== "ACCEPTED") return res.status(400).json({ error: `Offer must be Accepted before joining can be confirmed (currently ${offer.status}).` });
    if (offer.employeeId) return res.status(400).json({ error: "This offer already has an active employee." });
    if (!offer.reservedEmpNo) return res.status(400).json({ error: `No ${label} code was reserved for this offer.` });
    if (!sa) return res.status(400).json({ error: "Generate the Service Agreement before confirming joining." });
    if (sa.status !== "ACCEPTED") return res.status(400).json({ error: `Waiting for the ${label.toLowerCase()} to confirm acceptance of the Service Agreement (manually, or automatically via Adobe Sign) before joining can be confirmed.` });
    const itReq = await prisma.itProvisioningRequest.findUnique({ where: { offerId: id } });
    if (!itReq?.sentAt) return res.status(400).json({ error: "Send the IT Provisioning Request before confirming joining — IT needs the setup details first." });

    const employee = await prisma.employee.create({
      data: { empNo: offer.reservedEmpNo, name: offer.candidateName, email: offer.candidateEmail, joiningDate, location, empType: offer.employmentType, isBillable: true, noCostToCompany: !!sa.noCostToCompany,
        designation: offer.designation, department: offer.department, reportingManager: offer.reportingManager, businessUnitId: offer.businessUnitId,
        noticePeriod: offer.noticePeriod, probationPeriod: offer.probationPeriod, phone: offer.candidatePhone, officialPhone: offer.candidateOfficialPhone, personalEmail: offer.candidatePersonalEmail, address: offer.candidateAddress,
        city: offer.candidateCity, landmark: offer.candidateLandmark, state: offer.candidateState, pincode: offer.candidatePincode,
        residentAddress: offer.residentSameAsPermanent ? offer.candidateAddress : offer.residentAddress,
        residentCity: offer.residentSameAsPermanent ? offer.candidateCity : offer.residentCity,
        residentLandmark: offer.residentSameAsPermanent ? offer.candidateLandmark : offer.residentLandmark,
        residentState: offer.residentSameAsPermanent ? offer.candidateState : offer.residentState,
        residentPincode: offer.residentSameAsPermanent ? offer.candidatePincode : offer.residentPincode,
        gender: offer.gender, maritalStatus: offer.maritalStatus, dateOfBirth: offer.dateOfBirth },
    });
    await linkUserToEmployee(id, employee.id, employee.email);

    // "No Cost to Company" (explicit checkbox on the Service Agreement): skip CtcApprovalRequest/
    // CtcRecord entirely — no CTC record is ever created, so Finance never reviews it and
    // Employee.noCostToCompany (set above) keeps it out of every $ cost aggregate and out of
    // headcount COUNTS. They still get a real Bench/Project assignment and a Monthly Line (like
    // anyone else) so they're VISIBLE in Bench/Project rosters and Workforce — just at $0, since
    // computeEmployeeCost() naturally resolves to 0 with no CtcRecord to read from.
    if (sa.noCostToCompany) {
      const zcProject = project || await ensureBenchProject();
      let zcMonthlyLine: any = null, zcMonthlyLineError: string | null = null;
      if (zcProject) {
        await prisma.employeeProject.create({ data: { employeeId: employee.id, projectId: zcProject.id, fromDate: joiningDate } });
        // Anchor to deploymentStart, not always joiningDate — a deployment starting later than
        // joining otherwise falls outside the anchor sheet's own month and createMonthlyLine
        // hard-rejects the whole call (see the identical fix + full explanation in
        // ctcApprovals.ts's /approve route).
        const sheet = await ensureSheetForDate(deploymentStart || joiningDate);
        // applyFuture: without it, this only ever creates a line in the joining month — same bug
        // just fixed in ctcApprovals.ts's /approve route, applies equally here.
        const result = await createMonthlyLine(sheet.id, { employeeId: employee.id, projectId: zcProject.id, isBillable: false, deploymentStart, deploymentEnd, applyFuture: true }, req.user!.id);
        if (result.ok) zcMonthlyLine = result.line; else zcMonthlyLineError = result.error;
      }
      const updated = await prisma.offer.update({ where: { id }, data: { status: "JOINING_CONFIRMED", employeeId: employee.id, ctcRejectedAt: null, ctcRejectionNote: null } });
      await audit(id, req.user!.id, "CONFIRM_JOINING", "ACCEPTED", "JOINING_CONFIRMED", `${label} ${offer.reservedEmpNo} activated — No Cost to Company, no CTC approval needed`);
      emitEsignUpdate("OFFER", id, { status: "JOINING_CONFIRMED" });
      return res.json({ offer: updated, employee, project: zcProject, noCostToCompany: true, monthlyLine: zcMonthlyLine, monthlyLineError: zcMonthlyLineError });
    }

    // Contractor/Intern's CTC-equivalent for cost reporting: the flat monthly compensation,
    // written into `basic` — NOT `annualCostOverride`. engine/calc.ts's ctcAnnualUsd() treats
    // annualCostOverride as an ALREADY-USD figure (used by the US W2/vendor paths); writing an INR
    // annual number there would get treated as USD and inflate the cost ~93× on every dashboard.
    // Going through the ordinary INR-components field (basic) instead — same one every India
    // Employee CtcRecord uses — makes it flow through with the correct currency conversion once
    // approved.
    const approval = await prisma.ctcApprovalRequest.create({ data: {
      employeeId: employee.id, offerId: id, currency: "INR", empType: offer.employmentType, location,
      basic: sa.monthlyCompensation, ctcEffectiveFrom, ctcEffectiveTill,
      projectId: project?.id ?? null, deploymentStart, deploymentEnd, isBillable,
      rateUsd: b.rateUsd != null && b.rateUsd !== "" ? Number(b.rateUsd) : null, billingMode: b.billingMode || "HOURLY",
      requestedById: req.user!.id,
    } });
    const { sentCount, totalRecipients } = await notifyFinanceOfCtcApproval({
      EmployeeName: offer.candidateName, EmployeeId: offer.reservedEmpNo, EmployeeType: label,
      CtcSummary: money(sa.monthlyCompensation, "INR") + "/mo", CtcEffectiveFrom: dstr(ctcEffectiveFrom), ProjectName: project?.name || "Bench (default)",
    }, req.user!.email);
    emitAttention(["FINANCE", "CTO", "CEO", "COO"], "ctc_approval_pending", { employeeName: offer.candidateName });

    const updated = await prisma.offer.update({ where: { id }, data: { status: "JOINING_CONFIRMED", employeeId: employee.id, ctcRejectedAt: null, ctcRejectionNote: null } });
    await audit(id, req.user!.id, "CONFIRM_JOINING", "ACCEPTED", "JOINING_CONFIRMED", `${label} ${offer.reservedEmpNo} activated — CTC submitted for Finance approval (request #${approval.id})`);
    emitEsignUpdate("OFFER", id, { status: "JOINING_CONFIRMED" });
    return res.json({ offer: updated, employee, project, ctcApprovalRequestId: approval.id, notified: sentCount, totalRecipients });
  }

  const appt = await prisma.appointmentLetter.findUnique({ where: { offerId: id } });
  if (offer.employeeId) return res.status(400).json({ error: "This offer already has an active employee." });
  // Workflow-engine-gated (default: Employee Activation depends on Offer Accepted + Mandatory
  // Document Collection + IT Provisioning — Appointment is NOT a default dependency here, since
  // the default order runs Activation BEFORE Appointment; HR can add it as a dependency from the
  // Workflow Builder if they reorder Appointment to happen first instead).
  const gate = await requireStageUnlocked(id, "EMPLOYEE_ACTIVATION");
  if (!gate.ok) return res.status(400).json({ error: gate.error });
  // If Appointment already happened (HR reordered it before Activation), it must actually be
  // accepted first — mirrors the original fixed rule, now conditional on whether that stage ran.
  if (appt && appt.status !== "ACCEPTED") {
    return res.status(400).json({ error: "Waiting for the candidate to confirm acceptance of the Appointment Letter (manually, or automatically via Adobe Sign) before joining can be confirmed." });
  }
  // Default order: no Appointment yet, so no pre-reserved Employee ID either — assign one fresh
  // here instead of requiring appointment/generate to have already reserved it.
  const empNo = offer.reservedEmpNo || (await nextEmpNo());

  const employee = await prisma.employee.create({
    data: { empNo, name: offer.candidateName, email: offer.candidateEmail, joiningDate, location, empType: b.employmentType || "FULL_TIME", isBillable: true,
      designation: offer.designation, department: offer.department, reportingManager: offer.reportingManager, businessUnitId: offer.businessUnitId,
      noticePeriod: offer.noticePeriod, probationPeriod: offer.probationPeriod, phone: offer.candidatePhone, officialPhone: offer.candidateOfficialPhone, personalEmail: offer.candidatePersonalEmail, address: offer.candidateAddress,
      city: offer.candidateCity, landmark: offer.candidateLandmark, state: offer.candidateState, pincode: offer.candidatePincode,
      residentAddress: offer.residentSameAsPermanent ? offer.candidateAddress : offer.residentAddress,
      residentCity: offer.residentSameAsPermanent ? offer.candidateCity : offer.residentCity,
      residentLandmark: offer.residentSameAsPermanent ? offer.candidateLandmark : offer.residentLandmark,
      residentState: offer.residentSameAsPermanent ? offer.candidateState : offer.residentState,
      residentPincode: offer.residentSameAsPermanent ? offer.candidatePincode : offer.residentPincode,
      gender: offer.gender, maritalStatus: offer.maritalStatus, dateOfBirth: offer.dateOfBirth,
      uanPfDetails: offer.uanPfDetails,
      emergencyContactPhone: (appt?.dynamicFields as any)?.EmergencyContactPhone || null },
  });
  await linkUserToEmployee(id, employee.id, employee.email);

  const version = offer.versions.find((v) => v.versionNo === offer.activeVersion);
  const breakup = version?.salaryBreakup as any;
  const isIndiaComponents = !!breakup && offer.countryCode === "INDIA";
  const ctcFields = isIndiaComponents
    ? { currency: "INR", ...buildCtcComponentsFromBreakup(breakup), annualCostOverride: null as number | null }
    : { currency: offer.countryCode === "US" ? "USD" : "CAD", annualCostOverride: offer.ctc, basic: 0, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0, communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0 };
  const ctcSummary = isIndiaComponents
    ? money(ctcFields.basic + ctcFields.hra + ctcFields.otherAllowance + ctcFields.specialAllowance + ctcFields.conveyance + ctcFields.communication + ctcFields.meals + ctcFields.books + ctcFields.driver + ctcFields.uniform, "INR") + "/mo"
    : money(offer.ctc, ctcFields.currency) + "/annum";

  const approval = await prisma.ctcApprovalRequest.create({ data: {
    employeeId: employee.id, offerId: id, empType: b.employmentType || "FULL_TIME", location,
    ...ctcFields, ctcEffectiveFrom, ctcEffectiveTill,
    projectId: project?.id ?? null, deploymentStart, deploymentEnd, isBillable,
    rateUsd: b.rateUsd != null && b.rateUsd !== "" ? Number(b.rateUsd) : null, billingMode: b.billingMode || "HOURLY",
    requestedById: req.user!.id,
  } });
  const { sentCount, totalRecipients } = await notifyFinanceOfCtcApproval({
    EmployeeName: offer.candidateName, EmployeeId: empNo, EmployeeType: "Employee",
    CtcSummary: ctcSummary, CtcEffectiveFrom: dstr(ctcEffectiveFrom), ProjectName: project?.name || "Bench (default)",
  }, req.user!.email);
  emitAttention(["FINANCE", "CTO", "CEO", "COO"], "ctc_approval_pending", { employeeName: offer.candidateName });

  const updated = await prisma.offer.update({ where: { id }, data: { status: "JOINING_CONFIRMED", employeeId: employee.id, reservedEmpNo: empNo, ctcRejectedAt: null, ctcRejectionNote: null } });
  await audit(id, req.user!.id, "CONFIRM_JOINING", offer.status, "JOINING_CONFIRMED", `Employee ${empNo} activated — CTC submitted for Finance approval (request #${approval.id})`);
  await completeStageByType(id, "EMPLOYEE_ACTIVATION", req.user!.id);
  emitEsignUpdate("OFFER", id, { status: "JOINING_CONFIRMED" });
  res.json({ offer: updated, employee, project, ctcApprovalRequestId: approval.id, notified: sentCount, totalRecipients });
});

export default router;
