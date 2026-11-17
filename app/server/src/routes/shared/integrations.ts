import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { getReceivables } from "../../engine/calc";

const router = Router();
router.use(requireAdmin); // integrations are admin-tier only
router.use(requirePermission("integrations"));

const redact = (cfg: any) => {
  if (!cfg || typeof cfg !== "object") return cfg;
  const out: any = { ...cfg };
  for (const k of ["apiKey", "secret", "password", "token", "accessToken", "refreshToken"]) if (k in out) out[k] = "••••••";
  return out;
};

// List provider integrations. ANTHROPIC (the Claude API key) is managed on the
// Settings → AI Report panel, not here, and its stored key must never be returned —
// so we exclude it and redact any secret fields from the remaining rows.
router.get("/", requireAdmin, async (_req, res) => {
  // ADOBE_SIGN has its own dedicated settings UI (Client ID/Secret), not this generic table.
  const rows = await prisma.integration.findMany({ where: { provider: { notIn: ["ANTHROPIC", "ADOBE_SIGN", "SYSTEM_SETTINGS"] } } });
  res.json(rows.map((r) => ({ ...r, authConfig: redact(r.authConfig) })));
});

// Connect / store auth config for a provider (TALLY | BOA | ADOBE_SIGN | ...). A redacted field
// ("••••••", from GET's own redaction above) left untouched in the client's form is round-tripped
// back here — swap it for the real stored value instead of overwriting the secret with dots.
// Existing fields the client's form never sends at all (e.g. Adobe Sign's accessToken/
// refreshToken, written directly by the OAuth callback rather than through this form) are merged
// in underneath the submitted fields, not dropped — a partial save from one settings form must
// never silently erase state another part of the app maintains on this same JSON blob.
router.put("/:provider", requireAdmin, async (req, res) => {
  const provider = req.params.provider.toUpperCase();
  const ex = await prisma.integration.findUnique({ where: { provider } });
  let authConfig = req.body.authConfig ?? ex?.authConfig;
  if (authConfig && typeof authConfig === "object" && ex?.authConfig && typeof ex.authConfig === "object") {
    const merged: any = { ...(ex.authConfig as any), ...authConfig };
    for (const k of Object.keys(authConfig)) {
      if (authConfig[k] === "••••••" && (ex.authConfig as any)[k] !== undefined) merged[k] = (ex.authConfig as any)[k];
    }
    authConfig = merged;
  }
  // Preserve the existing status when the caller doesn't explicitly send one (e.g. a partial
  // save of just a couple of authConfig fields) — defaulting to "CONNECTED" here would silently
  // resurrect a status a more authoritative flow (like Adobe Sign's OAuth callback) had
  // deliberately set to DISCONNECTED.
  const data = { authConfig, status: req.body.status ?? ex?.status ?? "CONNECTED" };
  const integ = ex
    ? await prisma.integration.update({ where: { provider }, data })
    : await prisma.integration.create({ data: { provider, ...data } });
  res.json(integ);
});

/**
 * Sync from a provider. Real adapters call the Tally / BoA APIs; here the
 * adapter interface is in place and records land in ExternalLedger. Returns the
 * refreshed receivables/cash picture used by the CEO dashboard.
 */
router.post("/:provider/sync", requireAdmin, async (req, res) => {
  const provider = req.params.provider.toUpperCase();
  await prisma.integration.update({ where: { provider }, data: { lastSyncAt: new Date(), status: "CONNECTED" } }).catch(() => {});
  // adapter would push fetched rows into ExternalLedger here
  // getReceivables() is short-TTL cached for dashboard load speed (see engine/calc.ts) — a manual
  // Sync must always reflect what was just synced, never a stale cache hit.
  getReceivables.invalidate();
  res.json({ provider, syncedAt: new Date(), receivables: await getReceivables() });
});

router.get("/reconciliation", requireAdmin, async (_req, res) => {
  const [ledger, invoices] = await Promise.all([
    prisma.externalLedger.findMany(),
    prisma.invoice.findMany({ include: { client: true } }),
  ]);
  res.json({ ledger, invoices });
});

// Single provider (e.g. ADOBE_SIGN, which has its own dedicated settings UI outside the
// generic list above). Registered after the named routes above so it can't shadow them.
router.get("/:provider", requireAdmin, async (req, res) => {
  const provider = req.params.provider.toUpperCase();
  const integ = await prisma.integration.findUnique({ where: { provider } });
  res.json(integ ? { ...integ, authConfig: redact(integ.authConfig) } : { provider, status: "DISCONNECTED" });
});

export default router;
