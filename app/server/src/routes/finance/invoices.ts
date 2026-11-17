import { Router } from "express";
import { Writable } from "stream";
import fs from "fs";
import path from "path";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { renderInvoicePdf } from "../../engine/invoicePdf";
import { sendMail, mailEnabled } from "../../engine/mailer";
import { computeEmployeeCost } from "../../engine/calc";

const router = Router();
router.use(requireAdmin); // invoices are admin-tier only

const MONTH_NUM: Record<string, number> = { Apr:4,May:5,June:6,July:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,Jan:1,Feb:2,Mar:3 };

const parseLayout = (s: any) => { try { return s ? (typeof s === "string" ? JSON.parse(s) : s) : undefined; } catch { return undefined; } };
// Drops any header override under 3 characters — no real abbreviation anyone types for a column
// ("Leave", "Bill Rate", "Rate", "Qty"...) is that short, so a 1-2 char value is almost always a
// stray keystroke (e.g. a single letter typed into the rename box before clicking away) rather
// than a deliberate label. Without this, a stray "s"/"3" gets auto-saved onto the Project the
// moment anyone next clicks Preview/Generate (see rememberInvoiceOptions) and silently overwrites
// the real "Leave"/"Bill Rate" headers on every future invoice for that project.
function sanitizeColumnLabels(raw: any): any {
  let obj: any = raw;
  if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch { return {}; } }
  if (!obj || typeof obj !== "object") return {};
  const out: any = {};
  for (const section of ["li", "ax"]) {
    const s = obj[section];
    if (!s || typeof s !== "object") continue;
    const cleaned: any = {};
    for (const k of Object.keys(s)) {
      const v = typeof s[k] === "string" ? s[k].trim() : "";
      if (v.length >= 3) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length) out[section] = cleaned;
  }
  return out;
}
// Resolve a per-project invoice-number template. Tokens (case-insensitive):
// {ProjectCode} {ClientCode} {YYYY} {YY} {MMM} {MM} {ResourceName} {Seq}
function applyInvoiceNoFormat(fmt: string, ctx: { invoiceCode?: string; projectCode: string; clientCode: string; year: number; month: string; mmm: string; mm: string; resourceName: string; seq?: string }) {
  return String(fmt)
    .replace(/\{InvoiceCode\}/gi, ctx.invoiceCode || "")
    .replace(/\{ProjectCode\}/gi, ctx.projectCode || "")
    .replace(/\{ClientCode\}/gi, ctx.clientCode || "")
    .replace(/\{YYYY\}/gi, String(ctx.year))
    .replace(/\{Year\}/gi, String(ctx.year))
    .replace(/\{YY\}/gi, String(ctx.year).slice(2))
    .replace(/\{Month\}/gi, ctx.month || "")
    .replace(/\{MMM\}/gi, ctx.mmm)
    .replace(/\{MM\}/gi, ctx.mm)
    .replace(/\{ResourceName\}/gi, ctx.resourceName || "")
    .replace(/\{Seq\}/gi, ctx.seq || "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "") // collapse empty token gaps
    .trim()
    .toUpperCase(); // invoice numbers are always all-caps
}
// Resolve which InvoiceTemplate (issuer block, bank details) an invoice should use. The template is
// now a PROJECT setting (moved off the Client), so resolve from the project first:
//   the invoiced project's "Used By" template → any template linked to one of the client's projects
//   → the client's legacy assigned template (kept only as a fallback for un-migrated data).
async function resolveInvoiceTemplateId(client: any, projectName?: any): Promise<number | null> {
  const projs = client?.projects || [];
  const proj = projectName ? projs.find((p: any) => p.name === String(projectName)) : null;
  if (proj) { const t = await prisma.invoiceTemplate.findFirst({ where: { projects: { some: { id: proj.id } } } }); if (t) return t.id; }
  const ids = projs.map((p: any) => p.id);
  if (ids.length) { const t = await prisma.invoiceTemplate.findFirst({ where: { projects: { some: { id: { in: ids } } } } }); if (t) return t.id; }
  if (client?.invoiceTemplateId) return client.invoiceTemplateId; // legacy fallback
  return null;
}
// Pick the layout config string: explicit layoutId → project's assigned layout → the default layout.
async function resolveLayoutConfig(opts: { layoutId?: any; projectId?: any }): Promise<string | null> {
  if (opts.layoutId) { const l = await prisma.invoiceLayout.findUnique({ where: { id: Number(opts.layoutId) } }); if (l) return l.config; }
  if (opts.projectId) { const p = await prisma.project.findUnique({ where: { id: Number(opts.projectId) }, include: { invoiceLayout: true } }); if (p?.invoiceLayout) return p.invoiceLayout.config; }
  const def = await prisma.invoiceLayout.findFirst({ where: { isDefault: true } });
  return def?.config || null;
}

router.get("/", requireAdmin, async (_req, res) => {
  res.json(await prisma.invoice.findMany({
    include: { client: true, _count: { select: { lineItems: true } }, attachments: { select: { id: true, fileName: true, contentType: true, uploadedAt: true } } },
    orderBy: { invoiceDate: "desc" },
  }));
});

/** Preview the billable lines that /generate would invoice, without creating anything. */
router.get("/preview", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const { clientId, month } = req.query;
  const fiscalYear = (req.query.fiscalYear as string) || "FY26-27";
  const client = await prisma.client.findUnique({ where: { id: Number(clientId) }, include: { projects: true } });
  if (!client) return res.status(404).json({ error: "Client not found" });

  const sheet = await prisma.monthlySheet.findUnique({
    where: { fiscalYear_month: { fiscalYear, month: String(month) } },
    include: { lines: true },
  });
  if (!sheet) return res.json({ lines: [], total: 0, count: 0 });

  const projectNames = new Set([client.name, ...client.projects.map((p) => p.name)]);
  const lines = sheet.lines.filter((l) => !l.isExpense && l.invoiceAmount > 0 && (l.projectName ? projectNames.has(l.projectName) : false));
  const out = lines.map((l) => ({
    resourceName: l.resourceName,
    actualHours: l.actualHours,
    rateUsd: l.rateUsd || (l.actualHours ? l.invoiceAmount / l.actualHours : 0),
    invoiceAmount: l.invoiceAmount,
  }));
  const total = lines.reduce((s, l) => s + l.invoiceAmount, 0);
  res.json({ lines: out, total, count: out.length });
});

