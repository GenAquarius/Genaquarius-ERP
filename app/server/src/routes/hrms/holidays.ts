import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { fiscalOfDate, recomputeMonthCountry } from "../../engine/workdays";

const router = Router();
router.use(requireAdmin); // holiday calendar is admin-tier only
router.use(requirePermission("holidays"));

// Recompute the billable rows affected by a holiday change (its month + country). Always
// recomputes the WHOLE country regardless of whether the changed holiday was a Company Default
// or a specific Business Unit's own override — every line picks up its own employee's correct
// effective calendar (see engine/workdays.ts's recomputeMonthCountry doc comment).
async function reflow(date: Date, country: string): Promise<number> {
  const f = fiscalOfDate(date);
  return recomputeMonthCountry(f.fiscalYear, f.monthIndex, country);
}
// Tri-state Business Unit filter, same convention as hrSettings.ts/leavePolicy.ts: omitted =
// every row (used nowhere currently); "null" = only Company Default rows; a numeric id = only
// that BU's own calendar.
function parseBuParam(req: any): number | null | undefined {
  const raw = req.query.businessUnitId;
  if (raw === undefined) return undefined;
  if (raw === "null") return null;
  return Number(raw);
}

router.get("/", requireAdmin, async (req, res) => {
  const where: any = {};
  if (req.query.country) where.country = String(req.query.country).toUpperCase();
  const businessUnitId = parseBuParam(req);
  if (businessUnitId !== undefined) where.businessUnitId = businessUnitId;
  res.json(await prisma.holiday.findMany({ where, orderBy: { date: "asc" } }));
});

router.post("/", requireAdmin, async (req, res) => {
  const b = req.body;
  if (!b.country || !b.date || !b.name) return res.status(400).json({ error: "Country, date and name are required" });
  const country = String(b.country).toUpperCase();
  const date = new Date(b.date);
  const businessUnitId = b.businessUnitId ? Number(b.businessUnitId) : null;
  const holiday = await prisma.holiday.create({ data: { country, date, name: b.name, businessUnitId } });
  const recomputed = await reflow(date, country); // update existing Monthly Forecast rows
  res.status(201).json({ ...holiday, recomputed });
});

router.put("/:id", requireAdmin, async (req, res) => {
  const b = req.body;
  const before = await prisma.holiday.findUnique({ where: { id: Number(req.params.id) } });
  const holiday = await prisma.holiday.update({ where: { id: Number(req.params.id) }, data: {
    country: b.country ? String(b.country).toUpperCase() : undefined,
    date: b.date ? new Date(b.date) : undefined,
    name: b.name,
  } });
  let recomputed = await reflow(holiday.date, holiday.country);
  // If the date/country moved, recompute the previous month/country too.
  if (before && (before.country !== holiday.country || +new Date(before.date) !== +new Date(holiday.date)))
    recomputed += await reflow(new Date(before.date), before.country);
  res.json({ ...holiday, recomputed });
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const h = await prisma.holiday.findUnique({ where: { id: Number(req.params.id) } });
  await prisma.holiday.delete({ where: { id: Number(req.params.id) } });
  const recomputed = h ? await reflow(new Date(h.date), h.country) : 0;
  res.json({ ok: true, recomputed });
});

// Clones every Company-Default holiday for the given country into a fresh set of rows scoped
// to this Business Unit — same "start from what already works" pattern every other BU-scoped
// category uses. Recomputes the country's forecast afterward since the new rows can change it.
router.post("/clone-to-bu", requireAdmin, async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const country = String(req.body.country || "").toUpperCase();
  if (!country) return res.status(400).json({ error: "country is required" });
  const defaults = await prisma.holiday.findMany({ where: { country, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.holiday.create({ data: { country, businessUnitId, date: d.date, name: d.name } });
  }
  let recomputed = 0;
  for (const d of defaults) recomputed += await reflow(d.date, country);
  res.json({ cloned: defaults.length, recomputed });
});

export default router;
