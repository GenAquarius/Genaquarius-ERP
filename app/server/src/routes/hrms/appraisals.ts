// HR's Appraisal flow — a revised-CTC "Annual Performance Review" letter for an EXISTING active
// employee (not the hiring pipeline; no Offer record). Generate → Preview → Issue mirrors the
// Offer Letter lifecycle exactly; issuing emails the employee AND puts the CTC change up for
// Finance/CTO/CEO approval (appraisalApprovals.ts), which is what actually creates the new
// CtcRecord (CTC & Employment History → Add CTC Record). India Full-Time gets the full salary
// bracket/breakup; Contractor gets a flat monthly figure; US/Canada get a flat annual override —
// the same three-way split Confirm Joining already uses.
import { Router } from "express";
import fs from "fs";
import path from "path";
import { prisma } from "../../prisma";
import { requireRole, HR_OPS_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { detectBracket, computeSalaryBreakup, fillTemplate, nextAppraisalRef, getHrSignature, buFirst } from "../../engine/hr";
import { renderAppraisalPdf, renderToBuffer, AppraisalPdfData } from "../../engine/hrPdf";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { emitAttention } from "../../engine/realtime";
import { fmtDate } from "../../engine/dateFormat";

const router = Router();
router.use(requireRole(...HR_OPS_ROLES));
router.use(requirePermission("hr-appraisals"));

const dstr = fmtDate;
const firstName = (s: string) => String(s || "").trim().split(/\s+/)[0] || s;

const LOGO_PATH = path.resolve(__dirname, "../../../assets/genaquarius.png");
function logoDataUri(): string | null {
  try { return `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`; } catch { return null; }
}
// A single `\n` → `<br>` only joins lines WITHIN a paragraph correctly; two or more consecutive
// `<br>` tags (what a blank line between paragraphs used to produce) render inconsistently across
// email clients — Outlook in particular often collapses them, which is exactly the "paragraphs run
// together" bug reported. Splitting on blank lines and wrapping each paragraph in its own <p> is
// the reliable cross-client fix. Also appends the HR Email Template's own Signature/Logo (same
// fields the HR Settings → Email Templates editor's preview shows) — the actual send previously
// built its HTML ad hoc and silently dropped both.
function renderEmailHtml(rawBody: string, tpl: any, vals: Record<string, any>): string {
  const filled = fillTemplate(rawBody, vals);
  const paras = filled.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>")}</p>`).join("");
  let html = paras;
  if (tpl?.signature) html += `<p style="margin:0">${fillTemplate(tpl.signature, vals).replace(/\n/g, "<br>")}</p>`;
  if (tpl?.showLogo !== false) { const uri = logoDataUri(); if (uri) html += `<br><img src="${uri}" alt="GenAquarius" style="max-height:40px" />`; }
  return html;
}
const money = (n: number, ccy = "INR") => (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹") + Math.round(n || 0).toLocaleString("en-IN");

// Same INDIA-components / CONTRACTOR / ANNUAL_OVERRIDE three-way split Confirm Joining uses.
function modeFor(employee: { location: string | null; empType: string }): "INDIA_COMPONENTS" | "CONTRACTOR" | "ANNUAL_OVERRIDE" {
  if (employee.location === "INDIA" && employee.empType !== "CONTRACTOR") return "INDIA_COMPONENTS";
  if (employee.location === "INDIA" && employee.empType === "CONTRACTOR") return "CONTRACTOR";
  return "ANNUAL_OVERRIDE";
}
// step 2 reads the mirrored second* fields (a staged raise's later step) — see schema comment on
// Appraisal.secondEffectiveDate.
function revisedDisplay(a: any, step: 1 | 2 = 1): string {
  const mode = modeFor({ location: a.countryCode, empType: a.empType });
  const breakup = step === 2 ? a.secondSalaryBreakup : a.salaryBreakup;
  const ctc = step === 2 ? a.secondRevisedCtc : a.revisedCtc;
  const monthly = step === 2 ? a.secondMonthlyCompensation : a.monthlyCompensation;
  const annual = step === 2 ? a.secondAnnualCostOverride : a.annualCostOverride;
  if (mode === "INDIA_COMPONENTS") return `Rs ${Math.round((breakup?.totalMonthly) ?? (ctc || 0) / 12).toLocaleString("en-IN")}/- per month`;
  if (mode === "CONTRACTOR") return `Rs ${Math.round(monthly || 0).toLocaleString("en-IN")}/- per month`;
  return `${money(annual || 0, a.countryCode === "US" ? "USD" : "CAD")} per annum`;
}
// Same wording the PDF letter body already uses for a staged (2-tranche) raise — appended to both
// the employee's own Issue email and the Finance/CTO/CEO CTC-approval email so every reader sees
// both effective dates and both CTCs, whatever the HR-editable email template itself says.
function stagedTrancheNote(a: any): string {
  if (!a.secondEffectiveDate) return "";
  return ` The increment will be implemented in two tranches, with the first tranche effective from ${dstr(a.effectiveDate)}, revising compensation to ${revisedDisplay(a)}, and the second tranche effective from ${dstr(a.secondEffectiveDate)}, further revising it to ${revisedDisplay(a, 2)}.`;
}

router.get("/", async (_req, res) => {
  res.json(await prisma.appraisal.findMany({ include: { employee: { select: { id: true, name: true, empNo: true, location: true, empType: true } } }, orderBy: { createdAt: "desc" } }));
});
router.get("/:id", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  res.json(a);
});

router.post("/", async (req, res) => {
  const b = req.body || {};
  const employee = await prisma.employee.findUnique({ where: { id: Number(b.employeeId) } });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  if (employee.exitDate) return res.status(400).json({ error: "This employee has been terminated." });
  if (!b.designation?.trim()) return res.status(400).json({ error: "Designation is required" });
  if (!b.effectiveDate) return res.status(400).json({ error: "Effective Date is required" });
  const mode = modeFor(employee);
  if (mode === "INDIA_COMPONENTS" && !b.revisedCtc) return res.status(400).json({ error: "Revised CTC is required" });
  if (mode === "CONTRACTOR" && !b.monthlyCompensation) return res.status(400).json({ error: "Revised Monthly Compensation is required" });
  if (mode === "ANNUAL_OVERRIDE" && !b.annualCostOverride) return res.status(400).json({ error: "Revised Annual CTC is required" });

  // Optional second step (a staged raise) — only validated/stored when HR actually turned it on.
  const hasSecondStep = !!b.secondEffectiveDate;
  if (hasSecondStep) {
    if (new Date(b.secondEffectiveDate) <= new Date(b.effectiveDate)) return res.status(400).json({ error: "The second step's date must be after the first step's Effective Date." });
    if (mode === "INDIA_COMPONENTS" && !b.secondRevisedCtc) return res.status(400).json({ error: "Second step's Revised CTC is required" });
    if (mode === "CONTRACTOR" && !b.secondMonthlyCompensation) return res.status(400).json({ error: "Second step's Revised Monthly Compensation is required" });
    if (mode === "ANNUAL_OVERRIDE" && !b.secondAnnualCostOverride) return res.status(400).json({ error: "Second step's Revised Annual CTC is required" });
  }

  const appraisalRef = await nextAppraisalRef(new Date(), employee.empNo);
  const appraisal = await prisma.appraisal.create({
    data: {
      appraisalRef, employeeId: employee.id, designation: b.designation.trim(), isPromotion: !!b.isPromotion, reviewPeriod: b.reviewPeriod || null,
      effectiveDate: new Date(b.effectiveDate), countryCode: employee.location || "INDIA", empType: employee.empType,
      revisedCtc: mode === "INDIA_COMPONENTS" ? Number(b.revisedCtc) : null,
      monthlyCompensation: mode === "CONTRACTOR" ? Number(b.monthlyCompensation) : null,
      annualCostOverride: mode === "ANNUAL_OVERRIDE" ? Number(b.annualCostOverride) : null,
      secondEffectiveDate: hasSecondStep ? new Date(b.secondEffectiveDate) : null,
      secondRevisedCtc: hasSecondStep && mode === "INDIA_COMPONENTS" ? Number(b.secondRevisedCtc) : null,
      secondMonthlyCompensation: hasSecondStep && mode === "CONTRACTOR" ? Number(b.secondMonthlyCompensation) : null,
      secondAnnualCostOverride: hasSecondStep && mode === "ANNUAL_OVERRIDE" ? Number(b.secondAnnualCostOverride) : null,
      kra: b.kra && String(b.kra).trim() ? String(b.kra).trim() : null,
      requestedById: req.user!.id, createdById: req.user!.id,
    },
  });
  res.status(201).json(appraisal);
});

// Generate — India Full-Time: detect the CTC bracket and compute the salary breakup (same engine
// Offers use); Contractor/US/Canada just validate the flat figure already on the record.
router.post("/:id/generate", async (req, res) => {
  const id = Number(req.params.id);
  const a = await prisma.appraisal.findUnique({ where: { id }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  const mode = modeFor(a.employee);
  let breakup: any = null, bracketId: number | null = null;
  let secondBreakup: any = null;
  if (mode === "INDIA_COMPONENTS") {
    const bracket = await detectBracket(a.revisedCtc!, a.employee.location || "INDIA", a.employee.businessUnitId);
    if (!bracket) return res.status(400).json({ error: "No CTC bracket is configured for this amount — set one up in HR Admin Settings first." });
    breakup = await computeSalaryBreakup(bracket.id, a.revisedCtc!);
    bracketId = bracket.id;
    if (a.secondRevisedCtc) {
      const bracket2 = await detectBracket(a.secondRevisedCtc, a.employee.location || "INDIA", a.employee.businessUnitId);
      if (!bracket2) return res.status(400).json({ error: "No CTC bracket is configured for the second step's amount — set one up in HR Admin Settings first." });
      secondBreakup = await computeSalaryBreakup(bracket2.id, a.secondRevisedCtc);
    }
  }
  const updated = await prisma.appraisal.update({ where: { id }, data: { status: "GENERATED", salaryBreakup: breakup, bracketId, secondSalaryBreakup: secondBreakup } });
  res.json(updated);
});

// The auto-generated letter wording — from the configured template + current field values, live
// (never stored). HR's own edited wording (Appraisal.customBodyOverride) takes precedence over
// this wherever the letter is actually built; this function is also what the Preview-text editor
// starts from and what "Reset to default wording" reverts back to.
async function buildAutoBody(a: any): Promise<string> {
  const tpl = await buFirst(a.employee.businessUnitId, (bu) => prisma.hrAppraisalTemplate.findFirst({ where: { countryCode: a.countryCode, ...bu }, orderBy: { isDefault: "desc" } }))
    || await prisma.hrAppraisalTemplate.findFirst({ where: { isDefault: true } }) || await prisma.hrAppraisalTemplate.findFirst();
  // HR's own explicit checkbox (Appraisal.isPromotion), not an auto-detected diff against the
  // employee's current designation — see the schema field's own comment for why. On its own
  // paragraph via {{DesignationChangeNote}} in the default body; renderAppraisalPdf already drops
  // empty paragraphs after the template fill, so it simply disappears when not a promotion.
  const designationChangeNote = a.isPromotion ? `Also, you are promoted to the designation of ${a.designation}.` : "";
  const vals = { EmployeeName: a.employee.name, Designation: a.designation, RevisedCompensation: revisedDisplay(a), EffectiveDate: dstr(a.effectiveDate), ReviewPeriod: a.reviewPeriod || "", DesignationChangeNote: designationChangeNote };
  let templateBody = fillTemplate(tpl?.bodyText || "Dear {{EmployeeName}},\n\nYour CTC stands revised to {{RevisedCompensation}} with effective from {{EffectiveDate}}.\n\n{{DesignationChangeNote}}", vals);
  // One combined letter for a staged raise — appended after whatever template HR has configured,
  // so it works regardless of whether that template happens to mention a second step. Restates
  // BOTH steps' own date + CTC explicitly (not just the second one) so page 1 reads as a complete
  // summary on its own, even if the configured template's opening line phrases the first step
  // differently.
  if (a.secondEffectiveDate) {
    templateBody += `\n\nThe increment will be implemented in two tranches, with the first tranche effective from ${dstr(a.effectiveDate)}, revising your compensation to ${revisedDisplay(a)}, and the second tranche effective from ${dstr(a.secondEffectiveDate)}, further revising it to ${revisedDisplay(a, 2)}.`;
  }
  // Key Result Areas — optional, structured on its own field (not just typed into the free-text
  // editor) so it survives "Reset to default wording" and shows on the New/Edit forms too.
  if (a.kra && a.kra.trim()) {
    templateBody += `\n\nKey Result Areas (KRA):\n${a.kra.trim()}`;
  }
  return templateBody;
}

async function buildPdfData(a: any): Promise<AppraisalPdfData> {
  const mode = modeFor(a.employee);
  // HR's saved hand-edit wins outright — Preview/PDF/Issue all read the SAME text, so whatever was
  // last saved in the preview editor is exactly what gets issued.
  const templateBody = a.customBodyOverride || await buildAutoBody(a);
  return {
    appraisalRef: a.appraisalRef, date: new Date(), employeeName: a.employee.name, empNo: a.employee.empNo, designation: a.designation,
    effectiveDate: a.effectiveDate, templateBody, mode, currency: mode === "ANNUAL_OVERRIDE" ? (a.countryCode === "US" ? "USD" : "CAD") : "INR",
    revisedMonthlyDisplay: revisedDisplay(a), breakup: a.salaryBreakup, monthlyCompensation: a.monthlyCompensation, annualCostOverride: a.annualCostOverride,
    secondEffectiveDate: a.secondEffectiveDate, secondRevisedMonthlyDisplay: a.secondEffectiveDate ? revisedDisplay(a, 2) : undefined,
    secondBreakup: a.secondSalaryBreakup, secondMonthlyCompensation: a.secondMonthlyCompensation, secondAnnualCostOverride: a.secondAnnualCostOverride,
    ...(await getHrSignature(a.employee.businessUnitId)),
  };
}

router.get("/:id/pdf", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (a.status === "DRAFT") return res.status(400).json({ error: "Generate the appraisal first." });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Appraisal_${a.employee.empNo || a.id}.pdf"`);
  renderAppraisalPdf(await buildPdfData(a), res);
});

router.post("/:id/preview", async (req, res) => {
  const id = Number(req.params.id);
  const a = await prisma.appraisal.findUnique({ where: { id } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (a.status === "GENERATED") await prisma.appraisal.update({ where: { id }, data: { status: "PREVIEWED" } });
  res.json({ ok: true });
});

// HR's editable letter text — what Preview/PDF/Issue all actually use (see buildPdfData). GET
// returns the saved hand-edit if there is one, else the live auto-generated wording (so the editor
// always opens with real, current text, never blank). PUT saves a hand-edit (blank clears it,
// reverting to auto-generation) — editable any time before Issue, independent of the structured
// fields' own DRAFT-on-edit rule, since wording changes don't invalidate a prior Generate.
router.get("/:id/preview-text", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  const body = a.customBodyOverride || await buildAutoBody(a);
  res.json({ body, isCustom: !!a.customBodyOverride });
});
router.put("/:id/preview-text", async (req, res) => {
  const id = Number(req.params.id);
  const a = await prisma.appraisal.findUnique({ where: { id } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (!["GENERATED", "PREVIEWED"].includes(a.status)) return res.status(400).json({ error: `Cannot edit letter text from status ${a.status}.` });
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const updated = await prisma.appraisal.update({ where: { id }, data: { customBodyOverride: body || null } });
  res.json({ ok: true, isCustom: !!updated.customBodyOverride });
});

// Issue — emails the employee (letter attached) AND notifies Finance/CTO/CEO that the CTC change
// needs approval. Status ISSUED itself IS "pending approval" — appraisalApprovals.ts moves it to
// APPROVED/REJECTED. Nothing on the Employee's CTC/Employment History changes until then.
router.post("/:id/issue", async (req, res) => {
  const id = Number(req.params.id);
  const a = await prisma.appraisal.findUnique({ where: { id }, include: { employee: true } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (!["GENERATED", "PREVIEWED"].includes(a.status)) return res.status(400).json({ error: `Cannot issue from status ${a.status}.` });
  // HR can override the recipient right on the Issue screen (e.g. a corrected or personal email)
  // without having to go edit Employee Master first — whatever's typed there wins.
  const to = (req.body?.email && String(req.body.email).trim()) || a.employee.email;
  if (!to) return res.status(400).json({ error: "This employee has no email on file — add one in Employee Master first, or type one before issuing." });

  const pdfData = await buildPdfData(a);
  let emailedEmployee = false;
  if (mailEnabled()) {
    try {
      const pdf = await renderToBuffer((out) => renderAppraisalPdf(pdfData, out));
      // A staged (2-tranche) appraisal uses its own HR-editable template (HR Settings → Email
      // Templates → "Annual Performance Review Email — 2-Stage") with both dates/CTCs as their own
      // placeholders, instead of the single-tranche APPRAISAL_LETTER_EMAIL.
      const isStaged = !!a.secondEffectiveDate;
      const stageTpl = isStaged ? await buFirst(a.employee.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "APPRAISAL_LETTER_EMAIL_STAGE", ...bu } })) : null;
      const tpl = stageTpl || await buFirst(a.employee.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "APPRAISAL_LETTER_EMAIL", ...bu } }));
      const vals: Record<string, any> = { EmployeeFirstName: firstName(a.employee.name), Designation: a.designation, RevisedCompensation: revisedDisplay(a), EffectiveDate: dstr(a.effectiveDate) };
      if (isStaged) { vals.SecondEffectiveDate = dstr(a.secondEffectiveDate); vals.SecondRevisedCompensation = revisedDisplay(a, 2); }
      const defaultBody = isStaged
        ? "Dear {{EmployeeFirstName}}, please find attached your Annual Performance Review. Your CTC will be revised in two tranches: to {{RevisedCompensation}} effective from {{EffectiveDate}}, and further to {{SecondRevisedCompensation}} effective from {{SecondEffectiveDate}}."
        : "Dear {{EmployeeFirstName}}, please find attached your Annual Performance Review.";
      const subject = fillTemplate(tpl?.subject || "Your Annual Performance Review — GenAquarius", vals);
      // The dedicated stage template already states both tranches itself — only append the
      // auto-generated note as a backstop when no such template was found (default/fallback body),
      // as its own paragraph (blank-line-joined) rather than raw string concatenation.
      const rawBody = (tpl?.body || defaultBody) + (isStaged && stageTpl ? "" : `\n\n${stagedTrancheNote(a).trim()}`);
      const html = renderEmailHtml(rawBody, tpl, vals);
      const r = await notifyMail("APPRAISAL_SEND", { fromUpn: req.user!.email, to, subject, html, attachments: [{ name: `Appraisal_${a.employee.empNo || a.id}.pdf`, contentBytes: pdf.toString("base64"), contentType: "application/pdf" }] });
      emailedEmployee = r.sent;
    } catch { /* issuance still proceeds — HR can hand the PDF over manually */ }
  }

  // Notify Finance/CTO/CEO — same recipient set + pattern as Confirm Joining's CTC approval email.
  const recipients = await prisma.user.findMany({ where: { role: { in: ["FINANCE", "CTO", "CEO"] } }, select: { email: true } });
  const tpl2 = await buFirst(a.employee.businessUnitId, (bu) => prisma.hrEmailTemplate.findFirst({ where: { key: "APPRAISAL_CTC_APPROVAL_REQUEST", ...bu } }));
  const vals2 = { EmployeeName: a.employee.name, EmployeeId: a.employee.empNo || "", RevisedCompensation: revisedDisplay(a), EffectiveDate: dstr(a.effectiveDate) };
  const subject2 = fillTemplate(tpl2?.subject || "Action needed: appraisal CTC approval for {{EmployeeName}} ({{EmployeeId}})", vals2);
  const rawBody2 = (tpl2?.body || "HR has issued a revised appraisal — please review and approve.") + `\n\n${stagedTrancheNote(a).trim()}`;
  const html2 = renderEmailHtml(rawBody2, tpl2, vals2);
  let notified = 0;
  if (mailEnabled()) {
    for (const r of recipients) { if (!r.email) continue; try { const rr = await notifyMail("APPRAISAL_CTC_APPROVAL_NOTIFY", { fromUpn: req.user!.email, to: r.email, subject: subject2, html: html2 }); if (rr.sent) notified++; } catch { /* one bad recipient shouldn't block the rest */ } }
  }

  const updated = await prisma.appraisal.update({ where: { id }, data: { status: "ISSUED", issuedAt: new Date() } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "ISSUE_APPRAISAL", entity: "Appraisal", entityId: String(id), after: { employeeId: a.employeeId, appraisalRef: a.appraisalRef, sentTo: to } } }).catch(() => {});
  emitAttention(["FINANCE", "CTO", "CEO", "COO"], "appraisal_approval_pending", { employeeName: a.employee.name });
  res.json({ appraisal: updated, emailedEmployee, sentTo: to, notified, totalRecipients: recipients.length });
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const a = await prisma.appraisal.findUnique({ where: { id } });
  if (!a) return res.status(404).json({ error: "Appraisal not found" });
  if (a.status !== "DRAFT" && a.status !== "GENERATED") return res.status(400).json({ error: "Can only edit before it's issued." });
  const b = req.body || {};
  // Second step is edited as a package — clearing its date drops the whole step (and its stale
  // breakup), not just the date, same as never having set one.
  const clearingSecondStep = "secondEffectiveDate" in b && !b.secondEffectiveDate;
  const updated = await prisma.appraisal.update({ where: { id }, data: {
    designation: b.designation !== undefined ? b.designation : undefined, isPromotion: b.isPromotion !== undefined ? !!b.isPromotion : undefined, reviewPeriod: b.reviewPeriod !== undefined ? (b.reviewPeriod || null) : undefined,
    effectiveDate: b.effectiveDate ? new Date(b.effectiveDate) : undefined,
    revisedCtc: b.revisedCtc != null ? Number(b.revisedCtc) : undefined,
    monthlyCompensation: b.monthlyCompensation != null ? Number(b.monthlyCompensation) : undefined,
    annualCostOverride: b.annualCostOverride != null ? Number(b.annualCostOverride) : undefined,
    secondEffectiveDate: clearingSecondStep ? null : b.secondEffectiveDate ? new Date(b.secondEffectiveDate) : undefined,
    secondRevisedCtc: clearingSecondStep ? null : b.secondRevisedCtc != null ? Number(b.secondRevisedCtc) : undefined,
    secondMonthlyCompensation: clearingSecondStep ? null : b.secondMonthlyCompensation != null ? Number(b.secondMonthlyCompensation) : undefined,
    secondAnnualCostOverride: clearingSecondStep ? null : b.secondAnnualCostOverride != null ? Number(b.secondAnnualCostOverride) : undefined,
    secondSalaryBreakup: (clearingSecondStep ? null : undefined) as any,
    kra: b.kra !== undefined ? (String(b.kra).trim() || null) : undefined,
    status: "DRAFT", // any edit invalidates a prior Generate — HR must Generate again before Issue
  } });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const a = await prisma.appraisal.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.json({ ok: true });
  // REJECTED is also deletable (a dead-end HR may want to clear out) — only an actual APPROVED
  // CTC change (already reflected in the employee's CTC & Employment History) is locked forever.
  if (!["DRAFT", "GENERATED", "PREVIEWED", "REJECTED"].includes(a.status)) return res.status(400).json({ error: "Cannot delete an approved appraisal." });
  await prisma.appraisal.delete({ where: { id: a.id } });
  res.json({ ok: true });
});

export default router;