// Build a full, EDITABLE invoice draft from a month's billable lines — invoice details +
// grouped line items + per-resource annexure — WITHOUT saving anything. The client edits this
// and posts it back to /generate (or /preview-pdf) so the user controls the final document.
async function buildInvoiceDraft(client: any, fiscalYear: string, month: string, projectName?: any, subProjectId?: any) {
  const sheet = await prisma.monthlySheet.findUnique({
    where: { fiscalYear_month: { fiscalYear, month } }, include: { lines: true },
  });
  // Scope by the chosen PROJECT NAME (as it appears on the monthly resource lines) — these may be
  // a sub-project ("Providence-1") or the client-level name ("Providence"). Else all client lines.
  const allClientNames = new Set([client.name, ...client.projects.map((p: any) => p.name)]);
  const proj = projectName ? String(projectName) : "";
  const scopeNames = proj ? new Set([proj]) : allClientNames;
  // Optional Sub-Project scope — when set, this is the ENTIRE filter (one specific resource/
  // cost-center's lines only), on top of whatever project-name scoping already narrowed it to.
  const subProjId = subProjectId ? Number(subProjectId) : null;
  const subProj = subProjId ? await prisma.subProject.findUnique({ where: { id: subProjId } }) : null;
  const lines = sheet ? sheet.lines.filter((l) => !l.isExpense && l.invoiceAmount > 0 && (l.projectName ? scopeNames.has(l.projectName) : false) && (!subProjId || l.subProjectId === subProjId)) : [];
  // PO/desc/contacts come from the Project record whose NAME matches the selection (if any), else
  // the project the billed lines belong to, else the client's first. Editable before generate.
  const lineProjNames = new Set(lines.map((l) => l.projectName).filter(Boolean));
  const srcProj = (proj && client.projects.find((p: any) => p.name === proj)) || client.projects.find((p: any) => lineProjNames.has(p.name)) || client.projects[0] || null;
  const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
  // Billing currency is a PROJECT setting now (falls back to the client for un-migrated data).
  const ccy = srcProj?.currency || client.currency;
  // CAD projects are invoiced in CAD: monthly lines store USD (rate entered as CAD/hr × CANADA_FACTOR),
  // so the invoice converts BACK to CAD (CAD = USD ÷ factor). USD/INR pass through unchanged.
  const isCad = String(ccy) === "CAD";
  let cadFactor = 1;
  let cadFactorLoaded = false;
  const getCadFactor = async () => { if (!cadFactorLoaded) { const fx = await prisma.fxRate.findFirst({ where: { context: "CANADA_FACTOR" }, orderBy: { effectiveFrom: "desc" } }); cadFactor = fx?.rate || 0.71; cadFactorLoaded = true; } return cadFactor; };
  if (isCad) await getCadFactor();
  const toCcy = (usd: number) => (isCad && cadFactor ? r2(usd / cadFactor) : usd);
  const byRate = new Map<number, { hours: number; amount: number }>();
  for (const l of lines) {
    const r = l.rateUsd || (l.actualHours ? l.invoiceAmount / l.actualHours : 0);
    const g = byRate.get(r) || { hours: 0, amount: 0 };
    g.hours += l.actualHours; g.amount += l.invoiceAmount; byRate.set(r, g);
  }
  const hpd = srcProj?.billingHoursPerDay || 8; // for the Day Rate / Days basis (annexure & line items)
  // Role per resource: remembered from the most recent invoice of this client that named the same
  // resource (typed once in the Annexure "Role" column, it carries forward month to month).
  const norm = (v: any) => String(v || "").trim().toLowerCase();
  const roleByName = new Map<string, string>();
  const missingRoles = () => lines.map((l) => norm(l.resourceName)).filter((k, i, arr) => k && !roleByName.has(k) && arr.indexOf(k) === i);
  if (lines.length) {
    // 1) Annexure rows of this client's earlier invoices.
    const prior = await prisma.invoiceAnnexure.findMany({ where: { invoice: { clientId: client.id }, role: { not: null } }, orderBy: { invoiceId: "desc" }, select: { resourceName: true, role: true } });
    for (const a of prior) { const k = norm(a.resourceName); if (a.role && !roleByName.has(k)) roleByName.set(k, a.role); }
    // 2) Earlier per-resource invoices whose Annexure never recorded the role — e.g. line items typed by
    //    hand as "IT Services - Sr. Developer" on an invoice with an empty Annexure. Match each such line
    //    item to that month's billed resource lines on hours (then rate) and adopt the role when every
    //    line item in the bucket agrees on it. A "role" that is really a resource name (the per-resource
    //    fallback description) is ignored.
    if (missingRoles().length) {
      const invs = await prisma.invoice.findMany({ where: { clientId: client.id }, orderBy: { id: "desc" }, take: 12, select: { fiscalYear: true, month: true, currency: true, lineItems: { select: { description: true, rateUsd: true, hours: true } } } });
      for (const inv of invs) {
        if (!missingRoles().length) break;
        const items = inv.lineItems.map((x) => { const m = /^(.*?) - (.+)$/.exec(String(x.description || "")); return { role: m ? m[2].trim() : "", hours: r2(x.hours), rate: r2(x.rateUsd) }; }).filter((x) => x.role);
        if (!items.length || !inv.fiscalYear || !inv.month) continue;
        const ms = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear: inv.fiscalYear, month: inv.month } }, include: { lines: true } });
        if (!ms) continue;
        const fx = inv.currency === "CAD" ? await getCadFactor() : 1;
        const mlines = ms.lines.filter((l) => !l.isExpense && l.invoiceAmount > 0 && l.projectName && allClientNames.has(l.projectName))
          .map((l) => ({ name: norm(l.resourceName), hours: r2(l.actualHours), rate: r2((l.rateUsd || (l.actualHours ? l.invoiceAmount / l.actualHours : 0)) / (fx || 1)) }));
        const nameSet = new Set(mlines.map((l) => l.name));
        const usable = items.filter((x) => !nameSet.has(norm(x.role)));
        const adopt = (keyOf: (x: { hours: number; rate: number }) => string) => {
          const rolesByKey = new Map<string, Set<string>>();
          for (const x of usable) { const k = keyOf(x); if (!rolesByKey.has(k)) rolesByKey.set(k, new Set()); rolesByKey.get(k)!.add(x.role); }
          for (const l of mlines) { const rs = rolesByKey.get(keyOf(l)); if (rs && rs.size === 1 && !roleByName.has(l.name)) roleByName.set(l.name, [...rs][0]); }
        };
        adopt((x) => `${x.hours}|${x.rate}`); // exact hours + rate first
        adopt((x) => String(x.hours));          // then hours alone when unambiguous
      }
    }
    // 3) The same person on another client's invoice (a resource's role rarely differs per client).
    const still = missingRoles();
    if (still.length) {
      const names = lines.map((l) => l.resourceName).filter((n, i, arr) => still.includes(norm(n)) && arr.indexOf(n) === i);
      const any = await prisma.invoiceAnnexure.findMany({ where: { role: { not: null }, resourceName: { in: names } }, orderBy: { invoiceId: "desc" }, select: { resourceName: true, role: true } });
      for (const a of any) { const k = norm(a.resourceName); if (a.role && !roleByName.has(k)) roleByName.set(k, a.role); }
    }
  }
  const roleOf = (l: any) => roleByName.get(norm(l.resourceName)) || null;
  const sumAll = !!srcProj?.lineItemsSumAll;
  const perResource = !sumAll && !!srcProj?.lineItemsPerResource;
  const allHours = lines.reduce((s, l) => s + (l.actualHours || 0), 0);
  const allAmount = toCcy(lines.reduce((s, l) => s + (l.invoiceAmount || 0), 0));
  const lineItems = sumAll
    // ONE "IT Services" row: total hours, blended rate (amount ÷ hours), total amount.
    ? (lines.length ? [{ description: "IT Services", rateUsd: allHours ? r2(allAmount / allHours) : 0, hours: r2(allHours), dayRate: allHours && hpd ? r2((allAmount / allHours) * hpd) : 0, days: hpd ? r2(allHours / hpd) : 0, amount: r2(allAmount) }] : [])
    : perResource
    // One line per resource, described by role: "IT Services - Sr. Developer" (falls back to the resource name).
    ? lines.map((l) => { const r = toCcy(l.rateUsd || (l.actualHours ? l.invoiceAmount / l.actualHours : 0)); return { description: `IT Services - ${roleOf(l) || l.resourceName}`, resourceName: l.resourceName, lineId: l.id, rateUsd: r, hours: l.actualHours, dayRate: r2(r * hpd), days: hpd ? r2(l.actualHours / hpd) : 0, amount: toCcy(l.invoiceAmount) }; })
    : [...byRate.entries()].map(([rate, g]) => { const r = toCcy(rate); return { description: "IT Services", rateUsd: r, hours: g.hours, dayRate: r2(r * hpd), days: hpd ? r2(g.hours / hpd) : 0, amount: toCcy(g.amount) }; });
  const annexure = lines.map((l) => {
    const billRate = toCcy(l.rateUsd || (l.actualHours ? l.invoiceAmount / l.actualHours : 0)); // in invoice currency
    return { lineId: l.id, resourceName: l.resourceName, role: roleOf(l), leave: null as string | null, billRate, hours: l.actualHours, dayRate: r2(billRate * hpd), days: hpd ? r2(l.actualHours / hpd) : 0, timeLoggedOn: (l as any).timeLoggedOn || null, amount: toCcy(l.invoiceAmount) };
  });
  const total = lineItems.reduce((s, x) => s + x.amount, 0);
  // Diagnostics — explain an empty draft: which project names actually have billable lines this
  // month for the client (so you can see a project-name mismatch or a month with no billed hours).
  const clientBillable = sheet ? sheet.lines.filter((l) => !l.isExpense && (l.projectName ? allClientNames.has(l.projectName) : false)) : [];
  const byProj: Record<string, { billableAmount: number; lines: number; billedLines: number }> = {};
  for (const l of clientBillable) {
    const k = l.projectName || "(unassigned)";
    byProj[k] = byProj[k] || { billableAmount: 0, lines: 0, billedLines: 0 };
    byProj[k].lines++; byProj[k].billableAmount += l.invoiceAmount; if (l.invoiceAmount > 0) byProj[k].billedLines++;
  }
  const diag = {
    sheetFound: !!sheet, chosenProject: proj || null, matched: lines.length,
    byProject: Object.entries(byProj).map(([projectName, v]) => ({ projectName, ...v })),
  };
  const last = await prisma.invoice.findFirst({ where: { clientId: client.id }, orderBy: { seq: "desc" } });
  const seq = (last?.seq || 0) + 1;
  const mNum = MONTH_NUM[month] || 1;
  // Year for the invoice number = the billing month's calendar year (Apr–Dec = FY start year; Jan–Mar = next).
  const fyStart = (() => { const m = /FY(\d{2})/i.exec(fiscalYear || ""); return m ? 2000 + Number(m[1]) : new Date().getFullYear(); })();
  const yr = mNum >= 4 ? fyStart : fyStart + 1;
  // Invoice NAME format — default GA-{ProjectCode}-{Month}. If the project's "add resource name"
  // is on, append -{ResourceName} (first billable resource's first name on a consolidated invoice).
  const firstRes = (lines[0]?.resourceName || "").split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  let fmt = (srcProj?.invoiceNoFormat && String(srcProj.invoiceNoFormat).trim()) ? String(srcProj.invoiceNoFormat).trim() : "{InvoiceCode}{Year}{Month}";
  if (srcProj?.invoiceNameIncludeResource && !/\{ResourceName\}/i.test(fmt)) fmt += "-{ResourceName}";
  let invoiceNo = applyInvoiceNoFormat(fmt, {
    invoiceCode: srcProj?.invoiceCode || srcProj?.code || client.code, projectCode: srcProj?.code || client.code, clientCode: client.code, year: yr,
    month, mmm: month.toUpperCase(), mm: String(mNum).padStart(2, "0"), resourceName: firstRes,
  });
  if (await prisma.invoice.findUnique({ where: { invoiceNo } })) invoiceNo = `${invoiceNo}-${String(seq).padStart(2, "0")}`;
  const invoiceDate = new Date();
  const dueDate = new Date(invoiceDate.getTime() + ((srcProj?.paymentTermsDays ?? client.paymentTermsDays) || 30) * 86400000);
  return {
    clientId: client.id, fiscalYear, month, seq, invoiceNo,
    subProjectId: subProj?.id || null,
    invoiceDate: invoiceDate.toISOString(), dueDate: dueDate.toISOString(),
    billingPeriodStart: new Date(yr, mNum - 1, 1).toISOString(), billingPeriodEnd: new Date(yr, mNum, 0).toISOString(),
    // Auto-filled from the project (editable per invoice). A Sub-Project's own PO/Code/Description —
    // the "remembered" per-resource settings — win over the parent Project's when one's selected.
    // Contacts fall back to the client during transition.
    poNumber: subProj?.poNumber || srcProj?.poNumber || "",
    customerRefNo: subProj?.customerRefNo || srcProj?.customerRefNo || "",
    paymentTerms: srcProj?.paymentTerms || "",
    projectCode: subProj?.code || srcProj?.code || "",
    projectTitle: subProj?.title || srcProj?.title || "",
    projectDescription: (subProj?.description && subProj.description.trim()) ? subProj.description
      : (srcProj?.description && srcProj.description.trim()) ? srcProj.description : "Professional Services",
    billingEmail: client.email || "",
    ccEmail: client.ccEmail || "",
    bccEmail: client.bccEmail || "",
    addressTo: client.addressTo || "AP Team",
    attentionContact: subProj?.attentionContact || srcProj?.attentionContact || client.attentionContact || "",
    billToAddress: srcProj?.billToAddress || client.billToAddress || "",
    annexureHideLeaveRate: !!srcProj?.annexureHideLeaveRate, annexureHideLeave: !!(srcProj?.annexureHideLeave || srcProj?.annexureHideLeaveRate), annexureHideBillRate: !!(srcProj?.annexureHideBillRate || srcProj?.annexureHideLeaveRate),
    annexureHideHours: !!srcProj?.annexureHideHours, annexureHideRole: !!srcProj?.annexureHideRole, annexureHide: !!srcProj?.annexureHide,
    lineItemsHideHours: !!srcProj?.lineItemsHideHours, lineItemsHideRate: !!srcProj?.lineItemsHideRate, lineItemsDayBasis: !!srcProj?.lineItemsDayBasis, lineItemsPerResource: perResource, lineItemsSumAll: sumAll,
    annexureDayBasis: !!srcProj?.annexureDayBasis, annexureHpd: hpd, annexureSumTotal: !!srcProj?.annexureSumTotal, lineItemsAddGst: !!srcProj?.lineItemsAddGst, gstPercent: srcProj?.gstPercent ?? 5, gstExclusive: !!(srcProj as any)?.gstExclusive,
    // Description / resource-column settings — remembered on the PROJECT (auto-written back on
    // every Preview / Generate) so they never need re-selecting month to month.
    lineItemsShowDesc: !!(srcProj as any)?.lineItemsShowDesc, lineItemsMergeDesc: !!(srcProj as any)?.lineItemsMergeDesc, lineItemsDesc: (srcProj as any)?.lineItemsDesc || "",
    lineItemsShowResource: !!(srcProj as any)?.lineItemsShowResource, lineItemsHideRole: !!(srcProj as any)?.lineItemsHideRole, lineItemsSumTotal: !!(srcProj as any)?.lineItemsSumTotal,
    columnLabels: (() => { try { return (srcProj as any)?.columnLabels ? JSON.parse((srcProj as any).columnLabels) : {}; } catch { return {}; } })(),
    layoutId: srcProj?.invoiceLayoutId || (await prisma.invoiceLayout.findFirst({ where: { isDefault: true } }))?.id || null,
    currency: ccy, templateId: await resolveInvoiceTemplateId(client, proj), lineItems, annexure, totalAmount: total, diag,
  };
}
const num = (v: any) => { const n = +v; return Number.isFinite(n) ? n : 0; };
const sanitizeLineItems = (arr: any[]) => (arr || []).map((x) => ({ description: String(x.description || "").slice(0, 300), resourceName: x.resourceName && String(x.resourceName).trim() ? String(x.resourceName).trim().slice(0, 200) : null, detail: x.detail && String(x.detail).trim() ? String(x.detail).trim().slice(0, 500) : null, rateUsd: num(x.rateUsd), hours: num(x.hours), dayRate: x.dayRate != null ? num(x.dayRate) : null, days: x.days != null ? num(x.days) : null, amount: num(x.amount) }));
const sanitizeAnnexure = (arr: any[]) => (arr || []).map((x) => ({ resourceName: String(x.resourceName || "").slice(0, 200), role: x.role && String(x.role).trim() ? String(x.role).trim().slice(0, 190) : null, leave: x.leave ? String(x.leave) : null, billRate: num(x.billRate), hours: num(x.hours), dayRate: x.dayRate != null ? num(x.dayRate) : null, days: x.days != null ? num(x.days) : null, timeLoggedOn: x.timeLoggedOn ? String(x.timeLoggedOn).slice(0, 190) : null, amount: num(x.amount), lineId: x.lineId != null && Number.isFinite(Number(x.lineId)) ? Number(x.lineId) : null }));

