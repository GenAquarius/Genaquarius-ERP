// Relieving & Experience Certificate — issued once an employee's exit is finalized (FNF done,
// Employee.exitDate set). Generate (one action — there's no computation step like Appraisal's
// bracket detection, so Create IS Generate) → Preview (PDF) → Send Email. Every field is editable
// right up until it's actually emailed; once SENT it's locked, same convention as Offer/Appraisal.
// Re-renderable to PDF any time afterward — that re-render IS "kept in Employee Master's document
// records", no separate stored PDF blob (same convention as Appointment Letter/Appraisal).
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole, HR_OPS_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { fillTemplate, buFirst, getHrSignature } from "../../engine/hr";
import { renderRelievingLetterPdf, renderToBuffer, RelievingLetterPdfData } from "../../engine/hrPdf";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { fmtDate } from "../../engine/dateFormat";

const router = Router();
router.use(requireRole(...HR_OPS_ROLES));
router.use(requirePermission("hr-relieving-letters"));

// Company-wide "Jan 2nd 2026" format (see engine/dateFormat.ts) — was previously "02 Jan 2026".
const dstr = fmtDate;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const COMPANY_BY_LOCATION: Record<string, string> = { INDIA: "GenAquarius Private Limited", US: "GenAquarius LLC", CANADA: "GenAquarius Technologies Limited" };

function pronouns(gender: string | null | undefined) {
  const g = String(gender || "").toUpperCase();
  if (g.startsWith("MALE") || g === "M") return { title: "Mr.", poss: "his", subj: "he", obj: "him" };
  if (g.startsWith("FEMALE") || g === "F") return { title: "Ms.", poss: "her", subj: "she", obj: "her" };
  return { title: "", poss: "their", subj: "they", obj: "them" };
}

router.get("/employee/:employeeId", async (req, res) => {
  res.json(await prisma.relievingLetter.findMany({ where: { employeeId: Number(req.params.employeeId) }, orderBy: { createdAt: "desc" } }));
});

router.get("/:id", async (req, res) => {
  const rl = await prisma.relievingLetter.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!rl) return res.status(404).json({ error: "Relieving letter not found" });
  res.json(rl);
});

router.post("/", async (req, res) => {
  const b = req.body || {};
  const employee = await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  if (!employee.exitDate) return res.status(400).json({ error: "This employee hasn't been terminated yet — FNF must be finalized first." });

  // Best-effort prefill from the latest approved termination request (resignation date) — HR can
  // override every one of these on the form before Create, and again any time before Send.
  const term = await prisma.terminationApprovalRequest.findFirst({ where: { employeeId: employee.id, status: "APPROVED" }, orderBy: { id: "desc" } });
  const lastWorkingDate = b.lastWorkingDate ? new Date(b.lastWorkingDate) : employee.exitDate;
  const relievedDate = b.relievedDate ? new Date(b.relievedDate) : addDays(new Date(lastWorkingDate), 1);

  const rl = await prisma.relievingLetter.create({
    data: {
      employeeId: employee.id,
      subject: (b.subject && String(b.subject).trim()) || "Relieving & Experience Certificate",
      date: b.date ? new Date(b.date) : new Date(),
      designation: b.designation ?? employee.designation ?? null,
      department: b.department ?? employee.department ?? null,
      empNo: b.empNo ?? employee.empNo ?? null,
      joiningDate: b.joiningDate ? new Date(b.joiningDate) : employee.joiningDate,
      lastWorkingDate,
      relievedDate,
      resignationDate: b.resignationDate ? new Date(b.resignationDate) : (term?.resignationDate ?? null),
      createdById: req.user!.id,
    },
  });
  res.status(201).json(rl);
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const rl = await prisma.relievingLetter.findUnique({ where: { id } });
  if (!rl) return res.status(404).json({ error: "Relieving letter not found" });
  if (rl.status === "SENT") return res.status(400).json({ error: "Cannot edit — already sent." });
  const b = req.body || {};
  const updated = await prisma.relievingLetter.update({ where: { id }, data: {
    subject: b.subject !== undefined ? (String(b.subject).trim() || "Relieving & Experience Certificate") : undefined,
    date: b.date ? new Date(b.date) : undefined,
    designation: b.designation !== undefined ? b.designation : undefined,
    department: b.department !== undefined ? b.department : undefined,
    empNo: b.empNo !== undefined ? b.empNo : undefined,
    joiningDate: b.joiningDate !== undefined ? (b.joiningDate ? new Date(b.joiningDate) : null) : undefined,
    lastWorkingDate: b.lastWorkingDate !== undefined ? (b.lastWorkingDate ? new Date(b.lastWorkingDate) : null) : undefined,
    relievedDate: b.relievedDate !== undefined ? (b.relievedDate ? new Date(b.relievedDate) : null) : undefined,
    resignationDate: b.resignationDate !== undefined ? (b.resignationDate ? new Date(b.resignationDate) : null) : undefined,
  } });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const rl = await prisma.relievingLetter.findUnique({ where: { id: Number(req.params.id) } });
  if (!rl) return res.json({ ok: true });
  if (rl.status === "SENT") return res.status(400).json({ error: "Cannot delete — already sent." });
  await prisma.relievingLetter.delete({ where: { id: rl.id } });
  res.json({ ok: true });
});

