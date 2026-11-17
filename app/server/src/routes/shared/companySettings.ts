// Company Settings -> Date & Time Format. One company-wide choice, readable by any logged-in
// user (every screen needs it to render dates), changeable only by an admin. See
// engine/dateFormat.ts for the format registry and the in-process cache this writes through to.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { DATE_FORMATS, TIME_FORMATS, DateFormatKey, TimeFormatKey, getDateTimeFormatSetting, setDateTimeFormatCache } from "../../engine/dateFormat";

const router = Router();

router.get("/company-settings/date-time-format", async (_req, res) => {
  const current = getDateTimeFormatSetting();
  res.json({
    ...current,
    dateFormatOptions: Object.entries(DATE_FORMATS).map(([key, v]) => ({ key, label: v.label })),
    timeFormatOptions: Object.entries(TIME_FORMATS).map(([key, v]) => ({ key, label: v.label })),
  });
});

router.put("/company-settings/date-time-format", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!DATE_FORMATS[b.dateFormat as DateFormatKey]) return res.status(400).json({ error: "Unknown date format." });
  if (!TIME_FORMATS[b.timeFormat as TimeFormatKey]) return res.status(400).json({ error: "Unknown time format." });
  await prisma.companyDateTimeSetting.upsert({
    where: { id: 1 },
    update: { dateFormat: b.dateFormat, timeFormat: b.timeFormat, updatedById: req.user!.id },
    create: { id: 1, dateFormat: b.dateFormat, timeFormat: b.timeFormat, updatedById: req.user!.id },
  });
  setDateTimeFormatCache(b.dateFormat, b.timeFormat);
  res.json(getDateTimeFormatSetting());
});

export default router;
