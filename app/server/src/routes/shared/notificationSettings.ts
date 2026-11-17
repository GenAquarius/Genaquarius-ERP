// Administration → Notification Settings — per-flow email on/off, Finance+HR CC checkboxes, and
// reminder cadence (times/day) for the two cadence-capable flows. Same admin-tier gate as Module
// Access Matrix (permissions.ts), since this is a system-wide behavioral control, not owned by
// any one module.
import { Router } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../../prisma";
import { requireRole } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { NOTIFICATION_FLOWS } from "../../engine/notificationFlows";
import { defaultCcPool } from "../../engine/notify";

const router = Router();
router.use(requireRole(Role.CEO, Role.CTO));
router.use(requirePermission("notification-settings"));

router.get("/", async (_req, res) => {
  const [settings, ccPool] = await Promise.all([
    prisma.notificationSetting.findMany(),
    defaultCcPool(),
  ]);
  const byKey = new Map(settings.map((s) => [s.flowKey, s]));
  const flows = NOTIFICATION_FLOWS.map((f) => {
    const s = byKey.get(f.key);
    // A companyWide flow (broadcasts to the whole active employee population) defaults to OFF with
    // no row yet, not on — see isFlowEnabled's own comment in engine/notify.ts, which this mirrors.
    return {
      ...f,
      enabled: s ? s.enabled : !f.companyWide,
      ccExcludedUserIds: (Array.isArray(s?.ccExcludedUserIds) ? s!.ccExcludedUserIds : []) as number[],
      reminderTimes: (Array.isArray(s?.reminderTimes) ? s!.reminderTimes : null) as string[] | null,
    };
  });
  res.json({ flows, ccPool });
});

router.put("/:flowKey", async (req, res) => {
  const flowKey = req.params.flowKey;
  const def = NOTIFICATION_FLOWS.find((f) => f.key === flowKey);
  if (!def) return res.status(404).json({ error: "Unknown notification flow" });
  const b = req.body || {};
  const data: any = { updatedAt: new Date() };
  if (b.enabled !== undefined) data.enabled = !!b.enabled;
  if (b.ccExcludedUserIds !== undefined) data.ccExcludedUserIds = Array.isArray(b.ccExcludedUserIds) ? b.ccExcludedUserIds.map((n: any) => Number(n)) : [];
  if (b.reminderTimes !== undefined) data.reminderTimes = Array.isArray(b.reminderTimes) ? b.reminderTimes.filter((t: any) => /^\d{2}:\d{2}$/.test(t)) : null;
  // Same companyWide-defaults-off rule as the GET route — saving CC/cadence details on a flow with
  // no row yet (e.g. setting reminder times before ever toggling it) must not silently turn it on.
  const setting = await prisma.notificationSetting.upsert({
    where: { flowKey },
    update: data,
    create: { flowKey, enabled: b.enabled !== undefined ? !!b.enabled : !def.companyWide, ccExcludedUserIds: data.ccExcludedUserIds ?? [], reminderTimes: data.reminderTimes ?? null },
  });
  res.json(setting);
});

export default router;
