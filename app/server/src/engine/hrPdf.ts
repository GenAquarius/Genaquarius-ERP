// HR document rendering — Offer Letter + Appointment Letter PDFs.
//
// Fonts, sizes, colors and indentation below are not stylistic choices — they were measured
// directly from the source documents:
//   - Offer letter: extracted per-character font/size/color from a real generated PDF
//     ("1071. Offer Letter - Jalaj Goyal.pdf") via pdfplumber. Font is Barlow — a Google Font
//     (SIL Open Font License), embedded from server/assets/fonts/Barlow-*.ttf.
//   - Appointment letter: extracted from "Appointment Letter - GenAquarius.docx"'s actual
//     run/style properties via python-docx. Font is Tahoma, embedded from the Windows system
//     font files (server/assets/fonts/Tahoma*.ttf) — Tahoma is a Microsoft font with no
//     redistributable open license, so it is embedded from this machine's own licensed Windows
//     install for this company's own internal documents, the same font Word itself would use;
//     it is not bundled as a general-purpose asset.
// Content (paragraphs, clauses) is DATA (HrOfferTemplate.bodyText / HrAppointmentTemplate.clauses,
// filled with {{placeholders}}) — this file only lays it out, it never hard-codes letter wording.
import PDFDocument from "pdfkit";
import { Writable } from "stream";
import path from "path";
import fs from "fs";
import { fillTemplate } from "./hr";
import { fmtDate } from "./dateFormat";

const LOGO_PATH = path.resolve(__dirname, "../../assets/genaquarius.png");
// CHRO's own signature, exactly as it appears in the real "Appointment Letter - GenAquarius.docx"
// reference (extracted directly from that document's own embedded image) — the company's own
// signatory image for the company's own generated documents, same category of asset as the logo.
const SIGNATURE_PATH = path.resolve(__dirname, "../../assets/vivek-kaw-signature.png");
const FONT_DIR = path.resolve(__dirname, "../../assets/fonts");
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Shared by every render*Pdf() below — the configurable signatory (HR Admin Settings →
// Signature; see engine/hr.ts's getHrSignature()). Any caller that omits these keeps the
// original hard-coded "Vivek Kaw / CHRO" + static asset image, so this is zero-regression.
export interface SignatureFields {
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  signatureImageBase64?: string | null;
}
// Draws the configured signature image (base64, no file I/O) if present, else falls back to the
// static asset file, else returns false so the caller can fall back to a script-font approximation.
function drawSignatureImage(doc: any, base64: string | null | undefined, x: number, y: number, width: number, height: number): boolean {
  try {
    if (base64) { doc.image(Buffer.from(base64.replace(/^data:.*;base64,/, ""), "base64"), x, y, { width, height }); return true; }
    if (fs.existsSync(SIGNATURE_PATH)) { doc.image(SIGNATURE_PATH, x, y, { width, height }); return true; }
  } catch { /* fall through to caller's text fallback */ }
  return false;
}

// ---- exact colors measured from the source documents (not approximations) ----
const OFFER_C = {
  title: "#000000",       // "OFFER LETTER" — Barlow-Bold 20pt, black (no red in the real PDF)
  heading: "#000000",     // "Position Details" / "Compensation and Benefits" — Barlow 16pt, black
  greeting: "#262626",    // "Dear X," — rgb(0.149,0.149,0.149)
  intro: "#404040",       // opening paragraph — rgb(0.251,0.251,0.251)
  body: "#262626",        // bulleted Compensation/Benefits items — rgb(0.149,0.149,0.149)
  footerLabel: "#262626", // "GenAquarius Proprietary & Confidential"
  footerText: "#A6A6A6",  // entity name / address block — rgb(0.651,0.651,0.651)
};
const APPT_C = {
  title: "#DF121F",        // "Appointment Letter" + "Position Details" — measured from the docx run color
  heading: "#404040",      // ALL-CAPS section headings (APPOINTMENT DETAILS:, COMPENSATION:, …)
  greeting: "#252525",
  body: "#404040",
  sign: "#252525",
};

// Company-wide "Jan 2nd 2026" format (see engine/dateFormat.ts) — was previously day-first
// ("2nd Jan 2026"), now matches every other generated document.
const dstr = fmtDate;
// No "₹" here on purpose: neither embedded font (Barlow, Tahoma) reliably has that glyph, and
// the real source documents don't use the symbol either — the offer letter spells out "INR",
// and the Annexure table's cells are plain numbers with the currency named in the header only.
function money(n: number, ccy = "INR") {
  const sym = ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "INR ";
  return sym + Math.round(n || 0).toLocaleString("en-IN");
}
function numOnly(n: number) {
  return Math.round(n || 0).toLocaleString("en-IN");
}
// Indian numbering system (Crore/Lakh, not Million/Billion) amount-in-words — matches the reference
// FnF Settlement template's payment sentence exactly (e.g. 296907 → "Two Lakh Ninety Six Thousand
// Nine Hundred Seven"). Whole rupees only (FnF amounts are always rounded before this is called).
const NUM_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const NUM_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigitWords(n: number): string {
  if (n < 20) return NUM_ONES[n];
  return NUM_TENS[Math.floor(n / 10)] + (n % 10 ? " " + NUM_ONES[n % 10] : "");
}
function threeDigitWords(n: number): string {
  if (n < 100) return twoDigitWords(n);
  return NUM_ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + twoDigitWords(n % 100) : "");
}
function amountInWordsInr(amount: number): string {
  let n = Math.round(Math.abs(amount || 0));
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  const parts: string[] = [];
  if (crore) parts.push(threeDigitWords(crore) + " Crore");
  if (lakh) parts.push(twoDigitWords(lakh) + " Lakh");
  if (thousand) parts.push(twoDigitWords(thousand) + " Thousand");
  if (n) parts.push(threeDigitWords(n));
  return parts.join(" ");
}
/** "INR 24.5 Lakhs" — matches the real offer letter's phrasing for an India CTC exactly. */
function lakhsPhrase(n: number, ccy = "INR") {
  if (ccy !== "INR") return money(n, ccy);
  const lakhs = Math.round(((n || 0) / 100000) * 100) / 100; // 2dp, trailing zeros trimmed by String()
  return `INR ${lakhs} Lakhs`;
}
const firstName = (s: string) => String(s || "").trim().split(/\s+/)[0] || s;

/** Register the embedded fonts this document needs; falls back to a built-in font if a file is missing. */
function registerFonts(doc: any, kind: "offer" | "appointment") {
  const has = (f: string) => fs.existsSync(path.join(FONT_DIR, f));
  if (kind === "offer") {
    if (has("Barlow-Regular.ttf")) doc.registerFont("Body", path.join(FONT_DIR, "Barlow-Regular.ttf")); else doc.registerFont("Body", "Helvetica");
    if (has("Barlow-Bold.ttf")) doc.registerFont("Body-Bold", path.join(FONT_DIR, "Barlow-Bold.ttf")); else doc.registerFont("Body-Bold", "Helvetica-Bold");
    if (has("Barlow-Italic.ttf")) doc.registerFont("Body-Italic", path.join(FONT_DIR, "Barlow-Italic.ttf")); else doc.registerFont("Body-Italic", "Helvetica-Oblique");
  } else {
    if (has("Tahoma.ttf")) doc.registerFont("Body", path.join(FONT_DIR, "Tahoma.ttf")); else doc.registerFont("Body", "Helvetica");
    if (has("Tahoma-Bold.ttf")) doc.registerFont("Body-Bold", path.join(FONT_DIR, "Tahoma-Bold.ttf")); else doc.registerFont("Body-Bold", "Helvetica-Bold");
    // Tahoma has no italic on Windows; the source doc's one italic line (CHRO signature) is
    // approximated with the offer letter's Barlow italic if present, else a built-in oblique.
    if (has("Barlow-Italic.ttf")) doc.registerFont("Body-Italic", path.join(FONT_DIR, "Barlow-Italic.ttf")); else doc.registerFont("Body-Italic", "Helvetica-Oblique");
  }
}

const BRAND_RED = "#C4161C";

const OFFER_FOOTER_ENTITIES = [
  { name: "GenAquarius Private Limited", lines: ["24th Floor, Etherea, Alphathum, Tower B,", "Sector 90, Noida, Uttar Pradesh, 201305", "www.genaquarius.com", "hr@genaquarius.com"], primary: true },
  { name: "GenAquarius LLC", lines: ["2795 E Bidwell St.", "Suite 100-662, Folsom,", "CA 95630, USA"] },
  { name: "GenAquarius Technologies Limited", lines: ["5343 Dundas Street West", "Suite 601, Etobicoke, Toronto,", "Ontario, M9B 6H8, Canada"] },
];
// Only the primary (GenAquarius Private Limited) column has icons in the real footer: a location
// pin beside the 2-line address, a globe beside the website, an envelope beside the email —
// keyed by that column's own line index (0/1 = address, 2 = website, 3 = email).
const OFFER_FOOTER_ICONS: Record<number, "pin" | "globe" | "envelope"> = { 0: "pin", 2: "globe", 3: "envelope" };

/** Small vector glyphs (no image asset needed) for the offer letter's footer contact block. */
function footerIcon(doc: any, type: "pin" | "globe" | "envelope", x: number, y: number, size: number) {
  const color = type === "globe" ? "#8a8a8a" : BRAND_RED;
  doc.save();
  doc.fillColor(color).strokeColor(color).lineWidth(0.6);
  if (type === "pin") {
    const r = size * 0.32, cx = x + size / 2, cy = y + r + 0.5;
    doc.circle(cx, cy, r).fill();
    doc.polygon([cx - r * 0.68, cy + r * 0.5], [cx + r * 0.68, cy + r * 0.5], [cx, cy + size * 0.95]).fill();
    doc.circle(cx, cy, r * 0.38).fillColor("#ffffff").fill();
  } else if (type === "globe") {
    const r = size / 2, cx = x + r, cy = y + r;
    doc.circle(cx, cy, r).stroke();
    doc.moveTo(x, cy).lineTo(x + size, cy).stroke();
    doc.ellipse(cx, cy, r * 0.42, r).stroke();
  } else {
    doc.rect(x, y + size * 0.15, size, size * 0.7).fill();
    doc.strokeColor("#ffffff").lineWidth(0.8);
    doc.moveTo(x + 0.5, y + size * 0.18).lineTo(x + size / 2, y + size * 0.55).lineTo(x + size - 0.5, y + size * 0.18).stroke();
  }
  doc.restore();
}

/**
 * Footer reproduced from "1071. Offer Letter - Jalaj Goyal.pdf" — "GenAquarius Proprietary &
 * Confidential" + 3-entity address block. Every y below is an absolute offset from `bottom`
 * (divider line, measured at page.height-93.6 on the reference's 841.9pt-tall A4 page), not
 * stacked from a guessed line-height — the same root-cause fix already applied to
 * appointmentFooter() below. Drawn with the bottom margin zeroed out so these absolute-positioned
 * lines can safely sit inside what PDFKit normally treats as the unprintable margin area —
 * without that, writing past `page.height - margins.bottom` silently triggers an extra blank
 * page per call, which is what caused a 2-page letter to balloon to 20+ pages.
 */
function offerFooter(doc: any) {
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const bottom = doc.page.height - 93.6;
  doc.moveTo(67, bottom).lineTo(doc.page.width - 67, bottom).strokeColor("#dddddd").lineWidth(0.5).stroke();
  doc.font("Body").fontSize(8).fillColor(OFFER_C.footerLabel).text("GenAquarius Proprietary & Confidential", 81, bottom + 5, { width: 300, lineBreak: false });
  // 3 entity columns — x-positions measured directly from the real footer (97 / 267 / 395 on a
  // 595.3pt-wide A4 page), not evenly spaced.
  const cols = [{ x: 97, w: 165 }, { x: 267, w: 125 }, { x: 395, w: 125 }];
  const lineH = 12.3; // measured spacing between the entity's own address/website/email lines
  OFFER_FOOTER_ENTITIES.forEach((e, i) => {
    const { x, w: colW } = cols[i];
    let y = bottom + 19.7; // entity-name row
    // Measure the actual rendered height (don't assume 1 line) — "GenAquarius Technologies
    // Limited" wraps to 2 lines at this column width, and a fixed single-line advance let it
    // overlap the address line below it.
    doc.font("Body-Bold").fontSize(8);
    const nameH = doc.heightOfString(e.name, { width: colW - 6 });
    doc.fillColor(e.primary ? "#333333" : OFFER_C.footerText).text(e.name, x, y, { width: colW - 6 });
    if (e.primary) footerIcon(doc, "pin", x - 15, y - 1, 14.3); // spans the name→address-line-1 gap
    y += Math.max(lineH, nameH + 0.5);
    e.lines.forEach((line, li) => {
      const icon = e.primary ? OFFER_FOOTER_ICONS[li] : undefined;
      if (icon === "globe") footerIcon(doc, "globe", x - 15, y - 2, 10.4);
      else if (icon === "envelope") footerIcon(doc, "envelope", x - 15, y - 1, 7.8);
      doc.font("Body").fontSize(7.5).fillColor(OFFER_C.footerText).text(line, x, y, { width: colW - 6, lineBreak: false });
      y += lineH;
    });
  });
  doc.page.margins.bottom = savedBottom;
}

