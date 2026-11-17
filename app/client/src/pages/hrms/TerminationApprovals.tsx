// Finance's queue for the termination HR requested with just an exit date (Employee Master's
// "Request Termination" action). Approving here shows the exact same rich Terminate form Masters.tsx's
// own admin Terminate flow uses (day basis, FNF, cost/invoice overrides) and is what actually calls
// the real termination logic — nothing changes on the Employee/MonthlyLine records until then.
import { useState, useEffect } from "react";
import { api } from "../../api";
import { useFetch, fmt, Panel, Field, d2, useMaskNumbers } from "../../ui";
import { fmtDate } from "../../dateFormat";
import { useToast, GhostButton, AddButton, confirmDialog } from "../../components";
import { useAuth } from "../../auth";

// Shared shell for both queues below — a request list on the left, the same review/approve
// detail panel on the right. `filter` splits the single PENDING queue in two: this page only
// ever shows requests that still need its OWN step, so TerminationApprovalDetail's existing
// twoStep/deploymentEndApproved gating naturally puts the right button on the right page.
function TerminationQueue({ title, subtitle, emptyLabel, filter }: { title: string; subtitle: string; emptyLabel: string; filter: (r: any) => boolean }) {
  const { data: requests, reload } = useFetch<any[]>("/termination-approvals?status=PENDING");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = (requests || []).filter(filter);
  const selected = rows.find((r) => r.id === selectedId) || rows[0] || null;

  return (
    <div>
      <h1>{title}</h1>
      <div className="subtitle">{subtitle}</div>
      <div className="grid cols-2" style={{ alignItems: "start", marginTop: 12 }}>
        <Panel title={`Pending (${rows.length})`}>
          {rows.length === 0 && <div style={{ color: "var(--muted)" }}>{emptyLabel}</div>}
          {rows.length > 0 && (
            <table><tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer", background: selected?.id === r.id ? "var(--panel2)" : undefined }} onClick={() => setSelectedId(r.id)}>
                  <td>{r.employee?.name}</td>
                  <td style={{ color: "var(--muted)" }}>{r.employee?.empNo}</td>
                  <td>{fmtDate(r.exitDate)}</td>
                  <td style={{ color: "var(--muted)" }}>{r.fnfFinalizationDate ? `FNF by ${fmtDate(r.fnfFinalizationDate)}` : ""}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Panel>
        {selected ? (
          <TerminationApprovalDetail key={selected.id} request={selected} busy={busy} setBusy={setBusy}
            onDone={() => { setSelectedId(null); reload(); }} onDeploymentEndApproved={reload} />
        ) : (
          <Panel title="Review"><div style={{ color: "var(--muted)" }}>Select a pending request on the left.</div></Panel>
        )}
      </div>
    </div>
  );
}

// A request only belongs on the plain "Termination Approvals" queue while it genuinely still needs
// that first step — a Deployment End Date that hasn't been approved yet. Everything else (no
// Deployment End Date at all, i.e. single-step; or a two-step request whose Deployment End Date is
// already approved) is ready for FnF work and belongs on FNF Pending instead — see
// TerminationApprovalDetail's own showFnfStage, which this mirrors exactly so a request never shows
// FnF fields on this queue and never shows the plain Approve-Deployment-End action on FNF Pending.
const needsDeploymentEndApproval = (r: any) => !!r.deploymentEndDate && !r.deploymentEndApprovedAt;

export function TerminationApprovals() {
  return (
    <TerminationQueue
      title="Termination Approvals"
      subtitle="Terminations HR has requested — accept and move the employee from their project to Bench. No FnF here; that's worked out on FNF Pending once this is approved (or immediately, for a request with no Deployment End Date)."
      emptyLabel="Nothing pending — every requested termination has been reviewed."
      filter={needsDeploymentEndApproval}
    />
  );
}

// Everything ready for FnF work: a two-step request whose Deployment End Date is already approved
// (Monthly Forecast already reflects it, the employee is still active on Bench), or a single-step
// request with no Deployment End Date at all (nothing to approve first — straight to FnF).
// Two tabs: Pending (the queue above, unchanged) and Completed — every APPROVED/finalized FnF,
// so Finance can come back any time afterward to preview, send, or resend it, not just in the one
// moment right after Approve & Terminate.
export function FnfPendingApprovals() {
  const [tab, setTab] = useState<"pending" | "completed">("pending");
  return (
    <div>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", margin: "0 0 16px" }}>
        <div onClick={() => setTab("pending")} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === "pending" ? "var(--accent)" : "var(--muted)", borderBottom: tab === "pending" ? "2px solid var(--accent)" : "2px solid transparent" }}>Pending</div>
        <div onClick={() => setTab("completed")} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === "completed" ? "var(--accent)" : "var(--muted)", borderBottom: tab === "completed" ? "2px solid var(--accent)" : "2px solid transparent" }}>Completed</div>
      </div>
      {tab === "pending" ? (
        <TerminationQueue
          title="FnF"
          subtitle="Ready for FnF — calculate the settlement, preview/generate the FnF document, and Approve & Terminate here."
          emptyLabel="Nothing here — no request is waiting on FnF finalization."
          filter={(r) => !needsDeploymentEndApproval(r)}
        />
      ) : <FnfCompletedQueue />}
    </div>
  );
}

