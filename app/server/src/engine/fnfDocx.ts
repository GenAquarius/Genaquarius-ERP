// FnF (Full & Final) Settlement — the .docx counterpart of the fixed FnfPdf (engine/hrPdf.ts
// renderFnfPdf). Body text is a Finance-editable {{placeholder}} template (FnfSettlementTemplate,
// managed from Finance Settings → FnF Settlement, same Advanced-Builder-with-live-preview pattern
// as the HR Offer/Appointment templates), rendered here against a real (or sample) FnfPdfData —
// never a stored binary, always regenerated from current data, same convention as the PDF.
import { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, BorderStyle } from "docx";
import fs from "fs";
import path from "path";
import { fillTemplate } from "./hr";
import type { FnfPdfData, FnfLineItem } from "./hrPdf";
import { fmtDate } from "./dateFormat";

// Company-wide "Jan 2nd 2026" format (see engine/dateFormat.ts) — was previously "02 Jan 2026".
const dstr = (d: any) => fmtDate(d) || "—";
const money = (n: number, ccy = "USD") => (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : ccy === "INR" ? "₹" : ccy + " ") + Math.round(n || 0).toLocaleString("en-IN");
// Same brand assets/colors the real PDF (engine/hrPdf.ts renderFnfPdf) uses — Barlow font, the
// #C4161C red header bar, and the actual company logo — so the Advanced Builder's live preview
// looks like the real document instead of a generic plain-HTML approximation.
const LOGO_PATH = path.resolve(__dirname, "../../assets/genaquarius.png");
const BRAND_RED = "#C4161C";
// Actual pixel dimensions of assets/genaquarius.png (329×58) — docx's ImageRun needs explicit
// width/height, it can't read them off the PNG itself like a browser <img> can.
const LOGO_W = 120, LOGO_H = Math.round(120 * (58 / 329));
function logoDataUri(): string | null {
  try { return `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`; } catch { return null; }
}
function logoImageRun(): ImageRun | null {
  try { return new ImageRun({ type: "png", data: fs.readFileSync(LOGO_PATH), transformation: { width: LOGO_W, height: LOGO_H } }); } catch { return null; }
}

export function fnfTemplateVals(f: FnfPdfData): Record<string, any> {
  return {
    EmployeeName: f.employeeName, EmpNo: f.empNo || "", Designation: f.designation || "", Department: f.department || "",
    EmpType: f.empType === "FULL_TIME" ? "Full-Time" : "Contractor", JoiningDate: dstr(f.joiningDate),
    ExitDate: dstr(f.exitDate), ResignationDate: dstr(f.resignationDate), FnfFinalizationDate: dstr(f.fnfFinalizationDate),
    TotalAmount: money(f.totalAmount, f.currency), Currency: f.currency, Note: f.note || "",
    ReviewedByName: f.reviewedByName || "", GeneratedAt: dstr(f.generatedAt),
  };
}

export const DEFAULT_FNF_BODY = "Dear {{EmployeeName}},\n\nThis letter confirms your Full & Final Settlement following separation from GenAquarius, effective {{ExitDate}}. Please find the settlement breakdown below.\n\nWe wish you the very best in your future endeavors.";

function bodyParagraphs(templateBody: string, vals: Record<string, any>): Paragraph[] {
  const filled = fillTemplate(templateBody || DEFAULT_FNF_BODY, vals);
  return filled.split(/\n\s*\n/).map((para) => new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: para.trim().replace(/\n/g, " "), size: 22 })] }));
}

function cell(text: string, opts?: { bold?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType] }) {
  return new TableCell({
    children: [new Paragraph({ alignment: opts?.align, children: [new TextRun({ text, bold: !!opts?.bold, size: 21 })] })],
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}

const TABLE_BORDERS = { top: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" }, bottom: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" }, left: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" }, right: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" } };

// Earned/Deductions grid — matches Finance's own FF Settlement statement layout (Gross Total
// Income, Gross Total Deduction) rather than one flat summed list.
function lineItemsTable(headLabel: string, items: FnfLineItem[], totalLabel: string, total: number, ccy: string): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [
      new TableRow({ children: [cell(headLabel, { bold: true }), cell("Amount", { bold: true, align: AlignmentType.RIGHT })] }),
      ...items.map((li) => new TableRow({ children: [cell(li.label), cell(money(li.amount, ccy), { align: AlignmentType.RIGHT })] })),
      new TableRow({ children: [cell(totalLabel, { bold: true }), cell(money(total, ccy), { bold: true, align: AlignmentType.RIGHT })] }),
    ],
  });
}

