// Ready-made Timesheet Templates matching the real client timesheet formats inspected this
// session (Downloads/Updated Template + Downloads/Template/Template). CXC, Kira, Cozzinibros,
// Cyncly, Northpoint Consulting and "Default Template.xlsx" all turned out to be the SAME
// underlying layout — GenAquarius's own "Work Order Monthly Timesheet Report" — so they share one
// template (GENAQUARIUS_STANDARD, marked isDefault) rather than five near-duplicate rows. Station
// Casino, Clarien Bank, WEnergy and Symsoft are genuinely distinct client-imposed formats and each
// get their own. This models each format's field LABELS/structure within the existing template
// config engine (used for the Library preview and for relabeling the live entry grid) — it is NOT
// a pixel-identical file export; an exact-file-export-per-format feature is a separate, larger
// follow-up the user explicitly deferred past tonight's deploy.
// Bastian gets no template here — it's an image-only PDF with no extractable structure to model
// (see importTimesheet.ts's own comment), so it stays manual-entry against the generic default.
// Idempotent (skips by name if already present) — safe to re-run, never clobbers a Finance edit.
import { prisma } from "../prisma";
import { TemplateConfig } from "../engine/timesheetTemplate";
import { TemplateBlock } from "../engine/templateDocumentEngine";

const APPROVAL_FIELDS = [
  { id: "employeeApproval", label: "Employee Approval", type: "APPROVAL" as const, order: 1, width: 4 },
  { id: "pmApproval", label: "PM Approval", type: "APPROVAL" as const, order: 2, width: 4 },
  { id: "financeApproval", label: "Finance Approval", type: "APPROVAL" as const, order: 3, width: 4 },
];

const STATION_CASINO: TemplateConfig = {
  header: { title: "Station Casino Timesheet", showLogo: true, companyName: "GenAquarius" },
  footer: { text: "", showSignatures: true },
  sections: [
    { id: "employee", title: "Employee Details", order: 1, fields: [
      { id: "employeeName", label: "Assigned To", type: "TEXT", order: 1, width: 4, required: true },
      { id: "project", label: "Project", type: "TEXT", order: 2, width: 4, required: true },
      { id: "period", label: "Period", type: "TEXT", order: 3, width: 3 },
    ] },
    { id: "hours", title: "Work Items", order: 2, fields: [
      { id: "date", label: "Closed Date", type: "DATE", order: 1, width: 2, required: true },
      { id: "workItemTitle", label: "Title", type: "TEXT", order: 2, width: 3 },
      { id: "activity", label: "Activity", type: "TEXT", order: 3, width: 2 },
      { id: "regularHours", label: "Completed Work", type: "HOURS", order: 4, width: 2 },
      { id: "totalHours", label: "Total Hours", type: "CALCULATED", order: 5, width: 2, formula: "regularHours" },
      { id: "comments", label: "Notes", type: "TEXT", order: 6, width: 3 },
    ] },
    { id: "approval", title: "Approval", order: 3, fields: APPROVAL_FIELDS },
  ],
  blocks: [
    { id: "blk1", type: "KEYVALUE", order: 1, title: "Employee Details", fields: [
      { id: "f1", label: "Assigned To", fieldId: "employeeName" },
      { id: "f2", label: "Project", fieldId: "project" },
      { id: "f3", label: "Period", fieldId: "period" },
    ] },
    { id: "blk2", type: "TABLE", order: 2, title: "Work Items", columns: [
      { id: "c1", label: "Closed Date", fieldId: "date" },
      { id: "c2", label: "Title", fieldId: "head" },
      { id: "c3", label: "Completed Work", fieldId: "hours" },
      { id: "c4", label: "Notes", fieldId: "comment" },
    ] },
  ] as TemplateBlock[],
};

const WENERGY: TemplateConfig = {
  header: { title: "WEnergy Timesheet", showLogo: true, companyName: "GenAquarius" },
  footer: { text: "", showSignatures: true },
  sections: [
    { id: "employee", title: "Employee Details", order: 1, fields: [
      { id: "employeeName", label: "Employee Name", type: "TEXT", order: 1, width: 4, required: true },
      { id: "project", label: "Project", type: "TEXT", order: 2, width: 4, required: true },
      { id: "period", label: "Period", type: "TEXT", order: 3, width: 3 },
    ] },
    { id: "hours", title: "Hours", order: 2, fields: [
      { id: "date", label: "Day", type: "DATE", order: 1, width: 2, required: true },
      { id: "projectTask", label: "Project / Task / Category", type: "TEXT", order: 2, width: 4 },
      { id: "regularHours", label: "Hours", type: "HOURS", order: 3, width: 2 },
      { id: "totalHours", label: "Total Hours", type: "CALCULATED", order: 4, width: 2, formula: "regularHours" },
      { id: "comments", label: "Notes", type: "TEXT", order: 5, width: 3 },
    ] },
    { id: "approval", title: "Approval", order: 3, fields: APPROVAL_FIELDS },
  ],
  blocks: [
    { id: "blk1", type: "KEYVALUE", order: 1, title: "Employee Details", fields: [
      { id: "f1", label: "Employee Name", fieldId: "employeeName" },
      { id: "f2", label: "Project", fieldId: "project" },
      { id: "f3", label: "Period", fieldId: "period" },
    ] },
    { id: "blk2", type: "PIVOT_GRID", order: 2, title: "Hours", pivot: {
      rowField: "task", columnMode: "DAY_OF_WEEK", valueField: "hours",
      rowLabel: "Project / Task / Category", showRowTotal: true, showColumnTotal: true,
    } },
  ] as TemplateBlock[],
};

