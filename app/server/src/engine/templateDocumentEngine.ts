// Generic, block-based timesheet document engine — the "one engine, every element
// controllable, preview matches output" layer the user explicitly asked for, on top of the
// existing section/field TemplateConfig (engine/timesheetTemplate.ts), which stays for backward
// compatibility with templates authored before this extension and for the simple quick-edit UI.
//
// Design: a template's `blocks` array describes WHAT to show (text/key-value/table/pivot-grid/
// summary-table) in order. `resolveRenderedDocument()` is the SINGLE place that turns a block
// config + real timesheet data into an abstract `RenderedDocument` — a plain tree of text/kv/
// table blocks with already-computed headers and rows. Every renderer (HTML preview, XLSX
// export, PDF export) consumes that SAME RenderedDocument, so whatever the live preview shows is
// exactly what the exported file contains — same headers, same rows, same values, same order.
// "Byte-identical to the client's original Excel file" isn't achievable across three different
// file formats (HTML/XLSX/PDF inherently produce different bytes) — what IS guaranteed, and is
// the part that actually matters for Finance's use case, is that preview and every exported
// format show the identical structure and numbers, every time, for every template.
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Writable } from "stream";
import path from "path";
import fs from "fs";
import { evalFormula } from "./timesheetTemplate";

// Same real GenAquarius logo asset + path convention engine/hrPdf.ts's own letterheads already
// use — a real embedded image, not just the company NAME printed as colored text.
const LOGO_PATH = path.resolve(__dirname, "../../assets/genaquarius.png");
let LOGO_BASE64: string | null | undefined; // undefined = not loaded yet, null = load failed/missing
function logoBase64(): string | null {
  if (LOGO_BASE64 === undefined) {
    try { LOGO_BASE64 = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH).toString("base64") : null; }
    catch { LOGO_BASE64 = null; }
  }
  return LOGO_BASE64;
}

export type BlockType = "TEXT" | "KEYVALUE" | "TABLE" | "PIVOT_GRID" | "SUMMARY_TABLE";

// Excel-toolbar-style formatting — bold/color controls Finance can set per block (and per field/
// column, via the same shape on KeyValueFieldDef/TableColumnDef) in the Advanced Builder, applied
// identically across the HTML preview and the real XLSX/PDF exports. Colors are plain 6-hex
// (`#rrggbb`, no alpha) from an <input type="color">; renderers add the ARGB "FF" prefix (XLSX)
// or pass through as-is (HTML/PDF) as needed.
export interface BlockStyle {
  bold?: boolean;
  align?: "left" | "center" | "right";
  border?: boolean;
  fontColor?: string; // "#rrggbb"
  fillColor?: string; // "#rrggbb"
}

export interface KeyValueFieldDef { id: string; label: string; fieldId: string; width?: number; style?: BlockStyle }
export interface TableColumnDef { id: string; label: string; fieldId: string; width?: number; type?: string; formula?: string; style?: BlockStyle }
// rowField "task" groups entries by their `head` (falls back to one unnamed row when entries
// carry no head at all — the common case for formats like WEnergy/Clarien Bank that don't break
// hours down by named task). columnMode DAY_OF_WEEK is for a single Mon–Sun week block (WEnergy/
// Symsoft-style); DAY_OF_MONTH spans every day in the period (Station Casino/Clarien Bank/CXC-
// style). valueField "status" prints "Y"/blank instead of a number — Clarien Bank's Y/N day grid.
export interface PivotGridDef {
  rowField: "task";
  columnMode: "DAY_OF_MONTH" | "DAY_OF_WEEK";
  valueField: "hours" | "status";
  rowLabel?: string;
  showRowTotal?: boolean;
  showColumnTotal?: boolean;
}
export interface SummaryColumnDef { id: string; label: string; fieldId: "resourceName" | "projectName" | "totalHours" | "leaveDays" }

export interface TemplateBlock {
  id: string;
  type: BlockType;
  order: number;
  title?: string;
  style?: BlockStyle;
  text?: string;
  fields?: KeyValueFieldDef[];
  columns?: TableColumnDef[];
  pivot?: PivotGridDef;
  summaryColumns?: SummaryColumnDef[];
}

export interface TimesheetEntryLike { day: number; hours: number; leave: boolean; comment?: string; head?: string; billable?: boolean }

