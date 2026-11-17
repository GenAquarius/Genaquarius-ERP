// Seed for the new US/Canada simplified onboarding feature — NOT run automatically anywhere
// (no other seed file imports/calls this one). Run manually once, after the schema migration,
// with: npx ts-node src/seed/seedUsCanadaOnboarding.ts  (or the compiled dist/ equivalent).
// Idempotent: every create is guarded by a findFirst/upsert check, safe to re-run.
//
// Creates:
//  1. The two new Business Units (GenAquarius LLC / US, Aquarius Technologies Limited / Canada).
//  2. Default MsaTemplate + SowTemplate rows for each, reproducing the real signed
//     "GenAquarius MSA/SOW - Vijay Kumar" samples clause-for-clause, with the vendor/consultant/
//     rate/client specifics turned into {{placeholders}} (see engine/hrPdf.ts's renderMsaSowPdf /
//     routes/hrms/hrOffers.ts's renderMsaOrSowPdfBuffer for exactly which keys are filled).
//  3. A PUBLISHED WorkflowDefinition (employmentType: "US_CANADA", see engine/workflow.ts's
//     workflowBucketFor) with the 3 stages from the signed-off artifact design: Capture
//     Information -> Agreement & Signature -> Onboarding Activation. Resume and SSN/SIN are
//     explicitly optional per the latest instruction (requiredDocuments[].required: false).
import { prisma } from "../prisma";

const MSA_BODY = `{{EntityName}}.
MASTER SERVICES AGREEMENT

This Master Services Agreement (this "Agreement") is made by and between {{EntityName}}., and {{VendorName}} Federal Employer Identification Number: {{VendorEin}}, ("Service Provider").

1 TERM OF CONTRACT
1.1 Term: This Agreement will become effective on {{EffectiveDate}} and will continue in effect for a term of 1 (One) Year (the "Term"), or until terminated pursuant to the provisions of this Agreement.

2 SERVICES TO BE PERFORMED BY SERVICE PROVIDER
2.1 Specific Services: Service Provider agrees to provide the services specified in the Statement of Work ("Services"), attached to this Agreement as Schedule 1 and incorporated herein by reference ("SOW").
2.2 Control: {{EntityName}} shall not control or direct the manner or means by which Service Provider performs the Services, including but not limited to, the time and place Services are performed.
2.3 Third-Party Rules: Service Provider may be required to provide Services to a third-party client of {{EntityName}} ("Client") and therefore may report to Client's Manager ("Manager"). Service Provider shall comply with all rules and procedures communicated to Service Provider by the Client or the Manager, including those related to safety, security, and confidentiality.
2.4 Quality Assurance: If within fifteen (15) days from the date the Services start, {{EntityName}} notifies Service Provider that the Client is not satisfied with the Services, Service Provider will not raise any invoice for such services or refund 100% of the fees paid, if any for the unsatisfactory services, or reperform the services as per the Client requirement.

3 RELATIONSHIP OF THE PARTIES
3.1 Status of Service Provider and its Employees: Service Provider is an independent contractor, and it is not an employee of {{EntityName}}. Service Provider shall not have authority (and shall not hold itself out as having authority) to bind {{EntityName}} and shall not make any agreements or representations on behalf of {{EntityName}} without {{EntityName}}'s prior written consent.
3.2 No Benefits Conferred: Service Provider and Service Provider's employees are not entitled to any benefits {{EntityName}} may provide its employees. Service Provider is solely responsible for all applicable tax and withholding requirements with respect to any and all compensation paid to Service Provider hereunder, including income, payroll, social security, or other federal, state, or local taxes, as well as insurance contributions, including unemployment or disability and workers compensation insurance.

4 FEES AND EXPENSES
4.1 Schedule of Payments: {{EntityName}} shall pay all undisputed invoices to Service Provider according to the schedule of payments in the SOW.
4.2 Billing and Payment: Service Provider agrees to invoice {{EntityName}} on a monthly fiscal basis. {{EntityName}} agrees to pay Service Provider for the Services according to the billable hourly rate specified in the SOW. All payments will be made within 30 days of the receipt of invoice from Service Provider.
4.3 Service Provider should directly submit its invoices along with approved timesheet to Finance@genaquarius.com. Service vendors also need to provide mandatory ACH direct deposit information with either bank letter or void check to the AP email ID above.
4.4 Approval of Time Sheets and Invoices: All invoices presented by Service Provider must be accompanied by time sheets signed by a manager or electronically approved by a manager.
4.5 Expenses: Service Provider shall solely be responsible for any travel or other costs or expenses incurred in connection with the performance of the Services, and in no event shall {{EntityName}} reimburse Service Provider for any such costs or expenses, except those which have been preapproved by {{EntityName}} in writing.

5 OBLIGATIONS OF SERVICE PROVIDER
5.1 Liability Insurance: Service Provider agrees to obtain general liability insurance coverage in the following amounts: comprehensive form, bodily injury and property damage combined $1,000,000 each occurrence; $1,000,000 aggregate.
5.2 Indemnification: Service Provider shall defend, indemnify, and hold harmless {{EntityName}} and its affiliates and its officers, directors, employees, agents, successors, and assigns from and against all losses, damages, liabilities, deficiencies, actions, judgments, awards, penalties, fines, costs, or expenses of whatever kind (including reasonable attorneys' fees) arising out of or resulting from Service Provider's acts or omissions.
5.3 Non-Solicitation of Employees: During the Term and for a period of three years following the termination or expiration of this Agreement, Service Provider shall not solicit, recruit, or induce the termination of employment of any {{EntityName}} employee.
5.5 Representations and Warranties: Service Provider represents and warrants that it has the right to enter into this Agreement, that its employees possess the required skill and qualifications to perform the Services, and that its employees have the legal right to work in the country where they provide Services.

6 OBLIGATIONS OF {{EntityName}}
6.1 Cooperation: {{EntityName}} agrees to comply with all reasonable requests of Service Provider made in the performance of the agreed upon services.

7 INTELLECTUAL PROPERTY RIGHTS
7.1 Confidentiality: Service Provider may have access to information that is treated as confidential and proprietary by {{EntityName}} or its Client. Service Provider agrees to treat all such Confidential Information as strictly confidential and not to disclose it to any third party without prior written consent.
7.2 Work Product: Client is and will be the sole and exclusive owner of all right, title, and interest in and to all Work Product produced under this Agreement, deemed "work made for hire".

8 TERMINATION
8.1 Notice Termination: Either party may terminate this Agreement at any time without cause by providing written notice of at least fifteen (15) days.
8.2 Termination for Cause: Either party may terminate this Agreement, effective immediately upon written notice, if the other party breaches this Agreement.

9 GENERAL PROVISIONS
9.1 Assignment: Service Provider shall not assign any rights or delegate any obligations under this Agreement without {{EntityName}}'s prior written consent.
9.2 Entire Agreement: This Agreement supersedes any and all prior agreements between the parties with respect to the Services.
9.5 Choice of Law: This Agreement will be governed by and construed in accordance with the laws of {{GoverningLaw}}.
9.6 Arbitration: Any controversy or claim arising from or relating to this Agreement shall be settled by arbitration in accordance with the rules of the American Arbitration Association.

{{EntityName}}.
( )
(Signature)

{{VendorName}}
( )
(Signature)

{{EntityAddress}}
{{VendorAddress}}`;

