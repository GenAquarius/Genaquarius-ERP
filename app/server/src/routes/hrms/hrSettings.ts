// HR Admin Settings — every rule the offer/appointment-letter engine uses is a row here.
// Visible to HR, CEO, CTO, FINANCE (HR_SETTINGS_ROLES) — never to PROJECT_MANAGER/EMPLOYEE.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole, HR_SETTINGS_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { detectBracket, computeSalaryBreakup, fillTemplate, amountToWordsIndia, getHrSignature } from "../../engine/hr";
import { renderOfferPdf, renderAppointmentPdf, renderServiceAgreementPdf, renderAppraisalPdf, renderMsaSowPdf, renderRelievingLetterPdf, ServiceAgreementClause } from "../../engine/hrPdf";

const router = Router();
router.use(requireRole(...HR_SETTINGS_ROLES));
// Additive dynamic gate on top of the static role check above — a CTO can further disable
// "hr-settings" for a whole role via the Module Access Matrix without touching this file.
router.use(requirePermission("hr-settings"));

// Tri-state Business Unit filter shared by every BU-scoped GET below: omitted (`undefined`) =
// no filter at all (used nowhere currently, kept for completeness); the literal string "null"
// = only Country-default rows (businessUnitId IS NULL); a numeric id = only that BU's own rows.
// The client-side BusinessUnitSelector always sends one of "null" or a real id, never omits it.
function parseBuParam(req: any): number | null | undefined {
  const raw = req.query.businessUnitId;
  if (raw === undefined) return undefined;
  if (raw === "null") return null;
  return Number(raw);
}

