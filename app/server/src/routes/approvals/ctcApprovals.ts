// Finance's queue for the CTC + Monthly Sheet line HR proposes at Confirm Joining. Nothing here
// touches cost/revenue reporting until an APPROVE call actually creates the CtcRecord,
// EmployeeProject and MonthlyLine — mirrors "Add Line to Monthly Sheet" (Operations) exactly via
// the same createMonthlyLine() engine, so an approved line behaves identically to a hand-added one.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole } from "../../auth/auth";
import { Role } from "@prisma/client";
import { requirePermission } from "../../engine/permissions";
import { ensureBenchProject, offerEngagementComp } from "../../engine/hr";
import { ensureSheetForDate } from "../hrms/hrOffers";
import { createMonthlyLine, previewMonthlyLineImpact } from "../finance/monthly";
import { emitEsignUpdate, emitHelpdeskUpdate } from "../../engine/realtime";
import { itAdminEmails } from "../../engine/itAdmin";
import { mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";

// Same Finance-templated-email resolution as terminationApprovals.ts's renderFinanceEmail —
// duplicated rather than shared/exported to avoid a cross-route-file import for one small helper;
// null-fallback via HrEmailTemplate(key, businessUnitId), same convention as HR's own templated
// emails. Falls back to the given hardcoded subject/body when no template row exists yet.
async function renderFinanceEmail(key: string, businessUnitId: number | null | undefined, vals: Record<string, string>, fallbackSubject: string, fallbackHtml: string) {
  const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key, businessUnitId: businessUnitId ?? null } })
    || await prisma.hrEmailTemplate.findFirst({ where: { key, businessUnitId: null } });
  const fillTpl = (t: string) => t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => vals[k] ?? "");
  return {
    subject: tpl ? fillTpl(tpl.subject) : fallbackSubject,
    html: tpl ? fillTpl(tpl.body).replace(/\n/g, "<br>") : fallbackHtml,
  };
}

const APPROVER_ROLES = [Role.FINANCE, Role.CTO, Role.CEO];

const router = Router();
router.use(requireRole(...APPROVER_ROLES));
router.use(requirePermission("ctc-approvals"));

// A brand-new hire whose real project deployment starts LATER than their joining date (an
// ordinary case — joins now, starts on the client project a few months out) has a genuine Bench
// period in between that createMonthlyLine's own anchor-to-deploymentStart fix (see the /approve
// route's own comment) was silently dropping — no line at all covered the gap, so those days of
// real Bench cost never appeared anywhere in Monthly Forecast. `gapEnd` is the day before
// deploymentStart so the two lines (gap Bench + real project) never overlap the same day twice.
function benchGapWindow(joiningDate: Date | null, deploymentStart: string | Date | null): { start: Date; end: Date } | null {
  if (!joiningDate || !deploymentStart) return null;
  const dStart = new Date(deploymentStart);
  const gapEnd = new Date(dStart.getTime() - 86400000);
  if (gapEnd <= joiningDate) return null; // deployment starts on/before joining — no gap
  return { start: joiningDate, end: gapEnd };
}

