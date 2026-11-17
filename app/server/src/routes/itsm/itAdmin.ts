// IT Admin module — the task queue behind the IT_ADMIN role. Version 1: new-hire O365 mailbox
// creation, triggered by HR's IT Provisioning Request (hrOffers.ts). Asset Tracker and IT Service
// Requests are planned future additions to this same module (specs pending) — kept in their own
// file from the start so they can be added here without touching hrOffers.ts again.
import { Router } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../../prisma";
import { requireRole, ADMIN_ROLES, hashPassword } from "../../auth/auth";
import { fillTemplate } from "../../engine/hr";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { emitPendingActionsUpdate, emitHelpdeskUpdate, emitEsignUpdate } from "../../engine/realtime";
import { itAdminEmails } from "../../engine/itAdmin";
import { getGraphAdminConfig, createO365Mailbox, assignLicenseToUser, setUserManager, findGroupByName, addUserToGroup, disableO365Account, removeAllLicenses, removeUserFromGroup, resolveGraphUserId, genTempPassword, getUserGroupMemberships } from "../../engine/graphAdmin";
import { audit } from "../hrms/hrOffers";
import { renderLaptopHandoverPdf } from "../../engine/laptopHandoverPdf";
import { getAdobeAuthConfig, uploadTransientDocument, createAgreement, getSigningUrl } from "../../engine/adobeSign";


const router = Router();
router.use(requireRole(Role.IT_ADMIN, ...ADMIN_ROLES));

// Section 7 — full request detail (name/email/job title/department/laptop config/RAM/other
// requirements) included directly on the Pending Task row, so IT Admin never has to navigate
// elsewhere to see everything about the request.
// Address fields included so IT Admin can see where the laptop actually needs to ship — Onboarding
// already collects this as the candidate's Resident Address ("current/where equipment ships"),
// which defaults to same-as-Permanent unless the candidate gave a different current address.
const TASK_OFFER_SELECT = {
  id: true, candidateName: true, candidateFirstName: true, candidateLastName: true, candidateEmail: true, designation: true, department: true, reportingManager: true, employmentType: true, proposedJoiningDate: true, reservedEmpNo: true, employeeId: true, countryCode: true,
  candidateAddress: true, candidateCity: true, candidateLandmark: true, candidateState: true, candidatePincode: true,
  residentSameAsPermanent: true, residentAddress: true, residentCity: true, residentLandmark: true, residentState: true, residentPincode: true,
} as const;

// Open tasks: an IT Provisioning Request that's been sent to IT but not yet marked complete.
router.get("/tasks", async (_req, res) => {
  const rows = await prisma.itProvisioningRequest.findMany({
    where: { sentAt: { not: null }, emailCreatedAt: null },
    include: { offer: { select: TASK_OFFER_SELECT } },
    orderBy: { sentAt: "asc" },
  });
  res.json(rows);
});
// History: already-completed tasks, most recent first.
router.get("/tasks/history", async (_req, res) => {
  const rows = await prisma.itProvisioningRequest.findMany({
    where: { emailCreatedAt: { not: null } },
    include: { offer: { select: TASK_OFFER_SELECT } },
    orderBy: { emailCreatedAt: "desc" },
    take: 50,
  });
  res.json(rows);
});

// IT Admin's own Display Name input (Section 8) — saved independently of Approve so it isn't lost
// if IT Admin fills it in, gets interrupted, and comes back later. Also lets IT Admin correct every
// other field HR submitted (Email ID to Create / OS Requirement / Laptop Configuration / Phone /
// Requested Applications / Access Requirements / Other Requirements / ship-to Address) before
// Approve, for the same reason (a typo or a spec change shouldn't require sending HR back to redo
// the request) — each field only updates when actually present in the body, so a partial save
// never blanks the others. Personal Email is the one exception: it lives on the Offer itself (used
// everywhere in onboarding, not just here), so correcting it here updates the Offer directly rather
// than a local IT-only copy.
router.put("/tasks/:offerId", async (req, res) => {
  const offerId = Number(req.params.offerId);
  const reqRow = await prisma.itProvisioningRequest.findUnique({ where: { offerId } });
  if (!reqRow) return res.status(404).json({ error: "IT Provisioning Request not found" });
  const b = req.body || {};
  const updated = await prisma.itProvisioningRequest.update({ where: { offerId }, data: {
    displayName: b.displayName ?? reqRow.displayName,
    emailIdToCreate: b.emailIdToCreate !== undefined ? b.emailIdToCreate : reqRow.emailIdToCreate,
    osRequirement: b.osRequirement !== undefined ? b.osRequirement : reqRow.osRequirement,
    laptopConfiguration: b.laptopConfiguration !== undefined ? b.laptopConfiguration : reqRow.laptopConfiguration,
    phoneNumber: b.phoneNumber !== undefined ? (b.phoneNumber || null) : reqRow.phoneNumber,
    requiredApplications: b.requiredApplications !== undefined ? (b.requiredApplications || null) : reqRow.requiredApplications,
    requiredAccess: b.requiredAccess !== undefined ? (b.requiredAccess || null) : reqRow.requiredAccess,
    otherRequirements: b.otherRequirements !== undefined ? (b.otherRequirements || null) : reqRow.otherRequirements,
    shipToAddress: b.shipToAddress !== undefined ? (b.shipToAddress || null) : reqRow.shipToAddress,
  } });
  if (b.personalEmail !== undefined && b.personalEmail.trim()) {
    await prisma.offer.update({ where: { id: offerId }, data: { candidateEmail: b.personalEmail.trim() } });
  }
  res.json(updated);
});

// ------------------------------------------------------------------ Group Checklist (configurable Intune/Entra groups) ----
// Admin Settings catalog backing both the Pending Tasks "Group Assignment Checklist" (Approve) and
// the Offboarding "Deactivation Checklist" (group removal) — `name` must exactly match the real
// Entra group displayName (resolved via findGroupByName at confirm time).
router.get("/group-defs", async (req, res) => {
  const scope = String(req.query.scope || "");
  res.json(await prisma.itGroupDef.findMany({
    where: scope ? { OR: [{ scope }, { scope: "BOTH" }] } : {},
    orderBy: [{ order: "asc" }, { id: "asc" }],
  }));
});
router.post("/group-defs", async (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: "Group name is required" });
  res.status(201).json(await prisma.itGroupDef.create({ data: { name: b.name.trim(), scope: b.scope || "BOTH", enabled: b.enabled !== false, order: Number(b.order) || 0 } }));
});
router.put("/group-defs/:id", async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const data: any = {};
  if (b.name !== undefined) data.name = String(b.name).trim();
  if (b.scope !== undefined) data.scope = b.scope;
  if (b.enabled !== undefined) data.enabled = !!b.enabled;
  if (b.order !== undefined) data.order = Number(b.order) || 0;
  res.json(await prisma.itGroupDef.update({ where: { id }, data }));
});
router.delete("/group-defs/:id", async (req, res) => {
  await prisma.itGroupDef.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
});