// ---- Advanced Builder live preview helpers — sample/fake data ONLY, never a real candidate,
// employee or contractor row. Mirrors invoices.ts's own preview-pdf: renders straight from the
// in-progress (possibly unsaved) request body via the exact same render*Pdf() functions the real
// generate endpoints in hrOffers.ts use, so a saved template renders identically. ----
const previewMoney = (n: number, ccy = "INR") => (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹") + Math.round(n || 0).toLocaleString("en-IN");
const previewRsAmount = (n: number) => `Rs ${Math.round(n || 0).toLocaleString("en-IN")}/-`;
const previewCcy = (countryCode: string) => (countryCode === "US" ? "USD" : countryCode === "CANADA" ? "CAD" : "INR");

// ---- Signature (singleton) — used on every generated Offer/Appointment/Appraisal/Service
// Agreement PDF (see engine/hr.ts's getHrSignature()). GET never returns the base64 image (list
// callers don't need it); the Advanced Builder previews and the real render routes fetch it
// themselves via getHrSignature(). ----
// `businessUnitId` (optional, tri-state): omitted/"null" = the company-wide default signature
// (formerly the id:1 singleton); a numeric id = that Business Unit's own override — falls back
// to the default when read (getHrSignature()'s buFirst()) if the BU hasn't set one yet.
router.get("/signature", async (req, res) => {
  const businessUnitId = parseBuParam(req) ?? null;
  const row = await prisma.hrSignature.findFirst({ where: { businessUnitId } });
  res.json({ signatoryName: row?.signatoryName || "Vivek Kaw", signatoryTitle: row?.signatoryTitle || "CHRO", hasImage: !!row?.imageData });
});
router.get("/signature/image", async (req, res) => {
  const businessUnitId = parseBuParam(req) ?? null;
  const row = await prisma.hrSignature.findFirst({ where: { businessUnitId } });
  if (!row?.imageData) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.send(Buffer.from(row.imageData, "base64"));
});
router.put("/signature", async (req, res) => {
  const b = req.body || {};
  const businessUnitId = b.businessUnitId ? Number(b.businessUnitId) : null;
  const data: any = { signatoryName: b.signatoryName || null, signatoryTitle: b.signatoryTitle || null, updatedById: req.user!.id };
  if (b.imageData !== undefined) data.imageData = b.imageData || null;
  const existing = await prisma.hrSignature.findFirst({ where: { businessUnitId } });
  const row = existing
    ? await prisma.hrSignature.update({ where: { id: existing.id }, data })
    : await prisma.hrSignature.create({ data: { businessUnitId, ...data } });
  res.json({ signatoryName: row.signatoryName || "Vivek Kaw", signatoryTitle: row.signatoryTitle || "CHRO", hasImage: !!row.imageData });
});

// ---- CTC brackets + salary components ----
// `businessUnitId` query param (optional): unfiltered when omitted (Salary & CTC settings shows
// everything, Country+BU columns visible), otherwise scoped to just that BU's own override rows
// — a BU with none yet shows empty here (its live fallback to the Country default still applies
// wherever detectBracket() is actually used, e.g. Generate Offer — see engine/hr.ts's buRows()).
router.get("/ctc-brackets", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrCtcBracket.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, include: { components: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } }));
});
router.post("/ctc-brackets", async (req, res) => {
  const b = req.body;
  const bracket = await prisma.hrCtcBracket.create({
    data: { name: b.name, countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, minCtc: Number(b.minCtc) || 0, maxCtc: b.maxCtc === "" || b.maxCtc == null ? null : Number(b.maxCtc), referenceSheet: b.referenceSheet || null, order: Number(b.order) || 0 },
  });
  res.status(201).json(bracket);
});
router.put("/ctc-brackets/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrCtcBracket.update({
    where: { id: Number(req.params.id) },
    data: { name: b.name, countryCode: b.countryCode, minCtc: b.minCtc != null ? Number(b.minCtc) : undefined, maxCtc: b.maxCtc === "" ? null : (b.maxCtc != null ? Number(b.maxCtc) : undefined), referenceSheet: b.referenceSheet, order: b.order != null ? Number(b.order) : undefined },
  }));
});
router.delete("/ctc-brackets/:id", async (req, res) => {
  await prisma.hrCtcBracket.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
// Clones every Country-default bracket (+ its salary components) into a fresh set of rows scoped
// to this Business Unit — the practical starting point for a BU override (start from what already
// works, then tweak percentages/ranges for this BU) rather than building one from a blank form.
router.post("/ctc-brackets/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrCtcBracket.findMany({ where: { countryCode: bu.countryCode, businessUnitId: null }, include: { components: true } });
  for (const d of defaults) {
    await prisma.hrCtcBracket.create({ data: {
      name: d.name, countryCode: d.countryCode, businessUnitId, minCtc: d.minCtc, maxCtc: d.maxCtc, referenceSheet: d.referenceSheet, order: d.order,
      components: { create: d.components.map((c) => ({ name: c.name, part: c.part, pct: c.pct, order: c.order })) },
    } });
  }
  res.json({ cloned: defaults.length });
});

router.post("/ctc-brackets/:id/components", async (req, res) => {
  const b = req.body;
  const comp = await prisma.hrSalaryComponent.create({
    data: { bracketId: Number(req.params.id), name: b.name, part: b.part === "B" ? "B" : "A", pct: Number(b.pct) || 0, order: Number(b.order) || 0 },
  });
  res.status(201).json(comp);
});
router.put("/components/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrSalaryComponent.update({
    where: { id: Number(req.params.id) },
    data: { name: b.name, part: b.part, pct: b.pct != null ? Number(b.pct) : undefined, order: b.order != null ? Number(b.order) : undefined },
  }));
});
router.delete("/components/:id", async (req, res) => {
  await prisma.hrSalaryComponent.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// ---- Tax brackets ----
router.get("/tax-brackets", async (req, res) => {
  const countryCode = String(req.query.countryCode || "INDIA");
  const regime = String(req.query.regime || "NEW");
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrTaxBracket.findMany({ where: { countryCode, regime, ...(businessUnitId !== undefined ? { businessUnitId } : {}) }, orderBy: { order: "asc" } }));
});
router.post("/tax-brackets", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrTaxBracket.create({
    data: { countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, regime: b.regime || "NEW", minIncome: Number(b.minIncome) || 0, maxIncome: b.maxIncome === "" || b.maxIncome == null ? null : Number(b.maxIncome), ratePct: Number(b.ratePct) || 0, order: Number(b.order) || 0 },
  }));
});
router.put("/tax-brackets/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrTaxBracket.update({
    where: { id: Number(req.params.id) },
    data: { minIncome: b.minIncome != null ? Number(b.minIncome) : undefined, maxIncome: b.maxIncome === "" ? null : (b.maxIncome != null ? Number(b.maxIncome) : undefined), ratePct: b.ratePct != null ? Number(b.ratePct) : undefined, order: b.order != null ? Number(b.order) : undefined },
  }));
});
router.delete("/tax-brackets/:id", async (req, res) => {
  await prisma.hrTaxBracket.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
router.post("/tax-brackets/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrTaxBracket.findMany({ where: { countryCode: bu.countryCode, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrTaxBracket.create({ data: { countryCode: d.countryCode, businessUnitId, regime: d.regime, minIncome: d.minIncome, maxIncome: d.maxIncome, ratePct: d.ratePct, order: d.order } });
  }
  res.json({ cloned: defaults.length });
});