// Editable draft for the UI (no DB writes).
router.get("/draft", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const fiscalYear = (req.query.fiscalYear as string) || "FY26-27";
  const client = await prisma.client.findUnique({ where: { id: Number(req.query.clientId) }, include: { projects: true } });
  if (!client) return res.status(404).json({ error: "Client not found" });
  res.json(await buildInvoiceDraft(client, fiscalYear, String(req.query.month), req.query.project, req.query.subProjectId));
});

// Sub-Projects of whichever real Project record matches the chosen name — drives the optional
// "Sub-Project" picker on Prepare Invoice (per-resource/per-cost-center invoicing). Empty array
// when the project has none defined — existing combined-invoice behavior is unaffected.
router.get("/sub-project-options", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const clientId = Number(req.query.clientId);
  const projectName = String(req.query.project || "");
  if (!clientId || !projectName) return res.json([]);
  const proj = await prisma.project.findFirst({ where: { clientId, name: projectName } });
  if (!proj) return res.json([]);
  res.json(await prisma.subProject.findMany({ where: { projectId: proj.id, status: "ACTIVE" }, orderBy: { name: "asc" } }));
});

// Distinct billable project-name groups for a client+month (drives the Invoices Project dropdown,
// since lines may sit under a sub-project or the client-level name).
router.get("/projects", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const fiscalYear = (req.query.fiscalYear as string) || "FY26-27";
  const client = await prisma.client.findUnique({ where: { id: Number(req.query.clientId) }, include: { projects: true } });
  if (!client) return res.status(404).json({ error: "Client not found" });
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: String(req.query.month) } }, include: { lines: true } });
  const allNames = new Set([client.name, ...client.projects.map((p: any) => p.name)]);
  const byProj: Record<string, { name: string; billedLines: number; amount: number }> = {};
  for (const l of (sheet?.lines || [])) {
    if (l.isExpense || l.invoiceAmount <= 0 || !l.projectName || !allNames.has(l.projectName)) continue;
    byProj[l.projectName] = byProj[l.projectName] || { name: l.projectName, billedLines: 0, amount: 0 };
    byProj[l.projectName].billedLines++; byProj[l.projectName].amount += l.invoiceAmount;
  }
  res.json(Object.values(byProj).map((g) => ({ ...g, projectId: client.projects.find((p: any) => p.name === g.name)?.id || null })));
});

// Render a PDF of the (possibly edited) draft WITHOUT saving — for on-screen preview.
// Remember every invoice-page option on the source PROJECT (the one matching the chosen project
// name), so the next month's draft opens with the same checkboxes — no re-selecting. Called on
// every Preview and Generate. (annexureHpd is NOT written back: Project.billingHoursPerDay also
// drives the monthly billing derivation and must not change as an invoice side effect.)
async function rememberInvoiceOptions(client: any, projectName: any, b: any): Promise<void> {
  const proj = projectName ? client.projects.find((p: any) => p.name === String(projectName)) : null;
  if (!proj) return;
  await prisma.project.update({ where: { id: proj.id }, data: {
    annexureHideLeaveRate: !!b.annexureHideLeaveRate, annexureHideLeave: !!b.annexureHideLeave, annexureHideBillRate: !!b.annexureHideBillRate,
    annexureHideHours: !!b.annexureHideHours, annexureHideRole: !!b.annexureHideRole, annexureHide: !!b.annexureHide,
    lineItemsHideHours: !!b.lineItemsHideHours, lineItemsHideRate: !!b.lineItemsHideRate, lineItemsDayBasis: !!b.lineItemsDayBasis,
    ...(b.lineItemsPerResource !== undefined ? { lineItemsPerResource: !!b.lineItemsPerResource } : {}),
    ...(b.lineItemsSumAll !== undefined ? { lineItemsSumAll: !!b.lineItemsSumAll } : {}),
    annexureDayBasis: !!b.annexureDayBasis, annexureSumTotal: !!b.annexureSumTotal,
    lineItemsAddGst: !!b.lineItemsAddGst, gstExclusive: !!b.gstExclusive, ...(b.gstPercent != null ? { gstPercent: +b.gstPercent } : {}),
    lineItemsShowDesc: !!b.lineItemsShowDesc, lineItemsMergeDesc: !!b.lineItemsMergeDesc,
    lineItemsDesc: b.lineItemsDesc && String(b.lineItemsDesc).trim() ? String(b.lineItemsDesc).trim() : null,
    lineItemsShowResource: !!b.lineItemsShowResource, lineItemsHideRole: !!b.lineItemsHideRole, lineItemsSumTotal: !!b.lineItemsSumTotal,
    ...(b.columnLabels !== undefined ? (() => { const cl = sanitizeColumnLabels(b.columnLabels); return { columnLabels: Object.keys(cl).length ? JSON.stringify(cl).slice(0, 4000) : null }; })() : {}),
    ...(b.layoutId ? { invoiceLayoutId: Number(b.layoutId) } : {}),
  } }).catch(() => { /* remembering is best-effort — never block the invoice */ });
}

// Wizard "Save as project defaults": store every option on the PROJECT without generating anything.
router.post("/remember", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const b = req.body || {};
  const client = await prisma.client.findUnique({ where: { id: Number(b.clientId) }, include: { projects: true } });
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (!b.project) return res.status(400).json({ error: "Project is required" });
  await rememberInvoiceOptions(client, b.project, b);
  res.json({ ok: true });
});

