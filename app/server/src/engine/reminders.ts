// "You have a pending action" reminder emails — onboarding document checklist and PM/CTO-assigned
// timesheet nudges (see routes/ess.ts's /pending-actions, routes/timesheets.ts's /nudge/:employeeId).
// Cadence (how many times a day, and at what times) is configurable per flow from Administration →
// Notification Settings (TIMESHEET_REMINDER / ONBOARDING_DOC_REMINDER); index.ts ticks
// `reminderTick` every 15 minutes rather than once a day so multiple daily send times actually
// fire. ReminderLog's per-(employee, type, day, slot) dedup row keeps this safe against the app
// restarting or ticking more than once within the same slot.
import { prisma } from "../prisma";
import { notifyMail, isFlowEnabled } from "./notify";
import { itAdminEmails } from "./itAdmin";

const todayStr = () => new Date().toISOString().slice(0, 10);
const hhmmNow = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

async function alreadySentToday(employeeId: number, actionType: string, slot: string): Promise<boolean> {
  const row = await prisma.reminderLog.findUnique({ where: { employeeId_actionType_sentDate_slot: { employeeId, actionType, sentDate: todayStr(), slot } } });
  return !!row;
}
async function markSent(employeeId: number, actionType: string, slot: string) {
  await prisma.reminderLog.create({ data: { employeeId, actionType, sentDate: todayStr(), slot } }).catch(() => {});
}

const DEFAULT_REMINDER_TIMES = ["09:00"];

/** The configured send times ("HH:mm"[]) for a cadence flow, or the built-in default if unset. */
async function reminderTimesFor(flowKey: string): Promise<string[]> {
  const s = await prisma.notificationSetting.findUnique({ where: { flowKey } });
  const times = Array.isArray(s?.reminderTimes) ? (s!.reminderTimes as any[]).filter((t) => typeof t === "string") : null;
  return times && times.length ? times : DEFAULT_REMINDER_TIMES;
}

// Slack around the exact minute so a tick that lands a couple minutes late (or a 15-min tick vs a
// send time not on a 15-min boundary) still catches its slot exactly once per day.
function matchesSlot(times: string[], now: string): string | null {
  return times.find((t) => t === now) || null;
}

// How long after joining someone still counts as "onboarding" for this reminder's purposes. Without
// this bound, EVERY active employee company-wide (not just recent hires) got nagged daily forever —
// a long-tenured employee who never uploaded a document type that was only marked required AFTER
// they joined (or whose pre-launch/imported record never had it on file) shows as "pending" under
// the plain docTypes/EmployeeOnboardingDocument check below with no way to ever stop qualifying.
const ONBOARDING_REMINDER_WINDOW_DAYS = 60;

async function sendOnboardingReminders(slot: string) {
  const docTypes = await prisma.onboardingDocumentType.findMany({ where: { required: true } });
  if (!docTypes.length) return;
  const windowStart = new Date(Date.now() - ONBOARDING_REMINDER_WINDOW_DAYS * 86400000);
  const employees = await prisma.employee.findMany({ where: { exitDate: null, email: { not: null }, joiningDate: { gte: windowStart } } });
  for (const emp of employees) {
    const existing = await prisma.employeeOnboardingDocument.findMany({ where: { employeeId: emp.id } });
    const byType = new Map(existing.map((d) => [d.docTypeId, d]));
    const pending = docTypes.filter((t) => { const d = byType.get(t.id); return !d || d.status === "PENDING" || d.status === "REJECTED"; });
    if (!pending.length) continue;
    if (await alreadySentToday(emp.id, "ONBOARDING_DOCS", slot)) continue;
    try {
      const r = await notifyMail("ONBOARDING_DOC_REMINDER", {
        fromUpn: "hr@genaquarius.com", to: emp.email!,
        subject: "Action required: complete your onboarding documents",
        html: `Hi ${emp.name},<br><br>The following onboarding document(s) are still pending — please upload them in <b>My Profile → Onboarding Documents</b>:<br>${pending.map((p) => `• ${p.name}`).join("<br>")}<br><br>Regards,<br>GenAquarius HR`,
      });
      if (r.sent) await markSent(emp.id, "ONBOARDING_DOCS", slot);
    } catch { /* one bad recipient shouldn't block the rest */ }
  }
}

