// Timesheet Template engine — config shape, a default starter template, the live-preview HTML
// renderer, template resolution (project → assigned template → company default), and the tiny
// safe formula evaluator for CALCULATED fields. Mirrors the established InvoiceLayout pattern
// (engine/invoicePdf.ts's normalizeLayout/DEFAULT_LAYOUT) but renders an HTML grid preview instead
// of a PDF, since a timesheet is naturally a live-editable grid, not a fixed print layout.
import { prisma } from "../prisma";
import type { TemplateBlock } from "./templateDocumentEngine";

export type TemplateFieldType = "TEXT" | "NUMBER" | "DATE" | "HOURS" | "BOOLEAN" | "SELECT" | "CALCULATED" | "APPROVAL";

export interface TemplateField {
  id: string;
  label: string;
  type: TemplateFieldType;
  order: number;
  width?: number; // relative column width, 1-12
  required?: boolean;
  defaultValue?: string;
  // CALCULATED only — a sum/difference of other field ids, e.g. "regularHours+otHours-leaveHours".
  // Deliberately NOT a general expression engine (no eval/new Function) — see evalFormula below.
  formula?: string;
  options?: string[]; // SELECT only
}

export interface TemplateSection {
  id: string;
  title: string;
  order: number;
  fields: TemplateField[];
}

export interface TemplateConfig {
  header: { title?: string; showLogo?: boolean; companyName?: string };
  footer: { text?: string; showSignatures?: boolean };
  sections: TemplateSection[];
  // Optional, generic block-based layout (engine/templateDocumentEngine.ts) — when present, this
  // is what drives real XLSX/PDF exports and their live preview, since `sections` alone (a flat
  // field list rendered as one simple table) can't represent a pivot grid, a multi-block report,
  // or a letterhead. `sections` stays the source for the Builder's quick-edit UI and for
  // relabeling the live TimesheetCalendar entry grid (section 14's "separate data from
  // presentation"), so existing templates keep working unchanged.
  blocks?: TemplateBlock[];
}

export const DEFAULT_TIMESHEET_CONFIG: TemplateConfig = {
  header: { title: "Monthly Timesheet", showLogo: true, companyName: "GenAquarius" },
  footer: { text: "", showSignatures: true },
  sections: [
    {
      id: "employee", title: "Employee Details", order: 1,
      fields: [
        { id: "employeeName", label: "Employee Name", type: "TEXT", order: 1, width: 4, required: true },
        { id: "employeeId", label: "Employee Id", type: "TEXT", order: 2, width: 3 },
        { id: "project", label: "Project", type: "TEXT", order: 3, width: 4, required: true },
        { id: "period", label: "Period", type: "TEXT", order: 4, width: 3 },
      ],
    },
    {
      id: "hours", title: "Hours", order: 2,
      fields: [
        { id: "date", label: "Date", type: "DATE", order: 1, width: 2, required: true },
        { id: "regularHours", label: "Regular Hours", type: "HOURS", order: 2, width: 2 },
        { id: "otHours", label: "OT Hours", type: "HOURS", order: 3, width: 2 },
        { id: "totalHours", label: "Total Hours", type: "CALCULATED", order: 4, width: 2, formula: "regularHours+otHours" },
        { id: "comments", label: "Comments", type: "TEXT", order: 5, width: 4 },
      ],
    },
    {
      id: "approval", title: "Approval", order: 3,
      fields: [
        { id: "employeeApproval", label: "Employee Approval", type: "APPROVAL", order: 1, width: 4 },
        { id: "pmApproval", label: "PM Approval", type: "APPROVAL", order: 2, width: 4 },
        { id: "financeApproval", label: "Finance Approval", type: "APPROVAL", order: 3, width: 4 },
      ],
    },
  ],
};

export function normalizeConfig(raw: any): TemplateConfig {
  if (!raw || !Array.isArray(raw.sections)) return DEFAULT_TIMESHEET_CONFIG;
  return {
    header: { title: raw.header?.title || "Monthly Timesheet", showLogo: raw.header?.showLogo !== false, companyName: raw.header?.companyName || "GenAquarius" },
    footer: { text: raw.footer?.text || "", showSignatures: raw.footer?.showSignatures !== false },
    sections: raw.sections.map((s: any, si: number) => ({
      id: s.id || `section_${si}`, title: s.title || `Section ${si + 1}`, order: s.order ?? si,
      fields: (Array.isArray(s.fields) ? s.fields : []).map((f: any, fi: number) => ({
        id: f.id || `field_${si}_${fi}`, label: f.label || "Field", type: f.type || "TEXT", order: f.order ?? fi,
        width: f.width || 3, required: !!f.required, defaultValue: f.defaultValue, formula: f.formula, options: f.options,
      })),
    })),
    blocks: Array.isArray(raw.blocks) ? raw.blocks.map((b: any, bi: number) => ({
      id: b.id || `block_${bi}`, type: b.type || "TEXT", order: b.order ?? bi, title: b.title, style: b.style,
      text: b.text, fields: b.fields, columns: b.columns, pivot: b.pivot, summaryColumns: b.summaryColumns,
    })) : undefined,
  };
}