// ---- Countries (currency/name only) ----
router.get("/countries", async (_req, res) => res.json(await prisma.hrCountryConfig.findMany({ orderBy: { code: "asc" } })));
router.post("/countries", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrCountryConfig.create({ data: { code: b.code, name: b.name, currency: b.currency } }));
});
router.put("/countries/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrCountryConfig.update({ where: { id: Number(req.params.id) }, data: { name: b.name, currency: b.currency } }));
});

// ---- Standard Deduction & Cess — per (country, regime), not per country ----
router.get("/tax-regime-config", async (req, res) => {
  const countryCode = String(req.query.countryCode || "INDIA");
  const regime = String(req.query.regime || "NEW");
  const cfg = await prisma.hrTaxRegimeConfig.findUnique({ where: { countryCode_regime: { countryCode, regime } } });
  res.json(cfg || { countryCode, regime, standardDeduction: 0, cessPct: 0 });
});
router.put("/tax-regime-config", async (req, res) => {
  const b = req.body;
  const countryCode = b.countryCode || "INDIA", regime = b.regime || "NEW";
  const cfg = await prisma.hrTaxRegimeConfig.upsert({
    where: { countryCode_regime: { countryCode, regime } },
    update: { standardDeduction: b.standardDeduction != null ? Number(b.standardDeduction) : undefined, cessPct: b.cessPct != null ? Number(b.cessPct) : undefined },
    create: { countryCode, regime, standardDeduction: Number(b.standardDeduction) || 0, cessPct: Number(b.cessPct) || 0 },
  });
  res.json(cfg);
});

// ---- Business units ----
router.get("/business-units", async (_req, res) => res.json(await prisma.hrBusinessUnit.findMany({ orderBy: { name: "asc" } })));
router.post("/business-units", async (req, res) => {
  const b = req.body;
  const bu = await prisma.hrBusinessUnit.create({ data: { name: b.name, countryCode: b.countryCode || "INDIA" } });
  res.status(201).json(bu);
});
router.put("/business-units/:id", async (req, res) => {
  const b = req.body;
  const bu = await prisma.hrBusinessUnit.update({ where: { id: Number(req.params.id) }, data: { name: b.name, countryCode: b.countryCode } });
  res.json(bu);
});
router.delete("/business-units/:id", async (req, res) => {
  await prisma.hrBusinessUnit.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// ---- Designations & Departments (Organization) — feed Generate Offer's dropdowns ----
router.get("/designations", async (_req, res) => res.json(await prisma.hrDesignation.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] })));
router.post("/designations", async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const count = await prisma.hrDesignation.count();
  res.status(201).json(await prisma.hrDesignation.create({ data: { name, order: count } }));
});
router.put("/designations/:id", async (req, res) => {
  res.json(await prisma.hrDesignation.update({ where: { id: Number(req.params.id) }, data: { name: req.body.name } }));
});
router.delete("/designations/:id", async (req, res) => {
  await prisma.hrDesignation.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

router.get("/departments", async (_req, res) => res.json(await prisma.hrDepartment.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] })));
router.post("/departments", async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const count = await prisma.hrDepartment.count();
  res.status(201).json(await prisma.hrDepartment.create({ data: { name, order: count } }));
});
router.put("/departments/:id", async (req, res) => {
  res.json(await prisma.hrDepartment.update({ where: { id: Number(req.params.id) }, data: { name: req.body.name } }));
});
router.delete("/departments/:id", async (req, res) => {
  await prisma.hrDepartment.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// ---- Offer templates ----
router.get("/offer-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrOfferTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/offer-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrOfferTemplate.create({ data: { name: b.name, countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, minCtc: Number(b.minCtc) || 0, maxCtc: b.maxCtc === "" || b.maxCtc == null ? null : Number(b.maxCtc), bodyText: b.bodyText || "", isDefault: !!b.isDefault } }));
});
router.put("/offer-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrOfferTemplate.update({
    where: { id: Number(req.params.id) },
    data: { name: b.name, countryCode: b.countryCode, minCtc: b.minCtc != null ? Number(b.minCtc) : undefined, maxCtc: b.maxCtc === "" ? null : (b.maxCtc != null ? Number(b.maxCtc) : undefined), bodyText: b.bodyText, isDefault: b.isDefault },
  }));
});
router.delete("/offer-templates/:id", async (req, res) => {
  await prisma.hrOfferTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
router.post("/offer-templates/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrOfferTemplate.findMany({ where: { countryCode: bu.countryCode, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrOfferTemplate.create({ data: { name: d.name, countryCode: d.countryCode, businessUnitId, minCtc: d.minCtc, maxCtc: d.maxCtc, bodyText: d.bodyText, isDefault: d.isDefault } });
  }
  res.json({ cloned: defaults.length });
});

