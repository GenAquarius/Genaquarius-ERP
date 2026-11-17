// One-off / re-runnable seed for the HR module's configuration tables (HR Admin Settings).
// Idempotent: every row is an upsert, so running this again after HR has edited values in
// the UI does NOT clobber their edits for anything already present — it only fills gaps.
// Run with: npm run seed:hr (see package.json). Never touches the golden-master seed data.
import { prisma } from "../prisma";
import { SERVICE_AGREEMENT_CLAUSES, DEFAULT_SERVICES } from "./serviceAgreementClauses";

async function upsertBracket(name: string, countryCode: string, minCtc: number, maxCtc: number | null, referenceSheet: string, order: number, pcts: Record<string, number>) {
  const existing = await prisma.hrCtcBracket.findFirst({ where: { name, countryCode } });
  const bracket = existing
    ? await prisma.hrCtcBracket.update({ where: { id: existing.id }, data: { minCtc, maxCtc, referenceSheet, order } })
    : await prisma.hrCtcBracket.create({ data: { name, countryCode, minCtc, maxCtc, referenceSheet, order } });

  // Component list is identical across brackets (confirmed against the 4 reference workbooks) —
  // only the % allocation differs. Order matches Part A then Part B as it appears on the Annexure.
  const COMPONENTS: [string, "A" | "B"][] = [
    ["Basic Salary", "A"], ["HRA", "A"], ["Special / Other Allowance", "A"],
    ["Conveyance / Fuel Allowance", "B"], ["Communication Allowance", "B"], ["Meals & Entertainment Exp.", "B"],
    ["Magazine (Books & Periodicals)", "B"], ["Vehicle Maintenance Allowance", "B"], ["Driver Allowance", "B"], ["Uniform Allowance", "B"],
  ];
  for (let i = 0; i < COMPONENTS.length; i++) {
    const [cname, part] = COMPONENTS[i];
    const pct = pcts[cname] ?? 0;
    const existingComp = await prisma.hrSalaryComponent.findFirst({ where: { bracketId: bracket.id, name: cname } });
    if (existingComp) await prisma.hrSalaryComponent.update({ where: { id: existingComp.id }, data: { pct, part, order: i } });
    else await prisma.hrSalaryComponent.create({ data: { bracketId: bracket.id, name: cname, part, pct, order: i } });
  }
  return bracket;
}

async function upsertTaxSlab(countryCode: string, regime: string, minIncome: number, maxIncome: number | null, ratePct: number, order: number) {
  const existing = await prisma.hrTaxBracket.findFirst({ where: { countryCode, regime, order } });
  if (existing) await prisma.hrTaxBracket.update({ where: { id: existing.id }, data: { minIncome, maxIncome, ratePct } });
  else await prisma.hrTaxBracket.create({ data: { countryCode, regime, minIncome, maxIncome, ratePct, order } });
}

const OFFER_TEMPLATE_BODY = `Dear {{CandidateFirstName}},

We are pleased to offer you the position of {{Role}} at GenAquarius Private Limited. We believe your skills and experience will be a valuable addition to our team. Below are the terms of our offer:

Position Details
Job Title: {{Designation}}
Offer Ref.: {{OfferRef}}
Start Date: {{ProposedJoiningDate}}
Business: {{Business}}

Compensation and Benefits
Base Salary: {{Ctc}} per annum, paid monthly, subject to deductions for taxes and other withholdings as required by law. Provident Fund contributions will be made as per the Employees' Provident Fund Provisions Act, 1952.

Benefits: You will be covered under the Medical Insurance Policy at the time of joining the service. Medical insurance will cover the Spouse & Children.

Vacations: You are entitled to receive 18 days paid vacation (12 Earned, 6 General Leaves & not counting public holidays, Saturdays and Sundays) every 12 months, which accrues at the rate of 1.50 days each month.

Your detailed salary structure is attached as per Annexure A.

Probation Period - 2 Months
Notice Period - 2 Months

Your remuneration package is strictly confidential between you and the Company and should not be discussed with anyone.

Conditions of Offer
Confidentiality: You recognize and agree that confidential and/or proprietary information concerning the business of GenAquarius is a valuable asset, and that unauthorized disclosure or use of such information would inflict irreparable harm to GenAquarius. You agree not to disclose or use any such information without the prior written consent of GenAquarius.

Please indicate your acceptance of the terms set forth in this letter by signing and returning a copy of this letter.

We take this opportunity to congratulate you and look forward to an enduring relationship with GenAquarius Private Limited!`;

