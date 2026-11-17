// Leave Policy config (HR Admin Settings) — leave types per country, the global sandwich-rule
// /probation/comp-off/encashment knobs, and the onboarding-document checklist definition.
// Same tier as hrSettings.ts: HR, CEO, CTO, FINANCE (HR_SETTINGS_ROLES).
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole, HR_SETTINGS_ROLES } from "../../auth/auth";
import { runYearEndRollover } from "../../engine/leave";
import { buFirst, buRows } from "../../engine/hr";

const router = Router();
router.use(requireRole(...HR_SETTINGS_ROLES));

// ---- Leave types ----
// `businessUnitId` (optional): a BU with its own leave-type rows sees only those; a BU with none
// yet falls back to the Country default list (same rule as every other BU-scoped category).
router.get("/leave-types", async (req, res) => {
  const countryCode = String(req.query.countryCode || "INDIA");
  const businessUnitId = req.query.businessUnitId ? Number(req.query.businessUnitId) : null;
  res.json(await buRows(businessUnitId, (bu) => prisma.hrLeaveType.findMany({ where: { countryCode, ...bu }, orderBy: { order: "asc" } })));
});
router.post("/leave-types", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.hrLeaveType.create({
    data: {
      countryCode: b.countryCode || "INDIA", businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, key: b.key, name: b.name,
      accrualPerMonth: Number(b.accrualPerMonth) || 0,
      annualQuota: b.annualQuota === "" || b.annualQuota == null ? null : Number(b.annualQuota),
      maxCarryForward: b.maxCarryForward === "" || b.maxCarryForward == null ? null : Number(b.maxCarryForward),
      maxApplyPerYear: b.maxApplyPerYear === "" || b.maxApplyPerYear == null ? null : Number(b.maxApplyPerYear),
      maxConsecutiveDays: b.maxConsecutiveDays === "" || b.maxConsecutiveDays == null ? null : Number(b.maxConsecutiveDays),
      requiresProbationComplete: !!b.requiresProbationComplete,
      lapsesAtYearEnd: !!b.lapsesAtYearEnd,
      sandwichEligible: !!b.sandwichEligible,
      order: Number(b.order) || 0,
    },
  }));
});
router.put("/leave-types/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.hrLeaveType.update({
    where: { id: Number(req.params.id) },
    data: {
      name: b.name,
      accrualPerMonth: b.accrualPerMonth != null ? Number(b.accrualPerMonth) : undefined,
      annualQuota: b.annualQuota === "" ? null : (b.annualQuota != null ? Number(b.annualQuota) : undefined),
      maxCarryForward: b.maxCarryForward === "" ? null : (b.maxCarryForward != null ? Number(b.maxCarryForward) : undefined),
      maxApplyPerYear: b.maxApplyPerYear === "" ? null : (b.maxApplyPerYear != null ? Number(b.maxApplyPerYear) : undefined),
      maxConsecutiveDays: b.maxConsecutiveDays === "" ? null : (b.maxConsecutiveDays != null ? Number(b.maxConsecutiveDays) : undefined),
      requiresProbationComplete: b.requiresProbationComplete != null ? !!b.requiresProbationComplete : undefined,
      lapsesAtYearEnd: b.lapsesAtYearEnd != null ? !!b.lapsesAtYearEnd : undefined,
      sandwichEligible: b.sandwichEligible != null ? !!b.sandwichEligible : undefined,
      order: b.order != null ? Number(b.order) : undefined,
    },
  }));
});
router.delete("/leave-types/:id", async (req, res) => {
  await prisma.hrLeaveType.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
// Clones every Country-default leave type for the given country into a fresh set of rows
// scoped to this Business Unit — same "start from what already works" pattern hrSettings.ts's
// CTC/Tax/Template categories use. Keyed by countryCode (not the BU's own country) since this
// tab lets HR view/edit any country's leave types independent of which BU is selected.
router.post("/leave-types/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const countryCode = String(req.body.countryCode || "INDIA");
  const defaults = await prisma.hrLeaveType.findMany({ where: { countryCode, businessUnitId: null } });
  for (const d of defaults) {
    await prisma.hrLeaveType.create({ data: {
      countryCode, businessUnitId, key: d.key, name: d.name, accrualPerMonth: d.accrualPerMonth, annualQuota: d.annualQuota,
      maxCarryForward: d.maxCarryForward, maxApplyPerYear: d.maxApplyPerYear, maxConsecutiveDays: d.maxConsecutiveDays,
      requiresProbationComplete: d.requiresProbationComplete, lapsesAtYearEnd: d.lapsesAtYearEnd, sandwichEligible: d.sandwichEligible, order: d.order,
    } });
  }
  res.json({ cloned: defaults.length });
});

// ---- Global policy config (sandwich rule, probation, comp-off expiry, EL encashment) ----
// `businessUnitId` query/body param (optional): omitted/null reads or writes the Country-level
// default; a real id reads or writes that Business Unit's own override (GET falls back to the
// Country default if the BU hasn't got one yet — same rule as every other BU-scoped category).
router.get("/policy-config", async (req, res) => {
  const countryCode = String(req.query.countryCode || "INDIA");
  const businessUnitId = req.query.businessUnitId ? Number(req.query.businessUnitId) : null;
  const cfg = await buFirst(businessUnitId, (bu) => prisma.hrLeavePolicyConfig.findFirst({ where: { countryCode, ...bu } }));
  res.json(cfg || { countryCode, businessUnitId, sandwichEnabled: false, sandwichDays: 4, probationDays: 90, elEncashmentCapDays: 30, elEncashmentRatePerDay: 2000, compOffExpiryDays: 30 });
});
router.put("/policy-config", async (req, res) => {
  const b = req.body;
  const countryCode = b.countryCode || "INDIA";
  const businessUnitId = b.businessUnitId ? Number(b.businessUnitId) : null;
  const data = {
    sandwichEnabled: b.sandwichEnabled != null ? !!b.sandwichEnabled : undefined,
    sandwichDays: b.sandwichDays != null ? Number(b.sandwichDays) : undefined,
    probationDays: b.probationDays != null ? Number(b.probationDays) : undefined,
    elEncashmentCapDays: b.elEncashmentCapDays != null ? Number(b.elEncashmentCapDays) : undefined,
    elEncashmentRatePerDay: b.elEncashmentRatePerDay != null ? Number(b.elEncashmentRatePerDay) : undefined,
    compOffExpiryDays: b.compOffExpiryDays != null ? Number(b.compOffExpiryDays) : undefined,
  };
  // Prisma's compound-unique WHERE rejects a `null` businessUnitId at RUNTIME (not just the
  // type level) — findFirst-then-create/update sidesteps it, same pattern used throughout
  // seedHr.ts/seedLeave.ts for the same reason.
  const existing = await prisma.hrLeavePolicyConfig.findFirst({ where: { countryCode, businessUnitId } });
  const cfg = existing
    ? await prisma.hrLeavePolicyConfig.update({ where: { id: existing.id }, data })
    : await prisma.hrLeavePolicyConfig.create({ data: { countryCode, businessUnitId, sandwichEnabled: !!b.sandwichEnabled, sandwichDays: Number(b.sandwichDays) || 4, probationDays: Number(b.probationDays) || 90, elEncashmentCapDays: Number(b.elEncashmentCapDays) || 30, elEncashmentRatePerDay: Number(b.elEncashmentRatePerDay) || 2000, compOffExpiryDays: Number(b.compOffExpiryDays) || 30 } });
  res.json(cfg);
});

// ---- Year-end rollover (manual trigger — no cron infra in this repo beyond audit rotation) ----
router.post("/year-end-rollover", async (req, res) => {
  const year = Number(req.body.year) || new Date().getFullYear();
  const countryCode = req.body.countryCode || "INDIA";
  res.json(await runYearEndRollover(year, countryCode));
});

// ---- Onboarding document checklist (types) ----
// `businessUnitId` (optional, tri-state like hrSettings.ts's parseBuParam): omitted = the
// original global list (used by GenerateOffer's checklist selector, unfiltered); "null" =
// only the global-default rows; a numeric id = only that BU's own checklist rows.
function parseBuParam(req: any): number | null | undefined {
  const raw = req.query.businessUnitId;
  if (raw === undefined) return undefined;
  if (raw === "null") return null;
  return Number(raw);
}
router.get("/onboarding-doc-types", async (req, res) => {
  const businessUnitId = parseBuParam(req);
  // `fallback=1` (Generate Offer's "List of Joining Documents", the actual candidate checklist) —
  // a BU with its own cloned rows uses only those (its override); no BU / a BU that never cloned
  // falls back to the global default rows. Never merges every BU's rows together, which used to
  // show each document name once per BU that had cloned its own copy ("duplicated entries" bug).
  // The plain (non-fallback) mode is unchanged — HR Settings' admin checklist editor relies on
  // seeing a genuinely EMPTY list for a BU that hasn't cloned yet, to show its "Clone from
  // Defaults" banner; falling back there would silently show/edit the global rows instead.
  if (req.query.fallback === "1") {
    if (businessUnitId) {
      const own = await prisma.onboardingDocumentType.findMany({ where: { businessUnitId }, orderBy: { order: "asc" } });
      if (own.length) return res.json(own);
    }
    return res.json(await prisma.onboardingDocumentType.findMany({ where: { businessUnitId: null }, orderBy: { order: "asc" } }));
  }
  res.json(await prisma.onboardingDocumentType.findMany({ where: businessUnitId !== undefined ? { businessUnitId } : undefined, orderBy: { order: "asc" } }));
});
router.post("/onboarding-doc-types", async (req, res) => {
  const b = req.body;
  res.status(201).json(await prisma.onboardingDocumentType.create({ data: { name: b.name, businessUnitId: b.businessUnitId ? Number(b.businessUnitId) : null, required: b.required !== false, order: Number(b.order) || 0 } }));
});
router.put("/onboarding-doc-types/:id", async (req, res) => {
  const b = req.body;
  res.json(await prisma.onboardingDocumentType.update({ where: { id: Number(req.params.id) }, data: { name: b.name, required: b.required != null ? !!b.required : undefined, order: b.order != null ? Number(b.order) : undefined } }));
});
router.delete("/onboarding-doc-types/:id", async (req, res) => {
  await prisma.onboardingDocumentType.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});
// No countryCode on this model (it was never country-scoped) — clone every global-default row
// (businessUnitId null) into a fresh set for this Business Unit.
router.post("/onboarding-doc-types/clone-to-bu", async (req, res) => {
  const businessUnitId = Number(req.body.businessUnitId);
  const bu = await prisma.hrBusinessUnit.findUnique({ where: { id: businessUnitId } });
  if (!bu) return res.status(404).json({ error: "Business Unit not found" });
  const defaults = await prisma.onboardingDocumentType.findMany({ where: { businessUnitId: null } });
  for (const d of defaults) {
    await prisma.onboardingDocumentType.create({ data: { name: d.name, businessUnitId, required: d.required, order: d.order } });
  }
  res.json({ cloned: defaults.length });
});

export default router;
