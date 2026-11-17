// Employee Self-Service — self-profile, onboarding-document checklist, holiday calendar,
// leave application (against engine/leave.ts) and attendance marking. "My" endpoints are
// scoped to req.user.employeeId (any authenticated role linked to an Employee record);
// approval/report endpoints are role-gated below.
import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../../prisma";
import { requireRole, HR_SETTINGS_ROLES, ADMIN_ROLES } from "../../auth/auth";
import { ctcAnnualUsd } from "../../engine/calc";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { fillTemplate, getHrSignature } from "../../engine/hr";
import { renderOfferPdf, renderAppointmentPdf } from "../../engine/hrPdf";
import { emitPendingActionsUpdate, emitAttention } from "../../engine/realtime";
import { fmtDate } from "../../engine/dateFormat";
import { resolveProfileFieldsForBu } from "./hrSettings";
import {
  getLeaveBalances, createLeaveRequest, approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  creditCompOff, compOffAvailable, getPolicyConfig,
} from "../../engine/leave";

const router = Router();

// Approvers for leave requests: PM (own reports, but this app has no manager hierarchy beyond
// PM/HR — see report) + the same admin/HR tier already used for timesheet approvals.
const LEAVE_APPROVE_ROLES: Role[] = [Role.PROJECT_MANAGER, Role.HR, Role.CEO, Role.CTO, Role.FINANCE, Role.QA];
// Onboarding-document review: HR + Finance (per the original ask) + CEO/CTO — same tier as HR_SETTINGS_ROLES.
const DOC_APPROVE_ROLES: Role[] = HR_SETTINGS_ROLES;

function requireEmployee(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.employeeId) return res.status(400).json({ error: "No employee record is linked to this user account." });
  next();
}

const money = (n: number, ccy = "INR") => (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹") + Math.round(n || 0).toLocaleString("en-IN");
const firstName = (s: string) => String(s || "").trim().split(/\s+/)[0] || s;
const dstr = fmtDate;

// =====================================================================================
// Pending Actions — the Employee Dashboard's "major badge": anything HR/PM/CTO needs the
// employee to finish. Onboarding docs are always derived live from EmployeeOnboardingDocument
// (never a stale tracked row); timesheet nudges are explicit EmployeeAction rows a PM/CTO
// assigned. Both feed the same daily reminder email job (engine/reminders.ts).
// =====================================================================================
// The specific offer's own "List of Joining Documents" checklist (Generate Offer/SLA, Stage 1) —
// when HR set one, ONLY those document names are actually required for this person, regardless of
// which ones the global OnboardingDocumentType master list marks required=true. null (never
// configured, e.g. an Employee added directly with no Offer) falls back to the master list, same
// as before this existed; an explicit EMPTY array (HR cleared every checkbox — "no documents
// needed for this hire") correctly means zero pending docs, not "fall back to the master list".
async function offerDocumentChecklist(employeeId: number): Promise<string[] | null> {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { offer: { select: { documentChecklist: true } } } });
  const list = employee?.offer?.documentChecklist;
  return Array.isArray(list) ? (list as string[]) : null;
}

router.get("/pending-actions", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const checklist = await offerDocumentChecklist(employeeId);
  const docTypes = await prisma.onboardingDocumentType.findMany({ where: checklist !== null ? { name: { in: checklist } } : { required: true } });
  const existingDocs = await prisma.employeeOnboardingDocument.findMany({ where: { employeeId } });
  const byType = new Map(existingDocs.map((d) => [d.docTypeId, d]));
  const pendingDocs = docTypes.filter((t) => { const d = byType.get(t.id); return !d || d.status === "PENDING" || d.status === "REJECTED"; });
  const timesheetActions = await prisma.employeeAction.findMany({ where: { employeeId, type: "TIMESHEET", status: "OPEN" }, orderBy: { assignedAt: "desc" } });
  // Derived, not a stored EmployeeAction row — HR doesn't necessarily know a candidate's wedding
  // anniversary at hiring time, so unlike Gender/Marital Status/DOB (captured at Offer Generation)
  // this is left for the employee to self-fill once active. Auto-closes the moment they save it.
  const me = await prisma.employee.findUnique({ where: { id: employeeId }, select: { maritalStatus: true, marriageAnniversary: true, photoFileData: true } });
  const needsAnniversary = me?.maritalStatus === "MARRIED" && !me.marriageAnniversary;
  const needsPhoto = !me?.photoFileData;
  const profileSubmission = await prisma.employeeProfileSubmission.findUnique({ where: { employeeId }, select: { status: true } });
  const needsProfile = !profileSubmission || profileSubmission.status === "REJECTED";
  const actions = [
    ...(pendingDocs.length ? [{ type: "ONBOARDING_DOCS", label: `Complete onboarding document checklist (${pendingDocs.length} pending)`, count: pendingDocs.length }] : []),
    ...timesheetActions.map((a) => ({ type: "TIMESHEET", label: `Submit timesheet for ${a.periodMonth}/${a.periodYear}`, periodMonth: a.periodMonth, periodYear: a.periodYear })),
    ...(needsAnniversary ? [{ type: "MARRIAGE_ANNIVERSARY", label: "Add your Marriage Anniversary date to your profile" }] : []),
    ...(needsPhoto ? [{ type: "PHOTO", label: "Upload your profile photo" }] : []),
    ...(needsProfile ? [{ type: "ADDITIONAL_PROFILE", label: profileSubmission?.status === "REJECTED" ? "HR rejected your Additional Details — please review and resubmit" : "Complete your Additional Profile Details" }] : []),
  ];
  res.json({ actions });
});

// =====================================================================================
// My Profile
// =====================================================================================
router.get("/me", requireEmployee, async (req, res) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.user!.employeeId! },
    include: {
      offer: { select: { id: true, offerRef: true, status: true, role: true, designation: true, businessUnit: { select: { name: true } } } },
    },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  // Never expose CTC/salary via self-service — strip it explicitly even though this query never selected it.
  const { ctcRecords, ...safe } = employee as any;
  res.json(safe);
});

