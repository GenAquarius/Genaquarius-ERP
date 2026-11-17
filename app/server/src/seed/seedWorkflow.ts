// Seeds (or re-seeds, if none is published yet) the default HR Workflow — Employee Lifecycle v1,
// PUBLISHED — so the workflow engine (engine/workflow.ts) has something to pin new offers to out
// of the box. Idempotent: no-ops if a published workflow already exists. Run via `npm run seed:workflow`.
import { prisma } from "../prisma";

const DEFAULT_STAGES = [
  // Candidate Information, Resume/Aadhaar Capture, and Offer Generation were originally three
  // separate stages — merged into one (2026-09-23, HR request) since they all just drive fields/
  // actions on the same real form (Generate Offer). Kept as stageType OFFER_GENERATION (its
  // `actions` are meaningfully tied to the real Generate Offer buttons); CANDIDATE_INFO/
  // DATA_COLLECTION are still accepted alongside it in the shared field-config merge
  // (engine/workflow.ts resolveOfferFieldConfig) in case HR ever splits it again.
  { key: "offer_generation", name: "Candidate Information & Generate Offer", stageType: "OFFER_GENERATION", order: 1, candidateFacing: "HR_ONLY", dependsOnKeys: [],
    mandatoryFields: [{ key: "resume", label: "Resume", mandatory: true }, { key: "aadhaar", label: "Aadhaar", mandatory: true }, { key: "pan", label: "PAN", mandatory: false }],
    actions: [{ key: "generate", label: "Generate Offer", enabled: true }, { key: "preview", label: "Preview Offer", enabled: true },
      { key: "send_email", label: "Send Offer Through Email", enabled: true }, { key: "send_esign", label: "Send Offer Through E-Signature", enabled: true },
      { key: "recalculate", label: "Recalculate", enabled: true }, { key: "regenerate", label: "Regenerate Offer", enabled: true }] },
  // No dependsOnKeys — /offers/:id/accept enforces "must be Sent" via offer.status directly, not
  // the engine (Offer Generation is open-ended/regenerable, never marked COMPLETED by the engine,
  // so listing it as a real dependency here would leave this stage permanently "locked" on paper).
  { key: "offer_accepted", name: "Offer Accepted", stageType: "OFFER_ACCEPTANCE", order: 2, candidateFacing: "CANDIDATE_FACING", completionMode: "AUTO", dependsOnKeys: [] },
  { key: "document_collection", name: "Mandatory Document Collection", stageType: "DOCUMENT_COLLECTION", order: 3, candidateFacing: "CANDIDATE_FACING", dependsOnKeys: ["offer_accepted"],
    requiredDocuments: [
      { docType: "PAN_CARD", label: "PAN Card", required: true, candidateUpload: true, hrVerification: true, allowReupload: true, multipleFiles: false, order: 1 },
      { docType: "EDUCATION_CERTIFICATE", label: "Educational Certificate – Highest Qualification", required: true, candidateUpload: true, hrVerification: true, allowReupload: true, multipleFiles: false, order: 2 },
      { docType: "PHOTO", label: "Passport-size Photograph", required: true, candidateUpload: true, hrVerification: true, allowReupload: true, multipleFiles: false, order: 3 },
      { docType: "SALARY_SLIPS", label: "Last 3 Months' Salary Slips", required: true, candidateUpload: true, hrVerification: true, allowReupload: true, multipleFiles: true, order: 4 },
    ],
    notification: { sendEmail: true, templateKey: "DOCUMENT_COLLECTION_REQUEST", sendMode: "MANUAL", useSecureLink: true } },
  { key: "it_provisioning", name: "IT Provisioning Request", stageType: "IT_PROVISIONING", order: 4, candidateFacing: "HR_ONLY", dependsOnKeys: ["document_collection"] },
  { key: "employee_activation", name: "Onboarding Activation", stageType: "EMPLOYEE_ACTIVATION", order: 5, candidateFacing: "HR_ONLY", dependsOnKeys: ["offer_accepted", "document_collection", "it_provisioning"] },
  // Default: Appointment AFTER Employee Activation (per the confirmed 2026-09-23 ordering) — HR
  // can freely drag these before Employee Activation instead from the Workflow Builder.
  { key: "appointment_generation", name: "Appointment Generation", stageType: "APPOINTMENT_GENERATION", order: 6, candidateFacing: "HR_ONLY", dependsOnKeys: ["employee_activation"],
    actions: [{ key: "generate", label: "Generate Appointment", enabled: true }, { key: "preview", label: "Preview Appointment", enabled: true },
      { key: "send_email", label: "Send Appointment Through Email", enabled: true }, { key: "send_esign", label: "Send Appointment Through E-Signature", enabled: true },
      { key: "view", label: "View Appointment", enabled: true }] },
  { key: "appointment_accepted", name: "Appointment Accepted", stageType: "APPOINTMENT_ACCEPTANCE", order: 7, candidateFacing: "CANDIDATE_FACING", completionMode: "AUTO", dependsOnKeys: ["appointment_generation"] },
];

