# GenAquarius Costing & Billing Platform — Implementation Plan

**Goal:** Replace `Costing_FY26-27New.xlsm` with a Node + React + MySQL web application that covers every function in the workbook, so the business can run entirely in the app — CTC/salary management, monthly forecast & actuals entry, timesheets, project & billing-rate setup, invoice generation, and the CEO/Finance P&L dashboard.

> **Status (2026-06-01): BUILT & RUNNING.** Full app in `app/` (Node+Express+Prisma API, React+Vite web, MySQL via Docker). Both fiscal years migrated; `npm run reconcile` shows **ZERO deviation** across both years. Every plan item below is implemented — see the checklist.

### ✅ Completion checklist (all done)
- **Migration:** current + prior year (`Costing_Updated till Mar26`) imported; golden-master extractor + two-year cell-level reconciliation (FY26-27 435 cells, FY25-26 768 cells) — **zero deviation**.
- **Dashboards:** CEO (global revenue, projections, US/Canada/Caribbean, onsite/offshore, EBITDA, per-customer profitability, top-3, AR past-30, cash flow, FY selector) + Finance (full Actual Cost P&L: head count, onsite/offshore, GP/PGP, transfer pricing, tax, cash flow 30/60, year total, Show GP / Hide-empty toggles, FY selector).
- **Masters:** Employees (+ one/many project assignment, computed CTC cost), CTC (versioned), Clients, Projects (Fixed/T&M, scope, delivery), Billing Rates (8h/9h, resource/project), FX (per-context dated).
- **Operations:** Monthly Forecast/Actuals form (editable, recompute, CSV export), Expenses/Vendors, Invoices (generate → Kira-format PDF, sequential per client, INR/USD/CAD), Invoice Templates (per-client configurable).
- **People & RBAC:** Login; CEO/CTO/Finance admin; Manager approvals; Member & Restricted ("Meeta") timesheets (select project + tasks + leave). Users & Roles admin with **role assignment** + **GenAquarius/Entra tenant import** (admin consent, default MEMBER). Audit log.
- **Engine:** per-employee cost (CTC+FX), per-line billing/invoice, margins, project/geo roll-ups, company P&L, transfer pricing 15%, tax 26%×15%, cash flow.
- **Integrations:** Tally + Bank of America adapters + sync + reconciliation view feeding AR/cash.

---

> **Original plan (reference) below.** This document maps every Excel sheet to app modules, defines the data model, roles, screens, calculation engine, and a phased build roadmap.

---

## 1. Source Material Analysis

### 1.1 Files reviewed
| File | Role in the business today |
|---|---|
| `Costing_FY26-27New.xlsm` | The single source of truth — 7 sheets covering salary, monthly billing, and the master P&L. |
| `Kira Learning Invoice Aug 2025.pdf` | The target output format for client invoices. |
| `CEO_Dashboard_FY26-27.html` | Reference for the executive analytics layer (KPIs + charts). |

### 1.2 Workbook sheet-by-sheet breakdown

#### Sheet 1 — `Actual Cost` (171 rows × 82 cols) → **THE main dashboard to build**
The master P&L. The horizontal axis is **12 monthly blocks** (Apr = cols F–K, May = L–Q, June = R–W, … Mar = BD–BG). Each month block carries: **Head Count, TB (Total Billing), Off B (Offshore Billing), On B (Onsite Billing), GP (Gross Profit), PGP (Profit/GP %)**.

- **Rows 14–132:** every resource, grouped by **Project** in column A (Providence, Kira, NP, LM, Station Casino India/US, Clarien, Voices, Vancity, Bastian, Cozzini, Cyncly, Stratoscope, MC Energy, Symsoft/Caltrans) and by **overhead buckets** (Internal HR/IT, Expenses India, Expenses India–Resourcing, Expenses US/Canada).
  - `F` (cost) = `VLOOKUP(name → monthly sheet, col 3 "Invoice/Cost")`, `G` (invoice/revenue) = `VLOOKUP(name → monthly sheet, col 8)`.
  - `D/E` = annual CTC and USD cost; `J` = per-resource margin `(G−F)/G`; `K` = project-average margin.
