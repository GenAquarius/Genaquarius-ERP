// Pixel-faithful, per-client export renderers — unlike engine/templateDocumentEngine.ts's one
// generic block engine (which Finance uses to build ANY new template from scratch, styled
// consistently), these 4 functions reproduce the EXACT visual look of the 4 real reference files
// this feature was built against (Station Casino/Clarien Bank xlsx, WEnergy/Symsoft PDF) —
// measured directly off those files (colors, fonts, borders, exact text layout). The export
// route (routes/finance/timesheetTemplates.ts) dispatches to these by template NAME for the 5
// known seeded templates; any other, Finance-authored template still uses the generic engine.
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Writable } from "stream";
import { SingleTimesheetContext, ReportContext, DocumentContext } from "./templateDocumentEngine";
import { prisma } from "../prisma";
import { buRows } from "./hr";

const CALIBRI = "Calibri";
const TIMES = "Times New Roman";
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayHoursMap(entries: SingleTimesheetContext["entries"]) {
  const m = new Map<number, number>();
  for (const e of entries) if (!e.leave && e.hours) m.set(e.day, (m.get(e.day) || 0) + e.hours);
  return m;
}
// Splits by (head, billable) — a task logged as both billable and non-billable across the month
// becomes two separate rows in the Task×Day grid, each clearly labeled, instead of blending them
// into one number that hides which hours actually count toward invoicing.
function groupByHead(entries: SingleTimesheetContext["entries"]) {
  const groups = new Map<string, SingleTimesheetContext["entries"]>();
  for (const e of entries) {
    if (e.leave) continue;
    const base = e.head || "";
    const key = e.billable === false ? `${base}\u0000NB` : base;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return [...groups.entries()].map(([key, es]) => {
    const nonBillable = key.endsWith("\u0000NB");
    const label = nonBillable ? key.slice(0, -3) : key;
    return [label + (nonBillable ? " (Non-Billable)" : ""), es] as [string, SingleTimesheetContext["entries"]];
  });
}

// ---------------- Station Casino — real Azure DevOps work-item export look ----------------
// Bold yellow (#FFFF00) Calibri 12 header row, medium black outline + thin internal borders,
// plain white body rows — measured off the real reference file exactly.
export async function renderStationCasinoXlsx(ctx: DocumentContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet((ctx.kind === "SINGLE" ? ctx.employeeName : ctx.projectName).slice(0, 31) || "Timesheet");
  const headers = ["ID", "Work Item Type", "Title", "Assigned To", "Completed Work", "Activity", "Value Area", "Project", "Product", "State", "Closed Date", "Created Date"];
  const widths = [7, 14, 28, 15, 15, 11, 12, 19, 18, 5, 11, 12];
  headers.forEach((h, i) => {
    const c = sheet.getCell(1, i + 1);
    c.value = h;
    c.font = { bold: true, size: 12, name: CALIBRI };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    c.border = {
      left: { style: i === 0 ? "medium" : "thin" }, right: { style: i === headers.length - 1 ? "medium" : "thin" },
      top: { style: "medium" }, bottom: { style: "medium" },
    };
  });
  sheet.columns.forEach((col, i) => { col.width = widths[i] || 12; });

  // One row per entry — groups entries by head (the work-item Title) back into individual rows,
  // since this format is a flat work-item LIST, not a pivot (confirmed real structure).
  const entriesList = ctx.kind === "SINGLE" ? ctx.entries : ctx.resources.flatMap((r) => r.entries);
  const employeeName = ctx.kind === "SINGLE" ? ctx.employeeName : "";
  const projectName = ctx.kind === "SINGLE" ? ctx.projectName : ctx.projectName;
  let row = 2;
  for (const e of entriesList) {
    if (e.leave || !e.hours) continue;
    const dateStr = e.day ? `2026-09-${String(e.day).padStart(2, "0")}` : "";
    const cells = [e.day, "Task", e.head || e.comment || "", employeeName, e.hours, "", "", projectName, "", "Done", dateStr, dateStr];
    cells.forEach((v, i) => {
      const c = sheet.getCell(row, i + 1);
      c.value = v as any;
      c.font = { size: 12, name: CALIBRI };
      c.border = {
        left: { style: i === 0 ? "medium" : "thin" }, right: { style: i === cells.length - 1 ? "medium" : "thin" },
        top: { style: "thin" }, bottom: { style: "thin" },
      };
    });
    row += 1;
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------------- Clarien Bank — real letterhead + Y/N day-grid look ----------------
// Times New Roman 10pt throughout, no cell fills, GenAquarius LLC address block, bold labels,
// a day-of-month grid split into rows of 16 with bold centered day numbers and a
// "- Days (Need to fill Y/N)" status row underneath — measured off the real reference file.
export async function renderClarienBankXlsx(ctx: DocumentContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Timesheet");
  const tnr = (bold = false, size = 10) => ({ name: TIMES, size, bold });
  const employeeName = ctx.kind === "SINGLE" ? ctx.employeeName : ctx.resources[0]?.employeeName || "";
  const projectName = ctx.projectName;
  const periodDays = ctx.kind === "SINGLE" ? new Date(ctx.periodYear, ctx.periodMonth, 0).getDate() : 30;
  const entries = ctx.kind === "SINGLE" ? ctx.entries : ctx.resources[0]?.entries || [];
  const hoursByDay = dayHoursMap(entries);
  const leaveByDay = new Set(entries.filter((e) => e.leave).map((e) => e.day));

  sheet.getCell(4, 1).value = "GenAquarius LLC."; sheet.getCell(4, 1).font = tnr(true);
  sheet.getCell(5, 1).value = "2795 E Bidwell St."; sheet.getCell(5, 1).font = tnr();
  sheet.getCell(6, 1).value = "Suite 100-662, Folsom,"; sheet.getCell(6, 1).font = tnr();
  sheet.getCell(7, 1).value = "CA 95630, USA"; sheet.getCell(7, 1).font = tnr();
  sheet.getCell(4, 8).value = "Timesheet"; sheet.getCell(4, 8).font = tnr(true, 14);

  sheet.getCell(10, 1).value = "Employee Name:"; sheet.getCell(10, 1).font = tnr(true);
  sheet.getCell(10, 2).value = employeeName; sheet.getCell(10, 2).font = tnr();
  sheet.getCell(11, 1).value = "Manager:"; sheet.getCell(11, 1).font = tnr(true);
  sheet.getCell(12, 1).value = "Project Title:"; sheet.getCell(12, 1).font = tnr(true);
  sheet.getCell(12, 2).value = projectName; sheet.getCell(12, 2).font = tnr();
  sheet.getCell(13, 1).value = "Project Code:"; sheet.getCell(13, 1).font = tnr(true);
  sheet.getCell(14, 1).value = "Period from:"; sheet.getCell(14, 1).font = tnr(true);
  const periodStr = ctx.kind === "SINGLE" ? `1st to ${periodDays} ${ctx.periodMonth}/${ctx.periodYear}` : "";
  sheet.getCell(14, 2).value = periodStr; sheet.getCell(14, 2).font = tnr();

  let r = 15;
  for (let half = 0; half < 2; half++) {
    const startDay = half * 16 + 1;
    const endDay = Math.min(startDay + 15, periodDays);
    for (let d = startDay; d <= endDay; d++) {
      const c = sheet.getCell(r, d - startDay + 2);
      c.value = d; c.font = tnr(true); c.alignment = { horizontal: "center" };
    }
    r += 1;
    sheet.getCell(r, 1).value = "- Days (Need to fill Y/N)"; sheet.getCell(r, 1).font = tnr(true);
    for (let d = startDay; d <= endDay; d++) {
      const dow = ctx.kind === "SINGLE" ? new Date(ctx.periodYear, ctx.periodMonth - 1, d).getDay() : -1;
      const status = leaveByDay.has(d) ? "N" : dow === 0 ? "Sun" : dow === 6 ? "Sat" : hoursByDay.has(d) ? "Y" : "";
      const c = sheet.getCell(r, d - startDay + 2);
      c.value = status; c.font = tnr(); c.alignment = { horizontal: "center" };
    }
    r += 2;
  }
  sheet.columns.forEach((col, i) => { col.width = i === 0 ? 34 : 8.5; });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------------- WEnergy — real weekly PDF layout ----------------
// "Project Task Category | Mon .. Sun | Total Hours" table, a TOTAL TIME row, then the
// employee's name and "M/D/YY - M/D/YY" date range as their own lines — matches the real
// extracted text layout exactly (confirmed this session against the actual reference PDF).
export function renderWEnergyPdf(ctx: DocumentContext, out: Writable) {
  const pdf = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  pdf.pipe(out);
  const employeeName = ctx.kind === "SINGLE" ? ctx.employeeName : ctx.resources[0]?.employeeName || "";
  const entries = ctx.kind === "SINGLE" ? ctx.entries : ctx.resources[0]?.entries || [];
  const projectName = ctx.projectName;
  const days = [...entries].filter((e) => !e.leave).sort((a, b) => a.day - b.day).slice(0, 7);
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  pdf.font("Helvetica-Bold").fontSize(10).text("Project Task Category", 40, 40, { continued: false });
  const colW = 55, startX = 220;
  dow.forEach((d, i) => pdf.font("Helvetica-Bold").fontSize(9).text(d, startX + i * colW, 40, { width: colW, align: "center" }));
  pdf.font("Helvetica-Bold").fontSize(9).text("Total\nHours", startX + 7 * colW, 40, { width: colW, align: "center" });
  pdf.moveTo(40, 58).lineTo(startX + 8 * colW, 58).strokeColor("#999").lineWidth(0.5).stroke();

  pdf.font("Helvetica").fontSize(9).fillColor("#333").text(projectName, 40, 65, { width: 170 });
  let total = 0;
  const byDay = new Map(days.map((e) => [e.day, e.hours]));
  const allDays = ctx.kind === "SINGLE" ? Array.from({ length: 7 }, (_, i) => (days[0]?.day || 1) + i) : [];
  dow.forEach((_, i) => {
    const d = days[i]?.day;
    const h = d != null ? byDay.get(d) || 0 : 0;
    total += h;
    pdf.font("Helvetica").fontSize(9).text(h ? h.toFixed(2) : "--", startX + i * colW, 65, { width: colW, align: "center" });
  });
  pdf.font("Helvetica").fontSize(9).text(total.toFixed(2), startX + 7 * colW, 65, { width: colW, align: "center" });

  pdf.moveTo(40, 85).lineTo(startX + 8 * colW, 85).strokeColor("#333").lineWidth(0.8).stroke();
  pdf.font("Helvetica-Bold").fontSize(9).text("TOTAL TIME", 40, 90);
  dow.forEach((_, i) => {
    const d = days[i]?.day;
    const h = d != null ? byDay.get(d) || 0 : 0;
    pdf.font("Helvetica-Bold").fontSize(9).text(h ? h.toFixed(2) : "--", startX + i * colW, 90, { width: colW, align: "center" });
  });
  pdf.font("Helvetica-Bold").fontSize(9).text(total.toFixed(2), startX + 7 * colW, 90, { width: colW, align: "center" });

  pdf.font("Helvetica").fontSize(8).fillColor("#666").text("Hours that have not been approved by a supervisor are flagged (*)", 40, 120);
  pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(employeeName, 40, 150);
  if (ctx.kind === "SINGLE" && days.length) {
    const start = new Date(ctx.periodYear, ctx.periodMonth - 1, days[0].day);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
    pdf.font("Helvetica").fontSize(9).text(`${fmt(start)} - ${fmt(end)}`, 40, 165);
  }
  pdf.font("Helvetica").fontSize(8).fillColor("#999").text("-- 1 of 1 --", 40, 760, { align: "center", width: pdf.page.width - 80 });
  pdf.end();
}

// ---------------- Symsoft — real weekly PDF layout ----------------
// "Timesheet" title, Consultant/Client/Project/Week Period/Status key-value block, a Day/Date/
// Hours/Notes table, TOTAL HOURS line, Manager Approval + phone/fax footer — matches the real
// extracted text layout exactly (confirmed this session against the actual reference PDF).
export function renderSymsoftPdf(ctx: DocumentContext, out: Writable) {
  const pdf = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  pdf.pipe(out);
  const employeeName = ctx.kind === "SINGLE" ? ctx.employeeName : ctx.resources[0]?.employeeName || "";
  const clientName = ctx.clientName || "";
  const projectName = ctx.projectName;
  const entries = (ctx.kind === "SINGLE" ? ctx.entries : ctx.resources[0]?.entries || []).filter((e) => !e.leave).sort((a, b) => a.day - b.day);

  pdf.font("Helvetica-Bold").fontSize(14).fillColor("#000").text("Timesheet", 40, 40);
  const kv = (label: string, value: string, y: number) => {
    pdf.font("Helvetica-Bold").fontSize(10).text(label, 40, y, { continued: true });
    pdf.font("Helvetica").fontSize(10).text(" " + value);
  };
  kv("Consultant", employeeName, 65);
  kv("Client", clientName, 80);
  kv("Project", projectName, 95);
  const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekStart = ctx.kind === "SINGLE" && entries.length ? new Date(ctx.periodYear, ctx.periodMonth - 1, entries[0].day) : null;
  const weekEnd = weekStart ? new Date(weekStart.getTime() + 6 * 86400000) : null;
  const fmtLong = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  kv("Week Period", weekStart && weekEnd ? `${fmtLong(weekStart)} – ${fmtLong(weekEnd)}` : "", 110);
  kv("Status", "APPROVED", 125);

  let y = 150;
  const cols = [{ w: 90, label: "Day" }, { w: 90, label: "Date" }, { w: 50, label: "Hours" }, { w: 230, label: "Notes" }];
  let x = 40;
  pdf.font("Helvetica-Bold").fontSize(9);
  cols.forEach((c) => { pdf.text(c.label, x, y, { width: c.w }); x += c.w; });
  y += 16;
  pdf.moveTo(40, y - 2).lineTo(460, y - 2).strokeColor("#999").lineWidth(0.5).stroke();
  let total = 0;
  const hoursByDay = new Map(entries.map((e) => [e.day, e.hours]));
  if (weekStart) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart.getTime() + i * 86400000);
      const h = hoursByDay.get(d.getDate()) || 0;
      total += h;
      x = 40;
      pdf.font("Helvetica").fontSize(9);
      const rowVals = [DOW_NAMES[d.getDay()], `${DOW_NAMES[d.getDay()].slice(0, 3)}, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, h ? String(h) : "-", (entries.find((e) => e.day === d.getDate())?.comment || "")];
      rowVals.forEach((v, i) => { pdf.text(v, x, y, { width: cols[i].w }); x += cols[i].w; });
      y += 18;
    }
  }
  pdf.moveTo(40, y).lineTo(460, y).strokeColor("#333").lineWidth(0.8).stroke();
  y += 8;
  pdf.font("Helvetica-Bold").fontSize(10).text(`TOTAL HOURS ${total}`, 40, y);
  y += 30;
  pdf.font("Helvetica-Bold").fontSize(9).text("Manager Approval", 40, y);
  y += 14;
  pdf.font("Helvetica").fontSize(9).text("Date: _______________", 40, y);
  pdf.font("Helvetica").fontSize(8).fillColor("#666").text("Phone: 916.567.1740 | Fax: 916.290.9067 | SymSoftSolutions.com", 40, 760);
  pdf.end();
}

// ---------------- GenAquarius Standard — real "Work Order Monthly Timesheet Report" look ----------------
// Measured exactly off Downloads/Updated Template/Default Template.xlsx: a plain header block
// (Report/Client Name/Billing Criteria), a blue-banner "Summary Report" (Resource Name/Project
// Name/Value), a SEPARATE "Comparison Table" — rows are metrics (Working Days/Holiday/Leave/
// Billable Hrs Per Day/Billable Days/Total Billable Hrs), one COLUMN per resource, "Total
// Billable Hrs" highlighted light-blue (#E5EEF7) label + blue-tinted value, bold — and a
// per-resource "Resource Name: X" / "Stage-Task Name" blue-banner grid with day-of-month number
// columns, task rows, weekend/holiday columns shaded a light olive/gray, "-" for no-work cells,
// and a light-blue "Total" row.
const BLUE = "FF528BCB";
const BLUE_TINT = "FFBDD7EE"; // theme 4 tint ~0.8 approximated as a literal color
const LIGHT_BLUE_BG = "FFE5EEF7";
const HOLIDAY_SHADE = "FFC6D9B2"; // theme 3 tint ~0.6 approximated as a literal olive-gray
const WHITE = "FFFFFFFF";
// Excel's own standard "light red" conditional-formatting palette — used for the Leave marker so
// it reads as a distinct, recognizable color rather than just more plain text in the grid.
const LEAVE_SHADE = "FFFFC7CE";
const LEAVE_TEXT = "FF9C0006";
// Non-billable task rows get a light amber tint — distinct from both the plain white billable
// rows and the weekend/leave shading — so Finance/PM can spot at a glance which logged hours
// will NOT count toward invoice/forecast.
const NON_BILLABLE_SHADE = "FFFFF2CC";
const NON_BILLABLE_TEXT = "FF9C6500";
const allThin = { top: { style: "thin" as const }, bottom: { style: "thin" as const }, left: { style: "thin" as const }, right: { style: "thin" as const } };

function isWeekend(year: number, month: number, day: number) {
  const dow = new Date(year, month - 1, day).getDay();
  return dow === 0 || dow === 6;
}

// Thin borders on every cell in the range, with a medium border on the range's own outer edge —
// gives a block (e.g. one resource's whole Task×Day grid) a real bounding border, not just the
// internal grid lines every cell already has from its own fill.
function applyGridBorders(sheet: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      sheet.getCell(r, c).border = {
        top: { style: r === r1 ? "medium" : "thin" },
        bottom: { style: r === r2 ? "medium" : "thin" },
        left: { style: c === c1 ? "medium" : "thin" },
        right: { style: c === c2 ? "medium" : "thin" },
      };
    }
  }
}

export async function renderGenAquariusStandardXlsx(ctx: DocumentContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const projectName = ctx.projectName;
  const resources = ctx.kind === "REPORT" ? ctx.resources : [{ employeeName: ctx.employeeName, entries: ctx.entries, country: ctx.country, businessUnitId: ctx.businessUnitId }];
  const periodMonth = ctx.periodMonth, periodYear = ctx.periodYear;
  const sheet = wb.addWorksheet(`${MONTH_ABBR[periodMonth - 1]}-${periodYear}`.slice(0, 31));
  // Real holiday count per resource — HR Settings → Annual Leaves (Holidays) for that resource's
  // own country, falling back from their Business Unit's own calendar (if it has one) to the
  // country-wide default, same resolution rule engine/workdays.ts's workingDaysInMonth uses.
  // Weekday holidays only (a holiday that happens to fall on a weekend is already covered by the
  // SAT/SUN marker, not double-counted here).
  const holidayCountByResource = new Map<string, number>();
  for (const res of resources) {
    const country = (res as { country?: string | null }).country;
    const businessUnitId = (res as { businessUnitId?: number | null }).businessUnitId;
    let count = 0;
    if (country) {
      const start = new Date(periodYear, periodMonth - 1, 1), end = new Date(periodYear, periodMonth, 1);
      const hols = await buRows(businessUnitId ?? null, (bu) => prisma.holiday.findMany({ where: { country: country.toUpperCase(), date: { gte: start, lt: end }, ...bu } }));
      for (const h of hols) { const dow = new Date(h.date).getDay(); if (dow !== 0 && dow !== 6) count++; }
    }
    holidayCountByResource.set(res.employeeName, count);
  }

  sheet.getCell(4, 2).value = "Report"; sheet.getCell(4, 2).font = { bold: true, size: 11, name: CALIBRI };
  sheet.getCell(4, 4).value = ":"; sheet.getCell(4, 4).font = { bold: true, size: 11, name: CALIBRI };
  const daysInM = new Date(periodYear, periodMonth, 0).getDate();
  sheet.getCell(4, 5).value = `${String(periodMonth).padStart(2, "0")}/01/${periodYear} To ${String(periodMonth).padStart(2, "0")}/${daysInM}/${periodYear}`;
  sheet.getCell(4, 5).font = { size: 11, name: CALIBRI };
  sheet.getCell(5, 2).value = "Client Name"; sheet.getCell(5, 2).font = { bold: true, size: 11, name: CALIBRI };
  sheet.getCell(5, 4).value = ":"; sheet.getCell(5, 4).font = { bold: true, size: 11, name: CALIBRI };
  sheet.getCell(5, 5).value = ctx.clientName || ""; sheet.getCell(5, 5).font = { size: 11, name: CALIBRI };
  sheet.getCell(6, 2).value = "Billing Criteria"; sheet.getCell(6, 2).font = { bold: true, size: 11, name: CALIBRI };
  sheet.getCell(6, 4).value = ":"; sheet.getCell(6, 4).font = { bold: true, size: 11, name: CALIBRI };
  sheet.getCell(6, 5).value = "Billable"; sheet.getCell(6, 5).font = { size: 11, name: CALIBRI };

  // Summary Report — one real merged banner cell (B8:E8), not the same text repeated into 4
  // separate cells (the "junk text repeated across columns" this and the Comparison Table banner
  // below, and the Resource Name row further down, all shared the same bug).
  sheet.mergeCells(8, 2, 8, 5);
  const summaryBanner = sheet.getCell(8, 2);
  summaryBanner.value = "Summary Report";
  summaryBanner.font = { bold: true, size: 11, color: { argb: WHITE }, name: CALIBRI };
  summaryBanner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  const sumHeaders = ["Resource Name", "Project Name", "Value"];
  [2, 3, 4].forEach((c, i) => { const cell = sheet.getCell(10, c); cell.value = sumHeaders[i] || ""; cell.font = { bold: true, size: 10, color: { argb: WHITE }, name: CALIBRI }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } }; cell.border = allThin; });
  let sr = 11;
  const resourceTotals = new Map<string, number>();
  // Billable-only total — what "Individual Billable Hrs"/"Total Billable" below must actually
  // reflect (never the blended totalHours figure, which includes non-billable work too).
  const billableTotals = new Map<string, number>();
  for (const res of resources) {
    const total = res.entries.filter((e) => !e.leave).reduce((s, e) => s + (e.hours || 0), 0);
    resourceTotals.set(res.employeeName, total);
    billableTotals.set(res.employeeName, res.entries.filter((e) => !e.leave && e.billable !== false).reduce((s, e) => s + (e.hours || 0), 0));
    sheet.getCell(sr, 2).value = res.employeeName; sheet.getCell(sr, 2).font = { size: 9, name: CALIBRI }; sheet.getCell(sr, 2).border = allThin; sheet.getCell(sr, 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WHITE } };
    sheet.getCell(sr, 3).value = projectName; sheet.getCell(sr, 3).font = { size: 9, name: CALIBRI }; sheet.getCell(sr, 3).border = allThin; sheet.getCell(sr, 3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WHITE } };
    sheet.getCell(sr, 4).value = total; sheet.getCell(sr, 4).font = { size: 9, name: CALIBRI }; sheet.getCell(sr, 4).border = allThin; sheet.getCell(sr, 4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WHITE } };
    sr += 1;
  }
  // Grand-total row under the Value column — the reference template has this and the previous
  // version of this renderer dropped it entirely.
  sheet.getCell(sr, 2).value = "Total"; sheet.getCell(sr, 2).font = { bold: true, size: 9, name: CALIBRI }; sheet.getCell(sr, 2).border = allThin; sheet.getCell(sr, 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } };
  sheet.getCell(sr, 3).value = " --"; sheet.getCell(sr, 3).font = { size: 9, name: CALIBRI }; sheet.getCell(sr, 3).border = allThin; sheet.getCell(sr, 3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } };
  const summaryGrandTotal = [...resourceTotals.values()].reduce((a, b) => a + b, 0);
  sheet.getCell(sr, 4).value = Math.round(summaryGrandTotal * 100) / 100; sheet.getCell(sr, 4).font = { bold: true, size: 9, name: CALIBRI }; sheet.getCell(sr, 4).border = allThin; sheet.getCell(sr, 4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE_TINT } };
  sr += 1;

  // Comparison Table — transposed: metrics as rows, one column per resource
  const compCol0 = 13; // column M
  const compColEnd = compCol0 + 1 + resources.length;
  sheet.mergeCells(8, compCol0, 8, compColEnd);
  const comparisonBanner = sheet.getCell(8, compCol0);
  comparisonBanner.value = "Comparison Table";
  comparisonBanner.font = { bold: true, size: 9, color: { argb: WHITE }, name: "Arial" };
  comparisonBanner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  // Every Comparison Table label gets the SAME M:N merge (column N was otherwise just a bare,
  // unused spacer) — gives the label real width to render in without needing column M itself
  // (which doubles as the per-resource grid's own "day 8" column below) to be wide too.
  const mergeLabelCell = (row: number) => { sheet.mergeCells(row, compCol0, row, compCol0 + 1); sheet.getCell(row, compCol0).alignment = { wrapText: true, vertical: "middle" }; };
  sheet.getCell(9, compCol0).value = "Resource Name"; sheet.getCell(9, compCol0).font = { bold: true, size: 8, color: { argb: WHITE }, name: "Arial" }; sheet.getCell(9, compCol0).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  mergeLabelCell(9);
  resources.forEach((res, i) => {
    const cell = sheet.getCell(9, compCol0 + 2 + i);
    cell.value = res.employeeName; cell.font = { bold: true, size: 8, color: { argb: WHITE }, name: "Arial" }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  });
  const metricRows: { label: string; calc: (res: typeof resources[number]) => number }[] = [
    { label: "Working Days", calc: () => { let w = 0; for (let d = 1; d <= daysInM; d++) if (!isWeekend(periodYear, periodMonth, d)) w++; return w; } },
    { label: "Holiday", calc: (res) => holidayCountByResource.get(res.employeeName) || 0 },
    { label: "Leave", calc: (res) => res.entries.filter((e) => e.leave).length },
    { label: "Billable Hrs Per Day", calc: () => 8 },
  ];
  let mr = 10;
  const workingDaysByResource = new Map<string, number>();
  const holidayByResource = new Map<string, number>();
  for (const m of metricRows) {
    sheet.getCell(mr, compCol0).value = m.label; sheet.getCell(mr, compCol0).font = { size: 9, name: CALIBRI }; sheet.getCell(mr, compCol0).border = allThin;
    mergeLabelCell(mr);
    resources.forEach((res, i) => {
      const v = m.calc(res);
      if (m.label === "Working Days") workingDaysByResource.set(res.employeeName, v);
      if (m.label === "Holiday") holidayByResource.set(res.employeeName, v);
      const cell = sheet.getCell(mr, compCol0 + 2 + i);
      cell.value = v; cell.font = { size: 9, name: CALIBRI }; cell.border = allThin;
    });
    mr += 1;
  }
  // Billable Days = Working Days - Holiday - Leave
  sheet.getCell(mr, compCol0).value = "Billable Days"; sheet.getCell(mr, compCol0).font = { size: 9, name: CALIBRI }; sheet.getCell(mr, compCol0).border = allThin;
  mergeLabelCell(mr);
  resources.forEach((res, i) => {
    const working = workingDaysByResource.get(res.employeeName) || 0;
    const holiday = holidayByResource.get(res.employeeName) || 0;
    const leave = res.entries.filter((e) => e.leave).length;
    const billable = working - holiday - leave;
    const cell = sheet.getCell(mr, compCol0 + 2 + i);
    cell.value = billable; cell.font = { size: 9, name: CALIBRI }; cell.border = allThin;
  });
  mr += 1;
  // Weekend Support Hrs. — hours actually logged on a Sat/Sun (on-call/support work), separate
  // from the normal weekday billable hours below.
  sheet.getCell(mr, compCol0).value = "Weekend Support Hrs."; sheet.getCell(mr, compCol0).font = { size: 9, name: CALIBRI }; sheet.getCell(mr, compCol0).border = allThin;
  mergeLabelCell(mr);
  resources.forEach((res, i) => {
    const weekendHrs = res.entries.filter((e) => !e.leave && isWeekend(periodYear, periodMonth, e.day)).reduce((s, e) => s + (e.hours || 0), 0);
    const cell = sheet.getCell(mr, compCol0 + 2 + i);
    cell.value = weekendHrs; cell.font = { size: 9, name: CALIBRI }; cell.border = allThin;
  });
  mr += 1;
  // Non-Billable Hrs — surfaced as its own row so Finance/PM can see at a glance how much of a
  // resource's logged time will NOT count toward invoice/forecast.
  sheet.getCell(mr, compCol0).value = "Non-Billable Hrs"; sheet.getCell(mr, compCol0).font = { size: 9, name: CALIBRI }; sheet.getCell(mr, compCol0).border = allThin;
  mergeLabelCell(mr);
  resources.forEach((res, i) => {
    const nb = (resourceTotals.get(res.employeeName) || 0) - (billableTotals.get(res.employeeName) || 0);
    const cell = sheet.getCell(mr, compCol0 + 2 + i);
    cell.value = Math.round(nb * 100) / 100; cell.font = { size: 9, name: CALIBRI }; cell.border = allThin;
  });
  mr += 1;
  // Individual Billable Hrs — each resource's own BILLABLE-ONLY total (was mislabeled "Total
  // Billable Hrs" while also being per-resource, not an actual total, AND previously used the
  // blended totalHours instead of billable-only; the real grand total is its own row below).
  sheet.getCell(mr, compCol0).value = "Individual Billable Hrs "; sheet.getCell(mr, compCol0).font = { bold: true, size: 9, name: CALIBRI }; sheet.getCell(mr, compCol0).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } }; sheet.getCell(mr, compCol0).border = allThin;
  mergeLabelCell(mr);
  resources.forEach((res, i) => {
    const cell = sheet.getCell(mr, compCol0 + 2 + i);
    cell.value = billableTotals.get(res.employeeName) || 0; cell.font = { bold: true, size: 9, name: CALIBRI }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE_TINT } }; cell.border = allThin;
  });
  mr += 1;
  // Total Billable — one grand-total value (sum across every resource), shown once in the first
  // value column only, not repeated per resource. Billable-only, matching Finance's Monthly
  // Forecast approval (which now computes Invoice Amount off billable hours exclusively).
  sheet.getCell(mr, compCol0).value = "Total Billable"; sheet.getCell(mr, compCol0).font = { bold: true, size: 9, name: CALIBRI }; sheet.getCell(mr, compCol0).border = allThin;
  mergeLabelCell(mr);
  const grandTotal = resources.reduce((s, res) => s + (billableTotals.get(res.employeeName) || 0), 0);
  const grandCell = sheet.getCell(mr, compCol0 + 2);
  grandCell.value = Math.round(grandTotal * 100) / 100; grandCell.font = { bold: true, size: 9, name: CALIBRI }; grandCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE_TINT } }; grandCell.border = allThin;

  // Per-resource Task×Day grid
  let gridRow = Math.max(sr, mr) + 3;
  for (const res of resources) {
    const byTask = groupByHead(res.entries as SingleTimesheetContext["entries"]);
    const taskGroups = byTask.length ? byTask : [["", res.entries]] as [string, SingleTimesheetContext["entries"]][];
    // One real merged cell spanning the FULL row width (through the last day column), with the
    // blue fill covering the whole thing — not the same text repeated into 5 separate cells with
    // only the first one colored, which is what this used to do.
    const totalCol = 5 + daysInM + 1;
    const headerRow = gridRow;
    sheet.mergeCells(headerRow, 1, headerRow, totalCol);
    const headerCell = sheet.getCell(headerRow, 1);
    headerCell.value = `Resource Name: ${res.employeeName}`;
    headerCell.font = { bold: true, size: 9, color: { argb: WHITE }, name: "Arial" };
    headerCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    headerCell.alignment = { vertical: "middle", horizontal: "left" };
    gridRow += 1;
    const taskHeaderRow = gridRow;
    sheet.getCell(taskHeaderRow, 1).value = "Stage-Task Name"; sheet.getCell(taskHeaderRow, 1).font = { bold: true, size: 9, color: { argb: WHITE }, name: CALIBRI }; sheet.getCell(taskHeaderRow, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    for (let d = 1; d <= daysInM; d++) {
      const cell = sheet.getCell(taskHeaderRow, 5 + d);
      cell.value = d; cell.font = { bold: true, size: 9, color: { argb: WHITE }, name: CALIBRI }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    }
    // Per-task/Resource Total row total, right after the last day column — this was missing
    // entirely, so every row visually just stopped at the last day with no total shown.
    const totalHeaderCell = sheet.getCell(taskHeaderRow, totalCol);
    totalHeaderCell.value = "Total"; totalHeaderCell.font = { bold: true, size: 9, color: { argb: WHITE }, name: CALIBRI }; totalHeaderCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    gridRow += 1;
    const firstTaskRow = gridRow;
    // A day is a "pure leave day" (merge the whole column into one Leave marker, instead of
    // repeating it on every task row) only when a leave entry exists AND nothing else was
    // actually logged that day — someone who both took partial leave and logged real hours the
    // same day keeps the normal per-task cells instead, so that data is never hidden. Same idea
    // for "pure weekend" — only merge+shade a Sat/Sun column when truly nothing was logged on it.
    const leaveDays = new Set<number>();
    const anyEntryDays = new Set<number>();
    const hoursLoggedDays = new Set<number>();
    for (const e of res.entries) {
      anyEntryDays.add(e.day);
      if (e.leave) leaveDays.add(e.day);
      else if (e.hours) hoursLoggedDays.add(e.day);
    }
    const pureLeaveDay = (d: number) => leaveDays.has(d) && !hoursLoggedDays.has(d);
    const pureWeekendDay = (d: number) => isWeekend(periodYear, periodMonth, d) && !anyEntryDays.has(d);
    for (const [task, taskEntries] of taskGroups) {
      const nonBillableRow = task.endsWith(" (Non-Billable)");
      sheet.getCell(gridRow, 1).value = task || ""; sheet.getCell(gridRow, 1).font = { size: 8, name: CALIBRI, color: nonBillableRow ? { argb: NON_BILLABLE_TEXT } : undefined, italic: nonBillableRow };
      if (nonBillableRow) sheet.getCell(gridRow, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NON_BILLABLE_SHADE } };
      const byDay = new Map(taskEntries.filter((e) => !e.leave).map((e) => [e.day, e.hours]));
      for (let d = 1; d <= daysInM; d++) {
        if (pureLeaveDay(d) || pureWeekendDay(d)) continue; // written once, merged, below instead
        const cell = sheet.getCell(gridRow, 5 + d);
        const weekend = isWeekend(periodYear, periodMonth, d);
        cell.value = byDay.has(d) ? byDay.get(d)! : "-";
        cell.font = { size: 8, name: CALIBRI };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: weekend ? HOLIDAY_SHADE : nonBillableRow ? NON_BILLABLE_SHADE : WHITE } };
      }
      const taskTotal = [...byDay.values()].reduce((s, h) => s + (h || 0), 0);
      const taskTotalCell = sheet.getCell(gridRow, totalCol);
      taskTotalCell.value = taskTotal; taskTotalCell.font = { bold: true, size: 8, name: CALIBRI }; taskTotalCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } };
      gridRow += 1;
    }
    const lastTaskRow = gridRow - 1;
    // One merged marker cell per pure leave/weekend day, spanning every task row for this
    // resource — Leave gets its own distinct color so it reads at a glance, separate from the
    // plain weekend shading.
    for (let d = 1; d <= daysInM; d++) {
      const col = 5 + d;
      if (pureLeaveDay(d)) {
        if (lastTaskRow > firstTaskRow) sheet.mergeCells(firstTaskRow, col, lastTaskRow, col);
        const cell = sheet.getCell(firstTaskRow, col);
        cell.value = "LEAVE";
        cell.font = { size: 8, name: CALIBRI, bold: true, color: { argb: LEAVE_TEXT } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LEAVE_SHADE } };
        // Vertical (stacked) text — the merged cell is many rows tall but still just one narrow
        // day column, so horizontal text would either overflow sideways into neighboring days or
        // get truncated; reading top-to-bottom fits the cell's actual shape.
        cell.alignment = { vertical: "middle", horizontal: "center", textRotation: "vertical" };
      } else if (pureWeekendDay(d)) {
        if (lastTaskRow > firstTaskRow) sheet.mergeCells(firstTaskRow, col, lastTaskRow, col);
        const cell = sheet.getCell(firstTaskRow, col);
        const dow = new Date(periodYear, periodMonth - 1, d).getDay();
        cell.value = dow === 6 ? "SAT" : "SUN";
        cell.font = { size: 8, name: CALIBRI, bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HOLIDAY_SHADE } };
        cell.alignment = { vertical: "middle", horizontal: "center", textRotation: "vertical" };
      }
    }
    sheet.getCell(gridRow, 2).value = "Total"; sheet.getCell(gridRow, 2).font = { bold: true, size: 9, name: CALIBRI }; sheet.getCell(gridRow, 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } };
    const allByDay = new Map<number, number>();
    for (const [, taskEntries] of taskGroups) for (const e of taskEntries) if (!e.leave) allByDay.set(e.day, (allByDay.get(e.day) || 0) + e.hours);
    for (let d = 1; d <= daysInM; d++) {
      const cell = sheet.getCell(gridRow, 5 + d);
      cell.value = allByDay.has(d) ? allByDay.get(d)! : "-";
      cell.font = { bold: true, size: 9, name: CALIBRI };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } };
    }
    const resourceGrandTotal = [...allByDay.values()].reduce((s, h) => s + (h || 0), 0);
    const resourceTotalCell = sheet.getCell(gridRow, totalCol);
    resourceTotalCell.value = resourceGrandTotal; resourceTotalCell.font = { bold: true, size: 9, name: CALIBRI }; resourceTotalCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE_BG } };
    // Thin grid lines on every cell of this resource's block, PLUS a medium border around its
    // true outer edge (headerRow through the Total row just written) — previously this whole
    // block had no border at all, same style gap the Summary/Comparison tables above never had.
    applyGridBorders(sheet, headerRow, 1, gridRow, totalCol);
    gridRow += 2;
  }

  sheet.getColumn(1).width = 28;
  for (let c = 2; c <= 5; c++) sheet.getColumn(c).width = 10;
  for (let d = 1; d <= 31; d++) sheet.getColumn(5 + d).width = 3.5;
  // The per-row Total column sits right after the last real day column — override its width
  // back up from the narrow day-column default (which the loop above applies to it too, since
  // it always runs through a fixed 31 columns regardless of this month's actual length).
  sheet.getColumn(5 + daysInM + 1).width = 8;
  // The Comparison Table shares its column range with the per-resource day grid above (both
  // start around column M) — its label column was getting the day grid's narrow 4.5 width,
  // squeezing labels like "Individual Billable Hrs" down to unreadable/invisible. Widening it
  // (and the resource-name/value columns next to it) makes the one day column underneath it
  // wider than its neighbors in the grid below, which is an acceptable trade-off for the label
  // actually being visible.
  sheet.getColumn(compCol0).width = 20;
  for (let i = 0; i < resources.length; i++) sheet.getColumn(compCol0 + 2 + i).width = 9;
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