router.put("/me", requireEmployee, async (req, res) => {
  const b = req.body;
  const employeeId = req.user!.employeeId!;
  const employee = await prisma.employee.update({
    where: { id: employeeId },
    data: {
      phone: b.phone ?? undefined,
      officialPhone: b.officialPhone ?? undefined,
      emergencyContactName: b.emergencyContactName ?? undefined,
      emergencyContactPhone: b.emergencyContactPhone ?? undefined,
      // Self-fill only — Gender/Marital Status/DOB are HR-set at Offer Generation, not editable
      // here. Marriage Anniversary is the one field intentionally left for the employee themselves
      // (see the MARRIAGE_ANNIVERSARY pending action above).
      marriageAnniversary: b.marriageAnniversary !== undefined ? (b.marriageAnniversary ? new Date(b.marriageAnniversary) : null) : undefined,
    },
  });
  emitPendingActionsUpdate(employeeId);
  res.json(employee);
});

router.get("/me/offer-pdf", requireEmployee, async (req, res) => {
  const offer = await prisma.offer.findFirst({ where: { employeeId: req.user!.employeeId! }, include: { versions: true, businessUnit: true } });
  if (!offer) return res.status(404).json({ error: "No offer on file" });
  const version = offer.versions.find((v) => v.versionNo === offer.activeVersion) || offer.versions[offer.versions.length - 1];
  if (!version) return res.status(404).json({ error: "Offer was never generated" });
  const tpl = version.offerTemplateId ? await prisma.hrOfferTemplate.findUnique({ where: { id: version.offerTemplateId } }) : null;
  const body = fillTemplate(tpl?.bodyText || "Dear {{CandidateFirstName}},\n\nWe are pleased to offer you the position of {{Role}}.", {
    CandidateFirstName: firstName(offer.candidateName), Role: offer.role, Designation: offer.designation,
    OfferRef: offer.offerRef, ProposedJoiningDate: dstr(offer.proposedJoiningDate) || "To be confirmed",
    Business: offer.businessUnit?.name || "", Ctc: money(offer.ctc, offer.countryCode === "US" ? "USD" : offer.countryCode === "CANADA" ? "CAD" : "INR"),
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Offer_${offer.offerRef}.pdf"`);
  renderOfferPdf({ offerRef: offer.offerRef, candidateName: offer.candidateName, role: offer.role, designation: offer.designation, ctc: offer.ctc, offerDate: offer.offerDate, proposedJoiningDate: offer.proposedJoiningDate, businessName: offer.businessUnit?.name, countryCode: offer.countryCode, phone: offer.candidatePhone, templateBody: body, breakup: version.salaryBreakup as any, ...(await getHrSignature(offer.businessUnitId)) }, res);
});

router.get("/me/appointment-pdf", requireEmployee, async (req, res) => {
  const offer = await prisma.offer.findFirst({ where: { employeeId: req.user!.employeeId! }, include: { appointmentLetter: true } });
  const appt = offer?.appointmentLetter;
  if (!appt) return res.status(404).json({ error: "No appointment letter on file" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Appointment_${appt.empNo}.pdf"`);
  renderAppointmentPdf({ empNo: appt.empNo, dynamicFields: appt.dynamicFields as any, clauses: appt.clauses as any, ...(await getHrSignature(offer?.businessUnitId)) }, res);
});

// =====================================================================================
// Onboarding documents
// =====================================================================================
router.get("/onboarding-docs", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const checklist = await offerDocumentChecklist(employeeId);
  const allTypes = await prisma.onboardingDocumentType.findMany({ orderBy: { order: "asc" } });
  // Same checklist scoping as /pending-actions above — only list the document types HR actually
  // selected on this person's own offer, not every type in the global master list.
  const types = checklist !== null ? allTypes.filter((t) => checklist.includes(t.name)) : allTypes;
  const existing = await prisma.employeeOnboardingDocument.findMany({ where: { employeeId }, include: { docType: true } });
  const byType = new Map(existing.map((d) => [d.docTypeId, d]));
  res.json(types.map((t) => byType.get(t.id) || { id: null, employeeId, docTypeId: t.id, docType: t, fileName: null, status: "PENDING" }));
});

router.post("/onboarding-docs/:docTypeId", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const docTypeId = Number(req.params.docTypeId);
  const { fileName, fileData } = req.body;
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const doc = await prisma.employeeOnboardingDocument.upsert({
    where: { employeeId_docTypeId: { employeeId, docTypeId } },
    update: { fileName, fileData, status: "SUBMITTED", submittedAt: new Date(), reviewedById: null, reviewedAt: null, note: null },
    create: { employeeId, docTypeId, fileName, fileData, status: "SUBMITTED", submittedAt: new Date() },
  });
  emitPendingActionsUpdate(employeeId);
  res.status(201).json(doc);
});

// HR-side upload — HR attaching a document on an employee's behalf (e.g. a scanned copy of an
// offer/appointment/service agreement for someone imported before the HR module existed, or any
// other checklist item HR already has on file). Unlike the employee's own self-submit above,
// this goes straight to APPROVED — HR is the one attaching it, there's no separate review step.
router.post("/onboarding-docs/employee/:employeeId/:docTypeId", requireRole(...DOC_APPROVE_ROLES), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const docTypeId = Number(req.params.docTypeId);
  const { fileName, fileData } = req.body;
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const doc = await prisma.employeeOnboardingDocument.upsert({
    where: { employeeId_docTypeId: { employeeId, docTypeId } },
    update: { fileName, fileData, status: "APPROVED", submittedAt: new Date(), reviewedById: req.user!.id, reviewedAt: new Date(), note: null },
    create: { employeeId, docTypeId, fileName, fileData, status: "APPROVED", submittedAt: new Date(), reviewedById: req.user!.id, reviewedAt: new Date() },
  });
  emitPendingActionsUpdate(employeeId);
  res.status(201).json(doc);
});

// Serve a stored document's raw bytes for inline preview/download — either the employee viewing
// their own file, or HR/Finance viewing anyone's (same tier that can review/approve them).
router.get("/onboarding-docs/:id/file", async (req, res) => {
  const doc = await prisma.employeeOnboardingDocument.findUnique({ where: { id: Number(req.params.id) } });
  if (!doc || !doc.fileData) return res.status(404).json({ error: "Document not found" });
  const isOwner = req.user?.employeeId === doc.employeeId;
  const isApprover = DOC_APPROVE_ROLES.includes(req.user!.role);
  if (!isOwner && !isApprover) return res.status(403).json({ error: "Forbidden" });
  const ext = (doc.fileName || "").split(".").pop()?.toLowerCase();
  const contentType = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename="${doc.fileName}"`);
  res.send(Buffer.from(doc.fileData, "base64"));
});

// =====================================================================================
// Profile photo — self-upload pending action (see /pending-actions above); the same photo IT
// uses once the O365 email-creation action is built.
// =====================================================================================
router.post("/photo", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  await prisma.employee.update({ where: { id: employeeId }, data: { photoFileName: fileName, photoFileData: fileData, photoUploadedAt: new Date() } });
  emitPendingActionsUpdate(employeeId);
  res.json({ ok: true });
});
router.get("/photo/:employeeId", async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { photoFileName: true, photoFileData: true, confidential: true, exitDate: true } });
  if (!emp?.photoFileData) return res.status(404).json({ error: "No photo on file" });
  const isOwner = req.user?.employeeId === employeeId;
  const isApprover = DOC_APPROVE_ROLES.includes(req.user!.role);
  // Any signed-in colleague may see an active, non-confidential employee's photo — it's shown on
  // the Org Chart / Directory, same visibility as the name + designation next to it.
  const isDirectoryVisible = !emp.confidential && !emp.exitDate;
  if (!isOwner && !isApprover && !isDirectoryVisible) return res.status(403).json({ error: "Forbidden" });
  const ext = (emp.photoFileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "png" ? "image/png" : "image/jpeg");
  res.setHeader("Content-Disposition", `inline; filename="${emp.photoFileName}"`);
  res.send(Buffer.from(emp.photoFileData, "base64"));
});

// =====================================================================================
// Additional Profile Details — HR-configurable field catalog (EmployeeProfileFieldConfig,
// managed from HR Settings) + three fixed repeating-list sections (Education/Family/Nomination).
// One submission per employee (enforced by the DB's own @@unique on employeeId — an upsert can
// never create a second row), resubmittable in place until HR approves it.
// =====================================================================================
router.get("/profile-fields", requireEmployee, async (req, res) => {
  const emp = await prisma.employee.findUnique({ where: { id: req.user!.employeeId! }, select: { businessUnitId: true } });
  const rows = await resolveProfileFieldsForBu(emp?.businessUnitId ?? null);
  res.json(rows.filter((r) => r.enabled));
});
router.get("/profile-submission", requireEmployee, async (req, res) => {
  const row = await prisma.employeeProfileSubmission.findUnique({ where: { employeeId: req.user!.employeeId! } });
  res.json(row);
});
router.put("/profile-submission", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const b = req.body || {};
  const row = await prisma.employeeProfileSubmission.upsert({
    where: { employeeId },
    update: { values: b.values || {}, education: b.education || [], family: b.family || [], nomination: b.nomination || [], status: "PENDING", submittedAt: new Date(), reviewedById: null, reviewedAt: null, reviewNote: null },
    create: { employeeId, values: b.values || {}, education: b.education || [], family: b.family || [], nomination: b.nomination || [] },
  });
  emitPendingActionsUpdate(employeeId);
  emitAttention(["HR", "FINANCE", "CTO", "CEO", "COO"], "profile_submission_pending", { employeeId });
  res.json(row);
});

// HR review queue — mirrors the onboarding-document review pattern exactly.
router.get("/profile-submissions", requireRole(...DOC_APPROVE_ROLES), async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const rows = await prisma.employeeProfileSubmission.findMany({
    where: status ? { status } : undefined,
    include: { employee: { select: { id: true, name: true, empNo: true, businessUnitId: true } } },
    orderBy: { submittedAt: "desc" },
  });
  res.json(rows);
});
router.post("/profile-submissions/:employeeId/review", requireRole(...DOC_APPROVE_ROLES), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const { status, note } = req.body || {};
  if (!["APPROVED", "REJECTED"].includes(status)) return res.status(400).json({ error: "status must be APPROVED or REJECTED" });
  const row = await prisma.employeeProfileSubmission.update({
    where: { employeeId },
    data: { status, reviewNote: note || null, reviewedById: req.user!.id, reviewedAt: new Date() },
  });
  emitPendingActionsUpdate(employeeId);
  res.json(row);
});

// HR/Finance: full checklist across all employees + per-employee review.
router.get("/onboarding-docs/all", requireRole(...DOC_APPROVE_ROLES), async (_req, res) => {
  const docs = await prisma.employeeOnboardingDocument.findMany({
    where: { status: { in: ["SUBMITTED", "APPROVED", "REJECTED"] } },
    include: { docType: true, employee: { select: { id: true, name: true, empNo: true } } },
    orderBy: { submittedAt: "desc" },
  });
  res.json(docs);
});
router.get("/onboarding-docs/employee/:employeeId", requireRole(...DOC_APPROVE_ROLES), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const types = await prisma.onboardingDocumentType.findMany({ orderBy: { order: "asc" } });
  const existing = await prisma.employeeOnboardingDocument.findMany({ where: { employeeId }, include: { docType: true } });
  const byType = new Map(existing.map((d) => [d.docTypeId, d]));
  res.json(types.map((t) => byType.get(t.id) || { id: null, employeeId, docTypeId: t.id, docType: t, fileName: null, status: "PENDING" }));
});
router.put("/onboarding-docs/:id/review", requireRole(...DOC_APPROVE_ROLES), async (req, res) => {
  const { status, note } = req.body;
  if (!["APPROVED", "REJECTED"].includes(status)) return res.status(400).json({ error: "status must be APPROVED or REJECTED" });
  const doc = await prisma.employeeOnboardingDocument.update({
    where: { id: Number(req.params.id) },
    data: { status, note: note || null, reviewedById: req.user!.id, reviewedAt: new Date() },
  });
  emitPendingActionsUpdate(doc.employeeId);
  res.json(doc);
});

// =====================================================================================
// Holiday calendar (read-only, any authenticated user)
// =====================================================================================
router.get("/holidays", async (req, res) => {
  let country = req.query.country ? String(req.query.country).toUpperCase() : null;
  if (!country && req.user?.employeeId) {
    const emp = await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { location: true } });
    country = emp?.location?.toUpperCase() || "INDIA";
  }
  res.json(await prisma.holiday.findMany({ where: country ? { country } : undefined, orderBy: { date: "asc" } }));
});

// =====================================================================================
// Leave
// =====================================================================================
router.get("/leave-types", async (req, res) => {
  let countryCode = req.query.countryCode ? String(req.query.countryCode).toUpperCase() : null;
  if (!countryCode && req.user?.employeeId) {
    const emp = await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { location: true } });
    countryCode = emp?.location?.toUpperCase() || "INDIA";
  }
  res.json(await prisma.hrLeaveType.findMany({ where: { countryCode: countryCode || "INDIA" }, orderBy: { order: "asc" } }));
});

router.get("/leave-balances", requireEmployee, async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json(await getLeaveBalances(req.user!.employeeId!, year));
});

router.get("/leave-requests", requireEmployee, async (req, res) => {
  const requests = await prisma.leaveRequest.findMany({
    where: { employeeId: req.user!.employeeId! },
    include: { leaveType: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(requests);
});

router.post("/leave-requests", requireEmployee, async (req, res) => {
  const { leaveTypeId, fromDate, toDate, reason } = req.body;
  if (!leaveTypeId || !fromDate || !toDate) return res.status(400).json({ error: "leaveTypeId, fromDate and toDate are required" });
  try {
    const { request, warnings } = await createLeaveRequest(req.user!.employeeId!, Number(leaveTypeId), new Date(fromDate), new Date(toDate), reason);
    res.status(201).json({ ...request, warnings });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/leave-requests/:id/cancel", requireEmployee, async (req, res) => {
  try { res.json(await cancelLeaveRequest(Number(req.params.id), req.user!.employeeId!)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Approvers — no manager hierarchy exists in this app yet (see report), so every approver
// role sees every PENDING request company-wide, same scope as Timesheet Approvals.
router.get("/leave-requests/pending", requireRole(...LEAVE_APPROVE_ROLES), async (_req, res) => {
  res.json(await prisma.leaveRequest.findMany({
    where: { status: "PENDING" },
    include: { leaveType: true, employee: { select: { id: true, name: true, empNo: true } } },
    orderBy: { createdAt: "asc" },
  }));
});
router.post("/leave-requests/:id/approve", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  try { res.json(await approveLeaveRequest(Number(req.params.id), req.user!.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
router.post("/leave-requests/:id/reject", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  try { res.json(await rejectLeaveRequest(Number(req.params.id), req.user!.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ---- Comp-Off ----
router.get("/comp-off", requireEmployee, async (req, res) => {
  res.json(await compOffAvailable(req.user!.employeeId!));
});
// Comp-off is granted by HR/admin only (masters.ts's /employees lookup used by the credit
// form's employee picker is itself HR_SETTINGS_ROLES-gated — PROJECT_MANAGER can't see it).
router.post("/comp-off/credit", requireRole(...DOC_APPROVE_ROLES), async (req, res) => {
  const { employeeId, days, note } = req.body;
  if (!employeeId || !days) return res.status(400).json({ error: "employeeId and days are required" });
  try { res.status(201).json(await creditCompOff(Number(employeeId), Number(days), req.user!.id, note)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/policy-config", async (req, res) => {
  res.json(await getPolicyConfig(String(req.query.countryCode || "INDIA")));
});

// =====================================================================================
// Attendance
// =====================================================================================
router.get("/attendance", requireEmployee, async (req, res) => {
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const year = Number(req.query.year) || new Date().getFullYear();
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  res.json(await prisma.attendanceRecord.findMany({ where: { employeeId: req.user!.employeeId!, date: { gte: from, lte: to } }, orderBy: { date: "asc" } }));
});

router.post("/attendance", requireEmployee, async (req, res) => {
  const { date, status } = req.body;
  const allowed = ["PRESENT", "WFH"]; // LEAVE/HOLIDAY are inferred (from LeaveRequest / Holiday), not self-marked
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
  // Normalized to UTC midnight (a calendar date, not a local instant) — matches how Holiday
  // and LeaveRequest dates are stored, so the report's day-key lookups line up correctly
  // regardless of the server's local timezone.
  const src = date ? new Date(date) : new Date();
  const d = new Date(Date.UTC(src.getFullYear(), src.getMonth(), src.getDate()));
  const record = await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: req.user!.employeeId!, date: d } },
    update: { status, markedAt: new Date() },
    create: { employeeId: req.user!.employeeId!, date: d, status },
  });
  res.status(201).json(record);
});

// ---- Check-In / Check-Out ----
// Additive to the existing daily status marker above: these only ever touch
// checkInTime/checkOutTime on the same AttendanceRecord row, never `status`, so the
// original "Mark Present/WFH" flow (and the HR attendance report) keeps working unchanged.
function utcMidnight(d: Date) { return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); }

router.get("/attendance/today", requireEmployee, async (req, res) => {
  const today = utcMidnight(new Date());
  const record = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: req.user!.employeeId!, date: today } } });
  res.json(record || null);
});

router.post("/attendance/check-in", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const today = utcMidnight(new Date());
  const existing = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date: today } } });
  if (existing?.checkInTime) return res.status(400).json({ error: "You have already checked in today." });
  const record = existing
    ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { checkInTime: new Date() } })
    : await prisma.attendanceRecord.create({ data: { employeeId, date: today, checkInTime: new Date() } });
  res.status(201).json(record);
});

router.post("/attendance/check-out", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const today = utcMidnight(new Date());
  const existing = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date: today } } });
  if (!existing?.checkInTime) return res.status(400).json({ error: "You haven't checked in yet today." });
  if (existing.checkOutTime) return res.status(400).json({ error: "You have already checked out today." });
  const record = await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { checkOutTime: new Date() } });
  res.status(201).json(record);
});

// Attendance summary for the employee's own month (graphical use — dashboard chart): counts
// of present/WFH days actually marked, days on approved leave, holidays, and (for past
// weekdays only) days with nothing marked/inferred at all ("unmarked").
router.get("/attendance/summary", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const year = Number(req.query.year) || new Date().getFullYear();
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { location: true } });
  const country = (employee?.location || "INDIA").toUpperCase();

  const [records, leaves, holidays] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { employeeId, date: { gte: from, lte: to } } }),
    prisma.leaveRequest.findMany({ where: { employeeId, status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } } }),
    prisma.holiday.findMany({ where: { country, date: { gte: from, lte: to } } }),
  ]);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const holidaySet = new Set(holidays.map((h) => dayKey(new Date(h.date))));
  const recordByDay = new Map(records.map((r) => [dayKey(new Date(r.date)), r]));
  const onLeave = (date: Date) => leaves.some((l) => date >= new Date(l.fromDate) && date <= new Date(l.toDate));

  let present = 0, wfh = 0, leave = 0, holiday = 0, unmarked = 0;
  const today = utcMidnight(new Date());
  const daysInMonth = to.getUTCDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(Date.UTC(year, month - 1, d));
    if (date > today) continue; // don't count future days as unmarked
    const key = dayKey(date);
    const rec = recordByDay.get(key);
    if (rec) { if (rec.status === "WFH") wfh++; else present++; continue; }
    if (holidaySet.has(key)) { holiday++; continue; }
    if (onLeave(date)) { leave++; continue; }
    const isWeekday = date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
    if (isWeekday) unmarked++;
  }
  res.json({ present, wfh, leave, holiday, unmarked });
});

// ---- Attendance Regularization ----
router.get("/attendance/regularization", requireEmployee, async (req, res) => {
  res.json(await prisma.attendanceRegularizationRequest.findMany({ where: { employeeId: req.user!.employeeId! }, orderBy: { createdAt: "desc" } }));
});

router.post("/attendance/regularization", requireEmployee, async (req, res) => {
  const { date, requestedCheckIn, requestedCheckOut, reason } = req.body;
  if (!date || !reason) return res.status(400).json({ error: "date and reason are required" });
  if (!requestedCheckIn && !requestedCheckOut) return res.status(400).json({ error: "Provide a requested check-in and/or check-out time" });
  const src = new Date(date);
  const record = await prisma.attendanceRegularizationRequest.create({
    data: {
      employeeId: req.user!.employeeId!,
      date: utcMidnight(src),
      requestedCheckIn: requestedCheckIn ? new Date(requestedCheckIn) : null,
      requestedCheckOut: requestedCheckOut ? new Date(requestedCheckOut) : null,
      reason,
    },
  });
  res.status(201).json(record);
});

router.post("/attendance/regularization/:id/cancel", requireEmployee, async (req, res) => {
  const request = await prisma.attendanceRegularizationRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request || request.employeeId !== req.user!.employeeId!) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: "Only a pending request can be cancelled" });
  res.json(await prisma.attendanceRegularizationRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } }));
});

router.get("/attendance/regularization/pending", requireRole(...LEAVE_APPROVE_ROLES), async (_req, res) => {
  res.json(await prisma.attendanceRegularizationRequest.findMany({
    where: { status: "PENDING" },
    include: { employee: { select: { id: true, name: true, empNo: true } } },
    orderBy: { createdAt: "asc" },
  }));
});

router.post("/attendance/regularization/:id/approve", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  const request = await prisma.attendanceRegularizationRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: `Request is already ${request.status}` });
  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: request.employeeId, date: request.date } },
    update: {
      ...(request.requestedCheckIn ? { checkInTime: request.requestedCheckIn } : {}),
      ...(request.requestedCheckOut ? { checkOutTime: request.requestedCheckOut } : {}),
    },
    create: {
      employeeId: request.employeeId, date: request.date,
      checkInTime: request.requestedCheckIn, checkOutTime: request.requestedCheckOut,
    },
  });
  res.json(await prisma.attendanceRegularizationRequest.update({ where: { id: request.id }, data: { status: "APPROVED", reviewedById: req.user!.id, reviewedAt: new Date() } }));
});

router.post("/attendance/regularization/:id/reject", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  const request = await prisma.attendanceRegularizationRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: `Request is already ${request.status}` });
  res.json(await prisma.attendanceRegularizationRequest.update({ where: { id: request.id }, data: { status: "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date() } }));
});

// ---- Permission Requests (short-duration, e.g. "leaving 2 hours early") ----
router.get("/permission-requests", requireEmployee, async (req, res) => {
  res.json(await prisma.permissionRequest.findMany({ where: { employeeId: req.user!.employeeId! }, orderBy: { createdAt: "desc" } }));
});

router.post("/permission-requests", requireEmployee, async (req, res) => {
  const { date, fromTime, toTime, reason } = req.body;
  if (!date || !fromTime || !toTime || !reason) return res.status(400).json({ error: "date, fromTime, toTime and reason are required" });
  const record = await prisma.permissionRequest.create({
    data: { employeeId: req.user!.employeeId!, date: utcMidnight(new Date(date)), fromTime, toTime, reason },
  });
  res.status(201).json(record);
});

router.post("/permission-requests/:id/cancel", requireEmployee, async (req, res) => {
  const request = await prisma.permissionRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request || request.employeeId !== req.user!.employeeId!) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: "Only a pending request can be cancelled" });
  res.json(await prisma.permissionRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } }));
});

router.get("/permission-requests/pending", requireRole(...LEAVE_APPROVE_ROLES), async (_req, res) => {
  res.json(await prisma.permissionRequest.findMany({
    where: { status: "PENDING" },
    include: { employee: { select: { id: true, name: true, empNo: true } } },
    orderBy: { createdAt: "asc" },
  }));
});

router.post("/permission-requests/:id/approve", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  const request = await prisma.permissionRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: `Request is already ${request.status}` });
  res.json(await prisma.permissionRequest.update({ where: { id: request.id }, data: { status: "APPROVED", reviewedById: req.user!.id, reviewedAt: new Date() } }));
});

router.post("/permission-requests/:id/reject", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  const request = await prisma.permissionRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: `Request is already ${request.status}` });
  res.json(await prisma.permissionRequest.update({ where: { id: request.id }, data: { status: "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date() } }));
});

// HR/manager report: a month's attendance for every active employee, combining explicit
// check-ins with inferred LEAVE (approved LeaveRequest overlapping the day) and HOLIDAY
// (Holiday table) — days with nothing marked and no inference are left blank (not assumed absent).
router.get("/attendance/report", requireRole(...LEAVE_APPROVE_ROLES), async (req, res) => {
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const year = Number(req.query.year) || new Date().getFullYear();
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const [employees, records, leaves, holidays] = await Promise.all([
    prisma.employee.findMany({ where: { exitDate: null }, select: { id: true, name: true, empNo: true, location: true }, orderBy: { name: "asc" } }),
    prisma.attendanceRecord.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.leaveRequest.findMany({ where: { status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } } }),
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to } } }),
  ]);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const holidaysByCountry = new Map<string, Set<string>>();
  for (const h of holidays) {
    const set = holidaysByCountry.get(h.country) || new Set<string>();
    set.add(dayKey(new Date(h.date)));
    holidaysByCountry.set(h.country, set);
  }
  const recordsByEmp = new Map<number, Map<string, string>>();
  for (const r of records) {
    const m = recordsByEmp.get(r.employeeId) || new Map<string, string>();
    m.set(dayKey(new Date(r.date)), r.status);
    recordsByEmp.set(r.employeeId, m);
  }
  const leavesByEmp = new Map<number, { from: Date; to: Date }[]>();
  for (const l of leaves) {
    const arr = leavesByEmp.get(l.employeeId) || [];
    arr.push({ from: new Date(l.fromDate), to: new Date(l.toDate) });
    leavesByEmp.set(l.employeeId, arr);
  }

  const daysInMonth = to.getUTCDate();
  const report = employees.map((e) => {
    const holidaySet = holidaysByCountry.get((e.location || "INDIA").toUpperCase()) || new Set<string>();
    const empRecords = recordsByEmp.get(e.id) || new Map<string, string>();
    const empLeaves = leavesByEmp.get(e.id) || [];
    const days: Record<string, string> = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(Date.UTC(year, month - 1, d));
      const key = dayKey(date);
      if (empRecords.has(key)) { days[key] = empRecords.get(key)!; continue; }
      if (holidaySet.has(key)) { days[key] = "HOLIDAY"; continue; }
      const onLeave = empLeaves.some((l) => date >= l.from && date <= l.to);
      if (onLeave) { days[key] = "LEAVE"; continue; }
    }
    return { employeeId: e.id, name: e.name, empNo: e.empNo, days };
  });
  res.json(report);
});

// =====================================================================================
// Regularization & Permission — batch "Apply" screen. One submission can carry several dates,
// each with several rows; every row becomes either an AttendanceRegularizationRequest
// (MISSED_PUNCH — approving it writes check-in/out onto AttendanceRecord, as before) or a
// PermissionRequest (short-duration types). Both keep their existing approve/reject/cancel
// endpoints above, so Leave Approvals keeps working unchanged.
// =====================================================================================
export const PERMISSION_TYPES = [
  { key: "MISSED_PUNCH", label: "Missed Check-In / Check-Out (Regularization)", kind: "REGULARIZATION" },
  { key: "LATE_COMING", label: "Late Coming", kind: "PERMISSION" },
  { key: "EARLY_GOING", label: "Early Going", kind: "PERMISSION" },
  { key: "PERSONAL_WORK", label: "Personal Work (Short Leave)", kind: "PERMISSION" },
  { key: "OFFICIAL_DUTY", label: "On Duty / Official Work", kind: "PERMISSION" },
  { key: "CLIENT_VISIT", label: "Client Visit", kind: "PERMISSION" },
] as const;
const TYPE_BY_KEY = new Map<string, (typeof PERMISSION_TYPES)[number]>(PERMISSION_TYPES.map((t) => [t.key, t]));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

router.get("/regularization-permission/types", (_req, res) => res.json(PERMISSION_TYPES));

router.post("/regularization-permission/apply", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const b = req.body || {};
  const entries: any[] = Array.isArray(b.entries) ? b.entries : [];
  const remarks: string | null = String(b.remarks || "").trim() || null;
  const cc: string[] = (Array.isArray(b.cc) ? b.cc : []).map((e: any) => String(e || "").trim().toLowerCase()).filter((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const ccEmails = cc.length ? Array.from(new Set(cc)).join(",") : null;
  if (!entries.length) return res.status(400).json({ error: "Add at least one date with a request row." });
  if (entries.length > 62) return res.status(400).json({ error: "Too many rows in one submission (max 62)." });

  const today = utcMidnight(new Date());
  const errors: string[] = [];
  entries.forEach((e, i) => {
    const n = `Row ${i + 1} (${e?.date || "no date"})`;
    const t = TYPE_BY_KEY.get(e?.type);
    if (!e?.date || isNaN(new Date(e.date).getTime())) errors.push(`${n}: date is required`);
    if (!t) errors.push(`${n}: select a Permission Type`);
    if (!String(e?.reason || "").trim()) errors.push(`${n}: reason is required`);
    if (e?.fromTime && !HHMM.test(e.fromTime)) errors.push(`${n}: From time must be HH:MM`);
    if (e?.toTime && !HHMM.test(e.toTime)) errors.push(`${n}: To time must be HH:MM`);
    if (t?.kind === "REGULARIZATION") {
      if (!e.fromTime && !e.toTime) errors.push(`${n}: provide the check-in and/or check-out time`);
      // +1 day grace: the server clock is UTC while employees are mostly IST (ahead of UTC).
      if (e.date && new Date(String(e.date).slice(0, 10)).getTime() > today.getTime() + 86400000) errors.push(`${n}: attendance can't be regularized for a future date`);
    } else if (t) {
      if (!e.fromTime || !e.toTime) errors.push(`${n}: From and To time are required`);
      else if (e.fromTime >= e.toTime) errors.push(`${n}: To time must be after From time`);
    }
    if (e?.fromTime && e?.toTime && t?.kind === "REGULARIZATION" && e.fromTime >= e.toTime) errors.push(`${n}: check-out must be after check-in`);
  });
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  // Client sends the date as YYYY-MM-DD plus local HH:MM and the browser's own ISO instants for
  // regularization times (fromIso/toIso) so the stored check-in/out is the real local moment.
  const created = await prisma.$transaction(entries.map((e) => {
    const t = TYPE_BY_KEY.get(e.type)!;
    const [y, m, d] = String(e.date).slice(0, 10).split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const reason = String(e.reason).trim();
    if (t.kind === "REGULARIZATION") {
      return prisma.attendanceRegularizationRequest.create({
        data: {
          employeeId, date, reason, remarks, ccEmails,
          requestedCheckIn: e.fromTime ? new Date(e.fromIso || `${String(e.date).slice(0, 10)}T${e.fromTime}:00`) : null,
          requestedCheckOut: e.toTime ? new Date(e.toIso || `${String(e.date).slice(0, 10)}T${e.toTime}:00`) : null,
        },
      }) as any;
    }
    return prisma.permissionRequest.create({ data: { employeeId, date, fromTime: e.fromTime, toTime: e.toTime, permissionType: t.key, reason, remarks, ccEmails } }) as any;
  }));

  // Best-effort CC notification — never fails the request itself.
  if (cc.length && mailEnabled() && req.user?.email) {
    const me = await prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true, empNo: true } });
    const rows = entries.map((e) => `<tr><td>${dstr(e.date)}</td><td>${TYPE_BY_KEY.get(e.type)!.label}</td><td>${e.fromTime || "—"} – ${e.toTime || "—"}</td><td>${String(e.reason).replace(/</g, "&lt;")}</td></tr>`).join("");
    const html = `<p>${me?.name || "An employee"}${me?.empNo ? ` (${me.empNo})` : ""} has raised a Regularization / Permission request and copied you.</p>`
      + `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Segoe UI,Arial;font-size:13px"><tr><th>Date</th><th>Type</th><th>Time</th><th>Reason</th></tr>${rows}</table>`
      + (remarks ? `<p><b>Remarks:</b> ${remarks.replace(/</g, "&lt;")}</p>` : "");
    for (const to of Array.from(new Set(cc))) {
      notifyMail("ESS_REGULARIZATION_CC", { fromUpn: req.user.email, to, subject: `Regularization / Permission request — ${me?.name || ""}`, html }).catch((err) => console.warn("[ess] CC mail failed:", err?.message || err));
    }
  }
  res.status(201).json({ created: created.length });
});