/**
 * Appointment Letter's own footer — same corporate letterhead content/icons as the offer letter
 * (reuses footerIcon() + OFFER_FOOTER_ENTITIES/OFFER_FOOTER_ICONS, which are generic company
 * data), but its OWN geometry: confirmed present on every page of the real Word-rendered
 * reference (A4, 595.8×841.8) via embedded footer images, measured span-by-span with PyMuPDF.
 * Unlike the offer letter, the "Proprietary & Confidential" label sits at the SAME x as the
 * first entity column (both x≈90), not offset from the body margin — a real, confirmed
 * difference between the two documents, not an oversight.
 */
function appointmentFooter(doc: any) {
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const bottom = doc.page.height - 93.5; // divider measured at y≈748.25 on an 841.8-tall page
  doc.moveTo(67, bottom - 4).lineTo(doc.page.width - 67, bottom - 4).strokeColor("#dddddd").lineWidth(0.5).stroke();
  // Every y below is an absolute offset from `bottom`, measured directly off the real reference
  // PDF's own text/image geometry (page.get_text("dict")/get_image_info()) — NOT derived by
  // stacking "previous line + a guessed line-height", which is what previously let the whole
  // block (and therefore every icon beside it) drift ~14pt too high versus the real document.
  doc.font("Body").fontSize(8).fillColor(OFFER_C.footerLabel).text("GenAquarius Proprietary & Confidential", 90, bottom + 7.5, { width: 300, lineBreak: false });
  // Columns measured directly: 90 / 266 / 399 on the 595.8pt-wide page (not evenly spaced).
  const cols = [{ x: 90, w: 170 }, { x: 266, w: 127 }, { x: 399, w: 121 }];
  OFFER_FOOTER_ENTITIES.forEach((e, i) => {
    const { x, w: colW } = cols[i];
    let y = bottom + 28.5;
    doc.font("Body-Bold").fontSize(8);
    // The real reference fits every entity name on one line; Tahoma-Bold is slightly wider than
    // Calibri at this size and can wrap "GenAquarius Technologies Limited" onto 2 lines — measure
    // the ACTUAL rendered height (don't assume 1 line) so the address lines below never overlap it.
    const nameH = doc.heightOfString(e.name, { width: colW - 6 });
    doc.fillColor(e.primary ? "#333333" : OFFER_C.footerText).text(e.name, x, y, { width: colW - 6 });
    // Icons: measured directly beside each real line (pin spans the entity-name→address-line-1
    // gap; globe/envelope each sit just above their own line) — pin drawn once, before the lines
    // loop, at the entity-name row itself, not keyed to a line index inside the loop.
    if (e.primary) footerIcon(doc, "pin", x - 15, y - 4, 14.5);
    y += nameH + 0.5;
    e.lines.forEach((line, li) => {
      const icon = e.primary ? OFFER_FOOTER_ICONS[li] : undefined;
      if (icon === "globe") footerIcon(doc, "globe", x - 15, y - 5, 10.5);
      else if (icon === "envelope") footerIcon(doc, "envelope", x - 15, y - 3, 8);
      doc.font("Body").fontSize(7.5).fillColor(OFFER_C.footerText).text(line, x, y, { width: colW - 6, lineBreak: false });
      y += 9;
    });
  });
  doc.page.margins.bottom = savedBottom;
}

export interface OfferPdfData extends SignatureFields {
  offerRef: string;
  candidateName: string;
  role: string;
  designation: string;
  ctc: number;
  offerDate: Date | string;
  proposedJoiningDate?: Date | string | null;
  businessName?: string;
  countryCode?: string;
  reportingManager?: string | null;
  probationPeriod?: string | null;
  noticePeriod?: string | null;
  acceptanceDeadline?: Date | string | null;
  documentChecklist?: string[] | null;
  phone?: string | null; // candidate's PERSONAL number — never officialPhone
  templateBody: string; // kept for backward compatibility; the structured render below is used instead
  breakup: { components: { name: string; part: string; pct: number; monthly: number; annual: number }[]; grossA: number; grossAAnnual: number; grossB: number; grossBAnnual: number; totalMonthly: number; totalAnnual: number };
}

export function renderOfferPdf(o: OfferPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: OFFER_MARGIN, bufferPages: true });
  registerFonts(doc, "offer");
  doc.pipe(out);
  const ccy = o.countryCode === "US" || o.countryCode === "UNITED STATES" ? "USD" : o.countryCode === "CANADA" ? "CAD" : "INR";
  const pageW = doc.page.width;
  const contentRight = pageW - OFFER_MARGIN;

  // Every page gets the red bar; every page AFTER the first also gets a small top-right logo
  // (page 1 draws its own larger top-left logo + Date separately, right below).
  doc.on("pageAdded", () => pageHeader(doc, false, OFFER_PAGE_OPTS));
  pageHeader(doc, true, OFFER_PAGE_OPTS);
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, OFFER_MARGIN, 53, { width: 191 }); } catch { /* ignore */ } }
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Date: ${dstr(o.offerDate)}`, OFFER_MARGIN, 115, { width: contentRight - OFFER_MARGIN, align: "right" });
  doc.y = 141;

  doc.font("Body-Bold").fontSize(20).fillColor(OFFER_C.title).text("OFFER LETTER", OFFER_MARGIN, doc.y);
  doc.moveDown(0.3);
  doc.moveTo(OFFER_MARGIN, doc.y).lineTo(contentRight, doc.y).strokeColor(OFFER_RULE_COLOR).lineWidth(1.8).stroke();
  doc.moveDown(1);

  doc.font("Body-Bold").fontSize(11).fillColor(OFFER_C.greeting).text(`Dear ${firstName(o.candidateName)},`);
  doc.moveDown(0.6);
  doc.font("Body").fontSize(10).fillColor(OFFER_C.intro).text(
    `We are pleased to offer you the position of ${o.role} at GenAquarius Private Limited. We believe your skills and experience will be a valuable addition to our team. Below are the terms of our offer:`,
    { align: "left", lineGap: 3 }
  );
  doc.moveDown(1);

  doc.font("Body").fontSize(16).fillColor(OFFER_C.heading).text("Position Details");
  doc.moveDown(0.4);
  // Fixed two-column tab-stop layout (label flush left, bold value at a shared x) — matches the
  // real letter's Job Title:/Start Date:/Location:/Reporting To: block exactly, not inline text.
  const labelX = OFFER_MARGIN, valueX = 144, rowH = 19;
  const posLine = (label: string, value: string) => {
    const y = doc.y;
    doc.font("Body").fontSize(10).fillColor(OFFER_C.intro).text(`${label}:`, labelX, y, { width: valueX - labelX - 8 });
    doc.font("Body-Bold").fontSize(10).fillColor(OFFER_C.intro).text(value, valueX, y, { width: contentRight - valueX });
    doc.y = y + rowH;
  };
  posLine("Job Title", o.designation);
  posLine("Start Date", o.proposedJoiningDate ? dstr(o.proposedJoiningDate) : "To be confirmed");
  posLine("Location", o.businessName ? o.businessName : "Noida");
  posLine("Reporting To", o.reportingManager || "—");
  if (o.phone) posLine("Phone", o.phone);
  doc.moveDown(1);

  // Explicit x — without it this inherits x=valueX (150) left over from posLine()'s last call
  // above, indenting the heading instead of aligning it to the page margin.
  doc.font("Body").fontSize(16).fillColor(OFFER_C.heading).text("Compensation and Benefits:", OFFER_MARGIN, doc.y);
  doc.moveDown(0.4);
  // Hanging-indent bullet: the bullet glyph sits at bulletX; the (possibly bold-led, wrapping)
  // paragraph starts at textX and — because we set doc.x/doc.y once and never pass a stray
  // empty text() call — PDFKit wraps continuation lines back to that same textX correctly.
  const bulletX = OFFER_MARGIN + 18, textX = OFFER_MARGIN + 36, textWidth = contentRight - textX;
  const bullet = (segments: [string, boolean][]) => {
    const y = doc.y;
    doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text("•", bulletX, y, { width: textX - bulletX, lineBreak: false });
    segments.forEach(([text, bold], i) => {
      doc.font(bold ? "Body-Bold" : "Body").fontSize(10).fillColor(OFFER_C.body);
      if (i === 0) doc.text(text, textX, y, { continued: segments.length > 1, width: textWidth, lineGap: 2 });
      else doc.text(text, { continued: i < segments.length - 1, width: textWidth, lineGap: 2 });
    });
    doc.moveDown(0.6);
  };
  bullet([["Base Salary: ", true], [`${lakhsPhrase(o.ctc, ccy)} per annum, paid monthly, subject to deductions for taxes and other withholdings as required by law. Provident Fund contributions will be made as per the Employees' Provident Fund Provisions Act, 1952.`, false]]);
  bullet([["Benefits: ", true], ["You will be covered under the Medical Insurance Policy at the time of joining the service. Medical insurance will cover the Spouse & Children.", false]]);
  bullet([["Vacations: ", true], ["You are entitled to receive 18 days paid vacation (12 Earned, 6 General Leaves & not counting public holidays, Saturdays and Sundays) every 12 months, which accrues at the rate of 1.50 days each month.", false]]);
  bullet([["Your detailed salary structure is attached as per Annexure A", false]]);
  bullet([[`Probation Period - ${o.probationPeriod || "2 Months"}`, false]]);
  bullet([[`Notice Period - ${o.noticePeriod || "2 Months"}`, false]]);
  bullet([["Your remuneration package is strictly confidential between you and the Company and should not be discussed with anyone nor divulged to anyone in any manner whatsoever.", false]]);
  doc.x = OFFER_MARGIN;
  offerFooter(doc);

  // Conditions of Offer starts on its own page — matches the real letter, which always breaks
  // here regardless of how much the Position Details/Compensation content above fills page 1.
  doc.addPage();
  doc.y = 100;

  // Conditions of Offer — bold-lead, justified paragraphs (matches "Confidentiality:" /
  // "Additional Provisions with Regards to Official Travel Outside India:" exactly).
  doc.font("Body").fontSize(16).fillColor(OFFER_C.heading).text("Conditions of Offer:", OFFER_MARGIN, doc.y, { align: "left" });
  doc.moveDown(0.5);
  paragraph(doc, "Confidentiality: You recognize and agree that confidential and/or proprietary information concerning the business or affairs of GenAquarius (including, but not limited to, GenAquarius's customer lists, the proprietary technology, information and know-how of GenAquarius's customers, GenAquarius's technologies services, marketing plans, strategies, costs, profits, sales and capitalization) is a valuable asset of GenAquarius and that unauthorized disclosure or use of any such confidential and/or proprietary information that you may obtain in the course of your employment would inflict irreparable harm to GenAquarius. You, therefore, agree that, during the term of your employment with GenAquarius and thereafter, you will not disclose or use, or authorize anyone else to disclose or use, any such confidential and/or proprietary information without the prior written specific consent of GenAquarius.");
  paragraph(doc, "Additional Provisions with Regards to Official Travel Outside India: If you are required to travel to GenAquarius's offices or client locations outside India for work or business purposes for more than 15 working days, you must agree to work for 6 months at GenAquarius's India-based development centers upon your return. This ensures that the company's investment in your travel is effectively utilized. During this 6 months, you will be responsible for transferring all knowledge gained during your visit to GenAquarius's team.");

  paragraph(doc, `Please indicate your acceptance of the terms set forth in this letter by sign and return a copy of this letter by ${dstr(o.acceptanceDeadline || new Date(Date.now() + 7 * 86400000))}.`, { justify: false });
  paragraph(doc, "We take this opportunity to congratulate you and are looking forward for you to begin, an enduring relationship with GenAquarius Private Limited!", { justify: false });
  paragraph(doc, "Please feel free to contact me if you have any questions or need further clarification.", { justify: false });
  paragraph(doc, "We look forward to hearing from you soon.", { justify: false });

  doc.moveDown(0.4);
  doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text("Sincerely,");
  doc.moveDown(0.6);
  const sigName = o.signatoryName || "Vivek Kaw", sigTitle = o.signatoryTitle || "Chief Human Resources Officer";
  // A configured signature image is drawn if present; otherwise the original script-style
  // Times-Italic approximation (not a fabricated scanned signature) is kept as the fallback.
  if (drawSignatureImage(doc, o.signatureImageBase64, OFFER_MARGIN, doc.y, 90, 20)) doc.moveDown(1.4);
  else doc.font("Times-Italic").fontSize(22).fillColor(OFFER_C.body).text(sigName);
  doc.font("Body").fontSize(10);
  doc.moveDown(0.3);
  doc.font("Body-Bold").text(sigName);
  doc.font("Body").text(sigTitle);
  doc.font("Body-Italic").text("(Authorised Signatory)");
  doc.moveDown();
  doc.font("Body").fontSize(10).fillColor("#000000").text(`Encl: Annexure A (Salary Structure), Annexure B (Check List of Documents),`);
  offerFooter(doc);

  // Annexure A — Salary Structure (centered heading, filled header row, highlighted subtotals,
  // then the acceptance/declaration + signature block on the same page — matches the real PDF).
  doc.addPage();
  doc.y = 100;
  doc.font("Body-Bold").fontSize(18).fillColor("#000000").text("Annexure A (Salary Structure)", OFFER_MARGIN, doc.y, { width: contentRight - OFFER_MARGIN, align: "center" });
  doc.moveDown(1.2);
  // A 0%-of-CTC component is configured but not applicable to this bracket/employee — never shown
  // on the letter, matching the Appointment letter's own Annexure below.
  const partA = o.breakup.components.filter((c) => c.part === "A" && c.pct !== 0);
  const partB = o.breakup.components.filter((c) => c.part === "B" && c.pct !== 0);
  // Column widths re-measured from "1071"'s own Annexure A (x0=72, boundaries at 304.5/402.75/498.75).
  const w = [232.5, 98.25, 96];
  const annexureRows = [
    ...partA.map((c) => [c.name, numOnly(c.monthly), numOnly(c.annual)]),
    ["Gross Salary (A)", numOnly(o.breakup.grossA), numOnly(o.breakup.grossAAnnual)],
    ...partB.map((c) => [c.name, numOnly(c.monthly), numOnly(c.annual)]),
    ["Gross Salary (Flexi) (B)", numOnly(o.breakup.grossB), numOnly(o.breakup.grossBAnnual)],
    ["Total Cost to Company (C) = A + B", numOnly(o.breakup.totalMonthly), numOnly(o.breakup.totalAnnual)],
  ];
  const highlight = new Set([partA.length, annexureRows.length - 2, annexureRows.length - 1]);
  table(doc, ["Component", `Monthly (${ccy})`, `Annual (${ccy})`], annexureRows, w, "offer", highlight);
  doc.moveDown(1.5);
  paragraph(doc, "Salary (CTC - Part A): Salary is paid monthly through bank transfer on the last day of the month, in the bank account details provided and is subject to regular attendance, submission and Permanent Account Number (PAN) details as per Company's records.");
  paragraph(doc, "Flexible Benefit Plan (CTC - Part B): Will be paid on monthly basis or on furnishing of proofs and will be taxable if proofs are not furnished or proofs furnished are short.");
  doc.moveDown(0.4);
  doc.font("Body-Bold").fontSize(11).fillColor("#000000").text("OFFER ACCEPTANCE & DECLARATION", { underline: true });
  doc.moveDown(0.5);
  paragraph(doc, "I have read and understood the terms and conditions of the above-mentioned offer letter including all annexures and I hereby confirm the acceptance of the same.", { justify: false });
  doc.moveDown(1.2);
  // Adobe Sign text-tag syntax — auto-detected on upload and converted into a real, clickable
  // signature field here for the candidate. Small/muted since it's a machine-readable marker,
  // not part of the letter's own visible copy (reproduced live: without this, "Start → Submit"
  // completes an e-signature request with nothing to actually sign).
  doc.fontSize(9).fillColor("#888").text("Candidate Signature: {{Sig_es_:signer1:signature}}");
  offerFooter(doc);

  // Annexure B — List of Joining Documents (own page, centered heading, numbered list).
  doc.addPage();
  doc.y = 100;
  doc.font("Body-Bold").fontSize(18).fillColor("#000000").text("Annexure B – List of joining Documents", OFFER_MARGIN, doc.y, { width: contentRight - OFFER_MARGIN, align: "center" });
  doc.moveDown(1.2);
  paragraph(doc, "As a part of the joining process at GenAquarius Private Limited you are requested to submit copies of the following listed documents on your day of joining. You are requested to carry the originals along for the purpose of verification.", { justify: false });
  doc.moveDown(0.4);
  // HR's own selection from the master Onboarding Document Types list (checked on Generate
  // Offer) — never a hard-coded list. Falls back to the original 6-item default only for offers
  // created before this was configurable, so an old draft's PDF doesn't suddenly render blank.
  (o.documentChecklist?.length ? o.documentChecklist : [
    "High School Passing Certificate Copy",
    "Last Form 16 and PAN Card Copy",
    "Degree for Graduation/Post Graduation and Mark sheets Copy",
    "Relieving certificate or copy of the resignation served to the previous employer Copy",
    "Digital passport size photographs",
    "Passport and Aadhar Card Copy",
  ]).forEach((d: string, i: number) => {
    // Same proven hanging-indent shape as the bullet() list above (two independent text() calls,
    // not a continued chain) — a continued chain here inherits the NUMBER's narrow width for the
    // whole run, which wrapped the real sentence one character per line.
    const y = doc.y;
    doc.font("Body-Bold").fontSize(10).fillColor(OFFER_C.body).text(`${i + 1}.`, OFFER_MARGIN, y, { width: 16, lineBreak: false });
    doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(d, OFFER_MARGIN + 20, y, { width: contentRight - (OFFER_MARGIN + 20) });
    doc.moveDown(0.4);
  });
  offerFooter(doc);

  doc.end();
}

