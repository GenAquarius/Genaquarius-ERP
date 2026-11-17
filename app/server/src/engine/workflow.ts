// HR Workflow Engine — Administration/HR Settings -> Workflow & Stage Configuration. The single
// source of truth for stage ORDER, dependencies, required fields/documents, and gating across the
// Offer -> Appointment -> Document Collection -> IT Provisioning -> Employee Activation pipeline.
// Real routes (hrOffers.ts, documentCollection.ts, itAdmin.ts) never hardcode "status must be X" —
// they call requireStageUnlocked(offerId, STAGE_TYPE) before acting and completeStageByType(...)
// after, so HR can freely reorder/add/disable stages from the Workflow Builder without a code
// change. See schema.prisma's WorkflowDefinition/WorkflowStage/OfferStageProgress for the model.
import { prisma } from "../prisma";
import { emitEsignUpdate } from "./realtime";

// One system stage type is allowed at most once per workflow — the real app action wired to it
// (see the route-level callers) is found by TYPE, never by the HR-editable name/key, so renaming
// or reordering a stage in the builder never breaks the underlying feature. CUSTOM_STAGE has no
// attached system behavior — HR uses it purely for manual tracking (Complete Stage button).
export const STAGE_TYPES = [
  "CANDIDATE_INFO", "DATA_COLLECTION", "DOCUMENT_COLLECTION", "OFFER_GENERATION", "OFFER_APPROVAL",
  "OFFER_ACCEPTANCE", "APPOINTMENT_GENERATION", "APPOINTMENT_ACCEPTANCE", "IT_PROVISIONING",
  "HR_APPROVAL", "MANAGEMENT_APPROVAL", "EMPLOYEE_ACTIVATION", "CUSTOM_STAGE",
  // US/Canada simplified 3-stage onboarding only (see workflowBucketFor below) — a parallel, much
  // shorter pipeline to the EMPLOYEE/CONTRACTOR ones above, not a replacement for them.
  "CAPTURE_INFORMATION", "AGREEMENT_SIGNATURE", "ONBOARDING_ACTIVATION",
] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const DEFAULT_STAGE_LABEL: Record<StageType, string> = {
  CANDIDATE_INFO: "Candidate Information", DATA_COLLECTION: "Resume + Aadhaar",
  DOCUMENT_COLLECTION: "Mandatory Document Collection", OFFER_GENERATION: "Offer Generation",
  OFFER_APPROVAL: "Offer Approval", OFFER_ACCEPTANCE: "Offer Accepted",
  APPOINTMENT_GENERATION: "Appointment Generation", APPOINTMENT_ACCEPTANCE: "Appointment Accepted",
  IT_PROVISIONING: "IT Provisioning", HR_APPROVAL: "HR Approval", MANAGEMENT_APPROVAL: "Management Approval",
  EMPLOYEE_ACTIVATION: "Employee Activation", CUSTOM_STAGE: "Custom Stage",
  CAPTURE_INFORMATION: "Capture Information", AGREEMENT_SIGNATURE: "Agreement & Signature",
  ONBOARDING_ACTIVATION: "Onboarding Activation",
};

// Short in-process cache — the published workflow changes rarely (an HR admin action), but is
// read on nearly every offer-lifecycle request; same TTL-cache pattern as engine/calc.ts. Keyed by
// employmentType now that EMPLOYEE and CONTRACTOR each have their own independent published workflow.
const publishedCache = new Map<string, { at: number; workflow: any }>();
const PUBLISHED_TTL_MS = 15_000;

export type WorkflowEmploymentType = "EMPLOYEE" | "CONTRACTOR" | "INTERN" | "US_CANADA";
const normalizeEmploymentType = (t?: string | null): WorkflowEmploymentType =>
  t === "CONTRACTOR" ? "CONTRACTOR" : t === "INTERN" ? "INTERN" : t === "US_CANADA" ? "US_CANADA" : "EMPLOYEE";

// US/Canada offers get their own workflow bucket ("US_CANADA"), independent of Offer.employmentType
// (EMPLOYEE/CONTRACTOR there still just means "Offer Letter" vs "Service Agreement" document —
// unrelated to which 3-stage-vs-7-stage pipeline applies). India's EMPLOYEE/CONTRACTOR/INTERN
// buckets are completely unaffected — this only ever returns "US_CANADA" when countryCode says so.
export function workflowBucketFor(offer: { employmentType?: string | null; countryCode?: string | null }): WorkflowEmploymentType {
  if (offer.countryCode && offer.countryCode !== "INDIA") return "US_CANADA";
  return normalizeEmploymentType(offer.employmentType);
}

export async function getPublishedWorkflow(employmentType: string = "EMPLOYEE") {
  const et = normalizeEmploymentType(employmentType);
  const cached = publishedCache.get(et);
  if (cached && Date.now() - cached.at < PUBLISHED_TTL_MS) return cached.workflow;
  const wf = await prisma.workflowDefinition.findFirst({ where: { status: "PUBLISHED", employmentType: et }, orderBy: { version: "desc" }, include: { stages: { orderBy: { order: "asc" } } } });
  publishedCache.set(et, { at: Date.now(), workflow: wf });
  return wf;
}
export function invalidatePublishedWorkflowCache() { publishedCache.clear(); }

/** Pin an offer to the currently-published workflow (for its own employment type) the first time
 *  it needs stage tracking (Offer Accepted) — an in-progress candidate keeps this workflow even if
 *  a newer one publishes later, matching the "Apply New Workflow To" rule (Section 28). No-op if
 *  already pinned. */
export async function ensureOfferPinnedToWorkflow(offerId: number): Promise<number | null> {
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, select: { workflowId: true, employmentType: true, countryCode: true } });
  if (offer?.workflowId) return offer.workflowId;
  const wf = await getPublishedWorkflow(workflowBucketFor(offer || {}));
  if (!wf) return null;
  await prisma.offer.update({ where: { id: offerId }, data: { workflowId: wf.id } });
  return wf.id;
}

async function offerWorkflow(offerId: number) {
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, select: { workflowId: true } });
  // Self-heals any offer that was created before pinning happened at creation time (see POST
  // /offers), or one created before a published workflow existed for its employment type yet —
  // every caller of this function (resolveRequiredDocuments, requireStageUnlocked,
  // resolveOfferFieldConfig, resolveStageFieldConfig...) previously fell back to hardcoded generic
  // defaults for the ENTIRE time workflowId stayed null, with no way to recover short of a manual
  // DB fix. Now it fixes itself on the very next read.
  const workflowId = offer?.workflowId || (await ensureOfferPinnedToWorkflow(offerId));
  if (!workflowId) return null;
  return prisma.workflowDefinition.findUnique({ where: { id: workflowId }, include: { stages: { orderBy: { order: "asc" } } } });
}

function stageOfType(wf: any, stageType: StageType) {
  return wf?.stages?.find((s: any) => s.stageType === stageType) || null;
}

/** Every stage's progress for an offer, keyed by stageKey. */
export async function getProgress(offerId: number): Promise<Record<string, any>> {
  const rows = await prisma.offerStageProgress.findMany({ where: { offerId } });
  return Object.fromEntries(rows.map((r) => [r.stageKey, r]));
}