// HR can assign an employee to a real project two ways: pick it right here at Confirm Joining
// (writes straight onto this CtcApprovalRequest's own projectId), or — often done afterward, once
// the client engagement is finalized — via Employee Master's own "Projects" action, which only
// ever touches EmployeeProject and has no idea a CtcApprovalRequest is still pending. When that
// happens this request's projectId snapshot stays null/Bench forever, so Finance's approval screen
// (and its Monthly Forecast preview, which follows whatever Project is selected there) kept
// showing Bench — and the resulting $0 billing/hours — even though HR had already put the person
// on a real project. Surfacing that real assignment as a suggested default (never silently
// overwriting the request's own projectId) lets the approval screen pre-select it instead.
async function withProjectName(rows: any[]) {
  const ids = Array.from(new Set(rows.map((r) => r.projectId).filter((x): x is number => !!x)));
  const projects = ids.length ? await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const map = new Map(projects.map((p) => [p.id, p.name]));
  const bench = await ensureBenchProject();
  // Contractor compensation structure chosen on the Service Agreement (Annual / Monthly / Daily).
  const offerIds = Array.from(new Set(rows.map((r) => r.offerId).filter((x): x is number => !!x)));
  const sas = offerIds.length ? await prisma.serviceAgreement.findMany({ where: { offerId: { in: offerIds } }, select: { offerId: true, dynamicFields: true } }) : [];
  const saMap = new Map(sas.map((s) => [s.offerId, s.dynamicFields as any]));
  const usOffers = offerIds.length ? await prisma.offer.findMany({ where: { id: { in: offerIds }, countryCode: { not: "INDIA" } } }) : [];
  const usMap = new Map(usOffers.map((o) => [o.id, o]));
  return rows.map((r) => {
    const df = r.offerId ? saMap.get(r.offerId) : null;
    const uo = r.offerId ? usMap.get(r.offerId) : null;
    const eng = uo ? offerEngagementComp(uo) : null;
    const compensation = { ...ctcSummary(r, df), ...(eng ? { type: eng.basis, amount: eng.rate, hoursPerDay: eng.hoursPerDay, workingDays: eng.workingDays, dayRate: eng.dayRate, hourlyRate: eng.hourlyRate, usEngagement: uo!.usEngagementType } : {}) };
    const assignments: any[] = r.employee?.projects || [];
    const current = !r.projectId ? assignments.find((ep) => ep.projectId !== bench?.id) : null;
    return {
      ...r,
      compensation,
      projectName: r.projectId ? map.get(r.projectId) || null : "Bench (default)",
      suggestedProjectId: current?.projectId ?? null,
      suggestedProjectName: current?.project?.name ?? null,
    };
  });
}

// Annualized CTC for ANY approval row — the single figure the list, review panel and forecast
// preview all show. Same precedence as engine/calc.ts ctcAnnualUsd (override, else monthly x 12 +
// bonus); the Contractor's selected structure (type/amount) is carried alongside for display.
// US/Canada: the compensation basis Finance is approving (hourly/daily/monthly/annual), carried onto
// the official CtcRecord so it keeps the agreed rate + computed annualization, not just a lump sum.
// annualCostOverride stays authoritative for cost (see engine/calc.ts ctcAnnualUsd) and is by
// construction equal to rate x hours x days (or day rate x days), so nothing double counts.
async function retainedBasis(r: any) {
  if (!r.offerId || r.location === "INDIA") return {};
  const offer = await prisma.offer.findUnique({ where: { id: r.offerId } });
  if (!offer) return {};
  const c = offerEngagementComp(offer);
  const hourlyType = offer.usEngagementType === "VENDOR" || offer.usEngagementType === "W2_NO_BENEFIT";
  const usEngagement = offer.usEngagementType === "W2_FULL_TIME" ? "W2" : offer.usEngagementType || null;
  if (!hourlyType) return { usEngagement, rateBasis: null, hourlyRateUsd: null, dayRateUsd: null, hoursPerDay: null, workingDaysPerYear: c.workingDays };
  return { usEngagement, rateBasis: c.basis === "DAILY" ? "DAILY" : "HOURLY", hourlyRateUsd: c.hourlyRate, dayRateUsd: c.dayRate, hoursPerDay: c.hoursPerDay, workingDaysPerYear: c.workingDays };
}

export function ctcSummary(r: any, df?: any) {
  const monthly = (r.basic || 0) + (r.hra || 0) + (r.otherAllowance || 0) + (r.specialAllowance || 0) + (r.conveyance || 0) + (r.communication || 0) + (r.meals || 0) + (r.books || 0) + (r.driver || 0) + (r.uniform || 0);
  const annual = r.annualCostOverride != null ? r.annualCostOverride : monthly * 12 + (r.bonusAnnual || 0);
  return { type: df?.CompensationType || null, amount: df?.CompensationAmount ?? null, monthly: r.annualCostOverride != null ? r.annualCostOverride / 12 : monthly, annual, currency: r.currency };
}

const EMPLOYEE_WITH_PROJECTS = { projects: { select: { projectId: true, fromDate: true, project: { select: { id: true, name: true } } } } };

router.get("/", async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const rows = await prisma.ctcApprovalRequest.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { requestedAt: "desc" },
    include: { employee: { select: { id: true, name: true, empNo: true, joiningDate: true, ...EMPLOYEE_WITH_PROJECTS } } },
  });
  res.json(await withProjectName(rows));
});

