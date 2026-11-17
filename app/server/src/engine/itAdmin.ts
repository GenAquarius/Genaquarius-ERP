// IT Admin recipients — every "notify IT" email in the app (new-hire provisioning, O365
// disable-on-exit) goes to whoever currently holds the IT_ADMIN role, replacing the old
// free-text SYSTEM_SETTINGS.itAdminEmail setting. Anyone can be assigned/unassigned via
// Users & Roles at any time with no further config needed.
import { prisma } from "../prisma";

export async function itAdminEmails(): Promise<string[]> {
  const rows = await prisma.user.findMany({ where: { role: "IT_ADMIN", isActive: true }, select: { email: true } });
  return rows.map((r) => r.email);
}