export async function seedDefaultWorkflowIfMissing(): Promise<void> {
  const existing = await prisma.workflowDefinition.findFirst({ where: { status: "PUBLISHED" } });
  if (existing) return;
  await seedIt();
}

// One-time cleanup (idempotent — no-op once run, safe to leave in the boot sequence forever): the
// EMPLOYEE_ACTIVATION stage was renamed "Confirm Joining — Employee Activation" -> "Onboarding
// Activation" across the app's static UI text (nav label, panel/h1 titles, field-config section
// labels in engine/workflow.ts's ACTIVATION_FIELD_CHECKS) on 2026-09, but the STAGE NAME already
// stored on each employment type's own live WorkflowStage row (Employee's/Contractor's own
// "employee_activation" stage — Intern's equivalent stage was separately renamed to its own
// numbered label and is untouched here) was never updated to match, so Workflow & Stage
// Configuration kept showing the old name for that stage's own tab even after every other UI
// surface had switched to the new one.
export async function normalizeRenamedStageNames(): Promise<void> {
  const r = await prisma.workflowStage.updateMany({
    where: { stageType: "EMPLOYEE_ACTIVATION", name: "Confirm Joining — Employee Activation" },
    data: { name: "Onboarding Activation" },
  });
  if (r.count) console.log(`Renamed ${r.count} EMPLOYEE_ACTIVATION stage(s) to "Onboarding Activation".`);
}

async function main() {
  const existing = await prisma.workflowDefinition.findFirst({ where: { status: "PUBLISHED" } });
  if (existing) { console.log(`Published workflow already exists (v${existing.version}) — nothing to do.`); return; }
  await seedIt();
}

async function seedIt() {
  const wf = await prisma.workflowDefinition.create({
    data: { name: "Employee Lifecycle", version: 1, status: "PUBLISHED", appliesTo: "ALL", publishedAt: new Date() },
  });
  for (const s of DEFAULT_STAGES) {
    await prisma.workflowStage.create({
      data: {
        workflowId: wf.id, key: s.key, name: s.name, stageType: s.stageType, order: s.order,
        candidateFacing: (s as any).candidateFacing || "HR_ONLY", completionMode: (s as any).completionMode || "MANUAL",
        dependsOnKeys: s.dependsOnKeys as any, mandatoryFields: (s as any).mandatoryFields || [],
        requiredDocuments: (s as any).requiredDocuments || [], actions: (s as any).actions || [],
        notification: (s as any).notification || undefined,
      },
    });
  }
  console.log(`Seeded and published "Employee Lifecycle" v1 with ${DEFAULT_STAGES.length} stages.`);
}

// Only run standalone (npm run seed:workflow) — importing seedDefaultWorkflowIfMissing() from
// index.ts's boot sequence must NOT also trigger this (and must never disconnect the shared
// Prisma client other requests are using).
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
