// Finance's queue for the termination HR requested with just an exit date (see the
// "Request Termination" action on the Employee Master page / masters.ts's request-termination
// route). Approving here is what actually calls terminateEmployee() — same logic as the direct
// admin Terminate flow — so nothing changes on the Employee/MonthlyLine records until then.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole } from "../../auth/auth";
import { Role } from "@prisma/client";
import { requirePermission } from "../../engine/permissions";
import { terminateEmployee, previewTermination } from "../shared/masters";
import { updateMonthlyLineCore, isBenchLine } from "../finance/monthly";
import { computeMonthlyEmployeeCostUsd } from "../../engine/calc";
import { deployedFraction, scaleToWindow } from "../../engine/workdays";
import { sendMail, mailEnabled } from "../../engine/mailer";
import { notifyMail } from "../../engine/notify";
import { itAdminEmails } from "../../engine/itAdmin";
import { emitHelpdeskUpdate } from "../../engine/realtime";
import { buildFnfPdfData, computeFnfSuggestion } from "../../engine/leave";
import { renderFnfPdf, renderToBuffer } from "../../engine/hrPdf";
import { renderFnfDocxBuffer, renderFnfPreviewHtml, sampleFnfData, fnfDocxFileName, DEFAULT_FNF_BODY } from "../../engine/fnfDocx";
import { fmtDate } from "../../engine/dateFormat";

const APPROVER_ROLES = [Role.FINANCE, Role.CTO, Role.CEO];

// Finance's own templated emails (FnF send / termination-completed / disable-account notices) —
// same `HrEmailTemplate` model + null-fallback resolution HR's own templated emails already use
// (see masters.ts's TERMINATION_APPROVAL_REQUEST), just a different set of fixed keys surfaced on
// a Finance Settings tab instead of HR Settings. Falls back to the given hardcoded subject/body
// when no template row exists yet for that key — never regresses an unconfigured key.
async function renderFinanceEmail(key: string, businessUnitId: number | null | undefined, vals: Record<string, string>, fallbackSubject: string, fallbackHtml: string) {
  const tpl = await prisma.hrEmailTemplate.findFirst({ where: { key, businessUnitId: businessUnitId ?? null } })
    || await prisma.hrEmailTemplate.findFirst({ where: { key, businessUnitId: null } });
  const fillTpl = (t: string) => t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => vals[k] ?? "");
  return {
    subject: tpl ? fillTpl(tpl.subject) : fallbackSubject,
    html: tpl ? fillTpl(tpl.body).replace(/\n/g, "<br>") : fallbackHtml,
  };
}

// Parse a fiscal-year label ("FY26-27") → its calendar start year (2026). Tiny pure parser,
// duplicated from masters.ts rather than exported/imported (same convention as parseBuParam).
function fyStartYear(label: string): number {
  const m = /FY(\d{2})/i.exec(label || "");
  return m ? 2000 + Number(m[1]) : new Date().getFullYear();
}

// The editable Monthly Forecast sheet covering a given date, plus this employee's active
// (non-bench, non-expense) resource lines in it — shared by the deployment-end preview
// (read-only) and the actual approve-deployment-end mutation below, so they always agree.
async function activeLinesForDate(employeeId: number, date: Date) {
  const cm = date.getMonth() + 1;
  const termIndex = cm >= 4 ? cm - 3 : cm + 9;
  const termStartYear = cm >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  const sheets = await prisma.monthlySheet.findMany({ where: { status: { not: "LOCKED" } }, select: { id: true, fiscalYear: true, monthIndex: true } });
  const termSheet = sheets.find((s) => fyStartYear(s.fiscalYear) === termStartYear && s.monthIndex === termIndex);
  if (!termSheet) return { termSheet: null, activeLines: [] as any[] };
  const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: termSheet.id, employeeId, isExpense: false } });
  return { termSheet, activeLines: lines.filter((l) => !isBenchLine(l)) };
}

// Real CURRENT total cost (all lines, Bench included — matches terminateEmployee's own
// skipProration sum exactly) for one employee in the fiscal month covering `date`. Used so FNF
// Pending's form starts from what Finance's own step-one override actually left in Monthly
// Forecast (e.g. a Bench line's much lower cost after Deployment End was approved), not a generic
// annual-average guess that ignores everything step one already changed.
async function currentMonthCostFor(employeeId: number, date: Date): Promise<number | null> {
  const cm = date.getMonth() + 1;
  const termIndex = cm >= 4 ? cm - 3 : cm + 9;
  const termStartYear = cm >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  const sheets = await prisma.monthlySheet.findMany({ where: { status: { not: "LOCKED" } }, select: { id: true, fiscalYear: true, monthIndex: true } });
  const sheet = sheets.find((s) => fyStartYear(s.fiscalYear) === termStartYear && s.monthIndex === termIndex);
  if (!sheet) return null;
  const lines = await prisma.monthlyLine.findMany({ where: { monthlySheetId: sheet.id, employeeId, isExpense: false }, select: { costUsd: true } });
  if (!lines.length) return null;
  return lines.reduce((a, l) => a + (l.costUsd || 0), 0);
}

const router = Router();

// HR needs to know WHICH terminated employees have their FnF finalized, to populate the
// Relieving Letter page's eligibility list — but HR shouldn't see the full financial detail
// (FnF amounts, Month Cost, notice pay, etc.) this router's own GET "/" below returns, which is
// why this router is otherwise Finance/CTO/CEO-only. A separate, narrow, ids-only route ahead of
// the blanket requireRole below keeps that financial data Finance-only while still letting HR
// (and HR_OPS_ROLES generally) drive the Relieving Letter eligibility check.
router.get("/fnf-done-employee-ids", requireRole(...APPROVER_ROLES, Role.HR), async (_req, res) => {
  const rows = await prisma.terminationApprovalRequest.findMany({ where: { status: "APPROVED" }, select: { employeeId: true } });
  res.json(rows.map((r) => r.employeeId));
});

router.use(requireRole(...APPROVER_ROLES));
router.use(requirePermission("termination-approvals"));

// Read-only preview of what approving this Deployment End Date will do to Monthly Forecast — the
// termination month's per-line prorated cost/billing/invoice, PLUS every later editable month
// through the exit date, via the shared previewTermination engine (masters.ts — see its own
// comment for why this is shared rather than a second hand-written copy of the math).
router.get("/:id/deployment-end-preview", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) }, include: { employee: { select: { empType: true } } } });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  const deploymentEndDate = req.query.deploymentEndDate ? new Date(String(req.query.deploymentEndDate)) : reqRow.deploymentEndDate;
  if (!deploymentEndDate || isNaN(+deploymentEndDate)) return res.json({ found: false });
  const isFullTime = reqRow.employee?.empType === "FULL_TIME";
  const noBenchMovement = req.query.noBenchMovement != null ? req.query.noBenchMovement === "true" : !!reqRow.noBenchMovement;
  const payableDaysOverride = req.query.payableDaysOverride != null && req.query.payableDaysOverride !== "" ? Number(req.query.payableDaysOverride) : (reqRow as any).payableDaysOverride ?? null;
  const preview = await previewTermination(reqRow.employeeId, { deploymentEndDate, exitDate: reqRow.exitDate, isFullTime, noBenchMovement, payableDaysOverride });
  res.json(preview);
});