// Internship Letter — replaces the Contractor-style Service Agreement (Bank Details/Aadhar/SLA
// Name-Address/Monthly-Compensation clauses) for INTERN offers specifically. Content is a plain
// {{Placeholder}} template (HrEmailTemplate key "INTERNSHIP_LETTER", edited in HR Settings ->
// Email exactly like the Offer/Welcome emails), not a clause list — a single flowing letter, per
// the reference document ("Internship Letter (Devansh Dixit).pdf"). Reuses the Offer Letter's
// exact header/footer/font/margin so it visually matches ("Styling and everything must flow offer
// template" — explicit instruction), just without the multi-page Annexures an Offer Letter needs.
export interface InternshipLetterPdfData extends SignatureFields {
  subject: string;
  body: string; // already fillTemplate()'d by the caller
}
export function renderInternshipLetterPdf(o: InternshipLetterPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: OFFER_MARGIN, bufferPages: true });
  registerFonts(doc, "offer");
  doc.pipe(out);
  const contentRight = doc.page.width - OFFER_MARGIN;

  doc.on("pageAdded", () => pageHeader(doc, false, OFFER_PAGE_OPTS));
  pageHeader(doc, true, OFFER_PAGE_OPTS);
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, OFFER_MARGIN, 53, { width: 191 }); } catch { /* ignore */ } }
  doc.y = 141;

  // Body is free-form HTML-ish text from the template editor (one paragraph per line, same
  // convention as every other HR email/letter body in this app) — rendered as plain justified
  // paragraphs, blank lines becoming paragraph breaks.
  String(o.body || "").replace(/\r\n/g, "\n").split(/\n{2,}/).forEach((block) => {
    const line = block.replace(/\n/g, " ").trim();
    if (line) paragraph(doc, line, { justify: false });
  });

  if (o.signatoryName || o.signatureImageBase64) {
    doc.moveDown(0.4);
    const sigName = o.signatoryName || "Vivek Kaw", sigTitle = o.signatoryTitle || "Chief Human Resources Officer";
    if (drawSignatureImage(doc, o.signatureImageBase64, OFFER_MARGIN, doc.y, 90, 20)) doc.moveDown(1.4);
    else doc.font("Times-Italic").fontSize(22).fillColor(OFFER_C.body).text(sigName);
    doc.font("Body").fontSize(10);
    doc.moveDown(0.3);
    doc.font("Body-Bold").text(sigName);
    doc.font("Body").text(sigTitle);
  }
  offerFooter(doc);
  doc.end();
}

// Table header fill + highlighted-subtotal-row background — measured pixel-for-pixel from the
// real "Annexure A (Salary Structure)" table (0008. Offer Letter - Amardeep Pundhir.pdf).
const TABLE_HEADER_BG = "#540C44";
const TABLE_HIGHLIGHT_BG = "#E4DBE2";

/**
 * Table matching the real Annexure exactly: a filled dark header row with white bold text,
 * indented (non-bold) component labels, and a light lavender highlight + bold on subtotal rows
 * (passed via `highlightRows`, a set of 0-based row indices into `rows`).
 */
function table(doc: any, headers: string[], rows: (string | number)[][], widths: number[], kind: "offer" | "appointment", highlightRows: Set<number> = new Set()) {
  const c = kind === "offer" ? OFFER_C : APPT_C;
  // This helper is only ever called for the offer letter's Annexure A — x0/rowH are that
  // table's own measured geometry (x0=93.36, row height ~15.3–16 across the real reference PDF).
  const x0 = kind === "offer" ? OFFER_MARGIN : 50;
  const rowH = kind === "offer" ? 15.5 : 20;
  const totalW = widths.reduce((a, b) => a + b, 0);

  // Header: filled bar, white bold text.
  doc.rect(x0, doc.y, totalW, rowH).fill(TABLE_HEADER_BG);
  let hy = doc.y + 5, hx = x0;
  doc.font("Body-Bold").fontSize(9.5).fillColor("#ffffff");
  headers.forEach((h, i) => { doc.text(h, hx + (i === 0 ? 10 : 0), hy, { width: widths[i] - (i === 0 ? 10 : 8), align: i === 0 ? "left" : "right" }); hx += widths[i]; });
  doc.y += rowH;

  rows.forEach((cells, ri) => {
    // addPage() already fires the "pageAdded" listener registered by the caller (which draws the
    // correct header for whichever document this table belongs to) — no need to call pageHeader
    // again here; doing so would draw a second, wrongly-styled header on top of it.
    if (doc.y > 730) { doc.addPage(); doc.y = 100; }
    const y = doc.y;
    const bold = highlightRows.has(ri);
    if (bold) doc.rect(x0, y, totalW, rowH).fill(TABLE_HIGHLIGHT_BG);
    let x = x0;
    doc.font(bold ? "Body-Bold" : "Body").fontSize(9.5).fillColor(bold ? "#1a1a1a" : c.body);
    cells.forEach((cell, i) => {
      doc.text(String(cell), x + (i === 0 ? 10 : 0), y + 5, { width: widths[i] - (i === 0 ? 10 : 8), align: i === 0 ? "left" : "right" });
      x += widths[i];
    });
    // Thin row-divider — every row in the real Annexure A table is underlined, not just the
    // filled/highlighted subtotal rows.
    doc.moveTo(x0, y + rowH).lineTo(x0 + totalW, y + rowH).strokeColor("#dddddd").lineWidth(0.5).stroke();
    doc.y = y + rowH;
  });
}

/**
 * Body paragraph matching the real letter: justified, with a bold "Label:" lead-in when the
 * paragraph starts with one (e.g. "Confidentiality:", "Benefits:") — measured from how the real
 * PDF renders "Conditions of Offer" and the bulleted Compensation items.
 */