/**
 * Is `stageType`'s action allowed to run right now for this offer? True (with no workflow pinned
 * yet, or no stage of this type configured, or the stage disabled) means "no gating — proceed",
 * so the engine is additive: an offer created before the workflow engine existed, or a workflow
 * that simply doesn't define this stage, behaves exactly as if the feature had no gate at all.
 */
export async function requireStageUnlocked(offerId: number, stageType: StageType): Promise<{ ok: true; stage: any | null } | { ok: false; error: string }> {
  const wf = await offerWorkflow(offerId);
  if (!wf) return { ok: true, stage: null };
  const stage = stageOfType(wf, stageType);
  if (!stage || !stage.enabled) return { ok: true, stage: null };
  const dependsOn: string[] = Array.isArray(stage.dependsOnKeys) ? stage.dependsOnKeys : [];
  if (!dependsOn.length) return { ok: true, stage };
  const progress = await getProgress(offerId);
  const byKey = new Map(wf.stages.map((s: any) => [s.key, s]));
  const blocked = dependsOn.filter((depKey) => {
    const depStage = byKey.get(depKey);
    if (!depStage || !depStage.enabled) return false; // a disabled/removed dependency can't block anything
    const st = progress[depKey]?.status;
    return st !== "COMPLETED" && st !== "SKIPPED";
  });
  if (blocked.length) {
    const names = blocked.map((k) => (byKey.get(k) as any)?.name || k).join(", ");
    return { ok: false, error: `Complete "${names}" before "${stage.name}".` };
  }
  return { ok: true, stage };
}

/** True only when this offer's workflow has its own dedicated OFFER_ACCEPTANCE-typed stage
 *  (Contractor/Employee) — false for a collapsed workflow like Intern's, where OFFER_GENERATION
 *  is itself the acceptance-tracking stage (see completeStageByType's fallback below). Used by
 *  reconcileAgreement (routes/shared/adobeSign.ts) to decide whether an Adobe Sign completion may
 *  auto-advance the stage on its own (Contractor/Employee: signing IS the confirmation, no
 *  separate HR click needed) or must instead wait for HR's own explicit review-and-proceed action
 *  (Intern: signing only captures the document — completeStageByType's OFFER_GENERATION fallback
 *  would otherwise mark the SAME stage HR is meant to review from as instantly "done", jumping the
 *  wizard straight past it before HR ever opened the signed document). */
export async function offerHasOwnAcceptanceStage(offerId: number): Promise<boolean> {
  const wf = await offerWorkflow(offerId);
  return !!wf?.stages?.some((s: any) => s.stageType === "OFFER_ACCEPTANCE" && s.enabled);
}

/** Marks stageType's stage COMPLETED for this offer (no-op if no workflow/stage configured).
 *  OFFER_ACCEPTANCE falls back to the OFFER_GENERATION-typed stage when the workflow has no
 *  dedicated acceptance stage — Intern's published workflow collapses "Generate & Send" and
 *  "Accept" into one stage (sla_generation, typed OFFER_GENERATION) rather than Contractor's two
 *  separate stages, so the plain "no stage of that type" no-op above left IT Provisioning locked
 *  forever: nothing ever marked sla_generation COMPLETED, for either the manual-confirm path or
 *  the Adobe Sign webhook, since both call completeStageByType(id, "OFFER_ACCEPTANCE") only. */
export async function completeStageByType(offerId: number, stageType: StageType, byUserId?: number): Promise<void> {
  const wf = await offerWorkflow(offerId);
  const stage = stageOfType(wf, stageType) || (stageType === "OFFER_ACCEPTANCE" ? stageOfType(wf, "OFFER_GENERATION") : null);
  if (!stage) return;
  await prisma.offerStageProgress.upsert({
    where: { offerId_stageKey: { offerId, stageKey: stage.key } },
    update: { status: "COMPLETED", completedAt: new Date(), completedById: byUserId ?? null },
    create: { offerId, stageKey: stage.key, status: "COMPLETED", completedAt: new Date(), completedById: byUserId ?? null },
  });
  emitEsignUpdate("OFFER", offerId, { stageCompleted: stage.key });
}

/** Marks a stage IN_PROGRESS (informational only — doesn't affect gating, which only checks
 *  COMPLETED/SKIPPED) so the dashboard can show "current owner" style state. */
export async function touchStageInProgress(offerId: number, stageType: StageType): Promise<void> {
  const wf = await offerWorkflow(offerId);
  const stage = stageOfType(wf, stageType);
  if (!stage) return;
  const existing = await prisma.offerStageProgress.findUnique({ where: { offerId_stageKey: { offerId, stageKey: stage.key } } });
  if (existing?.status === "COMPLETED") return;
  await prisma.offerStageProgress.upsert({
    where: { offerId_stageKey: { offerId, stageKey: stage.key } },
    update: { status: "IN_PROGRESS" },
    create: { offerId, stageKey: stage.key, status: "IN_PROGRESS" },
  });
}