// The employee's own requests of both kinds, normalized into one list for the Pending/History tabs.
router.get("/regularization-permission/requests", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const [regs, perms] = await Promise.all([
    prisma.attendanceRegularizationRequest.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } }),
    prisma.permissionRequest.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } }),
  ]);
  const rows = [
    ...regs.map((r) => ({ kind: "REGULARIZATION", id: r.id, date: r.date, type: "MISSED_PUNCH", typeLabel: TYPE_BY_KEY.get("MISSED_PUNCH")!.label, fromIso: r.requestedCheckIn, toIso: r.requestedCheckOut, fromTime: null, toTime: null, reason: r.reason, remarks: r.remarks, ccEmails: r.ccEmails, status: r.status, createdAt: r.createdAt, reviewedAt: r.reviewedAt })),
    ...perms.map((p) => ({ kind: "PERMISSION", id: p.id, date: p.date, type: p.permissionType || "PERMISSION", typeLabel: TYPE_BY_KEY.get(p.permissionType || "")?.label || "Permission", fromIso: null, toIso: null, fromTime: p.fromTime, toTime: p.toTime, reason: p.reason, remarks: p.remarks, ccEmails: p.ccEmails, status: p.status, createdAt: p.createdAt, reviewedAt: p.reviewedAt })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  res.json(rows);
});

