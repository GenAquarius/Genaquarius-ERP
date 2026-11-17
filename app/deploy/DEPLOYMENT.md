# Deploying the Costing app to the GenAquarius Azure tenant (test)

Bare-minimum footprint for a **test** deployment. One App Service hosts both the
API and the React UI; one small MySQL server; one Entra app registration for SSO.

## Services used (and why)
| Service | SKU (test) | Purpose | ~Cost |
|---|---|---|---|
| **Azure App Service** (Linux, Node 20) | **B1** Basic | Runs the Express API **and serves the built React app** (single service) | ~$13/mo |
| **Azure Database for MySQL — Flexible Server** | **B_Standard_B1ms** burstable, 20 GB | The database | ~$12–15/mo |
| **Microsoft Entra App Registration** | free | genaquarius.com SSO + 2FA (Conditional Access) | free |
| Resource Group | — | Holds everything; delete it to tear down | free |

> Deliberately omitted for "bare minimum": Key Vault (secrets go in App Service settings), Static Web Apps / separate frontend host (the API serves the static build), Front Door/CDN, VNet/private endpoints, App Insights. Add these for production.

## Architecture
```
Browser ──HTTPS──► App Service (Node 20, B1)
                     • /api/*  → Express API
                     • /*      → React build (client-dist)
                     │
                     └──► MySQL Flexible Server (B1ms)
Sign-in ─────────► Microsoft Entra (genaquarius.com) ──redirect──► /api/auth/azure/callback
                     (MFA enforced by Conditional Access)
```

## Prerequisites
- `az login` into the GenAquarius tenant; note the **subscription ID**.
- Terraform ≥ 1.5, Node 20, and permission to create an App Registration (Application Administrator).

## Step 1 — Provision infra (Terraform)
```bash
cd app/deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # fill subscription_id + mysql password + unique prefix
terraform init
terraform apply
```
This creates the RG, MySQL (+ `costing` DB, Azure-services firewall rule, TLS-off for test),
the App Service plan + web app, and the Entra app registration — and wires all the
app settings (DATABASE_URL, JWT_SECRET, AZURE_*, ALLOW_LOCAL_LOGIN=false,
BLOCKED_SIGNIN_ROLES, AZURE_AUTO_PROVISION=false).

Outputs: `app_url`, `redirect_uri`, `entra_client_id/tenant_id/secret` (the secret is
already injected into the web app; `terraform output -raw entra_client_secret` if needed).

## Step 2 — Build the deployment package
```bash
# from repo root
cd app/client && npm ci && npm run build            # -> client/dist
cd ../server && npm ci && npm run build && npx prisma generate
# bundle the React build into the server so one service serves both
rm -rf client-dist && cp -r ../client/dist ./client-dist
# zip what App Service needs to run
zip -r ../deploy/app.zip dist client-dist node_modules prisma package.json
```

## Step 3 — Deploy the code
```bash
az webapp deploy --resource-group <prefix>-rg --name <prefix> \
  --src-path app/deploy/app.zip --type zip
```
Startup runs `prisma db push` then `node dist/index.js` (set in Terraform). The schema
is created on first boot.

## Step 4 — Seed the canonical admins (one time)
Run once (it resets data, so only on a fresh DB):
```bash
az webapp ssh --resource-group <prefix>-rg --name <prefix>
#  then inside:  npm run seed
```
Seeds the admin users + migrates both fiscal years from the workbook data shipped in
`data/seed.json`. (Skip if you'll load data another way.)

## Step 5 — Verify
- Open `app_url`. Only **provisioned admins** can sign in (EMPLOYEE/PROJECT_MANAGER are
  blocked via `BLOCKED_SIGNIN_ROLES`; auto-provisioning is off).
- "Sign in with Microsoft" → completes MFA → lands on the CEO dashboard.

## Securing the DB — only you (genaquarius.com) can open it
Two layers:

**1) Network — only your laptop's IP can reach MySQL.**
The server is never open to the public internet. Terraform allows only (a) the App
Service (Azure-internal) and (b) the single IP you put in `my_client_ip`. Find yours:
```bash
curl https://ifconfig.me        # put this in terraform.tfvars -> my_client_ip
```
Anyone on any other network is refused at the firewall.

