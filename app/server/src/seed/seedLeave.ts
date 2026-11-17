// One-off / re-runnable seed for the Leave Policy engine (Employee Self-Service module):
// India's real 2026 leave-type entitlements, the global policy config (sandwich rule,
// probation length, comp-off expiry, EL encashment), the 2026 India public-holiday
// calendar, and the onboarding-document checklist. US/Canada get empty country scaffolding
// only — no invented numbers (the source policy PDF only defines India).
//
// Idempotent: every row is an upsert/findFirst-then-write, so re-running after HR has
// edited values in the UI does NOT clobber their edits for anything already present.
// Run with: npm run seed:leave (see package.json).
import { prisma } from "../prisma";

async function upsertLeaveType(countryCode: string, key: string, data: {
  name: string; accrualPerMonth?: number; annualQuota?: number | null; maxCarryForward?: number | null;
  maxApplyPerYear?: number | null; maxConsecutiveDays?: number | null; requiresProbationComplete?: boolean;
  lapsesAtYearEnd?: boolean; sandwichEligible?: boolean; order: number;
}) {
  // Prisma's compound-unique WHERE rejects `null` at RUNTIME even though a regular filter
  // accepts it (confirmed the hard way — the `as any` cast only silences the type error, the
  // query engine itself still throws "Argument businessUnitId must not be null"). findFirst-
  // then-create/update sidesteps it.
  const existing = await prisma.hrLeaveType.findFirst({ where: { countryCode, businessUnitId: null, key } });
  const data2 = {
    name: data.name, accrualPerMonth: data.accrualPerMonth ?? 0, annualQuota: data.annualQuota ?? null,
    maxCarryForward: data.maxCarryForward ?? null, maxApplyPerYear: data.maxApplyPerYear ?? null,
    maxConsecutiveDays: data.maxConsecutiveDays ?? null, requiresProbationComplete: !!data.requiresProbationComplete,
    lapsesAtYearEnd: !!data.lapsesAtYearEnd, sandwichEligible: !!data.sandwichEligible, order: data.order,
  };
  if (existing) await prisma.hrLeaveType.update({ where: { id: existing.id }, data: data2 });
  else await prisma.hrLeaveType.create({ data: { countryCode, key, ...data2 } });
}

async function upsertHoliday(country: string, date: string, name: string) {
  // Holiday has no unique constraint, and pre-existing rows (imported from the golden-master
  // workbook) store `date` at an arbitrary time-of-day (not UTC midnight) — so match by the
  // UTC CALENDAR DAY, not exact Date equality, or a same-day row would be missed and duplicated.
  const dayStart = new Date(date + "T00:00:00.000Z");
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const existing = await prisma.holiday.findFirst({ where: { country, date: { gte: dayStart, lt: dayEnd } } });
  if (existing) { if (existing.name !== name) await prisma.holiday.update({ where: { id: existing.id }, data: { name } }); }
  else await prisma.holiday.create({ data: { country, date: dayStart, name } });
}

async function upsertDocType(name: string, required: boolean, order: number) {
  const existing = await prisma.onboardingDocumentType.findFirst({ where: { name, businessUnitId: null } });
  if (existing) await prisma.onboardingDocumentType.update({ where: { id: existing.id }, data: { required, order } });
  else await prisma.onboardingDocumentType.create({ data: { name, required, order } });
}

async function upsertPolicyConfigDefault(countryCode: string, data: { sandwichEnabled: boolean; sandwichDays?: number; probationDays: number; elEncashmentCapDays: number; elEncashmentRatePerDay: number; compOffExpiryDays: number }) {
  const existing = await prisma.hrLeavePolicyConfig.findFirst({ where: { countryCode, businessUnitId: null } });
  if (existing) return;
  await prisma.hrLeavePolicyConfig.create({ data: { countryCode, businessUnitId: null, ...data } });
}

