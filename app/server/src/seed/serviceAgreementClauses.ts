// Default Service Agreement (CONTRACTOR) clause library — transcribed VERBATIM from the real
// "Service Agreement.docx" reference file (confirmed via PyMuPDF span extraction of a Word-
// automation PDF conversion of that docx). Shared by seed/seedHr.ts (idempotent upsert into
// HrServiceAgreementTemplate) and any test/verification script that needs the same fixture —
// never hand-duplicated, so the seeded default and anything testing against it can't drift.
import { ServiceAgreementClause } from "../engine/hrPdf";

export const DEFAULT_SERVICES: string[] = ["Technical Analysis", "Data Analysis", "QA", "Professional Services"];

export const SERVICE_AGREEMENT_CLAUSES: Omit<ServiceAgreementClause, "enabled" | "order">[] = [
  {
    key: "opening",
    pointStyle: "plain",
    points: [
      { text: 'This agreement, (hereinafter, “Agreement”), is entered into as of this date, **{{EffectiveDate}}**, by and between **GenAquarius Private Limited**, (hereinafter, “**GenAquarius Private Limited**”), an Indian Company with the registered office in **A-8, Sector-23, Noida, Gautam Buddha Nagar,201301.**' },
      { text: "and", align: "center" },
      { text: '**{{ContractorName}}, (Aadhar No: {{AadharNumber}}) (hereinafter, “Service Provider”) Resident of: {{ContractorAddress}}.**' },
      { text: '(Collectively hereinafter also referred to as the “Parties” or separately as a “Party”)' },
      { text: "The terms of this Agreement shall become effective upon execution." },
      { text: "**The Service Provider agrees as follows:**" },
      { text: "This Agreement constitutes the whole Agreement and any prior understanding or agreement, verbal/written communication is superseded by this Agreement." },
    ],
  },
  {
    key: "article1",
    articleLabel: "Article 1. Performance of Work",
    pointStyle: "lettered",
    points: [
      { text: "Drawing on Service Provider’s knowledge, experience, ability, and technical expertise, Service Provider agrees to provide the following services: -", servicesList: true },
      { text: "The work to be performed herein shall be conducted by the Service Provider as an independent Service Provider and not as an employee of GenAquarius Private Limited. The Service Provider will not be treated as an Employee of GenAquarius Private Limited for Income tax purposes nor other purposes nor will Service Provider be eligible for any employee benefits." },
      { text: "The Service Provider is solely responsible for the manner and means of the performance of the services to be provided herein and is solely responsible for supplying and using any equipment necessary for the performance of the work herein. Therefore, GenAquarius Private Limited will not control the Service Provider’s hours, and the Service Provider can work at the convenience." },
    ],
  },
  {
    key: "article2",
    articleLabel: "Article 2. Term and Termination",
    pointStyle: "lettered",
    points: [
      { text: "GenAquarius Private Limited and/or Service Provider may terminate this Agreement at will upon notifying the other subscribing party." },
    ],
  },
  {
    key: "article3-terms",
    articleLabel: "Article 3. Allowable Costs and Payment",
    romanHeading: "I. TERMS & CONDITION",
    pointStyle: "bulleted",
    points: [
      { text: "This agreement is temporary and will be effective - starting from **{{EffectiveDate}}** onwards." },
      { text: "The payment for the contact duration will be made as per the calculation based on monthly compensation of **{{MonthlyCompensationAmount}} ({{MonthlyCompensationWords}})** and will be paid by the last working day of the month." },
      { text: "Provide all your personal details along with your Indian bank account number for joining as an employee before Termination." },
      { text: "You will receive your payout in the bank account, details of which are provided below:", bankBlock: true },
      { text: "10% taxes will be deducted at source." },
    ],
  },
  {
    key: "article3-expenses",
    articleLabel: "",
    romanHeading: "II. SERVICE PROVIDER EXPENSES",
    pointStyle: "plain",
    points: [
      { text: "GenAquarius Private Limited does not reimburse Service Provider for costs, including but not limited to, travel expenses, incurred while working under this Agreement unless otherwise agreed to by GenAquarius Private Limited and subscribed to by both Service Provider and GenAquarius Private Limited in a written and signed contract." },
    ],
  },
  {
    key: "article4",
    articleLabel: "Article 4. Disputes",
    pointStyle: "plain",
    points: [
      { text: "GenAquarius Private Limited and Service Provider agree to settle disputes amicably." },
    ],
  },
  {
    key: "article5",
    articleLabel: "Article 5. Severability",
    pointStyle: "plain",
    points: [
      { text: "If any provision of this Agreement or its application to any person or circumstance is held invalid or unenforceable, the invalidity does not affect other provisions or applications of this Agreement which can be given effect without the invalid provision or application. Thus, the validity and enforceability of all valid and enforceable provisions shall not in any way be affected or impaired by any invalid or unenforceable provisions." },
    ],
  },
  {
    key: "article6",
    articleLabel: "Article 6. Confidentiality",
    pointStyle: "plain",
    points: [
      { text: "The Service Provider agrees to keep confidential any information furnished or obtained under or in connection with this Agreement or generally concerning the services and shall not divulge the same to any third person/party for any reason whatsoever. If the Service Provider fails to maintain complete confidentiality, then this Agreement shall be summarily terminated." },
    ],
  },
  {
    key: "article7",
    articleLabel: "Article 7. Execution",
    pointStyle: "plain",
    points: [
      { text: "This Agreement is binding on Service Provider and GenAquarius Private Limited, their successors, heirs and assigns when it is signed below by Service Provider and an authorized agent of GenAquarius Private Limited. This document and any attachments hereto constitute the entire agreement between the Parties." },
    ],
  },
  {
    key: "closing",
    articleLabel: "",
    pointStyle: "plain",
    points: [
      { text: "IN WITNESS WHEREOF, each of GenAquarius Private Limited and Service Provider, by its duly authorized representative has executed and delivered this Document as of the date specified above." },
    ],
  },
];