// Onboarding checklist shown before Approve — the FULL configured ONBOARDING/BOTH catalog, not
// filtered by current membership (a brand-new hire has no prior memberships to filter against,
// unlike the offboarding removal checklist below).
router.get("/tasks/:offerId/group-checklist", async (_req, res) => {
  res.json(await prisma.itGroupDef.findMany({ where: { enabled: true, OR: [{ scope: "ONBOARDING" }, { scope: "BOTH" }] }, orderBy: [{ order: "asc" }, { id: "asc" }] }));
});

// Offboarding checklist shown before Confirm Deactivation — ONLY groups the employee is actually,
// currently a member of (per spec: "do not show groups where the employee is not currently a
// member"), fetched live from Graph every time the checklist opens.
router.get("/offboarding-tasks/:id/group-checklist", async (req, res) => {
  const id = Number(req.params.id);
  const reqRow = await prisma.itOffboardingRequest.findUnique({ where: { id }, include: { employee: { select: { email: true } } } });
  if (!reqRow) return res.status(404).json({ error: "Offboarding task not found" });
  const configured = await prisma.itGroupDef.findMany({ where: { enabled: true, OR: [{ scope: "OFFBOARDING" }, { scope: "BOTH" }] } });
  if (!configured.length || !reqRow.employee.email) return res.json([]);
  const graphCfg = await getGraphAdminConfig();
  if (!graphCfg.enabled) return res.json([]);
  try {
    const current = await getUserGroupMemberships(reqRow.employee.email);
    const currentNames = new Set(current.map((g) => g.displayName.toLowerCase()));
    res.json(configured.filter((g) => currentNames.has(g.name.toLowerCase())).sort((a, b) => a.order - b.order || a.id - b.id));
  } catch (e: any) {
    res.status(400).json({ error: `Failed to fetch current group memberships from Microsoft Graph: ${e.message}` });
  }
});

