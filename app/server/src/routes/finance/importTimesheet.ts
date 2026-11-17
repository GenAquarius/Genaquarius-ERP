// Finance's "Import Timesheet" feature — uploads a client-supplied timesheet file, extracts
// employee/date/hours rows into ApprovedHour (source=IMPORTED, status=PENDING), lets Finance
// review/approve them (Finance → Approved Hours), and applies approved rows onto the existing
// MonthlyLine engine so invoice generation picks them up — see applyApprovedHoursToMonthlyLine
// below. Deliberately does NOT build a second, parallel billing engine: imported hours become
// MonthlyLine.actualHours/billingAmount for the matching employee/project/month, same fields
// Monthly Forecast & Actuals (and invoice generation) already read everywhere else in this app.
import { Router } from "express";
import ExcelJS from "exceljs";
import { PDFParse } from "pdf-parse";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";

const router = Router();
router.use(requireAdmin);
router.use(requirePermission("timesheet-templates"));

// A single extracted hours row, already summed to the (employee, project, month) grain —
// never one row per raw timesheet line-item (a Station Casino xlsx has one row per Azure DevOps
// work item; a multi-week WEnergy/Symsoft PDF has one block per week) — those would either flood
// Approved Hours with noise or, worse, each separately overwrite the same MonthlyLine.actualHours
// on Approve instead of adding up to the real monthly total. See each parser's own comment for its
// specific grouping key.
type ParsedRow = { employeeName: string; project: string | null; periodMonth: number; periodYear: number; regularHours: number; otHours: number };

// Mon..Sun → whichever calendar month has the most days in that span — used by both PDF parsers
// to decide which month a week that straddles a month boundary (e.g. Mon 8/31–Sun 9/6) counts
// toward. Finance can always correct the Period on a row afterward (Approved Hours is editable),
// this is just a sensible default rather than leaving it unset.
function weekDominantMonth(start: Date, end: Date): { year: number; month: number } {
  const counts = new Map<string, number>();
  const d = new Date(start);
  while (d <= end) {
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    d.setDate(d.getDate() + 1);
  }
  let best = "", bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { bestCount = c; best = k; }
  const [y, m] = best.split("-").map(Number);
  return { year: y, month: m };
}
const parseMMDDYY = (s: string) => { const [m, d, y] = s.split("/").map(Number); return new Date(2000 + y, m - 1, d); };

// Column-name synonyms a real client file might use — matched case-insensitively against the
// header row exceljs reads. Good enough for the two xlsx formats this session confirmed exist
// (Station Casino) without hardcoding their exact column order; a genuinely new, unrecognized
// layout just leaves more rows unmapped (regularHours 0), which Finance reviews before approving
// anyway — never silently invents hours.
const COLUMN_SYNONYMS: Record<string, string[]> = {
  employeeName: ["employee", "employee name", "resource", "resource name", "name"],
  date: ["date", "work date", "period", "week ending"],
  regularHours: ["regular hours", "reg hours", "hours", "regular", "total hours"],
  otHours: ["ot hours", "overtime", "ot", "overtime hours"],
  project: ["project", "client", "project name"],
};

function matchColumn(header: string): string | null {
  const h = header.trim().toLowerCase();
  for (const [key, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    if (synonyms.some((s) => h === s || h.includes(s))) return key;
  }
  return null;
}

async function parseXlsx(buffer: Buffer): Promise<{ rows: any[]; headerFound: boolean }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], headerFound: false };
  // First row with 3+ non-empty cells is treated as the header — real client files often have a
  // title/logo row or two above the actual column headers.
  let headerRowIdx = -1;
  let colMap: Record<number, string> = {};
  sheet.eachRow((row, rowNumber) => {
    if (headerRowIdx !== -1) return;
    const nonEmpty = (row.values as any[]).filter((v) => v != null && String(v).trim() !== "");
    if (nonEmpty.length < 3) return;
    const map: Record<number, string> = {};
    row.eachCell((cell, colNumber) => { const m = matchColumn(String(cell.value || "")); if (m) map[colNumber] = m; });
    if (Object.keys(map).length >= 2) { headerRowIdx = rowNumber; colMap = map; }
  });
  if (headerRowIdx === -1) return { rows: [], headerFound: false };
  const rows: any[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowIdx) return;
    const out: any = {};
    for (const [col, key] of Object.entries(colMap)) {
      const cell = row.getCell(Number(col));
      out[key] = cell?.value;
    }
    if (out.employeeName || out.regularHours) rows.push(out);
  });
  return { rows, headerFound: true };
}

