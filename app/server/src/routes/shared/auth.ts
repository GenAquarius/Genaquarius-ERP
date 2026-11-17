import { Router } from "express";
import { prisma } from "../../prisma";
import { signToken, verifyPassword, authenticate, setSession, clearSession, canSignIn } from "../../auth/auth";
import { azureLogin, azureCallback } from "../../auth/azure";
import { config } from "../../config";

const router = Router();

// What the login screen should offer
router.get("/config", (_req, res) => {
  res.json({ azureEnabled: config.azure.enabled, allowLocalLogin: config.allowLocalLogin });
});

// Local email/password (dev fallback; disabled by default in production)
router.post("/login", async (req, res) => {
  if (!config.allowLocalLogin) return res.status(403).json({ error: "Password login is disabled. Use Microsoft sign-in." });
  const { email, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { email: String(email || "").toLowerCase() } });
  if (!user || !user.isActive || !verifyPassword(password || "", user.passwordHash))
    return res.status(401).json({ error: "Invalid email or password" });
  if (!canSignIn(user.role)) return res.status(403).json({ error: "Sign-in is currently disabled for your role." });
  const authUser = { id: user.id, name: user.name, email: user.email, role: user.role, employeeId: user.employeeId };
  setSession(res, authUser);
  // token also returned for non-browser API clients; browser relies on the httpOnly cookie
  res.json({ token: signToken(authUser), user: authUser });
});

// Microsoft Entra SSO (2FA enforced by Azure)
router.get("/azure/login", azureLogin);
router.get("/azure/callback", azureCallback);

router.post("/logout", (_req, res) => { clearSession(res); res.json({ ok: true }); });

router.get("/me", authenticate, async (req, res) => {
  res.json({ user: req.user });
});

export default router;