// Approve — marks the O365 mailbox as created, emails the Office 365 Admin the full compiled
// request (Section 9), and sends the new hire the HR-configurable Welcome Email. "Two actions
// triggered by one click" the IT Admin module exists for, now three with the O365 Admin email.
router.post("/tasks/:offerId/complete", async (req, res) => {
  const offerId = Number(req.params.offerId);
  let reqRow = await prisma.itProvisioningRequest.findUnique({ where: { offerId }, include: { offer: true } });
  if (!reqRow) return res.status(404).json({ error: "IT Provisioning Request not found" });
  if (reqRow.emailCreatedAt) return res.status(400).json({ error: "Already marked complete." });
  // Carries any not-yet-saved edit to any field straight through Approve too — same convenience
  // displayName already had — so IT Admin editing a field and clicking Approve without a separate
  // Save first never silently loses the change.
  const requiredFields = ["emailIdToCreate", "osRequirement", "laptopConfiguration"] as const;
  const nullableFields = ["displayName", "phoneNumber", "requiredApplications", "requiredAccess", "otherRequirements", "shipToAddress"] as const;
  if ([...requiredFields, ...nullableFields].some((f) => req.body?.[f] !== undefined)) {
    const data: any = {};
    for (const f of requiredFields) if (req.body?.[f] !== undefined) data[f] = req.body[f];
    for (const f of nullableFields) if (req.body?.[f] !== undefined) data[f] = req.body[f] || null;
    reqRow = await prisma.itProvisioningRequest.update({ where: { offerId }, data, include: { offer: true } });
  }
  if (req.body?.personalEmail !== undefined && String(req.body.personalEmail).trim()) {
    await prisma.offer.update({ where: { id: offerId }, data: { candidateEmail: String(req.body.personalEmail).trim() } });
    reqRow = { ...reqRow, offer: { ...reqRow.offer, candidateEmail: String(req.body.personalEmail).trim() } };
  }

  await prisma.itProvisioningRequest.update({ where: { offerId }, data: { emailCreatedAt: new Date(), emailCreatedById: req.user!.id } });

  // Automated Microsoft Graph provisioning (opt-in — IT Admin's own connected admin account, see
  // engine/graphAdmin.ts) — creates the real O365 mailbox + assigns the configured license,
  // instead of just emailing the Office 365 Admin to do it by hand. Failure here doesn't block the
  // rest of Approve (same "warning, not a hard stop" treatment as every other notification step in
  // this route) — the O365 Admin email below still goes out either way, as confirmation when
  // automated, or as the manual instruction when it isn't/failed.
  let provisioningWarning: string | null = null;
  let graphResult: { graphUserId: string; temporaryPassword: string } | null = null;
  let groupResults: { groupId: number; name: string; status: "ADDED" | "ALREADY_MEMBER" | "FAILED"; error?: string }[] = [];
  const graphCfg = await getGraphAdminConfig();
  // "Email ID Already Created – Skip Account Creation" — the employee's M365 mailbox already
  // exists (created outside this app), so createO365Mailbox() must never run (that would either
  // fail on a duplicate UPN or, worse, silently create a second account). Everything else that
  // normally follows mailbox creation still runs exactly the same way: license assignment, Intune
  // group add, setting the M365 manager. graphResult is shaped identically to createO365Mailbox()'s
  // own return value (a resolved real object id, a freshly generated password) so every step below
  // can stay unchanged either way. This whole block only runs when Graph automation is actually
  // connected (graphCfg.enabled) — the ONE thing IT Admin specifically called out as needing to
  // happen regardless, this app's own Users & Roles login, is handled separately below precisely
  // because of that: it must never depend on Graph being enabled, or on the mailbox lookup/creation
  // above succeeding.
  const emailAlreadyExists = graphCfg.enabled && !!req.body?.emailAlreadyExists;
  if (graphCfg.enabled) {
    try {
      graphResult = emailAlreadyExists
        ? { graphUserId: await resolveGraphUserId(reqRow.emailIdToCreate), temporaryPassword: genTempPassword() }
        : await createO365Mailbox({
            userPrincipalName: reqRow.emailIdToCreate,
            displayName: reqRow.displayName || reqRow.offer.candidateName,
            mailNickname: reqRow.emailIdToCreate.split("@")[0],
            countryCode: reqRow.offer.countryCode,
            firstName: reqRow.offer.candidateFirstName || undefined,
            lastName: reqRow.offer.candidateLastName || undefined,
            mobilePhone: reqRow.phoneNumber || reqRow.offer.candidatePhone || undefined,
            jobTitle: reqRow.offer.designation || undefined,
            department: reqRow.offer.department || undefined,
          });
      const data: any = { graphUserId: graphResult.graphUserId, temporaryPassword: graphResult.temporaryPassword, provisioningError: null };
      if (graphCfg.licenseSkuIds.length) {
        // One Graph call assigns every selected SKU at once (assignLicenseToUser's addLicenses
        // array) — a partial failure (e.g. one SKU out of seats) still surfaces as a warning
        // rather than silently skipping the whole assignment.
        try { await assignLicenseToUser(graphResult.graphUserId, graphCfg.licenseSkuIds); data.licenseAssignedSku = graphCfg.licenseSkuPartNumbers.length ? graphCfg.licenseSkuPartNumbers.join(", ") : graphCfg.licenseSkuIds.join(", "); }
        catch (e: any) { provisioningWarning = `Mailbox created but license assignment failed: ${e.message}`; }
      }
      // Group Assignment Checklist — IT Admin explicitly selected these on the checklist shown
      // before clicking Approve; add to ONLY those groups, never automatically to every configured
      // group. Per-group try/catch so one group's failure never blocks account creation, license
      // assignment, or any other selected group. Already-a-member is only worth checking on the
      // "Email ID Already Created" path (a brand-new mailbox can't already belong to anything).
      const selectedGroupIds: number[] = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(Number) : [];
      if (selectedGroupIds.length) {
        const defs = await prisma.itGroupDef.findMany({ where: { id: { in: selectedGroupIds } } });
        let currentNames = new Set<string>();
        if (emailAlreadyExists) {
          try { currentNames = new Set((await getUserGroupMemberships(graphResult.graphUserId)).map((g) => g.displayName.toLowerCase())); } catch { /* best-effort pre-check only — falls through to a normal add attempt */ }
        }
        for (const def of defs) {
          if (currentNames.has(def.name.toLowerCase())) { groupResults.push({ groupId: def.id, name: def.name, status: "ALREADY_MEMBER" }); continue; }
          try {
            const group = await findGroupByName(def.name);
            if (!group) { groupResults.push({ groupId: def.id, name: def.name, status: "FAILED", error: `Group "${def.name}" not found in Entra` }); continue; }
            await addUserToGroup(group.id, graphResult.graphUserId);
            groupResults.push({ groupId: def.id, name: def.name, status: "ADDED" });
          } catch (e: any) { groupResults.push({ groupId: def.id, name: def.name, status: "FAILED", error: e.message }); }
        }
        const failed = groupResults.filter((g) => g.status === "FAILED");
        if (failed.length) {
          const msg = `Failed to add to group(s): ${failed.map((f) => f.name).join(", ")}.`;
          provisioningWarning = provisioningWarning ? `${provisioningWarning} Also: ${msg}` : `Mailbox created but ${msg}`;
        }
        await prisma.auditLog.create({
          data: { userId: req.user!.id, action: "GROUP_MEMBERSHIP_ADD", entity: "Employee", entityId: String(reqRow.offer.employeeId || offerId), after: groupResults },
        }).catch(() => {});
      }
      // Reporting Manager is a free-text name on the Offer (picked from Employee master at
      // Generate Offer time, not a structured reference) — best-effort match it back to a real
      // account's email so Graph can link it as the M365 "Manager" field. Employee.email is
      // unreliable in practice (routinely null/unset in this data, with no matching User link
      // either — see the User table instead, which is what actually has real login emails) so
      // that's checked first, falling back to Employee.email in case a deployment does populate
      // it. Surfaced as a warning (not silently skipped) when nothing matches, so this doesn't
      // fail invisibly again.
      if (reqRow.offer.reportingManager) {
        const manager = (await prisma.user.findFirst({ where: { name: reqRow.offer.reportingManager }, select: { email: true } }))
          || (await prisma.employee.findFirst({ where: { name: reqRow.offer.reportingManager }, select: { email: true } }));
        if (manager?.email) {
          try { await setUserManager(graphResult.graphUserId, manager.email); }
          catch (e: any) { provisioningWarning = provisioningWarning ? `${provisioningWarning} Also failed to set manager: ${e.message}` : `Mailbox created but setting the Reporting Manager failed: ${e.message}`; }
        } else {
          const msg = `No account found matching Reporting Manager "${reqRow.offer.reportingManager}" — set the M365 Manager field manually.`;
          provisioningWarning = provisioningWarning ? `${provisioningWarning} ${msg}` : msg;
        }
      }
      reqRow = await prisma.itProvisioningRequest.update({ where: { offerId }, data, include: { offer: true } });
    } catch (e: any) {
      provisioningWarning = emailAlreadyExists
        ? `Could not find the existing Microsoft 365 account for ${reqRow.emailIdToCreate}: ${e.message} — double-check the Email ID, or uncheck "Email ID Already Created" to create it instead.`
        : `Automated mailbox creation failed: ${e.message} — create it manually in the M365 Admin Center.`;
      await prisma.itProvisioningRequest.update({ where: { offerId }, data: { provisioningError: e.message } });
    }
  }

  // Registers the new hire as a login in this app's own Users & Roles — ALWAYS, regardless of
  // whether Microsoft Graph automation is connected/enabled or the mailbox lookup/creation above
  // succeeded, since this is a purely local action with no Graph dependency (the bug this fixes:
  // it used to live inside the graphCfg.enabled block above, so Approve with "Email ID Already
  // Created" produced no App Login + temporary password at all whenever automation wasn't
  // connected, or whenever resolveGraphUserId failed to find the existing account). Reuses the
  // Graph-created password when one exists (an O365 mailbox really was created/resolved this run);
  // otherwise generates a fresh one just for this app login. Skips (warns, doesn't fail Approve) if
  // a User with this email somehow already exists.
  const appLoginPassword = graphResult?.temporaryPassword || genTempPassword();
  let appLoginCreated = false;
  try {
    const email = reqRow.emailIdToCreate.toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      provisioningWarning = provisioningWarning ? `${provisioningWarning} Also: a Users & Roles account for ${email} already exists — role/access left unchanged.` : `A Users & Roles account for ${email} already existed, so it was left unchanged.`;
    } else {
      await prisma.user.create({
        data: {
          name: reqRow.offer.candidateName, email,
          passwordHash: hashPassword(appLoginPassword),
          role: reqRow.offer.employmentType === "CONTRACTOR" ? "CONTRACTOR" : reqRow.offer.employmentType === "INTERN" ? "INTERN" : "EMPLOYEE",
          employeeId: reqRow.offer.employeeId || null,
        },
      });
      appLoginCreated = true;
    }
  } catch (e: any) {
    const msg = `Creating the Users & Roles account failed: ${e.message}`;
    provisioningWarning = provisioningWarning ? `${provisioningWarning} Also: ${msg}` : msg;
  }

  const commonVals = {
    firstName: reqRow.offer.candidateFirstName || reqRow.offer.candidateName, lastName: reqRow.offer.candidateLastName || "",
    displayName: reqRow.displayName || reqRow.offer.candidateName, personalEmail: reqRow.offer.candidateEmail,
    jobTitle: reqRow.offer.designation, department: reqRow.offer.department || "",
    requestId: String(reqRow.id), laptopConfiguration: reqRow.laptopConfiguration, ram: reqRow.laptopConfiguration,
    requiredApplications: reqRow.requiredApplications || "—", requiredAccess: reqRow.requiredAccess || "—", otherRequirements: reqRow.otherRequirements || "—",
    EmployeeName: reqRow.offer.candidateName, EmailId: reqRow.emailIdToCreate, EmployeeId: reqRow.offer.reservedEmpNo || "",
  };

  // Section 9 — Office 365 Admin email, generated automatically from a configurable template.
  // This app has no separate "Office 365 Admin" role, so it's sent to the same IT/Network Admin
  // recipients the initial notification (Section 10) already goes to.
  let o365Warning: string | null = null;
  const o365Recipients = await itAdminEmails();
  if (!o365Recipients.length) o365Warning = "No one holds the IT/Network Admin role yet — assign it to someone in Users & Roles.";
  else if (!mailEnabled()) o365Warning = "O365 Admin email not sent — email sending is not configured (Microsoft Graph).";
  else {
    try {
      const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key: "O365_ADMIN_EMAIL", businessUnitId: null } });
      const subject = fillTemplate(tpl?.subject || "New O365 Account Provisioning Approved – {{EmployeeName}}", commonVals);
      const html = fillTemplate(
        tpl?.body ||
        "Employee Information<br>--------------------<br>First Name: {{firstName}}<br>Last Name: {{lastName}}<br>Display Name: {{displayName}}<br>Official Email: {{personalEmail}}<br>Job Title: {{jobTitle}}<br>Department: {{department}}<br><br>" +
        "IT Provisioning<br>---------------<br>Laptop Configuration: {{laptopConfiguration}}<br>RAM: {{ram}}<br>Required Applications: {{requiredApplications}}<br>Required Access: {{requiredAccess}}<br>Other IT Requirements: {{otherRequirements}}<br><br>" +
        "Email ID to create: {{EmailId}}",
        commonVals,
      ).replace(/\n/g, "<br>");
      for (const to of o365Recipients) await notifyMail("O365_ADMIN_PROVISIONING", { fromUpn: req.user!.email, to, subject, html });
    } catch (e: any) { o365Warning = `Failed to send: ${e.message || "unknown error"}`; }
  }

  let emailWarning: string | null = null;
  if (graphCfg.enabled && !graphResult) {
    emailWarning = "Welcome email not sent — automated mailbox creation failed, so the account doesn't exist yet.";
  } else if (!mailEnabled()) emailWarning = "Welcome email not sent — email sending is not configured (Microsoft Graph).";
  else {
    try {
      const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key: "WELCOME_EMAIL", businessUnitId: null } });
      const subject = fillTemplate(tpl?.subject || "Welcome to GenAquarius, {{EmployeeName}}!", commonVals);
      const html = fillTemplate(tpl?.body || "Welcome to GenAquarius!", commonVals).replace(/\n/g, "<br>");
      await notifyMail("WELCOME_EMAIL", { fromUpn: req.user!.email, to: reqRow.emailIdToCreate, subject, html });
      await prisma.itProvisioningRequest.update({ where: { offerId }, data: { welcomeEmailSentAt: new Date() } });
    } catch (e: any) { emailWarning = `Welcome email failed to send: ${e.message || "unknown error"}`; }
  }
  const provisioningNote = graphCfg.enabled
    ? (graphResult
        ? `${emailAlreadyExists ? "Existing O365 account confirmed (Email ID Already Created)" : "O365 mailbox created automatically via Microsoft Graph"} (${reqRow.emailIdToCreate})${reqRow.licenseAssignedSku ? `, license ${reqRow.licenseAssignedSku} assigned` : ""}`
        : `${emailAlreadyExists ? "Existing account lookup failed" : "Automated creation failed"} — ${provisioningWarning}`)
    : `O365 mailbox created (${reqRow.emailIdToCreate})`;
  await audit(offerId, req.user!.id, "IT_PROVISIONING_APPROVE", null, null, `${provisioningNote}${o365Warning ? ` — O365 Admin email not sent (${o365Warning})` : " — O365 Admin notified"}`);
  if (reqRow.offer.employeeId) emitPendingActionsUpdate(reqRow.offer.employeeId);
  // Live-moves this task off Pending Tasks and into Recently Completed for anyone else watching
  // the IT Admin Dashboard right now, same room the Helpdesk Console already live-updates from.
  emitHelpdeskUpdate("it_provisioning_approved", { offerId, candidateName: reqRow.offer.candidateName });
  // temporaryPassword is returned ONCE, directly in this response — never emailed, never logged
  // again after this (the row keeps it for IT Admin's own "Recently Completed" review, same rule
  // as the Helpdesk elevated-access credentials). Only present when a User row was actually just
  // created — never for an already-existing Users & Roles account. `emailAlreadyExists` here is the
  // raw checkbox the client sent (not the Graph-gated local variable above), so the "App Login
  // Created" vs "Mailbox Created" wording on the credential modal reflects what IT Admin actually
  // asked for even when Graph automation isn't connected at all.
  res.json({ ok: true, emailWarning, o365Warning, provisioningWarning, graphUserId: graphResult?.graphUserId, temporaryPassword: appLoginCreated ? appLoginPassword : undefined, licenseAssignedSku: reqRow.licenseAssignedSku, emailAlreadyExists: !!req.body?.emailAlreadyExists, groupResults });
});