// Field key -> how to read/label/group it off a real Offer row — the fixed vocabulary Section 8/9's
// "Mandatory Fields" checkboxes draw from for the OFFER_GENERATION / DATA_COLLECTION stages. Mirrors
// the Generate Offer form's own four sections (client/pages/hrms/Hr.tsx GenerateOffer) exactly, by
// name, so the Workflow Builder's config UI and the real form can never drift apart. `locked` fields
// are hard server-side requirements for creating any offer at all (POST /hr/offers) — always shown
// (so HR can see the full real field list) but never actually disableable/optional, because turning
// them off would break offer creation or the salary/tax engine itself.
const OFFER_FIELD_CHECKS: Record<string, { label: string; section: string; locked?: boolean; present: (o: any) => boolean }> = {
  candidateFirstName: { label: "First Name", section: "Candidate & Position", locked: true, present: (o) => !!o.candidateFirstName?.trim() },
  candidateMiddleName: { label: "Middle Name", section: "Candidate & Position", present: (o) => !!o.candidateMiddleName?.trim() },
  candidateLastName: { label: "Last Name", section: "Candidate & Position", locked: true, present: (o) => !!o.candidateLastName?.trim() },
  // Relabeled from "Personal Email" — candidateEmail is actually the official/work email (see
  // schema.prisma's own comment); it was colliding with the genuinely-personal
  // candidatePersonalEmail field below, whose own placeholder always said "distinct from the
  // official Email above".
  personalEmail: { label: "Official Email", section: "Candidate & Position", locked: true, present: (o) => !!o.candidateEmail?.trim() },
  phoneNumber: { label: "Personal Phone", section: "Candidate & Position", present: (o) => !!o.candidatePhone?.trim() },
  officialPhone: { label: "Official Phone", section: "Candidate & Position", present: (o) => !!o.candidateOfficialPhone?.trim() },
  candidatePersonalEmail: { label: "Personal Email", section: "Candidate & Position", present: (o) => !!o.candidatePersonalEmail?.trim() },
  gender: { label: "Gender", section: "Candidate & Position", present: (o) => !!o.gender },
  maritalStatus: { label: "Marital Status", section: "Candidate & Position", present: (o) => !!o.maritalStatus },
  dateOfBirth: { label: "Date of Birth", section: "Candidate & Position", present: (o) => !!o.dateOfBirth },
  employmentType: { label: "Employment Type", section: "Candidate & Position", locked: true, present: (o) => !!o.employmentType },
  designation: { label: "Designation", section: "Candidate & Position", locked: true, present: (o) => !!o.designation?.trim() },
  businessUnitId: { label: "Business Unit", section: "Candidate & Position", present: (o) => !!o.businessUnitId },
  countryCode: { label: "Country", section: "Candidate & Position", present: (o) => !!o.countryCode },
  ctc: { label: "CTC (Annual)", section: "Candidate & Position", locked: true, present: (o) => o.ctc > 0 },
  offerDate: { label: "Offer Date", section: "Candidate & Position", locked: true, present: (o) => !!o.offerDate },
  joiningDate: { label: "Proposed Joining Date", section: "Candidate & Position", locked: true, present: (o) => !!o.proposedJoiningDate },
  resume: { label: "Resume", section: "Candidate & Position", present: (o) => !!o.resumeFileData },
  aadhaar: { label: "Aadhaar", section: "Candidate & Position", present: (o) => !!o.aadhaarNumber && !!o.aadhaarFileData },
  pan: { label: "PAN", section: "Candidate & Position", present: (o) => !!o.panNumber },
  // Intern's Stage 1 captures these up front too (see schema.prisma Offer.educationCertificate*/
  // photo* fields) instead of a later, separate Document Collection stage.
  educationCertificate: { label: "Education Certificate", section: "Candidate & Position", present: (o) => !!o.educationCertificateFileData },
  photo: { label: "Photo", section: "Candidate & Position", present: (o) => !!o.photoFileData },
  // Zero-cost Contractor/Intern checkbox — captured on the same Candidate & Position card
  // regardless of country.
  noCostToCompany: { label: "No Cost to Company", section: "Candidate & Position", present: (o) => !!o.noCostToCompany },
  // US-only engagement breakdown (W2 Full-Time / W2 Hourly / Vendor) and its derived hourly-rate
  // fields — Canada has no equivalent (its flat CTC is covered by `ctc` above already).
  // `locked` — these three drive the derived billing-basis/CTC computation itself (same reasoning
  // as `ctc`/`employmentType` above being locked); hiding them would break that computation.
  usEngagementType: { label: "US Engagement", section: "Candidate & Position", locked: true, present: (o) => !!o.usEngagementType },
  hourlyRateUsd: { label: "Hourly Rate (USD)", section: "Candidate & Position", locked: true, present: (o) => o.hourlyRateUsd > 0 },
  hoursPerDay: { label: "Number of Hours (per day)", section: "Candidate & Position", locked: true, present: (o) => o.hoursPerDay > 0 },
  address: { label: "Address Line", section: "Address", present: (o) => !!o.candidateAddress?.trim() },
  // Permanent Address's own sub-fields beyond the single Address Line above, plus the whole
  // Resident (current) Address block — all captured on the same Address card, every BU.
  candidateCity: { label: "City", section: "Address", present: (o) => !!o.candidateCity?.trim() },
  candidateLandmark: { label: "Nearby Landmark", section: "Address", present: (o) => !!o.candidateLandmark?.trim() },
  candidateState: { label: "State", section: "Address", present: (o) => !!o.candidateState?.trim() },
  candidatePincode: { label: "Pincode", section: "Address", present: (o) => !!o.candidatePincode?.trim() },
  residentSameAsPermanent: { label: "Resident Address same as Permanent", section: "Address", present: () => true },
  residentAddress: { label: "Resident Address Line", section: "Address", present: (o) => !!o.residentAddress?.trim() },
  residentCity: { label: "Resident City", section: "Address", present: (o) => !!o.residentCity?.trim() },
  residentLandmark: { label: "Resident Nearby Landmark", section: "Address", present: (o) => !!o.residentLandmark?.trim() },
  residentState: { label: "Resident State", section: "Address", present: (o) => !!o.residentState?.trim() },
  residentPincode: { label: "Resident Pincode", section: "Address", present: (o) => !!o.residentPincode?.trim() },
  reportingManager: { label: "Reporting To", section: "Offer Terms", locked: true, present: (o) => !!o.reportingManager?.trim() },
  department: { label: "Department", section: "Offer Terms", locked: true, present: (o) => !!o.department?.trim() },
  workLocation: { label: "Work Location", section: "Offer Terms", present: (o) => !!o.workLocation },
  probationPeriod: { label: "Probation Period", section: "Offer Terms", present: (o) => !!o.probationPeriod },
  noticePeriod: { label: "Notice Period", section: "Offer Terms", present: (o) => !!o.noticePeriod },
  acceptanceDeadline: { label: "Acceptance Deadline", section: "Offer Terms", present: (o) => !!o.acceptanceDeadline },
  documentChecklist: { label: "List of Joining Documents", section: "List of Joining Documents", present: () => true },
  // Section: Service Agreement Terms — CONTRACTOR-only, captured on the separate "Generate
  // Service Agreement"/"Generate SLA" form (Hr.tsx ServiceAgreementGeneratePanel), same Stage 1
  // ("Candidate Information & Generate SLA") as the rest of this catalog. present() reads
  // offer.serviceAgreement, which unmetMandatoryOfferFields never actually calls these against —
  // that gate is Employee-/generate-only (Contractors short-circuit before it in
  // POST /offers/:id/generate) — these exist purely for resolveOfferFieldConfig's
  // enabled/mandatory configurability, consumed directly by ServiceAgreementGeneratePanel itself.
  monthlyCompensation: { label: "Monthly Compensation (INR)", section: "Service Agreement Terms", locked: true, present: (o) => !!o.serviceAgreement?.monthlyCompensation },
  effectiveDate: { label: "Effective Date", section: "Service Agreement Terms", locked: true, present: (o) => !!o.serviceAgreement?.dynamicFields?.EffectiveDate },
  // SLA Name/Address are deliberately their OWN fields, independent of the Candidate Information
  // section's First/Middle/Last Name and Address — the SLA prints the Service Agreement's own
  // ContractorName/ContractorAddress, never the candidate-info name/address, per explicit request
  // (a contractor's legal/billing name or registered address can genuinely differ from what's on
  // the candidate profile).
  slaName: { label: "SLA Name", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.ContractorName },
  aadharNumber: { label: "Aadhar / ID Number", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.AadharNumber },
  contractorAddress: { label: "SLA Address", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.ContractorAddress },
  bankName: { label: "Bank Name", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.BankName },
  bankAccountNumber: { label: "Bank Account Number", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.BankAccountNumber },
  bankIfsc: { label: "IFSC", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.BankIFSC },
  bankBranchName: { label: "Branch Name", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.BankBranchName },
  // Intern-only Internship Letter fields — Contractor's Service Agreement has neither (its
  // engagement isn't date-bounded the same way).
  internshipLocation: { label: "Location", section: "Service Agreement Terms", present: (o) => !!o.serviceAgreement?.dynamicFields?.Location },
  internshipEndDate: { label: "Internship End Date", section: "Service Agreement Terms", locked: true, present: (o) => !!o.serviceAgreement?.dynamicFields?.EndDateRaw },
  // Section: Vendor Engagement — US "Hired from Vendor" / Canada Contractor only, feeds
  // MsaSowAgreementPanel's MSA/SOW generation (Hr.tsx). Never shown for India or a direct US/
  // Canada employee.
  // locked — hard-required by Generate Offer's own submit validation once Vendor engagement is
  // picked (MsaSowAgreementPanel's MSA/SOW flow gates entirely on offer.vendorName existing).
  vendorName: { label: "Service Provider (Vendor) Name", section: "Vendor Engagement", locked: true, present: (o) => !!o.vendorName?.trim() },
  vendorEin: { label: "Vendor Federal EIN", section: "Vendor Engagement", locked: true, present: (o) => !!o.vendorEin?.trim() },
  endClientName: { label: "End Client Name", section: "Vendor Engagement", locked: true, present: (o) => !!o.endClientName?.trim() },
  vendorAddress: { label: "Vendor Address", section: "Vendor Engagement", present: (o) => !!o.vendorAddress?.trim() },
  engagementDescription: { label: "Engagement / Project Description", section: "Vendor Engagement", present: (o) => !!o.engagementDescription?.trim() },
  // Section: US/Canada Supporting Documents — the artifact's fixed Stage 1 document list
  // (Hr.tsx usCanDocTypes), now exposed here too so HR can toggle enabled/mandatory per BU like
  // every other field, instead of it being hardcoded with no configuration at all.
  ssnSinDocument: { label: "SSN / SIN Document", section: "US/Canada Supporting Documents", present: (o) => !!(o.documents || []).some((d: any) => d.docType === "SSN_SIN") },
  workAuthorizationDocument: { label: "Work Authorization / Work Permit", section: "US/Canada Supporting Documents", present: (o) => !!(o.documents || []).some((d: any) => d.docType === "WORK_AUTHORIZATION") },
  driversLicenseDocument: { label: "Driver's License / Photo ID", section: "US/Canada Supporting Documents", present: (o) => !!(o.documents || []).some((d: any) => d.docType === "DRIVERS_LICENSE") },
  w9VoidChequeDocument: { label: "W-9 / Void Cheque", section: "US/Canada Supporting Documents", present: (o) => !!(o.documents || []).some((d: any) => d.docType === "W9" || d.docType === "VOID_CHEQUE") },
};