// Lightweight colleague list for the "Add CC" picker — active, non-confidential, with an email.
router.get("/colleagues", async (_req, res) => {
  res.json(await prisma.employee.findMany({
    where: { exitDate: null, confidential: false, email: { not: null } },
    select: { id: true, name: true, empNo: true, email: true, designation: true },
    orderBy: { name: "asc" },
  }));
});

// =====================================================================================
// Org Chart / Directory — every active employee with their resolved manager. The hierarchy
// comes from Employee.reportingManager, which is stored as the manager's NAME (the Reporting-To
// dropdowns in Generate Offer / Employee Master save e.name), so it's resolved by
// case-insensitive name match here. Cycles (A→B→A) are broken so the tree always renders.
// Confidential employees are hidden from non-admin viewers, same rule as every HR list.
// =====================================================================================
router.get("/org-chart", async (req, res) => {
  const isAdmin = ADMIN_ROLES.includes(req.user!.role);
  const emps = await prisma.employee.findMany({
    where: { exitDate: null, ...(isAdmin ? {} : { confidential: false }) },
    select: { id: true, name: true, empNo: true, email: true, designation: true, department: true, location: true, reportingManager: true, joiningDate: true, photoFileName: true },
    orderBy: { name: "asc" },
  });
  const norm = (s: any) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const byName = new Map<string, number>();
  for (const e of emps) if (!byName.has(norm(e.name))) byName.set(norm(e.name), e.id);
  const managerOf = new Map<number, number | null>();
  for (const e of emps) {
    const m = e.reportingManager ? byName.get(norm(e.reportingManager)) ?? null : null;
    managerOf.set(e.id, m === e.id ? null : m);
  }
  // Break cycles: walk up from each node; if we revisit a node on the same walk, cut its link.
  for (const e of emps) {
    const seen = new Set<number>();
    let cur: number | null = e.id;
    while (cur != null) {
      if (seen.has(cur)) { managerOf.set(cur, null); break; }
      seen.add(cur);
      cur = managerOf.get(cur) ?? null;
    }
  }
  res.json({
    meId: req.user!.employeeId || null,
    employees: emps.map(({ photoFileName, ...e }) => ({ ...e, managerId: managerOf.get(e.id) ?? null, hasPhoto: !!photoFileName })),
  });
});