// ------------------------------------------------------------------ Offboarding (reverse of the O365 provisioning above) ----
// Rows are created by terminationApprovals.ts the moment a termination is "ready to offboard" —
// see the ItOffboardingRequest model's own comment in schema.prisma for exactly when that is.
const OFFBOARDING_EMPLOYEE_SELECT = { select: { id: true, name: true, empNo: true, email: true, designation: true, department: true, empType: true } } as const;

router.get("/offboarding-tasks", async (_req, res) => {
  res.json(await prisma.itOffboardingRequest.findMany({ where: { completedAt: null }, include: { employee: OFFBOARDING_EMPLOYEE_SELECT }, orderBy: { createdAt: "asc" } }));
});
router.get("/offboarding-tasks/history", async (_req, res) => {
  res.json(await prisma.itOffboardingRequest.findMany({ where: { completedAt: { not: null } }, include: { employee: OFFBOARDING_EMPLOYEE_SELECT }, orderBy: { completedAt: "desc" }, take: 50 }));
});

// IT Admin's one-click "Deactivate Account" — disables O365 sign-in, frees the license(s), removes
// from the Intune access group, then notifies Finance/HR it's done. The local app login was
// already deleted the moment this task was created (terminationApprovals.ts) — this route only
// handles the Microsoft 365 side. Best-effort per step, same "warn, don't block" treatment as
// onboarding's Approve — a failed license-removal shouldn't prevent the account from being
// disabled, the most security-critical step.
router.post("/offboarding-tasks/:id/complete", async (req, res) => {
  const id = Number(req.params.id);
  const reqRow = await prisma.itOffboardingRequest.findUnique({ where: { id }, include: { employee: { select: { id: true, name: true, empNo: true, email: true } } } });
  if (!reqRow) return res.status(404).json({ error: "Offboarding task not found" });
  if (reqRow.completedAt) return res.status(400).json({ error: "Already marked complete." });
  const email = reqRow.employee.email;
  if (!email) return res.status(400).json({ error: "This employee has no email on file — nothing to disable in Microsoft 365. Mark the task done manually once handled." });

  const graphCfg = await getGraphAdminConfig();
  const data: any = { completedAt: new Date(), completedById: req.user!.id };
  const warnings: string[] = [];
  // "Email ID Already Deactivated – Skip Account Deactivation" — mirrors onboarding's own "Email ID
  // Already Created" checkbox: the account was already disabled outside this app (e.g. by hand, or
  // by a different admin), so skip the Graph calls entirely instead of erroring on an
  // already-disabled account or re-doing work that's already done. Still marks the task complete
  // and still notifies Finance/HR, same as the automated path.
  const alreadyDeactivated = !!req.body?.alreadyDeactivated;
  // Deactivation Checklist — IT Admin reviewed the employee's CURRENT real group memberships and
  // explicitly selected which ones to remove; only those are touched. An unselected group the
  // employee is still in stays untouched, per spec.
  let groupResults: { groupId: number; name: string; status: "REMOVED" | "NOT_MEMBER" | "FAILED"; error?: string }[] = [];
  if (alreadyDeactivated) {
    data.accountDisabled = true; data.licenseRemoved = true; data.removedFromGroup = true;
  } else if (!graphCfg.enabled) {
    warnings.push("Automated provisioning is not enabled (IT Admin → Pending Tasks → Automated Provisioning) — nothing was changed in Microsoft 365. Disable the account manually.");
  } else {
    try { await disableO365Account(email); data.accountDisabled = true; } catch (e: any) { warnings.push(`Failed to disable account: ${e.message}`); }
    try { const removed = await removeAllLicenses(email); data.licenseRemoved = true; if (removed.length) data.error = null; } catch (e: any) { warnings.push(`Failed to remove license(s): ${e.message}`); }
    const removeGroupIds: number[] = Array.isArray(req.body?.removeGroupIds) ? req.body.removeGroupIds.map(Number) : [];
    if (removeGroupIds.length) {
      const defs = await prisma.itGroupDef.findMany({ where: { id: { in: removeGroupIds } } });
      // Re-check CURRENT membership right before removing — the checklist only showed membership
      // as of when IT Admin opened it, which could be stale by the time they confirm (another
      // admin removed them in the meantime, etc.). A group that's no longer a membership reports
      // "Not a Member" rather than attempting (and likely failing) a removal.
      let currentNames = new Set<string>();
      try { currentNames = new Set((await getUserGroupMemberships(email)).map((g) => g.displayName.toLowerCase())); } catch { /* best-effort pre-check only — falls through to a normal remove attempt */ }
      for (const def of defs) {
        if (currentNames.size && !currentNames.has(def.name.toLowerCase())) { groupResults.push({ groupId: def.id, name: def.name, status: "NOT_MEMBER" }); continue; }
        try {
          const group = await findGroupByName(def.name);
          if (!group) { groupResults.push({ groupId: def.id, name: def.name, status: "FAILED", error: `Group "${def.name}" not found in Entra` }); continue; }
          await removeUserFromGroup(group.id, email);
          groupResults.push({ groupId: def.id, name: def.name, status: "REMOVED" });
        } catch (e: any) { groupResults.push({ groupId: def.id, name: def.name, status: "FAILED", error: e.message }); }
      }
      data.removedFromGroup = groupResults.some((g) => g.status === "REMOVED");
      const failed = groupResults.filter((g) => g.status === "FAILED");
      if (failed.length) warnings.push(`Failed to remove from group(s): ${failed.map((f) => f.name).join(", ")}.`);
    }
  }
  if (warnings.length) data.error = warnings.join(" ");
  const updated = await prisma.itOffboardingRequest.update({ where: { id }, data });
  if (groupResults.length) {
    await prisma.auditLog.create({
      data: { userId: req.user!.id, action: "GROUP_MEMBERSHIP_REMOVE", entity: "Employee", entityId: String(reqRow.employeeId), after: groupResults.map((g) => ({ ...g, selectedForRemoval: true, removedBy: req.user!.id, removedAt: new Date() })) },
    }).catch(() => {});
  }

  // Notify Finance + HR the account has been deactivated — same recipient convention as the
  // termination-completed notice (requester + Finance/CTO/CEO), plus HR broadly.
  if (mailEnabled()) {
    const recipients = await prisma.user.findMany({ where: { role: { in: ["HR", "FINANCE", "CTO", "CEO"] } }, select: { email: true } });
    const subject = `O365 account deactivated: ${reqRow.employee.name} (${reqRow.employee.empNo || ""})`;
    const html = `Hi,<br><br>The Microsoft 365 account for <b>${reqRow.employee.name}</b> (${reqRow.employee.empNo || ""}) has been deactivated by IT Admin.<br>Account disabled: ${data.accountDisabled ? "Yes" : "No"}<br>License removed: ${data.licenseRemoved ? "Yes" : "No"}<br>Removed from access group: ${data.removedFromGroup ? "Yes" : "No"}${warnings.length ? `<br><br>Warnings:<br>${warnings.join("<br>")}` : ""}<br><br>Regards,<br>GenAquarius IT`;
    for (const r of recipients) { if (!r.email) continue; try { await notifyMail("OFFBOARDING_COMPLETE_NOTICE", { fromUpn: req.user!.email, to: r.email, subject, html }); } catch { /* one bad recipient shouldn't block the rest */ } }
  }
  // Asset Collection — snapshot every asset this employee currently holds into its own task the
  // instant the account is deactivated, so IT Admin has one place to track getting the hardware
  // back. Snapshotted as ItAssetCollectionItem rows (not just read live off ItAsset each time) so a
  // later reassignment elsewhere never silently changes what THIS collection run is chasing.
  const heldAssets = await prisma.itAsset.findMany({ where: { assignedEmployeeId: reqRow.employeeId, status: { in: ["ASSIGNED", "IN_REPAIR"] } } });
  let assetCollectionTask: any = null;
  if (heldAssets.length) {
    assetCollectionTask = await prisma.itAssetCollectionTask.create({
      data: {
        offboardingRequestId: reqRow.id, employeeId: reqRow.employeeId,
        items: { create: heldAssets.map((a) => ({ assetId: a.id })) },
      },
      include: { items: true },
    });
  }

  emitHelpdeskUpdate("it_offboarding_completed", { employeeId: reqRow.employeeId, employeeName: reqRow.employee.name });
  res.json({ ok: true, ...updated, warnings, assetCollectionTask, groupResults });
});