export async function renderFnfDocxBuffer(f: FnfPdfData, templateBody: string): Promise<Buffer> {
  const vals = fnfTemplateVals(f);
  const hasDeductions = !!f.deductionItems?.length;
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 }, children: [new TextRun({ text: "Full & Final Settlement Statement", bold: true })] }),
        new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: `Ref: FNF-${f.empNo || ""}   ·   Date: ${dstr(f.generatedAt)}`, size: 18, color: "666666" })] }),
        ...bodyParagraphs(templateBody, vals),
        new Paragraph({ spacing: { before: 120, after: 120 }, children: [new TextRun({ text: "", size: 4 })] }),
        lineItemsTable("Earned", f.lineItems, "Gross Total Income", f.grossEarned ?? f.totalAmount, f.currency),
        ...(hasDeductions ? [
          new Paragraph({ spacing: { before: 200, after: 80 }, children: [new TextRun({ text: "", size: 4 })] }),
          lineItemsTable("Deductions", f.deductionItems || [], "Gross Total Deduction", f.grossDeduction ?? 0, f.currency),
        ] : []),
        new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: `Grand Total (Net Payable): ${money(f.totalAmount, f.currency)}`, bold: true, size: 24 })] }),
        ...(f.note ? [new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: `Remarks: ${f.note}`, italics: true, size: 20 })] })] : []),
        new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: f.signatoryName || "HR/Finance", bold: true, size: 21 })] }),
        new Paragraph({ children: [new TextRun({ text: f.signatoryTitle || "GenAquarius", size: 20, color: "666666" })] }),
        ...(() => { const logo = logoImageRun(); return logo ? [new Paragraph({ spacing: { before: 160 }, children: [logo] })] : []; })(),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