export async function main() {
  // ---- Global policy config — India (real numbers from the 2026 policy PDF) ----
  await upsertPolicyConfigDefault("INDIA", {
    sandwichEnabled: true, sandwichDays: 4,
    probationDays: 90, // not specified numerically in the policy PDF excerpt — standard 3-month probation assumed; HR can edit in HR Settings
    elEncashmentCapDays: 30, elEncashmentRatePerDay: 2000,
    compOffExpiryDays: 30,
  });
  // US/Canada — empty scaffolding only, no invented policy numbers.
  await upsertPolicyConfigDefault("US", { sandwichEnabled: false, probationDays: 0, elEncashmentCapDays: 0, elEncashmentRatePerDay: 0, compOffExpiryDays: 0 });
  await upsertPolicyConfigDefault("CANADA", { sandwichEnabled: false, probationDays: 0, elEncashmentCapDays: 0, elEncashmentRatePerDay: 0, compOffExpiryDays: 0 });

  // ---- Leave types — India, GenAquarius Leave Policy 2026 ----
  await upsertLeaveType("INDIA", "EARNED", {
    name: "Earned Leave", accrualPerMonth: 1, maxCarryForward: 30, requiresProbationComplete: true, sandwichEligible: true, order: 1,
  });
  await upsertLeaveType("INDIA", "GENERAL", {
    name: "General Leave", annualQuota: 6, maxCarryForward: 0, maxConsecutiveDays: 3, lapsesAtYearEnd: true, sandwichEligible: true, order: 2,
  });
  await upsertLeaveType("INDIA", "BEREAVEMENT", {
    name: "Bereavement Leave", annualQuota: 5, lapsesAtYearEnd: true, order: 3,
  });
  await upsertLeaveType("INDIA", "COMP_OFF", {
    name: "Compensatory Off", order: 4, // earn-on-approval mechanic — see CompOffCredit / engine/leave.ts, no fixed annual quota
  });
  await upsertLeaveType("INDIA", "PUBLIC_HOLIDAY", {
    name: "Public Holiday", annualQuota: 7, order: 5, // informational — actual dates are the Holiday table, not applied for
  });
  await upsertLeaveType("INDIA", "FLOATING_RESTRICTED", {
    // = "RH" (Restricted Holiday) in the newer Employee Module naming — same leave type,
    // relabelled rather than duplicated (key unchanged so existing balances/requests carry over).
    name: "Restricted Holiday (RH)", annualQuota: 1, lapsesAtYearEnd: true, order: 6,
  });
  // PL (Privilege Leave) — genuinely new, requested by the Employee Module ask. No entitlement
  // number is given in the GenAquarius Leave Policy 2026 PDF (which only defines Earned/General/
  // Bereavement/Comp-Off/Public Holiday/Floating-Restricted/Birthday/Marriage-Anniversary), so
  // this is seeded as a clearly-marked placeholder (0 days) for HR to configure the real
  // entitlement in HR Settings → Leave Policy — not a fabricated number.
  await upsertLeaveType("INDIA", "PRIVILEGE", {
    // annualQuota: 0 is the placeholder itself — HR sets the real entitlement in HR Settings →
    // Leave Policy once it's defined (kept out of the display name so it doesn't clutter every
    // dropdown/table this leave type appears in).
    name: "Privilege Leave (PL)", annualQuota: 0, lapsesAtYearEnd: true, order: 9,
  });
  await upsertLeaveType("INDIA", "BIRTHDAY", {
    name: "Birthday Leave", annualQuota: 1, lapsesAtYearEnd: true, order: 7,
  });
  await upsertLeaveType("INDIA", "MARRIAGE_ANNIVERSARY", {
    name: "Marriage Anniversary Leave", annualQuota: 1, lapsesAtYearEnd: true, order: 8,
  });

  // ---- 2026 India public holidays (7 fixed + 1 floating/restricted — the floating day is
  // chosen per-employee via the Floating/Restricted leave type above, not a fixed calendar date) ----
  await upsertHoliday("INDIA", "2026-01-26", "Republic Day");
  await upsertHoliday("INDIA", "2026-03-04", "Holi");
  await upsertHoliday("INDIA", "2026-08-15", "Independence Day");
  await upsertHoliday("INDIA", "2026-10-02", "Mahatma Gandhi Birthday");
  await upsertHoliday("INDIA", "2026-10-20", "Dussehra");
  await upsertHoliday("INDIA", "2026-11-08", "Diwali");
  await upsertHoliday("INDIA", "2026-12-25", "Christmas");

  // ---- Onboarding document checklist (Annexure B — standard India joining documents) ----
  // The first three are HR's own record-keeping copies (system-generated for anyone onboarded
  // through the new HR flow, or a scanned/uploaded copy HR attaches for anyone imported before
  // it existed) — not required from the candidate directly, hence required:false.
  const docs: [string, boolean][] = [
    ["Offer Letter", false], ["Appointment Letter", false], ["Service Agreement", false],
    ["PAN Card", true], ["Aadhar Card", true], ["Passport-size Photographs", true],
    ["Educational Certificates (highest qualification)", true], ["Previous Employer — Relieving Letter", true],
    ["Previous Employer — Experience Letter", true], ["Last 3 Months' Salary Slips", true],
    ["Bank Account Details / Cancelled Cheque", true], ["Address Proof", true], ["Passport / Visa (if applicable)", false],
    ["UAN / PF Details (if applicable)", true],
  ];
  for (let i = 0; i < docs.length; i++) await upsertDocType(docs[i][0], docs[i][1], i);

  console.log("Leave policy, India 2026 holidays and onboarding-document checklist seeded.");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