function paragraph(doc: any, text: string, opts: { x?: number; width?: number; color?: string; justify?: boolean } = {}) {
  // Only ever called for the offer letter — its default x is that document's own margin.
  const x = opts.x ?? OFFER_MARGIN;
  const width = opts.width ?? (doc.page.width - OFFER_MARGIN - x);
  const color = opts.color ?? OFFER_C.body;
  const align = opts.justify === false ? "left" : "justify";
  const m = text.match(/^([A-Z][A-Za-z0-9 ,'()/-]{2,70}:)\s*/);
  if (m) {
    doc.font("Body-Bold").fontSize(10).fillColor(color).text(m[1] + " ", x, doc.y, { continued: true, width, align, lineGap: 3 });
    doc.font("Body").fontSize(10).fillColor(color).text(text.slice(m[0].length), { width, align, lineGap: 3 });
  } else {
    doc.font("Body").fontSize(10).fillColor(color).text(text, x, doc.y, { width, align, lineGap: 3 });
  }
  doc.moveDown(0.8);
}

/**
 * Header repeated on EVERY page (confirmed against the real multi-page PDF, including the
 * Annexure pages): the full-width brand-red bar always; a small top-right logo on every page
 * (the big top-left logo + Date only appear on page 1, drawn separately by the caller).
 */
// Offer and Appointment letters use genuinely different red-bar geometry in their own real
// reference documents: the Appointment Letter's bar is full-bleed (edge to edge), the Offer
// Letter's is inset ~26pt from each side — measured directly from
// "0008. Offer Letter - Amardeep Pundhir.pdf" (rect x0=26.64 y0=0.84 x1=585.48 y1=7.68 on a
// 612pt-wide US Letter page). Defaults below (barInset 0, height 8, margin 50) are the
// Appointment Letter's existing, unchanged behavior; the offer letter passes OFFER_PAGE_OPTS.
function pageHeader(doc: any, isFirstPage: boolean, opts: { barInset?: number; barHeight?: number; margin?: number } = {}) {
  const barInset = opts.barInset ?? 0;
  const barHeight = opts.barHeight ?? 8;
  const margin = opts.margin ?? 50;
  doc.rect(barInset, barInset ? 1 : 0, doc.page.width - barInset * 2, barHeight).fill(BRAND_RED);
  // .fill() leaves the fill color set to BRAND_RED — if this runs mid-paragraph (PDFKit fires
  // "pageAdded" the instant a continued text() call overflows onto a new page), the rest of
  // that same text call would otherwise continue drawing in red. Always reset afterward.
  doc.fillColor("#000000");
  if (!isFirstPage && fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, doc.page.width - margin - 130, 30, { width: 130 }); } catch { /* ignore */ }
  }
}

// Offer Letter page geometry — re-measured via pdfplumber from "1071. Offer Letter -
// Jalaj Goyal.pdf", the letter this whole file's fonts/colors were originally measured from
// (see the file header comment) but whose PAGE geometry had drifted onto a different, Letter-
// sized reference ("0008. Offer Letter - Amardeep Pundhir.pdf") at some point — a real bug, not
// an intentional difference: "1071" is A4 (595.3×841.9pt), body margin 72pt (Position Details/
// "OFFER LETTER" title/table/logo all start at x=72), full-bleed red bar (not inset 26pt).
const OFFER_MARGIN = 72;
const OFFER_PAGE_OPTS = { barInset: 0, barHeight: 7.2, margin: OFFER_MARGIN };
// Plum/purple rule used under "OFFER LETTER"/"Position Details" and as the Annexure A table's
// row-divider lines — measured fill rgb(0.486, 0.341, 0.506) on the real reference PDF.
const OFFER_RULE_COLOR = "#7C5781";

// Appointment Letter page geometry — measured span-by-span from a real Word-rendered PDF of
// "Appointment Letter - GenAquarius.docx" (docx2pdf, then PyMuPDF): A4 (595.8×841.8pt), body
// text/heading/logo margin 71pt (min text x0≈70.9, max x1≈527-528 on the 595.8pt page — NOT the
// 50pt the code used to assume), full-bleed red bar (barInset 0), bar height ≈7.2pt.
const APPT_MARGIN = 71;
const APPT_PAGE_OPTS = { barInset: 0, barHeight: 7.2, margin: APPT_MARGIN };

// A clause's own numbered sub-points (rendered "1.1", "1.2", … under heading "1."), matching the
// real "Appointment Letter - GenAquarius.docx" — confirmed by rendering that docx to PDF via Word
// automation and reading the actual auto-numbering (invisible to plain python-docx text extraction).
// `unnumbered: true` is for the handful of clauses (Background Verification, IP, Non-Compete,
// Governing Law, Notice, Remote Work) that are a single flowing paragraph with no "X.1" in the
// original; `subpoints` is for the two clauses (Separation, Conflict of Interest) that have a
// further lettered a/b/c… list nested under one numbered point.
export interface AppointmentClausePoint {
  text: string;
  unnumbered?: boolean;
  subpoints?: string[];
}
export interface AppointmentClause {
  key: string;
  title: string;
  points: (string | AppointmentClausePoint)[];
  enabled: boolean;
  order: number;
}
export interface AppointmentPdfData extends SignatureFields {
  empNo: string;
  dynamicFields: Record<string, any>;
  clauses: AppointmentClause[];
}

export function renderAppointmentPdf(a: AppointmentPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: APPT_MARGIN, bufferPages: true });
  registerFonts(doc, "appointment");
  doc.pipe(out);
  const f = a.dynamicFields || {};
  const contentRight = doc.page.width - APPT_MARGIN;

  // Every page gets the red top bar; every page AFTER the first also gets the small top-right
  // logo — same as the offer letter, and matching the real "Appointment Letter - GenAquarius.docx"
  // (confirmed by rendering it via Word automation: red bar + logo repeat on every page).
  doc.on("pageAdded", () => pageHeader(doc, false, APPT_PAGE_OPTS));
  pageHeader(doc, true, APPT_PAGE_OPTS);
  // Logo geometry measured directly from the reference's page-1 image (x0≈72, y0≈48.6, width≈203).
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, APPT_MARGIN, 48, { width: 203 }); } catch { /* ignore */ } }
  doc.y = 92;

  doc.font("Body-Bold").fontSize(20).fillColor(APPT_C.title).text("Appointment Letter", APPT_MARGIN, doc.y, { continued: true });
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`   Date: ${dstr(f.DateOfAppointment)}`, { width: contentRight - APPT_MARGIN, align: "right" });
  // Plum underline below the title — measured y≈118.4 on the reference, same brand rule color
  // the Offer Letter uses under "OFFER LETTER"/"Position Details" (rgb 0.486,0.341,0.506). A
  // fixed pixel gap (not moveDown, which scales off whatever font size the continued Date text
  // left active) so the rule clears the title's descenders instead of striking through them.
  const ruleY = doc.y + 8;
  doc.moveTo(APPT_MARGIN, ruleY).lineTo(contentRight, ruleY).strokeColor(OFFER_RULE_COLOR).lineWidth(0.75).stroke();
  doc.y = ruleY + 20; // extra breathing room below the rule, per explicit user feedback

  doc.font("Body").fontSize(10).fillColor(APPT_C.greeting).text("Dear ", { continued: true });
  doc.font("Body-Bold").fillColor(APPT_C.greeting).text(`${f.EmployeeName || ""},`);
  doc.moveDown(0.6);
  doc.font("Body").fontSize(10).fillColor(APPT_C.body).text(
    `We are pleased to welcome you for the position of ${f.Designation || f.JobTitle || ""} at GenAquarius Private Limited. We believe your skills and experience will be a valuable addition to our team.`,
    { lineGap: 3 }
  );
  doc.moveDown(1);

  // Measured: "Position Details" is regular weight (not bold), 16.2pt in the reference.
  doc.font("Body").fontSize(16.2).fillColor(APPT_C.title).text("Position Details");
  doc.moveDown(0.4);
  // Tab-stop layout (label flush left, bold value at a shared x) — measured from the reference's
  // Position Details block (label x≈72, value x≈144, row height≈13.2), matching the same pattern
  // already used for the Offer Letter's own Position Details.
  const posValueX = APPT_MARGIN + 73, posRowH = 13.2;
  const posLine = (label: string, value: string) => {
    const y = doc.y;
    doc.font("Body").fontSize(10.8).fillColor(APPT_C.body).text(`${label}:`, APPT_MARGIN, y, { width: posValueX - APPT_MARGIN - 4 });
    doc.font("Body-Bold").fontSize(10.8).fillColor(APPT_C.body).text(value, posValueX, y, { width: contentRight - posValueX });
    doc.y = Math.max(doc.y, y + posRowH);
  };
  posLine("Job Title", f.JobTitle || f.Designation || "");
  posLine("Emp. Id", a.empNo);
  posLine("Start Date", dstr(f.JoiningDate));
  posLine("Location", f.WorkLocation || "");
  posLine("Reporting To", f.ReportingManager || "");
  posLine("Business", f.BusinessUnit || "");
  doc.moveDown(1);

  // A numbered line ("1.2", "a.") as two independent text() calls at the same y — the same
  // proven hanging-indent shape used for Annexure B's numbered document list (see comment there):
  // a continued chain here would inherit the narrow label width for the whole wrapped paragraph.
  const numberedLine = (label: string, text: string, x: number, labelW: number) => {
    const y = doc.y;
    doc.font("Body-Bold").fontSize(10).fillColor(APPT_C.body).text(label, x, y, { width: labelW, lineBreak: false });
    doc.font("Body").fontSize(10).fillColor(APPT_C.body).text(fillTemplate(text, f), x + labelW, y, { width: contentRight - (x + labelW), lineGap: 2 });
    doc.moveDown(0.35);
  };

  // The footer is stamped retroactively (via bufferedPageRange()/switchToPage(), AFTER all clause
  // content is drawn — necessary because clauses reflow across an unknown page count), so nothing
  // rendered here can be allowed to overlap where it will land. A fixed "doc.y > 700" check isn't
  // enough: it only looks at the cursor BEFORE a point renders, not how tall that point's actual
  // (possibly multi-line) text will be — a long paragraph starting at y=699 can still end well
  // past the footer. Measure the real height with heightOfString() and reserve exact room for it.
  const FOOTER_TOP = doc.page.height - 93.5 - 4; // matches appointmentFooter()'s divider y
  const ensureSpace = (h: number) => { if (doc.y + h > FOOTER_TOP) { doc.addPage(); doc.y = 100; } };

  const sorted = [...(a.clauses || [])].filter((c) => c.enabled !== false).sort((x, y) => x.order - y.order);
  sorted.forEach((c, ci) => {
    const headingText = `${ci + 1}. ${c.title.toUpperCase()}:`;
    // Reserves room for the heading AND its first point together, not just the heading — without
    // this, a heading that just barely fits at the bottom of a page prints there alone while its
    // first point (e.g. "8.1") gets pushed to the next page, leaving what looks like a blank gap
    // right under "8. CONFIDENTIALITY:" with the numbered text only resuming after the page break.
    const firstRaw = c.points?.[0];
    const firstText = firstRaw ? (typeof firstRaw === "string" ? firstRaw : firstRaw.text) : "";
    const firstFilled = firstText ? fillTemplate(firstText, f) : "";
    const firstPointH = firstFilled ? doc.heightOfString(firstFilled, { width: contentRight - (APPT_MARGIN + 34), lineGap: 2 }) : 0;
    ensureSpace(doc.heightOfString(headingText, { width: contentRight - APPT_MARGIN }) + firstPointH);
    // Explicit x=50 — otherwise this inherits doc.x from wherever the PREVIOUS clause's last
    // explicit-x text() call left the cursor (e.g. a lettered sub-point indented to x=74), since
    // a plain (non-continued) PDFKit text() call doesn't reset x back to the page margin itself.
    doc.font("Body-Bold").fontSize(12).fillColor(APPT_C.heading).text(headingText, APPT_MARGIN, doc.y, { width: contentRight - APPT_MARGIN });
    doc.moveDown(0.3);
    let n = 0;
    for (const raw of c.points || []) {
      const p: AppointmentClausePoint = typeof raw === "string" ? { text: raw } : raw;
      const filled = fillTemplate(p.text, f);
      if (p.unnumbered) {
        ensureSpace(doc.heightOfString(filled, { width: contentRight - APPT_MARGIN, lineGap: 2 }));
        doc.font("Body").fontSize(10).fillColor(APPT_C.body).text(filled, APPT_MARGIN, doc.y, { width: contentRight - APPT_MARGIN, lineGap: 2 });
        doc.moveDown(0.35);
      } else {
        n++;
        const labelW = 34;
        ensureSpace(doc.heightOfString(filled, { width: contentRight - (APPT_MARGIN + labelW), lineGap: 2 }));
        numberedLine(`${ci + 1}.${n}`, p.text, APPT_MARGIN, labelW);
      }
      if (p.subpoints?.length) {
        p.subpoints.forEach((sp, si) => {
          const subLabelW = 22, subX = APPT_MARGIN + 24;
          ensureSpace(doc.heightOfString(fillTemplate(sp, f), { width: contentRight - (subX + subLabelW), lineGap: 2 }));
          numberedLine(`${String.fromCharCode(97 + si)}.`, sp, subX, subLabelW);
        });
      }
    }
    doc.moveDown(0.5);
  });

  if (doc.y > 660) { doc.addPage(); doc.y = 100; }
  doc.moveDown();
  doc.font("Body").fontSize(10).fillColor(APPT_C.sign).text("Yours sincerely,");
  doc.moveDown(0.6);
  // Configured signature image if present (real signature measured ~55.6×12pt in the reference
  // as the original fallback), not a font approximation.
  drawSignatureImage(doc, a.signatureImageBase64, APPT_MARGIN + 1, doc.y, 56, 12);
  doc.moveDown(1.6);
  const sigY = doc.y + 6;
  const sigRightX = contentRight - 200;
  doc.font("Body-Bold").fontSize(10).fillColor(APPT_C.sign).text(a.signatoryName || "Vivek Kaw", APPT_MARGIN, sigY, { width: 200 });
  doc.font("Body-Italic").fontSize(10).fillColor(APPT_C.sign).text(`${a.signatoryTitle || "CHRO"} (Authorized Signatory)`, APPT_MARGIN, sigY + 13, { width: 200 });
  doc.font("Body-Bold").fontSize(10).fillColor(APPT_C.sign).text(String(f.EmployeeName || ""), sigRightX, sigY, { width: 200, align: "right" });
  doc.font("Body").fontSize(10).fillColor(APPT_C.sign).text("(Signature & Date)", sigRightX, sigY + 13, { width: 200, align: "right" });
  // Adobe Sign text-tag syntax — auto-detected on upload and converted into a real, clickable
  // signature field right at the employee's existing "(Signature & Date)" placeholder. Small/
  // muted since it's a machine-readable marker, not part of the letter's own visible copy.
  doc.font("Body").fontSize(8).fillColor("#999").text("{{Sig_es_:signer1:signature}}", sigRightX, sigY + 25, { width: 200, align: "right" });

  // Footer on every page — the clause content reflows across an unknown number of pages (unlike
  // the offer letter's fixed Letter/Annexure-A/Annexure-B sections), so it can't be drawn inline
  // at fixed content boundaries. bufferPages:true lets us go back and stamp it on each page here.
  const pageRange = doc.bufferedPageRange();
  for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
    doc.switchToPage(i);
    appointmentFooter(doc);
  }

  doc.end();
}