// HTML rendering of the SAME filled body — the Advanced Builder's live preview pane (a browser
// can't render .docx inline; this mirrors the docx content closely enough for editing purposes,
// while the real download/send always uses renderFnfDocxBuffer above).
export function renderFnfPreviewHtml(templateBody: string, f: FnfPdfData): string {
  const vals = fnfTemplateVals(f);
  const filled = fillTemplate(templateBody || DEFAULT_FNF_BODY, vals);
  const paras = filled.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  const earnedRows = f.lineItems.map((li) => `<tr><td>${escapeHtml(li.label)}</td><td style="text-align:right">${escapeHtml(money(li.amount, f.currency))}</td></tr>`).join("");
  const hasDeductions = !!f.deductionItems?.length;
  const dedRows = (f.deductionItems || []).map((li) => `<tr><td>${escapeHtml(li.label)}</td><td style="text-align:right">${escapeHtml(money(li.amount, f.currency))}</td></tr>`).join("");
  const logo = logoDataUri();
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    body{font-family:'Barlow',Calibri,Arial,sans-serif;color:#262626;padding:0;margin:0;background:#e9e9e9}
    .sheet{max-width:720px;margin:24px auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.12)}
    .bar{height:7px;background:${BRAND_RED}}
    .inner{padding:28px 40px 40px}
    .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
    .head img{height:40px}
    .refline{text-align:right;font-size:11px;font-weight:700;color:#000}
    h1{font-size:16px;font-weight:700;color:#000;text-align:center;text-decoration:underline;margin:10px 0 22px}
    p{font-size:13.5px;line-height:1.6;margin:0 0 14px;color:#262626}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    td,th{border:1px solid #ccc;padding:7px 10px;font-size:12.5px}
    th{text-align:left;background:${BRAND_RED};color:#fff;font-weight:700}
    th:last-child,td:last-child{text-align:right}
    .total td{font-weight:700;background:#f7f0ee}
    .grand{font-weight:700;font-size:14px;margin-top:14px;background:#f7f0ee;padding:10px 12px;border-radius:2px;display:flex;justify-content:space-between;color:#1a1a1a}
    .note{font-style:italic;font-size:12.5px;margin-top:18px;color:#262626}
    .sign{margin-top:32px;font-weight:700;font-size:13.5px;color:#262626}
    .sign-title{color:#666;font-size:12px}
    .footer{border-top:1px solid #ddd;margin-top:36px;padding-top:10px;font-size:10.5px;color:#a6a6a6}
    .footer b{color:#262626}
  </style></head><body>
    <div class="sheet">
      <div class="bar"></div>
      <div class="inner">
        <div class="head">
          ${logo ? `<img src="${logo}" alt="GenAquarius" />` : `<div style="font-weight:700;font-size:18px;color:${BRAND_RED}">GenAquarius</div>`}
          <div class="refline">Ref: FNF-${escapeHtml(f.empNo || "")}<br>Date: ${escapeHtml(dstr(f.generatedAt))}</div>
        </div>
        <h1>Full &amp; Final Settlement Statement</h1>
        ${paras}
    <table><tr><th>Earned</th><th style="text-align:right">Amount</th></tr>${earnedRows}
      <tr class="total"><td>Gross Total Income</td><td style="text-align:right">${escapeHtml(money(f.grossEarned ?? f.totalAmount, f.currency))}</td></tr>
    </table>
    ${hasDeductions ? `<table style="margin-top:14px"><tr><th>Deductions</th><th style="text-align:right">Amount</th></tr>${dedRows}
      <tr class="total"><td>Gross Total Deduction</td><td style="text-align:right">${escapeHtml(money(f.grossDeduction ?? 0, f.currency))}</td></tr>
    </table>` : ""}
        <div class="grand"><span>Grand Total (Net Payable)</span><span>${escapeHtml(money(f.totalAmount, f.currency))}</span></div>
        ${f.note ? `<div class="note">Remarks: ${escapeHtml(f.note)}</div>` : ""}
        <div class="sign">${escapeHtml(f.signatoryName || "HR/Finance")}</div>
        <div class="sign-title">${escapeHtml(f.signatoryTitle || "GenAquarius")}</div>
        ${logo ? `<img src="${logo}" alt="GenAquarius" style="height:28px;margin-top:10px" />` : ""}
        <div class="footer"><b>GenAquarius Private Limited</b> · 24th Floor, Etherea, Alphathum, Tower B, Sector 90, Noida, Uttar Pradesh, 201305 · www.genaquarius.com</div>
      </div>
    </div>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Sample data for the Finance Settings live preview — never a real termination request. Two
// variants since a full-time and a contractor FnF are genuinely different documents (matching
// buildFnfPdfData's own per-type line items exactly).
export function sampleFnfData(empType?: string): FnfPdfData {
  if (empType === "CONTRACTOR") {
    return {
      employeeName: "Devina Bhatnagar", empNo: "GA-0187", designation: "Senior Developer", department: "IT",
      empType: "CONTRACTOR", joiningDate: new Date("2025-12-15"), deploymentEndDate: new Date("2026-09-15"),
      exitDate: new Date("2026-09-15"), fnfFinalizationDate: new Date("2026-09-30"),
      currency: "INR", daysWorkedInMonth: 10,
      lineItems: [
        { label: "Gross Payable Amount", amount: 134921 },
        { label: "GST@18%", amount: 24285 },
      ],
      deductionItems: [{ label: "TDS @ 10%", amount: 13492 }],
      grossEarned: 159206, grossDeduction: 13492, totalAmount: 145714,
      note: "Sample preview — no real data.", reviewedByName: "Finance Team", generatedAt: new Date(),
      signatoryName: "Vivek Kaw", signatoryTitle: "HR Head",
    } as FnfPdfData;
  }
  return {
    employeeName: "Venkatesan Iyer", empNo: "GA-0142", designation: "Senior Engineer", department: "Delivery",
    empType: "FULL_TIME", joiningDate: new Date("2022-04-11"), resignationDate: new Date("2026-08-01"),
    exitDate: new Date("2026-09-01"), fnfFinalizationDate: new Date("2026-09-15"), daysWorkedInMonth: 1,
    requiredNoticeDays: 60, servedNoticeDays: 45, currency: "USD",
    lineItems: [
      { label: "Full Salary (1 Day)", amount: 1200 },
      { label: "Basic (45 Days)", amount: 900 },
      { label: "Leave Encashment (5 Days)", amount: 480 },
      { label: "Other Flexi Benefits", amount: 350 },
    ],
    deductionItems: [{ label: "TDS", amount: 293 }],
    grossEarned: 2930, grossDeduction: 293, totalAmount: 2637,
    note: "Sample preview — no real data.", reviewedByName: "Finance Team", generatedAt: new Date(),
    signatoryName: "Vivek Kaw", signatoryTitle: "CHRO, GenAquarius",
  } as FnfPdfData;
}

export function fnfDocxFileName(f: { employeeName: string }, requestId: number): string {
  const safe = (f.employeeName || "Employee").trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, "") || "Employee";
  return `FF_Settlement_${safe}_${requestId}.docx`;
}