/** Any configured-mandatory field (from the OFFER_GENERATION and/or DATA_COLLECTION stages) that's
 *  still missing on this offer — drives the Generate Offer button's disabled state dynamically
 *  (Sections 8/9: HR toggles a field mandatory/optional in the Workflow Builder, no code change). */
export async function unmetMandatoryOfferFields(offerId: number): Promise<{ key: string; label: string }[]> {
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { documents: true } });
  if (!offer) return [];
  const wf = await offerWorkflow(offerId) || await getPublishedWorkflow(workflowBucketFor(offer));
  // CAPTURE_INFORMATION is the US/Canada simplified-pipeline equivalent of India's OFFER_GENERATION/
  // DATA_COLLECTION/CANDIDATE_INFO stages — same real Generate Offer form, just one merged stage
  // instead of three. Omitting it here meant US/Canada's "Capture Information" stage could never
  // carry field config at all (see Workflow Builder's OFFER_FIELD_CATALOG).
  const relevant = (wf?.stages || []).filter((s: any) => s.enabled && (s.stageType === "OFFER_GENERATION" || s.stageType === "DATA_COLLECTION" || s.stageType === "CANDIDATE_INFO" || s.stageType === "CAPTURE_INFORMATION"));
  const fieldMap = new Map<string, boolean>(); // key -> mandatory
  for (const s of relevant) {
    for (const f of (Array.isArray(s.mandatoryFields) ? s.mandatoryFields : [])) {
      if (OFFER_FIELD_CHECKS[f.key]) fieldMap.set(f.key, f.enabled !== false && !!f.mandatory);
    }
  }
  // No workflow / no configured fields at all -> fall back to the hardcoded baseline (Resume +
  // Aadhaar), same as before the engine existed, so this is additive rather than a regression.
  if (!fieldMap.size) { fieldMap.set("resume", true); fieldMap.set("aadhaar", true); }
  const missing: { key: string; label: string }[] = [];
  for (const [key, mandatory] of fieldMap) {
    if (!mandatory) continue;
    const check = OFFER_FIELD_CHECKS[key];
    if (check && !check.present(offer)) missing.push({ key, label: check.label });
  }
  return missing;
}

// Same four section names, in the same order, as the real Generate Offer form's own SectionLabels
// (client/pages/hrms/Hr.tsx) — "Candidate & Position", "Address", "Offer Terms", "List of Joining
// Documents" — so the Workflow Builder's config UI and live preview group fields identically.
const OFFER_FIELD_ORDER = [
  "candidateFirstName", "candidateMiddleName", "candidateLastName", "personalEmail", "phoneNumber", "officialPhone", "candidatePersonalEmail", "gender", "maritalStatus", "dateOfBirth", "employmentType",
  "designation", "businessUnitId", "countryCode", "ctc", "offerDate", "joiningDate", "resume", "aadhaar", "pan", "educationCertificate", "photo",
  "noCostToCompany", "usEngagementType", "hourlyRateUsd", "hoursPerDay",
  "address", "candidateCity", "candidateLandmark", "candidateState", "candidatePincode",
  "residentSameAsPermanent", "residentAddress", "residentCity", "residentLandmark", "residentState", "residentPincode",
  "reportingManager", "department", "workLocation", "probationPeriod", "noticePeriod", "acceptanceDeadline",
  "documentChecklist",
  "monthlyCompensation", "effectiveDate", "slaName", "aadharNumber", "contractorAddress", "bankName", "bankAccountNumber", "bankIfsc", "bankBranchName",
  "internshipLocation", "internshipEndDate",
  "vendorName", "vendorEin", "endClientName", "vendorAddress", "engagementDescription",
  "ssnSinDocument", "workAuthorizationDocument", "driversLicenseDocument", "w9VoidChequeDocument",
];

/** Full {key,label,section,locked,enabled,mandatory} list for every known Offer-Generation field,
 *  config-merged — drives both the REAL Generate Offer form (which fields even show up, and which
 *  are required) and the Workflow Builder's live preview, off the SAME source so they can never
 *  drift apart. `locked` fields always resolve enabled:true/mandatory:true regardless of any stored
 *  config — they're hard server-side requirements, never actually optional.
 *  `offerId` omitted (or not yet pinned) falls back to whatever's currently PUBLISHED for
 *  `workflowBucketFor({employmentType, countryCode})` — the only caller that omits `offerId` is
 *  the brand-new Generate Offer form, before any offer row exists yet, so it re-fetches this with
 *  the right employmentType/countryCode as HR toggles the Employment Type/Country dropdowns.
 *  `countryCode` is what routes a US/Canada candidate to the "US_CANADA" workflow bucket instead
 *  of India's EMPLOYEE/CONTRACTOR/INTERN ones — omitting it here would silently fall back to
 *  India's field config for a brand-new US/Canada candidate, the exact bug this parameter fixes. */
