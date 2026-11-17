import dotenv from "dotenv";
import path from "path";

// Env precedence:
//   • Local dev  → server/.env (+ optional server/.env.local override), both git-ignored.
//   • Production → real environment variables from Azure App Service settings; no .env is
//     deployed (the build zip excludes it), so dotenv is a harmless no-op there.
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
// Optional explicit env file (override) — used to run the isolated QA instance against
// its own database/secret: `ENV_FILE=.env.qa`. Production (Azure) sets real env vars,
// so ENV_FILE is unused there. Loaded last so it wins over .env / .env.local.
if (process.env.ENV_FILE) dotenv.config({ path: process.env.ENV_FILE, override: true });

const port = Number(process.env.PORT || 4000);
const isProd = process.env.NODE_ENV === "production";
const azureTenant = process.env.AZURE_TENANT_ID || "";
const azureClientId = process.env.AZURE_CLIENT_ID || "";
const azureClientSecret = process.env.AZURE_CLIENT_SECRET || "";

export const config = {
  port,
  isProd,
  jwtSecret: process.env.JWT_SECRET || "dev-secret",
  jwtExpires: process.env.JWT_EXPIRES || "12h",
  sessionCookie: process.env.SESSION_COOKIE || "ga_session",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  // Local email/password login — ON for dev; defaults OFF in production
  allowLocalLogin: isProd ? process.env.ALLOW_LOCAL_LOGIN === "true" : process.env.ALLOW_LOCAL_LOGIN !== "false",
  // Roles that are currently NOT allowed to sign in (any path). Default: block
  // EMPLOYEE + PROJECT_MANAGER so only provisioned admins can log in for now.
  blockedSignInRoles: (process.env.BLOCKED_SIGNIN_ROLES ?? "EMPLOYEE,PROJECT_MANAGER")
    .split(",").map((s) => s.trim()).filter(Boolean),
  // Microsoft Entra (Azure AD) SSO — 2FA/MFA is enforced by Azure Conditional Access
  azure: {
    tenant: azureTenant,
    clientId: azureClientId,
    clientSecret: azureClientSecret,
    redirectUri: process.env.AZURE_REDIRECT_URI || `http://localhost:${port}/api/auth/azure/callback`,
    enabled: !!(azureTenant && azureClientId && azureClientSecret),
    // Auto-create a user on first SSO login — OFF by default so only pre-provisioned
    // people can sign in (random tenant users are rejected). Enable explicitly.
    autoProvision: process.env.AZURE_AUTO_PROVISION === "true",
    // Only members of this Entra security group may sign in. Being a tenant Global
    // Admin does NOT grant access — only group membership does. Empty = no group gate.
    allowedGroupId: process.env.AZURE_ALLOWED_GROUP_ID || "",
  },
  goldenMasterPath: path.resolve(
    __dirname,
    "..",
    process.env.GOLDEN_MASTER_PATH || "../data/golden_master.json"
  ),
  seedPath: path.resolve(__dirname, "..", "../data/seed.json"),
};

// Fail fast in production on insecure configuration.
if (isProd) {
  if (config.jwtSecret === "dev-secret" || config.jwtSecret.length < 32)
    throw new Error("Refusing to start: set a strong JWT_SECRET (>=32 chars) in production.");
  if (config.allowLocalLogin && !config.azure.enabled)
    console.warn("WARNING: local password login is enabled in production without Entra SSO.");
}