- **Rows 133–154 (roll-ups):** Total Cost Monthly, Revenue Run Rate (×12), Total Monthly Profit, India Team Profit, US/Canada Team Profit, **Transfer Pricing (15%)**, **Tax (26% of 15%)**, **Cash Flow (30/60 days)**, Net Profit after Tax.
- **Rows 1–10 (top KPIs):** Salary Expense, Total Cost Monthly, Monthly Profit, Net Profit %, **Year Total (BH col)**; toggles "Show Past Month" and "Show GP".

→ This sheet **and** the `CEO_Dashboard` HTML are merged into a single **Executive Dashboard** module (see §6.1).

#### Sheet 2 — `Employee cost` (hidden, 31 rows) → **feeds cost into the dashboard**
Salary master with **proration**: Monthly CTC, Bonus, Annual CTC, a months-worked string (`S` e.g. "11 months 15 days"), **Actual cost `T`** (prorated annual cost), Annual cost in USD `U` (= `/85`). The dashboard's cost column VLOOKUPs against `T`/`U` here. In the app this becomes the **computed annual/effective cost per employee**, derived (not hand-typed).

#### Sheets 3–5 — `Apr`, `May`, `June` (~94 rows each) → **Monthly Forecast & Actuals forms (Finance-owned)**
> Per your note: *the monthly tabs are the forecast expense-vs-revenue data the Finance team creates.* These are the operational heart and the source of every invoice.

Columns per resource: `S.No | Name | Project | USD CTC (D) | Rate (E) | Estimate Hrs (F) | Billing Amount (G = Rate×EstimateHrs) | Actual Hrs (H) | Invoice Amount (I = Rate×ActualHrs)`.
- `D` USD CTC = `VLOOKUP(name → CTC/Employee cost, annual USD)` — the cost side.
- **Offshore/FX multipliers:** some rows apply `×0.68` (estimate) and `×0.71` (invoice) — the Canada conversion from `Settings`.
- **8h vs 9h billing:** monthly standard hours vary by row (160 = 8h×20d, 155/176/180/198 = other day-counts/9h patterns). Estimate Hrs is the standard-hours driver; Actual Hrs is what's actually billed.
- **Bottom block:** Totals, India Health Insurance, and a **Vendor/Overhead expenses table** (Etheria Rent, GreyHR, Prasha Consultancy, Techprayag, Credit Card) with INR→USD conversion.

→ In the app: one **Monthly Sheet per (month, FY)**, with a row per resource = forecast (estimate hrs × rate) vs actual (actual hrs × rate), plus the month's overhead lines.

#### Sheet 6 — `CTC` (98 rows) → **Salary / CTC register + Vendor costs**
Detailed salary structure per employee: S.No, Name, Project, Joining Date, **Basic, HRA, Other Allowance, Special Allowance, Fixed Total**, flexi components (**Conveyance/Fuel, Communication, Meals & Entertainment, Books & Periodicals, Driver, Uniform, Flexi Total**), **Total Payout**, **USD (= /93)**. Rows 83–91 hold **vendor/contractor costs** (Etheria Rent, TechPrayag, GreyHR, Aarkeya, Prasha, etc.) in INR and USD (`/88`).

#### Sheet 7 — `Settings` (FX rates)
`USD = ₹93` (INR per USD), `Canada exchange in USD rate = 0.71`. Other rates (`/85`, `/88`, `/90`) are hardcoded inconsistently across sheets — the app will centralize **dated FX rates** so every calc uses one rate table.

### 1.3 Invoice format (`Kira Learning Invoice Aug 2025.pdf`)
- **Issuer block:** GenAquarius LLC, Folsom CA address, website, Invoice Number (`GA/2025/KIRA-Aug`), Invoice Date, Payment Due Date (Net 30), Project Description, **Billing Period**, Attention contact.
- **Bill-To block:** client name + address.
- **Line items:** `Description | Rate per hour (USD) | Hours | Amount` → multiple rate tiers ($32, $45) summed to **Total Invoice Amount**.
- **Bank details** (Bank of America, account/routing, address) + payment terms.
- **Annexure:** per-resource table — `Name of Resource | Leave | Bill Rate (USD) | Hours | Amount`.
→ Invoice is generated **directly from the Monthly Sheet rows** for a client (Actual Hrs × Bill Rate), grouped into rate-tier line items, with the per-resource annexure. **Format configurable per client.**