/** Resolves the final render ORDER for a stage/catalog's fields — the Workflow Builder's drag-to-
 *  reorder (Configure panel) persists the new sequence by simply re-saving that stage's own
 *  `mandatoryFields` array in the dragged order (no separate order column — the array's own
 *  sequence IS the configured order). A field with no explicit position yet (newly added to the
 *  catalog in code, or a workflow nobody has re-ordered) is appended afterward in the catalog's own
 *  default order, so it's never silently hidden/misplaced just for lacking a stored position. */
function orderKeysByConfig(defaultOrder: string[], configuredArrays: any[][]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const arr of configuredArrays) {
    for (const f of (Array.isArray(arr) ? arr : [])) {
      if (defaultOrder.includes(f.key) && !seen.has(f.key)) { ordered.push(f.key); seen.add(f.key); }
    }
  }
  for (const key of defaultOrder) if (!seen.has(key)) { ordered.push(key); seen.add(key); }
  return ordered;
}

export async function resolveOfferFieldConfig(offerId?: number, employmentType?: string, countryCode?: string): Promise<{ key: string; label: string; section: string; locked: boolean; enabled: boolean; mandatory: boolean }[]> {
  // An existing (even unpinned) offer's OWN employmentType/countryCode win over whatever was
  // passed in the query string — the query params only matter pre-creation, when no offer row
  // exists yet.
  const existingOffer = offerId ? await prisma.offer.findUnique({ where: { id: offerId }, select: { employmentType: true, countryCode: true } }) : null;
  const wf = (offerId ? await offerWorkflow(offerId) : null) || await getPublishedWorkflow(workflowBucketFor({
    employmentType: existingOffer?.employmentType || employmentType,
    countryCode: existingOffer?.countryCode || countryCode,
  }));
  // CANDIDATE_INFO included alongside OFFER_GENERATION/DATA_COLLECTION — the default workflow ships
  // these as separate stages, but they drive the exact same real form (Generate Offer), so either
  // one (or several) can carry field config and HR can freely merge/delete the redundant one(s)
  // from the Workflow Builder without losing any field configuration. CAPTURE_INFORMATION is the
  // US/Canada simplified pipeline's own single merged equivalent of those three — same real form.
  const relevant = (wf?.stages || []).filter((s: any) => s.enabled && (s.stageType === "OFFER_GENERATION" || s.stageType === "DATA_COLLECTION" || s.stageType === "CANDIDATE_INFO" || s.stageType === "CAPTURE_INFORMATION"));
  const configured = new Map<string, { enabled: boolean; mandatory: boolean }>();
  for (const s of relevant) {
    for (const f of (Array.isArray(s.mandatoryFields) ? s.mandatoryFields : [])) {
      if (OFFER_FIELD_CHECKS[f.key]) configured.set(f.key, { enabled: f.enabled !== false, mandatory: !!f.mandatory });
    }
  }
  const orderedKeys = orderKeysByConfig(OFFER_FIELD_ORDER, relevant.map((s: any) => s.mandatoryFields));
  return orderedKeys.map((key) => {
    const meta = OFFER_FIELD_CHECKS[key];
    if (meta.locked) return { key, label: meta.label, section: meta.section, locked: true, enabled: true, mandatory: true };
    const c = configured.get(key);
    // No config at all for this field yet -> additive baseline: always shown, and Resume/Aadhaar
    // default mandatory (matches the fixed rule that existed before the engine did).
    return { key, label: meta.label, section: meta.section, locked: false, enabled: c ? c.enabled : true, mandatory: c ? c.mandatory : (key === "resume" || key === "aadhaar") };
  });
}

// Same {key,label,section,locked} vocabulary as OFFER_FIELD_CHECKS, but for the other real forms
// in the app that already have a dedicated Workflow stage type — Appointment Letter generation
// (client AppointmentGeneratePanel), the IT Provisioning request (ItProvisioningPanel) and Confirm
// Joining / Employee Activation (ConfirmJoiningPanel). `locked` fields are that form's own real
// client/server hard requirements (see each route's own validation) — shown but never disableable.
type FieldMeta = { label: string; section: string; locked?: boolean };
// Record Candidate Acceptance (client AcceptancePanel) — shared by India's Employee (Offer
// Letter) and Contractor/Intern (Service Agreement/Internship Letter) workflows alike, same
// OFFER_ACCEPTANCE stageType. Previously had NO Workflow & Stage Configuration wiring at all —
// every field here was unconditionally rendered.
const ACCEPTANCE_FIELD_CHECKS: Record<string, FieldMeta> = {
  // "required before Confirm Acceptance" is a hard client-side gate (Confirm Acceptance stays
  // disabled until this is uploaded) — locked, same reasoning as every other locked field.
  signedDocument: { label: "Signed Offer Letter / Service Agreement", section: "Record Acceptance", locked: true },
  // Employee-only — Contractor/Intern's acceptance has no method/notes, just the signed document.
  acceptanceMethod: { label: "How did the candidate accept?", section: "Record Acceptance" },
  acceptanceNote: { label: "Notes", section: "Record Acceptance" },
};
const ACCEPTANCE_FIELD_ORDER = ["signedDocument", "acceptanceMethod", "acceptanceNote"];

const APPOINTMENT_FIELD_CHECKS: Record<string, FieldMeta> = {
  // Hard-gates the "Generate Appointment Letter" button regardless of whether Resume was already
  // marked mandatory back at Offer Generation — locked, same real requirement either way.
  resume: { label: "Resume", section: "Appointment Details", locked: true },
  empNo: { label: "Employee ID", section: "Appointment Details" },
  emergencyContactPhone: { label: "Emergency Contact Number", section: "Appointment Details", locked: true },
  reportingManager: { label: "Reporting Manager", section: "Appointment Details" },
  workLocation: { label: "Work Location", section: "Appointment Details" },
  department: { label: "Department", section: "Appointment Details" },
  employmentType: { label: "Employment Type", section: "Appointment Details" },
  noticePeriod: { label: "Notice Period", section: "Appointment Details" },
  probationPeriod: { label: "Probation Period", section: "Appointment Details" },
};
// "resume" was defined in APPOINTMENT_FIELD_CHECKS above but missing here — catalog.order.map(...)
// in resolveStageFieldConfig only ever iterates this array, so the entry was completely invisible
// to the Workflow Builder (and to the client's fetched fieldConfig) despite existing in CHECKS.
const APPOINTMENT_FIELD_ORDER = ["resume", "empNo", "emergencyContactPhone", "reportingManager", "workLocation", "department", "employmentType", "noticePeriod", "probationPeriod"];

