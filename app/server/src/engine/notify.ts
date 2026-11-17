// Single choke point every notification email in the app goes through — Administration →
// Notification Settings' per-flow enable/disable and Finance+HR CC list are enforced here, not at
// each of the ~24 call sites, so callers just swap `sendMail(...)` for `notifyMail(flowKey, ...)`.
import { prisma } from "../prisma";
import { sendMail, mailEnabled, SendMailArgs } from "./mailer";
import { NOTIFICATION_FLOW_BY_KEY } from "./notificationFlows";
import { Role } from "@prisma/client";

const CC_POOL_ROLES = [Role.FINANCE, Role.HR];

/** Everyone currently in Finance or HR — live, not a snapshot, so new hires are auto-included. */
export async function defaultCcPool(): Promise<{ id: number; name: string; email: string; role: string }[]> {
  return prisma.user.findMany({ where: { role: { in: CC_POOL_ROLES }, isActive: true }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: "asc" } });
}

async function resolveSetting(flowKey: string) {
  return prisma.notificationSetting.findUnique({ where: { flowKey } });
}

/** Whether a flow is currently enabled. Default is true (no row = never turned off) for an ordinary
 *  flow — but a `companyWide` flow (see its own comment in notificationFlows.ts) defaults to FALSE
 *  until an admin explicitly opts in from Notification Settings, since it broadcasts to the whole
 *  active employee population rather than one specific recipient. */
export async function isFlowEnabled(flowKey: string): Promise<boolean> {
  const s = await resolveSetting(flowKey);
  if (s) return s.enabled;
  return !NOTIFICATION_FLOW_BY_KEY.get(flowKey)?.companyWide;
}

async function ccListFor(flowKey: string): Promise<string[]> {
  const def = NOTIFICATION_FLOW_BY_KEY.get(flowKey);
  if (!def?.hasCc) return [];
  const [pool, setting] = await Promise.all([defaultCcPool(), resolveSetting(flowKey)]);
  const excluded = new Set<number>(Array.isArray(setting?.ccExcludedUserIds) ? (setting!.ccExcludedUserIds as any[]) : []);
  return pool.filter((u) => !excluded.has(u.id)).map((u) => u.email);
}

export type NotifyResult = { sent: boolean; reason?: string };

/**
 * Send a flow-gated email. Returns {sent:false, reason:"disabled"} without throwing when the flow
 * is turned off in Notification Settings — callers treat that exactly like "mail not configured"
 * (already a normal, non-fatal outcome throughout this codebase).
 */
export async function notifyMail(flowKey: string, args: Omit<SendMailArgs, "cc">): Promise<NotifyResult> {
  if (!(await isFlowEnabled(flowKey))) return { sent: false, reason: "disabled" };
  if (!mailEnabled()) return { sent: false, reason: "Email not configured (Microsoft Graph)" };
  const cc = await ccListFor(flowKey);
  await sendMail({ ...args, cc });
  return { sent: true };
}
