// Timesheet Template Management — Library (list/preview/edit/duplicate/version/assign/
// deactivate), the Advanced Builder's own save + live-preview routes, and Project Template
// Assignment. Mirrors the established InvoiceLayout pattern (routes/finance/invoiceLayouts.ts)
// — config JSON + isDefault enforced unique + project assignment via project.updateMany — with
// versioning layered on top (Rule 6: historical timesheets keep the exact version they were
// created under; only NEW timesheets pick up a newer version).
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { DEFAULT_TIMESHEET_CONFIG, normalizeConfig, renderTimesheetPreviewHtml, resolveTemplateForProject } from "../../engine/timesheetTemplate";
import { resolveRenderedDocument, renderDocumentHtml, renderDocumentXlsx, renderDocumentPdf, SingleTimesheetContext, ReportContext, DocumentContext } from "../../engine/templateDocumentEngine";
import { renderStationCasinoXlsx, renderClarienBankXlsx, renderWEnergyPdf, renderSymsoftPdf, renderGenAquariusStandardXlsx } from "../../engine/bespokeTimesheetExports";
import { Role } from "@prisma/client";
import { Writable } from "stream";

// Pixel-faithful dispatch for the 5 known reference templates — any OTHER, Finance-authored
// template falls through to the generic block engine. Keyed by template NAME (stable, shown in
// the Template Library) rather than id, since a template's id can change across environments/
// reseeds but its name is the one thing Finance recognizes it by.
async function exportBespokeOrGeneric(
  templateName: string | undefined, config: any, ctx: DocumentContext, format: string, res: any,
) {
  if (templateName === "GenAquarius Standard Timesheet" && format !== "pdf" && format !== "html") {
    const buf = await renderGenAquariusStandardXlsx(ctx);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.send(buf);
  }
  if (templateName === "Station Casino Timesheet" && format !== "pdf" && format !== "html") {
    const buf = await renderStationCasinoXlsx(ctx);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.send(buf);
  }
  if (templateName === "Clarien Bank Timesheet" && format !== "pdf" && format !== "html") {
    const buf = await renderClarienBankXlsx(ctx);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.send(buf);
  }
  if (templateName === "WEnergy Timesheet" && format !== "html") {
    res.setHeader("Content-Type", "application/pdf");
    return renderWEnergyPdf(ctx, res as Writable);
  }
  if (templateName === "Symsoft Timesheet" && format !== "html") {
    res.setHeader("Content-Type", "application/pdf");
    return renderSymsoftPdf(ctx, res as Writable);
  }
  const doc = resolveRenderedDocument(config, ctx);
  if (format === "pdf") { res.setHeader("Content-Type", "application/pdf"); return renderDocumentPdf(doc, res); }
  if (format === "html") { res.setHeader("Content-Type", "text/html"); return res.send(renderDocumentHtml(doc)); }
  const buf = await renderDocumentXlsx(doc);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
}

const router = Router();

// "Preview Timesheet" (section 11) — any logged-in employee/PM/Finance can see the template
// their OWN project resolves to (Rules 3-5: Employee/PM/Finance all see the same assigned
// template). Registered ahead of the requireAdmin/requirePermission gate below, which is
// Finance-only and governs the actual Template Library/Builder/Import routes.
router.get("/preview-for-project/:projectId", async (req, res) => {
  const { template } = await resolveTemplateForProject(Number(req.params.projectId));
  const config = template ? normalizeConfig(template.config) : DEFAULT_TIMESHEET_CONFIG;
  res.setHeader("Content-Type", "text/html");
  res.send(renderTimesheetPreviewHtml(config));
});

// JSON counterpart of the preview above — the real My Timesheet entry grid (TimesheetCalendar.tsx)
// uses this to read the resolved template's own field LABELS (e.g. Finance renamed "Regular
// Hours" → "Billable Hours") so the live entry form shows them, without turning the grid itself
// into a generic dynamic form — the underlying day/hours/leave/comment data model never changes,
// only which label is painted on top of it (section 14's own "separate data from presentation").
router.get("/resolved-config-for-project/:projectId", async (req, res) => {
  const { template, source } = await resolveTemplateForProject(Number(req.params.projectId));
  const config = template ? normalizeConfig(template.config) : DEFAULT_TIMESHEET_CONFIG;
  res.json({ config, source, templateId: template?.id ?? null });
});

