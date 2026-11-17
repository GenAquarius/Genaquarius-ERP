# GenAquarius Costing & Billing Platform

Full-stack replacement for `Costing_FY26-27New.xlsm` — Node + React + MySQL.
Every cost/invoice number is imported from the workbook's cached cells, so the
data matches Excel with **zero deviation** (proven by `npm run reconcile`).

## Stack
- **DB:** MySQL 8 (Docker, port 3307)
- **API:** Node + Express + TypeScript + Prisma (port 4000)
- **Web:** React + Vite + TypeScript + Chart.js (port 5173)

## Run it

```bash
# 1. Database
cd app
docker compose up -d

# 2. Parse the workbooks -> golden master + seed  (Python 3 + openpyxl)
python scripts/extract_golden_master.py
python scripts/migrate_import.py

# 3. API
cd server
npm install
npx prisma generate
npx prisma db push
npm run seed          # load seed.json into MySQL + demo users
npm run reconcile     # PROVE zero deviation vs Excel
npm run dev           # http://localhost:4000

# 4. Web
cd ../client
npm install
npm run dev           # http://localhost:5173
```

## Sign-in & provisioned users
Sign-in is **Microsoft (Entra) SSO only** — genaquarius.com + 2FA. Provisioned users:
| User | Role | Sees |
|---|---|---|
| sandeep.minocha@genaquarius.com | CTO | Everything (full admin) |
| mandeep@genaquarius.com | CEO | Everything (full admin) |
| kumar@genaquarius.com | CEO | Everything (full admin) |
| finance@genaquarius.com | FINANCE | Everything (full admin) |

Everyone else signs in via SSO and is auto-provisioned as **EMPLOYEE** (My Timesheet only),
and **PROJECT_MANAGER** approves timesheets — but EMPLOYEE/PROJECT_MANAGER sign-in is
currently **blocked** (`BLOCKED_SIGNIN_ROLES`), so only the admins above can log in.

## Local vs Production config (kept separate)
| | Local dev | Production (Azure) |
|---|---|---|
| Where env comes from | `server/.env` (+ optional `server/.env.local` override) | **App Service application settings** (set by Terraform) |
| Committed to git? | No — both are git-ignored | n/a (lives in Azure) |
| Database | local Docker MySQL (`:3307`) | Azure MySQL Flexible Server |
| Sign-in | Microsoft SSO (local app reg) or password if enabled | Microsoft SSO only |
| Shipped in deploy zip? | **`.env` is NOT included** in the zip | uses Azure settings only |

So local secrets never reach prod and prod settings never affect local. To change prod
config, edit App Service settings (or Terraform `app_settings`) — never a file.

## Debugging locally (for maintenance)
- **Run with logs:** `cd server && npm run dev` (API, ts-node-dev auto-restarts) and
  `cd client && npm run dev` (Vite HMR). Watch the terminals for errors.
- **Breakpoints:** open the repo in VS Code → Run & Debug → **"Debug API (server)"**
  (uses `.vscode/launch.json`, loads `server/.env`). Set breakpoints in `src/**`.
- **Check what the login page offers:** `curl localhost:4000/api/auth/config`.
- **Prove data parity anytime:** `cd server && npm run reconcile`.
- **Reset local data:** `npm run seed` (re-imports the workbook; local DB only).
- **Toggle local password login:** `ALLOW_LOCAL_LOGIN=true|false` in `server/.env`, restart.

## Parity
`npm run reconcile` rebuilds expected per-resource/per-month cost & invoice from
`data/golden_master.json` (the Excel cached cells) and compares them to MySQL.
It exits non-zero on any deviation. CI should run it on every change.