---

## 1.4 Core Design Principle — Fully Dynamic, Nothing Hardcoded
Every business entity is **created and managed at runtime from the Admin module** — there are **no hardcoded clients, projects, resources, rates, or categories** anywhere in the code. The workbook's fixed project list (Providence, Kira, Clarien, …) and fixed resource rows are **seed/migration data only**, not constants.

This means:
- **Clients & Projects** — created/edited/archived in the UI; the project list is data, not an enum.
- **Billing rates, FX rates, payroll-tax %, transfer-pricing %, tax %** — all editable, dated config rows, never literals in code (no `/93`, `*0.71`, `15%`, `0.26` baked in).
- **Expense/overhead categories, vendors, geographies, delivery models** — managed as reference data (lookup tables), addable from admin.
- **Roles & permissions** — role list and page-access map are data-driven so new roles can be added without code changes.
- **Invoice templates** — per-client, configured in admin (issuer block, bank details, layout), not hardcoded.
- **Calculation engine** reads all coefficients from config tables, so changing a rate or % in the UI instantly changes every dashboard, invoice, and P&L figure.

→ Reflected in the schema (§3): `clients`, `projects`, `fx_rates`, `billing_rates`, `expenses`, `invoice_templates`, plus reference tables for geographies / delivery models / expense categories / roles.

## 2. Roles & Permissions (RBAC)

| Role | Access |
|---|---|
| **CEO** | Full admin — every page/function (incl. CEO Dashboard + Finance Dashboard). |
| **CTO** | Full admin — every page/function; explicitly has access to **both the CEO Dashboard and the Finance Dashboard / Actual Cost reports**. |
| **Finance** | Full admin — every page; **plus the data-entry owner**: add/edit Employees, add/edit **CTC**, create & edit **Monthly Forecast/Actuals sheets**, FX rates, expenses, generate invoices. |
| **Manager / Team Lead** *(optional tier)* | Enter/submit timesheets for their team & projects; view their projects' billing. No CTC/P&L access. |
| **Team Member** | Add & submit their own timesheets; view their own entries. |
| **Restricted Member ("Meeta")** | Login **only** + submit a timesheet. May be linked to **one or multiple projects**; on login they **select the project** and the form is scoped to it. They enter monthly hours + **tasks performed against those hours** + leave, then submit. No other pages. |

**Resource types:** every person is an employee that may be **full-time, part-time, or contract**, and may be assigned to **one or many projects** (a `user_projects` / employee-project link). Project assignment drives which projects appear in their timesheet selector.

- Admin tier (CEO/Finance/CTO) sees the **Admin Portal** (all Excel functions: CTC, Costing, Projects, Rates, Invoices, Expenses, Dashboard).
- Enforced both in the React route guard **and** server-side on every API endpoint (JWT + role claims; never trust the client).

---

## 3. Data Model (MySQL)

Core tables (PK/FK and key columns; types abbreviated):