const IT_PROVISIONING_FIELD_CHECKS: Record<string, FieldMeta> = {
  // First/Last/Job Title/Department/Official Email are always inherited read-only from the Offer
  // (Section 4/6.2 — "avoid asking users to re-enter information that already exists"), shown here
  // only so HR can see/toggle their VISIBILITY on the form, never their value. Key stays
  // "personalEmail" for backward compatibility with existing stored config/templates, but it's
  // actually offer.candidateEmail — the official/work email, same relabel as Candidate & Position.
  firstName: { label: "First Name", section: "IT Provisioning" },
  lastName: { label: "Last Name", section: "IT Provisioning" },
  candidateName: { label: "Candidate Name", section: "IT Provisioning" },
  jobTitle: { label: "Job Title", section: "IT Provisioning" },
  department: { label: "Department", section: "IT Provisioning" },
  personalEmail: { label: "Official Email", section: "IT Provisioning" },
  reportingManagerContext: { label: "Reporting Manager", section: "IT Provisioning" },
  proposedJoiningDateContext: { label: "Proposed Joining Date", section: "IT Provisioning" },
  shipToAddress: { label: "Address (for equipment shipping)", section: "IT Provisioning" },
  emailIdToCreate: { label: "Email ID to Create", section: "IT Provisioning", locked: true },
  osRequirement: { label: "OS Requirement", section: "IT Provisioning", locked: true },
  laptopConfiguration: { label: "Laptop Configuration", section: "IT Provisioning", locked: true },
  requiredApplications: { label: "Requested Applications", section: "IT Provisioning" },
  requiredAccess: { label: "Access Requirements", section: "IT Provisioning" },
  otherRequirements: { label: "Other Hardware/Software Requirements", section: "IT Provisioning" },
  phoneNumber: { label: "Phone Number", section: "IT Provisioning" },
};
const IT_PROVISIONING_FIELD_ORDER = [
  "firstName", "lastName", "candidateName", "jobTitle", "department", "personalEmail", "reportingManagerContext", "proposedJoiningDateContext", "shipToAddress",
  "emailIdToCreate", "osRequirement", "laptopConfiguration", "requiredApplications", "requiredAccess", "otherRequirements", "phoneNumber",
];

const ACTIVATION_FIELD_CHECKS: Record<string, FieldMeta> = {
  // Real form's label is dynamic ("Actual Start Date" for Contractor, "Actual Joining Date" for
  // Employee — Hr.tsx ConfirmJoiningPanel) — this single static catalog entry covers both.
  actualJoiningDate: { label: "Actual Joining / Start Date", section: "Onboarding Activation", locked: true },
  projectId: { label: "Project", section: "Onboarding Activation" },
  isBillable: { label: "Billable", section: "Onboarding Activation" },
  ctcEffectiveFrom: { label: "Effective From", section: "Onboarding Activation", locked: true },
  ctcEffectiveTill: { label: "Effective Till", section: "Onboarding Activation" },
  deploymentStart: { label: "Deployment Start", section: "Onboarding Activation", locked: true },
  deploymentEnd: { label: "Deployment End", section: "Onboarding Activation", locked: true },
};
// Matches the real ConfirmJoiningPanel form's true visual order (Hr.tsx) — Billable renders LAST,
// after Deployment End, not 3rd; this is only the DEFAULT for a workflow nobody has drag-reordered
// yet (see orderKeysByConfig above).
const ACTIVATION_FIELD_ORDER = ["actualJoiningDate", "projectId", "ctcEffectiveFrom", "ctcEffectiveTill", "deploymentStart", "deploymentEnd", "isBillable"];

const STAGE_TYPE_CATALOGS: Record<string, { checks: Record<string, FieldMeta>; order: string[] }> = {
  OFFER_ACCEPTANCE: { checks: ACCEPTANCE_FIELD_CHECKS, order: ACCEPTANCE_FIELD_ORDER },
  APPOINTMENT_GENERATION: { checks: APPOINTMENT_FIELD_CHECKS, order: APPOINTMENT_FIELD_ORDER },
  IT_PROVISIONING: { checks: IT_PROVISIONING_FIELD_CHECKS, order: IT_PROVISIONING_FIELD_ORDER },
  EMPLOYEE_ACTIVATION: { checks: ACTIVATION_FIELD_CHECKS, order: ACTIVATION_FIELD_ORDER },
};

/** Generic version of resolveOfferFieldConfig for any of the three stage types above — same
 *  {key,label,section,locked,enabled,mandatory} shape, config-merged off that single stage's own
 *  `mandatoryFields`. Returns [] for a stageType with no catalog (nothing to configure) or no
 *  matching enabled stage in the workflow. */
// ConfirmJoiningPanel (client) always asks for "EMPLOYEE_ACTIVATION" field config regardless of
// which pipeline the offer is on — the US/Canada simplified workflow's equivalent stage is typed
// "ONBOARDING_ACTIVATION" instead (same real form, different stage type per pipeline). Without
// this alias, a US/Canada offer's Activation stage could never carry field config at all.
const STAGE_TYPE_ALIASES: Record<string, string[]> = { EMPLOYEE_ACTIVATION: ["ONBOARDING_ACTIVATION"] };

export async function resolveStageFieldConfig(stageType: string, offerId?: number): Promise<{ key: string; label: string; section: string; locked: boolean; enabled: boolean; mandatory: boolean }[]> {
  const catalog = STAGE_TYPE_CATALOGS[stageType];
  if (!catalog) return [];
  const existingOffer = offerId ? await prisma.offer.findUnique({ where: { id: offerId }, select: { employmentType: true, countryCode: true } }) : null;
  const wf = (offerId ? await offerWorkflow(offerId) : null) || await getPublishedWorkflow(workflowBucketFor(existingOffer || {}));
  const acceptedTypes = [stageType, ...(STAGE_TYPE_ALIASES[stageType] || [])];
  const stage = (wf?.stages || []).find((s: any) => s.enabled && acceptedTypes.includes(s.stageType));
  const configured = new Map<string, { enabled: boolean; mandatory: boolean }>();
  for (const f of (Array.isArray(stage?.mandatoryFields) ? stage.mandatoryFields : [])) {
    if (catalog.checks[f.key]) configured.set(f.key, { enabled: f.enabled !== false, mandatory: !!f.mandatory });
  }
  const orderedKeys = orderKeysByConfig(catalog.order, [stage?.mandatoryFields]);
  return orderedKeys.map((key) => {
    const meta = catalog.checks[key];
    if (meta.locked) return { key, label: meta.label, section: meta.section, locked: true, enabled: true, mandatory: true };
    const c = configured.get(key);
    return { key, label: meta.label, section: meta.section, locked: false, enabled: c ? c.enabled : true, mandatory: c ? c.mandatory : false };
  });
}

// Custom Fields — HR-defined, added purely from the Workflow Builder (no code change), stored as
// `{key, label, fieldType, custom:true, enabled, mandatory}` entries inside a stage's own
// `mandatoryFields` array (same column, just flagged `custom`) so reordering/renaming a stage never
// loses them. Rendered generically (client CustomFieldsPanel), so unlike catalog fields a custom
// field can be freely reassigned to ANY stage — it isn't tied to any specific real form's code.
export type CustomFieldDef = { key: string; label: string; fieldType: "text" | "number" | "date"; enabled: boolean; mandatory: boolean };