// Real downloadable export (XLSX/PDF) of ONE employee's own timesheet for a project+period,
// laid out using that project's resolved template's generic `blocks` (falls back to the simple
// legacy section/field table when a template has no `blocks` yet — see DEFAULT_TIMESHEET_CONFIG).
// Reachable by the timesheet's own employee, any PM/admin role, or Finance — same broad access
// "Preview Timesheet" above already has, since this is the same no-save preview action, just as a
// real downloadable file instead of an inline HTML page. Also the "exact template Excel preview"
// Finance asked for on Approved Hours (Awaiting Finance Approval) and Invoice Generation/Email
// Invoice's attach-existing-timesheet picker — all three call this same route.
router.get("/export/:timesheetId", async (req, res) => {
  const id = Number(req.params.timesheetId);
  const ts = await prisma.timesheet.findUnique({
    where: { id },
    include: { employee: { select: { id: true, name: true, empNo: true, location: true, businessUnitId: true } }, project: { select: { id: true, name: true, client: { select: { name: true } } } }, entries: true },
  });
  if (!ts) return res.status(404).json({ error: "Timesheet not found" });
  const u = req.user!;
  const admin = ["CEO", "COO", "CTO", "FINANCE", "QA"].includes(u.role as string);
  const isOwner = u.employeeId === ts.employeeId;
  const isPm = u.role === Role.PROJECT_MANAGER;
  if (!admin && !isOwner && !isPm) return res.status(403).json({ error: "Not authorized to export this timesheet." });
  const { template } = await resolveTemplateForProject(ts.projectId);
  const config = template ? normalizeConfig(template.config) : DEFAULT_TIMESHEET_CONFIG;
  const ctx: SingleTimesheetContext = {
    kind: "SINGLE", employeeName: ts.employee.name, employeeId: ts.employee.empNo || undefined,
    projectName: ts.project.name, clientName: ts.project.client?.name,
    periodMonth: ts.periodMonth, periodYear: ts.periodYear,
    entries: ts.entries.map((e) => ({ day: e.day, hours: e.hours, leave: e.leave, comment: e.comment || undefined, head: e.head || undefined, billable: e.billable })),
    country: ts.employee.location, businessUnitId: ts.employee.businessUnitId,
  };
  const format = String(req.query.format || "xlsx").toLowerCase();
  const ext = format === "pdf" ? "pdf" : format === "html" ? "html" : "xlsx";
  const fileBase = `Timesheet_${ts.employee.empNo || ts.employee.name}_${ts.periodMonth}_${ts.periodYear}`;
  if (ext !== "html") res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${fileBase}.${ext}"`);
  await exportBespokeOrGeneric(template?.name, config, ctx, format, res);
});

// Multi-employee "Work Order Monthly Timesheet Report" style export — every employee's submitted
// timesheet for one project+period at once, the GenAquarius Standard/CXC-style report shape
// (Summary Report + per-resource Task×Day grid). Registered ahead of the requireAdmin gate below
// (same reason /export/:timesheetId above is) so the project's own assigned PM(s) can pull it too
// — not Finance-only, since a PM reviewing their whole team's hours for a period before approving
// is exactly what this is for. Also used from Invoice Generation / Email Invoice's "attach the
// generated timesheet" picker, and from Approved Hours for a whole-project view (both admin-only
// callers, covered by the admin branch below).
router.get("/export-report/:projectId", async (req, res) => {
  const projectId = Number(req.params.projectId);
  const u = req.user!;
  const admin = ["CEO", "COO", "CTO", "FINANCE", "QA"].includes(u.role as string);
  const isPm = u.role === Role.PROJECT_MANAGER && u.employeeId &&
    !!(await prisma.projectManager.findUnique({ where: { projectId_employeeId: { projectId, employeeId: u.employeeId } } }));
  if (!admin && !isPm) return res.status(403).json({ error: "Not authorized to export this project's timesheet report." });
  const periodMonth = Number(req.query.periodMonth);
  const periodYear = Number(req.query.periodYear);
  if (!periodMonth || !periodYear) return res.status(400).json({ error: "periodMonth and periodYear are required." });
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, client: { select: { name: true } } } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  // Excludes REJECTED sheets — a rejected timesheet's hours aren't real/approved yet (the
  // employee still has to fix and resubmit), so they don't belong in a report meant to reflect
  // the project's actual logged/approved time.
  const timesheets = await prisma.timesheet.findMany({
    where: { projectId, periodMonth, periodYear, status: { not: "REJECTED" } },
    include: { employee: { select: { name: true, location: true, businessUnitId: true } }, entries: true },
  });
  const { template } = await resolveTemplateForProject(projectId);
  const config = template ? normalizeConfig(template.config) : DEFAULT_TIMESHEET_CONFIG;
  const ctx: ReportContext = {
    kind: "REPORT", projectName: project.name, clientName: project.client?.name, billingCriteria: "Billable",
    periodMonth, periodYear,
    resources: timesheets.map((t) => ({
      employeeName: t.employee.name,
      entries: t.entries.map((e) => ({ day: e.day, hours: e.hours, leave: e.leave, comment: e.comment || undefined, head: e.head || undefined, billable: e.billable })),
      country: t.employee.location, businessUnitId: t.employee.businessUnitId,
    })),
  };
  const format = String(req.query.format || "xlsx").toLowerCase();
  const ext = format === "pdf" ? "pdf" : format === "html" ? "html" : "xlsx";
  const fileBase = `Timesheet_Report_${project.name}_${periodMonth}_${periodYear}`.replace(/[^\w.-]+/g, "_");
  if (ext !== "html") res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${fileBase}.${ext}"`);
  await exportBespokeOrGeneric(template?.name, config, ctx, format, res);
});