// Clause text transcribed VERBATIM from the real "Appointment Letter - GenAquarius.docx" reference
// file, INCLUDING its numbered sub-points (1.1, 1.2, … and, for two clauses, a further lettered
// a/b/c sub-list) — confirmed by rendering the actual docx to PDF via Word automation and reading
// the true auto-numbering, which plain text extraction does not expose. Every point below is its
// own editable line in HR Settings → Appointment Letter → Clause Library; nothing is condensed.
// "Position Details" is intentionally NOT one of these — it's the fixed label/value block rendered
// directly above from the offer's own fields (Job Title/Emp. Id/Start Date/…), matching the docx.
const APPOINTMENT_CLAUSES = [
  { key: "appointment", title: "Appointment Details", points: [
    "The date of appointment is effective from the date of joining, which is {{JoiningDate}}, unless otherwise communicated in writing by the company.",
    "You will functionally report to {{ReportingManager}}, or any other position as decided by the Company from time to time.",
    "You will be based at our Noida office. Additionally, at the Company's sole discretion, you may be transferred, posted, or deputed to any of the Company's affiliates, including parent or subsidiary companies. You may also be seconded from the Company to any of its clients or customers, within India or outside India, depending upon the existences of the business.",
    "Your appointment to the post of \"{{Designation}}\" will be on probation for a period of {{ProbationPeriod}} from the date of joining, which is {{JoiningDate}}, further extendable at the sole discretion of the management of the Company.",
  ] },
  { key: "compensation", title: "Compensation", points: [
    "Your annual compensation will be as per your offer letter (Annexure A+B).",
    "Your next salary revision will be in accordance with the merit review cycle of the Company. The pay review is once a year. Increments, allowances, perquisites and other service-related contractual pecuniary benefits shall be negotiated, determined, and finalized mutually between the Company and you in writing from time to time. However, the allowances and perquisites applicable to you can be altered/changed by the Company any time as per the policy of the Company and further depend upon the duties assigned to you.",
    "Further, salary, allowances and all other payments/benefits will be governed by the company's rules as well as statutory provisions in force from time to time and subject to deduction of appropriate taxes at source, as per the policy of the Company and further depending upon the duties assigned to you.",
  ] },
  { key: "entitlements", title: "Other Entitlements", points: [
    { text: "Your other entitlements, as may be determined by the Company Policy, are as follows:", unnumbered: true },
    "You will be entitled to receive 18 days' paid vacation (12 Earned Leaves & 6 General Leaves, not counting public holidays, Saturdays and Sundays) every 12 months, which accrues at the rate of 1.50 days per month.",
    "All employees who are on the rolls of the company will be covered under ESIC, eligible for Group Mediclaim.",
    { text: "All the above entitlements shall be provided in accordance with the Company's policy in this regard and at the sole discretion of the Company.", unnumbered: true },
  ] },
  { key: "responsibilities", title: "Responsibilities", points: [
    "In view of your position and office, you must effectively, diligently and to the best of your ability perform all responsibilities and ensure results. You will be required to work eight hours a day, in any one of the shifts during the day or at night as assigned by the Company, excluding thirty minutes' mealtime and two breaks of fifteen minutes each. The Company practices a forty-five-hour workweek which may at the discretion of the Company be increased to forty-eight hours per week. Work timings, schedules, and shifts may vary from time to time, based on customer service requirements and depend upon exigencies of business, as specified by the Company from time to time. The Company shall be free to amend and stagger the working hours in accordance with business requirements.",
    "You may be required to undertake travel on Company work, for which you will be reimbursed travel expenses as per the company's Travel and Expense policy applicable to you.",
    "We are committed to ensuring integrity in all aspects of our functioning. You are expected to comply with the HR policies of the Company, as well as any other policies, rules, regulations, and procedures relevant to your employment, including but not limited to the Prevention of Sexual Harassment Policy and Code of Conduct. You are required to understand the scope and intent of these policies and to comply with them. These policies are updated or modified periodically, and new policies may be introduced and notified to employees from time to time, with which you will be required to comply. You agree that it is solely your duty to stay up to date with the Company policies and that ignorance of Company policies will not be treated as a valid reason for failure to adhere to the Company policies.",
  ] },
  { key: "separation", title: "Separation and Termination", points: [
    "Separation Process should start with a formal resignation process. If an employee intends to leave or discontinue his/her service, he/she should not leave or discontinue his/her service in the company without giving prior notice. The resignation process should take place in an email, mentioning date/reason for resignation. Acknowledgment of the resignation will be issued to the employee in the form of an 'Acceptance of Resignation' issued by the Company before his/her last working day. The resigned employees will be released only after handing over all their assets and charges to the concerned department.",
    "Your employment service will be governed by the Company's rules and regulations applicable from time to time. If the Company wishes to terminate your employment for any reason as not prescribed in this appointment letter, the Company reserves the right to do so with notice of {{NoticePeriod}} in case of confirmed employment and no notice is required in case of probationary period; or by paying proportionate basic salary (excluding variable) in lieu of any short notice period.",
    "If you wish to terminate your employment with the company, you shall be required to serve a minimum of {{NoticePeriod}} notice in case of a confirmed employment and no notice is required in case of probationary period; or pay proportionate gross remuneration (excluding variable) in lieu of any short notice period to the Company, subject to management approval on the same. The Company may however, in its sole discretion, waive off the notice period, in full or in part, without assuming any liability to compensate you in respect of the period so waived.",
    "The notice period is meant to ensure completion of jobs/assignments already taken, handing over ongoing jobs/assignments, smooth transition of work and/or time to get suitable replacement. Since the position which will be held by you is crucial, the Company reserves its right to insist you serve the entire notice period or at least till it finds your suitable replacement. If you wish to avail leave during the notice period, your notice period will get extended in proportion to the number of leaves availed during the notice period.",
    { text: "That no notice period for the purpose of termination of your services will be required to be given by the Company on happening of either of the following events, as the present contract of employment will stand terminated automatically on happening of either of the following events:-", subpoints: [
      "Unauthorized absence beyond a period of seven (7) days without any sanctioned leave and/or further without any prior intimation in writing to the Company and/or failure to resume duties after completion of leave availed.",
      "On the grounds of gross misconduct, inefficiency, dereliction of duty, misrepresentation, fraud, malfeasance, burglary, breach of trust, financial irregularities, indiscipline, dishonest acts and omissions, neglect of duty and any other misconduct directly and indirectly affecting the interest of the Company.",
      "Where any information/declaration/document furnished by you in relation to the present appointment is found to be false, fabricated, manipulated, and suppressed.",
      "If you are convicted by any court of law or detained by the police for any offense involving moral or criminal turpitude.",
      "The Company may, at its sole discretion, terminate this employment agreement without notice if you continue to perform poorly in the discharge of your duties or in the conduct of the Company's business, despite being given reasonable opportunities to improve, including but not limited to a formal Performance Improvement Plan (PIP). Your refusal to adhere to a performance improvement plan or its terms and conditions, as required by the Company, shall constitute a breach of this Agreement.",
      "In case you are found medically unfit to continue with the job.",
      "You are in breach of any of the terms, conditions, or stipulations of this appointment letter hereof, including but not limited to breach of any of the terms and conditions or stipulations of any agreement or the NDA or understanding that you may have entered with the Company in the course of your employment with the Company.",
    ] },
    "You acknowledge that during the term of your employment, you shall be provided by the Company's training(s) and certifications as may be required from time to time. In case you decide to terminate your service within one year of undertaking such training or certifications program, you will be required to reimburse such costs and expenses incurred by the Company in relation to such programs.",
  ] },
  { key: "bgv", title: "Background Verification", points: [
    { text: "You agree that your employment with the Company is contingent and subject to the conclusion and positive outcome of the company's Background Verification Process. The Company may at any time at sole discretion, conduct the Background Verification Process. In the event of an unsatisfactory outcome of such verification, the Company reserves the right to terminate your employment.", unnumbered: true },
  ] },
  { key: "conflict", title: "Conflict of Interest", points: [
    "During your employment, you will put your best of abilities and efficiency to promote and expand the business of the company. During your employment, you will neither work for, nor employ yourself with or render your device/consultant/services directly or indirectly and further in any manner and in any capacity to any other Company/Organization/Firm/Person except with the prior written permission of the Company in writing. In the event of breach of this obligation, the Company shall be within its rights, at its sole discretion and no obligation, to claim appropriate damages, injunction as permitted to it under the law of the land.",
    { text: "The Conflict-of-Interest Policy also refers to the need on your part, during your employment and for a period of one year from the cessation of your employment with the company (irrespective of the circumstances of, or the reasons for, the cessation) not to solicit, induce or encourage:", subpoints: [
      "Any employee of GenAquarius to terminate their employment with the company or to accept employment with any competitor, supplier or any customer with whom you have a connection.",
      "Any customer or vendor of GenAquarius to move his existing business with GenAquarius to a third party or to terminate his business relationship with the company.",
      "Any existing employee to become associated with or perform services of any type for any third party.",
    ] },
  ] },
  { key: "confidentiality", title: "Confidentiality", points: [
    "During your employment you will have access to confidential information of the Company, its shareholder, employee related and affiliated entities, and Clients of the company (collectively \"confidential information\"). Confidential information shall include any information relating to trade secrets, software programs and designs, database, trading information, specification, financial information, customer and supplier names, correspondence, negotiations and/or contracts with customer and suppliers, research database and other information that the Company in the future may indicate as confidential or which may be deemed confidential by its nature. It is a condition of your employment not to disclose directly or indirectly, to any person or persons, any confidential information or proprietary information or information relating to the affairs of the Company or any related or affiliated entity or company's client which is commercially sensitive or the disclosure of which would adversely affect the Company, its shareholder, related or affiliated entities and/or the Company's client. This obligation survives the termination of your employment with the Company.",
    "You are required to strictly maintain the secrecy of and ensure that you do not divulge or communicate in any manner, any information regarding your remuneration/terms of employment, to any other employee of the Company.",
  ] },
  { key: "ip", title: "Assignment of Intellectual Property", points: [
    { text: "You agree and assure that during the term of your employment, to the maximum extent permitted by law, all intellectual property including copyrights, design rights, trade marks obtained by you individually or on behalf of the Company in relation to the work carried on, discovered, invented, designed and/or authored by you (hereinafter referred to as \"Intellectual Properties\") as an employee of the company during the term of your employment shall be owned by the Company and you shall not have any right in relation to the Intellectual Properties. Such Intellectual Properties shall constitute the absolute property of the company and you shall not lay claim on any such Intellectual Properties during the term of your employment and after termination of your employment.", unnumbered: true },
  ] },
  { key: "noncompete", title: "Non-Compete", points: [
    { text: "That on and after cessation of your employment with the Company, you will neither work for, nor employ yourself with nor render your advice/consultancy/service directly or indirectly and further any manner and in any capacity to any of the past and/or existing customers, clients of the Company you are serving for any matter for a period of 1 year from the date of leaving the employment.", unnumbered: true },
  ] },
  { key: "governing-law", title: "Governing Laws & Dispute Resolution", points: [
    { text: "This contract shall be governed and constructed in accordance with the laws of India. That all the disputes, differences and claims arising out of and/or in connection with and/or relating to and/or pertaining to the subject matter of the present letter as well as any other agreement/bond/document including the aforesaid appointment letter, having been executed between you and the Company, shall be referred for adjudication to the arbitration of the sole Arbitrator, to be appointed mutually by the Parties under the provisions of Indian Arbitration and Conciliation Act 1996, as amended up to date. The venue of arbitration shall be Delhi.", unnumbered: true },
  ] },
  { key: "notice", title: "Notice", points: [
    { text: "That all notices or communications delivered personally or sent by Regd. A.D. post and/or e-mail (hr@genaquarius.com) at the address given herein-before or any other subsequently changed address under written intimation to the Company shall be deemed delivered on the second business day following deposit of such notice in the post office/courier etc. with appropriate postage and fees paid.", unnumbered: true },
  ] },
  { key: "remote", title: "Remote Work", points: [
    { text: "You will be engaged in a {{WorkLocation}} capacity. Your primary place of work shall be your residence or such other location as approved by the reporting manager/Company. However, you may be required to report to the Company's office or any designated location as and when business needs arise.", unnumbered: true },
  ] },
  { key: "acceptance", title: "Acceptance", points: [
    { text: "Please indicate your acceptance by signing each page of the appointment letter to acknowledge all the terms and conditions. Submit a copy of document to the Company.", unnumbered: true },
  ] },
  { key: "effective", title: "Effective Date", points: [
    { text: "This contract will become effective only upon our receipt of a signed copy of this letter from you. Please be aware that your compensation and benefits will not begin to accrue until you start working for the Company.", unnumbered: true },
  ] },
  { key: "declaration", title: "Declaration", points: [
    { text: "I have read and understood the above-stated terms and conditions bearing No.1 to No.15 of the present appointment letter and hereby accept and acknowledge all the said terms and conditions and further declare that I will remain abide by the said terms and conditions.", unnumbered: true },
  ] },
];