```
users(id, name, email, password_hash, role ENUM[CEO,CTO,FINANCE,MANAGER,MEMBER,RESTRICTED], employee_id FK?, is_active, created_at)

clients(id, name, geo ENUM[US,CANADA,CARIBBEAN,INDIA,OTHER], bill_to_address,
        currency, attention_contact, default_invoice_template_id FK, payment_terms_days)

projects(id, client_id FK, name, code, billing_type ENUM[FIXED,TNM],
         billing_scope ENUM[PROJECT,RESOURCE], status, start_date, end_date,
         delivery_model ENUM[ONSITE,OFFSHORE,HYBRID])

employees(id, emp_no, name, joining_date, exit_date,
          location ENUM[INDIA,US,CANADA,OTHER],
          emp_type ENUM[FULL_TIME,PART_TIME,CONTRACT,VENDOR], is_billable)

employee_projects(id, employee_id FK, project_id FK, allocation_pct, from_date, to_date)
   -- one employee → one OR many projects; drives the timesheet project selector

ctc_records(id, employee_id FK, effective_from, basic, hra, other_allowance, special_allowance,
            conveyance, communication, meals, books, driver, uniform,
            bonus_annual, -- Fixed Total / Flexi Total / Monthly CTC / Annual CTC are COMPUTED
            currency DEFAULT 'INR')
   -- versioned by effective_from so salary revisions keep history

fx_rates(id, base_ccy, quote_ccy, rate, effective_from)   -- e.g. USD/INR=93, CAD factor 0.71

billing_rates(id, project_id FK, employee_id FK?, rate_usd, rate_basis ENUM[HOURLY,MONTHLY],
              standard_hours_per_day ENUM[8,9], effective_from)
   -- resource-level OR project-level (employee_id NULL = project default)

monthly_sheets(id, fiscal_year, month, status ENUM[DRAFT,SUBMITTED,LOCKED], created_by FK, locked_at)
   -- one per (FY, month); the "respective month form" owned by Finance

monthly_lines(id, monthly_sheet_id FK, employee_id FK, project_id FK,
              rate_usd, estimate_hours, actual_hours,
              fx_multiplier DEFAULT 1,           -- e.g. 0.71 Canada
              -- billing_amount = rate*estimate ; invoice_amount = rate*actual (computed)
              cost_usd_snapshot)                 -- cost frozen from CTC at sheet time

timesheets(id, employee_id FK, project_id FK, period_month, period_year,
           total_hours, leave_days,
           status ENUM[DRAFT,SUBMITTED,APPROVED], submitted_at, approved_by FK)
   -- one timesheet per (employee, project, month); monthly total + leave
timesheet_tasks(id, timesheet_id FK, task_description, hours)
   -- the "tasks performed against hours" breakdown for that month/project

expenses(id, scope ENUM[INDIA,US_CANADA,RESOURCING,INTERNAL], category, vendor_name,
         amount, currency, monthly_sheet_id FK?, recurring, notes)
   -- Etheria Rent, GreyHR, Prasha, Techprayag, insurance, payroll tax, commissions

invoices(id, client_id FK, invoice_no, invoice_date, due_date, billing_period_start,
         billing_period_end, project_description, currency, total_amount,
         status ENUM[DRAFT,SENT,PAID,OVERDUE], template_id FK, monthly_sheet_id FK)
invoice_line_items(id, invoice_id FK, description, rate_usd, hours, amount)
invoice_annexure(id, invoice_id FK, employee_id FK, resource_name, leave, bill_rate, hours, amount)

invoice_templates(id, name, issuer_block JSON, bank_details JSON, layout_config JSON)
   -- per-client configurable invoice format

audit_log(id, user_id FK, action, entity, entity_id, before JSON, after JSON, at)
```

**Why versioned CTC / FX / billing_rates:** the workbook hardcodes rates and overwrites salaries; versioning by `effective_from` preserves history and makes every past invoice/P&L reproducible.

---

## 4. Calculation Engine (the formulas behind the Excel)

A single server-side service computes everything the workbook's formulas do:

1. **Cost per employee (monthly/annual)** — sum CTC components (Basic+HRA+allowances+flexi), apply proration by joining/exit date (the `Employee cost!T` logic), convert INR→USD via `fx_rates`. Replaces the `Fixed Total / Flexi / Total Payout / Actual cost / USD` formulas.
2. **Billing & Invoice amount per line** — `billing_amount = rate × estimate_hours × fx_multiplier`; `invoice_amount = rate × actual_hours × fx_multiplier`. (Apr!G / Apr!I logic, incl. `×0.71` Canada.)
3. **Standard hours** — derived from `standard_hours_per_day` (8 or 9) × billing days in month; drives default Estimate Hrs.
4. **Per-resource & per-project margin** — `(revenue − cost)/revenue` (Actual Cost!J/K).
5. **Monthly roll-up per project & geography** — Total Billing, Onsite vs Offshore, Head Count, Gross Profit, PGP.
6. **Company P&L** — Total Cost, Revenue Run-Rate (×12), India vs US/Canada team profit, **Transfer Pricing 15%**, **Tax 26%×15%**, Cash Flow 30/60-day, Net Profit after Tax, Year Total.
7. **Overheads** — vendor/expense lines folded into monthly cost (rent, HRMS, recruiting firms, insurance, payroll tax 9%, commissions).