router.get("/", async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const rows = await prisma.terminationApprovalRequest.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { requestedAt: "desc" },
    include: { employee: { select: { id: true, name: true, empNo: true, email: true, location: true, empType: true, joiningDate: true } } },
  });
  // Once Deployment End Date is approved (FNF Pending), Finance's own step-one override is already
  // live in Monthly Forecast — attach it so the review form can start from THAT real figure instead
  // of a generic annual-average guess that ignores it (see currentMonthCostFor's own comment).
  // Raw SQL merge for fnfSentAt/fnfSentTo, same reason as the raw-SQL write in /fnf-settlement/
  // send — the generated Prisma Client on this container has been observed to silently omit these
  // two columns from a plain findMany() (no error, just missing from the result) even though the
  // database itself has always had them, so a plain rows.map() here would keep showing every FnF
  // as "Not Sent" regardless of what was actually sent.
  const sentInfo = rows.length
    ? await prisma.$queryRawUnsafe<{ id: number; fnfSentAt: Date | null; fnfSentTo: string | null }[]>(
        `SELECT id, fnfSentAt, fnfSentTo FROM TerminationApprovalRequest WHERE id IN (${rows.map((r) => r.id).join(",")})`,
      )
    : [];
  const sentById = new Map(sentInfo.map((s) => [s.id, s]));
  const withCurrentCost = await Promise.all(rows.map(async (r) => {
    const sent = sentById.get(r.id);
    const merged = sent ? { ...r, fnfSentAt: sent.fnfSentAt, fnfSentTo: sent.fnfSentTo } : r;
    if (!merged.deploymentEndApprovedAt) return merged;
    const isFullTime = merged.employee?.empType === "FULL_TIME";
    const billingDate = isFullTime ? merged.exitDate : merged.deploymentEndDate;
    const currentMonthCost = billingDate ? await currentMonthCostFor(merged.employeeId, new Date(billingDate)) : null;
    return { ...merged, currentMonthCost };
  }));
  res.json(withCurrentCost);
});

// ------------------------------------------------------------- FnF Settlement (.docx) templates ----
// Finance-owned template library for the .docx FnF Settlement statement, edited from Finance
// Settings → FnF Settlement (Advanced Builder + live preview — same pattern as the HR Offer/
// Appointment letter templates). Registered ahead of GET "/:id" above so these literal paths match
// first instead of being swallowed as an :id lookup.
router.get("/fnf-settlement-templates", async (_req, res) => {
  res.json(await prisma.fnfSettlementTemplate.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] }));
});

router.post("/fnf-settlement-templates", async (req, res) => {
  const { name, bodyText, empType, signatoryName, signatoryTitle } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Template name is required" });
  // A blank template silently fell back to DEFAULT_FNF_BODY only in the PREVIEW render (see
  // fnfDocx.ts) — the left-side editor stayed truly empty, so Advanced Builder looked broken (left
  // blank, right showing full default wording). Seeding real text here means the editor always
  // shows exactly what's being rendered, from the first save onward.
  const tpl = await prisma.fnfSettlementTemplate.create({
    data: {
      name: name.trim(), bodyText: (bodyText && bodyText.trim()) || DEFAULT_FNF_BODY,
      empType: empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME",
      // Blank = falls back to the shared HR Signature (see loadFnfDocxInputs) exactly as before.
      signatoryName: signatoryName?.trim() || null, signatoryTitle: signatoryTitle?.trim() || null,
    },
  });
  res.status(201).json(tpl);
});

router.put("/fnf-settlement-templates/:tid", async (req, res) => {
  const id = Number(req.params.tid);
  const { name, bodyText, isDefault, signatoryName, signatoryTitle } = req.body || {};
  // "Set as Default" only unseats the other default WITHIN this same empType — a full-time default
  // and a contractor default coexist independently, each type keeping its own.
  if (isDefault) {
    const existing = await prisma.fnfSettlementTemplate.findUnique({ where: { id } });
    if (existing) await prisma.fnfSettlementTemplate.updateMany({ where: { NOT: { id }, empType: existing.empType }, data: { isDefault: false } });
  }
  const tpl = await prisma.fnfSettlementTemplate.update({
    where: { id },
    // Same "never save truly blank" rule as Create — otherwise clearing the box and saving would
    // bring the left/right-mismatch bug straight back for this template.
    data: {
      name: name !== undefined ? name : undefined, bodyText: bodyText !== undefined ? ((bodyText && bodyText.trim()) || DEFAULT_FNF_BODY) : undefined, isDefault: isDefault !== undefined ? !!isDefault : undefined,
      signatoryName: signatoryName !== undefined ? (signatoryName?.trim() || null) : undefined,
      signatoryTitle: signatoryTitle !== undefined ? (signatoryTitle?.trim() || null) : undefined,
    },
  });
  res.json(tpl);
});

router.delete("/fnf-settlement-templates/:tid", async (req, res) => {
  await prisma.fnfSettlementTemplate.delete({ where: { id: Number(req.params.tid) } }).catch(() => {});
  res.json({ ok: true });
});

// Live-preview pane for the Advanced Builder — renders the in-progress bodyText (not yet saved)
// against a fixed sample candidate, as HTML (a browser can't render .docx inline; the real
// download/send below always uses the actual .docx renderer against real request data).
router.post("/fnf-settlement-templates/preview", (req, res) => {
  const sample = sampleFnfData(req.body?.empType);
  // Live, not-yet-saved signatory override, same as bodyText — lets the preview reflect whatever
  // Finance is currently typing into the Signature fields before they hit Save.
  if (req.body?.signatoryName?.trim()) sample.signatoryName = req.body.signatoryName.trim();
  if (req.body?.signatoryTitle?.trim()) sample.signatoryTitle = req.body.signatoryTitle.trim();
  res.setHeader("Content-Type", "text/html");
  res.send(renderFnfPreviewHtml(String(req.body?.bodyText || ""), sample));
});

router.get("/:id", async (req, res) => {
  const r = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) }, include: { employee: true } });
  if (!r) return res.status(404).json({ error: "Termination request not found" });
  res.json(r);
});

