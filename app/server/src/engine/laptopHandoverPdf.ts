// Laptop Handover — a real, signable PDF (not just an HTML email) so IT can capture the
// employee's actual signature acknowledging receipt of their assigned assets, same "generate a
// document → send for e-signature → capture the signed copy" pattern as Offer/Appointment
// Letter/Service Agreement (see engine/adobeSign.ts + routes/shared/adobeSign.ts, both fully
// generic on docType — "LAPTOP_HANDOVER" rides the exact same EsignAgreement/webhook/Attachment
// machinery with zero changes needed there). Kept as its own file, not added to engine/hrPdf.ts,
// so it never collides with that file's own concurrent edits.
import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { renderToBuffer } from "./hrPdf";
import { fmtDate } from "./dateFormat";

const LOGO_PATH = path.resolve(__dirname, "../../assets/genaquarius.png");

export type LaptopHandoverAsset = { category: string; name: string; make: string | null; model: string | null; serialNo: string | null };
export type LaptopHandoverFields = {
  employeeName: string; empNo: string; department: string; designation: string;
  location: string; building: string; mobileNo: string; email: string; assets: LaptopHandoverAsset[];
};

export function renderLaptopHandoverPdf(f: LaptopHandoverFields): Promise<Buffer> {
  return renderToBuffer((out) => {
    const margin = 56;
    const doc = new PDFDocument({ size: "A4", margin, bufferPages: true });
    doc.pipe(out);
    const contentRight = doc.page.width - margin;

    // Simple header — logo top-left, same "simple font, header, logo" style as the Offer Letter,
    // per the user's explicit instruction to match that template's look.
    if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, margin, 40, { width: 160 }); } catch { /* ignore */ } }
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(`Date: ${fmtDate(new Date())}`, margin, 44, { width: contentRight - margin, align: "right" });
    doc.y = 110;
    doc.moveTo(margin, doc.y).lineTo(contentRight, doc.y).strokeColor("#c62828").lineWidth(1.8).stroke();
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text("Laptop & Accessories Handover", margin, doc.y);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(10).fillColor("#333").text(
      `This document confirms the issuance of the laptop and accessories listed below to the employee named, for official use during their tenure at GenAquarius. Please review the details and sign below to acknowledge receipt.`,
      { align: "left", lineGap: 3 }
    );
    doc.moveDown(1);

    const labelX = margin, valueX = 190, rowH = 18;
    const row = (label: string, value: string) => {
      const y = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor("#333").text(`${label}:`, labelX, y, { width: valueX - labelX - 8 });
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(value || "—", valueX, y, { width: contentRight - valueX });
      doc.y = Math.max(y + rowH, doc.y);
    };
    row("Employee Name", f.employeeName);
    row("Employee No.", f.empNo);
    row("Department", f.department);
    row("Designation", f.designation);
    row("Location", f.location);
    row("Building", f.building);
    row("Mobile No.", f.mobileNo);
    row("Email ID", f.email);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Assigned Assets");
    doc.moveDown(0.4);
    if (!f.assets.length) {
      doc.font("Helvetica").fontSize(10).fillColor("#666").text("No assets currently assigned.");
    } else {
      const colX = [margin, margin + 140, margin + 340];
      const headerY = doc.y;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#fff");
      doc.rect(margin, headerY, contentRight - margin, 20).fill("#c62828");
      doc.fillColor("#fff").text("Category", colX[0] + 6, headerY + 5).text("Make / Model", colX[1] + 6, headerY + 5).text("Serial No.", colX[2] + 6, headerY + 5);
      doc.y = headerY + 20;
      doc.font("Helvetica").fontSize(9.5).fillColor("#222");
      for (const a of f.assets) {
        const y = doc.y;
        doc.text(a.category, colX[0] + 6, y + 5, { width: colX[1] - colX[0] - 10 });
        doc.text([a.make, a.model].filter(Boolean).join(" / ") || a.name, colX[1] + 6, y + 5, { width: colX[2] - colX[1] - 10 });
        doc.text(a.serialNo || "—", colX[2] + 6, y + 5, { width: contentRight - colX[2] - 10 });
        doc.moveTo(margin, y + 22).lineTo(contentRight, y + 22).strokeColor("#ddd").lineWidth(0.5).stroke();
        doc.y = y + 24;
      }
    }
    doc.moveDown(1.5);

    doc.font("Helvetica").fontSize(9).fillColor("#555").text(
      "By signing below, I acknowledge receipt of the above asset(s) in good working condition. I agree to use them responsibly for official purposes and to return them to GenAquarius upon separation or when requested by IT Admin.",
      { align: "left", lineGap: 3 }
    );
    doc.moveDown(2);
    doc.font("Helvetica").fontSize(10).fillColor("#333").text("Employee Signature:");
    doc.moveDown(0.3);
    // Adobe Sign's text-tag syntax — auto-detected on upload and converted into a real signature
    // field at this exact spot (same mechanism engine/adobeSign.ts's renderTestPdf relies on).
    doc.font("Helvetica").fontSize(9).fillColor("#999").text("{{Sig_es_:signer1:signature}}");
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(9).fillColor("#333").text(`Name: ${f.employeeName}    Employee No.: ${f.empNo}    Date: {{Dte_es_:signer1:date}}`);

    doc.end();
  });
}