All values are **recomputed from source rows**, never stored as the only copy — eliminating the fragile `VLOOKUP/INDIRECT` chains.

---

## 5. Application Screens (mapped to Excel functions)

### Admin Portal (CEO / CTO / Finance)
| # | Screen | Replaces Excel | Key functions |
|---|---|---|---|
| A1a | **CEO Dashboard** | `CEO_Dashboard.html` | Global revenue, revenue projections, revenue by US/Canada/Caribbean, onsite revenue, EBITDA, per-customer profitability, top-3 customers, AR past-30-days (which customer/which invoices), cash flow. **(§6.1)** |
| A1b | **Finance Dashboard** | `Actual Cost` (full) | Everything from Actual Cost: 12-month P&L grid, head count, on/off billing, GP/PGP, transfer pricing, tax, cash flow 30/60, year total, overheads, toggles. **(§6.1)** |
| A2 | **Employees** | `CTC` / `Employee cost` (names) | List/add/edit employees, project assignment, billable flag, joining/exit. *(Finance can add.)* |
| A3 | **CTC Management** | `CTC` sheet | Add/edit salary structure (versioned), auto-compute Fixed/Flexi/Total/USD. *(Finance can add.)* |
| A4 | **Projects & Clients** | Project column + client list | CRUD clients & projects; set billing type (Fixed/T&M), scope (project/resource), delivery model, geo. |
| A5 | **Billing Rates** | `Rate` column | Resource-level or project-level rates, 8h/9h day, effective dating. |
| A6 | **Monthly Sheet (Forecast & Actuals)** | `Apr/May/June` tabs | Finance creates a month, edits per-resource Estimate/Actual hrs & rate, sees Billing vs Invoice; submit & **lock**. **(the "respective month form")** |
| A7 | **Expenses & Vendors** | bottom of monthly + CTC vendor rows | Rent, HRMS, recruiting, insurance, payroll tax, commissions; INR/USD. |
| A8 | **Invoices** | Kira PDF prep | Generate per client from a monthly sheet → line items + annexure → PDF; configurable template; status (Sent/Paid/Overdue). **(§6.2)** |
| A9 | **FX Rates & Settings** | `Settings` | Dated USD/INR, Canada factor, payroll-tax %, transfer-pricing %, tax %. |
| A10 | **Users & Roles / Audit Log** | (new) | Manage users, roles; immutable audit trail. |

### Member screens
| # | Screen | Role |
|---|---|---|
| M1 | **My Timesheet** | Team Member — **select project** (from their assigned one/many), enter monthly hours + **tasks performed against hours** + leave, submit. |
| M2 | **Submit Timesheet** | Restricted "Meeta" — login → **select project** (scoped to assigned project(s)) → enter monthly hours + tasks + leave → submit. Nothing else visible. |
| M3 | **Timesheet Approvals** | Manager — review/approve team timesheets (informational; Finance keys actuals into the Monthly Sheet). |

---

## 6. Two flagship modules

There are **two distinct dashboards**: a high-level **CEO Dashboard** (executive summary, styled like the shared `CEO_Dashboard.html`) and a detailed **Finance Dashboard** (the full `Actual Cost` P&L). Both are admin-tier (CEO/CTO/Finance) but serve different altitudes.

#### CEO Dashboard (executive summary)
Exactly the tiles you specified:
- **Global company revenue** (all geographies combined).
- **Revenue projections** (forward months from the Monthly Sheets / run-rate).
- **Revenue by geography** — US, Canada, Caribbean customers (separate breakdown).
- **Revenue from Onsite business** (onsite vs offshore split).
- **EBITDA on global revenue** (value + margin %).
- **Profitability of each customer** (revenue / cost / profit / margin, color-coded).
- **Top 3 customers by revenue**.
- **Accounts Receivable** — which customer is **past 30 days** and **on which invoices** (aging detail, drill-down to invoice list).
- **Cash flow**.
> AR & Cash come from the **external systems** in §6.3 (Tally API for AR/realized revenue, Bank of America current-account API for cash), reconciled against our issued `invoices`.