// Tiny, deliberately-limited "formula" support — a sum/difference of other field ids only (e.g.
// "regularHours+otHours-leaveHours"). No eval/new Function, no arbitrary JS — every token is
// either a known field id (looked up in `values`, default 0) or a +/- operator.
export function evalFormula(formula: string, values: Record<string, number>): number {
  if (!formula) return 0;
  const tokens = formula.replace(/\s+/g, "").split(/([+-])/).filter(Boolean);
  let result = 0, sign = 1;
  for (const tok of tokens) {
    if (tok === "+") { sign = 1; continue; }
    if (tok === "-") { sign = -1; continue; }
    const n = Number(tok);
    result += sign * (Number.isFinite(n) ? n : (values[tok] || 0));
  }
  return result;
}

// Project → assigned template (latest version) → company-wide default (latest version) → null
// (plain grid, no template) — Rule 1/Rule 9's resolution order, used both for rendering an
// employee's actual timesheet and for the Template Assignment screen's "Source" column.
export async function resolveTemplateForProject(projectId: number) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { timesheetTemplateId: true } });
  if (project?.timesheetTemplateId) {
    const t = await prisma.timesheetTemplate.findUnique({ where: { id: project.timesheetTemplateId } });
    if (t && t.status === "ACTIVE") return { template: t, source: "PROJECT" as const };
  }
  const def = await prisma.timesheetTemplate.findFirst({ where: { isDefault: true, isLatest: true, status: "ACTIVE" } });
  return def ? { template: def, source: "DEFAULT" as const } : { template: null, source: "NONE" as const };
}

// Sample data for the Advanced Builder's live preview — never a real employee/project.
const SAMPLE_ROWS = [
  { date: "01 Sep 2026", regularHours: 8, otHours: 0, comments: "Sprint planning" },
  { date: "02 Sep 2026", regularHours: 8, otHours: 2, comments: "Release prep" },
  { date: "03 Sep 2026", regularHours: 7.5, otHours: 0, comments: "" },
];

export function renderTimesheetPreviewHtml(config: TemplateConfig): string {
  const section = (s: TemplateSection) => {
    const isHoursSection = s.fields.some((f) => f.type === "DATE" || f.type === "HOURS");
    const cols = [...s.fields].sort((a, b) => a.order - b.order);
    if (isHoursSection) {
      const headRow = `<tr>${cols.map((f) => `<th style="flex:${f.width || 3}">${esc(f.label)}${f.required ? " *" : ""}</th>`).join("")}</tr>`;
      const bodyRows = SAMPLE_ROWS.map((row: any) => {
        const cells = cols.map((f) => {
          let v: any = row[f.id];
          if (f.type === "CALCULATED") v = evalFormula(f.formula || "", row);
          if (v == null) v = f.defaultValue ?? "";
          return `<td style="flex:${f.width || 3}">${esc(String(v))}</td>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      return `<div class="section"><h3>${esc(s.title)}</h3><table class="grid">${headRow}${bodyRows}</table></div>`;
    }
    // Plain key:value section (Employee Details, Approval, etc.)
    const sample: Record<string, string> = { employeeName: "Aditi Sharma", employeeId: "1042", project: "ABC Project", period: "September 2026", employeeApproval: "Pending", pmApproval: "Pending", financeApproval: "Pending" };
    const rows = cols.map((f) => `<div class="kv" style="flex:${f.width || 3}"><label>${esc(f.label)}${f.required ? " *" : ""}</label><div>${esc(sample[f.id] ?? f.defaultValue ?? "—")}</div></div>`).join("");
    return `<div class="section"><h3>${esc(s.title)}</h3><div class="kvrow">${rows}</div></div>`;
  };
  const sections = [...config.sections].sort((a, b) => a.order - b.order).map(section).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
  <style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;background:#e9e9e9;margin:0;padding:0}
    .sheet{max-width:860px;margin:20px auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.12);padding:24px 28px}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #C4161C;padding-bottom:10px;margin-bottom:16px}
    .head h1{font-size:18px;margin:0}
    .section{margin-bottom:20px}
    .section h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:1px solid #ddd;padding-bottom:4px;margin:0 0 8px}
    table.grid{width:100%;border-collapse:collapse;display:table}
    table.grid tr{display:flex}
    table.grid th,table.grid td{border:1px solid #ccc;padding:6px 8px;font-size:12.5px;text-align:left}
    table.grid th{background:#f7f0ee;font-weight:700}
    .kvrow{display:flex;flex-wrap:wrap;gap:10px}
    .kv{min-width:140px}
    .kv label{display:block;font-size:11px;color:#888;text-transform:uppercase}
    .kv div{font-size:13.5px;font-weight:600}
    .footer{margin-top:20px;border-top:1px solid #ddd;padding-top:10px;font-size:11px;color:#999}
  </style></head><body>
    <div class="sheet">
      <div class="head"><h1>${esc(config.header.title || "Monthly Timesheet")}</h1>${config.header.showLogo ? `<div style="font-weight:700;color:#C4161C">${esc(config.header.companyName || "GenAquarius")}</div>` : ""}</div>
      ${sections}
      ${config.footer.text ? `<div class="footer">${esc(config.footer.text)}</div>` : ""}
    </div>
  </body></html>`;
}

function esc(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