// "Last, First" or "Last, First <email@client.com>" (both seen in the real export, column name
// and even column ORDER vary sheet-to-sheet within the same workbook) → "First Last", matching
// how this app's own Employee.name is stored. Falls back to the raw text (minus email) if it
// isn't in "Last, First" form at all.
function stationCasinoName(raw: string): string {
  const noEmail = String(raw || "").split("<")[0].trim();
  const [last, first] = noEmail.split(",").map((s) => s.trim());
  return first && last ? `${first} ${last}` : noEmail;
}

// Station Casino's real export (confirmed against both reference workbooks): an Azure DevOps
// work-item extract, ONE WORKSHEET PER EMPLOYEE (e.g. "Arun Timesheet", "Hem Timesheet") plus one
// combined "<Team> Team" sheet for everyone else — column SET and ORDER both vary sheet-to-sheet
// (some have "Assigned To", some don't and rely on the sheet's own name instead), so every sheet
// is header-matched independently rather than assuming a fixed layout. Each row is one work item
// ("Completed Work" hours against one Title/ID) — grouped and summed to (employee, project, month)
// here, never imported as one ApprovedHour row per work item.
async function parseStationCasinoXlsx(buffer: Buffer): Promise<{ rows: ParsedRow[]; headerFound: boolean }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const buckets = new Map<string, ParsedRow>();
  let anySheetMatched = false;
  for (const sheet of wb.worksheets) {
    let headerRowIdx = -1;
    const col: { assignedTo?: number; completedWork?: number; closedDate?: number; project?: number } = {};
    sheet.eachRow((row, rowNumber) => {
      if (headerRowIdx !== -1) return;
      const map: typeof col = {};
      row.eachCell((cell, colNumber) => {
        const h = String(cell.value || "").trim().toLowerCase();
        if (h === "assigned to") map.assignedTo = colNumber;
        else if (h === "completed work") map.completedWork = colNumber;
        else if (h === "closed date") map.closedDate = colNumber;
        else if (h === "project") map.project = colNumber;
      });
      // A real work-item sheet always has Completed Work + Closed Date — Assigned To/Project are
      // each individually optional (see the three different real column sets this confirmed).
      if (map.completedWork && map.closedDate) { headerRowIdx = rowNumber; Object.assign(col, map); }
    });
    if (headerRowIdx === -1) continue; // not a work-item sheet (unexpected extra tab) — skip, not an error
    anySheetMatched = true;
    // "Hem Timesheet" → "Hem"; "Jad Salman Timesheet" → "Jad Salman" — used only when this sheet
    // has no Assigned To column of its own (confirmed real case for 2 of the 3 per-person sheets).
    const sheetEmployeeName = sheet.name.replace(/\s*timesheet\s*$/i, "").trim();
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowIdx) return;
      const hours = Number(row.getCell(col.completedWork!).value) || 0;
      if (!hours) return;
      const closedRaw = row.getCell(col.closedDate!).value;
      const closed = closedRaw ? new Date(closedRaw as any) : null;
      if (!closed || isNaN(+closed)) return;
      const employeeName = col.assignedTo ? stationCasinoName(row.getCell(col.assignedTo).value as any) : sheetEmployeeName;
      const project = col.project ? String(row.getCell(col.project).value || "").trim() || null : null;
      const periodMonth = closed.getMonth() + 1, periodYear = closed.getFullYear();
      const key = `${employeeName}|||${project}|||${periodMonth}|||${periodYear}`;
      const existing = buckets.get(key);
      if (existing) existing.regularHours = Math.round((existing.regularHours + hours) * 100) / 100;
      else buckets.set(key, { employeeName, project, periodMonth, periodYear, regularHours: Math.round(hours * 100) / 100, otHours: 0 });
    });
  }
  return { rows: [...buckets.values()], headerFound: anySheetMatched };
}

