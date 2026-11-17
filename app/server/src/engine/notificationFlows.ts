// Static catalog of every email "flow" in the app — the source of truth for Administration →
// Notification Settings (per-flow on/off, and for `hasCc` flows, a Finance+HR CC list). A flow
// with no NotificationSetting row is simply enabled with nothing excluded from the default CC pool.
// `hasCc` marks flows where the primary recipient is external/candidate-facing (or otherwise
// financially/HR-sensitive) — Finance/HR CC visibility makes sense there. Purely internal
// notifications (already addressed to Finance/HR/IT by definition) don't get a CC list.
// `cadence` marks the two reminder-style flows configurable for multiple sends/day.
export interface NotificationFlowDef {
  key: string;
  label: string;
  category: string;
  description: string;
  hasCc: boolean;
  // Who the email is actually addressed TO (the primary recipient — a candidate/employee/
  // contractor/signer/manager), shown as its own "To:" pill directly on the flow row so it's
  // never left to be inferred from reading the full description sentence. Set on any flow whose
  // primary recipient is a single individual (not a Finance/HR/IT Admin role broadcast) — hasCc is
  // a separate, narrower flag for whether Finance/HR can ALSO be copied on it.
  to?: string;
  cadence?: boolean;
  // Marks a flow that scans and emails the WHOLE active employee population on a schedule, rather
  // than a single specific recipient tied to one record/event (every other flow here). Shown in its
  // own separate, clearly-labeled bucket in Notification Settings and — unlike every other flow,
  // which is enabled by default when no row exists yet — defaults to OFF until an admin explicitly
  // turns it on. A real incident (ONBOARDING_DOC_REMINDER emailing the entire company, including
  // employees who joined years before the required document type even existed) is why this exists.
  companyWide?: boolean;
}