// ✨ Advanced Builder live preview — renders the in-progress bodyText (not yet saved) against a
// fake candidate + a real CTC-bracket breakup, via the same renderOfferPdf() the real Offer PDF
// uses. Nothing is persisted (no offer/version/audit row is touched).
router.post("/offer-templates/preview-pdf", async (req, res) => {
  const b = req.body || {};
  const countryCode = b.countryCode || "INDIA";
  const minCtc = Number(b.minCtc) || 0;
  const maxCtc = b.maxCtc === "" || b.maxCtc == null ? null : Number(b.maxCtc);
  const sampleCtc = maxCtc != null ? Math.round((minCtc + maxCtc) / 2) : Math.round((minCtc || 1200000) * 1.15);
  const bracket = await detectBracket(sampleCtc, countryCode);
  let breakup: any;
  if (bracket) {
    breakup = await computeSalaryBreakup(bracket.id, sampleCtc);
  } else {
    const flat = Math.round(sampleCtc / 12);
    breakup = { bracketId: 0, bracketName: "Not modeled", components: [{ name: "Total Compensation", part: "A", pct: 100, monthly: flat, annual: sampleCtc }], grossA: flat, grossAAnnual: sampleCtc, grossB: 0, grossBAnnual: 0, totalMonthly: flat, totalAnnual: sampleCtc };
  }
  const offerDate = new Date();
  const proposedJoiningDate = new Date(Date.now() + 30 * 86400000);
  const templateBody = fillTemplate(b.bodyText || "", {
    CandidateFirstName: "Aditi", Role: "Senior Software Engineer", Designation: "Senior Software Engineer",
    OfferRef: "OFR-PREVIEW-0001", ProposedJoiningDate: proposedJoiningDate, Business: "GenAquarius Technologies",
    Ctc: previewMoney(sampleCtc, previewCcy(countryCode)),
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="offer-template-preview.pdf"`);
  renderOfferPdf({
    offerRef: "OFR-PREVIEW-0001", candidateName: "Aditi Sharma", role: "Senior Software Engineer", designation: "Senior Software Engineer",
    ctc: sampleCtc, offerDate, proposedJoiningDate, businessName: "GenAquarius Technologies", countryCode,
    reportingManager: "Rohit Verma", probationPeriod: "3 months", noticePeriod: "2 months", phone: "+91 98765 43210",
    acceptanceDeadline: new Date(Date.now() + 7 * 86400000), documentChecklist: ["PAN Card", "Aadhar Card", "Educational Certificates", "Address Proof"],
    templateBody, breakup, ...(await getHrSignature()),
  }, res);
});

// ---- Appraisal ("Annual Performance Review") templates — same simple bodyText shape as Offer
// templates (a handful of flowing paragraphs, no clause library needed). ----
router.get("/appraisal-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrAppraisalTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/appraisal-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrAppraisalTemplate.create({ data: { name: b.name, countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, bodyText: b.bodyText || "", isDefault: !!b.isDefault } }));
});
router.put("/appraisal-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrAppraisalTemplate.update({ where: { id: Number(req.params.id) }, data: { name: b.name, bodyText: b.bodyText, isDefault: b.isDefault } }));
});
router.delete("/appraisal-templates/:id", async (req, res) => {
  await prisma.hrAppraisalTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
router.post("/appraisal-templates/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrAppraisalTemplate.findMany({ where: { countryCode: bu.countryCode, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrAppraisalTemplate.create({ data: { name: d.name, countryCode: d.countryCode, businessUnitId, bodyText: d.bodyText, isDefault: d.isDefault } });
  }
  res.json({ cloned: defaults.length });
});
router.post("/appraisal-templates/preview-pdf", async (req, res) => {
  const b = req.body || {};
  const sampleCtc = 3090000; // matches the real reference letter's own sample figure
  const bracket = await detectBracket(sampleCtc, "INDIA");
  const breakup = bracket ? await computeSalaryBreakup(bracket.id, sampleCtc) : undefined;
  const effectiveDate = new Date(Date.now() + 14 * 86400000);
  const revisedMonthlyDisplay = breakup ? `Rs ${Math.round(breakup.totalMonthly).toLocaleString("en-IN")}/- per month` : `Rs ${Math.round(sampleCtc / 12).toLocaleString("en-IN")}/- per month`;
  const templateBody = fillTemplate(b.bodyText || "", {
    EmployeeName: "Vaishali Lambat", Designation: "Senior Salesforce Administrator", RevisedCompensation: revisedMonthlyDisplay,
    EffectiveDate: effectiveDate, ReviewPeriod: "FY 2025-26",
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="appraisal-template-preview.pdf"`);
  renderAppraisalPdf({
    appraisalRef: "GenAquarius/Preview/0001", date: new Date(), employeeName: "Vaishali Lambat", empNo: "0033",
    designation: "Senior Salesforce Administrator", effectiveDate, templateBody, mode: bracket ? "INDIA_COMPONENTS" : "ANNUAL_OVERRIDE",
    currency: "INR", revisedMonthlyDisplay, breakup, ...(await getHrSignature()),
  }, res);
});

// ---- Relieving & Experience Certificate templates — same simple subject+bodyText shape, no
// country scoping (the letter's wording doesn't vary by country the way CTC structure does). ----
router.get("/relieving-letter-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrRelievingLetterTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/relieving-letter-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrRelievingLetterTemplate.create({ data: {
    name: b.name, businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, subject: b.subject || "Relieving & Experience Certificate", bodyText: b.bodyText || "", isDefault: !!b.isDefault,
    signatoryName: b.signatoryName?.trim() || null, signatoryTitle: b.signatoryTitle?.trim() || null,
  } }));
});
router.put("/relieving-letter-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrRelievingLetterTemplate.update({ where: { id: Number(req.params.id) }, data: {
    name: b.name, subject: b.subject, bodyText: b.bodyText, isDefault: b.isDefault,
    signatoryName: b.signatoryName !== undefined ? (b.signatoryName?.trim() || null) : undefined,
    signatoryTitle: b.signatoryTitle !== undefined ? (b.signatoryTitle?.trim() || null) : undefined,
  } }));
});
router.delete("/relieving-letter-templates/:id", async (req, res) => {
  await prisma.hrRelievingLetterTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
router.post("/relieving-letter-templates/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrRelievingLetterTemplate.findMany({ where: { businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrRelievingLetterTemplate.create({ data: { name: d.name, businessUnitId, subject: d.subject, bodyText: d.bodyText, isDefault: d.isDefault, signatoryName: d.signatoryName, signatoryTitle: d.signatoryTitle } });
  }
  res.json({ cloned: defaults.length });
});
router.post("/relieving-letter-templates/preview-pdf", async (req, res) => {
  const b = req.body || {};
  const sampleVals = {
    EmployeeName: "Tripurari Kumar Ojha", Title: "Mr.", Pronoun: "his", PronounSubj: "he", PronounObj: "him",
    CompanyName: "GenAquarius Private Limited", Designation: "Manual QA", Department: "IT",
    JoiningDate: "30 Sep 2025", LastWorkingDate: "31 May 2026", RelievedDate: "01 Jun 2026", ResignationDate: "14 May 2026",
  };
  const templateBody = fillTemplate(b.bodyText || "", sampleVals);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="relieving-letter-template-preview.pdf"`);
  const sig = await getHrSignature();
  renderRelievingLetterPdf({
    subject: b.subject || "Relieving & Experience Certificate", date: new Date(), employeeName: sampleVals.EmployeeName, empNo: "1039",
    designation: sampleVals.Designation, templateBody, ...sig,
    signatoryName: b.signatoryName?.trim() || sig.signatoryName, signatoryTitle: b.signatoryTitle?.trim() || sig.signatoryTitle,
  }, res);
});

// ---- Appointment templates (clauses = JSON [{key,title,body,enabled,order}]) ----
router.get("/appointment-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrAppointmentTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/appointment-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrAppointmentTemplate.create({ data: { name: b.name, countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, clauses: b.clauses || [], isDefault: !!b.isDefault } }));
});
router.put("/appointment-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrAppointmentTemplate.update({ where: { id: Number(req.params.id) }, data: { name: b.name, countryCode: b.countryCode, clauses: b.clauses, isDefault: b.isDefault } }));
});
router.delete("/appointment-templates/:id", async (req, res) => {
  await prisma.hrAppointmentTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
router.post("/appointment-templates/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrAppointmentTemplate.findMany({ where: { countryCode: bu.countryCode, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrAppointmentTemplate.create({ data: { name: d.name, countryCode: d.countryCode, businessUnitId, clauses: d.clauses as any, isDefault: d.isDefault } });
  }
  res.json({ cloned: defaults.length });
});

// ✨ Advanced Builder live preview — renders the in-progress clause list (not yet saved) against
// a fake employee, via the same renderAppointmentPdf() the real Appointment Letter PDF uses.
router.post("/appointment-templates/preview-pdf", async (req, res) => {
  const b = req.body || {};
  const countryCode = b.countryCode || "INDIA";
  const joiningDate = new Date(Date.now() + 14 * 86400000);
  const dynamicFields = {
    EmployeeName: "Aditi Sharma", EmployeeId: "1234",
    DateOfAppointment: joiningDate, JoiningDate: joiningDate,
    JobTitle: "Senior Software Engineer", Designation: "Senior Software Engineer", Department: "Engineering",
    BusinessUnit: "GenAquarius Technologies", ReportingManager: "Rohit Verma",
    WorkLocation: "Noida", Ctc: previewMoney(1500000, previewCcy(countryCode)),
    EmploymentType: "Full Time", NoticePeriod: "2 months", ProbationPeriod: "3 months",
  };
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="appointment-template-preview.pdf"`);
  renderAppointmentPdf({ empNo: "1234", dynamicFields, clauses: b.clauses || [], ...(await getHrSignature()) }, res);
});