// A single employee/project/period's own timesheet — used for the per-employee export (My
// Timesheet, Approved Hours row, Timesheet Approvals).
export interface SingleTimesheetContext {
  kind: "SINGLE";
  employeeName: string;
  employeeId?: string;
  projectName: string;
  clientName?: string;
  periodMonth: number;
  periodYear: number;
  entries: TimesheetEntryLike[];
  // The employee's own country/Business Unit — resolves which Holiday calendar
  // (HR Settings → Annual Leaves (Holidays)) the "Holiday" row in the GenAquarius Standard
  // export counts against. Optional since the generic engine never needs it.
  country?: string | null;
  businessUnitId?: number | null;
}
// Every resource's timesheet for one project+period at once — used for the multi-employee
// "Work Order Monthly Timesheet Report" style export (GenAquarius Standard/CXC format).
export interface ReportContext {
  kind: "REPORT";
  projectName: string;
  clientName?: string;
  billingCriteria?: string;
  periodMonth: number;
  periodYear: number;
  resources: { employeeName: string; entries: TimesheetEntryLike[]; country?: string | null; businessUnitId?: number | null }[];
}
export type DocumentContext = SingleTimesheetContext | ReportContext;

export interface RenderedCell { value: string; bold?: boolean; align?: "left" | "center" | "right"; fontColor?: string; fillColor?: string }
export type RenderedRow = RenderedCell[];
export interface RenderedTableBlock { kind: "table"; title?: string; headers: string[]; headerStyle?: BlockStyle; rows: RenderedRow[]; style?: BlockStyle }
export interface RenderedKvBlock { kind: "kv"; title?: string; items: { label: string; value: string; style?: BlockStyle }[]; style?: BlockStyle }
export interface RenderedTextBlock { kind: "text"; text: string; style?: BlockStyle }
export type RenderedBlock = RenderedTableBlock | RenderedKvBlock | RenderedTextBlock;
export interface RenderedDocument {
  title: string;
  companyName: string;
  showLogo: boolean;
  blocks: RenderedBlock[];
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const periodLabel = (month: number, year: number) => `${MONTH_NAMES[month - 1]} ${year}`;
const daysInMonth = (month: number, year: number) => new Date(year, month, 0).getDate();

function contextValue(ctx: DocumentContext, fieldId: string): string {
  if (ctx.kind === "SINGLE") {
    switch (fieldId) {
      case "employeeName": return ctx.employeeName;
      case "employeeId": return ctx.employeeId || "";
      case "project": return ctx.projectName;
      case "client": return ctx.clientName || "";
      case "period": return periodLabel(ctx.periodMonth, ctx.periodYear);
      default: return "";
    }
  }
  switch (fieldId) {
    case "project": return ctx.projectName;
    case "client": return ctx.clientName || "";
    case "billingCriteria": return ctx.billingCriteria || "";
    case "period": return periodLabel(ctx.periodMonth, ctx.periodYear);
    default: return "";
  }
}

// Groups a single resource's entries by task (`head`) — entries with no head collapse into one
// unnamed row, matching formats (WEnergy/Clarien Bank) that never break hours down by task.
// Split further by billable/non-billable — a task logged as BOTH billable and non-billable hours
// across the month becomes two rows (one per status) rather than blending them into one number
// that would hide the breakdown PM/Finance need to see.
function groupByTask(entries: TimesheetEntryLike[]): { task: string; byDay: Map<number, number> }[] {
  const groups = new Map<string, Map<number, number>>();
  for (const e of entries) {
    if (e.leave || !e.hours) continue;
    const base = e.head && e.head.trim() ? e.head.trim() : "";
    const key = e.billable === false ? `${base}\u0000NB` : base;
    if (!groups.has(key)) groups.set(key, new Map());
    const m = groups.get(key)!;
    m.set(e.day, (m.get(e.day) || 0) + e.hours);
  }
  return [...groups.entries()].map(([key, byDay]) => {
    const nonBillable = key.endsWith("\u0000NB");
    const task = nonBillable ? key.slice(0, -3) : key;
    return { task: (task || "(No task)") + (nonBillable ? " (Non-Billable)" : ""), byDay };
  });
}

function pivotTable(pivot: PivotGridDef, entries: TimesheetEntryLike[], month: number, year: number, rowLabelPrefix?: string, style?: BlockStyle): RenderedTableBlock {
  const days = pivot.columnMode === "DAY_OF_MONTH"
    ? Array.from({ length: daysInMonth(month, year) }, (_, i) => i + 1)
    : [...new Set(entries.map((e) => e.day))].sort((a, b) => a - b);
  const headers = [pivot.rowLabel || "Task", ...days.map(String), ...(pivot.showRowTotal ? ["Total"] : [])];
  const groups = groupByTask(entries);
  const rows: RenderedRow[] = groups.map((g) => {
    const cells: RenderedCell[] = [{ value: g.task || "—" }];
    let rowTotal = 0;
    for (const d of days) {
      const v = g.byDay.get(d) || 0;
      rowTotal += v;
      cells.push({ value: v ? (pivot.valueField === "status" ? "Y" : String(v)) : "" });
    }
    if (pivot.showRowTotal) cells.push({ value: String(rowTotal), bold: true });
    return cells;
  });
  if (pivot.showColumnTotal) {
    const totals: RenderedCell[] = [{ value: "Total", bold: true }];
    let grand = 0;
    for (const d of days) {
      const dayTotal = groups.reduce((s, g) => s + (g.byDay.get(d) || 0), 0);
      grand += dayTotal;
      totals.push({ value: dayTotal ? String(dayTotal) : "", bold: true });
    }
    if (pivot.showRowTotal) totals.push({ value: String(grand), bold: true });
    rows.push(totals);
  }
  return { kind: "table", title: rowLabelPrefix, headers, rows, style, headerStyle: style };
}

export function resolveRenderedDocument(config: { header: { title?: string; showLogo?: boolean; companyName?: string }; blocks?: TemplateBlock[] }, ctx: DocumentContext): RenderedDocument {
  const blocks: RenderedBlock[] = [];
  const sorted = [...(config.blocks || [])].sort((a, b) => a.order - b.order);
  for (const b of sorted) {
    if (b.type === "TEXT") {
      blocks.push({ kind: "text", text: b.text || "", style: b.style });
    } else if (b.type === "KEYVALUE") {
      const items = (b.fields || []).map((f) => ({ label: f.label, value: contextValue(ctx, f.fieldId), style: f.style }));
      blocks.push({ kind: "kv", title: b.title, items, style: b.style });
    } else if (b.type === "TABLE") {
      if (ctx.kind !== "SINGLE") continue; // a flat entry table only makes sense per-employee
      const cols = b.columns || [];
      const sortedEntries = [...ctx.entries].filter((e) => !e.leave).sort((a, c) => a.day - c.day);
      const headers = cols.map((c) => c.label);
      const rows: RenderedRow[] = sortedEntries.map((e) => cols.map((c) => {
        let v: any;
        if (c.fieldId === "date") v = `${String(e.day).padStart(2, "0")}/${String(ctx.periodMonth).padStart(2, "0")}`;
        else if (c.fieldId === "hours") v = e.hours;
        else if (c.fieldId === "head") v = e.head || "";
        else if (c.fieldId === "comment") v = e.comment || "";
        else if (c.type === "CALCULATED") v = evalFormula(c.formula || "", { hours: e.hours });
        else v = "";
        return { value: String(v ?? ""), bold: c.style?.bold, fontColor: c.style?.fontColor, fillColor: c.style?.fillColor };
      }));
      blocks.push({ kind: "table", title: b.title, headers, rows, style: b.style, headerStyle: b.style });
    } else if (b.type === "PIVOT_GRID" && b.pivot) {
      if (ctx.kind === "SINGLE") {
        blocks.push(pivotTable(b.pivot, ctx.entries, ctx.periodMonth, ctx.periodYear, b.title, b.style));
      } else {
        for (const r of ctx.resources) {
          blocks.push(pivotTable(b.pivot, r.entries, ctx.periodMonth, ctx.periodYear, `${b.title || "Resource"}: ${r.employeeName}`, b.style));
        }
      }
    } else if (b.type === "SUMMARY_TABLE" && ctx.kind === "REPORT") {
      const cols = b.summaryColumns && b.summaryColumns.length ? b.summaryColumns : [
        { id: "resourceName", label: "Resource Name", fieldId: "resourceName" as const },
        { id: "projectName", label: "Project Name", fieldId: "projectName" as const },
        { id: "totalHours", label: "Value", fieldId: "totalHours" as const },
      ];
      const headers = cols.map((c) => c.label);
      const rows: RenderedRow[] = ctx.resources.map((r) => {
        const total = r.entries.filter((e) => !e.leave).reduce((s, e) => s + (e.hours || 0), 0);
        const leaveDays = r.entries.filter((e) => e.leave).length;
        return cols.map((c) => ({
          value: c.fieldId === "resourceName" ? r.employeeName
            : c.fieldId === "projectName" ? ctx.projectName
            : c.fieldId === "totalHours" ? String(total)
            : String(leaveDays),
        }));
      });
      const grandTotal = ctx.resources.reduce((s, r) => s + r.entries.filter((e) => !e.leave).reduce((s2, e) => s2 + (e.hours || 0), 0), 0);
      rows.push(cols.map((c, i) => ({ value: i === 0 ? "Total" : c.fieldId === "totalHours" ? String(grandTotal) : "", bold: true })));
      blocks.push({ kind: "table", title: b.title || "Summary Report", headers, rows, style: b.style, headerStyle: b.style });
    }
  }
  return {
    title: config.header?.title || "Timesheet",
    companyName: config.header?.companyName || "GenAquarius",
    showLogo: config.header?.showLogo !== false,
    blocks,
  };
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Live preview AND the visual reference for what the XLSX/PDF exports below will contain —
// same RenderedDocument, same block order, same headers/rows.
export function renderDocumentHtml(doc: RenderedDocument): string {
  const cellStyleAttr = (bold?: boolean, color?: string, bg?: string) =>
    `font-weight:${bold ? 700 : 400};${color ? `color:${esc(color)};` : ""}${bg ? `background:${esc(bg)};` : ""}`;
  const blockHtml = doc.blocks.map((b) => {
    if (b.kind === "text") return `<div class="textblock" style="${cellStyleAttr(b.style?.bold, b.style?.fontColor, b.style?.fillColor)}">${esc(b.text)}</div>`;
    if (b.kind === "kv") {
      const rows = b.items.map((i) => `<div class="kv" style="${cellStyleAttr(i.style?.bold, i.style?.fontColor)}"><label>${esc(i.label)}</label><div style="${cellStyleAttr(undefined, i.style?.fontColor, i.style?.fillColor)}">${esc(i.value)}</div></div>`).join("");
      return `<div class="block">${b.title ? `<h3 style="${cellStyleAttr(true, b.style?.fontColor, b.style?.fillColor)}">${esc(b.title)}</h3>` : ""}<div class="kvrow">${rows}</div></div>`;
    }
    const headStyle = cellStyleAttr(true, b.headerStyle?.fontColor, b.headerStyle?.fillColor);
    const head = `<tr>${b.headers.map((h) => `<th style="${headStyle}">${esc(h)}</th>`).join("")}</tr>`;
    const body = b.rows.map((r) => `<tr>${r.map((c) => `<td style="${cellStyleAttr(c.bold, c.fontColor, c.fillColor)}">${esc(c.value)}</td>`).join("")}</tr>`).join("");
    return `<div class="block">${b.title ? `<h3 style="${cellStyleAttr(true, b.style?.fontColor)}">${esc(b.title)}</h3>` : ""}<table class="grid">${head}${body}</table></div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;background:#e9e9e9;margin:0;padding:0}
    .sheet{max-width:1100px;margin:20px auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.12);padding:24px 28px}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #C4161C;padding-bottom:10px;margin-bottom:16px}
    .head h1{font-size:18px;margin:0}
    .block{margin-bottom:20px}
    .block h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:1px solid #ddd;padding-bottom:4px;margin:0 0 8px}
    table.grid{width:100%;border-collapse:collapse;font-size:12px}
    table.grid th,table.grid td{border:1px solid #ccc;padding:4px 6px;text-align:center}
    table.grid th{background:#f7f0ee;font-weight:700}
    table.grid td:first-child,table.grid th:first-child{text-align:left}
    .kvrow{display:flex;flex-wrap:wrap;gap:14px}
    .kv{min-width:140px}
    .kv label{display:block;font-size:11px;color:#888;text-transform:uppercase}
    .kv div{font-size:13.5px;font-weight:600}
    .textblock{font-size:12px;color:#444;margin-bottom:12px}
  </style></head><body>
    <div class="sheet">
      <div class="head"><h1>${esc(doc.title)}</h1>${doc.showLogo ? (logoBase64() ? `<img src="data:image/png;base64,${logoBase64()}" style="height:40px" alt="${esc(doc.companyName)}" />` : `<div style="font-weight:700;color:#C4161C">${esc(doc.companyName)}</div>`) : ""}</div>
      ${blockHtml}
    </div>
  </body></html>`;
}

// Real downloadable Excel export — same RenderedDocument the preview and PDF export use.
// Exact style measured off the real company reference file (Downloads/Updated Template/Default
// Template.xlsx) — the one GenAquarius itself already sends to CXC/Kira/Cozzinibros/Cyncly/
// Northpoint: Calibri throughout, a solid mid-blue banner (white bold text) for section/column
// headers, thin black borders around every data cell, white-filled body rows.
const XLSX_BLUE = "FF528BCB";
const THIN_BORDER = { style: "thin" as const, color: { argb: "FF000000" } };
const ALL_BORDERS = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
const HEADER_FONT = { bold: true, size: 10, color: { argb: "FFFFFFFF" }, name: "Calibri" };
const BODY_FONT = { size: 9, color: { argb: "FF000000" }, name: "Calibri" };
const HEADER_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: XLSX_BLUE } };
const WHITE_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFFFFF" } };
// "#rrggbb" (from an <input type="color">) → exceljs ARGB ("FFrrggbb").
function toArgb(hex: string): string {
  const clean = hex.replace("#", "").toUpperCase();
  return "FF" + (clean.length === 6 ? clean : "000000");
}

export async function renderDocumentXlsx(doc: RenderedDocument): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(doc.title.slice(0, 31) || "Timesheet");
  let row = 1;
  sheet.getCell(row, 1).value = doc.title;
  sheet.getCell(row, 1).font = { bold: true, size: 14, name: "Calibri" };
  if (doc.showLogo) {
    const b64 = logoBase64();
    if (b64) {
      const imgId = wb.addImage({ base64: `data:image/png;base64,${b64}`, extension: "png" });
      sheet.addImage(imgId, { tl: { col: 5, row: 0 }, ext: { width: 160, height: 50 } });
    } else {
      sheet.getCell(row, 6).value = doc.companyName;
      sheet.getCell(row, 6).font = { bold: true, color: { argb: "FFC4161C" }, name: "Calibri" };
    }
  }
  row += 2;
  for (const b of doc.blocks) {
    if (b.kind === "text") {
      const c = sheet.getCell(row, 1);
      c.value = b.text;
      c.font = { name: "Calibri", size: 11, bold: !!b.style?.bold, color: b.style?.fontColor ? { argb: toArgb(b.style.fontColor) } : undefined };
      if (b.style?.fillColor) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(b.style.fillColor) } };
      row += 2;
      continue;
    }
    if (b.title) {
      // Section banner — full-width solid blue bar with white bold text, matching the real
      // file's "Summary Report" row exactly (merged across the block's own column count).
      const span = b.kind === "kv" ? 2 : Math.max(b.headers.length, 1);
      sheet.mergeCells(row, 1, row, span);
      const titleCell = sheet.getCell(row, 1);
      titleCell.value = b.title;
      titleCell.font = b.style?.fontColor ? { ...HEADER_FONT, color: { argb: toArgb(b.style.fontColor) } } : HEADER_FONT;
      titleCell.fill = b.style?.fillColor ? { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(b.style.fillColor) } } : HEADER_FILL;
      titleCell.alignment = { horizontal: "left", vertical: "middle" };
      row += 1;
    }
    if (b.kind === "kv") {
      for (const item of b.items) {
        const labelCell = sheet.getCell(row, 1);
        labelCell.value = item.label;
        labelCell.font = { bold: true, size: 11, name: "Calibri", color: item.style?.fontColor ? { argb: toArgb(item.style.fontColor) } : undefined };
        const valCell = sheet.getCell(row, 2);
        valCell.value = item.value;
        valCell.font = { size: 11, name: "Calibri", bold: !!item.style?.bold, color: item.style?.fontColor ? { argb: toArgb(item.style.fontColor) } : undefined };
        if (item.style?.fillColor) { labelCell.fill = valCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(item.style.fillColor) } }; }
        row += 1;
      }
      row += 1;
      continue;
    }
    b.headers.forEach((h, i) => {
      const c = sheet.getCell(row, i + 1);
      c.value = h;
      c.font = b.headerStyle?.fontColor ? { ...HEADER_FONT, color: { argb: toArgb(b.headerStyle.fontColor) } } : HEADER_FONT;
      c.fill = b.headerStyle?.fillColor ? { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(b.headerStyle.fillColor) } } : HEADER_FILL;
      c.border = ALL_BORDERS;
      c.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    });
    row += 1;
    for (const r of b.rows) {
      r.forEach((cell, i) => {
        const c = sheet.getCell(row, i + 1);
        c.value = cell.value;
        c.font = { ...BODY_FONT, bold: !!cell.bold, color: cell.fontColor ? { argb: toArgb(cell.fontColor) } : BODY_FONT.color };
        c.fill = cell.fillColor ? { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(cell.fillColor) } } : WHITE_FILL;
        c.border = ALL_BORDERS;
        c.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      });
      row += 1;
    }
    row += 1;
  }
  sheet.columns.forEach((col, i) => { col.width = i === 0 ? 22 : 10; });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// Real downloadable PDF export — generic column-width table drawer mirroring the existing