router.get("/:id", async (req, res) => {
  const r = await prisma.ctcApprovalRequest.findUnique({ where: { id: Number(req.params.id) }, include: { employee: { include: EMPLOYEE_WITH_PROJECTS } } });
  if (!r) return res.status(404).json({ error: "Approval request not found" });
  const [withProject] = await withProjectName([r]);
  res.json(withProject);
});

// Read-only "what will Approve actually do to Monthly Forecast" preview — Finance can adjust
// Project/Deployment dates/Rate here and see the recalculated month-by-month cost/billing/invoice
// before ever committing anything, then fix a mistake before it becomes a real MonthlyLine. Query
// params override the request's own current values, so the panel can re-preview live as Finance
// edits the form, without needing the request itself saved first.
router.get("/:id/forecast-preview", async (req, res) => {
  const reqRow = await prisma.ctcApprovalRequest.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!reqRow) return res.status(404).json({ error: "Approval request not found" });
  if (!reqRow.employee.joiningDate) return res.status(400).json({ error: "No joining date on file for this employee yet." });
  const q = req.query as any;
  const projectId = q.projectId !== undefined ? (q.projectId ? Number(q.projectId) : null) : reqRow.projectId;
  let project = projectId ? await prisma.project.findUnique({ where: { id: projectId } }) : null;
  if (!project) project = await ensureBenchProject();
  if (!project) return res.status(400).json({ error: "No Bench project configured." });
  const isBillable = q.isBillable !== undefined ? (q.isBillable === "true" || q.isBillable === "1") : !!reqRow.isBillable;
  const deploymentStart = q.deploymentStart !== undefined ? (q.deploymentStart || null) : reqRow.deploymentStart;
  const deploymentEnd = q.deploymentEnd !== undefined ? (q.deploymentEnd || null) : reqRow.deploymentEnd;
  const rateUsd = q.rateUsd !== undefined ? (q.rateUsd === "" ? undefined : Number(q.rateUsd)) : (reqRow.rateUsd ?? undefined);
  const billingMode = q.billingMode || reqRow.billingMode;
  const startSheet = await ensureSheetForDate(deploymentStart ? new Date(deploymentStart) : reqRow.employee.joiningDate);
  // Stands in for the CtcRecord Approve will actually create (doesn't exist yet at preview time)
  // — see previewMonthlyLineImpact's own comment on virtualCtc for why this is needed at all.
  // Effective From/Till are now Finance-editable on the review form (previously read-only) — the
  // whole point of catching a mismatched date here (e.g. Effective Till landing before the
  // deployment window even starts, silently zeroing every month below) is to let Finance fix it
  // and see the preview update live, before Approve, not just view the same stale numbers.
  const ctcEffectiveFrom = q.ctcEffectiveFrom !== undefined ? (q.ctcEffectiveFrom ? new Date(q.ctcEffectiveFrom) : reqRow.ctcEffectiveFrom) : reqRow.ctcEffectiveFrom;
  const ctcEffectiveTill = q.ctcEffectiveTill !== undefined ? (q.ctcEffectiveTill ? new Date(q.ctcEffectiveTill) : null) : reqRow.ctcEffectiveTill;
  const virtualCtc = {
    effectiveFrom: ctcEffectiveFrom, effectiveTill: ctcEffectiveTill, currency: reqRow.currency, empType: reqRow.empType,
    basic: reqRow.basic, hra: reqRow.hra, otherAllowance: reqRow.otherAllowance, specialAllowance: reqRow.specialAllowance,
    conveyance: reqRow.conveyance, communication: reqRow.communication, meals: reqRow.meals, books: reqRow.books,
    driver: reqRow.driver, uniform: reqRow.uniform, bonusAnnual: reqRow.bonusAnnual, annualCostOverride: reqRow.annualCostOverride,
  };
  const result = await previewMonthlyLineImpact(startSheet.id, {
    employeeId: reqRow.employeeId, projectId: project.id, isBillable, deploymentStart, deploymentEnd, rateUsd, billingMode, virtualCtc,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // If picking this project leaves a real Bench gap before deploymentStart (see benchGapWindow's
  // own comment), preview it too — prepended, so Finance sees the FULL month-by-month impact
  // (gap Bench cost + the real project's own cost) rather than only the project's own months,
  // which silently made it look like those gap days cost nothing at all.
  const benchProject = await ensureBenchProject();
  const gap = (!benchProject || project.id !== benchProject.id) ? benchGapWindow(reqRow.employee.joiningDate, deploymentStart) : null;
  let gapMonths: any[] = [];
  if (gap && benchProject) {
    const gapStartSheet = await ensureSheetForDate(gap.start);
    const gapResult = await previewMonthlyLineImpact(gapStartSheet.id, {
      employeeId: reqRow.employeeId, projectId: benchProject.id, isBillable: false,
      deploymentStart: gap.start.toISOString(), deploymentEnd: gap.end.toISOString(), virtualCtc,
    });
    if (gapResult.ok) gapMonths = gapResult.months.map((m) => ({ ...m, isBenchGap: true }));
  }
  res.json({ projectName: project.name, isBillable, compensation: ctcSummary(reqRow), months: [...gapMonths, ...result.months] });
});

router.post("/:id/approve", async (req, res) => {
  const reqRow = await prisma.ctcApprovalRequest.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!reqRow) return res.status(404).json({ error: "Approval request not found" });
  if (reqRow.status !== "PENDING") return res.status(400).json({ error: `Already ${reqRow.status.toLowerCase()}` });
  const b = req.body || {};

  const projectId = b.projectId !== undefined ? (b.projectId ? Number(b.projectId) : null) : reqRow.projectId;
  let project = projectId ? await prisma.project.findUnique({ where: { id: projectId } }) : null;
  if (!project) project = await ensureBenchProject();

  const ctcEffectiveFrom = b.ctcEffectiveFrom ? new Date(b.ctcEffectiveFrom) : reqRow.ctcEffectiveFrom;
  const ctcEffectiveTill = b.ctcEffectiveTill !== undefined ? (b.ctcEffectiveTill ? new Date(b.ctcEffectiveTill) : null) : reqRow.ctcEffectiveTill;

  const retained = await retainedBasis(reqRow);
  const ctc = await prisma.ctcRecord.create({ data: {
    employeeId: reqRow.employeeId, effectiveFrom: ctcEffectiveFrom, effectiveTill: ctcEffectiveTill,
    currency: reqRow.currency as any, empType: reqRow.empType, ...retained,
    basic: reqRow.basic, hra: reqRow.hra, otherAllowance: reqRow.otherAllowance, specialAllowance: reqRow.specialAllowance,
    conveyance: reqRow.conveyance, communication: reqRow.communication, meals: reqRow.meals, books: reqRow.books,
    driver: reqRow.driver, uniform: reqRow.uniform, bonusAnnual: reqRow.bonusAnnual, annualCostOverride: reqRow.annualCostOverride,
  } });

  if (project) await prisma.employeeProject.create({ data: { employeeId: reqRow.employeeId, projectId: project.id, fromDate: reqRow.employee.joiningDate || ctcEffectiveFrom } });

  let monthlyLine: any = null, monthlyLineError: string | null = null;
  let benchGapLine: any = null, benchGapLineError: string | null = null;
  if (project && reqRow.employee.joiningDate) {
    const isBillable = b.isBillable !== undefined ? !!b.isBillable : reqRow.isBillable;
    const deploymentStart = b.deploymentStart !== undefined ? (b.deploymentStart || null) : reqRow.deploymentStart;
    const deploymentEnd = b.deploymentEnd !== undefined ? (b.deploymentEnd || null) : reqRow.deploymentEnd;
    // Real Bench period between joining and this deployment's own start (see benchGapWindow's own
    // comment) — created FIRST, as its own separate line, so those days' cost is actually captured
    // in Monthly Forecast instead of silently vanishing the way it used to.
    const benchProject = await ensureBenchProject();
    const gap = (!benchProject || project.id !== benchProject.id) ? benchGapWindow(reqRow.employee.joiningDate, deploymentStart) : null;
    if (gap && benchProject) {
      const gapSheet = await ensureSheetForDate(gap.start);
      const gapResult = await createMonthlyLine(gapSheet.id, {
        employeeId: reqRow.employeeId, projectId: benchProject.id, isBillable: false,
        deploymentStart: gap.start.toISOString(), deploymentEnd: gap.end.toISOString(),
        applyFuture: true,
      }, req.user!.id);
      if (gapResult.ok) benchGapLine = gapResult.line; else benchGapLineError = gapResult.error;
    }
    // Anchor to the deployment's OWN start month, not always the employee's joining month —
    // createMonthlyLine hard-rejects (400 "doesn't cover") when the anchor sheet's own month falls
    // outside the deployment window, and that rejection was silently swallowing EVERY month,
    // including the later ones applyFuture would otherwise have created. A contractor/employee
    // whose real project deployment starts later than their joining date (a real, ordinary case —
    // e.g. joins now, starts on the client project a few months out) landed with a Bench-default,
    // zero-cost placeholder AND no Monthly Sheet line at all: "CTC approved" showed a
    // monthlyLineError in the response toast, but nothing else ever surfaced or retried it.
    const sheet = await ensureSheetForDate(deploymentStart ? new Date(deploymentStart) : reqRow.employee.joiningDate);
    const result = await createMonthlyLine(sheet.id, {
      employeeId: reqRow.employeeId, projectId: project.id, isBillable,
      deploymentStart, deploymentEnd,
      rateUsd: b.rateUsd !== undefined ? b.rateUsd : (reqRow.rateUsd ?? undefined),
      billingMode: b.billingMode || reqRow.billingMode,
      // Without this, createMonthlyLine only ever creates a line in the joining month's own
      // sheet — a deployment spanning several months (e.g. Sep-Dec) silently had no cost at all
      // in every month after the first. applyFuture propagates a line into every editable future
      // sheet through deploymentEnd, exactly like the manual "Add Line to Monthly Sheet" UI does
      // with its own Apply to Future Months checkbox.
      applyFuture: true,
    }, req.user!.id);
    if (result.ok) monthlyLine = result.line; else monthlyLineError = result.error;
  }

  const updated = await prisma.ctcApprovalRequest.update({ where: { id: reqRow.id }, data: { status: "APPROVED", reviewedById: req.user!.id, reviewedAt: new Date() } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: "APPROVE_CTC", entity: "CtcApprovalRequest", entityId: String(reqRow.id), after: { employeeId: reqRow.employeeId, project: project?.name, monthlyLineId: monthlyLine?.id } } }).catch(() => {});
  // Live-refreshes Onboarding History's CTC Status pill and Monthly Forecast & Actuals for anyone
  // watching — same channel every other Offer/CTC state change already pushes through.
  if (reqRow.offerId) emitEsignUpdate("OFFER", reqRow.offerId, { status: "JOINING_CONFIRMED", ctcApproved: true });
  res.json({ request: updated, ctc, project, monthlyLine, monthlyLineError, benchGapLine, benchGapLineError });
});