#### Finance Dashboard (full Actual Cost P&L)
**Everything from the `Actual Cost` sheet**, in app form:
- The 12-month × per-project / per-resource grid: Head Count, Total Billing, **Offshore vs Onsite billing**, Gross Profit, PGP per month.
- Roll-ups: Total Cost Monthly, Revenue Run-Rate (×12), India-team vs US/Canada-team profit, **Transfer Pricing (15%)**, **Tax (26% of 15%)**, **Cash Flow (30/60 day)**, Net Profit after Tax, Year Total.
- Overhead/expense lines (rent, HRMS, recruiting firms, insurance, payroll tax, commissions).
- **Controls:** FY selector, "Show past month", "Show GP" toggles (mirroring the sheet).

### 6.2 Invoice generation (matches Kira PDF)
- Pick **client + month** → engine pulls that client's resources from the Monthly Sheet (Actual Hrs × Bill Rate), groups equal rates into **Description line items**, builds the **Annexure** (per resource: name, leave, rate, hours, amount), and totals.
- Auto invoice number (`GA/{YYYY}/{CLIENT}-{Mon}`), dates, Net-30 due date, billing period. Numbering is **strictly sequential per client**: the app reserves the next number in that client's chronological series, rejects duplicates/out-of-order numbers, and surfaces any gap — so each client's invoice register is auditable and gap-free. (If a client ever needs >1 invoice in a month, a `-01/-02` suffix is appended within the same sequence.)
- **Currency per client** — each client is configured as **INR, USD, or CAD**; the invoice, its line items, and the annexure render in that currency, and amounts convert via the dated `fx_rates` (e.g. USD→CAD for Vancity, USD/INR where applicable). Totals on the dashboards are normalized to a reporting currency for comparison.
- Renders to **PDF** using a **per-client configurable template** (issuer block, bank details, layout) — default template reproduces the GenAquarius/Kira layout exactly.
- Saves to `invoices` with status tracking → drives the dashboard's AR/Cash tiles.

---

### 6.3 External Integrations — AR / Revenue / Cash (read from Tally & Bank of America)
The internal Monthly Sheet produces **forecast/expected** revenue and the invoices we issue. **Actual AR, realized revenue, and cash come from outside the app** and are pulled via integrations:

- **Tally API** → Accounts Receivable & realized revenue: open invoices, payments received, AR aging by customer. Used to populate the dashboard's **AR tile** and to mark our `invoices` as paid/overdue (matched by invoice no / amount / date).
- **Bank of America current-account API** → **Cash Position** and incoming wire reconciliation (the BoA account on the Kira invoice). Used for the **Cash tile** and to auto-match deposits to invoices.

Design:
```
integrations(id, provider ENUM[TALLY,BOA], auth_config JSON, last_sync_at, status)
external_ledger(id, provider, ext_id, type ENUM[AR,PAYMENT,BALANCE,TXN],
                customer_ref, amount, currency, as_of_date, raw JSON, matched_invoice_id FK?)
```
- A scheduled **sync job** (cron) pulls from whichever source is connected; the app degrades gracefully if a provider is offline (tiles show "last synced" timestamp instead of failing).
- **Reconciliation view:** our issued invoices vs Tally AR vs BoA deposits, flagging mismatches and aged receivables — turning the two previously-"missing" CEO tiles into a live, source-backed picture.
- Provider is **pluggable** (adapter interface) so Tally-only, BoA-only, or both can be enabled per your final choice.

## 7. Technical Architecture

- **Frontend:** React (Vite) + TypeScript, React Router (role-guarded routes), TanStack Query, a component lib (shadcn/ui or MUI), Chart.js for the dashboard, an editable grid (AG Grid / TanStack Table) for the monthly sheet, a data-grid/Excel-paste UX so Finance feels at home.
- **Backend:** Node.js + Express (or NestJS) + TypeScript; layered (routes → services → repositories); the **calculation engine** as a pure, unit-tested service.
- **Database:** MySQL 8 + an ORM (Prisma or TypeORM) with migrations; decimal types for money; views for dashboard roll-ups.
- **Auth:** JWT + bcrypt; RBAC middleware per route; refresh tokens; password reset.
- **PDF:** Puppeteer or `pdfmake` rendering an HTML invoice template.
- **Excel bridge:** import existing workbook (one-time migration, §9) and export any grid back to `.xlsx` (so the team can still hand off spreadsheets when needed).
- **Infra:** Docker Compose (api + web + mysql) for dev; `.env` config; seed script.

