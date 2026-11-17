// Settings + OAuth connect flow for engine/graphAdmin.ts's automated O365 provisioning — mounted
// at /api/graph-admin. IT_ADMIN (plus the usual admin tiers) can connect their own Microsoft
// account and configure which license SKU gets auto-assigned; the actual mailbox creation itself
// happens from routes/itsm/itAdmin.ts's Approve action, not here.
import { Router } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { config } from "../../config";
import { requireRole, ADMIN_ROLES } from "../../auth/auth";
import { buildGraphAdminAuthorizeUrl, exchangeGraphAdminCode, getGraphAdminConfig, setGraphAdminSettings, listAvailableLicenseSkus } from "../../engine/graphAdmin";

const router = Router();
const IT_ADMIN_ROLES = [Role.IT_ADMIN, ...ADMIN_ROLES];
router.use(requireRole(...IT_ADMIN_ROLES));

// Signed, short-lived `state` doubles as CSRF protection — same pattern as Adobe Sign's own connect
// flow (routes/shared/adobeSign.ts).
router.get("/oauth/authorize", (req, res) => {
  const state = jwt.sign({ uid: req.user!.id }, config.jwtSecret, { expiresIn: "10m" });
  res.redirect(buildGraphAdminAuthorizeUrl(state));
});

router.get("/oauth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  const fail = (msg: string) => res.redirect(`${config.clientOrigin}/it-admin?graphAdminError=${encodeURIComponent(msg)}`);
  if (error) return fail(error_description || error);
  if (!code || !state) return fail("Missing code/state from Microsoft");
  try { jwt.verify(state, config.jwtSecret); } catch { return fail("Expired or invalid OAuth state — try connecting again"); }
  try {
    const { upn } = await exchangeGraphAdminCode(code);
    res.redirect(`${config.clientOrigin}/it-admin?graphAdminConnected=${encodeURIComponent(upn)}`);
  } catch (e: any) { fail(e.message || "Token exchange failed"); }
});

router.get("/status", async (_req, res) => {
  const cfg = await getGraphAdminConfig();
  res.json({
    connected: cfg.status === "CONNECTED" && !!cfg.accessToken,
    connectedByUpn: cfg.connectedByUpn, connectedAt: cfg.connectedAt,
    enabled: cfg.enabled, licenseSkuIds: cfg.licenseSkuIds, licenseSkuPartNumbers: cfg.licenseSkuPartNumbers,
    lastError: cfg.lastError,
  });
});

router.put("/settings", async (req, res) => {
  const { enabled, licenseSkuIds, licenseSkuPartNumbers } = req.body || {};
  await setGraphAdminSettings({
    enabled: !!enabled,
    licenseSkuIds: Array.isArray(licenseSkuIds) ? licenseSkuIds : undefined,
    licenseSkuPartNumbers: Array.isArray(licenseSkuPartNumbers) ? licenseSkuPartNumbers : undefined,
  });
  res.json({ ok: true });
});

router.get("/license-skus", async (_req, res) => {
  try { res.json(await listAvailableLicenseSkus()); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