const SYMSOFT: TemplateConfig = {
  header: { title: "Symsoft Timesheet", showLogo: true, companyName: "GenAquarius" },
  footer: { text: "", showSignatures: true },
  sections: [
    { id: "employee", title: "Consultant Details", order: 1, fields: [
      { id: "employeeName", label: "Consultant", type: "TEXT", order: 1, width: 4, required: true },
      { id: "employeeId", label: "Client", type: "TEXT", order: 2, width: 4 },
      { id: "project", label: "Project", type: "TEXT", order: 3, width: 4, required: true },
      { id: "period", label: "Week Period", type: "TEXT", order: 4, width: 3 },
    ] },
    { id: "hours", title: "Hours", order: 2, fields: [
      { id: "date", label: "Date", type: "DATE", order: 1, width: 2, required: true },
      { id: "dayName", label: "Day", type: "TEXT", order: 2, width: 2 },
      { id: "regularHours", label: "Hours", type: "HOURS", order: 3, width: 2 },
      { id: "totalHours", label: "Total Hours", type: "CALCULATED", order: 4, width: 2, formula: "regularHours" },
      { id: "comments", label: "Notes", type: "TEXT", order: 5, width: 4 },
    ] },
    { id: "approval", title: "Approval", order: 3, fields: [
      { id: "managerApproval", label: "Manager Approval", type: "APPROVAL", order: 1, width: 4 },
    ] },
  ],
  blocks: [
    { id: "blk1", type: "KEYVALUE", order: 1, title: "Consultant Details", fields: [
      { id: "f1", label: "Consultant", fieldId: "employeeName" },
      { id: "f2", label: "Client", fieldId: "client" },
      { id: "f3", label: "Project", fieldId: "project" },
      { id: "f4", label: "Week Period", fieldId: "period" },
    ] },
    { id: "blk2", type: "TABLE", order: 2, title: "Hours", columns: [
      { id: "c1", label: "Date", fieldId: "date" },
      { id: "c2", label: "Hours", fieldId: "hours" },
      { id: "c3", label: "Notes", fieldId: "comment" },
    ] },
  ] as TemplateBlock[],
};

// GenAquarius's own standard report — confirmed identical structure across CXC, Kira,
// Cozzinibros, Cyncly, Northpoint Consulting and "Default Template.xlsx": a Report
// Period/Client Name/Billing Criteria header, a Summary Report (Resource Name/Project Name/
// Value), and a per-resource Task × day-of-month detail grid with a Resource Total row.
const GENAQUARIUS_STANDARD: TemplateConfig = {
  header: { title: "Work Order Monthly Timesheet Report - GenAquarius", showLogo: true, companyName: "GenAquarius" },
  footer: { text: "", showSignatures: true },
  sections: [
    { id: "employee", title: "Report Details", order: 1, fields: [
      { id: "employeeName", label: "Resource Name", type: "TEXT", order: 1, width: 4, required: true },
      { id: "project", label: "Client Name", type: "TEXT", order: 2, width: 4, required: true },
      { id: "period", label: "Report Period", type: "TEXT", order: 3, width: 3 },
      { id: "employeeId", label: "Billing Criteria", type: "TEXT", order: 4, width: 2 },
    ] },
    { id: "hours", title: "Task Hours", order: 2, fields: [
      { id: "date", label: "Date", type: "DATE", order: 1, width: 2, required: true },
      { id: "projectTask", label: "Task", type: "TEXT", order: 2, width: 4 },
      { id: "regularHours", label: "Hours", type: "HOURS", order: 3, width: 2 },
      { id: "totalHours", label: "Resource Total", type: "CALCULATED", order: 4, width: 2, formula: "regularHours" },
      { id: "comments", label: "Notes", type: "TEXT", order: 5, width: 3 },
    ] },
    { id: "approval", title: "Approval", order: 3, fields: APPROVAL_FIELDS },
  ],
  blocks: [
    { id: "blk1", type: "KEYVALUE", order: 1, title: "Report Details", fields: [
      { id: "f1", label: "Client Name", fieldId: "client" },
      { id: "f2", label: "Report Period", fieldId: "period" },
      { id: "f3", label: "Billing Criteria", fieldId: "billingCriteria" },
    ] },
    { id: "blk2", type: "SUMMARY_TABLE", order: 2, title: "Summary Report" },
    { id: "blk3", type: "PIVOT_GRID", order: 3, title: "Resource", pivot: {
      rowField: "task", columnMode: "DAY_OF_MONTH", valueField: "hours",
      rowLabel: "Task", showRowTotal: true, showColumnTotal: true,
    } },
  ] as TemplateBlock[],
};