// ---- Service Agreement templates (CONTRACTOR) — clauses = JSON [{key,articleLabel,romanHeading,
// pointStyle,points,enabled,order}] (see engine/hrPdf.ts's ServiceAgreementClause), plus a
// separately-editable `services` string[] (Article 1(a)'s numbered services list) — same CRUD
// shape as the appointment templates above, just with the extra `services` field. ----
router.get("/service-agreement-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrServiceAgreementTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/service-agreement-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrServiceAgreementTemplate.create({ data: { name: b.name, countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, clauses: b.clauses || [], services: b.services || [], isDefault: !!b.isDefault } }));
});
router.put("/service-agreement-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrServiceAgreementTemplate.update({ where: { id: Number(req.params.id) }, data: { name: b.name, countryCode: b.countryCode, clauses: b.clauses, services: b.services, isDefault: b.isDefault } }));
});
router.delete("/service-agreement-templates/:id", async (req, res) => {
  await prisma.hrServiceAgreementTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
router.post("/service-agreement-templates/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.hrServiceAgreementTemplate.findMany({ where: { countryCode: bu.countryCode, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrServiceAgreementTemplate.create({ data: { name: d.name, countryCode: d.countryCode, businessUnitId, clauses: d.clauses as any, services: d.services as any, isDefault: d.isDefault } });
  }
  res.json({ cloned: defaults.length });
});