// Step one of the two-approval flow (either employment type, whenever a Deployment End Date was
// given): approves just the Deployment End Date, adjusting Monthly Forecast immediately — no FnF,
// Employee.exitDate is left untouched (they stay active) — so the forecast reflects reality right
// away even though the paperwork/FnF close-out (step two, /approve below) may happen later.
//   • Full-time: reuses Monthly Forecast's own deployment-window/bench engine (the exact cascade
//     a Finance user gets by editing the line's Deployment End by hand, applyFuture:true) — the
//     project line ends at the given date and the employee sits on Bench for every month after it
//     up until the eventual termination date.
//   • Contractor/vendor: no bench — the deployment-end month's lines are truncated and every
//     fully-future month's lines are removed outright (terminateEmployee's existing delete path).
router.post("/:id/approve-deployment-end", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) }, include: { employee: { select: { id: true, name: true, empNo: true, email: true, empType: true } } } });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (reqRow.status !== "PENDING") return res.status(400).json({ error: `Already ${reqRow.status.toLowerCase()}` });
  if (!reqRow.deploymentEndDate) return res.status(400).json({ error: "This request has no Deployment End Date to approve." });
  if (reqRow.deploymentEndApprovedAt) return res.status(400).json({ error: "Deployment End Date has already been approved." });
  const isFullTime = reqRow.employee?.empType === "FULL_TIME";
  const b = req.body || {};
  const deploymentEndDate = b.deploymentEndDate ? new Date(b.deploymentEndDate) : reqRow.deploymentEndDate;
  // Finance can override HR's No Bench Movement choice here too, same as monthCost/invoiceAmount.
  const noBenchMovement = b.noBenchMovement != null ? !!b.noBenchMovement : reqRow.noBenchMovement;

  let adjustment: any;
  if (isFullTime && !noBenchMovement) {
    const { termSheet, activeLines } = await activeLinesForDate(reqRow.employeeId, deploymentEndDate);
    if (!termSheet) return res.status(400).json({ error: "No editable Monthly Forecast sheet found for the Deployment End Date's month." });
    let benched = 0, propagated = 0, removed = 0;
    // An employee can legitimately have no active (non-bench) project line in the Deployment End
    // Date's month — already on Bench that month, a stub/test record, or simply unassigned that
    // month — there's nothing to prorate/bench-convert in that case, but Finance should still be
    // able to record the approval and move on rather than being hard-blocked.
    if (activeLines.length) {
      // Prorate the edited (deployment-end) month's own cost/hours/billing/invoice down to the
      // deployed part of it — updateMonthlyLineCore only auto-prorates FUTURE months; the edited
      // month is expected to arrive already prorated in the body, exactly like Monthly Forecast's
      // own Edit Resource Row modal does (applyWindow's windowFrac), otherwise estimated billing and
      // actual invoice are left at the full month's value alongside the new Bench row for the rest.
      const fullMonthCost = await computeMonthlyEmployeeCostUsd(reqRow.employeeId, termSheet.fiscalYear, termSheet.monthIndex);
      // Finance may override the Termination Month Cost here too (same as the final Approve &
      // Terminate step) — split proportionally across lines when there's more than one (double-dip).
      // Estimated Billing / Actual Invoice always stay auto-computed from the date, never overridden.
      const monthCostOverride = b.monthCost != null && b.monthCost !== "" ? Number(b.monthCost) : null;
      const withFrac = activeLines.map((l) => ({ l, frac: deployedFraction(termSheet.fiscalYear, termSheet.monthIndex, l.deploymentStart, deploymentEndDate).fraction }));
      const naturalTotal = withFrac.reduce((a, x) => a + fullMonthCost * x.frac, 0);
      for (const { l, frac } of withFrac) {
        const naturalCost = fullMonthCost * frac;
        const share = naturalTotal > 0 ? naturalCost / naturalTotal : 1 / withFrac.length;
        const finalCost = monthCostOverride != null ? monthCostOverride * share : naturalCost;
        const scaled = scaleToWindow(l as any, { hoursFrom: 1, costFrom: 1, to: frac });
        const r = await updateMonthlyLineCore(l.id, {
          deploymentEnd: deploymentEndDate.toISOString(),
          costUsd: Math.round(finalCost * 100) / 100,
          estimateHours: scaled.estimateHours, actualHours: scaled.actualHours,
          applyFuture: true,
        }, req.user!.id);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        // A DAILY/MONTHLY-billed line's amount doesn't auto-scale with hours in computeLineUpdate
        // (a fixed monthly fee re-derives its own rate from hours instead of shrinking) — correct
        // for a routine mid-project edit, but not here: a termination should always prorate
        // estimated billing and actual invoice to the deployment end date, so force it directly.
        await prisma.monthlyLine.update({ where: { id: l.id }, data: { billingAmount: scaled.billingAmount, invoiceAmount: scaled.invoiceAmount } });
        benched += r.benched; propagated += r.propagated; removed += r.removed;
      }
    }
    // The Bench cascade above (applyFuture) has no idea an exit date already exists — Employee.
    // exitDate isn't set until the final Approve & Terminate — so left alone it would keep
    // benching this person in every future month indefinitely while Finance sits on FnF. No
    // employee should show in forecast (project or Bench) past their own Termination Date, so
    // clear anything sitting in editable months strictly after it right now.
    const exitCm = reqRow.exitDate.getMonth() + 1;
    const exitTermIndex = exitCm >= 4 ? exitCm - 3 : exitCm + 9;
    const exitTermStartYear = exitCm >= 4 ? reqRow.exitDate.getFullYear() : reqRow.exitDate.getFullYear() - 1;
    const allSheets = await prisma.monthlySheet.findMany({ where: { status: { not: "LOCKED" } }, select: { id: true, fiscalYear: true, monthIndex: true } });
    const pastExitSheets = allSheets.filter((s) => {
      const sy = fyStartYear(s.fiscalYear);
      return sy > exitTermStartYear || (sy === exitTermStartYear && s.monthIndex > exitTermIndex);
    });
    const pastExitCleanup = await prisma.monthlyLine.deleteMany({ where: { monthlySheetId: { in: pastExitSheets.map((s) => s.id) }, isExpense: false, employeeId: reqRow.employeeId } });
    adjustment = { ok: true, benched, propagated, removed: removed + pastExitCleanup.count };
  } else {
    const result = await terminateEmployee(reqRow.employeeId, {
      deploymentEndDate, setExitDate: false, fnfAmount: 0, monthCost: b.monthCost, invoiceAmount: b.invoiceAmount,
    }, req.user!.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    adjustment = result;
  }
  const updated = await prisma.terminationApprovalRequest.update({ where: { id: reqRow.id }, data: {
    deploymentEndDate, noBenchMovement, deploymentEndApprovedById: req.user!.id, deploymentEndApprovedAt: new Date(),
  } });
  // "Deactivate" is complete as of this approval (cost is already gone — see the block above) —
  // for anyone who genuinely stops working right now (a Contractor/Intern, or a Full-Time employee
  // whose Deployment End skips Bench via noBenchMovement), close off their access immediately:
  // delete their local app login, and queue IT Admin's offboarding task for the Microsoft 365 side
  // (disable account / remove license / remove from the Intune access group — see itAdmin.ts).
  // A Full-Time employee going to Bench (noBenchMovement false) is still genuinely active and
  // expected to work — no offboarding is queued for them until THEIR OWN later no-bench-movement
  // approval or the final Approve & Terminate step.
  const readyForOffboarding = !isFullTime || noBenchMovement;
  if (readyForOffboarding) {
    // employeeId is unique on ItOffboardingRequest, so a reinstated-then-re-terminated employee
    // (see /employees/:id/reinstate) already has a row here from their PRIOR employment stint —
    // it must be reset back to pending (not left alone, or IT never gets notified this time), but
    // a row from THIS SAME termination cycle that's still pending must be left untouched.
    const existingReq = await prisma.itOffboardingRequest.findUnique({ where: { employeeId: reqRow.employeeId } });
    if (!existingReq || existingReq.completedAt) {
      const existingUser = await prisma.user.findFirst({ where: { employeeId: reqRow.employeeId } });
      if (existingUser) await prisma.user.delete({ where: { id: existingUser.id } }).catch(() => {});
      await prisma.itOffboardingRequest.upsert({
        where: { employeeId: reqRow.employeeId },
        update: { completedAt: null, completedById: null, accountDisabled: false, licenseRemoved: false, removedFromGroup: false, error: null, createdAt: new Date(), createdById: req.user!.id, terminationApprovalRequestId: reqRow.id },
        create: { employeeId: reqRow.employeeId, terminationApprovalRequestId: reqRow.id, createdById: req.user!.id },
      });
      emitHelpdeskUpdate("it_offboarding_queued", { employeeId: reqRow.employeeId, employeeName: reqRow.employee?.name });
    }
  }
  res.json({ request: updated, adjustment, offboardingQueued: readyForOffboarding });
});