// ============================================================================================
// Service Agreement (CONTRACTOR) — a plain, black-and-white LEGAL document, visually nothing
// like the Offer/Appointment letters above (no red bar, no purple accents, no Barlow/Tahoma).
// Re-styled (by explicit request) to match the Offer Letter's own page geometry, fonts and
// colors exactly instead of the Service Agreement's original Times/Letter reference-document
// look: A4 page, OFFER_MARGIN, Barlow ("Body"/"Body-Bold"/"Body-Italic"), OFFER_C palette, the
// same red-bar pageHeader()/offerFooter() every Offer Letter page uses. Only the clause CONTENT
// and its lettered/bulleted/plain layout logic below are unchanged — SA_MARGIN/SA_RIGHT are held
// as fixed values (not doc.page.width-derived) since every Service Agreement is now always A4.
const SA_MARGIN = OFFER_MARGIN;
const SA_RIGHT = 595.28 - SA_MARGIN;

/** Split "plain **bold** plain" into [text,bold] segments — the only inline markup this
 * document's clause text needs (matches the real doc's bold-run spans exactly). */
function saSegments(text: string): [string, boolean][] {
  const out: [string, boolean][] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push([text.slice(last, m.index), false]);
    out.push([m[1], true]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push([text.slice(last), false]);
  if (!out.length) return [[text, false]];
  // PDFKit trims LEADING whitespace at the start of every text() call, including a fresh call in
  // a `continued` chain — so a space that belongs at a bold/plain boundary (e.g. "...**amount**
  // and will be paid...") silently vanishes ("...amount**and will be paid...") unless it's moved
  // onto the END of the previous segment instead, where PDFKit does NOT trim it.
  for (let i = 1; i < out.length; i++) {
    const wsm = /^(\s+)/.exec(out[i][0]);
    if (wsm) { out[i - 1][0] += wsm[1]; out[i][0] = out[i][0].slice(wsm[1].length); }
  }
  return out;
}

/** Render a (possibly **bold**-mixed) paragraph as a hanging-indent block: `text` starts at `x`
 * and wraps to `width`; every continuation line comes back to `x` (PDFKit's own wrap behavior for
 * a single text()/continued-chain call) — the same proven technique the offer letter's bullet()
 * and appointment letter's numberedLine() already use for their own hanging-indent lists. */
function saRich(doc: any, raw: string, x: number, width: number, align: "justify" | "left" | "center" = "justify") {
  const segs = saSegments(raw);
  segs.forEach(([t, bold], i) => {
    doc.font(bold ? "Body-Bold" : "Body").fontSize(10).fillColor(OFFER_C.body);
    if (i === 0) doc.text(t, x, doc.y, { continued: segs.length > 1, width, align, lineGap: 2 });
    else doc.text(t, { continued: i < segs.length - 1, width, align, lineGap: 2 });
  });
}

/** A marker (letter/roman numeral/bullet) + its paragraph, laid out as two independent text()
 * calls at the same y — marker gets a fixed narrow column, paragraph gets the rest, so wrapped
 * continuation lines land back at `textX` (a continued chain here would instead inherit the
 * marker's own narrow width for the whole wrapped paragraph — the same pitfall documented next to
 * numberedLine() in renderAppointmentPdf above). */
function saMarker(doc: any, marker: string, markerBold: boolean, text: string, markerX: number, markerW: number, textX: number, textWidth: number) {
  const y = doc.y;
  doc.font(markerBold ? "Body-Bold" : "Body").fontSize(10).fillColor(OFFER_C.body).text(marker, markerX, y, { width: markerW, lineBreak: false });
  doc.y = y;
  doc.x = textX;
  saRich(doc, text, textX, textWidth, "justify");
}

export interface ServiceAgreementPoint {
  text: string;
  align?: "left" | "center" | "justify";
  /** Renders the dynamicFields.Services numbered (1),2),3)…) list right after this point's text —
   * only ever set on Article 1(a)'s "…provide the following services: -" point. */
  servicesList?: boolean;
  /** Renders the Name/Account Number/Bank Name/IFSC/Branch Name label-value block right after
   * this point's text — only ever set on Article 3.I's "payout in the bank account" bullet. */
  bankBlock?: boolean;
}
export interface ServiceAgreementClause {
  key: string;
  /** e.g. "Article 1. Performance of Work" — bold, own line, no indent. Blank/omitted = this
   * clause is a continuation of the previous Article (used for Article 3's "II." section, which
   * shares "Article 3. Allowable Costs and Payment" with the clause before it — see romanHeading). */
  articleLabel?: string;
  /** e.g. "I. TERMS & CONDITION" — bold + underlined sub-heading rendered before this clause's own
   * points. This is how Article 3's two Roman-numeral sub-sections are represented: two separate
   * top-level clauses, the first with articleLabel "Article 3. Allowable Costs and Payment" and
   * romanHeading "I. TERMS & CONDITION", the second with a blank articleLabel (no repeated Article
   * heading) and romanHeading "II. SERVICE PROVIDER EXPENSES". */
  romanHeading?: string;
  pointStyle: "lettered" | "bulleted" | "plain";
  points: (string | ServiceAgreementPoint)[];
  enabled: boolean;
  order: number;
}
export interface ServiceAgreementPdfData extends SignatureFields {
  // EffectiveDate, ContractorName, AadharNumber, ContractorAddress, MonthlyCompensationAmount,
  // MonthlyCompensationWords, BankAccountNumber, BankName, BankIFSC, BankBranchName, Services (string[])
  dynamicFields: Record<string, any>;
  clauses: ServiceAgreementClause[];
}

// Every page's footer, then a fresh page with the standard Offer-Letter header — replaces every
// former bare `doc.addPage()` page-break call in this function so the Service Agreement gets the
// same per-page footer treatment as the Offer Letter, instead of no footer at all.
function saPageBreak(doc: any) {
  offerFooter(doc);
  doc.addPage();
  doc.y = 100;
}

export function renderServiceAgreementPdf(a: ServiceAgreementPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: SA_MARGIN, bufferPages: true });
  registerFonts(doc, "offer");
  doc.pipe(out);
  const f = a.dynamicFields || {};

  doc.on("pageAdded", () => pageHeader(doc, false, OFFER_PAGE_OPTS));
  pageHeader(doc, true, OFFER_PAGE_OPTS);
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, SA_MARGIN, 53, { width: 191 }); } catch { /* ignore */ } }
  doc.y = 141;

  doc.font("Body-Bold").fontSize(12).fillColor(OFFER_C.heading).text("Commercial Independent Service Agreement", SA_MARGIN, doc.y, { width: SA_RIGHT - SA_MARGIN, align: "center", underline: true });
  doc.moveDown(1.6);

  const services: string[] = Array.isArray(f.Services) && f.Services.length ? f.Services : ["Technical Analysis", "Data Analysis", "QA", "Professional Services"];

  const renderServicesList = () => {
    doc.moveDown(0.15);
    services.forEach((s, i) => {
      if (doc.y > 700) saPageBreak(doc);
      saMarker(doc, `${i + 1})`, false, s, SA_MARGIN + 70, 18, SA_MARGIN + 88, SA_RIGHT - (SA_MARGIN + 88));
      doc.moveDown(0.2);
    });
    doc.moveDown(0.25);
  };
  const renderBankBlock = () => {
    doc.moveDown(0.45);
    const labelX = SA_MARGIN + 90, valueX = SA_MARGIN + 216;
    const labelW = valueX - labelX - 6, valueW = SA_RIGHT - valueX;
    const rows: [string, any][] = [
      ["Name:", f.ContractorName], ["Account Number:", f.BankAccountNumber], ["Bank Name:", f.BankName],
      ["IFSC:", f.BankIFSC], ["Branch Name:", f.BankBranchName],
    ];
    doc.font("Body-Bold").fontSize(10);
    rows.forEach(([label, val]) => {
      const valueStr = String(val ?? "");
      // The old code always advanced by a fixed moveDown(0.35) regardless of how tall the label
      // or value actually rendered — a long Bank Name/Branch Name wraps to 2 lines, so the fixed
      // advance left the next row's label/value starting BEFORE that wrapped second line finished,
      // printing directly on top of it. Measuring both sides with heightOfString and advancing by
      // the taller of the two (plus a small gap) guarantees rows never overlap regardless of length.
      const rowH = Math.max(doc.heightOfString(label, { width: labelW }), doc.heightOfString(valueStr, { width: valueW }));
      if (doc.y + rowH > 700) saPageBreak(doc);
      const y = doc.y;
      doc.fillColor(OFFER_C.body).text(label, labelX, y, { width: labelW });
      doc.text(valueStr, valueX, y, { width: valueW });
      doc.y = y + rowH + 3;
    });
    doc.moveDown(0.25);
  };

  const sorted = [...(a.clauses || [])].filter((c) => c.enabled !== false).sort((x, y) => x.order - y.order);
  sorted.forEach((c) => {
    if (doc.y > 700) saPageBreak(doc);
    if (c.articleLabel) {
      doc.x = SA_MARGIN;
      doc.font("Body-Bold").fontSize(11).fillColor(OFFER_C.heading).text(c.articleLabel, SA_MARGIN, doc.y, { width: SA_RIGHT - SA_MARGIN });
      doc.moveDown(0.55);
    }
    if (c.romanHeading) {
      if (doc.y > 700) saPageBreak(doc);
      const m = /^([IVX]+)\.\s*(.*)$/.exec(c.romanHeading) || [null, "", c.romanHeading];
      const ry = doc.y;
      doc.font("Body-Bold").fontSize(10.5).fillColor(OFFER_C.heading).text(`${m[1]}.`, SA_MARGIN + 28, ry, { width: 26, lineBreak: false });
      doc.font("Body-Bold").fontSize(10.5).fillColor(OFFER_C.heading).text(m[2], SA_MARGIN + 54, ry, { width: SA_RIGHT - (SA_MARGIN + 54), underline: true });
      doc.moveDown(0.7);
    }
    // Base left indent for this clause's points: bulleted/roman-heading body text sits one level
    // in (matches "SERVICE PROVIDER EXPENSES" paragraph starting at the same x as its bullets
    // would), plain Article clauses (4-7) get a single ~18pt indent, opening (no article label,
    // no roman heading) paragraphs sit flush at the page margin — all measured from the real PDF.
    const plainX = c.romanHeading ? SA_MARGIN + 54 : c.articleLabel ? SA_MARGIN + 18 : SA_MARGIN;

    (c.points || []).forEach((raw, pIdx) => {
      const p: ServiceAgreementPoint = typeof raw === "string" ? { text: raw } : raw;
      if (doc.y > 700) saPageBreak(doc);
      const filled = fillTemplate(p.text, f);
      if (p.align === "center") {
        doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(filled, SA_MARGIN, doc.y, { width: SA_RIGHT - SA_MARGIN, align: "center" });
      } else if (c.pointStyle === "lettered") {
        saMarker(doc, `${String.fromCharCode(97 + pIdx)}.`, false, filled, SA_MARGIN + 54, 18, SA_MARGIN + 72, SA_RIGHT - (SA_MARGIN + 72));
      } else if (c.pointStyle === "bulleted") {
        saMarker(doc, "•", false, filled, SA_MARGIN + 72, 14, SA_MARGIN + 90, SA_RIGHT - (SA_MARGIN + 90));
      } else {
        doc.x = plainX;
        saRich(doc, filled, plainX, SA_RIGHT - plainX, "justify");
      }
      if (p.servicesList) renderServicesList();
      else if (p.bankBlock) renderBankBlock();
      else doc.moveDown(0.6);
    });
    doc.moveDown(0.5);
  });

  // Signature block — hardcoded structure (not clause-driven), same reasoning as the offer/
  // appointment letters' own signature blocks: it's a fixed two-column grid, not flowing prose.
  // Left column (GenAquarius) is pre-filled; right column (contractor) is left BLANK for physical
  // signing, per the real reference document exactly.
  if (doc.y > 560) saPageBreak(doc);
  doc.moveDown(0.5);
  doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text("For and on behalf of:", SA_MARGIN, doc.y);
  doc.moveDown(1.1);
  // rightX + colW previously came out to SA_MARGIN + 545 = 617pt, past both the A4 page's right
  // margin (SA_RIGHT ≈ 523pt) AND the page's own 595pt width — the contractor's signature column
  // (blank rule, "(Signature)" label, Name/Title/Date rows) was printing off the page. Both
  // columns now fit inside [SA_MARGIN, SA_RIGHT] with room to spare.
  const leftX = SA_MARGIN, rightX = SA_MARGIN + 235, colW = 210;
  const headingY = doc.y;
  doc.font("Body-Bold").fontSize(10).fillColor(OFFER_C.heading).text("GENAQUARIUS PRIVATE LIMITED", leftX, headingY, { width: colW });
  doc.font("Body-Bold").fontSize(10).text(String(f.ContractorName || ""), rightX, headingY, { width: colW });
  const sigName = a.signatoryName || "Vivek Kaw", sigTitle = a.signatoryTitle || "CHRO";
  if (!drawSignatureImage(doc, a.signatureImageBase64, leftX, headingY + 30, 90, 20)) doc.font("Body-Italic").fontSize(20).fillColor(OFFER_C.body).text(sigName, leftX, headingY + 42, { width: colW });
  const sigLabelY = headingY + 78;
  doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text("(Signature)", leftX, sigLabelY, { width: colW });
  doc.font("Body").fontSize(10).text("(Signature)", rightX, sigLabelY, { width: colW });
  // Adobe Sign text-tag syntax — auto-detected on upload and converted into a real, clickable
  // signature field at the contractor's existing blank signature column. Small/muted since it's
  // a machine-readable marker, not part of the agreement's own visible copy.
  doc.font("Body").fontSize(8).fillColor("#999").text("{{Sig_es_:signer1:signature}}", rightX, sigLabelY + 14, { width: colW });
  const blankRule = (x: number, y: number, w: number) => { doc.moveTo(x, y + 11).lineTo(x + w, y + 11).strokeColor(OFFER_C.body).lineWidth(0.7).stroke(); };
  const row = (label: string, value: string | null, y: number) => {
    doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(label, leftX, y, { continued: !!value, width: colW, lineBreak: false });
    if (value) doc.font("Body").text(" " + value, { lineBreak: false });
    const rlx = doc.font("Body").fontSize(10).widthOfString(label + " ");
    doc.text(label, rightX, y, { lineBreak: false });
    blankRule(rightX + rlx + 4, y, colW - rlx - 8);
  };
  row("Name:", sigName, sigLabelY + 46);
  row("Title:", sigTitle, sigLabelY + 74);
  row("Date:", dstr(f.EffectiveDate), sigLabelY + 102);

  offerFooter(doc);
  doc.end();
}