router.post("/preview-pdf", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const b = req.body || {};
  const client = await prisma.client.findUnique({ where: { id: Number(b.clientId) }, include: { projects: true } });
  if (!client) return res.status(404).json({ error: "Client not found" });
  const templateId = b.templateId || await resolveInvoiceTemplateId(client, b.project);
  const template = templateId ? await prisma.invoiceTemplate.findUnique({ where: { id: Number(templateId) } }) : null;
  const lineItems = sanitizeLineItems(b.lineItems);
  const annexure = sanitizeAnnexure(b.annexure);
  if (!b.skipRemember) await rememberInvoiceOptions(client, b.project, b);
  const inv = {
    client, template, currency: b.currency || client.projects.find((p: any) => p.name === String(b.project))?.currency || client.currency,
    invoiceNo: b.invoiceNo || "DRAFT-PREVIEW", invoiceDate: b.invoiceDate ? new Date(b.invoiceDate) : new Date(),
    dueDate: b.dueDate ? new Date(b.dueDate) : new Date(),
    billingPeriodStart: b.billingPeriodStart ? new Date(b.billingPeriodStart) : null,
    billingPeriodEnd: b.billingPeriodEnd ? new Date(b.billingPeriodEnd) : null,
    poNumber: b.poNumber || null, customerRefNo: b.customerRefNo || null,
    paymentTerms: b.paymentTerms || null,
    projectCode: b.projectCode || null, projectTitle: b.projectTitle || null,
    projectDescription: b.projectDescription || "Professional Services",
    addressTo: b.addressTo || null, attentionContact: b.attentionContact || null, billToAddress: b.billToAddress || null,
    annexureHideLeaveRate: !!b.annexureHideLeaveRate, annexureHideLeave: !!b.annexureHideLeave, annexureHideBillRate: !!b.annexureHideBillRate, annexureHideHours: !!b.annexureHideHours, annexureHideRole: !!b.annexureHideRole, annexureHide: !!b.annexureHide, lineItemsHideHours: !!b.lineItemsHideHours, lineItemsHideRate: !!b.lineItemsHideRate, lineItemsDayBasis: !!b.lineItemsDayBasis, annexureDayBasis: !!b.annexureDayBasis, annexureSumTotal: !!b.annexureSumTotal, lineItemsAddGst: !!b.lineItemsAddGst, gstPercent: b.gstPercent != null ? +b.gstPercent : 5, gstExclusive: !!b.gstExclusive,
    lineItemsShowDesc: !!b.lineItemsShowDesc, lineItemsMergeDesc: !!b.lineItemsMergeDesc, lineItemsDesc: b.lineItemsDesc && String(b.lineItemsDesc).trim() ? String(b.lineItemsDesc).trim() : null,
    lineItemsShowResource: !!b.lineItemsShowResource, lineItemsHideRole: !!b.lineItemsHideRole, lineItemsSumTotal: !!b.lineItemsSumTotal,
    columnLabels: sanitizeColumnLabels(b.columnLabels),
    totalAmount: (() => { const t = lineItems.reduce((s, x) => s + x.amount, 0); return b.lineItemsAddGst && b.gstExclusive ? Math.round(t * (1 + (b.gstPercent != null ? +b.gstPercent : 5) / 100) * 100) / 100 : t; })(), lineItems, annexure,
  };
  const layoutCfg = b.layout || parseLayout(await resolveLayoutConfig({ layoutId: b.layoutId }));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="invoice-draft-preview.pdf"`);
  renderInvoicePdf(inv, res, layoutCfg);
});

router.get("/:id", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: Number(req.params.id) },
    include: { client: true, lineItems: true, annexure: true, template: true },
  });
  if (!inv) return res.status(404).json({ error: "Not found" });
  res.json(inv);
});

/** Generate (commit) an invoice. Uses the client's EDITED draft (line items / annexure / details)
 *  when supplied; otherwise builds it from the month's billable lines. Always created as DRAFT;
 *  never emails anyone. */
router.post("/generate", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const b = req.body || {};
  const fiscalYear = b.fiscalYear || "FY26-27";
  const client = await prisma.client.findUnique({ where: { id: Number(b.clientId) }, include: { projects: true, invoiceTemplate: true } });
  if (!client) return res.status(404).json({ error: "Client not found" });

  // A LOCKED month is frozen — no invoices may be generated for it until it is unlocked.
  if (b.month) {
    const genSheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: String(b.month) } } });
    if (genSheet?.status === "LOCKED") return res.status(423).json({ error: `${b.month} ${fiscalYear} is locked — unlock the month to generate invoices.` });
  }

  // Edited draft wins (user reviewed/changed it); else compute from the month.
  const draft = (Array.isArray(b.lineItems) && b.lineItems.length)
    ? b
    : await buildInvoiceDraft(client, fiscalYear, b.month, b.project, b.subProjectId);
  const lineItems = sanitizeLineItems(draft.lineItems);
  const annexure = sanitizeAnnexure(draft.annexure);
  if (!lineItems.length) return res.status(400).json({ error: "No line items to invoice — add at least one line or pick a month with billable hours." });
  // GST modes: INCLUDE (default) — GST is embedded in the amounts and backed out for display, so the
  // grand total equals the subtotal; EXCLUDE (gstExclusive) — GST is added ON TOP of the subtotal.
  const subTotal = lineItems.reduce((s, x) => s + x.amount, 0);
  const total = b.lineItemsAddGst && b.gstExclusive ? Math.round(subTotal * (1 + (b.gstPercent != null ? +b.gstPercent : 5) / 100) * 100) / 100 : subTotal;

  // Server-authoritative sequential seq; allow an edited invoiceNo but keep it unique.
  const last = await prisma.invoice.findFirst({ where: { clientId: client.id }, orderBy: { seq: "desc" } });
  const seq = (last?.seq || 0) + 1;
  const yr = new Date().getFullYear();
  const userSpecifiedInvoiceNo = !!(b.invoiceNo && String(b.invoiceNo).trim());
  let invoiceNo = (userSpecifiedInvoiceNo ? String(b.invoiceNo).trim() : `GA/${yr}/${client.code}-${b.month}`).toUpperCase(); // always all-caps
  const existingWithNo = await prisma.invoice.findUnique({ where: { invoiceNo } });
  if (existingWithNo) {
    if (userSpecifiedInvoiceNo) {
      // A number HR explicitly typed must be used exactly as given, never silently suffixed —
      // confirm with the client first; only actually replace the existing invoice once
      // `overrideExisting` comes back true. Everything it owns (line items, annexure,
      // attachments) cascade-deletes with it (see schema), so this is a clean full replacement.
      if (!b.overrideExisting) {
        return res.status(409).json({ error: `Invoice number ${invoiceNo} already exists. Do you want to override it?` });
      }
      await prisma.invoice.delete({ where: { id: existingWithNo.id } });
    } else {
      // Auto-generated default number collided — keep the existing silent-suffix behavior,
      // since HR never typed a specific number they'd expect used exactly.
      invoiceNo = `${invoiceNo}-${String(seq).padStart(2, "0")}`;
    }
  }

  // Currency + payment terms come from the invoiced PROJECT (fall back to client for legacy data).
  const genProj = b.project ? client.projects.find((p: any) => p.name === String(b.project)) : null;
  const genCcy = b.currency || genProj?.currency || client.currency;
  const invoiceDate = b.invoiceDate ? new Date(b.invoiceDate) : new Date();
  const dueDate = b.dueDate ? new Date(b.dueDate) : new Date(invoiceDate.getTime() + ((genProj?.paymentTermsDays ?? client.paymentTermsDays) || 30) * 86400000);
  const mNum = MONTH_NUM[b.month] || 1;

  const inv = await prisma.invoice.create({
    data: {
      clientId: client.id, invoiceNo, seq, invoiceDate, dueDate,
      billingPeriodStart: b.billingPeriodStart ? new Date(b.billingPeriodStart) : new Date(yr, mNum - 1, 1),
      billingPeriodEnd: b.billingPeriodEnd ? new Date(b.billingPeriodEnd) : new Date(yr, mNum, 0),
      poNumber: b.poNumber || null, customerRefNo: b.customerRefNo || null,
      paymentTerms: b.paymentTerms || null,
      // projectId is the durable link (the actual Project chosen in the dropdown) — set whenever
      // one was resolved, independent of whether the editable text snapshot below is blank.
      projectId: genProj?.id ?? null,
      subProjectId: b.subProjectId ? Number(b.subProjectId) : (draft.subProjectId ?? null),
      projectCode: b.projectCode || genProj?.code || null, projectTitle: b.projectTitle || genProj?.title || null,
      projectDescription: b.projectDescription ?? "Professional Services",
      billingEmail: b.billingEmail || null, ccEmail: b.ccEmail || null, bccEmail: b.bccEmail || null, addressTo: b.addressTo || null,
      attentionContact: b.attentionContact || null, billToAddress: b.billToAddress || null,
      annexureHideLeaveRate: !!b.annexureHideLeaveRate, annexureHideLeave: !!b.annexureHideLeave, annexureHideBillRate: !!b.annexureHideBillRate, annexureHideHours: !!b.annexureHideHours, annexureHideRole: !!b.annexureHideRole, annexureHide: !!b.annexureHide, lineItemsHideHours: !!b.lineItemsHideHours, lineItemsHideRate: !!b.lineItemsHideRate, lineItemsDayBasis: !!b.lineItemsDayBasis, annexureDayBasis: !!b.annexureDayBasis, annexureSumTotal: !!b.annexureSumTotal, lineItemsAddGst: !!b.lineItemsAddGst, gstPercent: b.gstPercent != null ? +b.gstPercent : 5, gstExclusive: !!b.gstExclusive,
      lineItemsShowDesc: !!b.lineItemsShowDesc, lineItemsMergeDesc: !!b.lineItemsMergeDesc, lineItemsDesc: b.lineItemsDesc && String(b.lineItemsDesc).trim() ? String(b.lineItemsDesc).trim() : null,
      lineItemsShowResource: !!b.lineItemsShowResource, lineItemsHideRole: !!b.lineItemsHideRole, lineItemsSumTotal: !!b.lineItemsSumTotal,
      columnLabels: (() => { const cl = sanitizeColumnLabels(b.columnLabels); return Object.keys(cl).length ? JSON.stringify(cl).slice(0, 4000) : null; })(),
      layoutConfig: b.layout ? JSON.stringify(b.layout) : await resolveLayoutConfig({ layoutId: b.layoutId }),
      currency: genCcy, totalAmount: total, status: "DRAFT",
      month: b.month || null, fiscalYear,
      templateId: b.templateId ? Number(b.templateId) : await resolveInvoiceTemplateId(client, b.project),
      lineItems: { create: lineItems },
      annexure: { create: annexure },
    },
    include: { lineItems: true, annexure: true, client: true },
  });
  await rememberInvoiceOptions(client, b.project, b);
  // Sync the ACTUALLY-invoiced amount (possibly hand-overridden in the Line Items table, e.g.
  // 8400 -> 8000 with hours left unchanged) back onto the originating MonthlyLine's
  // invoiceAmount — so Monthly Forecast & Actuals reflects what was really billed, not the
  // pre-override computed figure. Per-resource line items carry `lineId` (see
  // buildInvoiceDraft's perResource branch above); grouped/summed modes don't map 1:1 to a
  // single resource, so they're intentionally left alone here.
  // The Line Items amount shown/edited on screen is already in the invoice's billing currency
  // (genCcy — buildInvoiceDraft's toCcy converts USD -> CAD for display on a CAD project), but
  // MonthlyLine.invoiceAmount must always be stored in USD (toCcy converts it back to CAD again
  // every time the forecast is read) — so a CAD-billed invoice's synced amount must be converted
  // BACK to USD here, or it silently drifts further CAD-ward every time this runs.
  const rawDraftItems: any[] = Array.isArray(draft.lineItems) ? draft.lineItems : [];
  const syncs = rawDraftItems
    .map((x, i) => ({ lineId: x?.lineId != null ? Number(x.lineId) : null, amount: lineItems[i]?.amount }))
    .filter((s) => s.lineId != null && Number.isFinite(s.amount));
  if (syncs.length) {
    const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
    let syncUsdAmounts = syncs.map((s) => s.amount as number);
    if (String(genCcy) === "CAD") {
      const fx = await prisma.fxRate.findFirst({ where: { context: "CANADA_FACTOR" }, orderBy: { effectiveFrom: "desc" } });
      const cadFactor = fx?.rate || 0.71;
      syncUsdAmounts = syncUsdAmounts.map((a) => r2(a * cadFactor));
    }
    await Promise.all(syncs.map((s, i) =>
      prisma.monthlyLine.update({ where: { id: s.lineId as number }, data: { invoiceAmount: syncUsdAmounts[i] } }).catch(() => {})
    ));
  }
  res.status(201).json(inv);
});

// Approve & Save: write the (edited) Annexure hours back to the month's resource lines as
// Actual/Billable Hours — recomputing the Actual Invoice amount and the hourly-CTC cost — so the
// Monthly Forecast & Actuals updates, exactly like Finance approving a timesheet. Pre-generation.
router.post("/approve-hours", requireAdmin, requirePermission("invoices-generate"), async (req, res) => {
  const b = req.body || {};
  const fiscalYear = b.fiscalYear || "FY26-27";
  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month: b.month } } });
  if (!sheet) return res.status(404).json({ error: "Monthly sheet not found for that month." });
  if (sheet.status === "LOCKED") return res.status(400).json({ error: `${b.month} is locked — unlock it to update hours.` });
  const round2 = (n: number) => Math.round((n || 0) * 100) / 100;
  const client = b.clientId ? await prisma.client.findUnique({ where: { id: Number(b.clientId) }, select: { currency: true } }) : null;
  let cadFactor: number | null = null;
  const getCadFactor = async () => {
    if (cadFactor == null) { const fx = await prisma.fxRate.findFirst({ where: { context: "CANADA_FACTOR" }, orderBy: { effectiveFrom: "desc" } }); cadFactor = fx?.rate || 0.71; }
    return cadFactor;
  };
  let updated = 0;
  for (const row of (b.annexure || [])) {
    if (!row || row.lineId == null) continue; // only rows tied to an existing monthly line
    const line = await prisma.monthlyLine.findUnique({ where: { id: Number(row.lineId) }, include: { project: { select: { currency: true } } } });
    if (!line || line.monthlySheetId !== sheet.id || line.isExpense) continue;
    const hours = +row.hours || 0;
    // Prefer the Amount actually shown/edited in the Annexure (always kept current — auto-recomputed
    // on a rate/hours edit, or directly typed as an override) over re-deriving it from the line's
    // STORED rate — using the stored rate here would silently discard a rate edit or a direct amount
    // override the moment Approve & Save Hours is clicked, before Generate is even reachable.
    // That displayed Amount is in the PROJECT's billing currency (buildInvoiceDraft's toCcy
    // converts USD -> CAD for a CAD project), but MonthlyLine.invoiceAmount must always be stored
    // in USD — convert back here, or a CAD project's amount compounds further CAD-ward every save.
    const lineCcy = line.project?.currency || client?.currency || "USD";
    const invoiceAmount = row.amount != null && Number.isFinite(+row.amount)
      ? round2(+row.amount * (String(lineCcy) === "CAD" ? await getCadFactor() : 1))
      : round2((line.rateUsd || 0) * hours * (line.fxMultiplier || 1) + (line.adjustment || 0));
    let costUsd = line.costUsd;
    if (line.employeeId) {
      const c: any = await computeEmployeeCost(line.employeeId);
      if (c && (c.usEngagement === "VENDOR" || c.usEngagement === "W2_NO_BENEFIT") && c.hourlyCostUsd > 0) {
        costUsd = round2(c.hourlyCostUsd * hours + (line.doubleDipIncentive || 0) + (line.bonus || 0));
      }
    }
    await prisma.monthlyLine.update({ where: { id: line.id }, data: { actualHours: hours, invoiceAmount, costUsd } });
    updated++;
  }
  res.json({ updated, month: b.month });
});

router.put("/:id/status", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  res.json(await prisma.invoice.update({ where: { id: Number(req.params.id) }, data: { status: req.body.status } }));
});

/** Delete an invoice (lineItems & annexure cascade-delete per schema). */
router.delete("/:id", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  await prisma.invoice.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// Upload one or more extra supporting documents (e.g. a timesheet) directly to an invoice,
// independent of sending an email — available from the Generated Invoices table at any time,
// before or after the invoice has been sent. Returns the invoice's full current attachment list
// (no fileData — keep it light, same shape GET / already includes per invoice).
router.post("/:id/attachments", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const invoiceId = Number(req.params.id);
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return res.status(404).json({ error: "Not found" });
  const files: { fileName: string; contentType?: string; fileData: string }[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (files.length) {
    await prisma.invoiceAttachment.createMany({
      data: files.map((a) => ({ invoiceId, fileName: a.fileName, contentType: a.contentType || null, fileData: a.fileData, uploadedById: req.user!.id })),
    });
    await prisma.auditLog.create({
      data: { userId: req.user!.id, action: "UPLOAD_INVOICE_ATTACHMENT", entity: "Invoice", entityId: String(invoiceId), after: { fileNames: files.map((a) => a.fileName) } },
    }).catch(() => {});
  }
  const attachments = await prisma.invoiceAttachment.findMany({ where: { invoiceId }, select: { id: true, fileName: true, contentType: true, uploadedAt: true }, orderBy: { uploadedAt: "asc" } });
  res.json({ attachments });
});

router.get("/:id/pdf", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: Number(req.params.id) },
    include: { client: true, lineItems: true, annexure: true, template: true },
  });
  if (!inv) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${inv.invoiceNo.replace(/\//g, "_")}.pdf"`);
  renderInvoicePdf(inv, res, parseLayout((inv as any).layoutConfig));
});