// =====================================================================================
// Salary & Designation Revision — the employee's OWN compensation history only (never anyone
// else's). Each CtcRecord segment is one point on the timeline; a "revision" is any change
// between consecutive segments. Monthly CTC is in the record's own currency (INR components
// summed + annual bonus / 12; US/Canada annual override / 12; hourly/day-rate engagements
// annualised the same way the cost engine does). Designation history = joining designation
// (from the Offer) followed by every APPROVED appraisal that carried a designation.
// =====================================================================================
router.get("/salary-revisions", requireEmployee, async (req, res) => {
  const employeeId = req.user!.employeeId!;
  const [emp, records, appraisals] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true, empNo: true, designation: true, joiningDate: true, offer: { select: { designation: true, proposedJoiningDate: true } } } }),
    prisma.ctcRecord.findMany({ where: { employeeId }, orderBy: { effectiveFrom: "asc" } }),
    prisma.appraisal.findMany({ where: { employeeId, status: "APPROVED" }, orderBy: { effectiveDate: "asc" }, select: { id: true, appraisalRef: true, designation: true, effectiveDate: true, reviewPeriod: true } }),
  ]);
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const points = records.map((r) => {
    const annual = ctcAnnualUsd(r, 1); // fxRate 1 ⇒ stays in the record's own currency
    return { id: r.id, effectiveFrom: r.effectiveFrom, effectiveTill: r.effectiveTill, currency: String(r.currency), empType: r.empType, annual: round2(annual), monthly: round2(annual / 12) };
  });
  const revisions = points.slice(1).map((p, i) => {
    const prev = points[i];
    const sameCcy = prev.currency === p.currency;
    const amount = sameCcy ? round2(p.monthly - prev.monthly) : null;
    return {
      effectiveFrom: p.effectiveFrom, currency: p.currency, previousCurrency: prev.currency,
      revisedMonthly: p.monthly, previousMonthly: prev.monthly, revisedAnnual: p.annual, previousAnnual: prev.annual,
      amount, pct: sameCcy && prev.monthly > 0 ? round2(((p.monthly - prev.monthly) / prev.monthly) * 100) : null,
      previousFrom: prev.effectiveFrom,
    };
  });
  const last = revisions[revisions.length - 1] || null;

  // Designation timeline
  const joinDesignation = emp.offer?.designation || (appraisals.length ? null : emp.designation) || null;
  const joinDate = emp.joiningDate || emp.offer?.proposedJoiningDate || points[0]?.effectiveFrom || null;
  const designations: any[] = [];
  if (joinDesignation) designations.push({ effectiveDate: joinDate, designation: joinDesignation, previous: null, source: "Joining", ref: null });
  for (const a of appraisals) {
    const prev = designations[designations.length - 1]?.designation || null;
    if (!a.designation || a.designation === prev) continue;
    designations.push({ effectiveDate: a.effectiveDate, designation: a.designation, previous: prev, source: "Appraisal", ref: a.appraisalRef, reviewPeriod: a.reviewPeriod });
  }
  // Current designation set directly in Employee Master (not via an appraisal) — show it as the latest.
  const lastDes = designations[designations.length - 1]?.designation || null;
  if (emp.designation && emp.designation !== lastDes) designations.push({ effectiveDate: null, designation: emp.designation, previous: lastDes, source: "Employee Master", ref: null });

  res.json({
    currentDesignation: emp.designation || lastDes,
    joiningDate: emp.joiningDate,
    current: points[points.length - 1] || null,
    lastRevision: last ? { effectiveFrom: last.effectiveFrom, pct: last.pct, amount: last.amount } : null,
    lastRevisionDate: last?.effectiveFrom || points[0]?.effectiveFrom || null,
    timeline: points,
    revisions: revisions.reverse(),
    designations,
  });
});

export default router;
