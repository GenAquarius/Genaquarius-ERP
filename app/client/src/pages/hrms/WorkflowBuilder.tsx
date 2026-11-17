import React, { useState } from "react";
import { api } from "../../api";
import { useFetch, Panel } from "../../ui";
import { useToast, AddButton, GhostButton } from "../../components";
import { BrowserFrame } from "../itsm/Helpdesk";
import { BusinessUnitFilterBar } from "./Hr";
import { fmtDate, fmtDateTime } from "../../dateFormat";

// HR Settings -> Workflow & Stage Configuration. The visual builder for the HR Workflow Engine
// (server/src/engine/workflow.ts) — reorder (drag-and-drop), add/configure/remove stages, set
// dependencies/mandatory fields/required documents, validate, and publish. Everything here edits a
// DRAFT WorkflowDefinition; the live app only ever reads whatever's PUBLISHED (see the engine).
const CANDIDATE_FACING_OPTIONS = [["HR_ONLY", "HR Only"], ["CANDIDATE_FACING", "Candidate Facing"], ["BOTH", "Both HR and Candidate"]];
const COMPLETION_OPTIONS = [["MANUAL", "Manual — HR clicks Complete Stage"], ["AUTO", "Automatic — completes when its conditions are met"]];

// Mirrors server/src/engine/workflow.ts OFFER_FIELD_CHECKS/OFFER_FIELD_ORDER exactly (key, label,
// section, locked) — the same four section names as the real Generate Offer form
// (client/pages/hrms/Hr.tsx GenerateOffer: "Candidate & Position", "Address", "Offer Terms",
// "List of Joining Documents"), so Configure and its live Preview can never drift from the real form.
// `visibleFor` — which employmentType bucket(s) actually show this field on the real form;
// omitted = every bucket (EMPLOYEE/CONTRACTOR/INTERN/US_CANADA). Filters BOTH the Configure
// panel's Form Fields list and the Live Preview, so HR configuring e.g. the India Contractor
// workflow never sees US/Canada-only or Employee-only toggles that do nothing for Contractor.
type OfferField = { key: string; label: string; section: string; locked?: boolean; visibleFor?: ("EMPLOYEE" | "CONTRACTOR" | "INTERN" | "US_CANADA")[] };
const OFFER_FIELD_CATALOG: OfferField[] = [
  { key: "candidateFirstName", label: "First Name", section: "Candidate & Position", locked: true },
  { key: "candidateMiddleName", label: "Middle Name", section: "Candidate & Position" },
  { key: "candidateLastName", label: "Last Name", section: "Candidate & Position", locked: true },
  // Relabeled from "Personal Email" — candidateEmail is actually the official/work email (see
  // schema.prisma's own comment); it was colliding with the genuinely-personal
  // candidatePersonalEmail field below.
  { key: "personalEmail", label: "Official Email", section: "Candidate & Position", locked: true },
  { key: "phoneNumber", label: "Personal Phone", section: "Candidate & Position" },
  { key: "officialPhone", label: "Official Phone", section: "Candidate & Position" },
  { key: "candidatePersonalEmail", label: "Personal Email", section: "Candidate & Position" },
  { key: "gender", label: "Gender", section: "Candidate & Position" },
  { key: "maritalStatus", label: "Marital Status", section: "Candidate & Position" },
  { key: "dateOfBirth", label: "Date of Birth", section: "Candidate & Position" },
  { key: "employmentType", label: "Employment Type", section: "Candidate & Position", locked: true },
  { key: "designation", label: "Designation", section: "Candidate & Position", locked: true },
  { key: "businessUnitId", label: "Business Unit", section: "Candidate & Position" },
  { key: "countryCode", label: "Country", section: "Candidate & Position" },
  { key: "ctc", label: "CTC (Annual)", section: "Candidate & Position", locked: true },
  { key: "offerDate", label: "Offer Date", section: "Candidate & Position", locked: true },
  { key: "joiningDate", label: "Proposed Joining Date", section: "Candidate & Position", locked: true },
  { key: "resume", label: "Resume", section: "Candidate & Position" },
  // Aadhaar/PAN never show for a US/Canada candidate (isUsCanada hides them outright regardless
  // of config, per the signed-off design) — India-only buckets.
  { key: "aadhaar", label: "Aadhaar", section: "Candidate & Position", visibleFor: ["EMPLOYEE", "CONTRACTOR", "INTERN"] },
  { key: "pan", label: "PAN", section: "Candidate & Position", visibleFor: ["EMPLOYEE", "CONTRACTOR", "INTERN"] },
  { key: "educationCertificate", label: "Education Certificate", section: "Candidate & Position" },
  { key: "photo", label: "Photo", section: "Candidate & Position" },
  // Zero-cost Contractor/Intern checkbox — never shown for a plain India Employee.
  { key: "noCostToCompany", label: "No Cost to Company", section: "Candidate & Position", visibleFor: ["CONTRACTOR", "INTERN", "US_CANADA"] },
  // US-only engagement breakdown and derived hourly-rate fields — Canada has no equivalent (its
  // flat CTC is covered by `ctc` above already). Locked — these drive the derived billing-basis/
  // CTC computation itself, same reasoning as `ctc`/`employmentType` above.
  { key: "usEngagementType", label: "US Engagement", section: "Candidate & Position", locked: true, visibleFor: ["US_CANADA"] },
  { key: "hourlyRateUsd", label: "Hourly Rate (USD)", section: "Candidate & Position", locked: true, visibleFor: ["US_CANADA"] },
  { key: "hoursPerDay", label: "Number of Hours (per day)", section: "Candidate & Position", locked: true, visibleFor: ["US_CANADA"] },
  { key: "address", label: "Address Line", section: "Address" },
  // Permanent Address's own sub-fields, plus the whole Resident (current) Address block.
  { key: "candidateCity", label: "City", section: "Address" },
  { key: "candidateLandmark", label: "Nearby Landmark", section: "Address" },
  { key: "candidateState", label: "State", section: "Address" },
  { key: "candidatePincode", label: "Pincode", section: "Address" },
  { key: "residentSameAsPermanent", label: "Resident Address same as Permanent", section: "Address" },
  { key: "residentAddress", label: "Resident Address Line", section: "Address" },
  { key: "residentCity", label: "Resident City", section: "Address" },
  { key: "residentLandmark", label: "Resident Nearby Landmark", section: "Address" },
  { key: "residentState", label: "Resident State", section: "Address" },
  { key: "residentPincode", label: "Resident Pincode", section: "Address" },
  { key: "reportingManager", label: "Reporting To", section: "Offer Terms", locked: true },
  { key: "department", label: "Department", section: "Offer Terms", locked: true },
  // Hidden for India Contractor/Intern (isContractorForm) — isUsCanada overrides that hide, so
  // these always show for the US & Canada bucket regardless of which employment type is picked
  // there.
  { key: "workLocation", label: "Work Location", section: "Offer Terms", visibleFor: ["EMPLOYEE", "US_CANADA"] },
  { key: "probationPeriod", label: "Probation Period", section: "Offer Terms", visibleFor: ["EMPLOYEE", "US_CANADA"] },
  { key: "noticePeriod", label: "Notice Period", section: "Offer Terms", visibleFor: ["EMPLOYEE", "US_CANADA"] },
  { key: "acceptanceDeadline", label: "Acceptance Deadline", section: "Offer Terms" },
  // Never shown for isUsCanada (its own fixed Supporting Documents block below replaces it).
  { key: "documentChecklist", label: "List of Joining Documents", section: "List of Joining Documents", visibleFor: ["EMPLOYEE", "CONTRACTOR", "INTERN"] },
  // CONTRACTOR-only — captured on the separate "Generate Service Agreement"/"Generate SLA" form
  // (Hr.tsx ServiceAgreementGeneratePanel). Never applies to Intern (no bank/SLA-name/address
  // clauses) or US/Canada (Vendor engagement uses MSA/SOW instead, never this panel).
  { key: "monthlyCompensation", label: "Monthly Compensation (INR)", section: "Service Agreement Terms", locked: true, visibleFor: ["CONTRACTOR"] },
  { key: "effectiveDate", label: "Effective Date", section: "Service Agreement Terms", locked: true, visibleFor: ["CONTRACTOR"] },
  { key: "slaName", label: "SLA Name", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  { key: "aadharNumber", label: "Aadhar / ID Number", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  { key: "contractorAddress", label: "SLA Address", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  { key: "bankName", label: "Bank Name", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  { key: "bankAccountNumber", label: "Bank Account Number", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  { key: "bankIfsc", label: "IFSC", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  { key: "bankBranchName", label: "Branch Name", section: "Service Agreement Terms", visibleFor: ["CONTRACTOR"] },
  // Intern-only Internship Letter fields. India-only — US/Canada's Employment Type is now just
  // Employee (Full Time) / Corp to Corp, so Intern (and this whole panel) can never be reached
  // for the US & Canada bucket at all.
  { key: "internshipLocation", label: "Location", section: "Service Agreement Terms", visibleFor: ["INTERN"] },
  { key: "internshipEndDate", label: "Internship End Date", section: "Service Agreement Terms", locked: true, visibleFor: ["INTERN"] },
  // US "Hired from Vendor" / Canada Contractor only — feeds MsaSowAgreementPanel's MSA/SOW
  // generation. Never shown for India or a direct US/Canada employee.
  // locked — hard-required by Generate Offer's own submit validation once Vendor engagement is
  // picked (MsaSowAgreementPanel's MSA/SOW flow gates entirely on offer.vendorName existing).
  { key: "vendorName", label: "Service Provider (Vendor) Name", section: "Vendor Engagement", locked: true, visibleFor: ["US_CANADA"] },
  { key: "vendorEin", label: "Vendor Federal EIN", section: "Vendor Engagement", locked: true, visibleFor: ["US_CANADA"] },
  { key: "endClientName", label: "End Client Name", section: "Vendor Engagement", locked: true, visibleFor: ["US_CANADA"] },
  { key: "vendorAddress", label: "Vendor Address", section: "Vendor Engagement", visibleFor: ["US_CANADA"] },
  { key: "engagementDescription", label: "Engagement / Project Description", section: "Vendor Engagement", visibleFor: ["US_CANADA"] },
  // The artifact's fixed Stage 1 "Supporting Documents" list for US/Canada (Hr.tsx usCanDocTypes)
  // — now configurable here too, like every other field, instead of hardcoded with no config.
  { key: "ssnSinDocument", label: "SSN / SIN Document", section: "US/Canada Supporting Documents", visibleFor: ["US_CANADA"] },
  { key: "workAuthorizationDocument", label: "Work Authorization / Work Permit", section: "US/Canada Supporting Documents", visibleFor: ["US_CANADA"] },
  { key: "driversLicenseDocument", label: "Driver's License / Photo ID", section: "US/Canada Supporting Documents", visibleFor: ["US_CANADA"] },
  { key: "w9VoidChequeDocument", label: "W-9 / Void Cheque", section: "US/Canada Supporting Documents", visibleFor: ["US_CANADA"] },
];
const OFFER_FIELD_SECTIONS = ["Candidate & Position", "Address", "Offer Terms", "List of Joining Documents", "Service Agreement Terms", "Vendor Engagement", "US/Canada Supporting Documents"];

// Same three real forms as server/src/engine/workflow.ts's APPOINTMENT_FIELD_CHECKS/
// IT_PROVISIONING_FIELD_CHECKS/ACTIVATION_FIELD_CHECKS — Appointment Generation
// (AppointmentGeneratePanel), IT Provisioning (ItProvisioningPanel) and Confirm Joining/Employee
// Activation (ConfirmJoiningPanel) — so every real form in the pipeline, not just Generate Offer,
// gets the identical Configure (enable/mandatory) + live Preview treatment.
// Record Candidate Acceptance (client AcceptancePanel) — shared by India's Employee (Offer
// Letter) and Contractor/Intern (Service Agreement/Internship Letter) workflows alike, same
// OFFER_ACCEPTANCE stageType. Previously had NO Workflow & Stage Configuration wiring at all.
const ACCEPTANCE_FIELD_CATALOG: { key: string; label: string; section: string; locked?: boolean }[] = [
  { key: "signedDocument", label: "Signed Offer Letter / Service Agreement", section: "Record Acceptance", locked: true },
  { key: "acceptanceMethod", label: "How did the candidate accept?", section: "Record Acceptance" },
  { key: "acceptanceNote", label: "Notes", section: "Record Acceptance" },
];
const APPOINTMENT_FIELD_CATALOG: { key: string; label: string; section: string; locked?: boolean }[] = [
  // Hard-gates the "Generate Appointment Letter" button regardless of whether Resume was already
  // marked mandatory back at Offer Generation — locked, same real requirement either way.
  { key: "resume", label: "Resume", section: "Appointment Details", locked: true },
  { key: "empNo", label: "Employee ID", section: "Appointment Details" },
  { key: "emergencyContactPhone", label: "Emergency Contact Number", section: "Appointment Details", locked: true },
  { key: "reportingManager", label: "Reporting Manager", section: "Appointment Details" },
  { key: "workLocation", label: "Work Location", section: "Appointment Details" },
  { key: "department", label: "Department", section: "Appointment Details" },
  { key: "employmentType", label: "Employment Type", section: "Appointment Details" },
  { key: "noticePeriod", label: "Notice Period", section: "Appointment Details" },
  { key: "probationPeriod", label: "Probation Period", section: "Appointment Details" },
];
const IT_PROVISIONING_FIELD_CATALOG: { key: string; label: string; section: string; locked?: boolean }[] = [
  { key: "firstName", label: "First Name", section: "IT Provisioning" },
  { key: "lastName", label: "Last Name", section: "IT Provisioning" },
  { key: "candidateName", label: "Candidate Name", section: "IT Provisioning" },
  { key: "jobTitle", label: "Job Title", section: "IT Provisioning" },
  { key: "department", label: "Department", section: "IT Provisioning" },
  { key: "personalEmail", label: "Official Email", section: "IT Provisioning" },
  { key: "reportingManagerContext", label: "Reporting Manager", section: "IT Provisioning" },
  { key: "proposedJoiningDateContext", label: "Proposed Joining Date", section: "IT Provisioning" },
  { key: "shipToAddress", label: "Address (for equipment shipping)", section: "IT Provisioning" },
  { key: "emailIdToCreate", label: "Email ID to Create", section: "IT Provisioning", locked: true },
  { key: "osRequirement", label: "OS Requirement", section: "IT Provisioning", locked: true },
  { key: "laptopConfiguration", label: "Laptop Configuration", section: "IT Provisioning", locked: true },
  { key: "requiredApplications", label: "Requested Applications", section: "IT Provisioning" },
  { key: "requiredAccess", label: "Access Requirements", section: "IT Provisioning" },
  { key: "otherRequirements", label: "Other Hardware/Software Requirements", section: "IT Provisioning" },
  { key: "phoneNumber", label: "Phone Number", section: "IT Provisioning" },
];
// Matches the real ConfirmJoiningPanel form's true visual order (Hr.tsx) — Billable renders LAST,
// after Deployment End, not 3rd; this is only the DEFAULT for a workflow nobody has drag-reordered
// yet (see orderCatalogByConfig above).
const ACTIVATION_FIELD_CATALOG: { key: string; label: string; section: string; locked?: boolean }[] = [
  { key: "actualJoiningDate", label: "Actual Joining / Start Date", section: "Onboarding Activation", locked: true },
  { key: "projectId", label: "Project", section: "Onboarding Activation" },
  { key: "ctcEffectiveFrom", label: "Effective From", section: "Onboarding Activation", locked: true },
  { key: "ctcEffectiveTill", label: "Effective Till", section: "Onboarding Activation" },
  { key: "deploymentStart", label: "Deployment Start", section: "Onboarding Activation", locked: true },
  { key: "deploymentEnd", label: "Deployment End", section: "Onboarding Activation", locked: true },
  { key: "isBillable", label: "Billable", section: "Onboarding Activation" },
];

// stageType -> {catalog, sections} for every stage type with a real configurable form. Looked up by
// both the Configure panel's Form Fields section and the live Preview — one source, so they can
// never drift. OFFER_GENERATION and DATA_COLLECTION intentionally share the same offer-form catalog
// (mirrors the server's dual-stage-type merge in resolveOfferFieldConfig).
const STAGE_FORM_CATALOGS: Record<string, { catalog: OfferField[]; sections: string[] }> = {
  OFFER_GENERATION: { catalog: OFFER_FIELD_CATALOG, sections: OFFER_FIELD_SECTIONS },
  DATA_COLLECTION: { catalog: OFFER_FIELD_CATALOG, sections: OFFER_FIELD_SECTIONS },
  CANDIDATE_INFO: { catalog: OFFER_FIELD_CATALOG, sections: OFFER_FIELD_SECTIONS },
  // US/Canada simplified pipeline's own single merged "Stage 1" — same real Generate Offer form,
  // same catalog, just one stage instead of three. Was missing entirely, so Workflow & Stage
  // Configuration showed "No fields configured" for US & Canada's actual Stage 1.
  CAPTURE_INFORMATION: { catalog: OFFER_FIELD_CATALOG, sections: OFFER_FIELD_SECTIONS },
  OFFER_ACCEPTANCE: { catalog: ACCEPTANCE_FIELD_CATALOG, sections: ["Record Acceptance"] },
  APPOINTMENT_GENERATION: { catalog: APPOINTMENT_FIELD_CATALOG, sections: ["Appointment Details"] },
  IT_PROVISIONING: { catalog: IT_PROVISIONING_FIELD_CATALOG, sections: ["IT Provisioning"] },
  EMPLOYEE_ACTIVATION: { catalog: ACTIVATION_FIELD_CATALOG, sections: ["Onboarding Activation"] },
  // US/Canada's own Confirm Joining/Activation stage type — same real ConfirmJoiningPanel form
  // and catalog as EMPLOYEE_ACTIVATION, just named differently for that pipeline.
  ONBOARDING_ACTIVATION: { catalog: ACTIVATION_FIELD_CATALOG, sections: ["Onboarding Activation"] },
};

// Mirrors server/src/engine/workflow.ts's orderKeysByConfig exactly — HR's drag-to-reorder below
// persists the new sequence by simply re-saving the stage's own `mandatoryFields` array in the
// dragged order (no separate order column; the array's own sequence IS the configured order). A
// catalog field with no explicit position yet (just added in code, or never dragged) is appended
// afterward in the catalog's own default order, so publishing never silently drops/misplaces it.
function orderCatalogByConfig<T extends { key: string }>(catalog: T[], cfg: any[]): T[] {
  const byKey = new Map(catalog.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const f of (Array.isArray(cfg) ? cfg : [])) {
    const item = byKey.get(f.key);
    if (item && !seen.has(f.key)) { ordered.push(item); seen.add(f.key); }
  }
  for (const item of catalog) if (!seen.has(item.key)) { ordered.push(item); seen.add(item.key); }
  return ordered;
}

function StageTypeBadge({ type }: { type: string }) {
  return <span className="pill" style={{ fontSize: 10 }}>{type.replace(/_/g, " ")}</span>;
}

function StageCard({ stage, allStages, draggable, onDragStart, onDragOver, onDrop, onSaved, onDeleted, readOnly, employmentType }: any) {
  // Only this bucket's own real-form fields show — see OfferField's `visibleFor` above.
  const bucketVisible = (f: { visibleFor?: string[] }) => !f.visibleFor || f.visibleFor.includes(employmentType);
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dragFieldKey, setDragFieldKey] = useState<string | null>(null);

  const openConfig = () => { setDraft({ ...stage }); setOpen(true); setPreview(true); setShowAdvanced(Array.isArray(stage.dependsOnKeys) && stage.dependsOnKeys.length > 0); };
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/hr-workflow/${stage.workflowId}/stages/${stage.id}`, draft);
      show("Stage saved"); setOpen(false); onSaved();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm(`Remove "${stage.name}"?`)) return;
    try { await api.del(`/hr-workflow/${stage.workflowId}/stages/${stage.id}`); onDeleted(); } catch (e: any) { show(e.message, "error"); }
  };
  const toggleEnabled = async () => { await api.put(`/hr-workflow/${stage.workflowId}/stages/${stage.id}`, { enabled: !stage.enabled }); onSaved(); };

  const otherStages = allStages.filter((s: any) => s.id !== stage.id);
  const docs: any[] = Array.isArray(draft?.requiredDocuments) ? draft.requiredDocuments : [];
  const fields: any[] = Array.isArray(draft?.mandatoryFields) ? draft.mandatoryFields : [];
  const deps: string[] = Array.isArray(draft?.dependsOnKeys) ? draft.dependsOnKeys : [];

  return (
    <div draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}
      style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginBottom: 10, background: "var(--panel2)", opacity: stage.enabled ? 1 : 0.55, cursor: draggable ? "grab" : "default" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {draggable && <span style={{ color: "var(--muted)", fontSize: 16 }}>⋮⋮</span>}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{stage.order}. {stage.name}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            <StageTypeBadge type={stage.stageType} />
            {stage.candidateFacing !== "HR_ONLY" && <span className="pill" style={{ fontSize: 10 }}>{stage.candidateFacing === "BOTH" ? "HR + Candidate" : "Candidate Facing"}</span>}
            {Array.isArray(stage.mandatoryFields) && stage.mandatoryFields.length > 0 && <span className="subtitle" style={{ margin: 0, fontSize: 11 }}>{stage.mandatoryFields.filter((f: any) => f.mandatory).length} mandatory fields</span>}
            {Array.isArray(stage.requiredDocuments) && stage.requiredDocuments.length > 0 && <span className="subtitle" style={{ margin: 0, fontSize: 11 }}>{stage.requiredDocuments.length} required documents</span>}
            {Array.isArray(stage.dependsOnKeys) && stage.dependsOnKeys.length > 0 && <span className="subtitle" style={{ margin: 0, fontSize: 11 }}>{stage.dependsOnKeys.length} dependencies</span>}
          </div>
        </div>
        {!readOnly && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }} title="Enabled"><input type="checkbox" checked={stage.enabled} onChange={toggleEnabled} /> Enabled</label>
            <GhostButton onClick={openConfig}>Configure</GhostButton>
            <GhostButton onClick={() => setPreview((p) => !p)}>Preview</GhostButton>
            <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={del}>✕</button>
          </div>
        )}
      </div>

      {/* Configuring shows both panels side by side — left to edit, right to see the live result
          update instantly, same split-pane pattern as Helpdesk Settings. Preview-only (readOnly /
          not editing) still shows full width on its own, no Configure panel alongside it. */}
      {(preview || (open && draft)) && (
        // draggable={false} + cursor/userSelect reset — the outer card's draggable=true (for
        // drag-to-reorder) and its "grab" cursor otherwise both bleed into this expanded content
        // in Chromium/WebKit, hijacking normal click-and-drag text selection so Configure/Preview
        // text could never actually be copied.
        <div draggable={false} style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-start", flexWrap: open ? "nowrap" : "wrap", cursor: "auto", userSelect: "text" }}>
      {preview && (() => {
        const src = open && draft ? draft : stage;
        const previewInner = (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{src.name}</div>
            {src.stageType === "DOCUMENT_COLLECTION" ? (
              <div>
                {(src.requiredDocuments || []).length === 0 && <div className="subtitle" style={{ margin: 0 }}>No documents configured for this stage yet.</div>}
                {(src.requiredDocuments || []).map((d: any, i: number) => (
                  <div key={d.docType || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ flex: 1, fontSize: 13 }}>{d.label}{d.required === false ? <span style={{ color: "var(--muted)" }}> (optional)</span> : <span style={{ color: "var(--bad, #e5484d)" }}> *</span>}</div>
                    <button disabled className="ghost">{d.multipleFiles ? "Upload File(s)" : "Upload File"}</button>
                  </div>
                ))}
                <button disabled style={{ marginTop: 10 }}>Submit Documents</button>
              </div>
            ) : STAGE_FORM_CATALOGS[src.stageType] ? (
              <div>
                {(() => {
                  const { catalog, sections: sectionNames } = STAGE_FORM_CATALOGS[src.stageType];
                  const cfg = (src.mandatoryFields || []) as any[];
                  const isVisible = (key: string, locked?: boolean) => {
                    if (locked) return true;
                    const f = cfg.find((x) => x.key === key);
                    return f ? f.enabled !== false : true;
                  };
                  const isMandatory = (key: string, locked?: boolean) => {
                    if (locked) return true;
                    const f = cfg.find((x) => x.key === key);
                    return !!f?.mandatory;
                  };
                  const orderedCatalog = orderCatalogByConfig(catalog, cfg);
                  const sections = sectionNames.map((section) => ({
                    section,
                    fields: orderedCatalog.filter((f) => f.section === section && bucketVisible(f) && isVisible(f.key, f.locked)),
                  })).filter((s) => s.fields.length > 0);
                  if (sections.length === 0) return <div className="subtitle" style={{ margin: 0 }}>No fields configured to show at this stage.</div>;
                  return sections.map(({ section, fields: sf }) => (
                    <div key={section} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, margin: "6px 0 4px" }}>{section}</div>
                      {sf.map(({ key, label, locked }) => (
                        <div key={key} style={{ marginBottom: 8 }}>
                          <label style={{ display: "block", fontSize: 11, marginBottom: 2 }}>{label}{isMandatory(key, locked) && <span style={{ color: "var(--bad, #e5484d)" }}> *</span>}</label>
                          {key === "resume" ? <button disabled className="ghost">Upload Resume</button>
                            : key === "documentChecklist" ? <div style={{ fontSize: 12, color: "var(--muted)" }}>Checklist of required onboarding documents (from HR Settings)</div>
                            : key === "isBillable" ? <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}><input type="checkbox" disabled /> Billable</label>
                            : <input disabled placeholder={label} />}
                        </div>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            ) : (
              <div style={{ fontSize: 13 }}>
                {(src.mandatoryFields || []).filter((f: any) => f.custom && f.enabled !== false).length === 0 && (src.actions || []).filter((a: any) => a.enabled !== false).length === 0 && (
                  <div className="subtitle" style={{ margin: 0 }}>No fields or actions configured for this stage.</div>
                )}
              </div>
            )}
            {/* Custom Fields render the same way on every stage type — HR can add one to any stage
                from Configure below, and it shows up here immediately, live. */}
            {(src.mandatoryFields || []).filter((f: any) => f.custom && f.enabled !== false).length > 0 && (
              <div style={{ marginTop: 10 }}>
                {(src.mandatoryFields || []).filter((f: any) => f.custom && f.enabled !== false).map((f: any) => (
                  <div key={f.key} style={{ marginBottom: 8 }}>
                    <label style={{ display: "block", fontSize: 11, marginBottom: 2 }}>{f.label}{f.mandatory && <span style={{ color: "var(--bad, #e5484d)" }}> *</span>}</label>
                    <input disabled type={f.fieldType === "date" ? "date" : f.fieldType === "number" ? "number" : "text"} placeholder={f.label} />
                  </div>
                ))}
              </div>
            )}
            {(src.actions || []).filter((a: any) => a.enabled !== false).length > 0 && (
              <div style={{ marginTop: 10 }}>
                {(src.actions || []).filter((a: any) => a.enabled !== false).map((a: any) => <button key={a.key} disabled style={{ marginRight: 8, marginBottom: 6 }}>{a.label}</button>)}
              </div>
            )}
          </div>
        );
        // Same browser-chrome treatment as Helpdesk Settings — dominant, real-page preview on the
        // right (order: 2), Configure stays the narrower rail on the left (order: 1, below).
        return (
          <div style={{ order: 2, flex: open ? "1 1 60%" : "1 1 100%", minWidth: 320, position: open ? "sticky" : undefined, top: open ? 8 : undefined }}>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
              🔍 LIVE PREVIEW — the actual form {src.candidateFacing !== "HR_ONLY" ? "the candidate" : "HR"} sees at this stage{open ? " (updates as you edit Configure on the left)" : ""}
            </div>
            <BrowserFrame url={`/hr/offers/:id — Stage ${src.order}: ${src.name}`}>{previewInner}</BrowserFrame>
          </div>
        );
      })()}

      {open && draft && (
        <div style={{ order: 1, flex: "0 0 380px", minWidth: 320, padding: 14, borderRadius: 8, background: "var(--modal-bg)", border: "1px solid var(--border)" }}>
          <div className="form-grid">
            <div className="full"><label>Stage Name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div>
              <label>Candidate Facing</label>
              <select value={draft.candidateFacing} onChange={(e) => setDraft({ ...draft, candidateFacing: e.target.value })}>
                {CANDIDATE_FACING_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label>Completion</label>
              <select value={draft.completionMode} onChange={(e) => setDraft({ ...draft, completionMode: e.target.value })}>
                {COMPLETION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="full" style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} /> Required Stage</label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={draft.allowSkip} onChange={(e) => setDraft({ ...draft, allowSkip: e.target.checked })} /> Allow Skip</label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={draft.allowRevisit} onChange={(e) => setDraft({ ...draft, allowRevisit: e.target.checked })} /> Allow Revisit</label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={draft.hrApprovalRequired} onChange={(e) => setDraft({ ...draft, hrApprovalRequired: e.target.checked })} /> HR Approval Required</label>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <GhostButton onClick={() => setShowAdvanced((p) => !p)}>{showAdvanced ? "Hide Advanced" : "Advanced ▸"}</GhostButton>
          </div>

          {showAdvanced && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>Depends On</div>
              <div className="subtitle" style={{ margin: "0 0 6px" }}>
                Only needed if this stage's order relative to another must be enforced (e.g. Activation must wait for Document Collection). Most stages can leave this empty — order is already fixed elsewhere for the standard pipeline steps.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {otherStages.length === 0 ? <div className="subtitle" style={{ margin: 0 }}>No other stages yet.</div> : otherStages.map((s: any) => (
                  <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
                    <input type="checkbox" checked={deps.includes(s.key)} onChange={() => setDraft({ ...draft, dependsOnKeys: deps.includes(s.key) ? deps.filter((k) => k !== s.key) : [...deps, s.key] })} />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {(() => {
            const customFields = fields.filter((f: any) => f.custom);
            const updateCustomField = (key: string, patch: any) => setDraft({ ...draft, mandatoryFields: fields.map((f: any) => f.key === key ? { ...f, ...patch } : f) });
            const removeCustomField = (key: string) => setDraft({ ...draft, mandatoryFields: fields.filter((f: any) => f.key !== key) });
            const addCustomField = () => setDraft({ ...draft, mandatoryFields: [...fields, { key: `custom_${Date.now().toString(36)}`, label: "New Field", fieldType: "text", custom: true, enabled: true, mandatory: false }] });
            const moveCustomField = async (key: string, targetStageId: number) => {
              const moved = customFields.find((f: any) => f.key === key);
              const target = otherStages.find((s: any) => s.id === targetStageId);
              if (!moved || !target) return;
              setBusy(true);
              try {
                await api.put(`/hr-workflow/${stage.workflowId}/stages/${stage.id}`, { mandatoryFields: fields.filter((f: any) => f.key !== key) });
                const targetFields = Array.isArray(target.mandatoryFields) ? target.mandatoryFields : [];
                await api.put(`/hr-workflow/${stage.workflowId}/stages/${target.id}`, { mandatoryFields: [...targetFields, moved] });
                show(`Moved "${moved.label}" to ${target.name}`); setOpen(false); onSaved();
              } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
            };
            return (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>Custom Fields</div>
                <div className="subtitle" style={{ margin: "0 0 8px" }}>
                  Add any field this stage needs that isn't already listed below — no code change required. Move one to a different stage any time, or remove it.
                </div>
                {customFields.map((f: any) => (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
                    <input style={{ width: 170 }} value={f.label} onChange={(e) => updateCustomField(f.key, { label: e.target.value })} />
                    <select value={f.fieldType || "text"} onChange={(e) => updateCustomField(f.key, { fieldType: e.target.value })}>
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="date">Date</option>
                    </select>
                    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                      <input type="checkbox" checked={f.enabled !== false} onChange={() => updateCustomField(f.key, { enabled: f.enabled === false })} /> Enabled
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: f.enabled !== false ? 1 : 0.4 }}>
                      <input type="checkbox" disabled={f.enabled === false} checked={!!f.mandatory} onChange={() => updateCustomField(f.key, { mandatory: !f.mandatory })} /> Mandatory
                    </label>
                    {otherStages.length > 0 && (
                      <select value="" disabled={busy} onChange={(e) => e.target.value && moveCustomField(f.key, Number(e.target.value))} title="Move to another stage">
                        <option value="">Move to stage…</option>
                        {otherStages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    )}
                    <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => removeCustomField(f.key)} title="Remove">✕</button>
                  </div>
                ))}
                <GhostButton onClick={addCustomField} style={{ marginTop: 8 }}>+ Add Custom Field</GhostButton>
              </div>
            );
          })()}

          {STAGE_FORM_CATALOGS[stage.stageType] && (() => {
            const { catalog, sections: sectionNames } = STAGE_FORM_CATALOGS[stage.stageType];
            const orderedCatalog = orderCatalogByConfig(catalog, fields);
            // Drag within a section only — reorders that section's keys, splices them back into
            // the full catalog sequence (other sections untouched), then persists the WHOLE
            // sequence as draft.mandatoryFields (carrying forward each field's existing
            // enabled/mandatory, or sane defaults for one never configured before). Saved for real
            // only when HR clicks Save, same as every other Configure panel edit.
            const reorderField = (section: string, draggedKey: string, targetKey: string) => {
              if (draggedKey === targetKey) return;
              const sectionKeys = orderedCatalog.filter((f) => f.section === section && bucketVisible(f)).map((f) => f.key);
              const fromIdx = sectionKeys.indexOf(draggedKey), toIdx = sectionKeys.indexOf(targetKey);
              if (fromIdx < 0 || toIdx < 0) return;
              const reordered = [...sectionKeys];
              reordered.splice(fromIdx, 1);
              reordered.splice(toIdx, 0, draggedKey);
              let i = 0;
              const finalKeys = orderedCatalog.map((f) => (sectionKeys.includes(f.key) ? reordered[i++] : f.key));
              const byKey = new Map(fields.map((f) => [f.key, f]));
              const catalogByKey = new Map(catalog.map((f) => [f.key, f]));
              const next = finalKeys.map((k) => byKey.get(k) || { key: k, label: catalogByKey.get(k)?.label, enabled: true, mandatory: false });
              setDraft({ ...draft, mandatoryFields: next });
            };
            return (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>Form Fields</div>
              <div className="subtitle" style={{ margin: "0 0 8px" }}>
                Same fields and sections as the real form for this stage. Enable to show a field on the form at this stage; Mandatory to block progress until it's filled.
                Fields marked <b>Required</b> can't be turned off — they're needed for this step to work at all. Drag <b>⋮⋮</b> to reorder a field within its section —
                the published form will show fields in this same order.
              </div>
              {sectionNames.filter((section) => orderedCatalog.some((f) => f.section === section && bucketVisible(f))).map((section) => (
                <div key={section} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", margin: "8px 0 4px" }}>{section}</div>
                  {orderedCatalog.filter((f) => f.section === section && bucketVisible(f)).map(({ key, label, locked }) => {
                    const existing = fields.find((f) => f.key === key);
                    const enabled = locked ? true : (existing ? existing.enabled !== false : true);
                    const mandatory = locked ? true : !!existing?.mandatory;
                    const setField = (patch: any) => {
                      const next = existing ? fields.map((f) => f.key === key ? { ...f, ...patch } : f) : [...fields, { key, label, enabled: true, mandatory: false, ...patch }];
                      setDraft({ ...draft, mandatoryFields: next });
                    };
                    return (
                      <div key={key} draggable onDragStart={() => setDragFieldKey(key)} onDragOver={(e: any) => e.preventDefault()}
                        onDrop={() => { if (dragFieldKey) reorderField(section, dragFieldKey, key); setDragFieldKey(null); }}
                        style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid var(--border)", cursor: "grab" }}>
                        <span style={{ color: "var(--muted)", fontSize: 13 }} title="Drag to reorder">⋮⋮</span>
                        <div style={{ width: 160 }}>{label}</div>
                        {locked ? (
                          <span className="pill" style={{ fontSize: 10 }}>Required — always on</span>
                        ) : key === "documentChecklist" || key === "address" ? (
                          <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <input type="checkbox" checked={enabled} onChange={() => setField({ enabled: !enabled })} /> Show this section
                          </label>
                        ) : (
                          <>
                            <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <input type="checkbox" checked={enabled} onChange={() => setField({ enabled: !enabled, mandatory: enabled ? false : mandatory })} /> Enabled
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 5, opacity: enabled ? 1 : 0.4 }}>
                              <input type="checkbox" disabled={!enabled} checked={mandatory} onChange={() => setField({ mandatory: !mandatory })} /> Mandatory
                            </label>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            );
          })()}

          {stage.stageType === "DOCUMENT_COLLECTION" && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Required Documents</div>
              {docs.map((d, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <input style={{ flex: 1 }} value={d.label} onChange={(e) => setDraft({ ...draft, requiredDocuments: docs.map((x, xi) => xi === i ? { ...x, label: e.target.value } : x) })} />
                  <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={d.required !== false} onChange={(e) => setDraft({ ...draft, requiredDocuments: docs.map((x, xi) => xi === i ? { ...x, required: e.target.checked } : x) })} /> Required</label>
                  <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={!!d.multipleFiles} onChange={(e) => setDraft({ ...draft, requiredDocuments: docs.map((x, xi) => xi === i ? { ...x, multipleFiles: e.target.checked } : x) })} /> Multiple Files</label>
                  <button className="ghost" onClick={() => setDraft({ ...draft, requiredDocuments: docs.filter((_, xi) => xi !== i) })}>✕</button>
                </div>
              ))}
              <GhostButton onClick={() => setDraft({ ...draft, requiredDocuments: [...docs, { docType: `custom_${Date.now()}`, label: "New Document", required: true, candidateUpload: true, hrVerification: true, allowReupload: true, multipleFiles: false }] })}>+ Add Document</GhostButton>
            </div>
          )}

          {(draft.actions || []).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Available Actions</div>
              {(draft.actions || []).map((a: any, i: number) => (
                <label key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "2px 0" }}>
                  <input type="checkbox" checked={a.enabled !== false} onChange={(e) => setDraft({ ...draft, actions: draft.actions.map((x: any, xi: number) => xi === i ? { ...x, enabled: e.target.checked } : x) })} />
                  {a.label}
                </label>
              ))}
            </div>
          )}

          {draft.candidateFacing !== "HR_ONLY" && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Candidate Communication</div>
              <div className="form-grid">
                <div>
                  <label>Send Mode</label>
                  <select value={draft.notification?.sendMode || "MANUAL"} onChange={(e) => setDraft({ ...draft, notification: { ...draft.notification, sendMode: e.target.value } })}>
                    <option value="MANUAL">Send Manually</option>
                    <option value="AUTO">Send Automatically</option>
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 22 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={draft.notification?.sendEmail !== false} onChange={(e) => setDraft({ ...draft, notification: { ...draft.notification, sendEmail: e.target.checked } })} /> Send Email
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={draft.notification?.useSecureLink !== false} onChange={(e) => setDraft({ ...draft, notification: { ...draft.notification, useSecureLink: e.target.checked } })} /> Secure Link
                  </label>
                </div>
                <div className="full" style={{ fontSize: 11, color: "var(--muted)" }}>Candidate Email: Personal Email (Offer.candidateEmail)</div>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <AddButton disabled={busy} onClick={save}>Save Changes</AddButton>
            <GhostButton disabled={busy} onClick={() => setOpen(false)}>Cancel</GhostButton>
          </div>
        </div>
      )}
        </div>
      )}
    </div>
  );
}

const STAGE_TYPE_LIST = ["CANDIDATE_INFO", "DATA_COLLECTION", "DOCUMENT_COLLECTION", "OFFER_GENERATION", "OFFER_APPROVAL", "OFFER_ACCEPTANCE", "APPOINTMENT_GENERATION", "APPOINTMENT_ACCEPTANCE", "IT_PROVISIONING", "HR_APPROVAL", "MANAGEMENT_APPROVAL", "EMPLOYEE_ACTIVATION", "CUSTOM_STAGE", "CAPTURE_INFORMATION", "AGREEMENT_SIGNATURE", "ONBOARDING_ACTIVATION"];

export function WorkflowBuilder() {
  // Employee and Contractor are fully separate, independently configured/published/versioned
  // templates now (HR request — Contractor's real 5-stage pipeline shouldn't share Employee's
  // 7-stage config surface). Everything below re-fetches/re-posts with this in the query string.
  const [employmentType, setEmploymentType] = useState<"EMPLOYEE" | "CONTRACTOR" | "INTERN" | "US_CANADA">("EMPLOYEE");
  // Which tabs are even selectable is gated by the chosen Business Unit — same
  // isUsCanadaBu convention HrSettings() uses (countryCode US/CANADA hides the India-side
  // tabs and vice versa). "Company Default" (null) shows the India-side tabs, matching this
  // page's original always-India-visible behavior so nothing regresses for existing users.
  const [businessUnitId, setBusinessUnitId] = useState("null");
  const { data: allBusinessUnits } = useFetch<any[]>("/hr-settings/business-units");
  const selectedBu = (allBusinessUnits || []).find((b: any) => String(b.id) === businessUnitId);
  const isUsCanadaBu = !!selectedBu && (selectedBu.countryCode === "US" || selectedBu.countryCode === "CANADA");
  React.useEffect(() => {
    setEmploymentType(isUsCanadaBu ? "US_CANADA" : "EMPLOYEE");
    // eslint-disable-next-line
  }, [isUsCanadaBu]);
  const { data, reload } = useFetch<any>(`/hr-workflow?employmentType=${employmentType}`, [employmentType]);
  const { show } = useToast();
  const [dragId, setDragId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("CUSTOM_STAGE");
  const [validation, setValidation] = useState<any[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  const [appliesTo, setAppliesTo] = useState("NEW_ONLY");
  const [showPerms, setShowPerms] = useState(false);
  const [permsDraft, setPermsDraft] = useState<any>(null);
  const [showFullPreview, setShowFullPreview] = useState(false);

  if (!data) return <Panel>Loading…</Panel>;
  const wf = data.editing;
  const isDraft = wf?.status === "DRAFT";
  const perms = data.myPermissions || { view: true, configure: true, preview: true, publish: true };
  const canConfigure = isDraft && perms.configure;
  const canPublish = isDraft && perms.publish;

  const createDraft = async () => { await api.post("/hr-workflow/draft", { employmentType }); show("Draft created — editing a new version"); reload(); };
  const addStage = async () => {
    if (!newName.trim()) return;
    try { await api.post(`/hr-workflow/${wf.id}/stages`, { name: newName, stageType: newType }); setNewName(""); setShowAdd(false); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const onDrop = async (targetId: number) => {
    if (dragId == null || dragId === targetId) return;
    const ids = wf.stages.map((s: any) => s.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(null);
    await api.put(`/hr-workflow/${wf.id}/reorder`, { stageIds: ids });
    reload();
  };
  const runValidate = async () => { const r = await api.get(`/hr-workflow/${wf.id}/validate`); setValidation(r.results); };
  const publish = async () => {
    const r = await api.get(`/hr-workflow/${wf.id}/validate`);
    if (r.results.some((x: any) => x.level === "error")) { setValidation(r.results); show("Fix validation errors before publishing", "error"); return; }
    if (!window.confirm(`Publish "${wf.name}" v${wf.version}? This becomes the live workflow immediately.`)) return;
    try {
      const r2: any = await api.post(`/hr-workflow/${wf.id}/publish`, { appliesTo });
      show(`Workflow published${r2.migratedOfferCount ? ` — ${r2.migratedOfferCount} in-progress offer(s) moved onto it` : ""}`);
      setValidation(null); reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  const loadHistory = async () => { setHistory(await api.get(`/hr-workflow/history?employmentType=${employmentType}`)); setShowHistory(true); };
  const openPerms = () => { setPermsDraft({ ...data.permissionMatrix }); setShowPerms(true); };
  const savePerms = async () => {
    try { await api.put(`/hr-workflow/${wf.id}/permissions`, { permissions: permsDraft }); show("Permissions saved"); setShowPerms(false); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };

  return (
    <div>
      <h1>Workflow &amp; Stage Configuration</h1>
      <div className="subtitle">Configure the lifecycle — stage order, dependencies, mandatory fields/documents, and candidate communications — without a code change. Publish to make it live.</div>

      <BusinessUnitFilterBar businessUnitId={businessUnitId} setBusinessUnitId={setBusinessUnitId} />

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {(isUsCanadaBu ? (["US_CANADA"] as const) : (["EMPLOYEE", "CONTRACTOR", "INTERN"] as const)).map((t) => (
          <button key={t} className={employmentType === t ? "" : "ghost"} onClick={() => setEmploymentType(t)}
            style={{ fontWeight: employmentType === t ? 700 : 400 }}>
            {t === "EMPLOYEE" ? "Employee" : t === "CONTRACTOR" ? "Contractor" : t === "INTERN" ? "Intern" : "US & Canada"}
          </button>
        ))}
      </div>
      {employmentType === "US_CANADA" && (
        <div className="subtitle" style={{ marginTop: -8, marginBottom: 14 }}>
          Separate, parallel pipeline for US &amp; Canada onboarding (GenAquarius LLC / Aquarius Technologies Limited) — India's Employee/Contractor/Intern workflows above are completely unaffected by anything configured here.
        </div>
      )}

      <Panel title={`Active Workflow — ${employmentType === "EMPLOYEE" ? "Employee" : employmentType === "CONTRACTOR" ? "Contractor" : employmentType === "INTERN" ? "Intern" : "US & Canada"}`} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div><b>{wf?.name}</b> v{wf?.version} — <span className="pill">{wf?.status}</span></div>
          {data.published && <div className="subtitle" style={{ margin: 0 }}>Live: v{data.published.version} · Published {data.published.publishedAt ? fmtDate(data.published.publishedAt) : "—"}</div>}
          <GhostButton onClick={loadHistory}>Version History</GhostButton>
          {perms.publish && <GhostButton onClick={openPerms}>Permissions</GhostButton>}
          {!isDraft && perms.configure && <AddButton onClick={createDraft}>Create New Version</AddButton>}
        </div>
      </Panel>

      {showPerms && permsDraft && (
        <Panel title="Role-Based Configuration" style={{ marginBottom: 14 }}>
          <div className="subtitle" style={{ marginTop: 0 }}>Who can view, configure, preview and publish this workflow.</div>
          <table><thead><tr><th>Role</th><th>View</th><th>Configure</th><th>Preview</th><th>Publish</th></tr></thead>
            <tbody>{["CEO", "CTO", "HR", "FINANCE"].map((role) => {
              const row = permsDraft[role] || { view: role === "CEO" || role === "CTO" || role === "HR", configure: false, preview: true, publish: false };
              return (
                <tr key={role}>
                  <td>{role}</td>
                  {(["view", "configure", "preview", "publish"] as const).map((action) => (
                    <td key={action} style={{ textAlign: "center" }}>
                      <input type="checkbox" checked={!!row[action]} onChange={(e) => setPermsDraft({ ...permsDraft, [role]: { ...row, [action]: e.target.checked } })} />
                    </td>
                  ))}
                </tr>
              );
            })}</tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <AddButton onClick={savePerms}>Save Permissions</AddButton>
            <GhostButton onClick={() => setShowPerms(false)}>Cancel</GhostButton>
          </div>
        </Panel>
      )}

      {showHistory && history && (
        <Panel title="Version History" style={{ marginBottom: 14 }}>
          <table><thead><tr><th>Version</th><th>Status</th><th>Applies To</th><th>Published</th></tr></thead>
            <tbody>{history.map((h: any) => <tr key={h.id}><td>v{h.version}</td><td>{h.status}</td><td>{h.appliesTo}</td><td>{h.publishedAt ? fmtDateTime(h.publishedAt) : "—"}</td></tr>)}</tbody>
          </table>
          <GhostButton style={{ marginTop: 8 }} onClick={() => setShowHistory(false)}>Close</GhostButton>
        </Panel>
      )}

      {validation && (
        <Panel title="Workflow Validation" style={{ marginBottom: 14 }}>
          {validation.map((v, i) => (
            <div key={i} style={{ fontSize: 13, color: v.level === "error" ? "var(--bad, #e5484d)" : v.level === "warn" ? "var(--warn)" : "var(--good)" }}>
              {v.level === "error" ? "✗" : v.level === "warn" ? "⚠" : "✓"} {v.message}
            </div>
          ))}
        </Panel>
      )}

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <GhostButton onClick={() => setShowFullPreview((p) => !p)}>{showFullPreview ? "Hide" : "Preview Workflow"}</GhostButton>
      </div>

      {showFullPreview && (
        <Panel title="Preview Workflow" style={{ marginBottom: 14 }}>
          <div className="subtitle" style={{ marginTop: 0 }}>The complete configured sequence, disabled stages skipped. Click a stage below (in the Workflow Builder panel) to Configure or Preview it individually.</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {(wf?.stages || []).filter((s: any) => s.enabled).map((s: any, i: number, arr: any[]) => (
              <React.Fragment key={s.key}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, background: "var(--panel2)", border: "1px solid var(--border)" }}>
                  <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--accent)", color: "#06101f", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                  <StageTypeBadge type={s.stageType} />
                  {s.candidateFacing !== "HR_ONLY" && <span className="pill" style={{ fontSize: 10 }}>Candidate</span>}
                </div>
                {i < arr.length - 1 && <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: "2px 0" }}>↓</div>}
              </React.Fragment>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Workflow Builder">
        {(wf?.stages || []).map((s: any) => (
          <StageCard key={s.id} stage={{ ...s, workflowId: wf.id }} allStages={wf.stages} readOnly={!canConfigure}
            draggable={canConfigure} onDragStart={() => setDragId(s.id)} onDragOver={(e: any) => e.preventDefault()} onDrop={() => onDrop(s.id)}
            onSaved={reload} onDeleted={reload} employmentType={employmentType} />
        ))}
        {canConfigure && (
          showAdd ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input placeholder="Stage name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
              <select value={newType} onChange={(e) => setNewType(e.target.value)}>{STAGE_TYPE_LIST.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select>
              <AddButton onClick={addStage}>Add</AddButton>
              <GhostButton onClick={() => setShowAdd(false)}>Cancel</GhostButton>
            </div>
          ) : <GhostButton onClick={() => setShowAdd(true)}>+ Add Stage</GhostButton>
        )}
      </Panel>

      {isDraft && (
        <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
          <GhostButton onClick={runValidate}>Validate</GhostButton>
          {canPublish && (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                Apply New Workflow To
                <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                  <option value="NEW_ONLY">New Candidates Only</option>
                  <option value="NEW_AND_IN_PROGRESS">New + In-Progress Candidates</option>
                  <option value="ALL">All Candidates</option>
                </select>
              </label>
              <AddButton onClick={publish}>Publish</AddButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}