// Annual Performance Review (Appraisal Letter) — measured span-by-span from the real
// "0033. Annual Performance Review - Vaishali Lambat.pdf" via pdfplumber. Contrary to this
// function's first draft, it shares the APPOINTMENT Letter's page geometry, not the Offer
// Letter's: A4 (595.5×842pt, not US Letter), body margin ~71-72pt (not 93), full-bleed red bar
// (not inset), and Tahoma body text (not Barlow) — confirmed by sampling actual character
// fontnames at several y-positions ("DAAAAA+Tahoma-Bold"/"EAAAAA+Tahoma"). The one exception is
// the Annexure 1 table's own header row, which samples as "GAAAAA+Barlow-Bold" — apparently
// built with the same table component the Offer Letter's Annexure A uses — so it alone keeps
// the Offer Letter's purple header styling while the surrounding letter stays Tahoma/A4.
const APPR_MARGIN = APPT_MARGIN; // measured 70.85–72; reuses the Appointment Letter's own 71pt constant
const APPR_C = { heading: "#252525", body: "#000000", greeting: "#252525" };
export interface AppraisalPdfData extends SignatureFields {
  appraisalRef: string;
  date: Date | string;
  employeeName: string;
  empNo?: string | null;
  designation: string;
  effectiveDate: Date | string;
  templateBody: string;
  mode: "INDIA_COMPONENTS" | "CONTRACTOR" | "ANNUAL_OVERRIDE";
  currency: string;
  revisedMonthlyDisplay: string; // the letter body's headline figure, pre-formatted (Rs X/- per month, or $X/mo, or $X/yr)
  breakup?: { components: { name: string; part: string; pct: number; monthly: number; annual: number }[]; grossA: number; grossAAnnual: number; grossB: number; grossBAnnual: number; totalMonthly: number; totalAnnual: number };
  monthlyCompensation?: number;
  annualCostOverride?: number;
  // Optional second step of a staged raise — a full SECOND Annexure compensation block (its own
  // effective date + its own breakup table), not just a mention in the opening paragraph, so the
  // PDF actually documents both stages completely.
  secondEffectiveDate?: Date | string | null;
  secondRevisedMonthlyDisplay?: string;
  secondBreakup?: AppraisalPdfData["breakup"];
  secondMonthlyCompensation?: number;
  secondAnnualCostOverride?: number;
}

export function renderAppraisalPdf(o: AppraisalPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: APPR_MARGIN, bufferPages: true });
  registerFonts(doc, "appointment"); // Tahoma — measured, not Barlow
  if (fs.existsSync(path.join(FONT_DIR, "Barlow-Bold.ttf"))) doc.registerFont("TableHeadBold", path.join(FONT_DIR, "Barlow-Bold.ttf")); else doc.registerFont("TableHeadBold", "Helvetica-Bold");
  doc.pipe(out);
  const contentRight = doc.page.width - APPR_MARGIN;

  doc.on("pageAdded", () => pageHeader(doc, false, APPT_PAGE_OPTS));
  pageHeader(doc, true, APPT_PAGE_OPTS);
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, APPR_MARGIN, 53, { width: 191 }); } catch { /* ignore */ } }
  const refY = 115;
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Ref: ${o.appraisalRef}`, APPR_MARGIN, refY, { width: 260, continued: false });
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Date: ${dstr(o.date)}`, APPR_MARGIN, refY, { width: contentRight - APPR_MARGIN, align: "right" });
  doc.moveTo(APPR_MARGIN, refY + 21).lineTo(contentRight, refY + 21).strokeColor("#000000").lineWidth(0.6).stroke();
  doc.y = refY + 33;

  doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.heading).text("Annual Performance Review", APPR_MARGIN, doc.y, { width: contentRight - APPR_MARGIN, align: "center", underline: true });
  doc.moveDown(1.2);
  doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.heading).text(o.employeeName, APPR_MARGIN, doc.y);
  doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.heading).text(o.designation, APPR_MARGIN, doc.y);
  doc.moveDown(1);

  doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.greeting).text(`Dear ${firstName(o.employeeName)},`, APPR_MARGIN, doc.y);
  doc.moveDown(0.8);
  o.templateBody.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).forEach((p) => paragraph(doc, p, { x: APPR_MARGIN, width: contentRight - APPR_MARGIN, color: APPR_C.body, justify: false }));

  doc.moveDown(0.4);
  doc.font("Body").fontSize(11).fillColor(APPR_C.body).text("Sincerely,", APPR_MARGIN, doc.y);
  doc.moveDown(0.6);
  const sigName = o.signatoryName || "Vivek Kaw", sigTitle = o.signatoryTitle || "CHRO";
  if (drawSignatureImage(doc, o.signatureImageBase64, APPR_MARGIN, doc.y, 90, 20)) doc.moveDown(1.4);
  else doc.font("Times-Italic").fontSize(20).text(sigName, APPR_MARGIN, doc.y);
  doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.body).text(sigName, APPR_MARGIN, doc.y);
  doc.font("Body").fontSize(11).fillColor(APPR_C.body).text(sigTitle, APPR_MARGIN, doc.y);
  appointmentFooter(doc);

  // Annexure — Compensation Details. Measured exactly from the real reference's page 2: a bordered
  // 4-row/2-col key/value box (Name/Employee Id/Designation/Revised CTC), then — India Full-Time
  // only — the full salary-breakup table at x0≈71, columns [231.5, 98.25, 96]. A staged raise gets
  // ONE such block per step (its own effective date + its own breakup), not just a one-line mention
  // in the opening paragraph, so the PDF fully documents every stage.
  const renderCompAnnexure = (label: string, effectiveDate: Date | string, revisedDisplay: string, breakup: AppraisalPdfData["breakup"], monthlyComp?: number, annualOverride?: number) => {
    doc.addPage();
    doc.y = 96;
    doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.heading).text(label, APPR_MARGIN, doc.y, { underline: true });
    doc.moveDown(1.4);
    doc.font("Body-Bold").fontSize(11).fillColor(APPR_C.heading).text(`Compensation details as of ${dstr(effectiveDate)}`, APPR_MARGIN, doc.y);
    doc.moveDown(1);

    const kvLabelW = 121, kvRowH = 17.6, kvBoxW = contentRight - APPR_MARGIN;
    const kvRows: [string, string][] = [["Name", o.employeeName]];
    if (o.empNo) kvRows.push(["Employee Id. No.", o.empNo]);
    kvRows.push(["Designation", o.designation]);
    kvRows.push([o.mode === "ANNUAL_OVERRIDE" ? "Revised CTC/Annum" : "Revised CTC/Month", revisedDisplay]);
    const kvTop = doc.y;
    kvRows.forEach(([label2, value], i) => {
      const y = kvTop + i * kvRowH;
      doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(label2, APPR_MARGIN + 6, y + 4, { width: kvLabelW - 10 });
      doc.font("Body").fontSize(10).fillColor("#000000").text(value, APPR_MARGIN + kvLabelW + 6, y + 4, { width: kvBoxW - kvLabelW - 10 });
    });
    // Bordered box: outer rectangle, one vertical divider, a horizontal line under every row.
    const kvBottom = kvTop + kvRows.length * kvRowH;
    doc.rect(APPR_MARGIN, kvTop, kvBoxW, kvBottom - kvTop).strokeColor("#000000").lineWidth(0.6).stroke();
    doc.moveTo(APPR_MARGIN + kvLabelW, kvTop).lineTo(APPR_MARGIN + kvLabelW, kvBottom).strokeColor("#000000").lineWidth(0.6).stroke();
    for (let i = 1; i < kvRows.length; i++) { const y = kvTop + i * kvRowH; doc.moveTo(APPR_MARGIN, y).lineTo(APPR_MARGIN + kvBoxW, y).strokeColor("#000000").lineWidth(0.6).stroke(); }
    doc.y = kvBottom + 20;

    if (o.mode === "INDIA_COMPONENTS" && breakup) {
      // The real reference letter omits 0%-of-CTC components entirely (its bracket's "Vehicle
      // Maintenance Allowance"/"Driver Allowance" lines never appear at all, not even as a $0 row) —
      // matched exactly by filtering on pct here, same rule for both Part A and Part B.
      const partA = breakup.components.filter((c) => c.part === "A" && c.pct !== 0);
      const partB = breakup.components.filter((c) => c.part === "B" && c.pct !== 0);
      // Measured column boundaries: x0=70.85, 303.35, 401.6, 497.6 → widths 232.5/98.25/96.0.
      const w = [232.5, 98.25, 96];
      const rows = [
        ...partA.map((c) => [c.name, numOnly(c.monthly), numOnly(c.annual)]),
        ["Gross Salary (A)", numOnly(breakup.grossA), numOnly(breakup.grossAAnnual)],
        ...partB.map((c) => [c.name, numOnly(c.monthly), numOnly(c.annual)]),
        ["Gross Salary (Flexi) (B)", numOnly(breakup.grossB), numOnly(breakup.grossBAnnual)],
        ["Total Cost to Company (C) = A + B", numOnly(breakup.totalMonthly), numOnly(breakup.totalAnnual)],
      ];
      const highlight = new Set([partA.length, rows.length - 2, rows.length - 1]);
      // No "₹" — the embedded font has no rupee glyph and renders it as a mangled character; the
      // real reference letter spells "Rs" out in the body and just says "Monthly"/"Annual" here.
      appraisalTable(doc, ["Component", "Monthly (INR)", "Annual (INR)"], rows, w, highlight);
      doc.moveDown(1.4);
      doc.font("Body-Bold").fontSize(10).fillColor("#000000").text("Tax deduction at source", APPR_MARGIN, doc.y);
      doc.font("Body").fontSize(10).fillColor(APPR_C.body).text("Tax will be deducted at source as per the rules applicable.", APPR_MARGIN, doc.y, { width: contentRight - APPR_MARGIN });
    } else if (o.mode === "CONTRACTOR") {
      doc.font("Body").fontSize(10).fillColor(APPR_C.body).text("Flat monthly compensation — no salary-component breakdown applies to a Contractor engagement. TDS is deducted at the applicable rate.", APPR_MARGIN, doc.y, { width: contentRight - APPR_MARGIN });
    } else {
      doc.font("Body").fontSize(10).fillColor(APPR_C.body).text("Flat annual compensation — no India salary-component breakdown applies outside India.", APPR_MARGIN, doc.y, { width: contentRight - APPR_MARGIN });
    }
  };

  renderCompAnnexure("Annexure 1", o.effectiveDate, o.revisedMonthlyDisplay, o.breakup, o.monthlyCompensation, o.annualCostOverride);
  if (o.secondEffectiveDate) {
    renderCompAnnexure("Annexure 2 — Second Step", o.secondEffectiveDate, o.secondRevisedMonthlyDisplay || "", o.secondBreakup, o.secondMonthlyCompensation, o.secondAnnualCostOverride);
  }

  doc.moveDown(2.2);
  // "Limiter" (not "Limited") reproduces the real reference letter's own typo exactly.
  doc.font("Body").fontSize(10).fillColor("#000000").text("For GenAquarius Private Limiter", APPR_MARGIN, doc.y);
  doc.moveDown(2.8);
  if (drawSignatureImage(doc, o.signatureImageBase64, APPR_MARGIN, doc.y, 90, 20)) doc.moveDown(1.4);
  else doc.font("Times-Italic").fontSize(20).text(sigName, APPR_MARGIN, doc.y);
  doc.font("Body-Bold").fontSize(11).fillColor("#000000").text(sigName, APPR_MARGIN, doc.y);
  doc.font("Body").fontSize(11).fillColor("#000000").text(sigTitle, APPR_MARGIN, doc.y);
  appointmentFooter(doc);

  doc.end();
}