async function buildPdfData(rl: any): Promise<RelievingLetterPdfData> {
  const tpl = await buFirst(rl.employee.businessUnitId, (bu) => prisma.hrRelievingLetterTemplate.findFirst({ where: { ...bu }, orderBy: { isDefault: "desc" } }))
    || await prisma.hrRelievingLetterTemplate.findFirst({ where: { isDefault: true } }) || await prisma.hrRelievingLetterTemplate.findFirst();
  const p = pronouns(rl.employee.gender);
  const vals = {
    EmployeeName: rl.employee.name, Title: p.title, Pronoun: p.poss, PronounSubj: p.subj, PronounObj: p.obj,
    CompanyName: COMPANY_BY_LOCATION[rl.employee.location || "INDIA"] || COMPANY_BY_LOCATION.INDIA,
    Designation: rl.designation || "", Department: rl.department || "", Phone: rl.employee.phone || "",
    JoiningDate: dstr(rl.joiningDate), LastWorkingDate: dstr(rl.lastWorkingDate), RelievedDate: dstr(rl.relievedDate), ResignationDate: dstr(rl.resignationDate),
  };
  const defaultBody = "This is to certify that {{Title}} {{EmployeeName}} was employed with {{CompanyName}} from {{JoiningDate}} to {{LastWorkingDate}} as a {{Designation}} in the {{Department}} department.\n\n"
    + "We hereby confirm that {{Pronoun}} resignation dated {{ResignationDate}} was accepted and {{PronounSubj}} has been relieved from the services of the organization with effect from {{RelievedDate}}, after successful completion of all exit formalities.\n\n"
    + "During the period of employment, {{Pronoun}} performance and conduct were found to be satisfactory. All company assets have been duly returned, and no dues are pending as on {{Pronoun}} last working day.\n\n"
    + "We thank {{PronounObj}} for the contributions made to the organization and wish {{PronounObj}} every success in future professional endeavors.";
  const templateBody = fillTemplate(tpl?.bodyText || defaultBody, vals);
  const subject = rl.subject || tpl?.subject || "Relieving & Experience Certificate";
  return {
    subject, date: rl.date, employeeName: rl.employee.name, empNo: rl.empNo, designation: rl.designation, phone: rl.employee.phone, templateBody,
    ...(await getHrSignature(rl.employee.businessUnitId)),
  };
}

// Live PDF preview while HR is still typing into the Generate/Edit form — same Advanced-Builder
// pattern as the HR Settings template editor's own preview-pdf route, but against REAL employee
// data (gender/location/businessUnitId for pronouns/company/signature) and whatever's currently on
// screen, not yet saved. Registered as its own path (not "/:id/pdf") so it works before Create too.
router.post("/preview-pdf", async (req, res) => {
  const b = req.body || {};
  const employee = await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  const merged = {
    employee,
    subject: b.subject, date: b.date ? new Date(b.date) : new Date(),
    designation: b.designation || null, department: b.department || null, empNo: b.empNo || null,
    joiningDate: b.joiningDate ? new Date(b.joiningDate) : null,
    lastWorkingDate: b.lastWorkingDate ? new Date(b.lastWorkingDate) : null,
    relievedDate: b.relievedDate ? new Date(b.relievedDate) : null,
    resignationDate: b.resignationDate ? new Date(b.resignationDate) : null,
  };
  res.setHeader("Content-Type", "application/pdf");
  renderRelievingLetterPdf(await buildPdfData(merged), res);
});

router.get("/:id/pdf", async (req, res) => {
  const rl = await prisma.relievingLetter.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!rl) return res.status(404).json({ error: "Relieving letter not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Relieving_${rl.empNo || rl.id}.pdf"`);
  renderRelievingLetterPdf(await buildPdfData(rl), res);
});

// Sends the PDF to an HR-chosen address (often the employee's PERSONAL email — their GenAquarius
// account may already be deactivated by the time this goes out), not necessarily Employee.email.
router.post("/:id/send", async (req, res) => {
  const id = Number(req.params.id);
  const rl = await prisma.relievingLetter.findUnique({ where: { id }, include: { employee: true } });
  if (!rl) return res.status(404).json({ error: "Relieving letter not found" });
  if (rl.status === "SENT") return res.status(400).json({ error: "Already sent." });
  const to = String(req.body?.to || "").trim();
  if (!to) return res.status(400).json({ error: "Recipient email is required" });
  if (!mailEnabled()) return res.status(400).json({ error: "Email is not configured on this environment." });

  const pdfData = await buildPdfData(rl);
  const pdf = await renderToBuffer((out) => renderRelievingLetterPdf(pdfData, out));
  const html = `<p>Dear ${rl.employee.name},</p><p>Please find attached your Relieving &amp; Experience Certificate.</p><p>Thank you.</p>`;
  const r = await notifyMail("RELIEVING_LETTER_SEND", { fromUpn: req.user!.email, to, subject: pdfData.subject, html, attachments: [{ name: `Relieving_${rl.empNo || rl.id}.pdf`, contentBytes: pdf.toString("base64"), contentType: "application/pdf" }] });
  if (!r.sent) return res.status(502).json({ error: "Could not send email — check mail configuration." });

  const updated = await prisma.relievingLetter.update({ where: { id }, data: { status: "SENT", sentAt: new Date(), sentTo: to } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "SEND_RELIEVING_LETTER", entity: "RelievingLetter", entityId: String(id), after: { employeeId: rl.employeeId, to } } }).catch(() => {});
  res.json({ ok: true, relievingLetter: updated });
});

export default router;