// Every finalized FnF, oldest-approval-first-hidden (most recent first) — Preview/Download, Send
// and Resend are always available here, reusing the exact same FnfCompletedPanel the just-approved
// flow shows, just reachable again later instead of only in that one moment.
function FnfCompletedQueue() {
  const { data: requests, reload } = useFetch<any[]>("/termination-approvals?status=APPROVED");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { show } = useToast();

  const rows = (requests || []).filter((r) => !q.trim() || `${r.employee?.name} ${r.employee?.empNo || ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const selected = rows.find((r) => r.id === selectedId) || rows[0] || null;

  // Only while Not Sent — deletes the approval RECORD only (duplicate/erroneous request cleanup),
  // never undoes the actual termination already applied. See the server route's own comment.
  const del = async (r: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await confirmDialog({ title: `Delete this FnF request for ${r.employee?.name}?`, message: "Removes this request record only (e.g. a duplicate) — does not undo the employee's termination or Monthly Forecast changes already applied.", danger: true, confirmLabel: "Delete" }))) return;
    try {
      await api.del(`/termination-approvals/${r.id}`);
      show("Deleted");
      if (selectedId === r.id) setSelectedId(null);
      reload();
    } catch (e: any) { show(e.message, "error"); }
  };

  const [fnfNote, setFnfNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  // Only re-seed the Remarks box when the SELECTED request actually changes — never stomp what
  // Finance is actively typing on an unrelated re-render.
  const [seededFor, setSeededFor] = useState<number | null>(null);
  if (selected && seededFor !== selected.id) { setSeededFor(selected.id); setFnfNote(selected.fnfNote || ""); }

  const saveFnfNote = async () => {
    setNoteBusy(true);
    try { await api.put(`/termination-approvals/${selected.id}/fnf-note`, { note: fnfNote }); show("Remarks saved."); }
    catch (e: any) { show(e.message, "error"); } finally { setNoteBusy(false); }
  };

  return (
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <Panel title={`Completed (${rows.length})`}>
        <input placeholder="🔍 Search by name or employee id…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
        {rows.length === 0 && <div style={{ color: "var(--muted)" }}>{q.trim() ? "No matching completed FnF." : "No completed FnF yet."}</div>}
        {rows.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Employee Id</th><th>Date</th><th>Status</th><th></th></tr></thead>
            <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer", background: selected?.id === r.id ? "var(--panel2)" : undefined }} onClick={() => setSelectedId(r.id)}>
                <td>{r.employee?.name}</td>
                <td style={{ color: "var(--muted)" }}>{r.employee?.empNo}</td>
                <td>{fmtDate(r.exitDate)}</td>
                <td><span className={`pill ${r.fnfSentAt ? "good" : "accent"}`}>{r.fnfSentAt ? "Sent" : "Not Sent"}</span></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {!r.fnfSentAt && <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={(e) => del(r, e)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Panel>
      {selected ? (
        <FnfCompletedPanel request={selected} completedId={selected.id} fnfNote={fnfNote} setFnfNote={setFnfNote} noteBusy={noteBusy} saveFnfNote={saveFnfNote} onDone={() => setSelectedId(null)} onSent={reload} />
      ) : (
        <Panel title="FNF Completed"><div style={{ color: "var(--muted)" }}>Select a completed FnF on the left.</div></Panel>
      )}
    </div>
  );
}

// Post-approval panel: the fixed PDF (unchanged) plus the Finance-editable .docx FnF Settlement
// statement (engine/fnfDocx.ts, template managed from Finance Settings → FnF Settlement) with its
// own download and "Send to Employee" — mirrors Offer's generate → attach → sendMail pattern.
function FnfCompletedPanel({ request, completedId, fnfNote, setFnfNote, noteBusy, saveFnfNote, onDone, onSent }: any) {
  const { show } = useToast();
  const [sending, setSending] = useState(false);
  // Seeded from the employee's email on file, but editable right here — whatever's in this box
  // wins when Send is clicked (e.g. the employee's GenAquarius account may already be deactivated
  // by the time FnF goes out, same convention as Relieving Letter's own Send).
  const [sendTo, setSendTo] = useState(request.employee?.email || "");
  const [seededFor, setSeededFor] = useState<number | null>(null);
  if (seededFor !== completedId) { setSeededFor(completedId); setSendTo(request.employee?.email || ""); }
  // Reflects the send immediately in THIS panel (e.g. hides Regenerate right away) without waiting
  // on the parent list's own refetch — onSent (when the caller has a list to refresh, e.g. the
  // Completed queue) additionally updates the Sent/Not Sent chip there.
  const [justSent, setJustSent] = useState(false);
  const send = async () => {
    if (!sendTo.trim()) return show("Enter a recipient email", "error");
    setSending(true);
    try {
      const r: any = await api.post(`/termination-approvals/${completedId}/fnf-settlement/send`, { email: sendTo.trim() });
      show(`FnF Settlement emailed to ${r.sentTo}`);
      setJustSent(true);
      onSent?.();
    } catch (e: any) { show(e.message, "error"); } finally { setSending(false); }
  };
  // Not-Sent only — opens the same kind of editable FnF form the original Approve stage used
  // (Notice Required/Served/Waiver, Basic, Full Pay, EL Days/Amount, Reimbursement, Days Worked
  // Salary, Other Flexi Benefits, TDS), pre-filled from what's currently stored, with the same
  // "Recalculate from current dates" button — for when something upstream (e.g. EL balance)
  // changed after Approve but before Send. Full-time only — a contractor's FnF is billing-based.
  const [regenOpen, setRegenOpen] = useState(false);
  const canRegenerate = !request.fnfSentAt && !justSent;
  // Same impact table the Approve-stage review shows, now for the ALREADY-APPLIED termination —
  // what this resource's cost actually became each month (Bench, removed, or prorated), not a
  // hypothetical. Uses the request's own stored exitDate/deploymentEndDate/noBenchMovement (never
  // editable here), falling back to exitDate when there's no separate Deployment End Date, same as
  // previewTermination's own fallback.
  const basisDate = (request.deploymentEndDate || request.exitDate).slice(0, 10);
  const [impactPreview, setImpactPreview] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    api.get(`/termination-approvals/${completedId}/deployment-end-preview?deploymentEndDate=${basisDate}&noBenchMovement=${!!request.noBenchMovement}`)
      .then((p: any) => { if (!cancelled) setImpactPreview(p); })
      .catch(() => { if (!cancelled) setImpactPreview(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedId]);
  return (
    <Panel title={`FNF Completed — ${request.employee?.name} (${request.employee?.empNo})`}>
      <div className="note" style={{ marginBottom: 10 }}>Termination finalized. Review/edit the remarks below, then download the FnF settlement document — it always regenerates from the current data, so you can edit and re-download as many times as needed.</div>
      <div className="full"><label>Email</label><input value={sendTo} onChange={(e: any) => setSendTo(e.target.value)} placeholder="Email to send the FnF Settlement to" style={{ width: "100%" }} /></div>
      <div className="full" style={{ marginTop: 10 }}><label>Remarks (shown on the FnF document)</label><textarea rows={4} style={{ width: "100%" }} value={fnfNote} onChange={(e: any) => setFnfNote(e.target.value)} /></div>
      <h3 style={{ margin: "16px 0 6px" }}>Monthly Forecast Impact — {request.employee?.name}</h3>
      {impactPreview?.found ? (
        <>
          <div className="note" style={{ marginBottom: 6 }}>What this termination changed each month ($) — Cost Before this change vs. Cost After, as applied.</div>
          <table>
            <thead><tr><th>Month</th><th className="num">Cost Before</th><th className="num">Cost After</th><th>Outcome</th></tr></thead>
            <tbody>
              <tr>
                <td>{impactPreview.monthLabel} {impactPreview.fiscalYear}</td>
                <td className="num">{fmt(impactPreview.fullMonthCost)}</td>
                <td className="num">{fmt(impactPreview.cost)}</td>
                <td>Prorated to {request.deploymentEndDate ? "Deployment End Date" : "Termination Date"}</td>
              </tr>
              {impactPreview.futureMonths?.map((m: any, i: number) => (
                <tr key={i}>
                  <td>{m.month} {m.fiscalYear}</td>
                  <td className="num">{fmt(m.lostCost)}</td>
                  <td className="num">{fmt(impactPreview.goesToBench ? m.benchCostUsd : 0)}</td>
                  <td>{impactPreview.goesToBench ? <span className="pill" title="Cost-only, no revenue">🪑 Moved to Bench</span> : <span className="pill" title="Project line removed, employee off this month entirely">✕ Removed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <div className="note" style={{ marginTop: 4 }}>No active project line was found for {request.employee?.name} in that month at the time of termination — nothing was prorated (e.g. already on Bench, or the month was already locked).</div>
      )}
      {regenOpen && <FnfRegenerateForm request={request} completedId={completedId} onDone={() => setRegenOpen(false)} />}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <GhostButton disabled={noteBusy} onClick={saveFnfNote}>Save Remarks</GhostButton>
        <AddButton onClick={() => window.open(api.pdfUrl(`/termination-approvals/${completedId}/fnf-document.pdf`), "_blank")}>Download FNF Document (PDF)</AddButton>
        <GhostButton onClick={() => window.open(api.pdfUrl(`/termination-approvals/${completedId}/fnf-settlement.docx`), "_blank")}>Download FnF Settlement (.docx)</GhostButton>
        {canRegenerate && !regenOpen && <GhostButton onClick={() => setRegenOpen(true)} title="Opens the same FnF inputs form used at Approve, pre-filled with the current figures">Regenerate FnF</GhostButton>}
        <GhostButton disabled={sending || !sendTo.trim()} onClick={send}>{sending ? "Sending…" : (request.fnfSentAt || justSent) ? `Resend to ${sendTo.trim() || "Employee"}` : `Send to ${sendTo.trim() || "Employee"}`}</GhostButton>
        {justSent && !request.fnfSentAt && <span className="pill good">Sent</span>}
        <GhostButton onClick={onDone}>Close</GhostButton>
      </div>
    </Panel>
  );
}

// Mirrors the original Approve-stage FnF inputs form (same fields/labels/"Recalculate" pattern)
// so regenerating an already-APPROVED-but-Not-Sent FnF feels like generating it again, not a
// single opaque button. Pre-filled from the request's current stored figures; Apply persists
// whatever's on screen (edited or recalculated) and re-runs the suggestion engine server-side.
function FnfRegenerateForm({ request, completedId, onDone }: any) {
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const isFullTime = request.employee?.empType === "FULL_TIME";
  const basicCurrency = request.basicCurrency || "INR";
  const [resignationDate, setResignationDate] = useState(request.resignationDate ? request.resignationDate.slice(0, 10) : "");
  const [fnfFinalizationDate, setFnfFinalizationDate] = useState(request.fnfFinalizationDate ? request.fnfFinalizationDate.slice(0, 10) : "");
  const [exitDate, setExitDate] = useState(request.exitDate.slice(0, 10));
  const [fnfAmount, setFnfAmount] = useState(request.finalFnfAmount || 0);
  const [monthCost, setMonthCost] = useState<number | "">(request.finalMonthCost ?? "");
  const [invoiceAmount, setInvoiceAmount] = useState<number | "">("");
  const [requiredNoticeDays, setRequiredNoticeDays] = useState(request.requiredNoticeDays || 0);
  const [servedNoticeDays, setServedNoticeDays] = useState(request.servedNoticeDays || 0);
  const [payFullNoticePeriod, setPayFullNoticePeriod] = useState(!!request.payFullNoticePeriod);
  const [basicSalary, setBasicSalary] = useState(request.basicSalary || 0);
  // BUG FIX: basicOnly used to always re-fetch fresh from the live CTC record on load, silently
  // discarding whatever HR had actually typed/submitted for it — every OTHER FnF figure here
  // already initializes from `request.X` (what's actually stored), basicOnly was the one
  // exception. Now stored on the request row too (see schema) — only fetch fresh when genuinely
  // absent (a legacy request saved before this fix).
  const [basicOnly, setBasicOnly] = useState(request.basicOnly ?? 0);
  const [loadedBasicOnly, setLoadedBasicOnly] = useState(request.basicOnly != null);
  if (isFullTime && !loadedBasicOnly) {
    setLoadedBasicOnly(true);
    api.get(`/employees/${request.employeeId}/termination-fnf-suggestion?requiredNoticeDays=${requiredNoticeDays}&servedNoticeDays=${servedNoticeDays}&payFullNoticePeriod=${payFullNoticePeriod}&basicSalary=${basicSalary}&exitDate=${request.exitDate.slice(0, 10)}`)
      .then((s: any) => { if (s.isFullTime) setBasicOnly(s.basicOnly || 0); }).catch(() => {});
  }
  const [elDays, setElDays] = useState(request.elEncashmentDays || 0);
  const [elAmount, setElAmount] = useState(request.elEncashmentAmount || 0);
  const elRatePerDay = (request.elEncashmentDays || 0) > 0 ? (request.elEncashmentAmount || 0) / request.elEncashmentDays : 0;
  const setElDaysAndRecalc = (days: number) => { setElDays(days); setElAmount(Math.round(days * elRatePerDay * 100) / 100); };
  const [noticePay, setNoticePay] = useState(request.noticePayAmount || 0);
  const [reimbursement, setReimbursement] = useState(request.reimbursementAmount || 0);
  const [daysWorkedSalary, setDaysWorkedSalary] = useState(request.daysWorkedSalary || 0);
  const [otherFlexiBenefits, setOtherFlexiBenefits] = useState(request.otherFlexiBenefitsAmount || 0);
  const [tds, setTds] = useState(request.tdsAmount || 0);
  // Contractor-only FnF document fields — same ones the original Approve stage has, pre-filled
  // from whatever's already saved on this request (see their own schema comments for what each
  // affects: engine/leave.ts buildFnfPdfData).
  const [includeGst, setIncludeGst] = useState(request.includeGst !== false);
  const [gstAmount, setGstAmount] = useState<number | null>(request.gstAmount ?? null);
  const [fnfPrintDate, setFnfPrintDate] = useState(request.fnfPrintDate ? request.fnfPrintDate.slice(0, 10) : request.exitDate.slice(0, 10));
  const [payableDaysOverride, setPayableDaysOverride] = useState<number | null>(request.payableDaysOverride ?? null);
  const [leavesCount, setLeavesCount] = useState<number | null>(request.leavesCount ?? null);
  const [arrearAmount, setArrearAmount] = useState<number | null>(request.arrearAmount ?? null);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const recalculate = async () => {
    setRecalcBusy(true);
    try {
      const qs = new URLSearchParams({ requiredNoticeDays: String(requiredNoticeDays), servedNoticeDays: String(servedNoticeDays), payFullNoticePeriod: String(payFullNoticePeriod), basicSalary: String(basicSalary), reimbursementAmount: String(reimbursement), exitDate: request.exitDate.slice(0, 10) }).toString();
      const s: any = await api.get(`/employees/${request.employeeId}/termination-fnf-suggestion?${qs}`);
      if (s.isFullTime) {
        setBasicOnly(s.basicOnly || 0); setElDays(s.elEncashmentDays); setElAmount(s.elEncashmentAmount);
        setNoticePay(s.noticePayAmount); setDaysWorkedSalary(s.daysWorkedSalary); setTds(s.tdsAmount);
      }
    } catch (e: any) { show(e.message, "error"); } finally { setRecalcBusy(false); }
  };
  // Apply & Regenerate below re-writes Monthly Forecast's termination-month cost (and re-runs the
  // future-months cascade) — same previewTermination engine the original Approve-stage review uses,
  // so Finance sees that impact again BEFORE re-applying it a second time here, not just at the
  // original Approve.
  const [fcPreview, setFcPreview] = useState<any>(null);
  useEffect(() => {
    if (!exitDate) { setFcPreview(null); return; }
    let cancelled = false;
    const pdoQs = payableDaysOverride != null ? `&payableDaysOverride=${payableDaysOverride}` : "";
    api.get(`/termination-approvals/${completedId}/deployment-end-preview?deploymentEndDate=${exitDate}&noBenchMovement=${!!request.noBenchMovement}${pdoQs}`)
      .then((p: any) => { if (!cancelled) setFcPreview(p); })
      .catch(() => { if (!cancelled) setFcPreview(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitDate, payableDaysOverride]);
  const apply = async () => {
    setBusy(true);
    try {
      const r: any = await api.post(`/termination-approvals/${completedId}/fnf-regenerate`, {
        resignationDate: resignationDate || null, fnfFinalizationDate: fnfFinalizationDate || null, exitDate,
        fnfAmount, monthCost: monthCost === "" ? undefined : monthCost, invoiceAmount: invoiceAmount === "" ? undefined : invoiceAmount,
        requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicSalary, basicOnly, reimbursementAmount: reimbursement,
        elEncashmentDays: elDays, elEncashmentAmount: elAmount, noticePayAmount: noticePay,
        daysWorkedSalary, otherFlexiBenefitsAmount: otherFlexiBenefits, tdsAmount: tds,
        includeGst, gstAmount: gstAmount ?? undefined, fnfPrintDate: fnfPrintDate || undefined,
        payableDaysOverride: payableDaysOverride ?? undefined, leavesCount: leavesCount ?? undefined, arrearAmount: arrearAmount ?? undefined,
      });
      show(`FnF regenerated — Termination Month Cost ${fmt(r.monthCost || 0)}. Download again to see the refreshed document.`);
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Shows exactly what's currently typed in this form, NOT saved yet — the real FnF document
  // endpoints always read from the database, so without this, Preview/Download would keep
  // showing the last-saved figures until Apply & Regenerate is clicked.
  const preview = () => {
    const qs = new URLSearchParams({
      exitDate, resignationDate, fnfFinalizationDate,
      finalFnfAmount: String(fnfAmount),
      ...(isFullTime ? {
        requiredNoticeDays: String(requiredNoticeDays), servedNoticeDays: String(servedNoticeDays), payFullNoticePeriod: String(payFullNoticePeriod),
        basicSalary: String(basicSalary), elEncashmentDays: String(elDays), elEncashmentAmount: String(elAmount),
        noticePayAmount: String(noticePay), reimbursementAmount: String(reimbursement), daysWorkedSalary: String(daysWorkedSalary),
        otherFlexiBenefitsAmount: String(otherFlexiBenefits), tdsAmount: String(tds),
      } : {
        includeGst: String(includeGst), ...(gstAmount != null ? { gstAmount: String(gstAmount) } : {}),
        ...(fnfPrintDate ? { fnfPrintDate } : {}), ...(payableDaysOverride != null ? { payableDaysOverride: String(payableDaysOverride) } : {}),
        ...(leavesCount != null ? { leavesCount: String(leavesCount) } : {}), ...(arrearAmount != null ? { arrearAmount: String(arrearAmount) } : {}),
      }),
    } as Record<string, string>).toString();
    window.open(`${api.pdfUrl(`/termination-approvals/${completedId}/fnf-preview.pdf`)}?${qs}`, "_blank");
  };
  return (
    <div style={{ marginTop: 14, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
      <div className="note" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        Regenerate FnF — same inputs as the original Approve stage, pre-filled with the current figures. Re-applies the Termination Month Cost to Monthly Forecast (overwrites, never adds on top).
        {isFullTime && <GhostButton disabled={recalcBusy} onClick={recalculate} title="Recompute EL/Notice Pay/Days Worked/TDS from the Termination Date, Notice days and Full Pay currently above">{recalcBusy ? "Recalculating…" : "↺ Recalculate from current dates"}</GhostButton>}
      </div>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label="Resignation Date" type="date" value={resignationDate} onChange={(e: any) => setResignationDate(e.target.value)} />
        <Field label="FNF Finalization Date" type="date" value={fnfFinalizationDate} onChange={(e: any) => setFnfFinalizationDate(e.target.value)} />
        <Field label="Termination Date" required type="date" value={exitDate} onChange={(e: any) => setExitDate(e.target.value)} />
        <div>
          <label>Deployment End Date</label>
          <div style={{ fontWeight: 600, padding: "8px 0" }}>{request.deploymentEndDate ? fmtDate(request.deploymentEndDate) : "—"} <span className="subtitle" style={{ fontWeight: 400 }}>(locked — already applied)</span></div>
        </div>
      </div>
      {!!request.deploymentEndDate && (
        <div className="note" style={{ marginTop: 4 }}>No Bench Movement: {request.noBenchMovement ? "Yes" : "No"} — locked from the original Approve, not editable here.</div>
      )}
      {isFullTime && <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label="Notice Period Required (days)" type="number" value={requiredNoticeDays} onChange={(e: any) => setRequiredNoticeDays(+e.target.value)} />
        <Field label="Notice Period Served (days)" type="number" value={servedNoticeDays} disabled={payFullNoticePeriod}
          title={payFullNoticePeriod ? "Not used while Notice Served Waiver is checked" : undefined}
          onChange={(e: any) => setServedNoticeDays(+e.target.value)} />
        <Field label={`Basic (${basicCurrency}) — used for Notice Pay only`} type="number" value={basicOnly} onChange={(e: any) => {
          const basic = +e.target.value; setBasicOnly(basic);
          const noticePayDays = payFullNoticePeriod ? requiredNoticeDays : servedNoticeDays;
          setNoticePay(Math.round((basic / 30) * noticePayDays * 100) / 100);
        }} />
        <Field label={`Full Pay (${basicCurrency}) — Basic + HRA + Special/Other Allowance`} type="number" value={basicSalary} onChange={(e: any) => setBasicSalary(+e.target.value)} />
        <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Waives the requirement that notice actually be served — pays the full required notice period instead of pay-for-days-served">
          <input type="checkbox" checked={payFullNoticePeriod} onChange={(e) => setPayFullNoticePeriod(e.target.checked)} />
          Notice Served Waiver — checked pays Basic/30 × Notice Period Required; unchecked pays Basic/30 × Notice Period Served. Click Recalculate to apply.
        </label>
      </div>}
      {isFullTime && <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label="EL Encashment Days" type="number" value={elDays} onChange={(e: any) => setElDaysAndRecalc(+e.target.value)} />
        <Field label={`EL Encashment Amount (${basicCurrency})`} type="number" value={elAmount} onChange={(e: any) => setElAmount(+e.target.value)} />
        <Field label={`Notice Pay (${basicCurrency})`} type="number" value={noticePay} onChange={(e: any) => setNoticePay(+e.target.value)} />
        <Field label={`Reimbursement (${basicCurrency})`} type="number" value={reimbursement} onChange={(e: any) => setReimbursement(+e.target.value)} />
        <Field label={`Salary for Days Worked This Month (${basicCurrency})`} type="number" value={daysWorkedSalary} onChange={(e: any) => setDaysWorkedSalary(+e.target.value)} />
        <Field label={`Other Flexi Benefits (${basicCurrency})`} type="number" value={otherFlexiBenefits} onChange={(e: any) => setOtherFlexiBenefits(+e.target.value)} />
        <Field label={`TDS (${basicCurrency}) — deducted on the FnF document only`} type="number" value={tds} onChange={(e: any) => setTds(+e.target.value)} />
      </div>}
      {!isFullTime && <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label="Number of Days Worked (overrides the days used in Termination Month Cost/the FnF document)" type="number" value={payableDaysOverride ?? ""} onChange={(e: any) => setPayableDaysOverride(e.target.value === "" ? null : +e.target.value)} />
        <Field label="Number of Leaves (printed on FnF document, if given)" type="number" value={leavesCount ?? ""} onChange={(e: any) => setLeavesCount(e.target.value === "" ? null : +e.target.value)} />
        <Field label="Arrear — Previous Month (INR, if owed)" type="number" value={arrearAmount ?? ""} onChange={(e: any) => setArrearAmount(e.target.value === "" ? null : +e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}><Field label="Last Day of Working (printed on FnF document)" type="date" value={fnfPrintDate} onChange={(e: any) => setFnfPrintDate(e.target.value)} /></div>
          <GhostButton onClick={() => setFnfPrintDate(request.deploymentEndDate ? request.deploymentEndDate.slice(0, 10) : exitDate)} title="Copies Deployment End Date into this field">↺ Use Deployment End Date</GhostButton>
        </div>
        <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Not every contractor is GST-registered — uncheck if this settlement shouldn't add GST on the FnF document">
          <input type="checkbox" checked={includeGst} onChange={(e) => setIncludeGst(e.target.checked)} />
          Include GST @ 18% on the FnF document
        </label>
        {includeGst && (
          <Field label="GST Amount ($) — blank = auto 18% of FNF Amount" type="number" value={gstAmount ?? ""} onChange={(e: any) => setGstAmount(e.target.value === "" ? null : +e.target.value)} />
        )}
      </div>}
      <div className="note" style={{ marginTop: 8 }}>
        {isFullTime
          ? "FNF Amount and Termination Month Cost (both USD) are re-applied to Monthly Forecast for the termination month when you Apply — this overwrites the line's cost to exactly this total, it does not add to whatever is there now."
          : "FNF Amount (USD) is re-recorded as this employee's FnF Settlement expense line for the FNF Finalization Date's month (updates the existing line, never duplicates it), and Termination Month Cost/Invoice Amount re-apply to Monthly Forecast the same way."}
      </div>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label="FNF Amount ($) — gross, flows into Monthly Forecast cost" type="number" value={fnfAmount} onChange={(e: any) => setFnfAmount(+e.target.value)} />
        <Field label="Termination Month Cost (override, $)" type="number" value={monthCost} onChange={(e: any) => setMonthCost(e.target.value === "" ? "" : +e.target.value)} />
        <Field label="Invoice Amount (override, $) — blank = prorated to the termination date" type="number" value={invoiceAmount} onChange={(e: any) => setInvoiceAmount(e.target.value === "" ? "" : +e.target.value)} />
      </div>
      {fcPreview?.found && (
        <div className="subtitle" style={{ margin: "10px 0", background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
          Impact on Monthly Forecast if you Apply &amp; Regenerate — {fcPreview.month}: Estimated Billing <b>{fmt(fcPreview.estimatedBilling)}</b> · Actual Invoice <b>{fmt(fcPreview.actualInvoice)}</b> · Cost <b>{fmt(fcPreview.cost)}</b>.
          {!!fcPreview.futureMonths?.length && (
            <div style={{ marginTop: 6 }}>
              Later months {fcPreview.goesToBench ? "stay on Bench (cost only, no revenue)" : "lose this line entirely"}: {fcPreview.futureMonths.map((m: any) => `${m.month} ${m.fiscalYear}`).join(", ")}.
            </div>
          )}
        </div>
      )}
      {fcPreview && !fcPreview.found && (
        <div className="note" style={{ marginTop: 4 }}>No active project line found for {request.employee?.name} in this Termination Date's month — Apply &amp; Regenerate won't change Monthly Forecast's cost (e.g. already on Bench with no billable line, or the month is locked).</div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <GhostButton onClick={preview} title="Shows exactly what's typed above — not saved yet">Preview (PDF)</GhostButton>
        <AddButton disabled={busy} onClick={apply}>Apply &amp; Regenerate</AddButton>
        <GhostButton disabled={busy} onClick={onDone}>Cancel</GhostButton>
      </div>
    </div>
  );
}

function TerminationApprovalDetail({ request, busy, setBusy, onDone, onDeploymentEndApproved }: any) {
  const { show } = useToast();
  const { user } = useAuth();
  // Forces a re-render on mask toggle — fmt() below reads the shared mask flag directly but
  // nothing else here subscribes to "masknumberschange", so without this every Rate/Billing/
  // Invoice/Cost/Bench-Cost figure on this page stayed frozen at whatever it showed when the panel
  // first mounted (stuck masked, or stuck unmasked) until the panel itself remounted.
  useMaskNumbers(user?.id);
  const isFullTime = request.employee?.empType === "FULL_TIME";
  // Whenever HR gave a Deployment End Date (either employment type), Finance approves it first —
  // adjusting Monthly Forecast immediately (full-time: Bench from that date on; contractor: no
  // further forecast at all) with no FnF and the employee still active — before the actual
  // termination once FnF is worked out. A request with no Deployment End Date stays single-step.
  const twoStep = !!request.deploymentEndDate;
  const deploymentEndApproved = !!request.deploymentEndApprovedAt;
  // FnF (Notice Pay/EL/Reimbursement/TDS/FNF Amount, and the resulting Termination Month Cost) only
  // belongs on the FNF Pending stage — a genuinely two-step request that hasn't had its Deployment
  // End Date approved yet (the plain "Termination Approvals" queue) has nothing to do with FnF at
  // all: the employee just moves to Bench and costs their REGULAR monthly amount every month until
  // the eventual termination/FnF month, exactly like Monthly Forecast already tracks anyone else on
  // Bench. Single-step requests (no Deployment End Date) go straight to the FnF stage since there's
  // no separate bench period to wait out.
  const showFnfStage = !twoStep || deploymentEndApproved;
  const [exitDate, setExitDate] = useState(request.exitDate.slice(0, 10));
  const [resignationDate, setResignationDate] = useState(request.resignationDate ? request.resignationDate.slice(0, 10) : "");
  const [fnfFinalizationDate, setFnfFinalizationDate] = useState(request.fnfFinalizationDate ? request.fnfFinalizationDate.slice(0, 10) : "");
  const [noBenchMovement, setNoBenchMovement] = useState(!!request.noBenchMovement);
  const [emailTerminated, setEmailTerminated] = useState(!!request.emailTerminated);
  // Can't disable the O365 account while the employee is still sitting on Bench (a two-step,
  // full-time request with Bench movement — i.e. not No Bench Movement) — matches the server's
  // own guard in terminationApprovals.ts's /approve.
  const stillOnBench = twoStep && isFullTime && !noBenchMovement;
  const [deploymentEndDate, setDeploymentEndDate] = useState((request.deploymentEndDate || request.exitDate).slice(0, 10));
  const [deploymentEndMonthCost, setDeploymentEndMonthCost] = useState<number | null>(null);
  // Contractor-only — overrides JUST the printed "Last Day of Working" on the FnF document (e.g.
  // deployment actually ended before the administrative Termination Date). Display-only: never
  // feeds into daysWorkedSalary/EL/notice-pay math (see engine/leave.ts buildFnfPdfData). Defaults
  // to whatever's already saved, else the Termination Date itself — today's unconditional default.
  const [fnfPrintDate, setFnfPrintDate] = useState((request.fnfPrintDate || request.exitDate).slice(0, 10));
  // Contractor-only — when set, both the Salary-for-Days-Worked dollar amount below AND the FnF
  // document's printed "No. of Days Worked" count use THIS number instead of the auto-derived
  // day count. "Last Day of Working" above is unaffected either way.
  const [payableDaysOverride, setPayableDaysOverride] = useState<number | null>(request.payableDaysOverride ?? null);
  // Contractor-only, purely informational — prints a "Leaves" row on the FnF document when set.
  const [leavesCount, setLeavesCount] = useState<number | null>(request.leavesCount ?? null);
  // Contractor-only — unpaid amount owed from a prior month, in INR. When set, the FnF document
  // splits Gross Payable Amount into an Arrear line + a This-Month line, and GST/TDS are computed
  // on the combined total instead of This Month alone.
  const [arrearAmount, setArrearAmount] = useState<number | null>(request.arrearAmount ?? null);
  // Impact on Monthly Forecast — estimated billing, actual invoice and cost prorated to the
  // Deployment End Date, plus the effect on every later month. Shown on BOTH Termination Approvals
  // (as a live preview before Finance commits to it) AND FNF Pending (as a reference of what that
  // step already did) — only the editable "Deployment End Month Cost" override is approval-gated,
  // since that action itself can only happen once. Refetches whenever the date changes.
  const [deploymentEndPreview, setDeploymentEndPreview] = useState<any>(null);
  // Single-step requests (no separate Deployment End Date) have no Bench period at all — the
  // Termination Date itself IS the pivot previewTermination should prorate against, same as
  // terminateEmployee's own fallback (masters.ts: `deploymentEndDate = opts.deploymentEndDate ||
  // exitDate`). Without this, Finance saw zero Monthly Forecast impact preview on the far more
  // common single-step flow — only two-step requests ever fetched one.
  const previewBasisDate = twoStep ? deploymentEndDate : exitDate;
  useEffect(() => {
    if (!previewBasisDate) { setDeploymentEndPreview(null); return; }
    let cancelled = false;
    const pdoQs = payableDaysOverride != null ? `&payableDaysOverride=${payableDaysOverride}` : "";
    api.get(`/termination-approvals/${request.id}/deployment-end-preview?deploymentEndDate=${previewBasisDate}&noBenchMovement=${noBenchMovement}${pdoQs}`)
      .then((p: any) => { if (!cancelled) setDeploymentEndPreview(p); })
      .catch(() => { if (!cancelled) setDeploymentEndPreview(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBasisDate, noBenchMovement, payableDaysOverride]);
  const [basis, setBasis] = useState("WORKING");
  const [monthlyCost, setMonthlyCost] = useState(0);
  // BUG FIX: this used to always start at a hard 0 regardless of what was already saved on the
  // request (e.g. HR's own "Salary for Days Worked This Month" override, persisted as
  // finalFnfAmount — see Hr.tsx) — the /cost fetch below only auto-populates a COMPUTED estimate
  // when request.finalFnfAmount is null, so a real saved value was silently discarded and shown
  // as 0 until Finance happened to overwrite it by hand. Every other FnF figure here already
  // initializes from `request.X`; this was the one exception.
  const [fnfAmount, setFnfAmount] = useState(request.finalFnfAmount || 0);
  // Contractor-only: whether the FnF document adds GST on top of the Gross Payable Amount (not
  // every contractor is GST-registered), and Finance's own override of the computed 18% figure —
  // null/empty means "use the auto 18% calc". No-ops for full-time.
  const [includeGst, setIncludeGst] = useState(request.includeGst !== false);
  const [gstAmount, setGstAmount] = useState<number | null>(request.gstAmount ?? null);
  const [monthCost, setMonthCost] = useState<number | null>(null);
  const [invoiceAmount, setInvoiceAmount] = useState<number | null>(null);
  const [loadedCost, setLoadedCost] = useState(false);
  // Full-time FnF components — prefilled from what HR submitted, editable here (Finance's own
  // override) before rolling up into the FNF Amount used by the settlement calc below.
  const [requiredNoticeDays, setRequiredNoticeDays] = useState(request.requiredNoticeDays || 0);
  const [servedNoticeDays, setServedNoticeDays] = useState(request.servedNoticeDays || 0);
  // Whatever HR chose on the request (or Finance's own override here) — "Notice Served Waiver":
  // pays the full required notice period regardless of days served, instead of the default
  // pay-for-days-served calc. See its own comment in engine/leave.ts's computeFnfSuggestion.
  const [payFullNoticePeriod, setPayFullNoticePeriod] = useState(!!request.payFullNoticePeriod);
  const [basicSalary, setBasicSalary] = useState(request.basicSalary || 0);
  // Plain Basic (from the CTC record) — what Notice Pay actually prices off; Full Pay above is
  // what Days-Worked-Salary prices off instead. The two are deliberately different figures. Now
  // persisted on the request row like every other FnF figure here (previously it was NOT, so
  // this always re-derived fresh from the live CTC record, discarding HR's actual submission) —
  // only fetch fresh when genuinely absent (a legacy request saved before this fix).
  const [basicOnly, setBasicOnly] = useState(request.basicOnly ?? 0);
  const [loadedBasicOnly, setLoadedBasicOnly] = useState(request.basicOnly != null);
  if (isFullTime && !loadedBasicOnly) {
    setLoadedBasicOnly(true);
    api.get(`/employees/${request.employeeId}/termination-fnf-suggestion?requiredNoticeDays=${requiredNoticeDays}&servedNoticeDays=${servedNoticeDays}&payFullNoticePeriod=${payFullNoticePeriod}&basicSalary=${basicSalary}&exitDate=${exitDate}`)
      .then((s: any) => { if (s.isFullTime) setBasicOnly(s.basicOnly || 0); }).catch(() => {});
  }
  const [elDays, setElDays] = useState(request.elEncashmentDays || 0);
  const [elAmount, setElAmount] = useState(request.elEncashmentAmount || 0);
  // Remembered from HR's submitted Days/Amount so editing EL Days by hand recomputes EL Amount
  // (Days × rate) instead of leaving it stale.
  const elRatePerDay = (request.elEncashmentDays || 0) > 0 ? (request.elEncashmentAmount || 0) / request.elEncashmentDays : 0;
  const setElDaysAndRecalc = (days: number) => { setElDays(days); setElAmount(Math.round(days * elRatePerDay * 100) / 100); };
  const [noticePay, setNoticePay] = useState(request.noticePayAmount || 0);
  const [reimbursement, setReimbursement] = useState(request.reimbursementAmount || 0);
  const [daysWorkedSalary, setDaysWorkedSalary] = useState(request.daysWorkedSalary || 0);
  const [otherFlexiBenefits, setOtherFlexiBenefits] = useState(request.otherFlexiBenefitsAmount || 0);
  // TDS is tax withheld and remitted to the tax authority — it changes how the settlement is PAID
  // OUT (partly to the employee, partly to tax), not whether it's a company COST. So it only
  // reduces the FnF Settlement document's own "Grand Total (Net Payable)" to the employee — it is
  // deliberately NOT subtracted from the FNF Amount below, which is gross earned and IS what flows
  // into Monthly Forecast's costUsd for the termination month.
  const [tds, setTds] = useState(request.tdsAmount || 0);
  const basicCurrency = request.basicCurrency || "INR";
  // EL/Notice Pay/Reimbursement are denominated in basicCurrency (INR for India) but Monthly
  // Forecast's costUsd — and this form's own FNF Amount field — are always USD. Converting once
  // here (via the same USD_INR fxRate /cost already returns) keeps the two in sync everywhere
  // they're combined below, instead of silently writing an INR figure in as if it were USD.
  const [fxRate, setFxRate] = useState(93);
  const toUsdAmt = (n: number) => basicCurrency === "INR" ? d2(n / fxRate) : d2(n);
  // Inverse of toUsdAmt — Monthly Cost/FNF Amount/Termination Month Cost/Invoice Amount are all
  // stored and sent to the server in USD (Monthly Forecast's own canonical currency), but Finance
  // reviews everything else on this page in INR — showing these four in USD only was inconsistent
  // and error-prone (a USD figure could be misread as INR). Displayed/edited in INR here; converted
  // back to USD via toUsdAmt-style division before it's ever sent anywhere. Billing rate fields
  // elsewhere in the app (e.g. Rate USD/hr) are deliberately NOT part of this — rates stay in USD.
  const inr = (usd: number) => basicCurrency === "INR" ? Math.round((usd || 0) * fxRate) : (usd || 0);
  const usdFromInr = (n: number) => basicCurrency === "INR" ? d2(n / fxRate) : d2(n);
  const ccySym = basicCurrency === "INR" ? "₹" : "$";
  // Gross earned (Basic-derived components) — the figure that becomes both the FNF Amount rolled
  // into Monthly Forecast AND the FnF Settlement's "Gross Total Income". TDS is applied separately,
  // only on the settlement document's own net-payable figure — see the `tds` state's own comment.
  const grossEarnedLocal = elAmount + noticePay + reimbursement + daysWorkedSalary + otherFlexiBenefits;

  if (!loadedCost) {
    setLoadedCost(true);
    api.get(`/employees/${request.employeeId}/cost`).then((c: any) => {
      // Once Deployment End Date is approved (FNF Pending), Finance's own step-one override is
      // already live in Monthly Forecast (e.g. a much lower Bench cost, or whatever custom
      // Deployment End Month Cost they typed in) — start from THAT real current figure, not a
      // generic annual-average guess that ignores everything step one already changed. Still
      // needs this same call for fxRate (INR-to-USD conversion below).
      const useCurrent = deploymentEndApproved && request.currentMonthCost != null;
      setMonthlyCost(useCurrent ? d2(request.currentMonthCost) : d2((c?.annualUsd || 0) / 12));
      const rate = c?.fxRate || fxRate;
      setFxRate(rate);
      if (isFullTime) setFnfAmount(basicCurrency === "INR" ? d2(grossEarnedLocal / rate) : d2(grossEarnedLocal));
      // Contractor: auto-populate FNF Amount from the same Salary-for-Days-Worked calc HR's own
      // form showed (respecting Number of Days Worked if HR set it) — previously started at a
      // hard 0 until Finance manually clicked "Use Termination Month Cost". Only on first load
      // (request.finalFnfAmount is null for a fresh request) — never overwrites a real saved
      // figure on an already-reviewed one.
      else if (request.finalFnfAmount == null) {
        const costBasisUsd = useCurrent ? d2(request.currentMonthCost) : d2((c?.annualUsd || 0) / 12);
        const bd = deploymentEndDate ? new Date(deploymentEndDate + "T00:00:00") : null;
        if (bd && !isNaN(+bd)) {
          const year = bd.getFullYear(), m0 = bd.getMonth(), termDay = bd.getDate();
          const daysInMonth = new Date(year, m0 + 1, 0).getDate();
          const jd = request.employee?.joiningDate ? new Date(request.employee.joiningDate.slice(0, 10) + "T00:00:00") : null;
          const sameMonthJoin = !!jd && !isNaN(+jd) && jd.getFullYear() === year && jd.getMonth() === m0;
          const startDay = sameMonthJoin ? jd!.getDate() : 1;
          const sameDay = sameMonthJoin && startDay === termDay;
          const worked = payableDaysOverride != null ? payableDaysOverride : (sameDay ? 0 : Math.max(1, termDay - startDay + 1));
          const perDayUsd = daysInMonth ? costBasisUsd / daysInMonth : 0;
          setFnfAmount(d2(perDayUsd * worked));
        }
      }
    }).catch(() => {});
  }

  // Billing date driving the day-basis proration below: for a contractor/vendor this is the
  // Deployment End Date HR specified (last billable day), matching terminateEmployee's own
  // billingEndDate logic — for a full-time employee it's just the termination date.
  const billingDate = isFullTime ? exitDate : deploymentEndDate;

  // Business decision (2026-10-12): a contractor's Termination Month Cost / Deployment End Month
  // Cost now equal FNF Amount + Arrear directly — the full settlement payout — instead of a
  // separate day-proration estimate with FNF Amount recorded as its OWN standalone expense line
  // elsewhere (the old recordContractorFnfExpense mechanism — removed server-side too, see
  // finalizeTermination/fnf-regenerate). Keeps Monthly Forecast's cost for the month matching what
  // actually gets paid out, instead of under-stating it and double-booking FNF Amount a second time
  // in whatever month the FNF Finalization Date happens to land in.
  const contractorSettlementUsd = !isFullTime ? usdFromInr(d2(inr(fnfAmount) + (arrearAmount || 0))) : 0;
  // Full-time: Termination Month Cost is just the FNF Amount — it already sums Salary for Days
  // Worked This Month alongside EL/Notice Pay/Reimbursement/Other Flexi Benefits (see
  // grossEarnedLocal above), so adding a SECOND, separately-computed CTC-based days-worked salary
  // on top of it here would double-count that component.
  const termCalc = () => ({ total: isFullTime ? (+fnfAmount || 0) : contractorSettlementUsd });
  const c = termCalc();
  const finalCost = monthCost != null ? monthCost : d2(c.total);
  // What "Cost After" in the Monthly Forecast Impact table below should actually show — the exact
  // number that will be WRITTEN to Monthly Forecast, not the raw server-computed estimate
  // (deploymentEndPreview.cost), which previously showed there unconditionally even after Finance
  // typed an override into "Deployment End Month Cost" or "Termination Month Cost" above. Step 1
  // (two-step, not yet approved): Deployment End Month Cost override, if set. Otherwise — single-
  // step, OR the FNF stage of a two-step request (even after Deployment End Date was already
  // approved) — Approve & Terminate is still about to WRITE finalCost to this same month (see
  // buildApproveBody/approve below), overwriting whatever step 1 set; showing the stale step-1
  // preview figure here instead of finalCost was the bug (reported: ₹1,000,500 expected, ₹155,807
  // — the old step-1 figure — shown).
  const costAfterApplied = (twoStep && !deploymentEndApproved)
    ? (deploymentEndMonthCost ?? (isFullTime ? deploymentEndPreview?.cost : contractorSettlementUsd))
    : finalCost;
  // Contractor per-day rate, per explicit business rule: Total CTC ÷ 12 ÷ actual calendar days in
  // the termination month (not the Day-basis working/calendar toggle above, which only drives the
  // generic Termination Month Cost proration) × days worked to the Deployment End Date. monthlyCost
  // is already Total CTC ÷ 12 for a contractor (see the /cost fetch above) unless Deployment End
  // Date is already approved, in which case it's the real current forecast cost — either way, the
  // right basis for this figure. Informational only, shown in INR via the existing inr() helper.
  const contractorDaysWorkedCalc = () => {
    const d = billingDate ? new Date(billingDate + "T00:00:00") : null;
    if (!d || isNaN(+d)) return { worked: 0, daysInMonth: 0, salary: 0 };
    const year = d.getFullYear(), m0 = d.getMonth(), termDay = d.getDate();
    const daysInMonth = new Date(year, m0 + 1, 0).getDate();
    const jd = request.employee?.joiningDate ? new Date(request.employee.joiningDate.slice(0, 10) + "T00:00:00") : null;
    const sameMonthJoin = !!jd && !isNaN(+jd) && jd.getFullYear() === year && jd.getMonth() === m0;
    const startDay = sameMonthJoin ? jd!.getDate() : 1;
    const sameDay = sameMonthJoin && startDay === termDay;
    // payableDaysOverride replaces the auto-derived day count entirely — the per-day rate (still
    // off the billing date's own calendar month) stays the same either way.
    const worked = payableDaysOverride != null ? payableDaysOverride : (sameDay ? 0 : Math.max(1, termDay - startDay + 1));
    const perDay = daysInMonth ? (+monthlyCost || 0) / daysInMonth : 0;
    return { worked, daysInMonth, salary: perDay * worked };
  };
  const cc = contractorDaysWorkedCalc();

  const approveDeploymentEnd = async () => {
    setBusy(true);
    try {
      // Always send the exact number Finance sees on screen for a contractor (contractorSettlementUsd
      // — FNF Amount + Arrear, same "Deployment End Month Cost" field default above) rather than
      // letting the server fall back to its own day-proration default whenever Finance never
      // touched the override field — same principle buildApproveBody below follows for finalCost.
      const r: any = await api.post(`/termination-approvals/${request.id}/approve-deployment-end`, {
        deploymentEndDate, monthCost: deploymentEndMonthCost ?? (isFullTime ? undefined : contractorSettlementUsd), noBenchMovement,
      });
      show(`Deployment End Date approved for ${request.employee?.name} — Monthly Forecast adjusted${r.adjustment?.removedLines ? ` · removed ${r.adjustment.removedLines} future line(s)` : ""}.`);
      onDeploymentEndApproved();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Always send the exact number Finance sees on screen (finalCost — whether that's their own
  // typed override or the computed default) rather than letting the server recompute it fresh from
  // monthCost:undefined — guarantees the approved figure IS the forecast figure, with zero risk of
  // client/server calculation drift (rounding, timing, etc.). Shared by both Approve & Terminate
  // and Generate FnF & Send below — same body either way, since sending now finalizes too.
  const buildApproveBody = () => {
    const body: any = { exitDate, resignationDate: resignationDate || undefined, fnfFinalizationDate: fnfFinalizationDate || undefined, basis, fnfAmount, monthCost: finalCost, invoiceAmount: invoiceAmount ?? undefined, emailTerminated: !stillOnBench && emailTerminated };
    if (isFullTime) Object.assign(body, {
      requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicSalary, basicOnly,
      elEncashmentDays: elDays, elEncashmentAmount: elAmount, noticePayAmount: noticePay, reimbursementAmount: reimbursement, daysWorkedSalary,
      otherFlexiBenefitsAmount: otherFlexiBenefits, tdsAmount: tds,
    });
    else Object.assign(body, {
      deploymentEndDate, includeGst, gstAmount: gstAmount ?? undefined,
      fnfPrintDate: fnfPrintDate || undefined, payableDaysOverride: payableDaysOverride ?? undefined, leavesCount: leavesCount ?? undefined,
      arrearAmount: arrearAmount ?? undefined,
    });
    return body;
  };
  // HR's originally-submitted EL/Notice Pay/Days-Worked-Salary suggestion is computed once, at
  // request time, off whatever Termination Date HR had picked THEN — it never recomputes here if
  // Finance changes the Termination Date (or Notice/Full Pay) while reviewing, so the numbers
  // could silently go stale relative to the actual dates being approved. Recalculates off the SAME
  // engine (computeFnfSuggestion) HR's own request form uses, using whatever is CURRENTLY in this
  // form — Finance can still hand-edit any field afterward; this only refreshes the starting point.
  const [recalcBusy, setRecalcBusy] = useState(false);
  const recalculate = async () => {
    setRecalcBusy(true);
    try {
      // basicOnly deliberately NOT sent here — always recompute Notice Pay off the live CTC
      // record's actual Basic, not whatever was last loaded into the field on screen. reimbursementAmount
      // IS sent — TDS is 9.9% of the FULL Gross Total Income, which includes whatever Finance has
      // currently typed into Reimbursement.
      const qs = new URLSearchParams({ requiredNoticeDays: String(requiredNoticeDays), servedNoticeDays: String(servedNoticeDays), payFullNoticePeriod: String(payFullNoticePeriod), basicSalary: String(basicSalary), reimbursementAmount: String(reimbursement), exitDate }).toString();
      const s: any = await api.get(`/employees/${request.employeeId}/termination-fnf-suggestion?${qs}`);
      if (!s.isFullTime) return;
      setBasicOnly(s.basicOnly || 0);
      setElDays(s.elEncashmentDays); setElAmount(s.elEncashmentAmount);
      setNoticePay(s.noticePayAmount); setDaysWorkedSalary(s.daysWorkedSalary);
      setOtherFlexiBenefits(s.otherFlexiBenefitsAmount); setTds(s.tdsAmount);
      show("Recalculated from the current Termination Date, Notice, Basic and Full Pay above.");
    } catch (e: any) { show(e.message, "error"); } finally { setRecalcBusy(false); }
  };
  const approve = async () => {
    setBusy(true);
    try {
      const r: any = await api.post(`/termination-approvals/${request.id}/approve`, buildApproveBody());
      show(`${request.employee?.name} terminated · month cost ${fmt(inr(r.termination?.monthCost || 0), basicCurrency)}${r.termination?.removedLines ? ` · removed ${r.termination.removedLines} future line(s)` : ""}`);
      setCompletedId(request.id);
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Live preview reflecting exactly what's currently on screen — works before Approve/Send too
  // (see GET /fnf-preview.pdf's query-param overrides), so Finance can check the settlement
  // document's look/numbers before committing to anything.
  const previewFnf = () => {
    const body = buildApproveBody();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) qs.set(k, String(v));
    qs.set("finalFnfAmount", String(fnfAmount)); // contractor-only line item; harmless no-op for full-time
    window.open(api.pdfUrl(`/termination-approvals/${request.id}/fnf-preview.pdf?${qs.toString()}`), "_blank");
  };
  // "Generate FnF" only opens the preview document and reveals the Send box below (editable
  // recipient email + note) — nothing is saved SERVER-SIDE and the request stays PENDING. But the
  // box's open/closed state and whatever's typed into Email/Note IS remembered in localStorage
  // (per request id) — without this, refreshing the page after Generate (or just closing the PDF
  // tab) silently reset the box to closed with no way back to the generated document short of
  // re-clicking Generate, which is what was being reported as "not remembering the stage." Wrapped
  // in try/catch since localStorage can throw (private browsing, blocked site data).
  const draftKey = `fnfSendDraft_${request.id}`;
  const loadDraft = (): { open: boolean; email: string; note: string } => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore — fall through to defaults */ }
    return { open: false, email: request.employee?.email || "", note: "" };
  };
  const [showSendBox, setShowSendBox] = useState(() => loadDraft().open);
  const [sendEmail, setSendEmail] = useState(() => loadDraft().email);
  const [sendNote, setSendNote] = useState(() => loadDraft().note);
  const saveDraft = (next: Partial<{ open: boolean; email: string; note: string }>) => {
    try { localStorage.setItem(draftKey, JSON.stringify({ open: showSendBox, email: sendEmail, note: sendNote, ...next })); } catch { /* ignore */ }
  };
  const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } };
  const generateFnf = () => { previewFnf(); setShowSendBox(true); saveDraft({ open: true }); };
  // Sending is ITSELF what triggers the actual termination (calls /fnf-settlement/send, which runs
  // the same finalize logic as Approve & Terminate when the request is still PENDING) and emails
  // the document in one step — to whatever's currently in the editable Send To field, which may
  // differ from the employee's email on file. Note is saved right after, since /fnf-note requires
  // the request to already be APPROVED (true by then, whether it was already approved or just got
  // finalized by this same send).
  const [sendingFnf, setSendingFnf] = useState(false);
  const sendFnfEmail = async () => {
    setSendingFnf(true);
    try {
      const r: any = await api.post(`/termination-approvals/${request.id}/fnf-settlement/send`, { ...buildApproveBody(), email: sendEmail });
      if (sendNote) await api.put(`/termination-approvals/${request.id}/fnf-note`, { note: sendNote }).catch(() => {});
      clearDraft();
      show(`${request.employee?.name} terminated and FnF Settlement emailed to ${r.sentTo}`);
      setCompletedId(request.id);
    } catch (e: any) { show(e.message, "error"); } finally { setSendingFnf(false); }
  };
  // After Approve & Terminate succeeds, stay on this panel (instead of jumping straight back to
  // the list) so Finance can review/edit the FnF settlement note and download the document right
  // away — same "reviewed → confirmed" pattern used elsewhere in this module (e.g. onboarding
  // document preview), rather than making them hunt for the record again afterward.
  const [completedId, setCompletedId] = useState<number | null>(null);
  const [fnfNote, setFnfNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const saveFnfNote = async () => {
    setNoteBusy(true);
    try { await api.put(`/termination-approvals/${completedId}/fnf-note`, { note: fnfNote }); show("Remarks saved."); }
    catch (e: any) { show(e.message, "error"); } finally { setNoteBusy(false); }
  };
  const reject = async () => {
    const note = window.prompt(`Reject the termination request for ${request.employee?.name}? Enter a reason (optional):`);
    if (note === null) return;
    setBusy(true);
    try { await api.post(`/termination-approvals/${request.id}/reject`, { note }); show("Termination request rejected"); onDone(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  if (completedId) {
    return <FnfCompletedPanel request={request} completedId={completedId} fnfNote={fnfNote} setFnfNote={setFnfNote} noteBusy={noteBusy} saveFnfNote={saveFnfNote} onDone={onDone} />;
  }

  return (
    <Panel title={`Review — ${request.employee?.name} (${request.employee?.empNo})`}>
      <div className="form-grid">
        <Field label="Resignation Date" type="date" value={resignationDate} onChange={(e: any) => setResignationDate(e.target.value)} />
        <Field label="FNF Finalization Date" required type="date" value={fnfFinalizationDate} onChange={(e: any) => setFnfFinalizationDate(e.target.value)} />
        <Field label="Termination Date" required type="date" value={exitDate} onChange={(e: any) => setExitDate(e.target.value)} />
        {twoStep && (
          <Field label="Deployment End Date" required type="date" value={deploymentEndDate} disabled={deploymentEndApproved}
            title={deploymentEndApproved ? "Locked — already approved and applied to Monthly Forecast" : undefined}
            onChange={(e: any) => setDeploymentEndDate(e.target.value)} />
        )}
        {twoStep && isFullTime && (
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={noBenchMovement} disabled={deploymentEndApproved} onChange={(e) => setNoBenchMovement(e.target.checked)} />
            No Bench Movement — remove from Monthly Forecast at the Deployment End Date instead of Bench{deploymentEndApproved ? " (locked — already applied)" : ""}
          </label>
        )}
        {request.emailTerminated ? (
          <div className="full note">✓ Email already marked as terminated by HR.</div>
        ) : (
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title={stillOnBench ? "Not available while the employee is still on Bench — only after No Bench Movement" : undefined}>
            <input type="checkbox" checked={emailTerminated} disabled={stillOnBench} onChange={(e) => setEmailTerminated(e.target.checked)} />
            Disable Email — mark the O365 account ready to be deactivated{stillOnBench ? " (not available while still on Bench)" : ""}
          </label>
        )}
        {/* Monthly Cost is informational only — it seeds the initial suggested Salary/FNF Amount
            estimate on first load (see the /cost fetch above), nothing more. Termination Month
            Cost/Deployment End Month Cost no longer derive from it — they equal FNF Amount + Arrear
            directly (see contractorSettlementUsd's own comment). */}
        {!isFullTime && (
          <Field label={`Monthly Cost (${basicCurrency === "INR" ? "₹" : "USD"}) — informational, seeds the initial suggested estimate only`} type="number" value={inr(monthlyCost)} onChange={(e: any) => setMonthlyCost(usdFromInr(+e.target.value))} />
        )}
      </div>
      {!showFnfStage && (
        <div className="note" style={{ marginTop: 8 }}>
          FnF is not yet actionable — approve the Deployment End Date below first. Once approved, {request.employee?.name} costs their regular monthly amount (project or Bench) every month until the eventual Termination Date; FnF is only finalized then, on this same request, once it moves to the FNF Pending queue. HR's submitted FnF figures are shown below for reference in the meantime.
        </div>
      )}
      {isFullTime && (
        <>
          <div className="note" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            HR's submitted FnF inputs — override any of these as needed.
            <GhostButton disabled={recalcBusy} onClick={recalculate} title="Recompute EL/Notice Pay/Days Worked/Other Flexi Benefits/TDS from the Termination Date, Notice days and Full Pay currently above">{recalcBusy ? "Recalculating…" : "↺ Recalculate from current dates"}</GhostButton>
          </div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label="Notice Period Required (days)" type="number" value={requiredNoticeDays} onChange={(e: any) => setRequiredNoticeDays(+e.target.value)} />
            <Field label="Notice Period Served (days)" type="number" value={servedNoticeDays} disabled={payFullNoticePeriod}
              title={payFullNoticePeriod ? "Not used while Notice Served Waiver is checked" : undefined}
              onChange={(e: any) => setServedNoticeDays(+e.target.value)} />
            <Field label={`Basic (${basicCurrency}) — used for Notice Pay only`} type="number" value={basicOnly} onChange={(e: any) => {
              const basic = +e.target.value; setBasicOnly(basic);
              // Basic drives Notice Pay only — Full Pay drives Days-Worked-Salary instead; the two
              // are deliberately different figures, see the checkbox label's own formula.
              const noticePayDays = payFullNoticePeriod ? requiredNoticeDays : servedNoticeDays;
              setNoticePay(Math.round((basic / 30) * noticePayDays * 100) / 100);
            }} />
            <Field label={`Full Pay (${basicCurrency}) — Basic + HRA + Special/Other Allowance`} type="number" value={basicSalary} onChange={(e: any) => setBasicSalary(+e.target.value)} />
            <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Waives the requirement that notice actually be served — pays the full required notice period instead of pay-for-days-served">
              <input type="checkbox" checked={payFullNoticePeriod} onChange={(e) => setPayFullNoticePeriod(e.target.checked)} />
              Notice Served Waiver — checked pays Basic/30 × Notice Period Required (ignores days served); unchecked pays Basic/30 × Notice Period Served. Click Recalculate below to apply.
            </label>
          </div>
          <div className="note" style={{ marginTop: 4 }}>
            Working: Notice Pay = Basic (₹{basicOnly.toLocaleString()}) ÷ 30 × {payFullNoticePeriod ? requiredNoticeDays : servedNoticeDays} day(s) [{payFullNoticePeriod ? "Notice Period Required — waiver checked" : "Notice Period Served"}] = ₹{noticePay.toLocaleString()}. Salary for Days Worked This Month = Full Pay (₹{basicSalary.toLocaleString()}) ÷ 30 = ₹{Math.round(basicSalary / 30).toLocaleString()}/day → ₹{daysWorkedSalary.toLocaleString()} total.
          </div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label="EL Encashment Days" type="number" value={elDays} onChange={(e: any) => setElDaysAndRecalc(+e.target.value)} />
            <Field label={`EL Encashment Amount (${basicCurrency})`} type="number" value={elAmount} onChange={(e: any) => setElAmount(+e.target.value)} />
            <Field label={`Notice Pay (${basicCurrency})`} type="number" value={noticePay} onChange={(e: any) => setNoticePay(+e.target.value)} />
            <Field label={`Reimbursement (${basicCurrency})`} type="number" value={reimbursement} onChange={(e: any) => setReimbursement(+e.target.value)} />
            <Field label={`Salary for Days Worked This Month (${basicCurrency})`} type="number" value={daysWorkedSalary} onChange={(e: any) => setDaysWorkedSalary(+e.target.value)} />
            <Field label={`Other Flexi Benefits (${basicCurrency})`} type="number" value={otherFlexiBenefits} onChange={(e: any) => setOtherFlexiBenefits(+e.target.value)} />
            <Field label={`TDS (${basicCurrency}) — deducted on the FnF document only, not from cost`} type="number" value={tds} onChange={(e: any) => setTds(+e.target.value)} />
          </div>
          {basicCurrency === "INR" && (
            <div className="note" style={{ marginTop: 4 }}>
              Gross Earned (EL + Notice Pay + Reimbursement + Days Worked + Other Flexi Benefits) = ₹{grossEarnedLocal.toLocaleString()} — this is what flows into Monthly Forecast's cost. Net Payable to the employee on the FnF document = Gross Earned − TDS (₹{tds.toLocaleString()}) = ₹{(grossEarnedLocal - tds).toLocaleString()}.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", margin: "10px 0" }}>
            <div style={{ flex: 1 }}><Field label={`FNF Amount (${ccySym}) — gross, flows into Monthly Forecast cost`} type="number" value={inr(fnfAmount)} onChange={(e: any) => setFnfAmount(usdFromInr(+e.target.value))} /></div>
            <GhostButton onClick={() => setFnfAmount(toUsdAmt(grossEarnedLocal))}>↺ Use Gross Earned</GhostButton>
          </div>
        </>
      )}
      {!isFullTime && (
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label="Salary for Days Worked This Month (INR)" type="number" value={inr(fnfAmount)}
            onChange={(e: any) => setFnfAmount(usdFromInr(+e.target.value))}
            title={`Total CTC ÷ 12 ÷ ${cc.daysInMonth} days in month × ${cc.worked} day(s) worked (Deployment End Date, or Number of Days Worked below if set) — editable: same underlying value as FNF Amount below, overriding either one updates both.`} />
          <Field label="Number of Days Worked (overrides the days used above)" type="number" value={payableDaysOverride ?? ""} onChange={(e: any) => setPayableDaysOverride(e.target.value === "" ? null : +e.target.value)} />
          <Field label="Number of Leaves (printed on FnF document, if given)" type="number" value={leavesCount ?? ""} onChange={(e: any) => setLeavesCount(e.target.value === "" ? null : +e.target.value)} />
          <Field label="Arrear — Previous Month (INR, if owed)" type="number" value={arrearAmount ?? ""} onChange={(e: any) => setArrearAmount(e.target.value === "" ? null : +e.target.value)}
            title="Splits Gross Payable Amount on the FnF document into an Arrear line + a This-Month line; GST/TDS are computed on the combined total." />
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Field label={`FNF Amount (${ccySym})`} type="number" value={inr(fnfAmount)} onChange={(e: any) => setFnfAmount(usdFromInr(+e.target.value))} /></div>
            <GhostButton onClick={() => setFnfAmount(finalCost)} title="Copy the Termination Month Cost above into FNF Amount — these are separate figures (Termination Month Cost is billing-based proration written to Monthly Forecast; FNF Amount is the settlement shown as Gross Payable Amount on the FnF document and recorded as its own expense), use this only if you mean them to be the same number">↺ Use Termination Month Cost</GhostButton>
          </div>
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }} title="Not every contractor is GST-registered — uncheck if this settlement shouldn't add GST on the FnF document">
            <input type="checkbox" checked={includeGst} onChange={(e) => setIncludeGst(e.target.checked)} />
            Include GST @ 18% on the FnF document
          </label>
          {includeGst && (
            <Field label={`GST Amount (${ccySym}) — blank = auto 18% of FNF Amount`} type="number"
              value={gstAmount != null ? inr(gstAmount) : ""} placeholder={String(Math.round(inr(fnfAmount) * 0.18))}
              onChange={(e: any) => setGstAmount(e.target.value === "" ? null : usdFromInr(+e.target.value))} />
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Field label="Last Day of Working (printed on FnF document)" type="date" value={fnfPrintDate} onChange={(e: any) => setFnfPrintDate(e.target.value)} /></div>
            <GhostButton onClick={() => setFnfPrintDate(deploymentEndDate)} title="Copies Deployment End Date into this field">↺ Use Deployment End Date</GhostButton>
          </div>
          <div className="note full" style={{ marginTop: -4 }}>
            "Last Day of Working" prints as-is above regardless. "Number of Days Worked" also changes the printed "No. of Days Worked" count (to match the Salary figure), but never any other calculation.
          </div>
        </div>
      )}
      <div className="subtitle" style={{ margin: "10px 0", background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
        {isFullTime
          ? <>Termination Month Cost = FNF Amount <b>{fmt(inr(c.total), basicCurrency)}</b> — FNF Amount already includes Salary for Days Worked This Month alongside EL/Notice Pay/Reimbursement/Other Flexi Benefits, so nothing further is added on top of it.</>
          : <>Termination Month Cost = FNF Amount <b>{fmt(inr(fnfAmount), basicCurrency)}</b>{!!arrearAmount && <> + Arrear <b>{fmt(arrearAmount, basicCurrency)}</b></>} = <b>{fmt(inr(c.total), basicCurrency)}</b> — the full settlement payout, recorded directly as {request.employee?.name}'s cost for this month in Monthly Forecast (no separate FnF expense line).</>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
        <div style={{ flex: 1 }}><Field label={`Termination Month Cost (override, ${ccySym})`} type="number" value={inr(finalCost)} onChange={(e: any) => setMonthCost(usdFromInr(+e.target.value))} /></div>
        <GhostButton onClick={() => setMonthCost(null)}>↺ Use computed</GhostButton>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
        <div style={{ flex: 1 }}><Field label={`Invoice Amount (override, ${ccySym})`} type="number" value={invoiceAmount == null ? "" : inr(invoiceAmount)} onChange={(e: any) => setInvoiceAmount(e.target.value === "" ? null : usdFromInr(+e.target.value))} placeholder="blank = prorated to the termination date" /></div>
        <GhostButton onClick={() => setInvoiceAmount(null)}>↺ Use prorated</GhostButton>
      </div>
      <div className="subtitle" style={{ margin: 0 }}>This <b>final amount</b> ({fmt(inr(finalCost), basicCurrency)}) becomes <b>{request.employee?.name}</b>'s cost for the termination month in Monthly Forecast &amp; Actuals. Rows from months <b>after</b> it are removed; locked months are untouched.</div>
      {twoStep && deploymentEndApproved && (
        <div className="note" style={{ marginTop: 8 }}>
          ✓ Deployment End Date approved{request.deploymentEndApprovedAt ? ` on ${fmtDate(request.deploymentEndApprovedAt)}` : ""}.
          {isFullTime
            ? " Monthly Forecast already reflects it — Approve & Terminate now just closes the employee record and tops up the FNF Amount above."
            : " Approve & Terminate will overwrite this month's cost in Monthly Forecast to the current Termination Month Cost above (FNF Amount + Arrear) — if that's changed since step 1, this replaces whatever was set then, it doesn't add on top."}
        </div>
      )}
      <h3 style={{ margin: "16px 0 6px" }}>Monthly Forecast Impact — {request.employee?.name}</h3>
      {deploymentEndPreview?.found ? (
        <>
          <div className="note" style={{ marginBottom: 6 }}>
            Every month this resource's cost changes because of this termination — what it would have cost had nothing changed ("Cost Before") vs. what Monthly Forecast will actually show ("Cost After") once approved, in {basicCurrency}. Locked (historical) months are never touched.
          </div>
          {!!deploymentEndPreview.lines?.length && (
            <div style={{ marginBottom: 6 }}>
              {deploymentEndPreview.lines.map((l: any, i: number) => (
                <div key={i} style={{ fontSize: 12, color: "var(--muted)" }}>{deploymentEndPreview.monthLabel} {deploymentEndPreview.fiscalYear} — {l.projectName}: cost {fmt(inr(l.costUsd), basicCurrency)} · billing {fmt(inr(l.billingAmount), basicCurrency)} · invoice {fmt(inr(l.invoiceAmount), basicCurrency)}</div>
              ))}
            </div>
          )}
          {/* Deployment End Month Cost override only actually applies via approveDeploymentEnd's
              own /approve-deployment-end call (the two-step flow's own step 1) — showing it for a
              single-step request would be dead UI, since nothing ever submits it; single-step
              already has its own "Termination Month Cost (override)" field above for the same
              purpose. */}
          {twoStep && !deploymentEndApproved && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
              <div style={{ flex: 1 }}><Field label={`Deployment End Month Cost (override, ${ccySym})`} type="number" value={inr(deploymentEndMonthCost ?? (isFullTime ? deploymentEndPreview.cost : contractorSettlementUsd))} onChange={(e: any) => setDeploymentEndMonthCost(usdFromInr(+e.target.value))} /></div>
              <GhostButton onClick={() => setDeploymentEndMonthCost(null)}>↺ Use computed</GhostButton>
            </div>
          )}
          {/* One table, every affected month — the termination month itself (prorated, not fully
              lost) PLUS every later month through the exit date (either moved to Bench, cost-only
              with zero revenue, or removed entirely) — so Finance sees the full before/after
              picture for this resource in one place, not scattered across separate summaries. */}
          <table>
            <thead><tr><th>Month</th><th className="num">Cost Before</th><th className="num">Cost After</th><th>Outcome</th></tr></thead>
            <tbody>
              <tr>
                <td>{deploymentEndPreview.monthLabel} {deploymentEndPreview.fiscalYear}</td>
                <td className="num">{fmt(inr(deploymentEndPreview.fullMonthCost), basicCurrency)}</td>
                <td className="num">{fmt(inr(costAfterApplied), basicCurrency)}</td>
                <td>Prorated to {twoStep ? "Deployment End Date" : "Termination Date"}</td>
              </tr>
              {deploymentEndPreview.futureMonths?.map((m: any, i: number) => (
                <tr key={i}>
                  <td>{m.month} {m.fiscalYear}</td>
                  <td className="num">{fmt(inr(m.lostCost), basicCurrency)}</td>
                  <td className="num">{fmt(inr(deploymentEndPreview.goesToBench ? m.benchCostUsd : 0), basicCurrency)}</td>
                  <td>{deploymentEndPreview.goesToBench ? <span className="pill" title="Cost-only, no revenue">🪑 Moved to Bench</span> : <span className="pill" title="Project line removed, employee off this month entirely">✕ Removed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!deploymentEndPreview.futureMonths?.length && (
            <div className="note" style={{ marginTop: 4 }}>
              {deploymentEndPreview.goesToBench
                ? "Moved to Bench — the project line ends, but the employee still costs money (no revenue) every month shown above until the Termination Date, when they're fully removed."
                : "Removed — these project line(s) and their billing/invoice disappear from Monthly Forecast entirely from that month on."}
            </div>
          )}
        </>
      ) : (
        <div className="note" style={{ marginTop: 4 }}>No active project line found for {request.employee?.name} in the {twoStep ? "Deployment End Date's" : "Termination Date's"} month — nothing to prorate{deploymentEndPreview && !deploymentEndPreview.found ? " (e.g. already on Bench with no billable project line, or the month is locked)" : ""}.</div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <GhostButton disabled={busy} title="Preview the FnF Settlement document with the numbers currently on screen — nothing is saved yet" onClick={previewFnf}>Preview FnF PDF</GhostButton>
        {!showFnfStage && (
          <AddButton disabled={busy} onClick={approveDeploymentEnd}>Approve Deployment End Date</AddButton>
        )}
        {showFnfStage && (
          <>
            {!showSendBox && (
              <AddButton disabled={busy} title="Opens the FnF Settlement document for review and reveals the Send box below — nothing is finalized or emailed yet" onClick={generateFnf}>Generate FnF</AddButton>
            )}
            <GhostButton disabled={busy || sendingFnf} onClick={approve} title="Finalizes the termination without emailing FnF — download/send it afterward">Approve &amp; Terminate (no email)</GhostButton>
          </>
        )}
        <GhostButton disabled={busy || sendingFnf} onClick={reject}>Reject</GhostButton>
      </div>
      {/* Status stays PENDING (still in this queue) right up until Send Email is actually clicked —
          Generate only opens the preview PDF and reveals this editable box, it never calls the
          server. Sending is what finalizes the termination AND emails the document, in one step. */}
      {showFnfStage && showSendBox && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
          <div className="note" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            FnF document generated — review it, edit the recipient/note below, then Send. Nothing is finalized or emailed until Send Email is clicked; this request stays in Pending until then (this box survives a page refresh).
            <GhostButton onClick={previewFnf}>View Generated FnF PDF</GhostButton>
          </div>
          <div><label>Send To (Email)</label><input value={sendEmail} onChange={(e: any) => { const v = e.target.value; setSendEmail(v); saveDraft({ email: v }); }} placeholder="Email to send the FnF Settlement to" style={{ width: "100%" }} /></div>
          <div style={{ marginTop: 8 }}><label>Note / Remarks (shown on the FnF document)</label><textarea rows={3} style={{ width: "100%" }} value={sendNote} onChange={(e: any) => { const v = e.target.value; setSendNote(v); saveDraft({ note: v }); }} /></div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <AddButton disabled={busy || sendingFnf || !sendEmail.trim()} onClick={sendFnfEmail}>{sendingFnf ? "Sending…" : "Send Email"}</AddButton>
            <GhostButton disabled={busy || sendingFnf} onClick={() => { setShowSendBox(false); clearDraft(); }}>Cancel</GhostButton>
          </div>
        </div>
      )}
    </Panel>
  );
}