// Annexure 1's own table — measured x0/widths/row-height from the real reference PDF (own
// geometry, distinct from the Offer Letter's Annexure A: x0≈71 not 93, rowH≈16.75 not 15.5).
// Header row samples as Barlow-Bold (registered as "TableHeadBold" above) even though the rest
// of this letter is Tahoma — apparently built with the same table component as the Offer Letter.
function appraisalTable(doc: any, headers: string[], rows: (string | number)[][], widths: number[], highlightRows: Set<number>) {
  const x0 = APPR_MARGIN, rowH = 16.75, headerH = 16;
  const totalW = widths.reduce((a, b) => a + b, 0);
  doc.rect(x0, doc.y, totalW, headerH).fill(TABLE_HEADER_BG);
  let hx = x0;
  const hy = doc.y + 4.5;
  doc.font("TableHeadBold").fontSize(9.5).fillColor("#ffffff");
  headers.forEach((h, i) => { doc.text(h, hx + (i === 0 ? 10 : 0), hy, { width: widths[i] - (i === 0 ? 10 : 8), align: i === 0 ? "left" : "right" }); hx += widths[i]; });
  doc.y += headerH;
  rows.forEach((cells, ri) => {
    if (doc.y > 780) { doc.addPage(); doc.y = 96; }
    const y = doc.y;
    const bold = highlightRows.has(ri);
    if (bold) doc.rect(x0, y, totalW, rowH).fill(TABLE_HIGHLIGHT_BG);
    let x = x0;
    doc.font(bold ? "Body-Bold" : "Body").fontSize(9.5).fillColor(bold ? "#1a1a1a" : "#000000");
    cells.forEach((cell, i) => { doc.text(String(cell), x + (i === 0 ? 10 : 0), y + 4.5, { width: widths[i] - (i === 0 ? 10 : 8), align: i === 0 ? "left" : "right" }); x += widths[i]; });
    doc.y = y + rowH;
  });
}

/** Collect a PDF stream into a Buffer (for emailing) — same pattern as invoicePdf's helper. */
// ---- Full & Final Settlement Statement — internal Finance document, no reference source PDF to
// match, so laid out plainly (Tahoma, same margin/footer as the Appointment Letter) rather than
// measured pixel-for-pixel. Always rendered live from the TerminationApprovalRequest row (see
// routes/terminationApprovals.ts / masters.ts) — no PDF binary is stored anywhere, same
// "regenerate on download" convention as the Offer/Appointment letters.
export interface FnfLineItem { label: string; amount: number; }
export interface FnfPdfData extends SignatureFields {
  employeeName: string;
  empNo?: string | null;
  designation?: string | null;
  department?: string | null;
  empType: string; // "FULL_TIME" | contractor type
  joiningDate?: Date | string | null;
  resignationDate?: Date | string | null;
  deploymentEndDate?: Date | string | null;
  exitDate: Date | string;
  fnfFinalizationDate?: Date | string | null;
  requiredNoticeDays?: number | null;
  servedNoticeDays?: number | null;
  // Days actually worked in the termination month (joining-date-aware — see computeFnfSuggestion's
  // own daysWorkedInMonth) — shown as the reference FnF Settlement template's own "No. of Days
  // Worked: N days (Mon'YY)" row. Null/undefined (e.g. a contractor, priced off billing instead)
  // just omits that row.
  daysWorkedInMonth?: number | null;
  // What actually prints for "Last Day of Working" — defaults to exitDate when omitted (every
  // caller before this field existed). See buildFnfPdfData's own comment for the fnfPrintDate/
  // Deployment-End-Date priority this is computed from.
  lastWorkingDate?: Date | string | null;
  // Contractor-only, purely informational — prints a "Leaves" row when set; no amount attached.
  leavesCount?: number | null;
  phone?: string | null; // PERSONAL number — never officialPhone
  currency: string;
  lineItems: FnfLineItem[]; // Earned
  deductionItems?: FnfLineItem[];
  grossEarned?: number;
  grossDeduction?: number;
  totalAmount: number; // net payable (grossEarned - grossDeduction)
  note?: string | null;
  reviewedByName?: string | null;
  generatedAt: Date | string;
}

// Uses the OFFER LETTER's own look — Barlow font, black (not red) headings, offer margin/footer —
// per explicit request that the FnF Settlement match the Offer Letter's exact style, not the
// Appointment Letter's (which is red-headed Tahoma). Only the page-header red bar + logo geometry
// is genuinely shared between every HR document regardless of kind (see pageHeader itself).
export function renderFnfPdf(f: FnfPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: OFFER_MARGIN, bufferPages: true });
  registerFonts(doc, "offer");
  doc.pipe(out);
  const contentRight = doc.page.width - OFFER_MARGIN;

  doc.on("pageAdded", () => pageHeader(doc, false, OFFER_PAGE_OPTS));
  pageHeader(doc, true, OFFER_PAGE_OPTS);
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, OFFER_MARGIN, 53, { width: 191 }); } catch { /* ignore */ } }
  const refY = 115;
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Ref: FNF-${f.empNo || ""}`, OFFER_MARGIN, refY);
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Date: ${dstr(f.generatedAt)}`, OFFER_MARGIN, refY, { width: contentRight - OFFER_MARGIN, align: "right" });
  doc.moveTo(OFFER_MARGIN, refY + 21).lineTo(contentRight, refY + 21).strokeColor("#000000").lineWidth(0.6).stroke();
  doc.y = refY + 33;

  doc.font("Body-Bold").fontSize(13).fillColor(OFFER_C.title).text("Full & Final Settlement Statement", OFFER_MARGIN, doc.y, { width: contentRight - OFFER_MARGIN, align: "center", underline: true });
  doc.moveDown(1.2);

  doc.font("Body-Bold").fontSize(11).fillColor(OFFER_C.heading).text("Employee Details", OFFER_MARGIN, doc.y);
  doc.moveDown(0.4);

  // Employee details — bordered key/value box, same construction as the Appraisal letter's
  // Annexure 1 compensation box. Field set and order match the reference FnF Settlement template
  // exactly (Name/Code/Department/Designation/Joining/Last Day/Days Worked) — no extra fields
  // (Engagement Type, Resignation/Deployment End/FNF Finalization dates, Notice Period) beyond it.
  const kvLabelW = 150, kvRowH = 17.6, kvBoxW = contentRight - OFFER_MARGIN;
  const kvRows: [string, string][] = [["Name of Employee", f.employeeName]];
  if (f.empNo) kvRows.push(["Employee Code", f.empNo]);
  if (f.department) kvRows.push(["Department", f.department]);
  if (f.designation) kvRows.push(["Designation", f.designation]);
  if (f.phone) kvRows.push(["Phone", f.phone]);
  if (f.joiningDate) kvRows.push(["Date of Joining", dstr(f.joiningDate)]);
  // Defaults to the Termination Date itself (every caller before f.lastWorkingDate existed) —
  // buildFnfPdfData now computes this with the fnfPrintDate/Deployment-End-Date priority described
  // on its own comment, so a contractor's genuine last BILLABLE day can print here instead.
  const lastWorkingDate = f.lastWorkingDate || f.exitDate;
  kvRows.push(["Last Day of Working", dstr(lastWorkingDate)]);
  if (f.daysWorkedInMonth != null) {
    const ed = new Date(lastWorkingDate);
    kvRows.push(["No. of Days Worked", `${f.daysWorkedInMonth} day${f.daysWorkedInMonth === 1 ? "" : "s"} (${MON[ed.getMonth()]}'${String(ed.getFullYear()).slice(-2)})`]);
  }
  if (f.leavesCount) kvRows.push(["Leaves", String(f.leavesCount)]);

  const kvTop = doc.y;
  kvRows.forEach(([label, value], i) => {
    const y = kvTop + i * kvRowH;
    doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(label, OFFER_MARGIN + 6, y + 4, { width: kvLabelW - 10 });
    doc.font("Body").fontSize(10).fillColor("#000000").text(value, OFFER_MARGIN + kvLabelW + 6, y + 4, { width: kvBoxW - kvLabelW - 10 });
  });
  const kvBottom = kvTop + kvRows.length * kvRowH;
  doc.rect(OFFER_MARGIN, kvTop, kvBoxW, kvBottom - kvTop).strokeColor("#000000").lineWidth(0.6).stroke();
  doc.moveTo(OFFER_MARGIN + kvLabelW, kvTop).lineTo(OFFER_MARGIN + kvLabelW, kvBottom).strokeColor("#000000").lineWidth(0.6).stroke();
  for (let i = 1; i < kvRows.length; i++) { const y = kvTop + i * kvRowH; doc.moveTo(OFFER_MARGIN, y).lineTo(OFFER_MARGIN + kvBoxW, y).strokeColor("#000000").lineWidth(0.6).stroke(); }
  doc.y = kvBottom + 24;

  // Earned/Deductions grid — matches the reference FnF Settlement template's layout (Gross Total
  // Income, Gross Total Deduction, Grand Total net payable) rather than one flat summed list. Row
  // and subtotal amounts are bare numbers (no repeated currency prefix per cell) since the table's
  // own header already names the currency — same convention as the reference document; only the
  // final Grand Total line is prefixed ("INR 2,96,907"), matching it exactly.
  doc.font("Body-Bold").fontSize(11).fillColor(OFFER_C.heading).text("Payment for the Month", OFFER_MARGIN, doc.y);
  doc.moveDown(0.6);
  const grossEarned = f.grossEarned ?? f.totalAmount;
  const earnedRows = f.lineItems.map((li) => [li.label, numOnly(li.amount)]);
  earnedRows.push(["Gross Total Income", numOnly(grossEarned)]);
  fnfTable(doc, ["Earned", `Amount (${f.currency})`], earnedRows, [kvBoxW - 150, 150], new Set([earnedRows.length - 1]));
  doc.y += 16;

  const hasDeductions = !!f.deductionItems?.length;
  if (hasDeductions) {
    doc.font("Body-Bold").fontSize(11).fillColor(OFFER_C.heading).text("Less: Deductions", OFFER_MARGIN, doc.y);
    doc.moveDown(0.6);
    const grossDeduction = f.grossDeduction ?? 0;
    const dedRows = (f.deductionItems || []).map((li) => [li.label, numOnly(li.amount)]);
    dedRows.push(["Gross Total Deduction", numOnly(grossDeduction)]);
    fnfTable(doc, ["Deductions", `Amount (${f.currency})`], dedRows, [kvBoxW - 150, 150], new Set([dedRows.length - 1]));
    doc.y += 16;
  }

  const grandTotalY = doc.y;
  doc.rect(OFFER_MARGIN, grandTotalY, kvBoxW, 22).fill(TABLE_HIGHLIGHT_BG);
  doc.font("Body-Bold").fontSize(11).fillColor("#1a1a1a").text("Grand Total (Net Payable)", OFFER_MARGIN + 10, grandTotalY + 5, { width: kvBoxW - 170, lineBreak: false });
  doc.font("Body-Bold").fontSize(11).fillColor("#1a1a1a").text(money(f.totalAmount, f.currency), OFFER_MARGIN, grandTotalY + 5, { width: kvBoxW - 10, align: "right", lineBreak: false });
  doc.y = grandTotalY + 30;

  // Payment sentence — matches the reference FnF Settlement template's own wording exactly (amount
  // in words, Indian numbering system, NEFT, acceptance acknowledged via email).
  if (f.currency === "INR") {
    const words = amountInWordsInr(f.totalAmount);
    paragraph(doc, `Payment of INR ${numOnly(f.totalAmount)} (${words} Only) is being electronically transferred through NEFT, in acknowledgment of employee's acceptance communicated via email.`,
      { x: OFFER_MARGIN, width: contentRight - OFFER_MARGIN, color: OFFER_C.body, justify: false });
    doc.moveDown(0.8);
  }

  if (f.note) {
    doc.font("Body-Bold").fontSize(10).fillColor("#000000").text("Remarks", OFFER_MARGIN, doc.y);
    doc.moveDown(0.3);
    paragraph(doc, f.note, { x: OFFER_MARGIN, width: contentRight - OFFER_MARGIN, color: OFFER_C.body, justify: false });
    doc.moveDown(0.6);
  }

  // Signer — name + title, matching the reference template's own sign-off block.
  if (f.signatoryName) {
    doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(f.signatoryName, OFFER_MARGIN, doc.y);
    if (f.signatoryTitle) doc.font("Body").fontSize(10).fillColor("#000000").text(f.signatoryTitle, OFFER_MARGIN, doc.y);
    doc.moveDown(0.6);
  }

  doc.font("Body").fontSize(9).fillColor("#666666").text(`Generated on ${dstr(f.generatedAt)}${f.reviewedByName ? ` · Approved by ${f.reviewedByName}` : ""}`, OFFER_MARGIN, doc.y);
  offerFooter(doc);
  doc.end();
}

