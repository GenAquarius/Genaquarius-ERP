import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { renderInvoicePdf, normalizeLayout, DEFAULT_LAYOUT } from "../../engine/invoicePdf";

const router = Router();
router.use(requireAdmin);
router.use(requirePermission("invoice-templates")); // designer lives as a tab of the Invoice & Templates page

const parse = (s: any) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
// Saved configs are normalized on the way out (even Y pitch, one width + alignment per column) so the
// designer canvas shows the same tidy block the PDF renders — older layouts stored cramped positions.
const tidy = (c: any) => (c && Array.isArray(c.headerFields) ? normalizeLayout(c) : c);
const withParsed = (l: any) => ({ ...l, config: tidy(parse(l.config)) });

// The built-in default layout — the designer seeds a new template from this.
router.get("/default", (_req, res) => res.json(DEFAULT_LAYOUT));

router.get("/", async (_req, res) => {
  const rows = await prisma.invoiceLayout.findMany({ include: { projects: { select: { id: true, name: true } } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  res.json(rows.map(withParsed));
});

router.get("/:id", async (req, res) => {
  const l = await prisma.invoiceLayout.findUnique({ where: { id: Number(req.params.id) }, include: { projects: { select: { id: true, name: true } } } });
  if (!l) return res.status(404).json({ error: "Not found" });
  res.json(withParsed(l));
});

router.post("/", async (req, res) => {
  const b = req.body || {};
  if (b.isDefault) await prisma.invoiceLayout.updateMany({ data: { isDefault: false } }); // only one default
  const l = await prisma.invoiceLayout.create({
    data: { name: String(b.name || "Layout").trim(), isDefault: !!b.isDefault, config: JSON.stringify(b.config || DEFAULT_LAYOUT) },
  });
  if (Array.isArray(b.projectIds)) await prisma.project.updateMany({ where: { id: { in: b.projectIds.map(Number) } }, data: { invoiceLayoutId: l.id } });
  res.status(201).json(withParsed(l));
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (b.isDefault) await prisma.invoiceLayout.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
  const l = await prisma.invoiceLayout.update({
    where: { id },
    data: {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      isDefault: b.isDefault !== undefined ? !!b.isDefault : undefined,
      config: b.config !== undefined ? JSON.stringify(b.config) : undefined,
    },
  });
  // Re-assign projects (clear ones no longer selected, set the chosen ones to this layout).
  if (Array.isArray(b.projectIds)) {
    await prisma.project.updateMany({ where: { invoiceLayoutId: id, id: { notIn: b.projectIds.map(Number) } }, data: { invoiceLayoutId: null } });
    await prisma.project.updateMany({ where: { id: { in: b.projectIds.map(Number) } }, data: { invoiceLayoutId: id } });
  }
  res.json(withParsed(l));
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await prisma.project.updateMany({ where: { invoiceLayoutId: id }, data: { invoiceLayoutId: null } });
  await prisma.invoiceLayout.delete({ where: { id } });
  res.json({ ok: true });
});

// Render a SAMPLE invoice with the supplied (in-progress) config — for the designer's live preview.
router.post("/preview", async (req, res) => {
  const config = req.body?.config || DEFAULT_LAYOUT;
  const d = new Date();
  const sample = {
    invoiceNo: "GA/2026/SAMPLE-Apr", invoiceDate: d, dueDate: d,
    billingPeriodStart: new Date(Date.UTC(2026, 3, 1)), billingPeriodEnd: new Date(Date.UTC(2026, 3, 30)),
    projectTitle: "Sample Project", projectCode: "SMP-01", poNumber: "PO-12345", customerRefNo: "CR-9988",
    projectDescription: "Professional Services", currency: "USD", totalAmount: 12000,
    addressTo: "AP Team", attentionContact: "Jane Doe", billToAddress: "123 Client Street\nFolsom, CA 95630", billingEmail: "ap@client.com",
    client: { name: "Sample Client Inc.", logo: null },
    template: { issuerBlock: { company: "GenAquarius LLC", addressLines: ["2795 E Bidwell St.", "Suite 100, Folsom, CA 95630"], website: "www.GenAquarius.com", contact: "finance@genaquarius.com" }, bankDetails: { terms: "Net 30 Days", lines: ["Bank Name: Sample Bank", "Account #: 1234567890", "SWIFT/BIC: SMPLUS33"] } },
    lineItems: [{ description: "IT Services", rateUsd: 50, hours: 160, amount: 8000 }, { description: "IT Services", rateUsd: 40, hours: 100, amount: 4000 }],
    annexure: [{ resourceName: "A. Sharma", leave: "1", billRate: 50, hours: 160, amount: 8000 }, { resourceName: "B. Gupta", leave: "0", billRate: 40, hours: 100, amount: 4000 }],
  };
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="layout-preview.pdf"`);
  renderInvoicePdf(sample, res, config);
});

export default router;