// ✨ Advanced Builder live preview — renders the in-progress clauses/services (not yet saved)
// against a fake contractor, via the same renderServiceAgreementPdf() the real Service Agreement
// PDF uses.
router.post("/service-agreement-templates/preview-pdf", async (req, res) => {
  const b = req.body || {};
  const monthlyCompensation = 80000;
  const dynamicFields = {
    EffectiveDate: new Date(), ContractorName: "Rahul Mehta", AadharNumber: "1234 5678 9012",
    ContractorAddress: "House No. 12, Sector 62, Noida, Uttar Pradesh 201301",
    MonthlyCompensationAmount: previewRsAmount(monthlyCompensation), MonthlyCompensationWords: amountToWordsIndia(monthlyCompensation),
    BankAccountNumber: "0123456789012", BankName: "HDFC Bank", BankIFSC: "HDFC0001234", BankBranchName: "Sector 62, Noida",
    Services: Array.isArray(b.services) && b.services.length ? b.services : ["Technical Analysis", "Data Analysis", "QA", "Professional Services"],
  };
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="service-agreement-template-preview.pdf"`);
  renderServiceAgreementPdf({ dynamicFields, clauses: (b.clauses || []) as ServiceAgreementClause[], ...(await getHrSignature()) }, res);
});

// ---- MSA / SOW templates (US/Canada Vendor/Contractor engagements ONLY — GenAquarius LLC /
// Aquarius Technologies Limited) — same simple bodyText/{{placeholder}} shape as Offer templates.
// Not tied to countryCode/minCtc brackets like Offer templates: one row per Business Unit is
// enough since MSA/SOW terms don't vary by CTC band. See engine/hrPdf.ts's renderMsaSowPdf and
// routes/hrms/hrOffers.ts's renderMsaOrSowPdfBuffer. ----
router.get("/msa-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.msaTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/msa-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.msaTemplate.create({ data: { name: b.name, businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, entityName: b.entityName || "", entityAddress: b.entityAddress || null, governingLaw: b.governingLaw || "the State of California", bodyText: b.bodyText || "", isDefault: !!b.isDefault } }));
});
router.put("/msa-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.msaTemplate.update({ where: { id: Number(req.params.id) }, data: { name: b.name, entityName: b.entityName, entityAddress: b.entityAddress, governingLaw: b.governingLaw, bodyText: b.bodyText, isDefault: b.isDefault } }));
});
router.delete("/msa-templates/:id", async (req, res) => {
  await prisma.msaTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

router.get("/sow-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.sowTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { id: "asc" } }));
});
router.post("/sow-templates", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.sowTemplate.create({ data: { name: b.name, businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, entityName: b.entityName || "", entityAddress: b.entityAddress || null, bodyText: b.bodyText || "", isDefault: !!b.isDefault } }));
});
router.put("/sow-templates/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.sowTemplate.update({ where: { id: Number(req.params.id) }, data: { name: b.name, entityName: b.entityName, entityAddress: b.entityAddress, bodyText: b.bodyText, isDefault: b.isDefault } }));
});
router.delete("/sow-templates/:id", async (req, res) => {
  await prisma.sowTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// ✨ Advanced Builder live preview — same idea as offer-templates/preview-pdf: renders the
// in-progress bodyText (not yet saved) against a fake vendor/consultant/client, via the same
// renderMsaSowPdf() the real per-offer MSA/SOW PDF uses. Nothing is persisted.
function previewMsaOrSow(docType: "MSA" | "SOW", req: any, res: any) {
  const b = req.body || {};
  const entityName = b.entityName || "GenAquarius LLC";
  const vars = {
    EntityName: entityName, EntityAddress: b.entityAddress || "", GoverningLaw: docType === "MSA" ? (b.governingLaw || "the State of California") : "",
    VendorName: "Sample Staffing Inc", VendorEin: "12-3456789", VendorAddress: "123 Sample St, Sample City, ST 00000",
    EffectiveDate: new Date(), ConsultantName: "Jordan Sample", StartDate: new Date(Date.now() + 14 * 86400000), ClientName: "Sample End Client",
    HourlyRate: "USD 50/hr", EngagementDescription: "Sample Project — Time & Material (T&M) basis",
  };
  const body = fillTemplate(b.bodyText || "", vars);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${docType.toLowerCase()}-template-preview.pdf"`);
  renderMsaSowPdf({
    title: docType === "MSA" ? "MASTER SERVICES AGREEMENT" : "STATEMENT OF WORK",
    entityName, bodyText: body, counterpartyName: "Sample Staffing Inc",
  }, res);
}
router.post("/msa-templates/preview-pdf", (req, res) => previewMsaOrSow("MSA", req, res));
router.post("/sow-templates/preview-pdf", (req, res) => previewMsaOrSow("SOW", req, res));

