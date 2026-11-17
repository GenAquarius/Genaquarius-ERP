import PDFDocument from "pdfkit";
import { Writable } from "stream";
import path from "path";
import fs from "fs";
import { fmtDate as dstr, fmtDateRange as periodStr } from "./dateFormat";

// GenAquarius brand logo for invoices (server/assets/genaquarius.png)
const LOGO_PATH = path.resolve(__dirname, "../../assets/genaquarius.png");

// USD and CAD both render with a "$" sign (the column header states the currency); INR uses ₹.
const CUR: Record<string, string> = { USD: "$", CAD: "$", INR: "₹" };

// e.g. $5,200 (no decimals when whole; up to 2 decimals when there are cents).
function money(ccy: string, n: number) {
  return `${CUR[ccy] || "$"}${(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Configurable layout: every header field has its own position/visibility; the
// flowing sections (line items / bank details / annexure) have an order + toggle.
// The DEFAULT below reproduces the classic GenAquarius/Kira layout; a saved
// InvoiceLayout overrides any field by key. Page is A4 (595 × 842 pt), margin 50.
// ---------------------------------------------------------------------------
export type FieldBlock = { key: string; label?: string; visible: boolean; x: number; y: number; w?: number; fontSize?: number; bold?: boolean; align?: "left" | "right" | "center" };
export type LayoutSection = { key: string; visible: boolean };
export type InvoiceLayoutConfig = { headerFields: FieldBlock[]; sections: LayoutSection[]; sectionsStartY: number };

// Catalog of header fields (key → default label). Drives both renderer + designer.
export const HEADER_FIELD_LABELS: Record<string, string> = {
  logo: "Company Logo", title: "INVOICE title", issuer: "Issuer block",
  invoiceNo: "Invoice Number", invoiceDate: "Invoice Date", dueDate: "Payment Due Date",
  paymentTerms: "Payment Terms",
  projectTitle: "Project Title", projectCode: "Project Code", projectDescription: "Project Description",
  poNumber: "PO Number", customerRefNo: "Customer Ref No", billingPeriod: "Billing Period",
  attention: "Attention Contact(s)", clientLogo: "Client Logo", billTo: "Bill-To block",
  // Fields the invoice record carries that the layout could not print before. All ship hidden, so
  // existing invoices look unchanged until they are switched on in the Invoice Layouts designer.
  addressTo: "Address To", clientName: "Client Name", clientCode: "Client Code",
  billingMonth: "Billing Month", fiscalYear: "Fiscal Year", currency: "Currency",
  invoiceTotal: "Invoice Total", status: "Status", billingEmail: "Billing Email (AP)",
  billingPeriodStart: "Billing Period From", billingPeriodEnd: "Billing Period To",
};
export const SECTION_LABELS: Record<string, string> = { lineItems: "Line Items table", bankDetails: "Bank Details", annexure: "Annexure" };

export const DEFAULT_LAYOUT: InvoiceLayoutConfig = {
  headerFields: [
    { key: "logo", label: "", visible: true, x: 50, y: 38, w: 160 },
    { key: "title", label: "INVOICE", visible: true, x: 360, y: 44, w: 185, fontSize: 22, bold: true, align: "right" },
    { key: "issuer", label: "", visible: true, x: 50, y: 98, w: 260, fontSize: 9 },
    // Right-hand reference block: one field per row on a uniform 13pt grid, all sharing the same
    // column (x=330) and the same right edge (330 + 215 = 545 = R). Because they share an X they are
    // packed + reflowed together: the label sits flush LEFT at x, the value flush RIGHT at the page
    // edge (align:"right"), so every value in the block ends on the same vertical line.
    { key: "invoiceNo", label: "Invoice Number", visible: true, x: 330, y: 98, w: 215, fontSize: 9, align: "right" },
    { key: "invoiceDate", label: "Invoice Date", visible: true, x: 330, y: 111, w: 215, fontSize: 9, align: "right" },
    { key: "dueDate", label: "Payment Due Date", visible: true, x: 330, y: 124, w: 215, fontSize: 9, align: "right" },
    { key: "projectTitle", label: "Project Title", visible: true, x: 330, y: 137, w: 215, fontSize: 9, align: "right" },
    { key: "projectDescription", label: "Project Description", visible: true, x: 330, y: 150, w: 215, fontSize: 9, align: "right" },
    { key: "poNumber", label: "PO Number", visible: true, x: 330, y: 163, w: 215, fontSize: 9, align: "right" },
    { key: "projectCode", label: "Project Code", visible: true, x: 330, y: 176, w: 215, fontSize: 9, align: "right" },
    { key: "customerRefNo", label: "Customer Ref No", visible: true, x: 330, y: 189, w: 215, fontSize: 9, align: "right" },
    { key: "billingPeriod", label: "Billing Period", visible: true, x: 330, y: 202, w: 215, fontSize: 9, align: "right" },
    { key: "paymentTerms", label: "Payment Terms", visible: true, x: 330, y: 215, w: 215, fontSize: 9, align: "right" },
    { key: "attention", label: "Attention", visible: true, x: 330, y: 228, w: 215, fontSize: 9, align: "right" },
    // Optional extras — same column/grid, so ticking one in the designer drops it straight into the
    // right-hand block (labels flush left, values flush right) with no repositioning needed.
    { key: "addressTo", label: "Address To", visible: false, x: 330, y: 241, w: 215, fontSize: 9, align: "right" },
    { key: "clientName", label: "Client", visible: false, x: 330, y: 254, w: 215, fontSize: 9, align: "right" },
    { key: "clientCode", label: "Client Code", visible: false, x: 330, y: 267, w: 215, fontSize: 9, align: "right" },
    { key: "billingMonth", label: "Billing Month", visible: false, x: 330, y: 280, w: 215, fontSize: 9, align: "right" },
    { key: "fiscalYear", label: "Fiscal Year", visible: false, x: 330, y: 293, w: 215, fontSize: 9, align: "right" },
    { key: "billingPeriodStart", label: "Period From", visible: false, x: 330, y: 306, w: 215, fontSize: 9, align: "right" },
    { key: "billingPeriodEnd", label: "Period To", visible: false, x: 330, y: 319, w: 215, fontSize: 9, align: "right" },
    { key: "currency", label: "Currency", visible: false, x: 330, y: 332, w: 215, fontSize: 9, align: "right" },
    { key: "invoiceTotal", label: "Invoice Total", visible: false, x: 330, y: 345, w: 215, fontSize: 9, bold: true, align: "right" },
    { key: "status", label: "Status", visible: false, x: 330, y: 358, w: 215, fontSize: 9, align: "right" },
    { key: "billingEmail", label: "Billing Email", visible: false, x: 330, y: 371, w: 215, fontSize: 9, align: "right" },
    { key: "clientLogo", label: "", visible: true, x: 475, y: 92, w: 70 },
    { key: "billTo", label: "TO", visible: true, x: 50, y: 175, w: 260, fontSize: 9 },
  ],
  sections: [{ key: "lineItems", visible: true }, { key: "bankDetails", visible: true }, { key: "annexure", visible: true }],
  sectionsStartY: 250,
};

// Keys rendered as "Label: value" rows (the ones that form aligned columns).
const LINE_FIELD_KEYS = new Set(["invoiceNo", "invoiceDate", "dueDate", "paymentTerms", "projectTitle", "projectCode", "projectDescription", "poNumber", "customerRefNo", "billingPeriod", "attention", "addressTo", "clientName", "clientCode", "billingMonth", "fiscalYear", "billingPeriodStart", "billingPeriodEnd", "currency", "invoiceTotal", "status", "billingEmail"]);

/**
 * Tidy a layout's label/value fields so a column reads as one block. Older saved layouts have
 * cramped/overlapping Y values (6–7pt apart), mixed widths and per-field aligns; this re-spaces each
 * column on an even pitch, gives the whole column one width, and one alignment (right when the
 * column reaches the right margin). Used by BOTH the renderer and the Invoice Layouts designer, so
 * the canvas shows exactly what the PDF prints.
 */
export function normalizeLayout(cfg: InvoiceLayoutConfig): InvoiceLayoutConfig {
  const R = 545;
  const byX = new Map<number, FieldBlock[]>();
  for (const f of cfg.headerFields) {
    if (!LINE_FIELD_KEYS.has(f.key)) continue;
    if (!byX.has(f.x)) byX.set(f.x, []);
    byX.get(f.x)!.push(f);
  }
  const patched = new Map<string, Partial<FieldBlock>>();
  for (const group of byX.values()) {
    const sorted = [...group].sort((a, b) => a.y - b.y);
    const w = Math.max(...sorted.map((f) => f.w || (R - f.x)));
    const align = sorted[0].align || (sorted[0].x + w >= R - 20 ? "right" : "left");
    const pitch = Math.max(13, Math.max(...sorted.map((f) => (f.fontSize || 9) + 4)));
    // Only re-space rows that are CRAMPED (a gap tighter than one row would overlap). Spacing the
    // user set deliberately in the designer is left exactly as it is.
    const cramped = sorted.some((f, i) => i > 0 && f.y - sorted[i - 1].y < pitch);
    const top = sorted[0].y;
    sorted.forEach((f, i) => patched.set(f.key, { ...(cramped ? { y: top + i * pitch } : {}), w, align: align as any }));
  }
  return { ...cfg, headerFields: cfg.headerFields.map((f) => ({ ...f, ...(patched.get(f.key) || {}) })) };
}

// Merge a saved/partial config over the default (by field key); unknown keys ignored.
function mergeLayout(cfg: any): InvoiceLayoutConfig {
  if (!cfg || typeof cfg !== "object") return DEFAULT_LAYOUT;
  const byKey = new Map<string, FieldBlock>((cfg.headerFields || []).map((f: FieldBlock) => [f.key, f]));
  const headerFields = DEFAULT_LAYOUT.headerFields.map((d) => ({ ...d, ...(byKey.get(d.key) || {}) }));
  const sections = Array.isArray(cfg.sections) && cfg.sections.length ? cfg.sections : DEFAULT_LAYOUT.sections;
  const sectionsStartY = Number.isFinite(cfg.sectionsStartY) ? cfg.sectionsStartY : DEFAULT_LAYOUT.sectionsStartY;
  return normalizeLayout({ headerFields, sections, sectionsStartY });
}

/** Render an invoice using the (optional) configurable layout; falls back to the default. */
export function renderInvoicePdf(inv: any, out: Writable, layoutCfg?: any) {
  const layout = mergeLayout(layoutCfg);
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(out);

  const issuer = inv.template?.issuerBlock || {};
  const bank = inv.template?.bankDetails || {};
  const ccy = inv.currency || "USD";
  const L = 50, R = 545;
  const rowH = 22;
  const PAGE_BOTTOM = 792; // A4 usable bottom (height ~842 − 50 margin); break to a new page past this

  // Resolved bill-to values (invoice snapshot → client fallback). Note: "Email Address To" is an
  // EMAIL-only field (greeting/preview) and is intentionally NOT rendered on the PDF.
  const attn = inv.attentionContact ?? inv.client?.attentionContact;
  const billTo = inv.billToAddress ?? inv.client?.billToAddress;

  // Single-line labelled fields: "Label: value" (label="" → value only). Returns "" to skip.
  const lineFields: Record<string, () => string> = {
    invoiceNo: () => `${inv.invoiceNo || ""}`,
    invoiceDate: () => dstr(inv.invoiceDate),
    dueDate: () => dstr(inv.dueDate),
    paymentTerms: () => inv.paymentTerms || "",
    projectTitle: () => inv.projectTitle || "",
    projectCode: () => inv.projectCode || "",
    projectDescription: () => inv.projectDescription || "Professional Services",
    poNumber: () => inv.poNumber || "",
    customerRefNo: () => inv.customerRefNo || "",
    billingPeriod: () => periodStr(inv.billingPeriodStart, inv.billingPeriodEnd),
    attention: () => attn || "",
    // Optional extras (hidden unless enabled on the layout).
    addressTo: () => inv.addressTo ?? inv.client?.addressTo ?? "",
    clientName: () => inv.client?.legalEntityName || inv.client?.name || "",
    clientCode: () => inv.client?.code || "",
    billingMonth: () => inv.month || "",
    fiscalYear: () => inv.fiscalYear || "",
    billingPeriodStart: () => dstr(inv.billingPeriodStart),
    billingPeriodEnd: () => dstr(inv.billingPeriodEnd),
    currency: () => ccy,
    // Falls back to the line-item sum so a draft preview (no stored total yet) still prints a figure.
    invoiceTotal: () => money(ccy, inv.totalAmount != null && +inv.totalAmount ? +inv.totalAmount : (inv.lineItems || []).reduce((t: number, x: any) => t + (+x.amount || 0), 0)),
    status: () => inv.status || "",
    billingEmail: () => inv.billingEmail ?? inv.client?.email ?? "",
  };

  // Bottom-most pixel used by any header block — the flowing sections start below this so a tall
  // header (long description, many fields, big logo) can never be overlapped by the items table.
  let headerBottom = 0;
  const mark = (yy: number) => { headerBottom = Math.max(headerBottom, yy); };

  // Pass 1 — positioned/special blocks (image + multi-line). Empty ones draw nothing.
  for (const f of layout.headerFields) {
    if (!f.visible) continue;
    const fs2 = f.fontSize || 9;
    const w = f.w || (R - f.x);
    const align = (f.align || "left") as any;
    if (f.key === "logo") {
      if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, f.x, f.y, { fit: [w, 48] }); mark(f.y + 48); } catch { /* ignore */ } }
    } else if (f.key === "clientLogo") {
      if (typeof inv.client?.logo === "string" && inv.client.logo.startsWith("data:")) {
        try { doc.image(Buffer.from(inv.client.logo.split(",")[1], "base64"), f.x, f.y, { fit: [w, 40] }); mark(f.y + 40); } catch { /* bad image */ }
      }
    } else if (f.key === "title") {
      doc.font("Helvetica-Bold").fontSize(fs2).fillColor("#000").text(f.label ?? "INVOICE", f.x, f.y, { align, width: w });
      mark(doc.y);
    } else if (f.key === "issuer") {
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(fs2 + 1).text(issuer.company || "GenAquarius LLC", f.x, f.y, { width: w });
      doc.font("Helvetica").fontSize(fs2);
      // Render every address line, INCLUDING blank ones (a space forces the empty row to show).
      (issuer.addressLines || []).forEach((l: string) => doc.text(l && l.trim() ? l : " ", f.x, doc.y, { width: w }));
      if (issuer.website) doc.text(issuer.website, f.x, doc.y, { width: w });
      mark(doc.y);
    } else if (f.key === "billTo") {
      // Only the rows that have a value are drawn — no blank lines.
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(fs2).text(`${f.label ?? "TO"}:`, f.x, f.y, { width: w });
      doc.font("Helvetica");
      const billToName = inv.client?.legalEntityName || inv.client?.name; // legal entity on the invoice
      if (billToName) doc.text(billToName, f.x, doc.y, { width: w });
      if (billTo) doc.text(billTo, f.x, doc.y, { width: w });
      mark(doc.y);
    }
  }
  // Pass 2 — single-line labelled fields. Group by column (x); within each column, render only the
  // ones that HAVE a value. Fields in the same COLUMN (same X) are packed top-down from the
  // topmost field's Y — empty fields print nothing AND leave no gap, so the fields below move up
  // to fill the row (dynamic reflow). The column (X) and relative order (Y) from the layout are kept.
  //
  // Alignment: a row is drawn as TWO sub-columns — the label ("Invoice Number:") and the value —
  // never as one concatenated string. The label column is as wide as the widest label in the group,
  // so every value in the block starts at the SAME x and the values read as a clean column.
  // A column is aligned as ONE block: it takes its width and its value-alignment from the topmost
  // field, so a saved template whose fields carry mixed widths/aligns still renders flush (this is
  // what made older templates look ragged — per-field align on a few rows of a shared column).
  const LBL_GAP = 8;
  const colGroups = new Map<number, FieldBlock[]>();
  for (const f of layout.headerFields) {
    if (!f.visible || !lineFields[f.key]) continue;
    if (!colGroups.has(f.x)) colGroups.set(f.x, []);
    colGroups.get(f.x)!.push(f);
  }
  for (const fields of colGroups.values()) {
    fields.sort((a, b) => a.y - b.y);
    // Every field in the column, in layout order, with its resolved value + label. Empty ones are
    // kept in the list (so we can tell a deliberate gap from a skipped row) but never drawn.
    const all = fields.map((f) => ({ f, val: lineFields[f.key](), label: (f.label !== undefined ? f.label : HEADER_FIELD_LABELS[f.key]) || "" }));
    const rows = all.filter((r) => !!r.val);
    if (!rows.length) continue;
    const colW = Math.max(...fields.map((f) => f.w || (R - f.x)));
    // One alignment for the whole column, taken from the topmost field. A column with no explicit
    // align that reaches the right margin defaults to right-aligned values — that is what makes the
    // right-hand reference block (and older saved templates) end on a single flush right edge.
    const autoAlign = fields[0].x + colW >= R - 20 ? "right" : "left";
    const colAlign = (fields[0].align || autoAlign) as any;
    // Widest label in this column (measured in its own font) → shared label-column width.
    let labelW = 0;
    for (const r of rows) {
      if (!r.label) continue;
      doc.font(r.f.bold ? "Helvetica-Bold" : "Helvetica").fontSize(r.f.fontSize || 9);
      labelW = Math.max(labelW, doc.widthOfString(`${r.label}:`));
    }
    labelW = Math.min(labelW, colW * 0.62); // never let labels crowd out the value column
    const valX = fields[0].x + (labelW ? labelW + LBL_GAP : 0);
    const valW = colW - (labelW ? labelW + LBL_GAP : 0);
    // Vertical flow: the first drawn row sits at its own Y. After that, the gap the LAYOUT declares
    // between two adjacent fields is honoured (so spacing set in the designer shows up on the PDF),
    // but a skipped/empty field never leaves a hole — the next row simply follows on.
    let y = 0, lastH = 0, lastIdx = -1;
    for (let i = 0; i < all.length; i++) {
      const { f, val, label } = all[i];
      if (!val) continue; // missing value → no row drawn and no gap left behind
      if (lastIdx < 0) y = f.y;
      else {
        const declared = f.y - all[lastIdx].f.y;              // spacing asked for in the layout
        const adjacent = i === lastIdx + 1;                   // nothing was skipped in between
        y += adjacent ? Math.max(lastH + 4, declared) : lastH + 4;
      }
      const fs2 = f.fontSize || 9;
      const font = f.bold ? "Helvetica-Bold" : "Helvetica";
      const align = colAlign; // the VALUE's alignment inside its sub-column — shared by the column
      doc.fillColor("#000").font(font).fontSize(fs2);
      // Label is always one line (height caps it → pdfkit truncates with an ellipsis instead of wrapping).
      if (label) doc.text(`${label}:`, f.x, y, { width: labelW, align: "left", height: fs2 + 3, ellipsis: true });
      // Long values (e.g. Project Description) wrap inside the value column instead of overflowing.
      const h = label
        ? doc.heightOfString(val, { width: valW, align })
        : doc.heightOfString(val, { width: colW, align });
      doc.font(font).fontSize(fs2);
      if (label) doc.text(val, valX, y, { width: valW, align });
      else doc.text(val, f.x, y, { width: colW, align });
      lastH = Math.max(h, fs2 + 2);
      lastIdx = i;
    }
    mark(y + lastH);
  }

  // ---- Flowing sections (ordered, toggleable) ----
  // Column-header overrides (Advanced Builder): {li:{c1,desc,rate,qty,amt}, ax:{name,role,tlo,leave,rate,qty,amt}}.
  const colLabels: any = (() => { const v = (inv as any).columnLabels; if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return {}; } })();
  const lbl = (t: "li" | "ax", k: string, def: string) => { const v = colLabels?.[t]?.[k]; return v && String(v).trim() ? String(v).trim() : def; };
  const drawLineItems = (y0: number): number => {
    let y = y0;
    // Hours and/or Rate columns can be dropped. With the Day basis, Rate→"Day Rate" and Hours→"Days".
    const hideHrs = !!inv.lineItemsHideHours, hideRate = !!inv.lineItemsHideRate, dayBasis = !!inv.lineItemsDayBasis;
    const rateLabel = lbl("li", "rate", dayBasis ? `Day Rate (${ccy})` : `Rate per hour (${ccy})`);
    const qtyLabel = lbl("li", "qty", dayBasis ? "Days" : "Hours");
    // Column geometry: the numeric columns are FIXED width and laid out from the right edge of the
    // table backwards, so their cell borders and their right-aligned contents line up exactly with
    // the frame. Description absorbs whatever width is left.
    const PADX = 6;
    type LiCol = { l: number; r: number };
    const RATE_W = 104, QTY_W = 64, AMT_W = 81, DESC2_W = 140;
    // Optional "Description" column: per-row text (li.detail), or ONE merged cell (inv.lineItemsDesc)
    // spanning every item row. When shown, the first column's header reads "Service" instead.
    const showDesc = !!inv.lineItemsShowDesc;
    const mergeDesc = !!inv.lineItemsMergeDesc;
    const descText = String(inv.lineItemsDesc || "").trim();
    const showRes = !!inv.lineItemsShowResource;      // first column = resource names (like the Annexure)
    const liHideRole = !!inv.lineItemsHideRole;       // drop the " - <Role>" part of the Service text
    const liSumTotal = !!inv.lineItemsSumTotal;       // Amount column merged into ONE centred total cell
    const widths: { key: string; w: number }[] = [];
    if (showDesc) widths.push({ key: "desc2", w: DESC2_W }); // leftmost fixed column (next to Service)
    if (!hideRate) widths.push({ key: "rate", w: RATE_W });
    if (!hideHrs) widths.push({ key: "hrs", w: QTY_W });
    widths.push({ key: "amt", w: AMT_W });
    const cols: Record<string, LiCol> = {};
    let edge = R;
    for (let i = widths.length - 1; i >= 0; i--) { cols[widths[i].key] = { l: edge - widths[i].w, r: edge }; edge -= widths[i].w; }
    cols.desc = { l: L, r: edge };
    // Vertical column separators (at each numeric column's left edge) and the Description clip width.
    const seps = widths.map((c) => cols[c.key].l);
    const descW = cols.desc.r - cols.desc.l - PADX * 2;
    // Numeric cell: right-aligned inside its own column so all the figures share one right edge.
    const numCell = (c: LiCol, s: string, yy: number) => doc.text(s, c.l + PADX, yy, { width: c.r - c.l - PADX * 2, align: "right", height: 13, ellipsis: true });
    let pageTop = y0;
    // Draw the column separators + darker outer frame for the current page's segment (header → bottomY).
    const frame = (bottomY: number) => {
      doc.lineWidth(0.5).strokeColor("#cfd6e4");
      for (const sx of seps) doc.moveTo(sx, pageTop).lineTo(sx, bottomY).stroke();
      doc.lineWidth(1).strokeColor("#8a97ad").rect(L, pageTop, R - L, bottomY - pageTop).stroke();
      doc.lineWidth(0.5).strokeColor("#cfd6e4");
    };
    const header = (yy: number): number => {
      pageTop = yy;
      doc.lineWidth(0.5).rect(L, yy, R - L, rowH).fillAndStroke("#f0f3f8", "#cfd6e4");
      doc.fillColor("#222").font("Helvetica-Bold").fontSize(9);
      doc.text(lbl("li", "c1", showRes ? "Name of Resource" : showDesc ? "Service" : "Description"), cols.desc.l + PADX, yy + 7, { width: descW, height: 12, ellipsis: true });
      if (showDesc) doc.text(lbl("li", "desc", "Description"), cols.desc2.l + PADX, yy + 7, { width: DESC2_W - PADX * 2, height: 12, ellipsis: true });
      if (!hideRate) numCell(cols.rate, rateLabel, yy + 7);
      if (!hideHrs) numCell(cols.hrs, qtyLabel, yy + 7);
      numCell(cols.amt, lbl("li", "amt", `Amount (${ccy})`), yy + 7);
      doc.fillColor("#000").font("Helvetica").fontSize(9);
      return yy + rowH;
    };
    y = header(y);
    const items = (inv.lineItems || []).filter((x: any) => (x.description || "").trim() || +x.amount || +x.hours || +x.rateUsd);
    // GST is EMBEDDED in the billable amounts. When enabled we back it out: line items show the
    // ex-GST base (scaled down), a GST row holds the embedded tax, and the grand total is unchanged.
    const inclSubtotal = items.reduce((s: number, x: any) => s + (+x.amount || 0), 0);
    const gstPct = inv.gstPercent != null ? inv.gstPercent : 5;
    const addGst = !!inv.lineItemsAddGst;
    const gstExcl = !!inv.gstExclusive; // EXCLUDE mode: GST is ADDED ON TOP of the subtotal
    const base = addGst && !gstExcl ? inclSubtotal / (1 + gstPct / 100) : inclSubtotal;
    const scale = inclSubtotal ? base / inclSubtotal : 1; // include mode: = 1/(1+pct/100)
    const gst = addGst ? (gstExcl ? (inclSubtotal * gstPct) / 100 : inclSubtotal - base) : 0;
    const grand = gstExcl ? inclSubtotal + gst : inclSubtotal;
    let zi = 0;
    let liTop = y; // top of the item rows on the current page (for the merged Description cell)
    // Row background: tint odd rows (zebra) so long tables are easy to read; light row border either way.
    const rowBg = (yy: number) => { doc.lineWidth(0.5).strokeColor("#e2e7f0"); if (zi % 2 === 1) doc.rect(L, yy, R - L, rowH).fillAndStroke("#eef3fb", "#e2e7f0"); else doc.rect(L, yy, R - L, rowH).stroke(); zi++; doc.fillColor("#000").font("Helvetica").fontSize(9); };
    for (const li of items) {
      if (y + rowH > PAGE_BOTTOM) { frame(y); doc.addPage(); y = header(50); zi = 0; liTop = y; }
      rowBg(y);
      const liDesc = showRes ? (String((li as any).resourceName || "").trim() || li.description)
        : liHideRole ? String(li.description || "").split(" - ")[0] : li.description;
      doc.text(liDesc, cols.desc.l + PADX, y + 7, { width: descW, height: 12, ellipsis: true });
      if (showDesc && !mergeDesc) doc.text(String((li as any).detail || ""), cols.desc2.l + PADX, y + 7, { width: DESC2_W - PADX * 2, height: 12, ellipsis: true });
      if (!hideRate) numCell(cols.rate, money(ccy, (+(dayBasis ? li.dayRate : li.rateUsd) || 0) * scale), y + 7);
      if (!hideHrs) numCell(cols.hrs, String(dayBasis ? (li.days ?? 0) : li.hours), y + 7);
      if (!liSumTotal) numCell(cols.amt, money(ccy, (+li.amount || 0) * scale), y + 7);
      y += rowH;
    }
    // Merged Description: ONE real cell spanning all item rows (white fill covers the zebra tints
    // and row borders), with the text vertically centred — like the Annexure's merged cells.
    if (showDesc && mergeDesc && y > liTop) {
      doc.rect(cols.desc2.l, liTop, DESC2_W, y - liTop).fillAndStroke("#ffffff", "#cfd6e4");
      if (descText) {
        doc.fillColor("#000").font("Helvetica").fontSize(9);
        const tw = DESC2_W - PADX * 2;
        const th = Math.min(doc.heightOfString(descText, { width: tw }), y - liTop - 6);
        doc.text(descText, cols.desc2.l + PADX, liTop + Math.max(3, ((y - liTop) - th) / 2), { width: tw, height: th + 2, ellipsis: true });
      }
    }
    // Sum-total mode: the Amount column becomes ONE merged cell holding the (ex-GST) total, centred.
    if (liSumTotal && y > liTop) {
      doc.rect(cols.amt.l, liTop, cols.amt.r - cols.amt.l, y - liTop).fillAndStroke("#ffffff", "#cfd6e4");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text(money(ccy, base), cols.amt.l + PADX, (liTop + y) / 2 - 6, { width: cols.amt.r - cols.amt.l - PADX * 2, align: "right", height: 13, ellipsis: true });
      doc.font("Helvetica").fontSize(9).fillColor("#000");
    }
    if (addGst) {
      if (y + rowH > PAGE_BOTTOM) { frame(y); doc.addPage(); y = header(50); zi = 0; }
      rowBg(y);
      doc.text(`Add GST (${gstPct}%)`, cols.desc.l + PADX, y + 7, { width: descW, height: 12, ellipsis: true });
      numCell(cols.amt, money(ccy, gst), y + 7);
      y += rowH;
    }
    frame(y); // close the items grid (header → last row) with separators + outer frame
    // Total bar — full-width highlighted row with its own border (no internal separators).
    if (y + rowH > PAGE_BOTTOM) { doc.addPage(); y = 50; }
    doc.lineWidth(1).strokeColor("#8a97ad").rect(L, y, R - L, rowH).fillAndStroke("#eef7f0", "#8a97ad");
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(10);
    doc.text(`Total Invoice Amount ${ccy}`, cols.desc.l + PADX, y + 6, { width: descW, height: 13, ellipsis: true });
    numCell(cols.amt, money(ccy, grand), y + 6);
    doc.lineWidth(1).strokeColor("#000");
    return y + rowH + 22;
  };
  const drawBank = (y0: number): number => {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text("Bank Details for Wire Payment", L, y0);
    doc.fontSize(9).font("Helvetica");
    doc.text(`Beneficiary Details:    Payment Terms : ${bank.terms || "Net 30 Days"}`, L, doc.y + 4);
    if (bank.bankName) doc.text(`Bank Name: ${bank.bankName}`, L);
    let lines: string[] = Array.isArray(bank.lines) ? bank.lines : [];
    if (lines.length === 0) {
      if (bank.accountNumber) lines.push(`${bank.accountLabel || "Account #"}: ${bank.accountNumber}`);
      if (bank.routingNumber) lines.push(`${bank.routingLabel || "Routing"}: ${bank.routingNumber}`);
      if (bank.swift) lines.push(`SWIFT/BIC: ${bank.swift}`);
      if (!bank.accountNumber && bank.account) lines.push(`ACCOUNT # ${bank.account}, ROUTING # ${bank.routingPaper} (Paper & Electronic) Or ${bank.routingWire} (Wires)`);
      if (bank.bankAddress) lines.push(`Bank Address: ${bank.bankAddress}`);
      if (bank.officeAddress) lines.push(`Office Address: ${bank.officeAddress}`);
    }
    for (const ln of lines) doc.text(ln, L, undefined, { width: R - L });
    if (issuer.contact) doc.text(`For any clarifications please contact: ${issuer.contact}`, L);
    return doc.y + 22;
  };
  const drawAnnexure = (y0: number): number => {
    const rows = (inv.annexure || []).filter((x: any) => (x.resourceName || "").trim() || +x.amount || +x.hours || +x.billRate);
    if (!rows.length) return y0;
    let ay = y0;
    if (ay + 40 > PAGE_BOTTOM) { doc.addPage(); ay = 50; }
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(`Annexure for Invoice`, L, ay);
    ay = doc.y + 8;
    // Each optional column (Leave, Rate, Qty) can be hidden independently. The legacy combined
    // flag hides Leave + Rate. With Day-Rate basis, Rate→"Day Rate" and Qty→"Days".
    const legacyLR = !!inv.annexureHideLeaveRate, dayBasis = !!inv.annexureDayBasis;
    const hideLeave = !!inv.annexureHideLeave || legacyLR;
    const hideRate = !!inv.annexureHideBillRate || legacyLR;
    const hideQty = !!inv.annexureHideHours;
    const showRole = !inv.annexureHideRole && rows.some((r: any) => (r.role || "").trim()); // Role column when any row has one
    const sumTotal = !!inv.annexureSumTotal; // hide per-resource amount; one merged total cell
    const showTLO = rows.some((r: any) => (r.timeLoggedOn || "").trim()); // "Time Logged On" grouping column
    // Fixed column widths sized to their headers (so "Bill Rate (USD)" never collides with "Hours");
    // the Name column absorbs the remaining width. Every column is a real bordered cell.
    const AMT_W = 82, RATE_W = 92, QTY_W = 52, LEAVE_W = 52, TLO_W = 96, ROLE_W = 96;
    type Col = { key: string; h: string; get: (a: any) => string; align: "left" | "right"; x: number; w: number };
    const fixed = AMT_W + (showRole ? ROLE_W : 0) + (showTLO ? TLO_W : 0) + (!hideLeave ? LEAVE_W : 0) + (!hideRate ? RATE_W : 0) + (!hideQty ? QTY_W : 0);
    const nameW = (R - L) - fixed;
    const cols: Col[] = [];
    let cx = L;
    const add = (key: string, h: string, get: (a: any) => string, align: "left" | "right", w: number) => { cols.push({ key, h, get, align, x: cx, w }); cx += w; };
    add("name", lbl("ax", "name", "Name of Resource"), (a) => a.resourceName || "", "left", nameW);
    if (showRole) add("role", lbl("ax", "role", "Role"), (a) => a.role || "", "left", ROLE_W);
    if (showTLO) add("tlo", lbl("ax", "tlo", "Time Logged On"), (a) => a.timeLoggedOn || "", "left", TLO_W);
    if (!hideLeave) add("leave", lbl("ax", "leave", "Leave"), (a) => a.leave || "", "left", LEAVE_W);
    if (!hideRate) add("rate", lbl("ax", "rate", dayBasis ? `Day Rate (${ccy})` : `Bill Rate (${ccy})`), (a) => money(ccy, dayBasis ? a.dayRate : a.billRate), "right", RATE_W);
    if (!hideQty) add("qty", lbl("ax", "qty", dayBasis ? "Days" : "Hours"), (a) => String(dayBasis ? (a.days ?? 0) : a.hours), "right", QTY_W);
    add("amt", lbl("ax", "amt", `Amount(${ccy})`), (a) => money(ccy, a.amount), "right", AMT_W);
    const amtCol = cols[cols.length - 1];
    const tloCol = cols.find((c) => c.key === "tlo");
    const PAD = 6; // same cell padding as the line-items table, so both tables share one right edge
    // Compact rows for the annexure (tighter than the 22pt line-items rows) so a long resource list
    // doesn't waste vertical space; text is vertically centred in the shorter row.
    const arowH = 17, TY = 4.5;
    // Draw a value inside a column's cell, clipped to the cell width (no wrap, no overflow).
    const cell = (c: Col, s: string, yy: number, bold = false) => {
      if (!s) return;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#000");
      doc.text(s, c.x + PAD, yy + TY, { width: c.w - PAD * 2, align: c.align, height: 12, ellipsis: true });
    };
    doc.lineWidth(0.5);
    let pageTop = ay;
    const header = (yy: number): number => {
      pageTop = yy;
      doc.strokeColor("#cfd6e4").rect(L, yy, R - L, arowH).fillAndStroke("#f0f3f8", "#cfd6e4");
      doc.fillColor("#222");
      for (const c of cols) { doc.font("Helvetica-Bold").fontSize(9); doc.text(c.h, c.x + PAD, yy + TY, { width: c.w - PAD * 2, align: c.align, height: 12, ellipsis: true }); }
      doc.fillColor("#000").font("Helvetica").fontSize(9);
      return yy + arowH;
    };
    ay = header(ay);
    // Draw rows page by page; at each page break draw that page's full grid (outer border + column
    // separators + row lines), then the merged "Time Logged On" / summed-Amount cells over it.
    let pageRows: { r: any; y: number }[] = [];
    let lastSegTop = ay, lastSegBot = ay;
    let zi = 0; // zebra row counter (reset each page)
    const flush = () => {
      if (!pageRows.length) return;
      const bodyTop = pageRows[0].y, segBot = pageRows[pageRows.length - 1].y + arowH;
      lastSegTop = bodyTop; lastSegBot = segBot;
      // Inner grid: light row separators + column separators.
      doc.lineWidth(0.5).strokeColor("#cfd6e4");
      for (let i = 1; i < pageRows.length; i++) doc.moveTo(L, pageRows[i].y).lineTo(R, pageRows[i].y).stroke(); // between rows
      doc.moveTo(L, bodyTop).lineTo(R, bodyTop).stroke();                                                      // header/body divider
      for (const c of cols) if (c.x > L) doc.moveTo(c.x, pageTop).lineTo(c.x, segBot).stroke();                // column separators
      // Merge consecutive equal "Time Logged On" values into one cell (covers the internal row lines).
      if (showTLO && tloCol) {
        let k = 0;
        while (k < pageRows.length) {
          const val = (pageRows[k].r.timeLoggedOn || "").trim();
          let m = k; while (m + 1 < pageRows.length && (pageRows[m + 1].r.timeLoggedOn || "").trim() === val) m++;
          const gy0 = pageRows[k].y, gy1 = pageRows[m].y + arowH;
          doc.rect(tloCol.x, gy0, tloCol.w, gy1 - gy0).fillAndStroke("#ffffff", "#cfd6e4");
          if (val) doc.fillColor("#000").font("Helvetica").fontSize(9).text(val, tloCol.x + PAD, (gy0 + gy1) / 2 - 5, { width: tloCol.w - PAD * 2, height: 12, ellipsis: true });
          k = m + 1;
        }
      }
      // Sum-all mode: the Amount column is one merged cell (covers internal row lines); total drawn later.
      if (sumTotal) doc.rect(amtCol.x, bodyTop, amtCol.w, segBot - bodyTop).fillAndStroke("#ffffff", "#cfd6e4");
      // Outer frame drawn LAST (darker + thicker) so the merged white cells can never paint over the
      // table's top/bottom/side borders — the bottom edge always closes the table cleanly.
      doc.lineWidth(1).strokeColor("#8a97ad").rect(L, pageTop, R - L, segBot - pageTop).stroke();
      doc.lineWidth(0.5).strokeColor("#cfd6e4");
      pageRows = [];
    };
    for (const a of rows) {
      if (ay + arowH > PAGE_BOTTOM) { flush(); doc.addPage(); ay = header(50); zi = 0; }
      if (zi % 2 === 1) doc.rect(L, ay, R - L, arowH).fill("#eef3fb"); // zebra: tint alternate (odd) rows
      zi++;
      doc.fillColor("#000");
      for (const c of cols) { if (c.key === "tlo" || (sumTotal && c.key === "amt")) continue; cell(c, c.get(a), ay); }
      pageRows.push({ r: a, y: ay });
      ay += arowH;
    }
    flush();
    if (sumTotal) {
      const totalAmt = rows.reduce((s: number, a: any) => s + (+a.amount || 0), 0);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(money(ccy, totalAmt), amtCol.x + PAD, (lastSegTop + lastSegBot) / 2 - 6, { width: amtCol.w - PAD * 2, align: "right", height: 13, ellipsis: true });
    }
    doc.lineWidth(1).strokeColor("#000");
    return ay;
  };

  // Sections start at the configured Y, or lower if the header block actually runs past it.
  let y = Math.max(layout.sectionsStartY, headerBottom + 14);
  for (const s of layout.sections) {
    if (!s.visible) continue;
    if (s.key === "lineItems") y = drawLineItems(y);
    else if (s.key === "bankDetails") y = drawBank(y);
    else if (s.key === "annexure") { if (!inv.annexureHide) y = drawAnnexure(y); }
  }
  doc.y = y;

  doc.moveDown(1.5);
  // Keep the closing line on the page — writing past the bottom margin would spill onto a blank page.
  if (doc.y > 770) doc.y = 770;
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#000").text("Thank you for your business.", L, doc.y, { lineBreak: false });

  doc.end();
}