/** Custom field definitions attached to one specific stage (by its own unique `key`, not stageType —
 *  a workflow can have several CUSTOM_STAGE stages, each with its own independent custom fields). */
export async function resolveCustomFieldsForStage(stageKey: string, offerId?: number): Promise<CustomFieldDef[]> {
  const existingOffer = offerId ? await prisma.offer.findUnique({ where: { id: offerId }, select: { employmentType: true } }) : null;
  const wf = (offerId ? await offerWorkflow(offerId) : null) || await getPublishedWorkflow(existingOffer?.employmentType);
  const stage = (wf?.stages || []).find((s: any) => s.key === stageKey);
  if (!stage?.enabled) return [];
  const fields = Array.isArray(stage.mandatoryFields) ? stage.mandatoryFields : [];
  return fields
    .filter((f: any) => f.custom && f.enabled !== false)
    .map((f: any) => ({ key: f.key, label: f.label, fieldType: f.fieldType || "text", enabled: true, mandatory: !!f.mandatory }));
}

/** Save this offer's values for one stage's custom fields — validates mandatory ones are filled,
 *  merges into Offer.customFields (a flat {fieldKey: value} map; keys are globally-unique slugs
 *  generated when the field was created, so merging across stages can never collide). */
export async function applyCustomFieldValues(offerId: number, stageKey: string, values: Record<string, any>): Promise<{ ok: true } | { ok: false; error: string }> {
  const defs = await resolveCustomFieldsForStage(stageKey, offerId);
  if (!defs.length) return { ok: false, error: "No custom fields configured for this stage." };
  const missing = defs.filter((d) => d.mandatory && !String(values[d.key] ?? "").trim());
  if (missing.length) return { ok: false, error: `${missing.map((m) => m.label).join(", ")} required.` };
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, select: { customFields: true } });
  const merged = { ...(offer?.customFields as any || {}) };
  for (const d of defs) if (d.key in values) merged[d.key] = values[d.key];
  await prisma.offer.update({ where: { id: offerId }, data: { customFields: merged } });
  return { ok: true };
}

/** Per-stage status for one offer, in configured order — "unlocked" mirrors requireStageUnlocked,
 *  "current" flags the first enabled stage that isn't COMPLETED/SKIPPED yet (what the UI should
 *  actively show/act on right now). Falls back to the PUBLISHED workflow, read-only, for an offer
 *  not pinned yet (nothing has completed, nothing is unlocked except stages with no dependencies)
 *  so a brand-new DRAFT offer can still show the full sequence before Offer Accepted pins it. */
// OFFER_GENERATION and APPOINTMENT_GENERATION are open-ended/regenerable — no OfferStageProgress
// row is ever marked COMPLETED for them by design (see completeStageByType's call sites: neither
// stageType appears there). Left as pure progress-based "isDone", they'd stay PENDING forever and
// permanently claim "current" for every offer that has actually moved well past them — nothing
// downstream (Offers & Lifecycle's Current Stage column, the HR Dashboard funnel, the Offer
// Detail wizard's auto-advance) would ever show the real current stage again. "Done" for these
// two is read off the real offer.status milestone instead. Shared by getOfferStageStatus (per-offer
// wizard) and getFunnelCounts (dashboard aggregate) so both agree on what "done" means.
function stageStatusOverride(offer: { status: string; appointmentLetter?: { issuedAt: Date | null } | null } | null, stageType: string, agreementSignatureDone?: boolean): boolean | null {
  if (!offer) return null;
  if (["OFFER_GENERATION", "DATA_COLLECTION", "CANDIDATE_INFO"].includes(stageType)) return !["DRAFT", "GENERATED", "PREVIEWED"].includes(offer.status);
  // US/Canada's Stage 1 (Capture Information) has no one milestone shared by both of its
  // sub-paths — a direct-hire Employee sends a real Offer Letter (offer.status leaves DRAFT), but
  // a Corp-to-Corp engagement never does (no document to send, just an MSA/SOW to sign) so
  // offer.status stays DRAFT forever. Either way, Stage 2 (Agreement & Signature) can only ever be
  // reached once Stage 1's info is actually captured, so treat Stage 1 as done the moment Stage 2
  // is — fixes the stage tracker showing Stage 2 complete while Stage 1 stayed stuck as "current".
  if (stageType === "CAPTURE_INFORMATION") return agreementSignatureDone ? true : null;
  // Keyed off the letter having actually been ISSUED (sent to the candidate), not merely
  // generated — generating it is only the first of three actions inside this one stage
  // (Generate -> Preview -> Send by Email/E-Signature); marking "done" on generation alone (a
  // prior version of this fix) skipped the wizard past Preview/Send before HR could use them.
  // A previous, different bug here keyed off offer.status === "JOINING_CONFIRMED" instead, which
  // only ever proved a letter existed under the OLD stage order (Appointment before Activation) —
  // under the current default order (Activation before Appointment) that falsely marked this
  // stage done immediately after Stage 5. issuedAt is correct under either ordering.
  if (stageType === "APPOINTMENT_GENERATION") return !!offer.appointmentLetter?.issuedAt;
  return null;
}