// ---- Email templates (fixed keys: OFFER_EMAIL, APPOINTMENT_EMAIL, ...) ----
// `businessUnitId` (optional, tri-state): omitted = every row (used nowhere currently); "null"
// = only the company-wide default templates; a numeric id = only that BU's own overrides.
router.get("/email-templates", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  res.json(await prisma.hrEmailTemplate.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined }));
});
router.put("/email-templates/:key", async (req, res) => {
  const b = req.body;
  const businessUnitId = b.businessUnitId ? Number(b.businessUnitId) : null;
  const data = { subject: b.subject, body: b.body, signature: b.signature ?? null, showLogo: b.showLogo !== false };
  const existing = await prisma.hrEmailTemplate.findFirst({ where: { key: req.params.key, businessUnitId } });
  const row = existing
    ? await prisma.hrEmailTemplate.update({ where: { id: existing.id }, data })
    : await prisma.hrEmailTemplate.create({ data: { key: req.params.key, businessUnitId, subject: b.subject || "", body: b.body || "", signature: b.signature || null, showLogo: b.showLogo !== false } });
  res.json(row);
});
// Clones every company-wide default email template into a fresh set of rows for this BU.
router.post("/email-templates/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const defaults = await prisma.hrEmailTemplate.findMany({ where: { businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrEmailTemplate.create({ data: { key: d.key, businessUnitId, subject: d.subject, body: d.body, signature: d.signature, showLogo: d.showLogo } });
  }
  res.json({ cloned: defaults.length });
});