// Map a Geography.code to an EmailTemplate geography bucket.
function geoBucket(code?: string | null): "US" | "CANADA" | "INDIA" {
  const c = (code || "").toUpperCase();
  if (c === "CANADA") return "CANADA";
  if (c === "INDIA") return "INDIA";
  return "US";
}

const MON_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
// The invoice's own `month`/`fiscalYear` snapshot (set at generation time, used elsewhere for
// grouping/bulk email) is the authoritative billing period — NOT `invoiceDate` (when it was
// actually generated/issued, which can be weeks or months after the billing period it's for) and
// not even `billingPeriodStart` alone (only `month`+`fiscalYear` together correctly resolve the
// calendar year for Jan-Mar, which belong to the FOLLOWING calendar year of their fiscal year).
function invoiceMonthsStr(inv: any): string {
  if (inv.month && MONTH_NUM[inv.month]) {
    const mNum = MONTH_NUM[inv.month];
    const fyMatch = /FY(\d{2})/i.exec(inv.fiscalYear || "");
    const fyStart = fyMatch ? 2000 + Number(fyMatch[1]) : new Date().getFullYear();
    const yr = mNum >= 4 ? fyStart : fyStart + 1;
    return `${MON_FULL[mNum - 1]} ${yr}`;
  }
  // Legacy fallback for any invoice predating the `month`/`fiscalYear` snapshot fields.
  const d = inv.billingPeriodStart ? new Date(inv.billingPeriodStart) : (inv.invoiceDate ? new Date(inv.invoiceDate) : null);
  return d ? `${MON_FULL[d.getMonth()]} ${d.getFullYear()}` : "";
}