// Finance rejecting the CTC undoes the Confirm Joining activation entirely — the Employee row
// (created immediately at Confirm Joining, before Finance ever reviews the CTC) never should have
// gone live. Removes it from Employee Master and any project/forecast/onboarding footprint anyone
// added in the interim, and reopens the Offer at the pre-activation stage so HR can fix the CTC
// and re-confirm. The rejection stays visible in Onboarding History via the Offer's own
// ctcRejectedAt/ctcRejectionNote, since the Employee/CtcApprovalRequest rows themselves won't
// exist anymore (the latter cascade-deletes with the Employee).
//
// Everything runs in one transaction — a partial failure (e.g. some other table still references
// this employee) must roll back entirely rather than leaving the employee half-deleted (project/
// CTC gone, but the Employee row and PENDING approval still sitting there).
router.post("/:id/reject", async (req, res) => {
  const reqRow = await prisma.ctcApprovalRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!reqRow) return res.status(404).json({ error: "Approval request not found" });
  if (reqRow.status !== "PENDING") return res.status(400).json({ error: `Already ${reqRow.status.toLowerCase()}` });
  const note = req.body?.note || null;
  const employeeId = reqRow.employeeId;

  let revertStatus: "ACCEPTED" | "APPOINTMENT_ISSUED" | "" = "";
  // Whether a still-pending "Send to IT" task existed for this offer — decided inside the
  // transaction (so it only ever fires once the reject actually commits), used afterward to notify
  // IT Admin. Finance rejecting the CTC means this hire never happened, so IT Admin must not go
  // ahead and provision a mailbox/laptop for them — same reasoning as HR's own offer cancel/
  // decline/withdraw/expire paths (see hrOffers.ts's cancelPendingItProvisioning).
  let cancelledItCandidateName: string | null = null;
  let cancelledItBusinessUnitId: number | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      // Unlink rather than delete — an SSO-auto-provisioned User row belongs to the person's
      // login account, not to this specific (about-to-be-undone) Employee record.
      await tx.user.updateMany({ where: { employeeId }, data: { employeeId: null } });
      await tx.employeeOnboardingDocument.deleteMany({ where: { employeeId } });
      await tx.employeeAction.deleteMany({ where: { employeeId } });
      await tx.reminderLog.deleteMany({ where: { employeeId } });
      await tx.employeeProject.deleteMany({ where: { employeeId } });
      await tx.monthlyLine.deleteMany({ where: { employeeId } });
      await tx.ctcRecord.deleteMany({ where: { employeeId } });
      await tx.employee.delete({ where: { id: employeeId } });

      if (reqRow.offerId) {
        const offer = await tx.offer.findUnique({ where: { id: reqRow.offerId } });
        if (offer) {
          revertStatus = offer.employmentType === "CONTRACTOR" ? "ACCEPTED" : "APPOINTMENT_ISSUED";
          await tx.offer.update({ where: { id: reqRow.offerId }, data: { employeeId: null, status: revertStatus, ctcRejectedAt: new Date(), ctcRejectionNote: note } });
          await tx.offerAuditLog.create({
            data: { offerId: reqRow.offerId, byUserId: req.user!.id, action: "CTC_REJECTED", fromStatus: "JOINING_CONFIRMED", toStatus: revertStatus,
              note: note || "CTC rejected by Finance — employee record removed, project/forecast changes reverted" },
          }).catch(() => {});
          const itReq = await tx.itProvisioningRequest.findUnique({ where: { offerId: reqRow.offerId } });
          if (itReq && !itReq.emailCreatedAt) {
            await tx.itProvisioningRequest.delete({ where: { offerId: reqRow.offerId } });
            await tx.offerAuditLog.create({ data: { offerId: reqRow.offerId, byUserId: req.user!.id, action: "IT_PROVISIONING_CANCELLED", fromStatus: null, toStatus: null, note: "Pending IT provisioning task cancelled — CTC rejected by Finance" } }).catch(() => {});
            cancelledItCandidateName = offer.candidateName;
            cancelledItBusinessUnitId = offer.businessUnitId;
          }
        }
      }
      await tx.auditLog.create({ data: { userId: req.user!.id, action: "REJECT_CTC", entity: "CtcApprovalRequest", entityId: String(reqRow.id), after: { note, offerId: reqRow.offerId } } }).catch(() => {});
    });
  } catch (e: any) {
    return res.status(400).json({ error: `Could not reject — other data is still linked to this employee (${e.message || "unknown error"}). Nothing was changed; contact an admin.` });
  }

  // Live-refreshes Offers & Lifecycle, the Confirm Joining queue and the HR Dashboard — same
  // channel those pages already watch for every other Offer status change.
  if (reqRow.offerId) emitEsignUpdate("OFFER", reqRow.offerId, { status: revertStatus, ctcRejected: true });
  if (cancelledItCandidateName) {
    // Live-removes it from IT Admin's Pending Tasks the instant this commits (same room every
    // other IT Admin queue change already broadcasts through) — the email is the actual "notified"
    // part the user asked for, this is just so they don't need a manual refresh to see it gone.
    emitHelpdeskUpdate("it_provisioning_cancelled", { offerId: reqRow.offerId });
    if (mailEnabled()) {
      const recipients = await itAdminEmails();
      const vals = { CandidateName: cancelledItCandidateName, Reason: note || "" };
      const { subject, html } = await renderFinanceEmail("IT_PROVISIONING_CANCELLED", cancelledItBusinessUnitId, vals,
        `IT provisioning cancelled: ${vals.CandidateName}`,
        `Hi,<br><br>Finance rejected the CTC for <b>${vals.CandidateName}</b> — this hire did not go through, and the pending IT provisioning request for them has been cancelled and removed from your Pending Tasks.<br>${note ? `<br>Reason: ${note}<br>` : ""}<br>No action needed — please do not proceed with setting up their laptop or email account.<br><br>Regards,<br>GenAquarius HR/Finance`);
      for (const to of recipients) { try { await notifyMail("IT_PROVISIONING_CANCELLED", { fromUpn: req.user!.email, to, subject, html }); } catch { /* one bad recipient shouldn't block the rest */ } }
    }
  }
  res.json({ ok: true, employeeRemoved: true, itProvisioningCancelled: !!cancelledItCandidateName });
});

export default router;
