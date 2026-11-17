import { Router } from "express";
import path from "path";
import fs from "fs";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";

// F15 — Faithful Excel export that MATCHES the original workbook
// (Costing_FY26-27New.xlsm): all tabs (Actual Cost, Employee cost, Apr/May/June,
// CTC, Settings), exact columns, formatting and working formulas — including a
// fully-working "Actual Cost" sheet.
//
// Approach: we ship the original workbook itself as a TEMPLATE and only overwrite
// the *input* cells (the per-person rows in each month tab + the CTC component
// rows) with current DB data. Every formula / footer / special section / format
// is left exactly as the original, so "Actual Cost" recalculates live in Excel.
//
//   GET /excel-export?fiscalYear=FY26-27  -> streams costing-<FY>.xlsx
//
// xlsx-populate is used because it round-trips this workbook's INDIRECT/IFNA
// formulas and styles intact (exceljs cannot read this file).
const XlsxPopulate: any = require("xlsx-populate");

const router = Router();
router.use(requireAdmin);
router.use(requirePermission("fx-settings")); // the Export Excel button lives on the Settings page

// month tab names present in the template
const MONTH_TABS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

function templatePath(): string {
  // dist/routes -> ../../assets ; src/routes -> ../../assets ; both => server/assets
  const candidates = [
    path.resolve(__dirname, "../../assets/costing-template.xlsx"),
    path.resolve(process.cwd(), "assets/costing-template.xlsx"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

const isNum = (v: any) => typeof v === "number" && !isNaN(v);

router.get("/", requireAdmin, async (req, res) => {
  const fiscalYear = String(req.query.fiscalYear || "");
  if (!fiscalYear) return res.status(400).json({ error: "fiscalYear is required" });

  const tpl = templatePath();
  if (!fs.existsSync(tpl)) return res.status(500).json({ error: "Workbook template not found on server." });

  // ---- pull current DB data for this fiscal year ----
  const sheets = await prisma.monthlySheet.findMany({
    where: { fiscalYear },
    include: { lines: { where: { isExpense: false }, orderBy: { id: "asc" } } },
  });
  const linesByMonth = new Map(sheets.map((s) => [s.month, s.lines]));

  // latest CTC record per employee (for the CTC tab component inputs)
  const employees = await prisma.employee.findMany({
    include: { ctcRecords: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
    orderBy: { id: "asc" },
  });

  const wb = await XlsxPopulate.fromFileAsync(tpl);

  // ---------- month tabs: overwrite the per-person region only ----------
  for (const month of MONTH_TABS) {
    let ws: any;
    try { ws = wb.sheet(month); } catch { ws = null; }
    if (!ws) continue;                       // tab not in template
    const lines = linesByMonth.get(month);
    if (!lines) continue;                    // no DB data for this month

    // person region = contiguous rows from row 2 where col E (Rate) is numeric.
    let personEnd = 1;
    for (let r = 2; r < 1000; r++) {
      const e = ws.cell(`E${r}`).value();
      if (isNum(e)) personEnd = r; else if (r > 2) break; else if (!isNum(e)) break;
    }
    const capacity = Math.max(0, personEnd - 1); // rows available before the footer

    const n = Math.min(lines.length, capacity || lines.length);
    for (let i = 0; i < n; i++) {
      const l = lines[i];
      const r = 2 + i;
      ws.cell(`A${r}`).value(String(i + 1).padStart(3, "0"));
      ws.cell(`B${r}`).value(l.resourceName || "");
      ws.cell(`C${r}`).value(l.projectName || "");
      // D = USD CTC: same formula shape as the original (VLOOKUP into the CTC tab by name)
      ws.cell(`D${r}`).formula(`IFNA(VLOOKUP(B${r}, INDIRECT("'" &$M$1 & "'!B:U"),17,FALSE),"-")`);
      ws.cell(`E${r}`).value(l.rateUsd || 0);
      ws.cell(`F${r}`).value(l.estimateHours || 0);
      ws.cell(`G${r}`).formula(`E${r}*F${r}`);          // Billing
      ws.cell(`H${r}`).value(l.actualHours || 0);
      ws.cell(`I${r}`).formula(`H${r}*E${r}`);          // Invoice
    }
    // clear any leftover original person rows within the region (DB had fewer)
    for (let r = 2 + n; r <= personEnd; r++) {
      for (const col of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) ws.cell(`${col}${r}`).value(undefined);
    }
  }

  // ---------- CTC tab: overwrite component inputs (headers on row 2, data row 3+) ----------
  try {
    const ctc = wb.sheet("CTC");
    if (ctc) {
      // region = contiguous rows from 3 where col E (Basic) is numeric
      let end = 2;
      for (let r = 3; r < 1000; r++) {
        const e = ctc.cell(`E${r}`).value();
        if (isNum(e)) end = r; else if (r > 3) break; else break;
      }
      const cap = Math.max(0, end - 2);
      const recs = employees.filter((e) => e.ctcRecords[0]);
      const n = Math.min(recs.length, cap || recs.length);
      for (let i = 0; i < n; i++) {
        const e = recs[i]; const c = e.ctcRecords[0]; const r = 3 + i;
        ctc.cell(`A${r}`).value(String(i + 1).padStart(3, "0"));
        ctc.cell(`B${r}`).value(e.name);
        ctc.cell(`E${r}`).value(c.basic || 0);
        ctc.cell(`F${r}`).value(c.hra || 0);
        ctc.cell(`G${r}`).value(c.otherAllowance || 0);
        ctc.cell(`H${r}`).value(c.specialAllowance || 0);
        ctc.cell(`I${r}`).formula(`E${r}+F${r}+G${r}+H${r}`);                 // Fixed Total
        ctc.cell(`J${r}`).value(c.conveyance || 0);
        ctc.cell(`K${r}`).value(c.communication || 0);
        ctc.cell(`L${r}`).value(c.meals || 0);
        ctc.cell(`M${r}`).value(c.books || 0);
        ctc.cell(`N${r}`).value(c.driver || 0);
        ctc.cell(`O${r}`).value(c.uniform || 0);
        ctc.cell(`P${r}`).formula(`J${r}+K${r}+L${r}+M${r}+N${r}+O${r}`);     // Flexi total
        ctc.cell(`Q${r}`).formula(`I${r}+P${r}`);                            // Total Payout
        ctc.cell(`R${r}`).formula(`Q${r}/93`);                               // USD (matches original /93)
      }
      for (let r = 3 + n; r <= end; r++) {
        for (const col of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R"]) ctc.cell(`${col}${r}`).value(undefined);
      }
    }
  } catch { /* CTC tab absent — leave template as-is */ }

  const buf = await wb.outputAsync();
  const filename = `GenAquarius_ERP_${fiscalYear}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.end(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
});

export default router;