// Shared finalize logic — called by /approve directly, and by /fnf-settlement/send when Finance
// sends the FnF document straight from a still-PENDING request (that send action IS what triggers
// the actual termination + move to Past/Terminated, per explicit request — Finance no longer has
// to click a separate Approve & Terminate first if they're ready to send FnF right away).
async function finalizeTermination(id: number, b: any, user: { id: number; email: string }):
  Promise<{ ok: true; updated: any; result: any } | { ok: false; status: number; error: string }> {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id }, include: { employee: { select: { empType: true, name: true, empNo: true, businessUnitId: true } } } });
  if (!reqRow) return { ok: false, status: 404, error: "Termination request not found" };
  if (reqRow.status !== "PENDING") return { ok: false, status: 400, error: `Already ${reqRow.status.toLowerCase()}` };
  const isFullTime = reqRow.employee?.empType === "FULL_TIME";
  if (reqRow.deploymentEndDate && !reqRow.deploymentEndApprovedAt) {
    return { ok: false, status: 400, error: "Approve the Deployment End Date first." };
  }
  // Contractor-only re-prorate guard: their forecast was already truncated against
  // deploymentEndDate in step one, so terminateEmployee must top up FnF, not re-shrink it.
  // Full-time's deployment end (if any) already played out via Monthly Forecast's own bench
  // engine in an earlier month — it must never feed terminateEmployee's billing-end pivot here,
  // which always stays on the exit date itself for full-time.
  const alreadyProrated = !isFullTime && !!reqRow.deploymentEndApprovedAt;
  const fnfAmount = +b.fnfAmount || 0;
  const result = await terminateEmployee(reqRow.employeeId, {
    exitDate: b.exitDate || reqRow.exitDate,
    deploymentEndDate: isFullTime ? undefined : (alreadyProrated ? reqRow.deploymentEndDate : (b.deploymentEndDate || reqRow.deploymentEndDate || undefined)),
    skipProration: alreadyProrated,
    // Full-time: FnF tops up their own Bench/project line's cost, same as always. Contractor:
    // b.monthCost already IS FNF Amount + Arrear (the client's contractorSettlementUsd, sent as an
    // explicit override) — pass 0 here so terminateEmployee's own cost application doesn't ALSO add
    // fnfAmount on top of a total that already includes it.
    fnfAmount: isFullTime ? fnfAmount : 0, basis: b.basis, monthCost: b.monthCost, invoiceAmount: b.invoiceAmount,
  }, user.id);
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  // Persist whatever Finance reviewed/overrode (basic/notice/EL/reimbursement or deployment end
  // date) back onto the request row so the approved record reflects the actual final numbers,
  // not just what HR originally sent.
  const updateData: any = { status: "APPROVED", reviewedById: user.id, reviewedAt: new Date(), finalFnfAmount: fnfAmount, finalMonthCost: result.monthCost };
  if (!reqRow.deploymentEndApprovedAt && b.deploymentEndDate !== undefined) updateData.deploymentEndDate = b.deploymentEndDate ? new Date(b.deploymentEndDate) : null;
  if (b.resignationDate !== undefined) updateData.resignationDate = b.resignationDate ? new Date(b.resignationDate) : null;
  if (b.requiredNoticeDays !== undefined) updateData.requiredNoticeDays = Number(b.requiredNoticeDays) || 0;
  if (b.servedNoticeDays !== undefined) updateData.servedNoticeDays = Number(b.servedNoticeDays) || 0;
  if (b.payFullNoticePeriod !== undefined) updateData.payFullNoticePeriod = !!b.payFullNoticePeriod;
  if (b.basicSalary !== undefined) updateData.basicSalary = Number(b.basicSalary) || 0;
  if (b.basicOnly !== undefined) updateData.basicOnly = Number(b.basicOnly) || 0;
  if (b.elEncashmentDays !== undefined) updateData.elEncashmentDays = Number(b.elEncashmentDays) || 0;
  if (b.elEncashmentAmount !== undefined) updateData.elEncashmentAmount = Number(b.elEncashmentAmount) || 0;
  if (b.noticePayAmount !== undefined) updateData.noticePayAmount = Number(b.noticePayAmount) || 0;
  if (b.reimbursementAmount !== undefined) updateData.reimbursementAmount = Number(b.reimbursementAmount) || 0;
  if (b.daysWorkedSalary !== undefined) updateData.daysWorkedSalary = Number(b.daysWorkedSalary) || 0;
  if (b.otherFlexiBenefitsAmount !== undefined) updateData.otherFlexiBenefitsAmount = Number(b.otherFlexiBenefitsAmount) || 0;
  if (b.tdsAmount !== undefined) updateData.tdsAmount = Number(b.tdsAmount) || 0;
  if (b.includeGst !== undefined) updateData.includeGst = !!b.includeGst;
  if (b.gstAmount !== undefined) updateData.gstAmount = b.gstAmount === "" || b.gstAmount == null ? null : Number(b.gstAmount);
  if (b.fnfFinalizationDate !== undefined) updateData.fnfFinalizationDate = b.fnfFinalizationDate ? new Date(b.fnfFinalizationDate) : null;
  // Contractor-only FnF document overrides — Finance can review/override whatever HR submitted,
  // same as every other field here (see their own schema comments for exactly what each affects).
  if (b.fnfPrintDate !== undefined) updateData.fnfPrintDate = b.fnfPrintDate ? new Date(b.fnfPrintDate) : null;
  if (b.payableDaysOverride !== undefined) updateData.payableDaysOverride = b.payableDaysOverride === "" || b.payableDaysOverride == null ? null : Number(b.payableDaysOverride);
  if (b.leavesCount !== undefined) updateData.leavesCount = b.leavesCount === "" || b.leavesCount == null ? null : Number(b.leavesCount);
  if (b.arrearAmount !== undefined) updateData.arrearAmount = b.arrearAmount === "" || b.arrearAmount == null ? null : Number(b.arrearAmount);
  // HR may have left "Email Terminated" unchecked at request time — Finance gets one more chance
  // to flip it to true here before finalizing. Never let it go from true back to false at this
  // step (the account may already be disabled by then; the checkbox only ever moves forward).
  // Blocked while the employee is still sitting on Bench (a two-step request with Bench movement,
  // i.e. deploymentEndDate set and noBenchMovement not checked) — their O365 account can't be
  // disabled while they're still active and expected to work from the Bench.
  if (b.emailTerminated === true) {
    const stillOnBench = !!reqRow.deploymentEndDate && !reqRow.noBenchMovement && isFullTime;
    if (stillOnBench) return { ok: false, status: 400, error: "Cannot disable email while the employee is still on Bench — only available when No Bench Movement was selected." };
    updateData.emailTerminated = true;
  }
  const updated = await prisma.terminationApprovalRequest.update({ where: { id: reqRow.id }, data: updateData });
  // Notify everyone in the approval chain — the HR requester plus Finance/CTO/CEO — that the
  // termination is now finalized, mirroring the "request submitted" notification HR got earlier.
  if (mailEnabled()) {
    const recipients = await prisma.user.findMany({
      where: { OR: [{ id: reqRow.requestedById ?? -1 }, { role: { in: ["FINANCE", "CTO", "CEO"] } }] },
      select: { email: true },
    });
    const exitDateStr = fmtDate(updated.exitDate);
    const vals = { EmployeeName: reqRow.employee?.name || "", EmployeeId: reqRow.employee?.empNo || "", ExitDate: exitDateStr, MonthCost: (result.monthCost || 0).toFixed(2), FnfAmount: (result.fnf || 0).toFixed(2) };
    const { subject, html } = await renderFinanceEmail("TERMINATION_COMPLETED_NOTICE", reqRow.employee?.businessUnitId, vals,
      `Termination completed: ${vals.EmployeeName} (${vals.EmployeeId})`,
      `Hi,<br><br>The termination for <b>${vals.EmployeeName}</b> (${vals.EmployeeId}) has been approved and completed.<br>Exit Date: ${vals.ExitDate}<br>Final Termination Month Cost: $${vals.MonthCost}<br>FnF Amount: $${vals.FnfAmount}<br><br>They now appear in Past / Terminated Employees.<br><br>Regards,<br>GenAquarius`);
    for (const r of recipients) { if (!r.email) continue; try { await notifyMail("TERMINATION_COMPLETED_NOTICE", { fromUpn: user.email, to: r.email, subject, html }); } catch { /* one bad recipient shouldn't block the rest */ } }
  }
  // "Disable Email" IT-security notification — fires the moment emailTerminated becomes true
  // (whether HR checked it at request time or Finance flipped it just now), to Finance/HR plus
  // the configured IT admin contact (Settings → HR Settings). Deduped via
  // emailTerminatedNotifiedAt so re-approving/re-fetching this request never re-sends it.
  if (updated.emailTerminated && !reqRow.emailTerminatedNotifiedAt && mailEnabled()) {
    const recipients = new Set<string>(await itAdminEmails());
    if (reqRow.requestedById) { const hrUser = await prisma.user.findUnique({ where: { id: reqRow.requestedById }, select: { email: true } }); if (hrUser?.email) recipients.add(hrUser.email); }
    recipients.add(user.email);
    const disableVals = { EmployeeName: reqRow.employee?.name || "", EmployeeId: reqRow.employee?.empNo || "" };
    const { subject, html } = await renderFinanceEmail("IT_DISABLE_ACCOUNT_NOTICE", reqRow.employee?.businessUnitId, disableVals,
      `Action required: disable O365 account for ${disableVals.EmployeeName} (${disableVals.EmployeeId})`,
      `Hi,<br><br>The termination for <b>${disableVals.EmployeeName}</b> (${disableVals.EmployeeId}) has been finalized and their Office 365 account is ready to be disabled.<br><br>Please deactivate their email account in the Microsoft 365 admin center.<br><br>Regards,<br>GenAquarius`);
    for (const to of recipients) { try { await notifyMail("IT_DISABLE_ACCOUNT_NOTICE", { fromUpn: user.email, to, subject, html }); } catch { /* one bad recipient shouldn't block the rest */ } }
    await prisma.terminationApprovalRequest.update({ where: { id: reqRow.id }, data: { emailTerminatedNotifiedAt: new Date() } });
  }
  // Deferred offboarding — a Full-Time employee who was still on Bench at step one (Deactivate)
  // never got their login deleted / IT Admin task queued then, since they were genuinely still
  // active. The final Approve & Terminate here is unconditional (everyone reaching it is truly
  // done), so queue it now if it wasn't already queued at step one.
  const alreadyQueued = await prisma.itOffboardingRequest.findUnique({ where: { employeeId: reqRow.employeeId } });
  if (!alreadyQueued || alreadyQueued.completedAt) {
    const existingUser = await prisma.user.findFirst({ where: { employeeId: reqRow.employeeId } });
    if (existingUser) await prisma.user.delete({ where: { id: existingUser.id } }).catch(() => {});
    await prisma.itOffboardingRequest.upsert({
      where: { employeeId: reqRow.employeeId },
      update: { completedAt: null, completedById: null, accountDisabled: false, licenseRemoved: false, removedFromGroup: false, error: null, createdAt: new Date(), createdById: user.id, terminationApprovalRequestId: reqRow.id },
      create: { employeeId: reqRow.employeeId, terminationApprovalRequestId: reqRow.id, createdById: user.id },
    });
    emitHelpdeskUpdate("it_offboarding_queued", { employeeId: reqRow.employeeId, employeeName: reqRow.employee?.name });
  }
  return { ok: true, updated, result };
}