// ---- Employee Profile Fields (Additional Details) — HR-configurable catalog driving both the
// Employee Dashboard's self-service form and HR's review screen. Education/Family/Nomination are
// fixed repeating-list sections on the submission itself, not part of this flat catalog.
// Per-BU scoping: a BU with no rows of its own inherits the businessUnitId:null (India/company
// default) list entirely; once a BU has ANY row, it's a fully independent set — no merging with
// the default, same "once overridden, fully own it" semantics as every other HR config category. ----
export async function resolveProfileFieldsForBu(businessUnitId: number | null) {
  if (businessUnitId != null) {
    const own = await prisma.employeeProfileFieldConfig.findMany({ where: { businessUnitId }, orderBy: [{ section: "asc" }, { order: "asc" }] });
    if (own.length) return own;
  }
  return prisma.employeeProfileFieldConfig.findMany({ where: { businessUnitId: null }, orderBy: [{ section: "asc" }, { order: "asc" }] });
}
router.get("/profile-fields", async (req, res) => {
  res.json(await resolveProfileFieldsForBu(parseBuParam(req) ?? null));
});
router.post("/profile-fields", async (req, res) => {
  const b = req.body;
  if (!b.section || !b.key || !b.label || !b.fieldType) return res.status(400).json({ error: "section, key, label and fieldType are required." });
  const businessUnitId = b.businessUnitId ? Number(b.businessUnitId) : null;
  const row = await prisma.employeeProfileFieldConfig.create({ data: {
    section: b.section, key: b.key, label: b.label, fieldType: b.fieldType,
    options: Array.isArray(b.options) ? b.options : undefined,
    required: !!b.required, order: Number(b.order) || 0, enabled: b.enabled !== false, businessUnitId,
  } }).catch((e: any) => { throw e.code === "P2002" ? Object.assign(new Error(`A field with key "${b.key}" already exists.`), { status: 400 }) : e; });
  res.status(201).json(row);
});
router.put("/profile-fields/:id", async (req, res) => {
  const b = req.body;
  const row = await prisma.employeeProfileFieldConfig.update({
    where: { id: Number(req.params.id) },
    data: {
      section: b.section, label: b.label, fieldType: b.fieldType,
      options: b.options !== undefined ? (Array.isArray(b.options) ? b.options : null) : undefined,
      required: b.required != null ? !!b.required : undefined,
      order: b.order != null ? Number(b.order) : undefined,
      enabled: b.enabled != null ? !!b.enabled : undefined,
    },
  });
  res.json(row);
});
router.delete("/profile-fields/:id", async (req, res) => {
  await prisma.employeeProfileFieldConfig.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
// Clones every company-wide default profile field into a fresh, independent set of rows for this
// BU — same "clone to BU" convention as /email-templates/clone-to-bu above.
router.post("/profile-fields/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const defaults = await prisma.employeeProfileFieldConfig.findMany({ where: { businessUnitId: null } });
  for (const d of defaults) {
    await prisma.employeeProfileFieldConfig.create({ data: {
      section: d.section, key: d.key, label: d.label, fieldType: d.fieldType, options: d.options as any,
      required: d.required, order: d.order, enabled: d.enabled, businessUnitId,
    } });
  }
  res.json({ cloned: defaults.length });
});

export default router;