// Resolve the GenAquarius logo from whatever ships with the build (bundled assets first, then the
// client build) — works locally and on the Linux App Service. Returns a base64 data URI or null.
const LOGO_CANDIDATES = [
  path.resolve(__dirname, "../../assets/genaquarius.png"),
  path.resolve(__dirname, "../../client-dist/genaquarius.png"),
  path.resolve(process.cwd(), "assets/genaquarius.png"),
  path.resolve(process.cwd(), "client-dist/genaquarius.png"),
];
function logoDataUri(): string | null {
  for (const p of LOGO_CANDIDATES) {
    try { if (fs.existsSync(p)) return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`; } catch { /* try next */ }
  }
  return null;
}

/** Collect a PDF stream into a single Buffer using an in-memory Writable. */
function renderInvoicePdfToBuffer(inv: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    sink.on("finish", () => resolve(Buffer.concat(chunks)));
    sink.on("error", reject);
    try { renderInvoicePdf(inv, sink, parseLayout((inv as any).layoutConfig)); } catch (e) { reject(e); }
  });
}

// Recipients come from the client's AP/billing Email field (add/edit Client) — which may hold
// several addresses separated by commas/semicolons, each optionally in "Display Name <email>"
// form (Outlook/Graph itself writes addresses that way, and it's easy to paste in). Microsoft
// Graph's sendMail needs a BARE address in `emailAddress.address` — passing the whole "Name
// <email>" string there fails with "Recipient '...' is not resolved", so strip the wrapper here,
// once, for every TO/CC/BCC source (client-stored or typed into the preview) in one place.
const splitEmails = (s: any): string[] => String(s ?? "").split(/[,;\n]+/).map((x: string) => {
  const t = x.trim();
  const m = /<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(t);
  return (m ? m[1] : t).trim();
}).filter(Boolean);
// Invoice email recipients come from the CLIENT (TO/CC/BCC + greeting), then any explicit override.
function recipientsFor(inv: any, body: any): string[] {
  return splitEmails(body?.to ?? inv.client?.email ?? inv.billingEmail);
}
function ccFor(inv: any, body: any): string[] {
  return splitEmails(body?.cc ?? inv.client?.ccEmail ?? inv.ccEmail);
}
function bccFor(inv: any, body: any): string[] {
  return splitEmails(body?.bcc ?? inv.client?.bccEmail ?? inv.bccEmail);
}
// Render the drafted invoice email (recipients + subject + HTML body from the Email Template) —
// shared by the on-screen preview and the downloadable Outlook (.eml) draft. No sending.
async function renderInvoiceEmail(inv: any, body: any): Promise<{ recipients: string[]; cc: string[]; bcc: string[]; subject: string; html: string; tpl: any; fileName: string } | { error: string }> {
  const recipients = recipientsFor(inv, body);
  const cc = ccFor(inv, body);
  const bcc = bccFor(inv, body);
  // Template precedence: explicit → a template "Used By" one of the client's projects → the
  // client geography's default → any default → any template at all (so it never hard-fails).
  let tpl: any = null;
  if (body?.templateId) tpl = await prisma.emailTemplate.findUnique({ where: { id: Number(body.templateId) } });
  if (!tpl) tpl = await prisma.emailTemplate.findFirst({ where: { projects: { some: { clientId: inv.clientId } } }, orderBy: { isDefault: "desc" } });
  if (!tpl) {
    const bucket = geoBucket(inv.client?.geography?.code);
    tpl = await prisma.emailTemplate.findFirst({ where: { geography: bucket, isDefault: true } })
      || await prisma.emailTemplate.findFirst({ where: { geography: bucket } })
      || await prisma.emailTemplate.findFirst({ where: { isDefault: true } })
      || await prisma.emailTemplate.findFirst({});
  }
  if (!tpl) return { error: "No email template exists yet. Create one in Invoice & Templates → Email Templates." };
  const contactName = inv.client?.addressTo || inv.addressTo || inv.client?.attentionContact || inv.attentionContact || inv.client?.name || "there";
  const months = invoiceMonthsStr(inv);
  const projectName = inv.projectTitle || inv.client?.projects?.[0]?.name || inv.client?.name || "";
  // Substitute placeholders — supports {{contactName}}/{{invoiceMonths}} and the friendlier
  // {Month}, {Project Name}, {Invoice No}, {Client} (single or double braces, case-insensitive).
  const sub = (s: string) => (s || "")
    .replace(/\{\{?\s*contactName\s*\}?\}/gi, contactName)
    .replace(/\{\{?\s*invoiceMonths\s*\}?\}/gi, months)
    .replace(/\{\{?\s*month\s*\}?\}/gi, months)
    .replace(/\{\{?\s*project\s*name\s*\}?\}/gi, projectName)
    .replace(/\{\{?\s*invoice\s*no\.?\s*\}?\}/gi, inv.invoiceNo || "")
    .replace(/\{\{?\s*address\s*to\s*\}?\}/gi, inv.client?.addressTo || inv.addressTo || "")
    .replace(/\{\{?\s*client\s*\}?\}/gi, inv.client?.name || "");
  const toHtml = (s: string) => sub(s).replace(/\n/g, "<br>");
  let html = `<div>${toHtml(tpl.body)}</div>`;
  if (tpl.signature) html += `<br><div>${toHtml(tpl.signature)}</div>`;
  if (tpl.showLogo) { const uri = logoDataUri(); if (uri) html += `<br><div><img src="${uri}" alt="GenAquarius" style="max-width:200px"></div>`; }
  const fileName = `${(inv.invoiceNo || `invoice-${inv.id}`).replace(/\//g, "_")}.pdf`;
  // Subject from the template (with placeholders); fall back to a sensible default.
  const subject = (tpl.subject && String(tpl.subject).trim()) ? sub(tpl.subject) : `Invoice ${inv.invoiceNo}`;
  return { recipients, cc, bcc, subject, html, tpl, fileName };
}

// Build an Outlook-openable .eml draft: To pre-filled, body from the template, invoice PDF
// attached. `X-Unsent: 1` makes Outlook open it as an editable draft with a Send button — so the
// USER sends from their own Outlook; the app never sends anything itself.
function buildEml(to: string[], cc: string[], bcc: string[], subject: string, html: string, pdf: Buffer, fileName: string, extra: { fileName: string; contentType?: string; fileData: string }[] = []): string {
  const boundary = "GA_INVOICE_EML_BOUNDARY";
  const wrap = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");
  const head = [
    "X-Unsent: 1",
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");
  const parts = [
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(html, "utf8").toString("base64")),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${fileName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${fileName}"`,
    "",
    wrap(pdf.toString("base64")),
  ];
  for (const a of extra) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || "application/octet-stream"}; name="${a.fileName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.fileName}"`,
      "",
      wrap(a.fileData),
    );
  }
  parts.push(`--${boundary}--`, "");
  return `${head}\r\n\r\n${parts.join("\r\n")}`;
}

// Preview the drafted email (recipients + subject + rendered body + attachment) WITHOUT sending.
router.post("/:id/email-preview", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: Number(req.params.id) },
    include: { client: { include: { geography: true, projects: true } }, lineItems: true, annexure: true, template: true },
  });
  if (!inv) return res.status(404).json({ error: "Not found" });
  const r = await renderInvoiceEmail(inv, req.body);
  if ("error" in r) return res.status(400).json({ error: r.error });
  // Already-persisted extra attachments (e.g. a timesheet uploaded earlier, or kept from a prior
  // send) — shown in the preview's Additional Attachments picker alongside anything freshly
  // chosen, so nothing added once ever silently disappears from the preview again.
  const existingAttachments = await prisma.invoiceAttachment.findMany({ where: { invoiceId: inv.id }, select: { id: true, fileName: true, contentType: true, uploadedAt: true }, orderBy: { uploadedAt: "asc" } });
  res.json({ to: r.recipients.join(", "), cc: r.cc.join(", "), bcc: r.bcc.join(", "), recipients: r.recipients, subject: r.subject, html: r.html, attachment: r.fileName, templateName: r.tpl.name, existingAttachments });
});

// Download the Outlook draft (.eml) — opens in Outlook pre-addressed, body = template, PDF attached.
router.post("/:id/email-draft", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: Number(req.params.id) },
    include: { client: { include: { geography: true, projects: true } }, lineItems: true, annexure: true, template: true },
  });
  if (!inv) return res.status(404).json({ error: "Not found" });
  const r = await renderInvoiceEmail(inv, req.body);
  if ("error" in r) return res.status(400).json({ error: r.error });
  // Finance can edit the body in the preview before drafting/sending — an explicit `html` wins
  // over the freshly-rendered template body.
  const html = (typeof req.body?.html === "string" && req.body.html.trim()) ? req.body.html : r.html;
  const subject = (typeof req.body?.subject === "string" && req.body.subject.trim()) ? req.body.subject : r.subject;
  const to = (req.body?.to !== undefined ? splitEmails(req.body.to) : r.recipients);
  const cc = (req.body?.cc !== undefined ? splitEmails(req.body.cc) : r.cc);
  const bcc = (req.body?.bcc !== undefined ? splitEmails(req.body.bcc) : r.bcc);
  const pdf = await renderInvoicePdfToBuffer(inv);
  // Merge already-persisted attachments (so a draft always reflects whatever's on file for this
  // invoice, not just what was freshly picked in this one request) with any brand-new ones from
  // the client. Drafting never writes to InvoiceAttachment itself — only an actual Send does.
  const persistedRows = await prisma.invoiceAttachment.findMany({ where: { invoiceId: inv.id }, select: { fileName: true, contentType: true, fileData: true } });
  const persisted = persistedRows.map((a) => ({ fileName: a.fileName, contentType: a.contentType ?? undefined, fileData: a.fileData }));
  const fresh: { fileName: string; contentType?: string; fileData: string }[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const extra = [...persisted, ...fresh];
  const eml = buildEml(to, cc, bcc, subject, html, pdf, r.fileName, extra);
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "DRAFT_INVOICE_EMAIL", entity: "Invoice", entityId: String(inv.id),
      after: { to, cc, bcc, templateId: r.tpl.id, invoiceNo: inv.invoiceNo, subject, html, edited: html !== r.html || subject !== r.subject } },
  }).catch(() => {});
  res.setHeader("Content-Type", "message/rfc822");
  res.setHeader("Content-Disposition", `attachment; filename="${(inv.invoiceNo || `invoice-${inv.id}`).replace(/\//g, "_")}.eml"`);
  res.send(eml);
});

// Build an Outlook .eml with MULTIPLE PDF attachments (one bundled email for a client+month).
function buildEmlMulti(to: string[], cc: string[], bcc: string[], subject: string, html: string, attachments: { pdf: Buffer; fileName: string }[], extra: { fileName: string; contentType?: string; fileData: string }[] = []): string {
  const boundary = "GA_INVOICE_EML_BOUNDARY";
  const wrap = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");
  const head = [
    "X-Unsent: 1",
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");
  const parts: string[] = [
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(html, "utf8").toString("base64")),
  ];
  for (const a of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${a.fileName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.fileName}"`,
      "",
      wrap(a.pdf.toString("base64")),
    );
  }
  for (const a of extra) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || "application/octet-stream"}; name="${a.fileName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.fileName}"`,
      "",
      wrap(a.fileData),
    );
  }
  parts.push(`--${boundary}--`, "");
  return `${head}\r\n\r\n${parts.join("\r\n")}`;
}

// Load all GENERATED invoices for a client + billing month (the bundle for one bulk email).
// `selectedInvoiceIds`, when given, narrows that down to Finance's actual picked subset (the
// "send individually or as a group" picker on Email Invoices) — the base client+month+fiscalYear
// lookup stays the source of truth either way, so an id outside that scope is silently ignored
// rather than letting a stale/tampered id pull in an unrelated invoice.
async function bulkInvoicesFor(clientId: any, month: any, fiscalYear: any, selectedInvoiceIds?: any) {
  const invs = await prisma.invoice.findMany({
    where: { clientId: Number(clientId), month: String(month), ...(fiscalYear ? { fiscalYear: String(fiscalYear) } : {}) },
    include: { client: { include: { geography: true, projects: true } }, lineItems: true, annexure: true, template: true },
    orderBy: { seq: "asc" },
  });
  if (Array.isArray(selectedInvoiceIds) && selectedInvoiceIds.length) {
    const idSet = new Set(selectedInvoiceIds.map(Number));
    return invs.filter((i) => idSet.has(i.id));
  }
  return invs;
}

// Classifies a selected batch's attachments into SHARED (present on every invoice in the
// selection, by filename — added via the batch-level "+ Add shared attachment" picker or
// POST /bulk-attachments, which always fans an identical copy out to every invoice) vs.
// PER-INVOICE (present on fewer than all — added via the single-invoice Existing Invoice page's
// own InvoiceAttachmentsList, independent of any batch). A filename that happens to match by
// coincidence across every selected invoice is treated as shared; this is a heuristic, not a
// stored flag, since InvoiceAttachment has no "shared" column — acceptable because the only way
// a filename legitimately ends up on EVERY selected invoice today is the shared-upload fan-out.
async function classifyBatchAttachments(invs: any[]) {
  const rows = await prisma.invoiceAttachment.findMany({
    where: { invoiceId: { in: invs.map((i) => i.id) } },
    select: { id: true, invoiceId: true, fileName: true, contentType: true, fileData: true, uploadedAt: true },
    orderBy: { uploadedAt: "asc" },
  });
  const byInvoice = new Map<number, typeof rows>();
  for (const row of rows) { if (!byInvoice.has(row.invoiceId)) byInvoice.set(row.invoiceId, []); byInvoice.get(row.invoiceId)!.push(row); }
  const invoiceSetByFileName = new Map<string, Set<number>>();
  for (const row of rows) { if (!invoiceSetByFileName.has(row.fileName)) invoiceSetByFileName.set(row.fileName, new Set()); invoiceSetByFileName.get(row.fileName)!.add(row.invoiceId); }
  const sharedFileNames = new Set([...invoiceSetByFileName.entries()].filter(([, set]) => invs.every((i) => set.has(i.id))).map(([fn]) => fn));
  const firstId = invs[0]?.id;
  const shared = (byInvoice.get(firstId) || []).filter((r) => sharedFileNames.has(r.fileName));
  const perInvoice = invs.map((inv) => ({
    invoiceId: inv.id, invoiceNo: inv.invoiceNo,
    attachments: (byInvoice.get(inv.id) || []).filter((r) => !sharedFileNames.has(r.fileName)),
  }));
  return { shared, perInvoice };
}
// Render a bundled email (one client+month) — template body once, with {Invoice No} = all numbers.
async function renderBulkEmail(invs: any[], body: any) {
  const lead = { ...invs[0], invoiceNo: invs.map((i) => i.invoiceNo).join(", ") };
  return renderInvoiceEmail(lead, body);
}

// Preview the bundled email for a client+month (recipients, subject, body, attachment list). No send.
router.post("/email-preview-bulk", requireAdmin, requirePermission("email-invoices"), async (req, res) => {
  const { clientId, month, fiscalYear, selectedInvoiceIds } = req.body || {};
  const invs = await bulkInvoicesFor(clientId, month, fiscalYear, selectedInvoiceIds);
  if (!invs.length) return res.status(404).json({ error: "No generated invoices for this client and month." });
  const r = await renderBulkEmail(invs, req.body);
  if ("error" in r) return res.status(400).json({ error: r.error });
  // Shared (batch-level) vs. per-invoice attachments for exactly the SELECTED invoices — see
  // classifyBatchAttachments above. `existingAttachments` keeps its established name/shape (the
  // AttachmentPicker's "existing" prop) for the shared ones; `perInvoiceAttachments` is new, shown
  // as its own grouped section in the preview so Finance can see which document belongs to which
  // invoice before sending them combined.
  const { shared, perInvoice } = await classifyBatchAttachments(invs);
  const existingAttachments = shared.map((a) => ({ id: a.id, fileName: a.fileName, contentType: a.contentType, uploadedAt: a.uploadedAt }));
  const perInvoiceAttachments = perInvoice.map((g) => ({ invoiceId: g.invoiceId, invoiceNo: g.invoiceNo, attachments: g.attachments.map((a) => ({ id: a.id, fileName: a.fileName, contentType: a.contentType, uploadedAt: a.uploadedAt })) }));
  res.json({ to: r.recipients.join(", "), cc: r.cc.join(", "), bcc: r.bcc.join(", "), recipients: r.recipients, subject: r.subject, html: r.html, count: invs.length, invoiceNos: invs.map((i) => i.invoiceNo), templateName: r.tpl.name, existingAttachments, perInvoiceAttachments });
});

// Upload one or more extra supporting documents directly to every invoice in a client+month
// BATCH, independent of sending — mirrors the single-invoice POST /:id/attachments route. Since
// one shared attachment set covers the whole batch, it fans out to every matched invoice's own
// InvoiceAttachment rows (same "one row per (invoice, file)" pattern /send-bulk already uses), so
// viewing any single invoice later still shows it, not just the batch as a whole.
router.post("/bulk-attachments", requireAdmin, requirePermission("email-invoices"), async (req, res) => {
  const { clientId, month, fiscalYear } = req.body || {};
  const invs = await bulkInvoicesFor(clientId, month, fiscalYear);
  if (!invs.length) return res.status(404).json({ error: "No generated invoices for this client and month." });
  const files: { fileName: string; contentType?: string; fileData: string }[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (files.length) {
    const rows = invs.flatMap((inv) => files.map((a) => ({ invoiceId: inv.id, fileName: a.fileName, contentType: a.contentType || null, fileData: a.fileData, uploadedById: req.user!.id })));
    await prisma.invoiceAttachment.createMany({ data: rows });
    await prisma.auditLog.create({
      data: { userId: req.user!.id, action: "UPLOAD_INVOICE_ATTACHMENT_BULK", entity: "Client", entityId: String(clientId), after: { month, fileNames: files.map((a) => a.fileName) } },
    }).catch(() => {});
  }
  const attachments = await prisma.invoiceAttachment.findMany({ where: { invoiceId: invs[0].id }, select: { id: true, fileName: true, contentType: true, uploadedAt: true }, orderBy: { uploadedAt: "asc" } });
  res.json({ attachments });
});

// Permanently remove one shared attachment from EVERY invoice in a client+month batch, by
// filename — there's no single id representing the whole batch's copy of a file, since persisting
// one fans out to one InvoiceAttachment row per invoice (see POST above / /send-bulk). Deletes
// whatever matching rows actually exist across the batch; if the batch's invoices don't all have
// an identical attachment set for some reason (e.g. one picked up a file before this batch
// existed, or a row was removed individually elsewhere), this just removes however many it finds
// — never errors over a partial/inconsistent match.
router.delete("/bulk-attachments/:fileName", requireAdmin, requirePermission("email-invoices"), async (req, res) => {
  const { clientId, month, fiscalYear } = req.query as any;
  const fileName = decodeURIComponent(req.params.fileName);
  const invs = await bulkInvoicesFor(clientId, month, fiscalYear);
  if (!invs.length) return res.status(404).json({ error: "No generated invoices for this client and month." });
  const result = await prisma.invoiceAttachment.deleteMany({ where: { invoiceId: { in: invs.map((i) => i.id) }, fileName } });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "DELETE_INVOICE_ATTACHMENT_BULK", entity: "Client", entityId: String(clientId), after: { month, fileName, removedCount: result.count } },
  }).catch(() => {});
  res.json({ ok: true, removedCount: result.count });
});

// Download ONE Outlook draft (.eml) bundling every generated invoice PDF for a client+month.
router.post("/email-draft-bulk", requireAdmin, requirePermission("email-invoices"), async (req, res) => {
  const { clientId, month, fiscalYear, selectedInvoiceIds } = req.body || {};
  const invs = await bulkInvoicesFor(clientId, month, fiscalYear, selectedInvoiceIds);
  if (!invs.length) return res.status(404).json({ error: "No generated invoices for this client and month." });
  const r = await renderBulkEmail(invs, req.body);
  if ("error" in r) return res.status(400).json({ error: r.error });
  const html = (typeof req.body?.html === "string" && req.body.html.trim()) ? req.body.html : r.html;
  const subject = (typeof req.body?.subject === "string" && req.body.subject.trim()) ? req.body.subject : r.subject;
  const to = (req.body?.to !== undefined ? splitEmails(req.body.to) : r.recipients);
  const cc = (req.body?.cc !== undefined ? splitEmails(req.body.cc) : r.cc);
  const bcc = (req.body?.bcc !== undefined ? splitEmails(req.body.bcc) : r.bcc);
  const attachments = [] as { pdf: Buffer; fileName: string }[];
  for (const inv of invs) attachments.push({ pdf: await renderInvoicePdfToBuffer(inv), fileName: `${(inv.invoiceNo || `invoice-${inv.id}`).replace(/\//g, "_")}.pdf` });
  // Shared attachments go in unprefixed (same name for everyone); per-invoice ones are prefixed
  // with their own invoice number so e.g. two invoices both attaching "Timesheet.pdf" don't
  // silently collide in the recipient's inbox — plus any brand-new ones freshly picked in this
  // request (always treated as shared/batch-level, same as the existing "+ Add shared
  // attachment" picker). Drafting never writes to InvoiceAttachment — only an actual Send does.
  const { shared, perInvoice } = await classifyBatchAttachments(invs);
  const fresh: { fileName: string; contentType?: string; fileData: string }[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const extra = [
    ...shared.map((a) => ({ fileName: a.fileName, contentType: a.contentType ?? undefined, fileData: a.fileData })),
    ...perInvoice.flatMap((g) => g.attachments.map((a) => ({ fileName: `${g.invoiceNo} - ${a.fileName}`, contentType: a.contentType ?? undefined, fileData: a.fileData }))),
    ...fresh,
  ];
  const eml = buildEmlMulti(to, cc, bcc, subject, html, attachments, extra);
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "DRAFT_INVOICE_EMAIL_BULK", entity: "Client", entityId: String(clientId),
      after: { to, cc, bcc, month, invoiceNos: invs.map((i) => i.invoiceNo), subject, html, edited: html !== r.html || subject !== r.subject } },
  }).catch(() => {});
  res.setHeader("Content-Type", "message/rfc822");
  res.setHeader("Content-Disposition", `attachment; filename="${(invs[0].client?.code || "client")}-${month}-invoices.eml"`);
  res.send(eml);
});