### API surface (representative)
```
POST /auth/login
GET/POST/PUT  /employees           /ctc
GET/POST/PUT  /clients  /projects  /billing-rates  /fx-rates
GET/POST/PUT  /monthly-sheets  /monthly-sheets/:id/lines  /monthly-sheets/:id/lock
GET/POST      /timesheets  /timesheets/:id/submit  /timesheets/:id/approve
GET/POST/PUT  /expenses
POST          /invoices/generate   GET /invoices/:id/pdf   PUT /invoices/:id/status
GET           /dashboard/summary?fy=  /dashboard/projects  /dashboard/pnl
GET/POST      /users  /audit-log
GET/POST      /integrations  /integrations/:provider/sync   GET /reconciliation
```

---

## 8. Phased Delivery Roadmap

**Phase 0 — Foundation:** repo, Docker, MySQL schema + migrations, auth + RBAC, user seeding. Import workbook data (employees, CTC, projects, rates, FX).

**Phase 1 — Masters:** Employees, CTC (versioned), Clients/Projects, Billing Rates, FX/Settings. *(Finance can add employees & CTC.)*

**Phase 2 — Monthly Sheet + Calculation Engine:** the per-month forecast/actuals form, cost/billing/invoice computation, lock workflow. This unblocks the dashboard and invoices.

**Phase 3 — Timesheets:** Member + restricted "Meeta" flows, approvals feeding actual hours.

**Phase 4 — Invoices:** generator, per-client templates, PDF matching Kira format, status tracking.

**Phase 5 — Executive Dashboard:** combined Actual Cost P&L + CEO charts.

**Phase 6 — External Integrations:** Tally and/or Bank of America adapters, scheduled sync, reconciliation view → AR & Cash tiles go live (§6.3).

**Phase 7 — Expenses, Audit, polish:** vendor/overhead module, audit log, Excel export, hardening.

> **Parity gate runs throughout:** the golden-master is extracted in Phase 0; the cell-level reconciliation suite (§9.1) is wired into CI from Phase 2 onward and must show **zero deviation across both fiscal years** before any phase is accepted and before go-live.

---

## 9. Migration from Excel (current + prior year)
- **Current year** (`Costing_FY26-27New.xlsm`): importer parses the 7 sheets — load `employees` + `ctc_records` from CTC, `projects`/`clients` from the project groupings, `billing_rates` from the Rate columns, `fx_rates` from Settings, and back-fill `monthly_sheets` for Apr/May/June.
- **Prior year** (`Costing_Updated till Mar26.xlsm` — located in the project folder): migrate **all of last year's data** so historical months (Apr-25 … Mar-26) are captured and the dashboard shows full year-over-year history on day one. This workbook has **19 sheets**: `Actual Cost`, `Employee cost`, `CTC`, a **complete set of monthly tabs Apr→Mar** (one per month, same column shape as the current file), plus two extra sheets to map — **`Dep`** (depreciation schedule) and **`Insurance`**. The importer maps all monthly tabs + CTC into the same schema, and adds `Dep`/`Insurance` as `expenses` categories.
- Reconciliation report: app-computed totals vs workbook totals, **per month for both years**, to prove parity before go-live.

---

## 9.1 Numerical Parity Guarantee — ZERO deviation from the Excel (hard acceptance gate)

**Requirement:** after build + migration, **every computed number in the app must equal the corresponding cell in the workbook — every tab, every sheet, every row — with no deviation.** This is a release-blocking gate, not a "nice to have."