// Exported (not just self-executing) so this idempotent seed can also be triggered in-process
// from a running server without disconnecting the shared Prisma client — see bottom of file.
export async function main() {
  console.log("Seeding HR configuration (idempotent)…");

  // ---- Countries (currency/name only — deduction & cess live per tax REGIME, see below) ----
  await prisma.hrCountryConfig.upsert({ where: { code: "INDIA" }, update: {}, create: { code: "INDIA", name: "India", currency: "INR" } });
  await prisma.hrCountryConfig.upsert({ where: { code: "US" }, update: {}, create: { code: "US", name: "United States", currency: "USD" } });
  await prisma.hrCountryConfig.upsert({ where: { code: "CANADA" }, update: {}, create: { code: "CANADA", name: "Canada", currency: "CAD" } });

  // ---- Standard deduction & cess — per (country, regime): the Old and New regimes use
  // different deduction amounts, so this can't live at the country level.
  await prisma.hrTaxRegimeConfig.upsert({ where: { countryCode_regime: { countryCode: "INDIA", regime: "NEW" } }, update: {}, create: { countryCode: "INDIA", regime: "NEW", standardDeduction: 75000, cessPct: 4 } });
  await prisma.hrTaxRegimeConfig.upsert({ where: { countryCode_regime: { countryCode: "INDIA", regime: "OLD" } }, update: {}, create: { countryCode: "INDIA", regime: "OLD", standardDeduction: 50000, cessPct: 4 } });

  // ---- Tax slabs (India, New Regime u/s 115BAC of Income Tax Act, 1961 — from "Tax Slap.jpg") ----
  const slabs: [number, number | null, number][] = [
    [0, 400000, 0], [400000, 800000, 5], [800000, 1200000, 10],
    [1200000, 1600000, 15], [1600000, 2000000, 20], [2000000, 2400000, 25], [2400000, null, 30],
  ];
  for (let i = 0; i < slabs.length; i++) await upsertTaxSlab("INDIA", "NEW", slabs[i][0], slabs[i][1], slabs[i][2], i);

  // ---- Tax slabs (India, Old Regime — from "Tax Slap.jpg") ----
  const oldSlabs: [number, number | null, number][] = [
    [0, 250000, 0], [250000, 500000, 5], [500000, 1000000, 20], [1000000, null, 30],
  ];
  for (let i = 0; i < oldSlabs.length; i++) await upsertTaxSlab("INDIA", "OLD", oldSlabs[i][0], oldSlabs[i][1], oldSlabs[i][2], i);

  // ---- CTC brackets — % of CTC per component, verified against the 4 reference workbooks ----
  await upsertBracket("Bracket A", "INDIA", 0, 1900000, "Salary Calculation upto 19 Lakhs.xlsx", 0, {
    "Basic Salary": 50, "HRA": 25, "Special / Other Allowance": 25,
  });
  await upsertBracket("Bracket B", "INDIA", 1900001, 3600000, "Salary Calculation for 20LPA to 36LPA.xlsx", 1, {
    "Basic Salary": 45, "HRA": 22.5, "Special / Other Allowance": 22.5,
    "Conveyance / Fuel Allowance": 5, "Communication Allowance": 1, "Meals & Entertainment Exp.": 2.5,
    "Magazine (Books & Periodicals)": 0.5, "Uniform Allowance": 1,
  });
  await upsertBracket("Bracket C", "INDIA", 3600001, 5000000, "Salary Calculation for 36LPA to 50LPA.xlsx", 2, {
    "Basic Salary": 45, "HRA": 22.5, "Special / Other Allowance": 22.5,
    "Conveyance / Fuel Allowance": 5, "Communication Allowance": 0.5, "Meals & Entertainment Exp.": 0.5,
    "Magazine (Books & Periodicals)": 0.5, "Driver Allowance": 2.5, "Uniform Allowance": 1,
  });
  await upsertBracket("Bracket D", "INDIA", 5000001, null, "Salary Calculation for 50LPA & above.xlsx", 3, {
    "Basic Salary": 43.5, "HRA": 21.75, "Special / Other Allowance": 21.75,
    "Conveyance / Fuel Allowance": 3.25, "Communication Allowance": 1.3, "Meals & Entertainment Exp.": 1.95,
    "Magazine (Books & Periodicals)": 0.65, "Driver Allowance": 4.55, "Uniform Allowance": 1.3,
  });

  // ---- Business units ----
  await prisma.hrBusinessUnit.upsert({ where: { name: "GenAquarius Technologies Pvt Ltd" }, update: {}, create: { name: "GenAquarius Technologies Pvt Ltd", countryCode: "INDIA" } });
  await prisma.hrBusinessUnit.upsert({ where: { name: "GenAquarius LLC" }, update: {}, create: { name: "GenAquarius LLC", countryCode: "US" } });
  await prisma.hrBusinessUnit.upsert({ where: { name: "Aquarius Technologies Limited" }, update: {}, create: { name: "Aquarius Technologies Limited", countryCode: "CANADA" } });

  // ---- Offer template (from the real "Offer Letter Sample.docx") ----
  const existingOfferTpl = await prisma.hrOfferTemplate.findFirst({ where: { name: "Standard Offer — India" } });
  if (!existingOfferTpl) {
    await prisma.hrOfferTemplate.create({ data: { name: "Standard Offer — India", countryCode: "INDIA", minCtc: 0, maxCtc: null, bodyText: OFFER_TEMPLATE_BODY, isDefault: true } });
  }

  // ---- Appointment template (from the real "Appointment Letter - GenAquarius.docx") ----
  const existingApptTpl = await prisma.hrAppointmentTemplate.findFirst({ where: { name: "GenAquarius Standard" } });
  const clausesJson = APPOINTMENT_CLAUSES.map((c, i) => ({ ...c, enabled: true, order: i }));
  if (!existingApptTpl) {
    await prisma.hrAppointmentTemplate.create({ data: { name: "GenAquarius Standard", countryCode: "INDIA", clauses: clausesJson as any, isDefault: true } });
  }

  // ---- Service Agreement template (CONTRACTOR — from the real "Service Agreement.docx") ----
  const existingSaTpl = await prisma.hrServiceAgreementTemplate.findFirst({ where: { name: "GenAquarius Standard" } });
  const saClausesJson = SERVICE_AGREEMENT_CLAUSES.map((c, i) => ({ ...c, enabled: true, order: i }));
  if (!existingSaTpl) {
    await prisma.hrServiceAgreementTemplate.create({ data: { name: "GenAquarius Standard", countryCode: "INDIA", clauses: saClausesJson as any, services: DEFAULT_SERVICES as any, isDefault: true } });
  }

  // ---- Email templates ----
  // Prisma's compound-unique WHERE (key_businessUnitId) rejects `null` at RUNTIME even though a
  // regular filter accepts it — the same limitation documented on HrLeavePolicyConfig/
  // OnboardingDocumentType elsewhere in this file. findFirst-then-create/update instead of
  // upsert() sidesteps it (identical to the pattern hrSettings.ts's PUT /email-templates uses).
  async function upsertEmailTemplateDefault(key: string, subject: string, body: string) {
    const existing = await prisma.hrEmailTemplate.findFirst({ where: { key, businessUnitId: null } });
    if (existing) return;
    await prisma.hrEmailTemplate.create({ data: { key, businessUnitId: null, subject, body } });
  }
  await upsertEmailTemplateDefault("OFFER_EMAIL", "Your Offer from GenAquarius — {{Role}}, {{Business}}",
    "Dear {{CandidateFirstName}},\n\nWe are delighted to offer you the position of {{Designation}} with {{Business}}, with a proposed joining date of {{ProposedJoiningDate}}.\n\nPlease find your offer letter and CTC annexure attached (Ref: {{OfferRef}}).\n\nKindly confirm your acceptance by replying to this email.\n\nWarm regards,\nHR Team, GenAquarius");
  await upsertEmailTemplateDefault("APPOINTMENT_EMAIL", "Your Appointment Letter — GenAquarius",
    "Dear {{EmployeeName}},\n\nCongratulations and welcome to GenAquarius! Please find attached your Appointment Letter effective {{DateOfAppointment}}.\n\nEmployee ID: {{EmployeeId}}\nDesignation: {{Designation}}\nReporting Manager: {{ReportingManager}}\nWork Location: {{WorkLocation}}\n\nPlease review, sign, and return a copy at your earliest convenience.\n\nWarm regards,\nHR Team, GenAquarius");
  await upsertEmailTemplateDefault("OFFER_WITHDRAWN_EMAIL", "Update on your offer from GenAquarius — {{OfferRef}}",
    "Dear {{CandidateFirstName}},\n\nWe are writing to inform you that GenAquarius has withdrawn the offer of {{Designation}} (Ref: {{OfferRef}}) extended to you.\n\nWe appreciate the time you invested in this process and wish you the very best in your career.\n\nWarm regards,\nHR Team, GenAquarius");
  await upsertEmailTemplateDefault("DOCUMENT_COLLECTION_REQUEST_EMAIL", "Action required: submit your onboarding documents",
    "Hi {{CandidateFirstName}},\n\nPlease submit the following documents using the secure link below:\n\n{{DocumentList}}\n\n{{UploadLink}}\n\nRegards,\nGenAquarius HR");
  await upsertEmailTemplateDefault("DOCUMENT_REJECTION_EMAIL", "Action required: documents needing re-upload",
    "Hi {{CandidateFirstName}},\n\nA few of your submitted documents need to be re-uploaded:\n\nDocuments Requiring Re-upload:\n{{RejectedDocumentsList}}\n\n{{UploadLink}}\n\nRegards,\nGenAquarius HR");
  await upsertEmailTemplateDefault("IT_PROVISIONING_NOTIFICATION", "New IT Provisioning Request – {{EmployeeName}}",
    "A new IT provisioning request has been created and is waiting for your action.\n\nEmployee: {{EmployeeName}}\nDepartment: {{department}}\nJob Title: {{jobTitle}}\nPersonal Email: {{personalEmail}}\n\nLaptop Configuration: {{laptopConfiguration}}\nRAM: {{ram}}\n\nShipping Address: {{shippingAddress}}\n\nPlease open the IT Admin Dashboard to review and approve the request.");
  await upsertEmailTemplateDefault("O365_ADMIN_EMAIL", "New O365 Account Provisioning Approved – {{EmployeeName}}",
    "Employee Information\n--------------------\nFirst Name: {{firstName}}\nLast Name: {{lastName}}\nDisplay Name: {{displayName}}\nPersonal Email: {{personalEmail}}\nJob Title: {{jobTitle}}\nDepartment: {{department}}\n\nIT Provisioning\n---------------\nLaptop Configuration: {{laptopConfiguration}}\nRAM: {{ram}}\nRequired Applications: {{requiredApplications}}\nRequired Access: {{requiredAccess}}\nOther IT Requirements: {{otherRequirements}}\n\nEmail ID to create: {{EmailId}}");
  // ---- Service Agreement (CONTRACTOR) email templates ----
  await upsertEmailTemplateDefault("SERVICE_AGREEMENT_EMAIL", "Your Service Agreement from GenAquarius",
    "Dear {{ContractorFirstName}},\n\nPlease find attached your Commercial Independent Service Agreement with GenAquarius Private Limited, effective {{EffectiveDate}}.\n\nMonthly Compensation: {{MonthlyCompensationAmount}}\n\nKindly review, sign, and return a copy at your earliest convenience.\n\nWarm regards,\nHR Team, GenAquarius");
  await upsertEmailTemplateDefault("SERVICE_AGREEMENT_WITHDRAWN_EMAIL", "Update on your Service Agreement from GenAquarius — {{OfferRef}}",
    "Dear {{CandidateFirstName}},\n\nWe are writing to inform you that GenAquarius has withdrawn the proposed Service Agreement for {{Designation}} (Ref: {{OfferRef}}) extended to you.\n\nWe appreciate the time you invested in this process and wish you the very best.\n\nWarm regards,\nHR Team, GenAquarius");
  // ---- New Employee — CTC Approval notice (internal, to Finance/CTO/CEO) ----
  await upsertEmailTemplateDefault("NEW_EMPLOYEE_CTC_APPROVAL", "Action needed: CTC approval for {{EmployeeName}} ({{EmployeeId}})",
    "Hi Finance,\n\nHR has activated a new {{EmployeeType}} — {{EmployeeName}} ({{EmployeeId}}) — and their CTC record is awaiting your review and approval before it is added to the Monthly Forecast Sheet.\n\nProposed CTC: {{CtcSummary}}\nEffective From: {{CtcEffectiveFrom}}\nProject: {{ProjectName}}\n\nPlease review and approve (or reject) in Confirm Joining Approvals.\n\nRegards,\nHR Team, GenAquarius");
  // ---- Termination approval notice (internal, to Finance/CTO/CEO) ----
  await upsertEmailTemplateDefault("TERMINATION_APPROVAL_REQUEST", "Action needed: termination approval for {{EmployeeName}} ({{EmployeeId}})",
    "Hi Finance,\n\nHR has requested termination for {{EmployeeName}} ({{EmployeeId}}), effective {{ExitDate}}.\n\nPlease review and approve (or reject) in Termination Approvals — the actual termination (cost proration, FNF, future-month cleanup) is only applied once approved.\n\nRegards,\nHR Team, GenAquarius");

  // ---- Finance's own templated emails (everything except Invoice emails, which stay on the
  // separate invoice-email-template system) — surfaced on Administration → Finance Settings →
  // Email Templates, same key+businessUnitId model/null-fallback as every template above.
  await upsertEmailTemplateDefault("FNF_SETTLEMENT_SEND", "Full & Final Settlement — {{EmployeeName}}",
    "Dear {{EmployeeFirstName}},\n\nPlease find attached your Full & Final Settlement statement.\n\nRegards,\n{{SignatoryName}}");
  await upsertEmailTemplateDefault("TERMINATION_COMPLETED_NOTICE", "Termination completed: {{EmployeeName}} ({{EmployeeId}})",
    "Hi,\n\nThe termination for {{EmployeeName}} ({{EmployeeId}}) has been approved and completed.\nExit Date: {{ExitDate}}\nFinal Termination Month Cost: ${{MonthCost}}\nFnF Amount: ${{FnfAmount}}\n\nThey now appear in Past / Terminated Employees.\n\nRegards,\nGenAquarius");
  await upsertEmailTemplateDefault("IT_DISABLE_ACCOUNT_NOTICE", "Action required: disable O365 account for {{EmployeeName}} ({{EmployeeId}})",
    "Hi,\n\nThe termination for {{EmployeeName}} ({{EmployeeId}}) has been finalized and their Office 365 account is ready to be disabled.\n\nPlease deactivate their email account in the Microsoft 365 admin center.\n\nRegards,\nGenAquarius");
  await upsertEmailTemplateDefault("IT_PROVISIONING_CANCELLED", "IT provisioning cancelled: {{CandidateName}}",
    "Hi,\n\nFinance rejected the CTC for {{CandidateName}} — this hire did not go through, and the pending IT provisioning request for them has been cancelled and removed from your Pending Tasks.\n\nNo action needed — please do not proceed with setting up their laptop or email account.\n\nRegards,\nGenAquarius HR/Finance");

  // ---- Appraisal ("Annual Performance Review") letter — default body matches the real reference
  // "0033. Annual Performance Review - Vaishali Lambat.pdf" paragraph for paragraph. ----
  await prisma.hrAppraisalTemplate.upsert({
    where: { id: 1 }, update: {},
    create: {
      id: 1, name: "GenAquarius Standard", isDefault: true,
      bodyText: "We are pleased to inform you that based on your performance during the appraisal period, your contributions have been recognized and appreciated by the management. Your consistent dedication, teamwork, and commitment to high-quality work have added significant value to our organization.\n\nAs a result of your overall performance, we are happy to inform you that your CTC stands revised to {{RevisedCompensation}} with effective from {{EffectiveDate}}.\n\n{{DesignationChangeNote}}\n\nThe detailed compensation structure is attached as Annexure 1. Please note that your salary details are confidential and private, and we expect you to maintain strict confidentiality on the same.\n\nWe look forward to your continued excellence and contribution toward the goals of the company. Please keep up the good work and continue inspiring others through your professionalism and work ethic.\n\nAll other terms and conditions of your appointment will remain same.",
    },
  });
  await upsertEmailTemplateDefault("APPRAISAL_LETTER_EMAIL", "Your Annual Performance Review — GenAquarius",
    "Dear {{EmployeeFirstName}},\n\n<b>Congratulations on successfully completing your Annual Performance Review!</b> We appreciate your contributions, commitment, and efforts toward the growth and success of GenAquarius.\n\nPlease find attached your Annual Performance Review for your reference.\n\nWe are pleased to inform you that your CTC stands revised to <b>{{RevisedCompensation}}</b>, effective <b>{{EffectiveDate}}</b>.\n\nWe look forward to your continued contribution and success with GenAquarius.\n\n<b>Congratulations once again, and best wishes for the year ahead!</b>\n\nWarm regards,\n<b>HR Team</b>\nGenAquarius");
  // Used instead of APPRAISAL_LETTER_EMAIL whenever the appraisal has a second (staged) tranche —
  // separate template so HR can word the two-tranche email differently, with both dates/CTCs as
  // their own placeholders rather than one combined auto-generated sentence.
  await upsertEmailTemplateDefault("APPRAISAL_LETTER_EMAIL_STAGE", "Your Annual Performance Review — GenAquarius",
    "Dear {{EmployeeFirstName}},\n\n<b>Congratulations on successfully completing your Annual Performance Review!</b> We appreciate your contributions, commitment, and efforts toward the growth and success of GenAquarius.\n\nPlease find attached your Annual Performance Review for your reference.\n\nWe are pleased to inform you that your CTC will be revised in two tranches:\n\n• <b>{{RevisedCompensation}}</b>, effective <b>{{EffectiveDate}}</b>\n• <b>{{SecondRevisedCompensation}}</b>, effective <b>{{SecondEffectiveDate}}</b>\n\nWe look forward to your continued contribution and success with GenAquarius.\n\n<b>Congratulations once again, and best wishes for the year ahead!</b>\n\nWarm regards,\n<b>HR Team</b>\nGenAquarius");
  await upsertEmailTemplateDefault("APPRAISAL_CTC_APPROVAL_REQUEST", "Action needed: appraisal CTC approval for {{EmployeeName}} ({{EmployeeId}})",
    "Hi Finance,\n\nHR has issued a revised appraisal for {{EmployeeName}} ({{EmployeeId}}) — CTC revised to {{RevisedCompensation}}, effective {{EffectiveDate}}.\n\nPlease review and approve (or reject) in Appraisal Approvals — the new CTC Record is only created once approved.\n\nRegards,\nHR Team, GenAquarius");

  // Common IT-industry designation ladder (HR-requested) — seeded unconditionally alongside the
  // dynamic backfill below, so the Organization → Designations list starts populated even before
  // any real offers reference these titles. Idempotent (upsert on the unique `name`).
  const IT_DESIGNATION_LADDER = [
    "Software Engineer", "Senior Software Engineer", "Data Engineer", "Senior Data Engineer",
    "QA Engineer", "Senior QA Engineer", "Team Lead", "Project Lead", "Project Manager",
    "Senior Project Manager", "Technical Manager", "Technical Architect", "Senior Technical Architect",
    "Engineering Manager", "Associate Director", "Director", "Vice President",
    "Chief Technology Officer", "Chief Executive Officer",
  ];
  const existingBeforeLadder = await prisma.hrDesignation.findMany({ select: { name: true } });
  const knownBeforeLadder = new Set(existingBeforeLadder.map((d) => d.name));
  let ladderOrder = existingBeforeLadder.length;
  for (const name of IT_DESIGNATION_LADDER) {
    if (knownBeforeLadder.has(name)) continue;
    await prisma.hrDesignation.upsert({ where: { name }, update: {}, create: { name, order: ladderOrder++ } });
  }

  // Backfill HrDesignation (the Generate Offer dropdown's master list) with every designation
  // already in use across the system — Offer.designation and Appraisal.designation are the only
  // two places a designation string is stored (Employee itself has no designation field). Purely
  // additive/create-only (upsert on the unique `name`), so re-running never removes an HR-added
  // designation that happens to have zero offers/appraisals referencing it yet.
  const [offerDesignations, appraisalDesignations, existingDesignations] = await Promise.all([
    prisma.offer.findMany({ select: { designation: true }, distinct: ["designation"] }),
    prisma.appraisal.findMany({ select: { designation: true }, distinct: ["designation"] }),
    prisma.hrDesignation.findMany({ select: { name: true } }),
  ]);
  const known = new Set(existingDesignations.map((d) => d.name));
  const toAdd = new Set<string>();
  [...offerDesignations, ...appraisalDesignations].forEach((r) => {
    const name = (r.designation || "").trim();
    if (name && !known.has(name)) toAdd.add(name);
  });
  let order = existingDesignations.length;
  for (const name of toAdd) {
    await prisma.hrDesignation.upsert({ where: { name }, update: {}, create: { name, order: order++ } });
  }
  const designationMsg = toAdd.size ? `Backfilled ${toAdd.size} existing designation(s) into HrDesignation: ${[...toAdd].join(", ")}` : "No new designations to backfill.";
  console.log(designationMsg);

  // Same backfill for HrDepartment — Offer.department is the only place a department string is
  // stored (Employee has no department field, and Appraisal doesn't snapshot one either).
  const [offerDepartments, existingDepartments] = await Promise.all([
    prisma.offer.findMany({ select: { department: true }, distinct: ["department"] }),
    prisma.hrDepartment.findMany({ select: { name: true } }),
  ]);
  const knownDepts = new Set(existingDepartments.map((d) => d.name));
  const deptsToAdd = new Set<string>();
  offerDepartments.forEach((r) => {
    const name = (r.department || "").trim();
    if (name && !knownDepts.has(name)) deptsToAdd.add(name);
  });
  let deptOrder = existingDepartments.length;
  for (const name of deptsToAdd) {
    await prisma.hrDepartment.upsert({ where: { name }, update: {}, create: { name, order: deptOrder++ } });
  }
  const departmentMsg = deptsToAdd.size ? `Backfilled ${deptsToAdd.size} existing department(s) into HrDepartment: ${[...deptsToAdd].join(", ")}` : "No new departments to backfill.";
  console.log(departmentMsg);

  // Explicit HR request: any existing employee with no department on record defaults to "IT"
  // (rather than being left blank) — ensure "IT" exists in the master list first.
  await prisma.hrDepartment.upsert({ where: { name: "IT" }, update: {}, create: { name: "IT", order: deptOrder } });
  const { count: itBackfillCount } = await prisma.employee.updateMany({ where: { department: null }, data: { department: "IT" } });
  const employeeDeptMsg = itBackfillCount ? `Defaulted ${itBackfillCount} existing employee(s) with no department on record to "IT".` : "No employees needed a department default.";
  console.log(employeeDeptMsg);

  console.log("HR configuration seeded.");
  return `${designationMsg} ${departmentMsg} ${employeeDeptMsg}`;
}

