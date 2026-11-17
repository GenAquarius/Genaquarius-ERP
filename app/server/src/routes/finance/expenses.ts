import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";

const router = Router();
router.use(requireAdmin); // expenses are admin-tier only
router.use(requirePermission("expenses"));

router.get("/", requireAdmin, async (req, res) => {
  const where: any = {};
  if (req.query.fy) where.fiscalYear = String(req.query.fy);
  res.json(await prisma.expense.findMany({ where, orderBy: { createdAt: "desc" } }));
});

router.post("/", requireAdmin, async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.expense.create({ data: {
    scope: b.scope, category: b.category, vendorName: b.vendorName,
    amount: +b.amount || 0, currency: b.currency || "INR",
    fiscalYear: b.fiscalYear, month: b.month, recurring: !!b.recurring, note: b.note,
  } }));
});

router.put("/:id", requireAdmin, async (req, res) => {
  const b = req.body;
  res.json(await prisma.expense.update({ where: { id: Number(req.params.id) }, data: {
    scope: b.scope, category: b.category, vendorName: b.vendorName,
    amount: b.amount != null ? +b.amount : undefined, currency: b.currency,
    recurring: b.recurring, note: b.note,
  } }));
});

router.delete("/:id", requireAdmin, async (req, res) => {
  await prisma.expense.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

export default router;