router.use(requireAdmin);
router.use(requirePermission("timesheet-templates"));

// Library listing — one row per family (the LATEST version only), with a project count and the
// version/status metadata the spec's own Template Library table asks for (section 21).
router.get("/", async (_req, res) => {
  const rows = await prisma.timesheetTemplate.findMany({
    where: { isLatest: true },
    include: { _count: { select: { projects: true, timesheets: true } } },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
  res.json(rows.map((r) => ({ ...r, projectCount: r._count.projects, timesheetCount: r._count.timesheets })));
});

router.get("/:id", async (req, res) => {
  const t = await prisma.timesheetTemplate.findUnique({
    where: { id: Number(req.params.id) },
    include: { projects: { select: { id: true, name: true } } },
  });
  if (!t) return res.status(404).json({ error: "Template not found" });
  res.json(t);
});

// All versions of one family, newest first — for the "Template Versions" screen.
router.get("/:id/versions", async (req, res) => {
  const t = await prisma.timesheetTemplate.findUnique({ where: { id: Number(req.params.id) } });
  if (!t) return res.status(404).json({ error: "Template not found" });
  const versions = await prisma.timesheetTemplate.findMany({ where: { name: t.name }, orderBy: { version: "desc" } });
  res.json(versions);
});

// Create New Template — blank, or "Save As" from an existing template's config (b.fromId).
router.post("/", async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "New Template").trim();
  if (!name) return res.status(400).json({ error: "Template name is required" });
  let config = DEFAULT_TIMESHEET_CONFIG;
  if (b.fromId) {
    const base = await prisma.timesheetTemplate.findUnique({ where: { id: Number(b.fromId) } });
    if (base) config = normalizeConfig(base.config);
  } else if (b.config) {
    config = normalizeConfig(b.config);
  }
  if (b.isDefault) await prisma.timesheetTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  const t = await prisma.timesheetTemplate.create({
    data: { name, version: 1, isLatest: true, isDefault: !!b.isDefault, status: "ACTIVE", config: config as any, createdById: req.user!.id },
  });
  res.status(201).json(t);
});

// Save Changes — edits THIS version in place (typo/correction class edits). Does NOT touch
// historical timesheets, which store their own templateId snapshot, not a live reference.
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (b.isDefault) await prisma.timesheetTemplate.updateMany({ where: { id: { not: id }, isDefault: true }, data: { isDefault: false } });
  const t = await prisma.timesheetTemplate.update({
    where: { id },
    data: {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      config: b.config !== undefined ? (normalizeConfig(b.config) as any) : undefined,
      isDefault: b.isDefault !== undefined ? !!b.isDefault : undefined,
      status: b.status !== undefined ? String(b.status) : undefined,
      updatedById: req.user!.id,
    },
  });
  if (Array.isArray(b.projectIds)) {
    await prisma.project.updateMany({ where: { timesheetTemplateId: id, id: { notIn: b.projectIds.map(Number) } }, data: { timesheetTemplateId: null } });
    await prisma.project.updateMany({ where: { id: { in: b.projectIds.map(Number) } }, data: { timesheetTemplateId: id } });
  }
  res.json(t);
});

// Create New Version — a NEW row (version+1), config seeded from the current latest (or the
// in-progress b.config from the builder), marks the old row isLatest=false, and re-points every
// project currently assigned to the old latest version onto the new one — "new timesheets use the
// latest active version assigned to the project" (section 7) without Finance having to manually
// re-assign every project each time.
router.post("/:id/new-version", async (req, res) => {
  const id = Number(req.params.id);
  const current = await prisma.timesheetTemplate.findUnique({ where: { id } });
  if (!current) return res.status(404).json({ error: "Template not found" });
  const b = req.body || {};
  const config = b.config !== undefined ? normalizeConfig(b.config) : current.config;
  const next = await prisma.timesheetTemplate.create({
    data: { name: current.name, version: current.version + 1, isLatest: true, isDefault: current.isDefault, status: "ACTIVE", config: config as any, createdById: req.user!.id },
  });
  await prisma.timesheetTemplate.update({ where: { id: current.id }, data: { isLatest: false } });
  await prisma.project.updateMany({ where: { timesheetTemplateId: current.id }, data: { timesheetTemplateId: next.id } });
  res.status(201).json(next);
});

