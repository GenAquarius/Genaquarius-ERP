import { Router } from "express";
import { requireAdmin, requireRole, ADMIN_ROLES } from "../../auth/auth";
import { Role } from "@prisma/client";
import { getDashboard, getFinancePnl, getReceivables } from "../../engine/calc";

const router = Router();
// HR gets exactly one route below (hr-monthly-metrics) — everything else here stays admin-tier.
router.use((req, res, next) => (req.path === "/hr-monthly-metrics" ? next() : requireAdmin(req, res, next)));

// Same Monthly Metrics rows Finance sees, minus the financial columns (Salary Expense, Total
// Cost, Revenue, Monthly Profit, PGP) — stripped server-side, not just hidden in the client, so
// HR never receives that data over the wire at all. Roster drill-down (names/projects) stays.
router.get("/hr-monthly-metrics", requireRole(...ADMIN_ROLES, Role.HR), async (req, res) => {
  const fy = String(req.query.fy || "FY26-27");
  const month = String(req.query.month || "ALL");
  const full = await getFinancePnl(fy, month);
  const rows = (full.rows || []).map((r: any) => {
    const { salaryExpense, totalCost, revenue, monthlyProfit, netProfitPct, ...rest } = r;
    return rest;
  });
  res.json({ rows, rosterByMonth: full.rosterByMonth, months: full.months });
});

// CEO + Finance dashboards are admin-tier (CEO/CTO/Finance)
router.get("/ceo", requireAdmin, async (req, res) => {
  const fy = String(req.query.fy || "FY26-27");
  const month = String(req.query.month || "ALL");
  const [d, ar] = await Promise.all([getDashboard(fy, month), getReceivables()]);
  res.json({ ...d, month, receivables: ar });
});

router.get("/finance", requireAdmin, async (req, res) => {
  const fy = String(req.query.fy || "FY26-27");
  const month = String(req.query.month || "ALL");
  res.json(await getFinancePnl(fy, month));
});

router.get("/receivables", requireAdmin, async (_req, res) => {
  res.json(await getReceivables());
});

export default router;