// PDFKit table convention used elsewhere in this app (engine/hrPdf.ts's own `table()` helper):
// filled header bar, bordered body rows, auto page-break.
export function renderDocumentPdf(doc: RenderedDocument, out: Writable) {
  const pdf = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  pdf.pipe(out);
  const titleY = pdf.y;
  pdf.font("Helvetica-Bold").fontSize(16).fillColor("#1a1a1a").text(doc.title, { align: "left" });
  if (doc.showLogo) {
    if (fs.existsSync(LOGO_PATH)) { try { pdf.image(LOGO_PATH, pdf.page.width - 40 - 100, titleY, { width: 100 }); } catch { /* ignore */ } }
    else pdf.font("Helvetica-Bold").fontSize(11).fillColor("#C4161C").text(doc.companyName, 40, titleY, { align: "right", width: pdf.page.width - 80 });
  }
  pdf.y = Math.max(pdf.y, titleY + 30);
  pdf.moveDown(0.8);
  const pageW = pdf.page.width - 80;
  for (const b of doc.blocks) {
    if (pdf.y > 700) pdf.addPage();
    if (b.kind === "text") { pdf.font(b.style?.bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(b.style?.fontColor || "#333333").text(b.text); pdf.moveDown(0.6); continue; }
    if (b.title) { pdf.font("Helvetica-Bold").fontSize(11).fillColor(b.style?.fontColor || "#666666").text(b.title.toUpperCase()); pdf.moveDown(0.2); }
    if (b.kind === "kv") {
      for (const item of b.items) {
        pdf.font("Helvetica-Bold").fontSize(9).fillColor(item.style?.fontColor || "#888888").text(item.label, { continued: true });
        pdf.font(item.style?.bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(item.style?.fontColor || "#1a1a1a").text("  " + item.value);
      }
      pdf.moveDown(0.6);
      continue;
    }
    const n = b.headers.length || 1;
    const colW = pageW / n;
    const widths = b.headers.map(() => colW);
    const x0 = 40, rowH = 16;
    pdf.rect(x0, pdf.y, pageW, rowH).fill(b.headerStyle?.fillColor || "#f7f0ee");
    let hx = x0, hy = pdf.y + 3;
    pdf.font("Helvetica-Bold").fontSize(8).fillColor(b.headerStyle?.fontColor || "#333333");
    b.headers.forEach((h, i) => { pdf.text(h, hx + 3, hy, { width: widths[i] - 4, align: "center" }); hx += widths[i]; });
    pdf.y += rowH;
    for (const r of b.rows) {
      if (pdf.y > 760) { pdf.addPage(); pdf.y = 40; }
      const y = pdf.y;
      let x = x0;
      r.forEach((cell, i) => {
        if (cell.fillColor) pdf.rect(x, y, widths[i], rowH).fill(cell.fillColor);
        pdf.font(cell.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor(cell.fontColor || "#1a1a1a");
        pdf.text(cell.value, x + 3, y + 3, { width: widths[i] - 4, align: i === 0 ? "left" : "center" });
        x += widths[i];
      });
      pdf.moveTo(x0, y + rowH).lineTo(x0 + pageW, y + rowH).strokeColor("#dddddd").lineWidth(0.5).stroke();
      pdf.y = y + rowH;
    }
    pdf.moveDown(0.8);
  }
  pdf.end();
}