// WEnergy's real export (confirmed against the reference PDF): a text-layer PDF, one week per
// page/block — "<Project/Task/Category wrapped text> <7 day columns> <Total>" row(s), then
// "TOTAL TIME <7 day columns> <weekly total>", then the employee's name and "M/D/YY - M/D/YY"
// date range as their own lines. The per-task Project/Task/Category cell wraps across several
// lines with no reliable cell boundary in the extracted text (confirmed — see this feature's own
// investigation), so unlike Station Casino/Symsoft this does NOT attempt to resolve a project per
// row — Finance maps it manually in Approved Hours, same as any other unmatched name. Multiple
// week-blocks for the same employee landing in the same target month are summed into one row.
async function parseWEnergyPdf(buffer: Buffer): Promise<{ rows: ParsedRow[]; headerFound: boolean }> {
  const { text } = await new PDFParse({ data: buffer }).getText();
  const totalRe = /TOTAL TIME\s+([\d.\s-]+?)(\d+\.\d{2})\s*\n/g;
  const nameRe = /\n([A-Za-z][A-Za-z .'-]+)\n(\d{1,2}\/\d{1,2}\/\d{2})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2})/g;
  const totals = [...text.matchAll(totalRe)].map((m) => parseFloat(m[2]));
  const names = [...text.matchAll(nameRe)];
  const buckets = new Map<string, ParsedRow>();
  names.forEach((m, i) => {
    const hours = totals[i];
    if (hours == null) return;
    const employeeName = m[1].trim();
    const { year, month } = weekDominantMonth(parseMMDDYY(m[2]), parseMMDDYY(m[3]));
    const key = `${employeeName}|||${month}|||${year}`;
    const existing = buckets.get(key);
    if (existing) existing.regularHours = Math.round((existing.regularHours + hours) * 100) / 100;
    else buckets.set(key, { employeeName, project: null, periodMonth: month, periodYear: year, regularHours: Math.round(hours * 100) / 100, otHours: 0 });
  });
  return { rows: [...buckets.values()], headerFound: names.length > 0 };
}

// Symsoft's real export (confirmed against the reference PDF): a text-layer PDF, one week per
// page — "Consultant/Client/Project/Week Period/Status" header block, a "Day Date Hours Notes"
// table, then "TOTAL HOURS <n>". Multiple week-blocks (confirmed: the sample spans 2 weeks across
// 2 pages) for the same employee+project landing in the same target month are summed into one row
// — approving per-week would otherwise each separately overwrite the same MonthlyLine.actualHours
// instead of adding up to the real monthly total (see this file's own ParsedRow comment).
async function parseSymsoftPdf(buffer: Buffer): Promise<{ rows: ParsedRow[]; headerFound: boolean }> {
  const { text } = await new PDFParse({ data: buffer }).getText();
  const re = /Consultant\s+(.+?)\nClient\s+(.+?)\nProject\s+(.+?)\nWeek Period\s+(.+?)\n[\s\S]*?TOTAL HOURS\s+(\d+(?:\.\d+)?)/g;
  const buckets = new Map<string, ParsedRow>();
  let matchCount = 0;
  for (const m of text.matchAll(re)) {
    matchCount++;
    const employeeName = m[1].trim(), project = m[3].trim(), weekPeriod = m[4], hours = Number(m[5]);
    const [startStr, endStr] = weekPeriod.split(/[–—-]/).map((s) => s.trim());
    const start = new Date(startStr), end = endStr ? new Date(endStr) : start;
    const { year, month } = !isNaN(+start) && !isNaN(+end) ? weekDominantMonth(start, end) : { year: start.getFullYear() || new Date().getFullYear(), month: (start.getMonth?.() ?? 0) + 1 };
    const key = `${employeeName}|||${project}|||${month}|||${year}`;
    const existing = buckets.get(key);
    if (existing) existing.regularHours = Math.round((existing.regularHours + hours) * 100) / 100;
    else buckets.set(key, { employeeName, project, periodMonth: month, periodYear: year, regularHours: Math.round(hours * 100) / 100, otHours: 0 });
  }
  return { rows: [...buckets.values()], headerFound: matchCount > 0 };
}

// Multer-free upload — the client base64-encodes the file into the JSON body (small files, same
// convention as document uploads elsewhere in this app, e.g. ess/onboarding-docs).
router.post("/upload", async (req, res) => {
  const b = req.body || {};
  if (!b.fileData || !b.fileName) return res.status(400).json({ error: "File is required" });
  const format = String(b.format || "GENERIC_XLSX");
  const periodMonth = b.periodMonth ? Number(b.periodMonth) : null;
  const periodYear = b.periodYear ? Number(b.periodYear) : null;
  const buffer = Buffer.from(String(b.fileData).split(",").pop() || "", "base64");

  const batch = await prisma.importedTimesheetBatch.create({
    data: { format, fileName: b.fileName, uploadedById: req.user!.id, periodMonth, periodYear },
  });

  const isPdf = /\.pdf$/i.test(b.fileName);
  let rows: ParsedRow[] = [];
  let headerFound = false;
  try {
    if (format === "WENERGY_PDF") {
      ({ rows, headerFound } = await parseWEnergyPdf(buffer));
    } else if (format === "SYMSOFT_PDF") {
      ({ rows, headerFound } = await parseSymsoftPdf(buffer));
    } else if (format === "STATION_CASINO_XLSX") {
      ({ rows, headerFound } = await parseStationCasinoXlsx(buffer));
    } else if (!isPdf) {
      const generic = await parseXlsx(buffer);
      rows = generic.rows.map((r) => ({
        employeeName: String(r.employeeName || "").trim(), project: r.project ? String(r.project).trim() : null,
        periodMonth: periodMonth || new Date().getMonth() + 1, periodYear: periodYear || new Date().getFullYear(),
        regularHours: Number(r.regularHours) || 0, otHours: Number(r.otHours) || 0,
      }));
      headerFound = generic.headerFound;
    }
  } catch {
    // Malformed/unreadable file for the chosen format — falls through to the same PDF_MANUAL-style
    // response below rather than a 500, so Finance can still key the batch in by hand.
    headerFound = false;
  }
  // Covers PDF_MANUAL explicitly AND the graceful fallback for a genuinely unextractable PDF —
  // an image-only scan/screenshot (confirmed real case: a Bastian-style timesheet has no text
  // layer at all, pdf-parse returns only page-footer boilerplate) has no automatic path at all;
  // rather than fail the upload outright, the batch is still recorded so Finance can key the
  // hours in by hand against it (Add Row below), same as this always did for any PDF before
  // WEnergy/Symsoft parsing existed.
  if (isPdf && !headerFound) {
    return res.status(201).json({ batch, rowCount: 0, note: format === "PDF_MANUAL" ? "Add rows manually below, they'll be tied to this import batch." : "Could not automatically extract hours from this PDF (it may be an image-only scan with no text layer) — add rows manually below, they'll be tied to this import batch." });
  }
  if (!headerFound) {
    return res.status(400).json({ error: "Could not find a recognizable header row (Employee/Name + Hours columns) in this file. You can still add rows manually against this batch." });
  }
  const employees = await prisma.employee.findMany({ select: { id: true, name: true } });
  const projects = await prisma.project.findMany({ select: { id: true, name: true } });
  const findEmp = (name: string) => employees.find((e) => e.name.toLowerCase().trim() === String(name || "").toLowerCase().trim())?.id || null;
  const findProj = (name: string) => projects.find((p) => p.name.toLowerCase().trim() === String(name || "").toLowerCase().trim())?.id || null;

  let created = 0;
  for (const r of rows) {
    if (!r.employeeName && !r.regularHours) continue;
    await prisma.approvedHour.create({
      data: {
        batchId: batch.id,
        employeeNameRaw: r.employeeName,
        employeeId: findEmp(r.employeeName),
        projectNameRaw: r.project,
        projectId: r.project ? findProj(r.project) : null,
        periodMonth: r.periodMonth, periodYear: r.periodYear,
        regularHours: r.regularHours, otHours: r.otHours, totalHours: r.regularHours + r.otHours,
        source: "IMPORTED", status: "PENDING",
      },
    });
    created++;
  }
  await prisma.importedTimesheetBatch.update({ where: { id: batch.id }, data: { rowCount: created } });
  res.status(201).json({ batch, rowCount: created });
});

router.get("/batches", async (_req, res) => {
  res.json(await prisma.importedTimesheetBatch.findMany({ orderBy: { uploadedAt: "desc" }, include: { _count: { select: { hours: true } } } }));
});

// Manual row add — for a PDF batch (no auto-extraction) or to correct/supplement an xlsx import.
router.post("/batches/:id/rows", async (req, res) => {
  const batchId = Number(req.params.id);
  const b = req.body || {};
  const regularHours = Number(b.regularHours) || 0;
  const otHours = Number(b.otHours) || 0;
  const batch = await prisma.importedTimesheetBatch.findUnique({ where: { id: batchId } });
  if (!batch) return res.status(404).json({ error: "Import batch not found" });
  const row = await prisma.approvedHour.create({
    data: {
      batchId, employeeNameRaw: String(b.employeeName || "").trim(), employeeId: b.employeeId ? Number(b.employeeId) : null,
      projectNameRaw: b.project || null, projectId: b.projectId ? Number(b.projectId) : null,
      periodMonth: Number(b.periodMonth) || batch.periodMonth || new Date().getMonth() + 1,
      periodYear: Number(b.periodYear) || batch.periodYear || new Date().getFullYear(),
      regularHours, otHours, totalHours: regularHours + otHours, source: "IMPORTED", status: "PENDING",
    },
  });
  await prisma.importedTimesheetBatch.update({ where: { id: batchId }, data: { rowCount: { increment: 1 } } });
  res.status(201).json(row);
});

// Finance → Approved Hours — every extracted row, editable (to fix employee/project mapping)
// before Approve. ?status=PENDING|APPROVED filters.
router.get("/approved-hours", async (req, res) => {
  const status = req.query.status as string | undefined;
  const rows = await prisma.approvedHour.findMany({
    where: status ? { status } : undefined,
    include: { employee: { select: { id: true, name: true, empNo: true } }, project: { select: { id: true, name: true } }, batch: { select: { id: true, fileName: true, format: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(rows);
});

router.put("/approved-hours/:id", async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const regularHours = b.regularHours != null ? Number(b.regularHours) : undefined;
  const otHours = b.otHours != null ? Number(b.otHours) : undefined;
  const row = await prisma.approvedHour.update({
    where: { id },
    data: {
      employeeId: b.employeeId !== undefined ? (b.employeeId ? Number(b.employeeId) : null) : undefined,
      projectId: b.projectId !== undefined ? (b.projectId ? Number(b.projectId) : null) : undefined,
      periodMonth: b.periodMonth != null ? Number(b.periodMonth) : undefined,
      periodYear: b.periodYear != null ? Number(b.periodYear) : undefined,
      regularHours, otHours,
      totalHours: (regularHours != null || otHours != null) ? undefined : undefined,
    },
  });
  // totalHours recompute needs the merged row — simplest is a second small update when either side changed.
  if (regularHours != null || otHours != null) {
    const fresh = await prisma.approvedHour.findUnique({ where: { id } });
    if (fresh) await prisma.approvedHour.update({ where: { id }, data: { totalHours: (fresh.regularHours || 0) + (fresh.otHours || 0) } });
  }
  res.json(row);
});

router.delete("/approved-hours/:id", async (req, res) => {
  await prisma.approvedHour.delete({ where: { id: Number(req.params.id) } }).catch(() => {});
  res.json({ ok: true });
});

// Applies this ApprovedHour row onto the matching MonthlyLine (Monthly Forecast & Actuals) —
// setting actualHours and recomputing billingAmount off the line's own existing rateUsd, exactly
// the field invoice generation already reads for every other resource. Requires employeeId AND
// projectId to be resolved (Finance must map any unmatched name first). Marks the row Approved +
// appliedToMonthlyLine so a second Approve click is a safe no-op, not a double-application.
router.post("/approved-hours/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  const row = await prisma.approvedHour.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ error: "Row not found" });
  if (!row.employeeId || !row.projectId) return res.status(400).json({ error: "Map this row to a real Employee and Project before approving." });
  const cm = row.periodMonth;
  const fiscalIndex = cm >= 4 ? cm - 3 : cm + 9;
  const fiscalStartYear = cm >= 4 ? row.periodYear : row.periodYear - 1;
  const sheet = await prisma.monthlySheet.findFirst({ where: { monthIndex: fiscalIndex }, orderBy: { id: "desc" } });
  let appliedToMonthlyLine = false;
  if (sheet) {
    const line = await prisma.monthlyLine.findFirst({ where: { monthlySheetId: sheet.id, employeeId: row.employeeId, projectId: row.projectId, isExpense: false } });
    if (line) {
      const rate = line.rateUsd || 0;
      await prisma.monthlyLine.update({ where: { id: line.id }, data: { actualHours: row.totalHours, billingAmount: Math.round(rate * row.totalHours * 100) / 100 } });
      appliedToMonthlyLine = true;
    }
  }
  const updated = await prisma.approvedHour.update({ where: { id }, data: { status: "APPROVED", appliedToMonthlyLine } });
  res.json({ ...updated, appliedToMonthlyLine });
});

export default router;