async function sendTimesheetNudgeReminders(slot: string) {
  const openActions = await prisma.employeeAction.findMany({ where: { type: "TIMESHEET", status: "OPEN" }, include: { employee: true } });
  for (const a of openActions) {
    if (!a.employee.email) continue;
    if (await alreadySentToday(a.employeeId, "TIMESHEET", slot)) continue;
    try {
      const r = await notifyMail("TIMESHEET_REMINDER", {
        fromUpn: "hr@genaquarius.com", to: a.employee.email,
        subject: "Action required: submit your timesheet",
        html: `Hi ${a.employee.name},<br><br>Please submit your timesheet for ${a.periodMonth}/${a.periodYear} — your Project Manager is waiting to review it.<br><br>Regards,<br>GenAquarius`,
      });
      if (r.sent) await markSent(a.employeeId, "TIMESHEET", slot);
    } catch { /* one bad recipient shouldn't block the rest */ }
  }
}

// Asset Collection — a ONE-TIME nudge (not a daily cadence like the two reminders above): the
// moment a PENDING task's Expected Collection Date has passed, email IT Admin once and stamp
// reminderSentAt so it's never resent for the same task, no matter how many times this tick runs.
// Goes to the IT/Network Admin role (itAdminEmails()), not the departed employee — same recipient
// convention as every other internal IT Admin notice in itAdmin.ts.
async function sendAssetCollectionReminders() {
  const overdue = await prisma.itAssetCollectionTask.findMany({
    where: { status: "PENDING", reminderSentAt: null, expectedDate: { lt: new Date() } },
    include: { employee: { select: { name: true, empNo: true } }, items: { include: { asset: { select: { assetTag: true, name: true } } } } },
  });
  if (!overdue.length) return;
  const recipients = await itAdminEmails();
  if (!recipients.length) return;
  for (const task of overdue) {
    const assetList = task.items.map((i) => `• ${i.asset.assetTag} — ${i.asset.name}`).join("<br>");
    const subject = `Overdue asset collection: ${task.employee.name} (${task.employee.empNo || ""})`;
    const html = `Hi,<br><br>The expected asset collection date for <b>${task.employee.name}</b> (${task.employee.empNo || ""}) has passed and the following asset(s) are still pending collection:<br>${assetList}<br><br>Please collect them and mark the task received in IT Admin → Offboarding.<br><br>Regards,<br>GenAquarius IT`;
    let anySent = false;
    for (const to of recipients) { try { const r = await notifyMail("ASSET_COLLECTION_REMINDER", { fromUpn: "it@genaquarius.com", to, subject, html }); if (r.sent) anySent = true; } catch { /* one bad recipient shouldn't block the rest */ } }
    if (anySent) await prisma.itAssetCollectionTask.update({ where: { id: task.id }, data: { reminderSentAt: new Date() } }).catch(() => {});
  }
}

/** Called every 15 minutes (see index.ts) — a no-op tick unless "now" matches a configured send time. */
export async function reminderTick() {
  const now = hhmmNow();
  if (await isFlowEnabled("ONBOARDING_DOC_REMINDER")) {
    const slot = matchesSlot(await reminderTimesFor("ONBOARDING_DOC_REMINDER"), now);
    if (slot) { try { await sendOnboardingReminders(slot); } catch (e) { console.error("Onboarding reminder job failed:", e); } }
  }
  if (await isFlowEnabled("TIMESHEET_REMINDER")) {
    const slot = matchesSlot(await reminderTimesFor("TIMESHEET_REMINDER"), now);
    if (slot) { try { await sendTimesheetNudgeReminders(slot); } catch (e) { console.error("Timesheet nudge reminder job failed:", e); } }
  }
  if (await isFlowEnabled("ASSET_COLLECTION_REMINDER")) {
    try { await sendAssetCollectionReminders(); } catch (e) { console.error("Asset collection reminder job failed:", e); }
  }
}