export async function getOfferStageStatus(offerId: number) {
  const [progress, offer] = await Promise.all([
    offerId ? getProgress(offerId) : Promise.resolve({} as Record<string, any>),
    prisma.offer.findUnique({ where: { id: offerId }, select: { status: true, employmentType: true, appointmentLetter: { select: { issuedAt: true } } } }),
  ]);
  const wf = (await offerWorkflow(offerId)) || (await getPublishedWorkflow(offer?.employmentType));
  if (!wf) return [];
  const byKey = new Map<string, any>(wf.stages.map((s: any) => [s.key, s]));
  const enabledStages = wf.stages.filter((s: any) => s.enabled);
  let foundCurrent = false;
  // OFFER_GENERATION and APPOINTMENT_GENERATION are open-ended/regenerable — no OfferStageProgress
  // row is ever marked COMPLETED for them by design (see completeStageByType's call sites: neither
  // stageType appears there). Left as pure progress-based "isDone", they'd stay PENDING forever and
  // permanently claim "current" for every offer that has actually moved well past them — nothing
  // downstream (Offers & Lifecycle's Current Stage column, the HR Dashboard funnel, the Offer
  // Detail wizard's auto-advance) would ever show the real current stage again. "Done" for these
  // two is read off the real offer.status milestone instead.
  //
  // BUT that "sent = done" reading only holds when Send and Accept are two DIFFERENT stages
  // (Contractor: sla_generation done-on-send, a separate offer_accepted stage tracks the real
  // acceptance). Intern's workflow has no OFFER_ACCEPTANCE-typed stage at all — sla_generation IS
  // the acceptance tracking for Intern (completeStageByType's own OFFER_ACCEPTANCE→OFFER_GENERATION
  // fallback, see its own comment, writes a real COMPLETED row there once acceptance genuinely
  // happens). Applying the "sent = done" override there too marked it done the instant HR clicked
  // Send — before the candidate had signed anything — which flipped "current" straight to Stage 3
  // (IT Provisioning/Activation) and made Stage 1/2's own manual-confirm / awaiting-signature UI
  // (which only renders while its tab is actually the current/selected one) never show at all.
  const hasOwnAcceptanceStage = wf.stages.some((s: any) => s.stageType === "OFFER_ACCEPTANCE" && s.enabled);
  const agreementSignatureKey = wf.stages.find((s: any) => s.stageType === "AGREEMENT_SIGNATURE")?.key;
  const agreementSignatureDone = agreementSignatureKey
    ? ["COMPLETED", "SKIPPED"].includes(progress[agreementSignatureKey]?.status)
    : false;
  const statusOverride = (stageType: string): boolean | null =>
    (stageType === "OFFER_GENERATION" && !hasOwnAcceptanceStage) ? null : stageStatusOverride(offer, stageType, agreementSignatureDone);
  return enabledStages.map((s: any) => {
    const status = progress[s.key]?.status || "PENDING";
    const dependsOn: string[] = Array.isArray(s.dependsOnKeys) ? s.dependsOnKeys : [];
    const unlocked = dependsOn.every((depKey) => {
      const dep = byKey.get(depKey);
      if (!dep || !dep.enabled) return true;
      const st = progress[depKey]?.status;
      return st === "COMPLETED" || st === "SKIPPED";
    });
    const override = statusOverride(s.stageType);
    const isDone = override !== null ? override : (status === "COMPLETED" || status === "SKIPPED");
    const current = !isDone && !foundCurrent;
    if (current) foundCurrent = true;
    const hasCustomFields = Array.isArray(s.mandatoryFields) && s.mandatoryFields.some((f: any) => f.custom && f.enabled !== false);
    // `done` is the resolved isDone (override-aware) — `status` stays the raw OfferStageProgress
    // value (still useful/shown elsewhere) but is permanently "PENDING" for override-driven stages
    // (OFFER_GENERATION/APPOINTMENT_GENERATION never get a real COMPLETED progress row by design —
    // see the comment above), so the client's "done -> green checkmark" nav indicator needs this
    // separate field instead of reading `status` directly, or it can never show green for them.
    return { key: s.key, name: s.name, stageType: s.stageType, order: s.order, candidateFacing: s.candidateFacing, status, done: isDone, unlocked, current, hasCustomFields };
  });
}

/** HR Dashboard funnel (Sections 11-13/21-22) — stage-by-stage counts, driven entirely by
 *  whatever's currently PUBLISHED. No hard-coded stage list: add/reorder/remove a stage in the
 *  Workflow Builder and this reflects it on the next call (15s cache, same as getPublishedWorkflow). */
export async function getFunnelCounts(employmentType: string = "EMPLOYEE") {
  const wf = await getPublishedWorkflow(employmentType);
  if (!wf) return { workflowName: null, workflowVersion: null, totalInWorkflow: 0, stages: [] };
  // Bulk-fetch every offer pinned to this workflow plus its stage-progress rows, then resolve
  // "done" per offer/stage the SAME override-aware way getOfferStageStatus does for the wizard —
  // counting raw OfferStageProgress rows alone (the old approach) always showed 0 completed for
  // OFFER_GENERATION/APPOINTMENT_GENERATION, since those never get a real COMPLETED row by design.
  // That silently hid two whole stages worth of real progress from this funnel for every offer.
  const [offers, progressRows] = await Promise.all([
    prisma.offer.findMany({ where: { workflowId: wf.id }, select: { id: true, status: true, appointmentLetter: { select: { issuedAt: true } } } }),
    prisma.offerStageProgress.findMany({ where: { offer: { workflowId: wf.id } }, select: { offerId: true, stageKey: true, status: true } }),
  ]);
  const total = offers.length;
  const progressByOffer = new Map<number, Map<string, string>>();
  for (const r of progressRows) {
    if (!progressByOffer.has(r.offerId)) progressByOffer.set(r.offerId, new Map());
    progressByOffer.get(r.offerId)!.set(r.stageKey, r.status);
  }
  const agreementSignatureKey = wf.stages.find((s: any) => s.stageType === "AGREEMENT_SIGNATURE")?.key;
  const stages = [];
  for (const s of wf.stages.filter((s: any) => s.enabled)) {
    let completed = 0, inProgress = 0;
    for (const o of offers) {
      const rawStatus = progressByOffer.get(o.id)?.get(s.key) || "PENDING";
      const agreementSignatureDone = agreementSignatureKey
        ? ["COMPLETED", "SKIPPED"].includes(progressByOffer.get(o.id)?.get(agreementSignatureKey) || "")
        : false;
      const override = stageStatusOverride(o, s.stageType, agreementSignatureDone);
      const isDone = override !== null ? override : (rawStatus === "COMPLETED" || rawStatus === "SKIPPED");
      if (isDone) completed++;
      else if (rawStatus === "IN_PROGRESS") inProgress++;
    }
    stages.push({ key: s.key, name: s.name, stageType: s.stageType, order: s.order, completed, inProgress, pending: Math.max(0, total - completed - inProgress), total });
  }
  return { workflowName: wf.name, workflowVersion: wf.version, totalInWorkflow: total, stages };
}

/** Configured document list for DOCUMENT_COLLECTION, resolved against what's already known about
 *  this offer (Aadhaar always excluded; PAN excluded if offer.panNumber is already set). Includes
 *  BOTH required and optional (required:false, e.g. Contractor's Salary Slips) documents — still
 *  offered to upload, just never block candidate submit / HR verify-all / auto-complete. */
export async function resolveRequiredDocuments(offerId: number): Promise<{ docType: string; label: string; multipleFiles: boolean; required: boolean }[]> {
  const wf = await offerWorkflow(offerId);
  const stage = stageOfType(wf, "DOCUMENT_COLLECTION");
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, select: { panNumber: true } });
  const configured: any[] = Array.isArray(stage?.requiredDocuments) && stage.requiredDocuments.length
    ? stage.requiredDocuments
    : [
        { docType: "PAN_CARD", label: "PAN Card", required: true, multipleFiles: false },
        { docType: "EDUCATION_CERTIFICATE", label: "Educational Certificate – Highest Qualification", required: true, multipleFiles: false },
        { docType: "PHOTO", label: "Passport-size Photograph", required: true, multipleFiles: false },
        { docType: "SALARY_SLIPS", label: "Last 3 Months' Salary Slips", required: true, multipleFiles: true },
      ];
  return configured
    // Aadhaar is always excluded regardless of config — captured (number + image) at Offer
    // Generation already. Matched by docType OR by label text, since HR can add a document with
    // any docType slug via "+ Add Document" in the Workflow Builder (only the literal "AADHAAR"
    // docType used to be caught, silently missing an HR-added one labeled "Aadhaar").
    .filter((d) => d.docType !== "AADHAAR" && !/aadhaar/i.test(d.label || ""))
    .filter((d) => !(d.docType === "PAN_CARD" && offer?.panNumber)) // already captured at Offer Generation
    .map((d) => ({ docType: d.docType, label: d.label, multipleFiles: !!d.multipleFiles, required: d.required !== false }));
}
