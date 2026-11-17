import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";

// F7 — Per-geography invoice email body + signature templates (US / Canada / India).
const router = Router();
router.use(requireAdmin);
router.use(requirePermission("invoice-templates")); // managed as a tab of the Invoice & Templates page

// Default US / Canada templates (exact text from deploy/EMAIL_TEMPLATES_F7.md).
const US_BODY = `Hi {{contactName}},

Hope you are doing good.

Please find attached GenAquarius LLC. invoice for the month of {{invoiceMonths}}.

Kindly acknowledge receipt of the invoice and do let us know if you have any questions.

Request to pay the attached invoice as per the bank details given in the invoice footer. Considering the enhanced cases of IT frauds, please ignore any change in bank account details unless it is communicated through email from Finance@GenAquarius.com.

We sincerely appreciate your continued business.`;
const US_SIGNATURE = `Thanks & Regards,
Accounts Receivable
Phone +1 416-571-3297
GenAquarius LLC
2795 E Bidwell St., Suite 100-662, Folsom, CA 95630`;

const CA_BODY = `Hi {{contactName}},

Hope you are doing good.

Please find attached Aquarius Technologies Limited invoice for the month of {{invoiceMonths}}.

Kindly acknowledge receipt of the invoice and do let us know if you have any questions.

Request to pay the attached invoice as per the bank details given in the invoice footer.

Considering the enhanced cases of IT frauds, please ignore any change in bank account details unless it is communicated through email from Finance@GenAquarius.com.

We sincerely appreciate your continued business.`;
const CA_SIGNATURE = `Thanks & Regards,
Accounts Receivable
Phone +1 416-571-3297
Aquarius Technologies Limited
5343 Dundas Street West,
Suite 601 Etobicoke ON M9B 6H8 Canada
Email: finance@genaquarius.com`;

const DEFAULTS = [
  { name: "GenAquarius LLC — US", geography: "US", entityName: "GenAquarius LLC", body: US_BODY, signature: US_SIGNATURE, showLogo: true, isDefault: true },
  { name: "Aquarius Technologies Limited — Canada", geography: "CANADA", entityName: "Aquarius Technologies Limited", body: CA_BODY, signature: CA_SIGNATURE, showLogo: true, isDefault: true },
];

const toData = (b: any) => ({
  name: String(b.name || "").trim(),
  geography: b.geography || "US",
  entityName: b.entityName ?? null,
  subject: b.subject ?? null,
  body: b.body ?? "",
  signature: b.signature ?? null,
  showLogo: b.showLogo !== false,
  isDefault: !!b.isDefault,
});

const projectIdsOf = (b: any): number[] =>
  Array.isArray(b?.projectIds) ? b.projectIds.map((id: any) => Number(id)).filter((n: number) => n > 0) : [];

// List all email templates (with the "Used By" projects for display).
router.get("/", async (_req, res) => {
  res.json(await prisma.emailTemplate.findMany({
    include: { projects: { select: { id: true, name: true } } },
    orderBy: [{ geography: "asc" }, { name: "asc" }],
  }));
});

// Create a template.
router.post("/", async (req, res) => {
  const d = toData(req.body);
  if (!d.name) return res.status(400).json({ error: "Template name is required" });
  const projectIds = projectIdsOf(req.body);
  res.json(await prisma.emailTemplate.create({
    data: { ...d, projects: { connect: projectIds.map((id) => ({ id })) } },
    include: { projects: { select: { id: true, name: true } } },
  }));
});

// Seed the default US + Canada templates (only adds those that don't already exist).
router.post("/seed-defaults", async (_req, res) => {
  const created: any[] = [];
  for (const d of DEFAULTS) {
    const exists = await prisma.emailTemplate.findFirst({ where: { geography: d.geography, isDefault: true } });
    if (exists) continue;
    created.push(await prisma.emailTemplate.create({ data: d }));
  }
  res.json({ ok: true, created: created.length, templates: created });
});

// Update a template.
router.put("/:id", async (req, res) => {
  const d = toData(req.body);
  if (!d.name) return res.status(400).json({ error: "Template name is required" });
  const projectIds = projectIdsOf(req.body);
  res.json(await prisma.emailTemplate.update({
    where: { id: Number(req.params.id) },
    data: { ...d, projects: { set: projectIds.map((id) => ({ id })) } },
    include: { projects: { select: { id: true, name: true } } },
  }));
});

// Delete a template.
router.delete("/:id", async (req, res) => {
  await prisma.emailTemplate.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

export default router;