// One-time patch for the IT_PROVISIONING_NOTIFICATION default row already saved to prod BEFORE
// {{shippingAddress}} was added to it — upsertEmailTemplateDefault() above only fills a missing
// row, it never updates an existing one, so re-running main() alone would not pick up this fix.
// Only touches the company-wide default (businessUnitId:null) row, and only if it still has the
// old body text (i.e. does nothing, safely, if Finance has since customized it themselves).
export async function patchItProvisioningShippingAddress() {
  const existing = await prisma.hrEmailTemplate.findFirst({ where: { key: "IT_PROVISIONING_NOTIFICATION", businessUnitId: null } });
  if (!existing) return "No IT_PROVISIONING_NOTIFICATION default row found — nothing to patch.";
  if (existing.body.includes("{{shippingAddress}}")) return "Already includes {{shippingAddress}} — no change made.";
  const patchedBody = existing.body.replace(
    /RAM:\s*\{\{ram\}\}/,
    "RAM: {{ram}}\n\nShipping Address: {{shippingAddress}}",
  );
  if (patchedBody === existing.body) return "Could not find the expected insertion point — left unchanged; patch the body manually.";
  await prisma.hrEmailTemplate.update({ where: { id: existing.id }, data: { body: patchedBody } });
  return "Patched IT_PROVISIONING_NOTIFICATION default body to include {{shippingAddress}}.";
}

if (require.main === module) {
  main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
}