// Clarien Bank's real export: a GenAquarius LLC letterhead, Employee Name/Manager/Project
// Title/Project Code/Period from-to header, then a day-of-month grid where each day gets a
// Y/N (or annotated: "Sat"/"Sun"/"Y - Overtime"/"Y - Half day sick leave") status rather than a
// plain numeric hours figure.
const CLARIEN_BANK: TemplateConfig = {
  header: { title: "Timesheet", showLogo: true, companyName: "GenAquarius LLC" },
  footer: { text: "", showSignatures: true },
  sections: [
    { id: "employee", title: "Employee Details", order: 1, fields: [
      { id: "employeeName", label: "Employee Name", type: "TEXT", order: 1, width: 4, required: true },
      { id: "employeeId", label: "Manager", type: "TEXT", order: 2, width: 3 },
      { id: "project", label: "Project Title", type: "TEXT", order: 3, width: 4, required: true },
      { id: "period", label: "Period", type: "TEXT", order: 4, width: 3 },
    ] },
    { id: "hours", title: "Daily Status", order: 2, fields: [
      { id: "date", label: "Date", type: "DATE", order: 1, width: 2, required: true },
      { id: "regularHours", label: "Hours", type: "HOURS", order: 2, width: 2 },
      { id: "dayStatus", label: "Day Status (Y/N)", type: "TEXT", order: 3, width: 3 },
      { id: "totalHours", label: "Total Hours", type: "CALCULATED", order: 4, width: 2, formula: "regularHours" },
      { id: "comments", label: "Notes", type: "TEXT", order: 5, width: 3 },
    ] },
    { id: "approval", title: "Approval", order: 3, fields: APPROVAL_FIELDS },
  ],
  blocks: [
    { id: "blk1", type: "KEYVALUE", order: 1, title: "Employee Details", fields: [
      { id: "f1", label: "Employee Name", fieldId: "employeeName" },
      { id: "f2", label: "Manager", fieldId: "employeeId" },
      { id: "f3", label: "Project Title", fieldId: "project" },
      { id: "f4", label: "Period", fieldId: "period" },
    ] },
    { id: "blk2", type: "PIVOT_GRID", order: 2, title: "Daily Status", pivot: {
      rowField: "task", columnMode: "DAY_OF_MONTH", valueField: "status",
      rowLabel: "Day Status", showRowTotal: true, showColumnTotal: true,
    } },
  ] as TemplateBlock[],
};

const FORMAT_TEMPLATES: { name: string; config: TemplateConfig; isDefault?: boolean }[] = [
  { name: "GenAquarius Standard Timesheet", config: GENAQUARIUS_STANDARD, isDefault: true },
  { name: "Station Casino Timesheet", config: STATION_CASINO },
  { name: "Clarien Bank Timesheet", config: CLARIEN_BANK },
  { name: "WEnergy Timesheet", config: WENERGY },
  { name: "Symsoft Timesheet", config: SYMSOFT },
];

export async function main() {
  let created = 0, skipped = 0;
  for (const t of FORMAT_TEMPLATES) {
    const existing = await prisma.timesheetTemplate.findFirst({ where: { name: t.name } });
    if (existing) { skipped++; continue; }
    if (t.isDefault) await prisma.timesheetTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    await prisma.timesheetTemplate.create({
      data: { name: t.name, version: 1, isLatest: true, isDefault: !!t.isDefault, status: "ACTIVE", config: t.config as any },
    });
    created++;
  }
  const msg = `Timesheet format templates seed: created ${created}, already present ${skipped}.`;
  console.log(msg);
  return msg;
}

// One-time sync for the night `blocks` was added to these 5 templates after they'd already been
// created by main() above — overwrites ONLY these 5 known rows (matched by name, isLatest only)
// with their current FORMAT_TEMPLATES config, never touches any other template Finance may have
// since created or edited. Not part of main()'s own ordinary idempotent create-if-missing path.
export async function syncBlocksToExisting() {
  let updated = 0, missing = 0;
  for (const t of FORMAT_TEMPLATES) {
    const existing = await prisma.timesheetTemplate.findFirst({ where: { name: t.name, isLatest: true } });
    if (!existing) { missing++; continue; }
    await prisma.timesheetTemplate.update({ where: { id: existing.id }, data: { config: t.config as any } });
    updated++;
  }
  const msg = `Timesheet format templates blocks-sync: updated ${updated}, missing ${missing}.`;
  console.log(msg);
  return msg;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