// Finance can still choose "Open in Outlook (draft)" (above) to review and send from their own
// mailbox, or send directly from here as themselves (fromUpn = their own login email, same as
// every other Graph-sent notification in this app) — the client only ever calls this AFTER its own
// confirmation popup, so nothing goes out from a stray click on the Send button itself.
router.post("/:id/send", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  if (!mailEnabled()) return res.status(400).json({ error: "Email sending is not configured (Microsoft Graph)." });
  const inv = await prisma.invoice.findUnique({
    where: { id: Number(req.params.id) },
    include: { client: { include: { geography: true, projects: true } }, lineItems: true, annexure: true, template: true },
  });
  if (!inv) return res.status(404).json({ error: "Not found" });
  const r = await renderInvoiceEmail(inv, req.body);
  if ("error" in r) return res.status(400).json({ error: r.error });
  const html = (typeof req.body?.html === "string" && req.body.html.trim()) ? req.body.html : r.html;
  const subject = (typeof req.body?.subject === "string" && req.body.subject.trim()) ? req.body.subject : r.subject;
  const to = (req.body?.to !== undefined ? splitEmails(req.body.to) : r.recipients);
  const cc = (req.body?.cc !== undefined ? splitEmails(req.body.cc) : r.cc);
  const bcc = (req.body?.bcc !== undefined ? splitEmails(req.body.bcc) : r.bcc);
  if (!to.length) return res.status(400).json({ error: "Enter at least one recipient." });
  const pdf = await renderInvoicePdfToBuffer(inv);
  // Already-persisted attachments (uploaded earlier from the table, or kept from a prior send) are
  // always included — plus whatever's freshly picked in this popup, which gets persisted now so
  // it's reviewable from Invoice Generated after the fact too, not just a one-time email artifact.
  const persisted = await prisma.invoiceAttachment.findMany({ where: { invoiceId: inv.id }, select: { fileName: true, contentType: true, fileData: true } });
  const fresh: { fileName: string; contentType?: string; fileData: string }[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const attachments = [
    { name: r.fileName, contentType: "application/pdf", contentBytes: pdf.toString("base64") },
    ...persisted.map((a) => ({ name: a.fileName, contentType: a.contentType || "application/octet-stream", contentBytes: a.fileData })),
    ...fresh.map((a) => ({ name: a.fileName, contentType: a.contentType || "application/octet-stream", contentBytes: a.fileData })),
  ];
  try {
    await sendMail({ fromUpn: req.user!.email, to, cc, bcc, subject, html, attachments });
  } catch (e: any) {
    return res.status(400).json({ error: `Failed to send: ${e.message || "unknown error"}` });
  }
  if (fresh.length) {
    await prisma.invoiceAttachment.createMany({ data: fresh.map((a) => ({ invoiceId: inv.id, fileName: a.fileName, contentType: a.contentType || null, fileData: a.fileData, uploadedById: req.user!.id })) });
  }
  // A PAID invoice stays Paid even if re-sent (e.g. a corrected copy) — never silently demotes it
  // back to Sent.
  const updated = inv.status !== "PAID" ? await prisma.invoice.update({ where: { id: inv.id }, data: { status: "SENT" } }) : inv;
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "SEND_INVOICE_EMAIL", entity: "Invoice", entityId: String(inv.id),
      after: { to, cc, bcc, invoiceNo: inv.invoiceNo, attachments: [...persisted, ...fresh].map((a) => a.fileName), subject, html, edited: html !== r.html || subject !== r.subject } },
  }).catch(() => {});
  res.json({ ok: true, status: updated.status });
});