**2) Identity — open the DB with your genaquarius.com login (Entra token), not a password.**
After `terraform apply`, make your account the MySQL Entra administrator:
```bash
RG=<prefix>-rg ; SRV=<prefix>-mysql
# give the server a managed identity (required for Entra auth)
az mysql flexible-server identity assign --resource-group $RG --server-name $SRV \
  --identity "$(az identity create -g $RG -n ${SRV}-uami --query id -o tsv)"
# set YOU as the Entra admin
OID=$(az ad signed-in-user show --query id -o tsv)
az mysql flexible-server ad-admin create --resource-group $RG --server-name $SRV \
  --display-name "Sandeep Minocha" --object-id $OID
```
Now connect with a **short-lived token from your own login** (MFA via Conditional Access) —
no shared password:
```bash
az login                                   # your genaquarius.com account + MFA
TOKEN=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
mysql -h <prefix>-mysql.mysql.database.azure.com -u "sandeep.minocha@genaquarius.com" \
  --enable-cleartext-plugin --password="$TOKEN" costing
```
The token expires in ~1 hour and is tied to your identity, so only you can open the DB.

> The app itself keeps using the SQL admin password (kept only in App Service settings)
> over the Azure-internal path. To remove that password too, give the **App Service a
> managed identity** and create a matching MySQL Entra user — a good production follow-up.

## Access control — only the people you choose (not "any admin")
The app gates sign-in on **membership of an Entra security group**, layered with the
provisioning + role checks. A user gets in only if **all** hold:
1. They authenticate against genaquarius.com (Entra SSO + MFA), **and**
2. They are a member of the **`<prefix>-access`** security group (Terraform creates it,
   seeded with just sandeep; `AZURE_ALLOWED_GROUP_ID` is wired automatically), **and**
3. They are provisioned in the app with a non-blocked role (`AZURE_AUTO_PROVISION=false`,
   `BLOCKED_SIGNIN_ROLES=EMPLOYEE,PROJECT_MANAGER`).

**Being a tenant Global Administrator grants none of this.** GA is a directory role; it
does not put you in the access group, provision you in the app, or give you the DB. So
your second Global Admin cannot sign into the app. To grant/revoke a person, just add or
remove them from the `<prefix>-access` group — no redeploy.

### Important honesty about Global Administrators and the DB
You **cannot fully, technically lock a Global Administrator out of the Azure resources**.
A GA can elevate themselves to "User Access Administrator" over all subscriptions, then
reassign the MySQL Entra admin or reset the SQL password and reach the data. Groups and
firewalls stop *normal* access; they don't stop a determined GA at the control plane.
Mitigate organizationally:
- Keep GA count minimal; put GA behind **PIM (just-in-time, approval + MFA)**.
- Put this app in its **own subscription/resource group** with scoped RBAC.
- Turn on **alerts** for role elevation, `ad-admin` changes, and password resets.
- (Strongest) give the **App Service a managed identity** as the only DB principal and
  remove the SQL admin password entirely.

## "Never exposed to the internet" DB (private option)
The bare-minimum setup gives MySQL a **public endpoint locked by firewall** (your IP +
the App Service only). For **no public endpoint at all**, switch MySQL to **Private
Access**: put the Flexible Server in a delegated subnet of a VNet, add a **private DNS
zone**, and turn on **App Service VNet integration** so the app reaches the DB over a
private IP. The server then has no public address. This adds a VNet, a subnet, and a
private DNS zone (~no extra cost, more moving parts) — ask and I'll provide that variant.
(You cannot host MySQL inside App Service itself — App Service has no persistent DB
engine; a managed MySQL is required either way.)

## Notes / production hardening (later)
- Move secrets to **Key Vault** + App Service references.
- Turn MySQL TLS back **ON** (`require_secure_transport=ON`) and append `?sslaccept=strict` to `DATABASE_URL`.
- Replace `db push` with versioned **`prisma migrate deploy`**.
- Add **Application Insights**, autoscale, and a deployment slot.
- Use a CI pipeline (GitHub Actions) for Steps 2–3.

## Tear down
```bash
terraform destroy        # removes everything in the resource group + the app registration
```

## Cost control
It's ~$25–30/mo while running. To pause: **Stop** the web app and **Stop** the MySQL
flexible server from the portal (compute billing pauses; storage still bills).