// Deactivate — never hard-deletes (a version may already be referenced by historical
// timesheets); unassigns any project currently pointing at it so they fall back to Default.
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await prisma.project.updateMany({ where: { timesheetTemplateId: id }, data: { timesheetTemplateId: null } });
  await prisma.timesheetTemplate.update({ where: { id }, data: { status: "INACTIVE" } }).catch(() => {});
  res.json({ ok: true });
});

// Permanent Delete — only when truly unused (no project currently assigned to it, and no
// historical Timesheet ever snapshotted it); Deactivate above remains the usual path for a
// version that's still referenced anywhere.
router.delete("/:id/permanent", async (req, res) => {
  const id = Number(req.params.id);
  const t = await prisma.timesheetTemplate.findUnique({ where: { id }, include: { _count: { select: { projects: true, timesheets: true } } } });
  if (!t) return res.status(404).json({ error: "Template not found" });
  const { projects: projectCount, timesheets: timesheetCount } = t._count;
  if (projectCount > 0 || timesheetCount > 0) {
    return res.status(400).json({ error: `Still in use — ${projectCount} project(s) and ${timesheetCount} historical timesheet(s) reference this version. Deactivate instead, or reassign them off it first.` });
  }
  await prisma.timesheetTemplate.delete({ where: { id } });
  res.json({ ok: true });
});

// Live preview for the Advanced Builder — renders the in-progress (possibly unsaved) config
// against sample data, as HTML (an iframe can render this inline).
// Sample data for the Advanced Builder's block preview — never a real employee/project. Spans a
// full month (so DAY_OF_MONTH pivot grids have something to show) with two "tasks" so a pivot
// grid's row-grouping is visibly exercised, plus one leave day.
const SAMPLE_SINGLE_CTX: SingleTimesheetContext = {
  kind: "SINGLE", employeeName: "Aditi Sharma", employeeId: "1042", projectName: "ABC Project", clientName: "ABC Client",
  periodMonth: 9, periodYear: 2026,
  entries: [
    { day: 1, hours: 5, leave: false, head: "Development" }, { day: 1, hours: 3, leave: false, head: "Client Call" },
    { day: 2, hours: 8, leave: false, head: "Development" }, { day: 3, hours: 8, leave: false, head: "Development" },
    { day: 4, hours: 0, leave: true }, { day: 5, hours: 7.5, leave: false, head: "Testing" },
  ],
};
const SAMPLE_REPORT_CTX: ReportContext = {
  kind: "REPORT", projectName: "ABC Project", clientName: "ABC Client", billingCriteria: "Billable", periodMonth: 9, periodYear: 2026,
  resources: [
    { employeeName: "Aditi Sharma", entries: SAMPLE_SINGLE_CTX.entries },
    { employeeName: "Rahul Verma", entries: [{ day: 1, hours: 8, leave: false, head: "Development" }, { day: 2, hours: 8, leave: false, head: "Development" }] },
  ],
};
router.post("/preview", (req, res) => {
  const config = normalizeConfig(req.body?.config);
  res.setHeader("Content-Type", "text/html");
  if (config.blocks && config.blocks.length) {
    const ctx = req.body?.previewMode === "REPORT" ? SAMPLE_REPORT_CTX : SAMPLE_SINGLE_CTX;
    return res.send(renderDocumentHtml(resolveRenderedDocument(config, ctx)));
  }
  res.send(renderTimesheetPreviewHtml(config));
});

// ---- Project Template Assignment screen ----
router.get("/assignments/all", async (_req, res) => {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, timesheetTemplateId: true, timesheetTemplate: { select: { id: true, name: true, version: true, status: true } } },
    orderBy: { name: "asc" },
  });
  const def = await prisma.timesheetTemplate.findFirst({ where: { isDefault: true, isLatest: true } });
  res.json(projects.map((p) => ({
    projectId: p.id, projectName: p.name,
    assignedTemplate: p.timesheetTemplate ? `${p.timesheetTemplate.name} v${p.timesheetTemplate.version}` : (def ? `${def.name} v${def.version}` : "—"),
    source: p.timesheetTemplate ? "PROJECT_SPECIFIC" : "DEFAULT",
    status: (p.timesheetTemplate || def)?.status || "—",
  })));
});

router.post("/assignments/:projectId", async (req, res) => {
  const projectId = Number(req.params.projectId);
  const templateId = req.body?.templateId != null ? Number(req.body.templateId) : null; // null = "Use Default Template"
  await prisma.project.update({ where: { id: projectId }, data: { timesheetTemplateId: templateId } });
  res.json({ ok: true });
});

export default router;