// ------------------------------------------------------------------ Asset Collection (post-offboarding) ----
// Created automatically above the moment an account is deactivated — see ItAssetCollectionTask's
// own schema comment for the full lifecycle. IT Admin picks an expected collection date, an
// overdue-reminder tick (engine/reminders.ts) nudges them once if it slips, and "Receive Asset
// Collection" resolves every item to Received (back to stock) or Missing (stays with the
// now-departed employee, excluded from reassignment) — never both silently, and never guessed.
const ASSET_COLLECTION_INCLUDE = {
  employee: { select: { id: true, name: true, empNo: true, empType: true } },
  items: { include: { asset: { select: { id: true, assetTag: true, name: true, category: true, serialNo: true, status: true } } } },
} as const;

router.get("/asset-collection", async (_req, res) => {
  res.json(await prisma.itAssetCollectionTask.findMany({ where: { status: "PENDING" }, include: ASSET_COLLECTION_INCLUDE, orderBy: { createdAt: "asc" } }));
});
// Permanent record of exactly what happened at this employee's offboarding asset handover — never
// touched again after /receive closes it out, even once the assets themselves later move to stock
// or get reassigned elsewhere (Asset Inventory's own history tracks THAT separately). Resolves
// processedById to a name since it's a plain user id, not a relation.
router.get("/asset-collection/history", async (_req, res) => {
  const rows = await prisma.itAssetCollectionTask.findMany({ where: { status: "RECEIVED" }, include: ASSET_COLLECTION_INCLUDE, orderBy: { processedAt: "desc" }, take: 50 });
  const userIds = Array.from(new Set(rows.map((r) => r.processedById).filter((x): x is number => !!x)));
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  res.json(rows.map((r) => ({ ...r, processedByName: r.processedById ? nameById.get(r.processedById) || null : null })));
});
// IT Admin's own Expected Collection Date — separate save so it isn't lost mid-edit, same
// convention as Pending Tasks' Display Name field.
router.put("/asset-collection/:id", async (req, res) => {
  const id = Number(req.params.id);
  const task = await prisma.itAssetCollectionTask.findUnique({ where: { id } });
  if (!task) return res.status(404).json({ error: "Asset collection task not found" });
  const updated = await prisma.itAssetCollectionTask.update({ where: { id }, data: { expectedDate: req.body?.expectedDate ? new Date(req.body.expectedDate) : null } });
  res.json(updated);
});
// Resolves every item on the task to Received or Missing in one pass. A remark is required for a
// Missing item (mirrors Asset Inventory's own mandatory Return Remark) — otherwise a status this
// consequential (excludes the asset from reassignment indefinitely) could be set with zero
// explanation of what actually happened to it.
router.post("/asset-collection/:id/receive", async (req, res) => {
  const id = Number(req.params.id);
  const task = await prisma.itAssetCollectionTask.findUnique({ where: { id }, include: { items: true } });
  if (!task) return res.status(404).json({ error: "Asset collection task not found" });
  if (task.status === "RECEIVED") return res.status(400).json({ error: "Already marked received." });
  const results: { itemId: number; result: string; remark?: string }[] = req.body?.items || [];
  const byItemId = new Map(results.map((r) => [Number(r.itemId), r]));
  for (const item of task.items) {
    const r = byItemId.get(item.id);
    if (!r || !["RECEIVED", "MISSING"].includes(r.result)) return res.status(400).json({ error: `Every asset must be marked Received or Missing — ${item.id} was not.` });
    if (r.result === "MISSING" && !String(r.remark || "").trim()) return res.status(400).json({ error: "A remark is required for every asset marked Missing." });
  }
  for (const item of task.items) {
    const r = byItemId.get(item.id)!;
    await prisma.itAssetCollectionItem.update({ where: { id: item.id }, data: { result: r.result, remark: r.remark || null } });
    if (r.result === "RECEIVED") {
      // Same closing sequence as Asset Inventory's own single-asset Return — closes the open
      // assignment history row and frees the asset back to stock for reassignment.
      const open = await prisma.itAssetAssignmentHistory.findFirst({ where: { assetId: item.assetId, returnedAt: null }, orderBy: { assignedAt: "desc" } });
      if (open) await prisma.itAssetAssignmentHistory.update({ where: { id: open.id }, data: { returnedAt: new Date(), returnedById: req.user!.id, returnRemark: r.remark || "Collected during offboarding" } });
      await prisma.itAsset.update({ where: { id: item.assetId }, data: { assignedEmployeeId: null, assignedAt: null, status: "IN_STOCK" } });
    } else {
      // Stays associated with the (now-departed) employee and out of the reassignment pool — the
      // assignment history row is deliberately left open (returnedAt null): it genuinely was never
      // returned, so closing it would misrepresent the asset's own lifecycle record.
      await prisma.itAsset.update({ where: { id: item.assetId }, data: { status: "MISSING" } });
    }
  }
  const updated = await prisma.itAssetCollectionTask.update({ where: { id }, data: { status: "RECEIVED", processedAt: new Date(), processedById: req.user!.id }, include: ASSET_COLLECTION_INCLUDE });
  emitHelpdeskUpdate("asset_collection_received", { employeeId: task.employeeId });
  res.json(updated);
});