// Approve & Terminate (no email) — the plain finalize action. This route was missing entirely
// (only /approve-deployment-end, /fnf-settlement/send and /reject existed), so every click of this
// button hit an unmatched Express route and got back Express's default HTML 404 page instead of
// JSON — the exact cause of the long-running "Unexpected token '<', <!DOCTYPE" reports, which were
// never actually a deploy-timing collision.
router.post("/:id/approve", async (req, res) => {
  const fin = await finalizeTermination(Number(req.params.id), req.body || {}, req.user!);
  if (!fin.ok) return res.status(fin.status).json({ error: fin.error });
  res.json({ request: fin.updated, termination: fin.result });
});

// Finance's editable remarks on the FnF settlement document — reviewed/edited any time after
// the termination is finalized (APPROVED), before or between downloads. No separate "generate"
// step: the PDF (below) always renders live from current data, so editing the note and
// re-downloading is how "review and edit" works, same convention as Offer/Appointment letters.
router.put("/:id/fnf-note", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (reqRow.status !== "APPROVED") return res.status(400).json({ error: "FnF has not been finalized yet." });
  const updated = await prisma.terminationApprovalRequest.update({ where: { id: reqRow.id }, data: { fnfNote: req.body?.note ?? null } });
  res.json({ ok: true, fnfNote: updated.fnfNote });
});