### How parity is proven
1. **Golden-master extraction.** A script reads **both** workbooks (current + prior year) and exports the **cached computed value of every non-empty cell** of every sheet (`Actual Cost`, `Employee cost`, `CTC`, all monthly tabs, `Settings`, `Dep`, `Insurance`) to a reference dataset (CSV/JSON), keyed by `sheet!cell`. This is the immutable "truth" we must match.
2. **Cell-level reconciliation suite.** An automated test recomputes each value through the app's calculation engine (and migrated data) and compares it against the golden master **cell by cell**:
   - Money/hours/rates compared at the **same rounding the workbook displays** (exact to the cell's precision; tolerance `0.00`).
   - A diff report lists any `sheet!cell` where app ≠ Excel, with both values — must be **empty** to pass.
3. **Roll-up reconciliation.** Independently verify the aggregates: monthly Total Cost/Invoice/Profit, per-project margins, geography splits, transfer pricing, tax, cash flow, and **Year Total (BH)** — all must tie to `Actual Cost`.
4. **Go-live gate.** The system is not "done" until the diff report is **zero rows for both fiscal years**. CI runs this suite on every change so parity can never silently regress.

### Important wrinkle (must be handled to hit *exact* match)
The workbook contains **manual fudge factors and one-off overrides that are not derivable from clean formulas**, e.g.:
- `Employee cost`: `R4 =(P4*12)+Q4-4`, `R6 …+4`, `R9 …-24`, `R13 …-8`, `R22 …-8` — arbitrary ±4/±8/±24 adjustments.
- `CTC`: `Q14 =525003*0.7`, `Q15 =(250000+100000)*0.5`, `O17 …+1`, hardcoded annual figures, mixed divisors (`/93`, `/90`, `/85`, `/88`).
- Monthly tabs: per-row literal rates and hand-entered hours, Canada `×0.68 / ×0.71` multipliers, and rows that hardcode amounts (`=400*17`, `=90*176`).

To match **exactly**, the migration will, for historical/locked months, **import the workbook's computed values as the stored baseline** (so history is identical by construction), while the **forward engine** reproduces the documented logic. Any cell that relies on an un-formula'd manual tweak is captured as an explicit, admin-editable **adjustment** on that row (so it's preserved *and* visible, not lost). This is why the schema carries `cost_usd_snapshot` and per-line adjustment fields, and why CTC/FX are versioned.

→ Net effect: **migrated historical numbers are bit-for-bit identical to the workbook; going forward the same inputs produce the same outputs**, and the reconciliation suite guarantees it stays that way.

## 10. Decisions

**Resolved (confirmed by you):**
1. **External AR/Cash source** → **Build BOTH Tally + Bank of America adapters together** and reconcile against each other (Phase 6).
2. **Actual hours flow** → **Finance keys actuals directly** into the Monthly Sheet (like Excel today). Timesheets are informational, not gating invoices.
3. **FX** → **Keep per-context rates** (93/88/85/90) per cost type — but stored as **editable, dated config rows** in `fx_rates` (a context/key column distinguishes them), never hardcoded.
4. **Timesheet granularity** → **Monthly total hours + leave** per resource per project (maps straight to the invoice Hours/Leave columns).
5. **System is fully dynamic** → all clients, projects, resources, rates, categories, roles, and invoice templates are admin-managed data; nothing hardcoded (§1.4).

6. **Invoice numbering** → **Confirmed**: format `GA/{YYYY}/{CLIENT}-{Mon}` (e.g. `GA/2025/KIRA-Aug`), **strictly sequential per client** — the app enforces a gap-free, chronological order of invoices for each client and blocks out-of-order or duplicate numbers. See §6.2.

7. **Multi-currency invoices** → **Confirmed**: support **INR / USD / CAD, configurable per client**. Invoice + annexure render in the client's currency; conversions use dated `fx_rates`; dashboards normalize to a reporting currency. See §6.2.

8. **Restricted "Meeta" role & timesheets** → **Confirmed**: people (full-time / part-time / contract) can be linked to **one or multiple projects** (`employee_projects`). On login they **select the project**, the timesheet form scopes to it, and they enter **monthly hours + tasks performed against hours + leave**, then submit. Restricted members see only this. See §2, §3, §5 (M1/M2).

*All decisions resolved — plan is build-ready.*
```