// ------------------------------------------------------------------ Laptop Handover Email ----
// IT-Admin-managed template (separate from HR's own email templates — same HrEmailTemplate
// table, just a key only this module reads/writes), styled and stored exactly like the Offer
// Letter template (Subject/Body/Signature/Show Logo), content derived from "Laptop Template 7"
// (GenAquarius's laptop-receipt form). Company-wide only — no per-Business-Unit override, unlike
// HR's templates, since this is an IT Admin operational notice, not a legal/HR document.
const LAPTOP_TEMPLATE_KEY = "LAPTOP_HANDOVER_EMAIL";
router.get("/laptop-template", async (_req, res) => {
  const row = await prisma.hrEmailTemplate.findFirst({ where: { key: LAPTOP_TEMPLATE_KEY, businessUnitId: null } });
  res.json(row || { key: LAPTOP_TEMPLATE_KEY, subject: "", body: "", signature: "", showLogo: true });
});
router.put("/laptop-template", async (req, res) => {
  const b = req.body || {};
  const data = { subject: b.subject || "", body: b.body || "", signature: b.signature || null, showLogo: b.showLogo !== false };
  const existing = await prisma.hrEmailTemplate.findFirst({ where: { key: LAPTOP_TEMPLATE_KEY, businessUnitId: null } });
  const row = existing
    ? await prisma.hrEmailTemplate.update({ where: { id: existing.id }, data })
    : await prisma.hrEmailTemplate.create({ data: { key: LAPTOP_TEMPLATE_KEY, businessUnitId: null, ...data } });
  res.json(row);
});