export const NOTIFICATION_FLOWS: NotificationFlowDef[] = [
  // HR — Offers & Lifecycle
  { key: "OFFER_SEND", label: "Send Offer Letter", category: "HR — Offers & Lifecycle", description: "Emailed to the candidate when HR sends the offer letter.", hasCc: true, to: "The candidate" },
  { key: "OFFER_WITHDRAWN", label: "Offer Withdrawn", category: "HR — Offers & Lifecycle", description: "Emailed to the candidate when an offer is cancelled.", hasCc: true, to: "The candidate" },
  { key: "SERVICE_AGREEMENT_SEND", label: "Send Service Agreement", category: "HR — Offers & Lifecycle", description: "Emailed to the contractor when HR sends the service agreement.", hasCc: true, to: "The contractor" },
  { key: "SERVICE_AGREEMENT_WITHDRAWN", label: "Service Agreement Withdrawn", category: "HR — Offers & Lifecycle", description: "Emailed to the contractor when a service agreement is cancelled.", hasCc: true, to: "The contractor" },
  { key: "APPOINTMENT_SEND", label: "Send Appointment Letter", category: "HR — Offers & Lifecycle", description: "Emailed to the candidate when HR sends the appointment letter.", hasCc: true, to: "The candidate" },
  { key: "WELCOME_EMAIL", label: "Welcome Email (new O365 mailbox)", category: "HR — Offers & Lifecycle", description: "Sent to a new hire's freshly created email once IT Admin marks it created.", hasCc: false, to: "The new hire" },
  { key: "IT_PROVISIONING_REQUEST", label: "New-Hire IT Provisioning Request", category: "HR — Offers & Lifecycle", description: "Notifies the IT/Network Admin role that a new hire needs equipment/mailbox set up.", hasCc: false },
  { key: "IT_PROVISIONING_CANCELLED", label: "IT Provisioning Request Cancelled", category: "HR — Offers & Lifecycle", description: "Notifies the IT/Network Admin role that a pending IT provisioning task was cancelled — the offer was rejected/cancelled/declined/withdrawn/expired, or Finance rejected the CTC.", hasCc: false },
  { key: "CTC_APPROVAL_NOTIFY", label: "New Employee CTC Approval Needed", category: "HR — Offers & Lifecycle", description: "Notifies Finance/CTO/CEO that a new hire's CTC is awaiting approval.", hasCc: false },
  // HR — Termination & FnF
  { key: "TERMINATION_APPROVAL_REQUEST", label: "Termination Approval Requested", category: "HR — Termination & FnF", description: "Notifies Finance/CTO/CEO when HR requests a termination.", hasCc: false },
  { key: "TERMINATION_COMPLETED_NOTICE", label: "Termination Completed", category: "HR — Termination & FnF", description: "Notifies the HR requester + Finance/CTO/CEO once a termination is finalized.", hasCc: false },
  { key: "IT_DISABLE_ACCOUNT_NOTICE", label: "Disable O365 Account (offboarding)", category: "HR — Termination & FnF", description: "Notifies the IT/Network Admin role + HR that a terminated employee's O365 account should be disabled.", hasCc: false },
  { key: "ASSET_COLLECTION_REMINDER", label: "Overdue Asset Collection Reminder", category: "HR — Termination & FnF", description: "Notifies the IT/Network Admin role once when an offboarded employee's asset collection date has passed and the task is still pending.", hasCc: false },
  { key: "FNF_SETTLEMENT_SEND", label: "Send FnF Settlement Statement", category: "HR — Termination & FnF", description: "Emailed to the employee when Finance sends the Full & Final settlement document.", hasCc: true, to: "The (terminated) employee" },
  { key: "DOCUMENT_COLLECTION_REQUEST", label: "Send Document Collection Request", category: "HR — Offers & Lifecycle", description: "Emailed to the candidate's personal email with the secure link to upload mandatory documents.", hasCc: true, to: "The candidate (personal email)" },
  // HR — Appraisals
  { key: "APPRAISAL_SEND", label: "Send Appraisal Letter", category: "HR — Appraisals", description: "Emailed to the employee when HR issues their Annual Performance Review letter.", hasCc: true, to: "The employee" },
  { key: "APPRAISAL_CTC_APPROVAL_NOTIFY", label: "Appraisal CTC Approval Needed", category: "HR — Appraisals", description: "Notifies Finance/CTO/CEO that a revised appraisal CTC is awaiting approval.", hasCc: false },
  // Timesheets
  { key: "TIMESHEET_REMINDER", label: "Automated Timesheet Reminder", category: "Timesheets", description: "Daily nudge to employees with a pending timesheet action.", hasCc: false, cadence: true, companyWide: true, to: "The employee (with a pending timesheet)" },
  { key: "TIMESHEET_MANUAL_REMINDER", label: "Manual Timesheet Reminder", category: "Timesheets", description: "One-off reminder a manager sends from the Approvals screen.", hasCc: true, to: "The employee being reminded" },
  // ESS
  { key: "ONBOARDING_DOC_REMINDER", label: "Onboarding Document Reminder", category: "ESS", description: "Daily nudge to employees with pending onboarding document uploads.", hasCc: false, cadence: true, companyWide: true, to: "The employee (with pending documents)" },
  { key: "ESS_REGULARIZATION_CC", label: "Regularization/Permission Request CC", category: "ESS", description: "Copies the employee-selected recipients when a regularization/permission request is raised.", hasCc: false },
  // IT Helpdesk
  { key: "HELPDESK_NOTIFY_IT", label: "New Ticket → Notify IT Agents", category: "IT Helpdesk", description: "Notifies all IT/Network Admin users when a new ticket needs attention.", hasCc: false },
  { key: "HELPDESK_NOTIFY_REQUESTER", label: "Ticket Update → Notify Requester", category: "IT Helpdesk", description: "Notifies the requester when their ticket's status changes.", hasCc: false, to: "The ticket requester" },
  { key: "HELPDESK_APPROVAL_NEEDED", label: "Ticket Manager Approval Needed", category: "IT Helpdesk", description: "Notifies the requester's manager that a ticket needs their approval.", hasCc: false, to: "The requester's manager" },
  // E-Signature
  { key: "ADOBE_SIGN_INVITE", label: "Adobe Sign — Send for Signature", category: "E-Signature", description: "Emailed to the signer with their Adobe Sign signing link.", hasCc: true, to: "The signer (candidate/employee/contractor)" },
  { key: "ADOBE_SIGN_SIGNED_NOTICE", label: "Adobe Sign — Signed Notice", category: "E-Signature", description: "Notifies HR when a document is signed via Adobe Sign.", hasCc: false },
  { key: "ADOBE_SIGN_DECLINED_NOTICE", label: "Adobe Sign — Declined Notice", category: "E-Signature", description: "Notifies HR when a document is declined via Adobe Sign.", hasCc: false },
  // Finance / Executive
  { key: "MONTHLY_FORECAST_IMPACT", label: "Monthly Forecast Change Impact", category: "Finance — Monthly Forecast", description: "Live feed on the Finance/Executive Dashboard of every line added/edited/removed in Monthly Forecast and its $ impact on Revenue, Salary Expense, Total Cost and Profit. Turning this off stops both the feed and its real-time push — it is not an email.", hasCc: false },
];

export const NOTIFICATION_FLOW_BY_KEY = new Map(NOTIFICATION_FLOWS.map((f) => [f.key, f]));