const SOW_BODY = `{{EntityName}}.
STATEMENT OF WORK

This Statement of Work (this "SOW") is made by and between {{EntityName}}., and {{VendorName}} Federal Employer Identification Number {{VendorEin}}, ("Service Provider").

1. This SOW adopts and incorporates by reference the terms and conditions of the Master Service Agreement entered by the Parties as of {{EffectiveDate}}, including all Annexures, Appendices, Exhibits and Schedules, if any, attached thereto (the "MSA"). The Services shall be governed by the general terms and conditions contained in the MSA. All capitalized terms not otherwise defined herein shall have the meaning provided in the MSA.

2. Service Provider agrees to provide the following Services to {{EntityName}}:
{{VendorName}} will deploy {{ConsultantName}} to support {{EntityName}} {{ClientName}} project. {{ConsultantName}} will provide services on a Time & Material (T&M) basis.
{{EngagementDescription}}

3. {{EntityName}} agrees to pay Service Provider according to the following payment schedule:
a. Consultant name: {{ConsultantName}}
b. Start date: {{StartDate}}
c. Rate: {{HourlyRate}}
d. Payment schedule: As Per MSA (Net 30 days)
e. Client Name: {{ClientName}}
f. All costs and expenses must be preapproved by {{EntityName}} in writing to be reimbursed.
g. Service Provider will not outsource or subcontract work to any other person other than the resource named in this SOW.
h. Billing will be on a time and material basis. Payments will be made for all hours worked and approved by the client.
i. The Service Provider shall not, directly or indirectly, approach, solicit, or offer employment to any customer or client of {{EntityName}} without {{EntityName}}'s prior written consent.

{{EntityName}}.
(Signature) ( )

{{VendorName}}
(Signature) ( )

{{EntityAddress}}
{{VendorAddress}}`;

async function ensureBusinessUnit(name: string, countryCode: string) {
  const existing = await prisma.hrBusinessUnit.findUnique({ where: { name } });
  if (existing) return existing;
  return prisma.hrBusinessUnit.create({ data: { name, countryCode } });
}