router.get("/:id/fnf-document.pdf", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({
    where: { id: Number(req.params.id) },
    include: { employee: { select: { name: true, empNo: true, designation: true, department: true, phone: true, empType: true, joiningDate: true, businessUnitId: true } } },
  });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (reqRow.status !== "APPROVED") return res.status(400).json({ error: "FnF has not been finalized yet." });
  const data = await buildFnfPdfData(reqRow);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="FNF_${reqRow.employee?.empNo || reqRow.employeeId}.pdf"`);
  renderFnfPdf(data, res);
});

// Live PDF preview for a still-PENDING request — Finance reviews exactly what the FnF Settlement
// will look like, with whatever they've currently typed into the form (query-param overrides),
// BEFORE finalizing anything. Same query-param-driven pattern as deployment-end-preview above.
// Once APPROVED, falls back to the real saved figures (query overrides no longer apply — the
// numbers are locked in at that point) so this same button keeps working after finalization too.
const FNF_NUMERIC_OVERRIDES = ["requiredNoticeDays", "servedNoticeDays", "basicSalary", "elEncashmentDays", "elEncashmentAmount", "noticePayAmount", "reimbursementAmount", "daysWorkedSalary", "otherFlexiBenefitsAmount", "tdsAmount", "finalFnfAmount", "gstAmount", "payableDaysOverride", "leavesCount", "arrearAmount"] as const;
router.get("/:id/fnf-preview.pdf", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({
    where: { id: Number(req.params.id) },
    include: { employee: { select: { name: true, empNo: true, designation: true, department: true, phone: true, empType: true, joiningDate: true, businessUnitId: true } } },
  });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  const q = req.query || {};
  const merged: any = { ...reqRow };
  // Query overrides apply up until the FnF is actually sent — covers both the original PENDING-
  // stage preview AND the Regenerate form's own live preview on an already-APPROVED, Not-Sent
  // request (Regenerate's edits aren't saved until Apply, so this is the only way the preview can
  // reflect them). Once sent, the employee already has the numbers — locked, no overrides.
  if (!reqRow.fnfSentAt) {
    if (q.exitDate) merged.exitDate = new Date(String(q.exitDate));
    if (q.resignationDate) merged.resignationDate = new Date(String(q.resignationDate));
    if (q.fnfFinalizationDate) merged.fnfFinalizationDate = new Date(String(q.fnfFinalizationDate));
    if (q.deploymentEndDate) merged.deploymentEndDate = new Date(String(q.deploymentEndDate));
    if (q.fnfPrintDate) merged.fnfPrintDate = new Date(String(q.fnfPrintDate));
    // Not numeric — handled separately. Affects only the "Basic (N Days)" line's day-count label
    // (the dollar amount itself already comes from the noticePayAmount override below regardless).
    if (q.payFullNoticePeriod != null) merged.payFullNoticePeriod = q.payFullNoticePeriod === "true";
    if (q.includeGst != null) merged.includeGst = q.includeGst === "true";
    for (const k of FNF_NUMERIC_OVERRIDES) if (q[k] != null && q[k] !== "") merged[k] = Number(q[k]);
  }
  const data = await buildFnfPdfData(merged);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="FNF_Preview_${reqRow.employee?.empNo || reqRow.employeeId}.pdf"`);
  renderFnfPdf(data, res);
});

async function loadFnfDocxInputs(id: number) {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({
    where: { id },
    include: { employee: { select: { name: true, empNo: true, email: true, designation: true, department: true, phone: true, empType: true, joiningDate: true, businessUnitId: true } } },
  });
  if (!reqRow) return null;
  if (reqRow.status !== "APPROVED") return { reqRow, data: null, tpl: null };
  // Full-time and contractor FnF letters are different enough documents (Basic/Notice Pay/EL vs
  // Gross Payable/GST/TDS) that each employment type keeps its own default template — falls back to
  // any template of that same type if none is marked default, never to the OTHER type's template.
  const empType = reqRow.employee?.empType === "FULL_TIME" ? "FULL_TIME" : "CONTRACTOR";
  const [data, tpl] = await Promise.all([
    buildFnfPdfData(reqRow),
    prisma.fnfSettlementTemplate.findFirst({ where: { isDefault: true, empType } }).then((t) => t || prisma.fnfSettlementTemplate.findFirst({ where: { empType } })),
  ]);
  // Per-template signatory override — when THIS FnF template has its own Name/Title set (Finance
  // Settings → FnF Settlement → Advanced Builder → Signature), it signs the real .docx/preview as
  // that person instead of the shared HR Signature getHrSignature() already put on `data`.
  if (tpl?.signatoryName) data.signatoryName = tpl.signatoryName;
  if (tpl?.signatoryTitle) data.signatoryTitle = tpl.signatoryTitle;
  return { reqRow, data, tpl };
}