// Renders one <tr> per asset actually assigned to the employee (never a fixed 3-slot Laptop/
// Mouse/Headphone shape — an employee may have more, fewer, or different asset types).
function assetsTableHtml(assets: { category: string; name: string; make: string | null; model: string | null; serialNo: string | null }[]): string {
  if (!assets.length) return "<i>No assets currently assigned.</i>";
  const rows = assets.map((a) => `<tr><td>${a.category}</td><td>${a.name}${a.make || a.model ? ` — ${[a.make, a.model].filter(Boolean).join(" / ")}` : ""}</td><td>${a.serialNo || "—"}</td></tr>`).join("");
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%"><thead><tr><th>Category</th><th>Make / Model</th><th>Serial No.</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Resolves everything automatically from existing records (IT Provisioning Request, O365 email
// creation, Asset Inventory assignment) — IT Admin enters nothing here, per the spec.
async function buildLaptopHandoverContent(offerId: number) {
  const reqRow = await prisma.itProvisioningRequest.findUnique({ where: { offerId }, include: { offer: { include: { employee: true } } } });
  if (!reqRow) return { error: "IT Provisioning Request not found" as const };
  const employee = reqRow.offer.employee;
  // handoverEmailOverride wins when IT Admin has explicitly corrected it from the Preview screen
  // (e.g. before the employee's own work email exists yet) — same override precedence as
  // shipToAddress/locationOverride/building below.
  const email = reqRow.handoverEmailOverride || employee?.email || reqRow.emailIdToCreate;
  if (!email) return { error: "No email on file for this employee — nothing to send to." as const };
  // Location had NO data source at all before Employee Activation (Employee.location doesn't
  // exist yet at the IT Provisioning stage) — that's why it always showed blank on the Preview.
  // Building never had a source anywhere. Both are now IT-editable overrides, same pattern as
  // shipToAddress.
  const location = reqRow.locationOverride || employee?.location || "";
  const building = reqRow.building || "";
  const assets = employee
    ? await prisma.itAsset.findMany({ where: { assignedEmployeeId: employee.id, status: "ASSIGNED" }, select: { category: true, name: true, make: true, model: true, serialNo: true } })
    : [];
  const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key: LAPTOP_TEMPLATE_KEY, businessUnitId: null } });
  const vals = {
    EmployeeName: reqRow.offer.candidateName, EmployeeId: employee?.empNo || reqRow.offer.reservedEmpNo || "",
    Department: employee?.department || reqRow.offer.department || "", Designation: employee?.designation || reqRow.offer.designation || "",
    Location: location, Building: building, MobileNo: employee?.phone || reqRow.phoneNumber || reqRow.offer.candidatePhone || "",
    EmailId: email, AssetsTable: assetsTableHtml(assets),
  };
  const subject = fillTemplate(tpl?.subject || "Issuance of Laptop & Accessories — {{EmployeeName}}", vals);
  let html = fillTemplate(tpl?.body || "", vals).replace(/\n/g, "<br>");
  if (tpl?.signature) html += `<br><br>${fillTemplate(tpl.signature, vals).replace(/\n/g, "<br>")}`;
  if (tpl?.showLogo !== false) html += `<br><br><img src="${process.env.PUBLIC_APP_URL || ""}/genaquarius.png" alt="GenAquarius" style="max-height:56px" />`;
  return { reqRow, employee, assets, subject, html, email, location, building, alreadySent: reqRow.laptopHandoverEmailSentAt };
}

// Lets IT Admin correct Location/Building/recipient Email right from the Laptop Handover Preview
// screen before sending, without touching the candidate's actual Employee/Offer record — same
// override precedence buildLaptopHandoverContent() above already applies when reading them back.
router.put("/tasks/:offerId/laptop-handover/fields", async (req, res) => {
  const offerId = Number(req.params.offerId);
  const existing = await prisma.itProvisioningRequest.findUnique({ where: { offerId } });
  if (!existing) return res.status(404).json({ error: "IT Provisioning Request not found" });
  const b = req.body || {};
  const updated = await prisma.itProvisioningRequest.update({
    where: { offerId },
    data: {
      locationOverride: b.location !== undefined ? (String(b.location).trim() || null) : undefined,
      building: b.building !== undefined ? (String(b.building).trim() || null) : undefined,
      handoverEmailOverride: b.email !== undefined ? (String(b.email).trim() || null) : undefined,
    },
  });
  res.json({ ok: true, locationOverride: updated.locationOverride, building: updated.building, handoverEmailOverride: updated.handoverEmailOverride });
});