async function ensureMsaTemplate(businessUnitId: number, entityName: string, entityAddress: string, governingLaw: string) {
  const existing = await prisma.msaTemplate.findFirst({ where: { businessUnitId, isDefault: true } });
  if (existing) return existing;
  return prisma.msaTemplate.create({ data: { name: `${entityName} — Default MSA`, businessUnitId, entityName, entityAddress, governingLaw, bodyText: MSA_BODY, isDefault: true } });
}

async function ensureSowTemplate(businessUnitId: number, entityName: string, entityAddress: string) {
  const existing = await prisma.sowTemplate.findFirst({ where: { businessUnitId, isDefault: true } });
  if (existing) return existing;
  return prisma.sowTemplate.create({ data: { name: `${entityName} — Default SOW`, businessUnitId, entityName, entityAddress, bodyText: SOW_BODY, isDefault: true } });
}

// Mirrors the artifact's Stage 1 "Supporting Documents" list exactly — Resume and SSN/SIN are
// explicitly NOT required (per the latest instruction), everything else optional too; the
// MSA/SOW/Offer Letter signing documents live in Stage 2 (AGREEMENT_SIGNATURE), not here.
function captureInformationDocs() {
  return [
    { docType: "RESUME", label: "Resume", required: false, candidateUpload: false, hrVerification: false, allowReupload: true, multipleFiles: false, order: 1 },
    { docType: "SSN_SIN_DOCUMENT", label: "SSN / SIN Document", required: false, candidateUpload: false, hrVerification: false, allowReupload: true, multipleFiles: false, order: 2 },
    { docType: "WORK_AUTHORIZATION", label: "Work Authorization (EAD / Visa / Work Permit)", required: false, candidateUpload: false, hrVerification: false, allowReupload: true, multipleFiles: false, order: 3 },
    { docType: "DRIVERS_LICENSE", label: "Driver's License / Photo ID", required: false, candidateUpload: false, hrVerification: false, allowReupload: true, multipleFiles: false, order: 4 },
    { docType: "EDUCATION_CERTIFICATE", label: "Education Certificate", required: false, candidateUpload: false, hrVerification: false, allowReupload: true, multipleFiles: false, order: 5 },
    { docType: "PHOTO", label: "Photo", required: false, candidateUpload: false, hrVerification: false, allowReupload: true, multipleFiles: false, order: 6 },
  ];
}

async function ensureUsCanadaWorkflow() {
  const existing = await prisma.workflowDefinition.findFirst({ where: { employmentType: "US_CANADA", status: "PUBLISHED" }, include: { stages: true } });
  if (existing) return existing;
  const wf = await prisma.workflowDefinition.create({
    data: {
      name: "US/Canada Onboarding", employmentType: "US_CANADA", version: 1, status: "PUBLISHED",
      appliesTo: "NEW_ONLY", publishedAt: new Date(),
      stages: {
        create: [
          {
            key: "capture-information", name: "Capture Information", stageType: "CAPTURE_INFORMATION", order: 1,
            enabled: true, required: true, candidateFacing: "HR_ONLY", completionMode: "AUTO",
            requiredDocuments: captureInformationDocs() as any,
          },
          {
            key: "agreement-signature", name: "Agreement & Signature", stageType: "AGREEMENT_SIGNATURE", order: 2,
            enabled: true, required: true, candidateFacing: "BOTH", completionMode: "AUTO",
            dependsOnKeys: ["capture-information"] as any,
          },
          {
            key: "onboarding-activation", name: "Onboarding Activation", stageType: "ONBOARDING_ACTIVATION", order: 3,
            enabled: true, required: true, candidateFacing: "HR_ONLY", completionMode: "MANUAL",
            dependsOnKeys: ["agreement-signature"] as any,
          },
        ],
      },
    },
    include: { stages: true },
  });
  return wf;
}

export async function main() {
  const genAquariusLlc = await ensureBusinessUnit("GenAquarius LLC", "US");
  const aquariusTech = await ensureBusinessUnit("Aquarius Technologies Limited", "CANADA");

  await ensureMsaTemplate(genAquariusLlc.id, "GenAquarius LLC", "2795 E Bidwell St. Suite 100-662, Folsom, CA 95630, USA", "the State of California");
  await ensureSowTemplate(genAquariusLlc.id, "GenAquarius LLC", "2795 E Bidwell St. Suite 100-662, Folsom, CA 95630, USA");
  await ensureMsaTemplate(aquariusTech.id, "Aquarius Technologies Limited", "", "the Province of Ontario");
  await ensureSowTemplate(aquariusTech.id, "Aquarius Technologies Limited", "");

  const wf = await ensureUsCanadaWorkflow();

  console.log(`Business Units: GenAquarius LLC #${genAquariusLlc.id}, Aquarius Technologies Limited #${aquariusTech.id}`);
  console.log(`US/Canada WorkflowDefinition #${wf.id} (v${wf.version}, PUBLISHED) with ${wf.stages?.length ?? "?"} stages`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