function fnfTable(doc: any, headers: string[], rows: (string | number)[][], widths: number[], highlightRows: Set<number>) {
  const x0 = OFFER_MARGIN, rowH = 18, headerH = 18;
  const totalW = widths.reduce((a, b) => a + b, 0);
  doc.rect(x0, doc.y, totalW, headerH).fill(TABLE_HEADER_BG);
  let hx = x0;
  const hy = doc.y + 5;
  doc.font("Body-Bold").fontSize(9.5).fillColor("#ffffff");
  headers.forEach((h, i) => { doc.text(h, hx + (i === 0 ? 10 : 0), hy, { width: widths[i] - (i === 0 ? 10 : 8), align: i === 0 ? "left" : "right" }); hx += widths[i]; });
  doc.y += headerH;
  rows.forEach((cells, ri) => {
    if (doc.y > 780) { doc.addPage(); doc.y = 96; }
    const y = doc.y;
    const bold = highlightRows.has(ri);
    if (bold) doc.rect(x0, y, totalW, rowH).fill(TABLE_HIGHLIGHT_BG);
    let x = x0;
    doc.font(bold ? "Body-Bold" : "Body").fontSize(9.5).fillColor(bold ? "#1a1a1a" : "#000000");
    cells.forEach((cell, i) => { doc.text(String(cell), x + (i === 0 ? 10 : 0), y + 4.5, { width: widths[i] - (i === 0 ? 10 : 8), align: i === 0 ? "left" : "right" }); x += widths[i]; });
    doc.y = y + rowH;
  });
}

// ---------------------------------------------------------------------------
// MSA / SOW (US/Canada Vendor & Contractor engagements) — plain legal-document layout (Times
// Roman, numbered sections, signature block), not the branded Offer/Appointment stationery above.
// bodyText is MsaTemplate/SowTemplate's own {{placeholder}}-filled text (engine/hr.ts's
// fillTemplate), already resolved by the caller — this function only lays it out across pages.
// ---------------------------------------------------------------------------
export interface MsaSowPdfData {
  title: string; // "MASTER SERVICES AGREEMENT" | "STATEMENT OF WORK"
  entityName: string; // "GenAquarius LLC" | "Aquarius Technologies Limited"
  bodyText: string; // blank-line-separated paragraphs, placeholders already filled
  entitySignerName?: string | null;
  entitySignerTitle?: string | null;
  counterpartyName: string; // vendor/consultant-side signature block label
  signatureImageBase64?: string | null;
}

const MSA_MARGIN = 56;

export function renderMsaSowPdf(o: MsaSowPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: MSA_MARGIN, bufferPages: true });
  doc.pipe(out);
  const contentRight = doc.page.width - MSA_MARGIN;

  doc.font("Times-Bold").fontSize(13).text(o.entityName, MSA_MARGIN, doc.y, { width: contentRight - MSA_MARGIN, align: "center" });
  doc.moveDown(0.2);
  doc.font("Times-Bold").fontSize(13).text(o.title, { align: "center" });
  doc.moveDown(1.2);

  // Paragraphs: a line starting with a short ALL-CAPS/numbered heading (e.g. "1 TERM OF CONTRACT",
  // "1.1 Term:") is bolded; everything else renders as justified body text — same convention the
  // real signed samples use (numbered section headers, bold defined terms inline).
  const paragraphs = (o.bodyText || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const isHeading = /^\d+(\.\d+)*\s+[A-Z]/.test(para) && para.length < 90 && para === para.replace(/[a-z]/g, (c) => c);
    doc.font(isHeading ? "Times-Bold" : "Times-Roman").fontSize(10.5).fillColor("#000000")
      .text(para, { align: isHeading ? "left" : "justify", lineGap: 2 });
    doc.moveDown(0.7);
  }

  // Signature block — two side-by-side columns, same shape as the real signed MSA/SOW samples.
  if (doc.y > doc.page.height - 220) doc.addPage();
  doc.moveDown(0.8);
  const colW = (contentRight - MSA_MARGIN) / 2 - 10;
  const leftX = MSA_MARGIN, rightX = MSA_MARGIN + colW + 20;
  const topY = doc.y;
  doc.font("Times-Bold").fontSize(10.5).text(o.entityName, leftX, topY, { width: colW });
  doc.font("Times-Bold").fontSize(10.5).text(o.counterpartyName, rightX, topY, { width: colW });
  let sigY = doc.y + 10;
  if (drawSignatureImage(doc, o.signatureImageBase64, leftX, sigY, 90, 26)) { /* drawn */ } else {
    doc.font("Times-Roman").fontSize(10.5).text("_____________________", leftX, sigY, { width: colW });
  }
  doc.font("Times-Roman").fontSize(10.5).text("_____________________", rightX, sigY, { width: colW });
  const afterSigY = sigY + 34;
  doc.font("Times-Roman").fontSize(9.5)
    .text(`Name: ${o.entitySignerName || "________________"}`, leftX, afterSigY, { width: colW })
    .text(`Title: ${o.entitySignerTitle || "________________"}`, leftX, doc.y + 2, { width: colW })
    .text(`Date: ________________`, leftX, doc.y + 2, { width: colW });
  doc.font("Times-Roman").fontSize(9.5)
    .text(`Name: ________________`, rightX, afterSigY, { width: colW })
    .text(`Title: ________________`, rightX, doc.y + 2, { width: colW })
    .text(`Date: ________________`, rightX, doc.y + 2, { width: colW });

  doc.end();
}

// ---- Relieving & Experience Certificate — matches the real reference letter: Offer Letter's own
// look (Barlow, black headings, OFFER margin/footer), a plain "To, / Name / Emp Id / Designation /
// Subject:" block (not a centered title like the Appraisal letter), then flowing body paragraphs,
// single page, no Annexure. ----
export interface RelievingLetterPdfData extends SignatureFields {
  subject: string;
  date: Date | string;
  employeeName: string;
  empNo?: string | null;
  designation?: string | null;
  phone?: string | null; // PERSONAL number — never officialPhone
  templateBody: string;
}
export function renderRelievingLetterPdf(o: RelievingLetterPdfData, out: Writable) {
  const doc = new PDFDocument({ size: "A4", margin: OFFER_MARGIN, bufferPages: true });
  registerFonts(doc, "offer");
  doc.pipe(out);
  const contentRight = doc.page.width - OFFER_MARGIN;

  doc.on("pageAdded", () => pageHeader(doc, false, OFFER_PAGE_OPTS));
  pageHeader(doc, true, OFFER_PAGE_OPTS);
  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, OFFER_MARGIN, 53, { width: 191 }); } catch { /* ignore */ } }
  const refY = 115;
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Date: ${dstr(o.date)}`, OFFER_MARGIN, refY, { width: contentRight - OFFER_MARGIN, align: "right" });
  doc.moveTo(OFFER_MARGIN, refY + 21).lineTo(contentRight, refY + 21).strokeColor("#000000").lineWidth(0.6).stroke();
  doc.y = refY + 33;

  doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text("To,", OFFER_MARGIN, doc.y);
  doc.moveDown(0.8);
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`${o.employeeName},`, OFFER_MARGIN, doc.y);
  if (o.empNo) doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(`Emp. Id: ${o.empNo}`, OFFER_MARGIN, doc.y);
  if (o.designation) doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(`Designation: ${o.designation}`, OFFER_MARGIN, doc.y);
  if (o.phone) doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(`Phone: ${o.phone}`, OFFER_MARGIN, doc.y);
  doc.moveDown(1);

  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(`Subject: ${o.subject}`, OFFER_MARGIN, doc.y, { width: contentRight - OFFER_MARGIN });
  doc.moveDown(1);

  o.templateBody.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).forEach((p) => paragraph(doc, p, { x: OFFER_MARGIN, width: contentRight - OFFER_MARGIN, color: OFFER_C.body, justify: false }));

  doc.moveDown(1.2);
  doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text("Sincerely,", OFFER_MARGIN, doc.y);
  doc.moveDown(0.6);
  const sigName = o.signatoryName || "Vivek Kaw", sigTitle = o.signatoryTitle || "CHRO";
  if (drawSignatureImage(doc, o.signatureImageBase64, OFFER_MARGIN, doc.y, 90, 20)) doc.moveDown(1.4);
  else doc.font("Times-Italic").fontSize(20).text(sigName, OFFER_MARGIN, doc.y);
  doc.font("Body-Bold").fontSize(10).fillColor("#000000").text(sigName, OFFER_MARGIN, doc.y);
  doc.font("Body").fontSize(10).fillColor(OFFER_C.body).text(sigTitle, OFFER_MARGIN, doc.y);
  appointmentFooter(doc);

  doc.end();
}

export function renderToBuffer(render: (out: Writable) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    sink.on("finish", () => resolve(Buffer.concat(chunks)));
    sink.on("error", reject);
    try { render(sink); } catch (e) { reject(e); }
  });
}