// Same as above but for a client+month bundle (EmailInvoices' own bulk flow) — one email, every
// invoice PDF plus any extra attachments, all of those invoices marked Sent (unless already Paid).
router.post("/send-bulk", requireAdmin, requirePermission("email-invoices"), async (req, res) => {
  if (!mailEnabled()) return res.status(400).json({ error: "Email sending is not configured (Microsoft Graph)." });
  const { clientId, month, fiscalYear, selectedInvoiceIds } = req.body || {};
  const invs = await bulkInvoicesFor(clientId, month, fiscalYear, selectedInvoiceIds);
  if (!invs.length) return res.status(404).json({ error: "No generated invoices for this client and month." });
  const r = await renderBulkEmail(invs, req.body);
  if ("error" in r) return res.status(400).json({ error: r.error });
  const html = (typeof req.body?.html === "string" && req.body.html.trim()) ? req.body.html : r.html;
  const subject = (typeof req.body?.subject === "string" && req.body.subject.trim()) ? req.body.subject : r.subject;
  const to = (req.body?.to !== undefined ? splitEmails(req.body.to) : r.recipients);
  const cc = (req.body?.cc !== undefined ? splitEmails(req.body.cc) : r.cc);
  const bcc = (req.body?.bcc !== undefined ? splitEmails(req.body.bcc) : r.bcc);
  if (!to.length) return res.status(400).json({ error: "Enter at least one recipient." });
  // Shared attachments unprefixed, per-invoice ones prefixed with their own invoice number (same
  // collision-avoidance as the draft route above) — plus whatever's freshly picked in this popup
  // (always shared/batch-level), which gets persisted now, fanned out to every SELECTED invoice,
  // so it's reviewable from Invoice Generated after the fact too.
  const { shared, perInvoice } = await classifyBatchAttachments(invs);
  const fresh: { fileName: string; contentType?: string; fileData: string }[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const namedAttachments = [
    ...shared.map((a) => ({ name: a.fileName, contentType: a.contentType || "application/octet-stream", contentBytes: a.fileData })),
    ...perInvoice.flatMap((g) => g.attachments.map((a) => ({ name: `${g.invoiceNo} - ${a.fileName}`, contentType: a.contentType || "application/octet-stream", contentBytes: a.fileData }))),
    ...fresh.map((a) => ({ name: a.fileName, contentType: a.contentType || "application/octet-stream", contentBytes: a.fileData })),
  ];
  const pdfAttachments: { name: string; contentType: string; contentBytes: string }[] = [];
  for (const inv of invs) {
    const pdf = await renderInvoicePdfToBuffer(inv);
    pdfAttachments.push({ name: `${(inv.invoiceNo || `invoice-${inv.id}`).replace(/\//g, "_")}.pdf`, contentType: "application/pdf", contentBytes: pdf.toString("base64") });
  }
  const attachments = [...pdfAttachments, ...namedAttachments];
  try {
    await sendMail({ fromUpn: req.user!.email, to, cc, bcc, subject, html, attachments });
  } catch (e: any) {
    return res.status(400).json({ error: `Failed to send: ${e.message || "unknown error"}` });
  }
  if (fresh.length) {
    // One row per (invoice, file) — each SELECTED invoice in the batch keeps its own copy of the
    // shared attachment(s), so viewing any single invoice later shows them, not just the batch.
    const rows = invs.flatMap((inv) => fresh.map((a) => ({ invoiceId: inv.id, fileName: a.fileName, contentType: a.contentType || null, fileData: a.fileData, uploadedById: req.user!.id })));
    await prisma.invoiceAttachment.createMany({ data: rows });
  }
  await prisma.invoice.updateMany({ where: { id: { in: invs.map((i) => i.id) }, status: { not: "PAID" } }, data: { status: "SENT" } });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "SEND_INVOICE_EMAIL_BULK", entity: "Client", entityId: String(clientId),
      after: { to, cc, bcc, month, invoiceNos: invs.map((i) => i.invoiceNo), attachments: namedAttachments.map((a) => a.name), subject, html, edited: html !== r.html || subject !== r.subject } },
  }).catch(() => {});
  res.json({ ok: true, count: invs.length });
});

// Download/preview one stored attachment (shown from Invoice Generated's own invoice row).
router.get("/attachments/:id", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const a = await prisma.invoiceAttachment.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", a.contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${a.fileName}"`);
  res.send(Buffer.from(a.fileData, "base64"));
});

// Permanently remove one stored attachment — manageable from the Generated Invoices table or the
// email preview modal, independent of send status.
router.delete("/attachments/:id", requireAdmin, requirePermission("invoices-existing"), async (req, res) => {
  const a = await prisma.invoiceAttachment.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: "Not found" });
  await prisma.invoiceAttachment.delete({ where: { id: a.id } });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: "DELETE_INVOICE_ATTACHMENT", entity: "Invoice", entityId: String(a.invoiceId), after: { fileName: a.fileName } },
  }).catch(() => {});
  res.json({ ok: true });
});

export default router;