// Regenerates an already-APPROVED, Not-Sent FnF — the full Approve-stage form again (dates, FnF
// inputs, FNF Amount/Termination Month Cost/Invoice Amount), not just the settlement figures.
// Available for every employee type — full-time uses the EL/Notice-Pay/Days-Worked suggestion
// engine; everyone else (contractor/vendor/etc.) is billing/invoice-based, same split
// finalizeTermination itself uses. Re-runs terminateEmployee() with whatever's now on screen,
// which re-applies the Termination Month Cost to Monthly Forecast exactly like the original
// Approve did (same engine, called again) — safe to repeat since it always SETS the month's cost
// to the given total rather than adding on top of it (for a contractor, that total already IS
// FNF Amount + Arrear — see TerminationApprovalDetail's contractorSettlementUsd — so there's no
// separate FnF expense line to keep in sync here anymore). Only while still Not Sent — once sent,
// the employee already has the numbers, so the record is locked
// exactly like the Issue/Send pattern everywhere else in HR uses. Deliberately does NOT touch
// Deployment End Date, No Bench Movement, Disable Email, IT offboarding, or any of the one-time
// termination notifications — those already fired/applied at the original Approve and are out of
// scope for "regenerate the FnF figures".
router.post("/:id/fnf-regenerate", async (req, res) => {
  const id = Number(req.params.id);
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (reqRow.status !== "APPROVED") return res.status(400).json({ error: "FnF has not been finalized yet." });
  if (reqRow.fnfSentAt) return res.status(400).json({ error: "Already sent — cannot regenerate." });
  const b = req.body || {};
  const isFullTime = reqRow.employee?.empType === "FULL_TIME";
  const exitDate = b.exitDate ? new Date(b.exitDate) : reqRow.exitDate;
  const resignationDate = b.resignationDate !== undefined ? (b.resignationDate ? new Date(b.resignationDate) : null) : undefined;
  const fnfFinalizationDate = b.fnfFinalizationDate !== undefined ? (b.fnfFinalizationDate ? new Date(b.fnfFinalizationDate) : null) : reqRow.fnfFinalizationDate;
  const fnfAmount = b.fnfAmount != null ? Number(b.fnfAmount) : (reqRow.finalFnfAmount || 0);
  // Without an explicit override, terminateEmployee's own month-cost calc falls back to reading
  // the line's CURRENT costUsd — which, on this second call, is already the result of the FIRST
  // Approve, not the pre-termination figure. Recomputing proration/FnF on top of an already-
  // terminated cost would compound instead of overwrite. Defaulting to the stored finalMonthCost
  // (the original Approve's own applied total) guarantees terminateEmployee always takes its
  // direct-override branch here — a clean overwrite, never a second compounding calculation.
  const monthCost = (b.monthCost != null && b.monthCost !== "") ? b.monthCost : (reqRow.finalMonthCost ?? undefined);
  // Same alreadyProrated split finalizeTermination itself uses — a contractor's forecast was
  // already truncated against deploymentEndDate at the (mandatory, already-completed) Deployment
  // End Date approval step, so this must top up FnF, never re-shrink it a second time.
  const alreadyProrated = !isFullTime && !!reqRow.deploymentEndApprovedAt;
  const result = await terminateEmployee(reqRow.employeeId, {
    exitDate: b.exitDate || reqRow.exitDate,
    // Full-time's deployment end (if any) already played out via Monthly Forecast's own bench
    // engine in an earlier month — same as the original Approve, it must never feed
    // terminateEmployee's billing-end pivot here, which always stays on the exit date for full-time.
    deploymentEndDate: isFullTime ? undefined : (reqRow.deploymentEndDate || undefined),
    skipProration: alreadyProrated,
    fnfAmount: isFullTime ? fnfAmount : 0, basis: b.basis, monthCost, invoiceAmount: b.invoiceAmount,
  }, req.user!.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const fullTimeData: any = {};
  if (isFullTime) {
    const requiredNoticeDays = b.requiredNoticeDays != null ? Number(b.requiredNoticeDays) : reqRow.requiredNoticeDays;
    const servedNoticeDays = b.servedNoticeDays != null ? Number(b.servedNoticeDays) : reqRow.servedNoticeDays;
    const payFullNoticePeriod = b.payFullNoticePeriod != null ? !!b.payFullNoticePeriod : reqRow.payFullNoticePeriod;
    const basicSalary = b.basicSalary != null ? Number(b.basicSalary) : (reqRow.basicSalary || 0);
    const reimbursementAmount = b.reimbursementAmount != null ? Number(b.reimbursementAmount) : (reqRow.reimbursementAmount || 0);
    const ctc = await prisma.ctcRecord.findFirst({ where: { employeeId: reqRow.employeeId }, orderBy: { effectiveFrom: "desc" } });
    // Prefer whatever's already on the row (HR's original submission, or Finance's own earlier
    // edit) over re-deriving fresh from the live CTC record — same bug this basicOnly column was
    // added to fix everywhere else on this request.
    const basicOnly = b.basicOnly != null ? Number(b.basicOnly) : (reqRow.basicOnly ?? ctc?.basic ?? 0);
    const suggestion = await computeFnfSuggestion(reqRow.employeeId, exitDate, basicSalary, requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicOnly, reimbursementAmount);
    Object.assign(fullTimeData, {
      requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicSalary, basicOnly, reimbursementAmount,
      elEncashmentDays: b.elEncashmentDays != null ? Number(b.elEncashmentDays) : suggestion.elEncashmentDays,
      elEncashmentAmount: b.elEncashmentAmount != null ? Number(b.elEncashmentAmount) : suggestion.elEncashmentAmount,
      noticePayAmount: b.noticePayAmount != null ? Number(b.noticePayAmount) : suggestion.noticePayAmount,
      daysWorkedSalary: b.daysWorkedSalary != null ? Number(b.daysWorkedSalary) : suggestion.daysWorkedSalary,
      otherFlexiBenefitsAmount: b.otherFlexiBenefitsAmount != null ? Number(b.otherFlexiBenefitsAmount) : reqRow.otherFlexiBenefitsAmount,
      tdsAmount: b.tdsAmount != null ? Number(b.tdsAmount) : suggestion.tdsAmount,
    });
  }
  const contractorData: any = {};
  if (!isFullTime) {
    Object.assign(contractorData, {
      includeGst: b.includeGst != null ? !!b.includeGst : reqRow.includeGst,
      gstAmount: b.gstAmount !== undefined ? (b.gstAmount === "" || b.gstAmount == null ? null : Number(b.gstAmount)) : reqRow.gstAmount,
      fnfPrintDate: b.fnfPrintDate !== undefined ? (b.fnfPrintDate ? new Date(b.fnfPrintDate) : null) : reqRow.fnfPrintDate,
      payableDaysOverride: b.payableDaysOverride !== undefined ? (b.payableDaysOverride === "" || b.payableDaysOverride == null ? null : Number(b.payableDaysOverride)) : reqRow.payableDaysOverride,
      leavesCount: b.leavesCount !== undefined ? (b.leavesCount === "" || b.leavesCount == null ? null : Number(b.leavesCount)) : reqRow.leavesCount,
      arrearAmount: b.arrearAmount !== undefined ? (b.arrearAmount === "" || b.arrearAmount == null ? null : Number(b.arrearAmount)) : reqRow.arrearAmount,
    });
  }
  const updated = await prisma.terminationApprovalRequest.update({ where: { id }, data: {
    exitDate, resignationDate, fnfFinalizationDate,
    finalFnfAmount: fnfAmount, finalMonthCost: result.monthCost,
    ...fullTimeData, ...contractorData,
  } });
  res.json({ ok: true, updated, monthCost: result.monthCost });
});

// The Word-document counterpart of fnf-document.pdf above — same "always regenerated from current
// data" rule, named FF_Settlement_<FirstName>_<requestId>.docx so Finance's downloads folder reads
// clearly (e.g. "FF_Settlement_Venkatesan_1.docx").
router.get("/:id/fnf-settlement.docx", async (req, res) => {
  const loaded = await loadFnfDocxInputs(Number(req.params.id));
  if (!loaded?.reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (!loaded.data) return res.status(400).json({ error: "FnF has not been finalized yet." });
  const buffer = await renderFnfDocxBuffer(loaded.data, loaded.tpl?.bodyText || "");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${fnfDocxFileName(loaded.data, loaded.reqRow.id)}"`);
  res.send(buffer);
});

// Emails the SAME fixed-table PDF "Download FNF Document (PDF)" produces — Finance's "Send"
// action once the FnF statement looks right. Previously attached the separate Finance-editable
// .docx template instead, which could show different wording/figures than what Finance actually
// reviewed via Download — switched to attach the identical PDF so there's never a mismatch
// between what's downloaded and what the employee receives. Also THE trigger for the actual
// termination when called on a still-PENDING request (per explicit request: "once FnF is sent,
// Finance triggers actual termination and the record moves to Past/Terminated") — runs the exact
// same finalizeTermination() logic /approve uses, using whatever body Finance submits alongside
// Send, before generating/emailing the now-final document. Calling it on an already-APPROVED
// request (the old two-click flow, or a later re-send) just re-sends.
router.post("/:id/fnf-settlement/send", async (req, res) => {
  const existing = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Termination request not found" });
  if (existing.status === "PENDING") {
    const fin = await finalizeTermination(existing.id, req.body || {}, req.user!);
    if (!fin.ok) return res.status(fin.status).json({ error: fin.error });
  } else if (existing.status !== "APPROVED") {
    return res.status(400).json({ error: `Already ${existing.status.toLowerCase()}` });
  }
  const loaded = await loadFnfDocxInputs(Number(req.params.id));
  if (!loaded?.reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (!loaded.data) return res.status(400).json({ error: "FnF has not been finalized yet." });
  const to = req.body?.email || loaded.reqRow.employee?.email;
  if (!to) return res.status(400).json({ error: "No email address on file for this employee — pass one explicitly." });
  if (!mailEnabled()) return res.status(400).json({ error: "Email not configured (Microsoft Graph)." });
  const fileName = `FNF_${loaded.reqRow.employee?.empNo || loaded.reqRow.employeeId}.pdf`;
  const buffer = await renderToBuffer((out) => renderFnfPdf(loaded.data!, out));
  const fnfVals = { EmployeeName: loaded.data.employeeName, EmployeeFirstName: loaded.data.employeeName.split(/\s+/)[0], SignatoryName: loaded.data.signatoryName || "GenAquarius" };
  const { subject, html } = await renderFinanceEmail("FNF_SETTLEMENT_SEND", loaded.reqRow.employee?.businessUnitId, fnfVals,
    `Full & Final Settlement — ${fnfVals.EmployeeName}`,
    `Dear ${fnfVals.EmployeeFirstName},<br><br>Please find attached your Full &amp; Final Settlement statement.<br><br>Regards,<br>${fnfVals.SignatoryName}`);
  try {
    const r = await notifyMail("FNF_SETTLEMENT_SEND", { fromUpn: req.user!.email, to, subject, html, attachments: [{ name: fileName, contentBytes: buffer.toString("base64"), contentType: "application/pdf" }] });
    if (!r.sent) return res.status(400).json({ error: r.reason === "disabled" ? "This notification is turned off in Notification Settings." : (r.reason || "Send failed") });
  } catch (e: any) {
    return res.status(502).json({ error: e?.message || "Send failed" });
  }
  // Raw SQL, not prisma.terminationApprovalRequest.update() — the generated Prisma Client on this
  // specific running container has repeatedly been observed to reject fnfSentAt/fnfSentTo as
  // unknown arguments even when the deployed node_modules.tar.gz is independently verified
  // correct (byte-identical, and the same update succeeds against a fresh copy of that exact
  // file) — an Azure App Service-level stale local cache on this container that restarts/
  // redeploys haven't cleared. Raw SQL only needs the DB connection, not the generated client's
  // (possibly stale) type layer, so it works regardless.
  await prisma.$executeRawUnsafe(`UPDATE TerminationApprovalRequest SET fnfSentAt = ?, fnfSentTo = ? WHERE id = ?`, new Date(), to, existing.id);
  res.json({ ok: true, sentTo: to });
});

router.post("/:id/reject", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!reqRow) return res.status(404).json({ error: "Termination request not found" });
  if (reqRow.status !== "PENDING") return res.status(400).json({ error: `Already ${reqRow.status.toLowerCase()}` });
  const updated = await prisma.terminationApprovalRequest.update({ where: { id: reqRow.id }, data: { status: "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date(), reviewNote: req.body?.note || null } });
  res.json(updated);
});

// Deletes a Completed FnF's own APPROVAL RECORD only — for cleaning up a duplicate/erroneous
// request row (e.g. the employee was accidentally terminated/approved twice). Does NOT undo the
// actual termination already applied (Employee.exitDate, Monthly Forecast changes, IT offboarding
// queue) — those stay exactly as they are; this just removes the extra tracking row so it stops
// showing up (and confusing Regenerate/Send) alongside the real one. Only while Not Sent — once
// an FnF has actually been emailed to the employee, deleting its own record would be misleading
// (they already have the document), so it's locked exactly like Regenerate.
router.delete("/:id", async (req, res) => {
  const reqRow = await prisma.terminationApprovalRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!reqRow) return res.json({ ok: true });
  if (reqRow.status !== "APPROVED") return res.status(400).json({ error: "Only a completed (APPROVED) FnF request can be deleted here." });
  if (reqRow.fnfSentAt) return res.status(400).json({ error: "Already sent — cannot delete." });
  await prisma.terminationApprovalRequest.delete({ where: { id: reqRow.id } });
  res.json({ ok: true });
});

export default router;