// Preview — renders, does not send. "Assigned Assets → Populate Existing Laptop Template →
// Preview" step of the spec's flow.
router.get("/tasks/:offerId/laptop-handover", async (req, res) => {
  const r = await buildLaptopHandoverContent(Number(req.params.offerId));
  if ("error" in r) return res.status(404).json({ error: r.error });
  res.json({ subject: r.subject, html: r.html, email: r.email, location: r.location, building: r.building, assets: r.assets, alreadySent: r.alreadySent });
});

// Send — "→ Send Email to Employee" step, now a real e-signature request (not just a one-way
// notice): renders an actual signable PDF, sends it through Adobe Sign (same
// generate→send→sign→capture pipeline as Offer/Appointment Letter/Service Agreement — see
// engine/adobeSign.ts + routes/shared/adobeSign.ts, both fully generic on docType, so
// "LAPTOP_HANDOVER" rides the exact same EsignAgreement/webhook/Attachment machinery with no
// changes needed there), and records sent-status + timestamp on the same ItProvisioningRequest
// row this task already lives on. Falls back to the original plain-email notice (with the asset
// table, no signature capture) when Adobe Sign isn't connected for this tenant, so the button
// still works either way — same "degrade gracefully, don't block" convention as
// mailEnabled()/getGraphAdminConfig() elsewhere in this file.
router.post("/tasks/:offerId/laptop-handover/send", async (req, res) => {
  const offerId = Number(req.params.offerId);
  const r = await buildLaptopHandoverContent(offerId);
  if ("error" in r) return res.status(404).json({ error: r.error });
  if (!mailEnabled()) return res.status(400).json({ error: "Email sending is not configured (Microsoft Graph)." });

  const adobeCfg = await getAdobeAuthConfig();
  if (!adobeCfg.accessToken || !adobeCfg.refreshToken) {
    // Fallback: the original one-way notification email — no signature capture, but still useful
    // if Adobe Sign isn't set up yet (Settings → External Integrations → Adobe Sign → Connect).
    try {
      await notifyMail("LAPTOP_HANDOVER_EMAIL", { fromUpn: req.user!.email, to: r.email, subject: r.subject, html: r.html });
      await prisma.itProvisioningRequest.update({ where: { offerId }, data: { laptopHandoverEmailSentAt: new Date(), laptopHandoverEmailSentById: req.user!.id } });
      await audit(offerId, req.user!.id, "LAPTOP_HANDOVER_EMAIL_SENT", null, null, `Emailed to ${r.email} (no signature — Adobe Sign not connected) — ${r.assets.length} asset(s): ${r.assets.map((a) => a.name).join(", ") || "none"}`);
      res.json({ ok: true, sentAt: new Date(), signing: false, warning: "Adobe Sign isn't connected — sent as a plain notification email, no signature will be captured. Connect it in Settings → External Integrations to enable signing." });
    } catch (e: any) { res.status(500).json({ error: `Failed to send: ${e.message || "unknown error"}` }); }
    return;
  }

  try {
    const fileName = `Laptop_Handover_${offerId}.pdf`;
    const buffer = await renderLaptopHandoverPdf({
      employeeName: r.reqRow.offer.candidateName, empNo: r.employee?.empNo || r.reqRow.offer.reservedEmpNo || "",
      department: r.employee?.department || r.reqRow.offer.department || "", designation: r.employee?.designation || r.reqRow.offer.designation || "",
      location: r.location, building: r.building, mobileNo: r.employee?.phone || r.reqRow.phoneNumber || r.reqRow.offer.candidatePhone || "",
      email: r.email, assets: r.assets,
    });
    const transientDocumentId = await uploadTransientDocument(buffer, fileName);
    const agreementId = await createAgreement({ name: "Laptop & Accessories Handover", transientDocumentId, signerEmail: r.email, signerName: r.reqRow.offer.candidateName });
    const row = await prisma.esignAgreement.upsert({
      where: { docType_docId: { docType: "LAPTOP_HANDOVER", docId: offerId } },
      update: { agreementId, signerEmail: r.email, status: "OUT_FOR_SIGNATURE", signedAt: null, confirmedAt: null, confirmedById: null, createdById: req.user!.id },
      create: { docType: "LAPTOP_HANDOVER", docId: offerId, agreementId, signerEmail: r.email, createdById: req.user!.id },
    });
    let emailWarning: string | null = null;
    try {
      const signingUrl = await getSigningUrl(agreementId, r.email);
      if (!signingUrl) emailWarning = "Adobe Sign did not return a signing URL yet — try again shortly.";
      else await notifyMail("LAPTOP_HANDOVER_ESIGN_INVITE", { fromUpn: req.user!.email, to: r.email, subject: "Review & Sign: Laptop & Accessories Handover", html: `Hi ${r.reqRow.offer.candidateFirstName || r.reqRow.offer.candidateName},<br><br>Please review and sign the acknowledgment for the asset(s) issued to you: <b>Laptop & Accessories Handover</b>.<br><br><a href="${signingUrl}">Review &amp; Sign Document</a><br><br>Regards,<br>GenAquarius IT` });
    } catch (e: any) { emailWarning = `Invite email failed to send: ${e.message || "unknown error"}`; }
    await prisma.itProvisioningRequest.update({ where: { offerId }, data: { laptopHandoverEmailSentAt: new Date(), laptopHandoverEmailSentById: req.user!.id } });
    await audit(offerId, req.user!.id, "LAPTOP_HANDOVER_EMAIL_SENT", null, null, `Sent for e-signature to ${r.email} — ${r.assets.length} asset(s): ${r.assets.map((a) => a.name).join(", ") || "none"}`);
    emitEsignUpdate(row.docType, row.docId, row);
    res.json({ ok: true, sentAt: new Date(), signing: true, agreement: row, warning: emailWarning });
  } catch (e: any) {
    const cause = e?.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : "";
    res.status(400).json({ error: (e.message || "Failed to send for signature") + cause });
  }
});

export default router;
