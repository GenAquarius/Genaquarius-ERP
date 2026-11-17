// Finance's queue for the CTC + Monthly Sheet line HR proposes at Confirm Joining (see
// ConfirmJoiningPanel in Hr.tsx). Nothing HR submitted there is live yet — no CtcRecord,
// no EmployeeProject, no MonthlyLine — until Approve is clicked here, which calls the exact
// same createMonthlyLine() engine Operations' own "Add Line to Monthly Sheet" uses.
import { useState, useEffect } from "react";
import { api } from "../../api";
import { useFetch, Panel, Field, SelectField, d2, isMasked, useMaskNumbers, Masked } from "../../ui";
import { useAuth } from "../../auth";
import { useToast, GhostButton, AddButton } from "../../components";

const CCY_SYM: Record<string, string> = { USD: "$", CAD: "C$", INR: "₹" };
const money = (n: number, ccy = "INR") => isMasked() ? "•••••" : (CCY_SYM[ccy] || "₹") + Math.round(n || 0).toLocaleString("en-IN");

function ctcMonthlyTotal(r: any) {
  if (r.annualCostOverride != null) return r.annualCostOverride / 12;
  return (r.basic || 0) + (r.hra || 0) + (r.otherAllowance || 0) + (r.specialAllowance || 0) + (r.conveyance || 0) + (r.communication || 0) + (r.meals || 0) + (r.books || 0) + (r.driver || 0) + (r.uniform || 0);
}

function ReadOnlyField({ label, value }: { label: string; value: any }) {
  return <div><label>{label}</label><div style={{ fontWeight: 600 }}>{value}</div></div>;
}

export function CtcApprovals() {
  const { user } = useAuth();
  // Forces a re-render on mask toggle — money() below reads the shared mask flag directly
  // (isMasked()) but nothing else here subscribes to "masknumberschange".
  useMaskNumbers(user?.id);
  const { data: requests, reload } = useFetch<any[]>("/ctc-approvals?status=PENDING");
  const { data: projects } = useFetch<any[]>("/hr/projects");
  const { show } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = requests || [];
  const selected = rows.find((r) => r.id === selectedId) || rows[0] || null;

  return (
    <div>
      <h1>Employee & CTC Approval</h1>
      <div className="subtitle">New hires HR has activated — review the proposed CTC and the Monthly Sheet line it will create, then Approve or Reject. Nothing here affects cost/revenue reporting until Approved.</div>
      <div className="grid cols-2" style={{ alignItems: "start", marginTop: 12 }}>
        <Panel title={`Pending (${rows.length})`}>
          {rows.length === 0 && <div style={{ color: "var(--muted)" }}>Nothing pending — every activated hire has been reviewed.</div>}
          {rows.length > 0 && (
            <table><tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer", background: selected?.id === r.id ? "var(--panel2)" : undefined }} onClick={() => setSelectedId(r.id)}>
                  <td>{r.employee?.name}</td>
                  <td style={{ color: "var(--muted)" }}>{r.employee?.empNo}</td>
                  <td>{r.empType === "CONTRACTOR" ? "Contractor" : "Employee"}</td>
                  <td className="num">{money(r.compensation?.annual ?? ctcMonthlyTotal(r) * 12, r.currency)}/yr<div style={{ fontSize: 11, color: "var(--muted)" }}>{money(ctcMonthlyTotal(r), r.currency)}/mo</div></td>
                  <td>{r.projectName}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Panel>
        {selected ? (
          <CtcApprovalDetail key={selected.id} request={selected} projects={projects || []} busy={busy} setBusy={setBusy}
            onDone={() => { setSelectedId(null); reload(); }} />
        ) : (
          <Panel title="Review"><div style={{ color: "var(--muted)" }}>Select a pending request on the left.</div></Panel>
        )}
      </div>
    </div>
  );
}

function CtcApprovalDetail({ request, projects, busy, setBusy, onDone }: any) {
  const { show } = useToast();
  // Rate is always stored in USD (rateUsd) — same convention Operations' own "Add Line to Monthly
  // Sheet" already uses. For a Canadian-currency project, Finance enters the real CAD rate they
  // were quoted (e.g. Yogita's C$48/hr) in a second field and this auto-converts it, instead of
  // Finance having to do that math by hand and risk entering a CAD figure straight into a
  // USD-labeled field (which used to be the only option here — see Operations.tsx for the
  // pre-existing pattern this mirrors).
  const { data: fxRates } = useFetch<any[]>("/fx-rates");
  const canadaFactor = (fxRates || []).find((r: any) => r.context === "CANADA_FACTOR")?.rate || 0.71;
  // CTC Effective From/Till — was read-only here (Finance could only view what HR submitted at
  // Confirm Joining), so a mismatched date (e.g. Effective Till landing before the deployment
  // window even starts, silently zeroing the forecast preview) could only be fixed by sending HR
  // back to correct it. Finance can now correct it directly before approving.
  const [ctcEffectiveFrom, setCtcEffectiveFrom] = useState(request.ctcEffectiveFrom?.slice(0, 10) || "");
  const [ctcEffectiveTill, setCtcEffectiveTill] = useState(request.ctcEffectiveTill?.slice(0, 10) || "");
  // HR sometimes assigns the real project via Employee Master's "Projects" action AFTER Confirm
  // Joining rather than picking it there — this request's own projectId then stays null (Bench)
  // even though the employee already has a real assignment. Prefer that real assignment as the
  // starting default (never the request's own recorded choice when one exists), so Finance doesn't
  // approve onto Bench — and get an all-zero forecast — just because HR assigned it a different way.
  const defaultProjectId = request.projectId || request.suggestedProjectId || "";
  const [projectId, setProjectId] = useState(defaultProjectId ? String(defaultProjectId) : "");
  const [deploymentStart, setDeploymentStart] = useState(request.deploymentStart?.slice(0, 10) || "");
  const [deploymentEnd, setDeploymentEnd] = useState(request.deploymentEnd?.slice(0, 10) || "");
  const [isBillable, setIsBillable] = useState(!!request.isBillable && !!defaultProjectId);
  const [rateUsd, setRateUsd] = useState(request.rateUsd != null ? String(request.rateUsd) : "");
  const isCadProject = (projects || []).find((p: any) => String(p.id) === String(projectId))?.currency === "CAD";
  // Bench isn't a client engagement — cannot be billable — so force (and lock) it off whenever
  // no real project is selected.
  useEffect(() => { if (!projectId) setIsBillable(false); }, [projectId]);

  const approve = async () => {
    if (projectId && (!deploymentStart || !deploymentEnd)) return show("Deployment Start and Deployment End are required when a Project is selected (only optional for Bench).", "error");
    // Rate stays optional data-entry for a non-billable/Bench line (see the field's own note
    // above), but once Billable is actually checked with a real project, a rate is what makes the
    // resulting Monthly Sheet line mean anything as billed revenue — silently approving a billable
    // line with no rate would create a $0-billing line with no obvious warning anywhere else.
    if (isBillable && (rateUsd === "" || Number(rateUsd) <= 0)) return show("Rate (USD/hr) is required when Billable is checked.", "error");
    setBusy(true);
    try {
      const r = await api.post(`/ctc-approvals/${request.id}/approve`, {
        ctcEffectiveFrom: ctcEffectiveFrom || undefined, ctcEffectiveTill: ctcEffectiveTill || null,
        projectId: projectId || undefined, deploymentStart: deploymentStart || undefined, deploymentEnd: deploymentEnd || undefined,
        isBillable, rateUsd: rateUsd !== "" ? Number(rateUsd) : undefined,
      });
      const costNote = r.monthlyLine ? ` — Monthly Sheet line added on ${r.monthlyLine.projectName} at ${isMasked() ? "•••••" : `$${Math.round(r.monthlyLine.costUsd).toLocaleString()}`}/mo cost` : (r.monthlyLineError ? ` (Monthly Sheet line not added: ${r.monthlyLineError})` : "");
      const gapNote = r.benchGapLine ? ` · Bench cost also added for the gap before Deployment Start` : (r.benchGapLineError ? ` (Bench gap line not added: ${r.benchGapLineError})` : "");
      show(`CTC approved for ${request.employee?.name}${costNote}${gapNote}`);
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const reject = async () => {
    const note = window.prompt(`Reject the CTC for ${request.employee?.name}? Enter a reason (optional):`);
    if (note === null) return;
    setBusy(true);
    try { await api.post(`/ctc-approvals/${request.id}/reject`, { note }); show("CTC rejected"); onDone(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <Panel title={`Review — ${request.employee?.name} (${request.employee?.empNo})`}>
      <div className="note">Proposed CTC (from HR's Confirm Joining) — Effective From/Till are editable; everything else is read-only:</div>
      <div className="form-grid" style={{ marginTop: 6 }}>
        <ReadOnlyField label="Employment Type" value={request.empType === "CONTRACTOR" ? "Contractor" : "Full-Time"} />
        <ReadOnlyField label="Location" value={request.location} />
        <Field label="Effective From" type="date" value={ctcEffectiveFrom} onChange={(e: any) => setCtcEffectiveFrom(e.target.value)} />
        <Field label="Effective Till" type="date" value={ctcEffectiveTill} onChange={(e: any) => setCtcEffectiveTill(e.target.value)} placeholder="blank = open-ended" />
        {request.annualCostOverride != null ? (
          <>
            {request.compensation?.type && request.location !== "INDIA" && (
              <ReadOnlyField label="Compensation Structure" value={`${{ HOURLY: "Hourly Rate", DAILY: "Daily Rate", MONTHLY: "Monthly Salary", ANNUAL: "Annual Salary / CTC" }[request.compensation.type as string] || request.compensation.type} — ${money(request.compensation.amount, request.currency)}${{ HOURLY: "/hr", DAILY: "/day", MONTHLY: "/mo", ANNUAL: "/yr" }[request.compensation.type as string] || ""}${request.compensation.type === "HOURLY" ? ` × ${request.compensation.hoursPerDay} h/day × ${request.compensation.workingDays} days` : request.compensation.type === "DAILY" ? ` × ${request.compensation.workingDays} days` : ""}`} />
            )}
            <ReadOnlyField label="Annualized CTC" value={money(request.annualCostOverride, request.currency)} />
          </>
        ) : request.empType === "CONTRACTOR" ? (
          <>
            {request.compensation?.type && <ReadOnlyField label="Compensation Structure" value={`${request.compensation.type === "ANNUAL" ? "Annual CTC" : request.compensation.type === "DAILY" ? "Daily Salary" : "Monthly Salary"} — ${money(request.compensation.amount, request.currency)}${request.compensation.type === "DAILY" ? "/day" : request.compensation.type === "MONTHLY" ? "/mo" : "/yr"}`} />}
            <ReadOnlyField label="Monthly Cost" value={money(request.basic, request.currency)} />
            <ReadOnlyField label="Annualized Salary / CTC" value={money((request.basic || 0) * 12, request.currency)} />
          </>
        ) : (
          <>
            <ReadOnlyField label="Basic" value={money(request.basic, request.currency)} />
            <ReadOnlyField label="HRA" value={money(request.hra, request.currency)} />
            <ReadOnlyField label="Other Allowance" value={money(request.otherAllowance, request.currency)} />
            <ReadOnlyField label="Special Allowance" value={money(request.specialAllowance, request.currency)} />
            <ReadOnlyField label="Conveyance / Fuel" value={money(request.conveyance, request.currency)} />
            <ReadOnlyField label="Communication" value={money(request.communication, request.currency)} />
            <ReadOnlyField label="Meals & Ent." value={money(request.meals, request.currency)} />
            <ReadOnlyField label="Books & Periodicals" value={money(request.books, request.currency)} />
            <ReadOnlyField label="Driver" value={money(request.driver, request.currency)} />
            <ReadOnlyField label="Uniform" value={money(request.uniform, request.currency)} />
            <ReadOnlyField label="Annual Bonus" value={money(request.bonusAnnual, request.currency)} />
          </>
        )}
      </div>
      <div className="note" style={{ marginTop: 14 }}>Add Line to Monthly Sheet — preselected from HR's activation; adjust if needed before approving:</div>
      {!request.projectId && request.suggestedProjectId && (
        <div className="subtitle" style={{ margin: "4px 0 0", color: "var(--warn, #a8650a)" }}>
          ⚠ HR didn't pick a project at Confirm Joining, but has since assigned <b>{request.suggestedProjectName}</b> to this employee in Employee Master — preselected below. Verify it's still correct before approving.
        </div>
      )}
      <div className="form-grid" style={{ marginTop: 6 }}>
        <SelectField label="Project" value={projectId} onChange={(e: any) => setProjectId(e.target.value)} options={[{ value: "", label: "Bench (default)" }, ...projects.map((p: any) => ({ value: p.id, label: p.name }))]} />
        <Field label={`Deployment Start${projectId ? " (required for a Project)" : " (blank = from month start)"}`} required={!!projectId} type="date" value={deploymentStart} onChange={(e: any) => setDeploymentStart(e.target.value)} />
        <Field label={`Deployment End${projectId ? " (required for a Project)" : " (blank = open-ended)"}`} required={!!projectId} type="date" value={deploymentEnd} onChange={(e: any) => setDeploymentEnd(e.target.value)} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 22, opacity: projectId ? 1 : 0.5 }} title={projectId ? undefined : "Bench is not a client engagement — cannot be billable"}>
          <input type="checkbox" checked={isBillable} disabled={!projectId} onChange={(e) => setIsBillable(e.target.checked)} /> Billable
        </label>
        {/* Rate stays visible/enterable regardless of Billable — Finance can record a reference
            rate for a Bench resource (e.g. their standby/expected rate for when they're deployed)
            without that by itself making the Bench line billable revenue. Billable is still what
            actually controls whether the Monthly Sheet line counts as billed revenue. */}
        {isCadProject && (
          <Field label={`Rate (CAD/hr)${isBillable ? " (required)" : ""}`} required={isBillable} type="number" value={rateUsd !== "" ? d2((+rateUsd || 0) / (canadaFactor || 0.71)) : ""}
            onChange={(e: any) => setRateUsd(e.target.value === "" ? "" : String(d2((+e.target.value || 0) * (canadaFactor || 0.71))))} />
        )}
        <Field label={isCadProject ? "Rate (USD/hr) — auto from CAD" : isBillable ? "Rate (USD/hr, required)" : "Rate (USD/hr, optional)"} required={isBillable} type="number" value={rateUsd} onChange={(e: any) => setRateUsd(e.target.value)} />
      </div>
      <ForecastPreview requestId={request.id} ctcEffectiveFrom={ctcEffectiveFrom} ctcEffectiveTill={ctcEffectiveTill} projectId={projectId} deploymentStart={deploymentStart} deploymentEnd={deploymentEnd} isBillable={isBillable} rateUsd={rateUsd} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <AddButton disabled={busy} onClick={approve}>Approve</AddButton>
        <GhostButton disabled={busy} onClick={reject}>Reject</GhostButton>
      </div>
    </Panel>
  );
}

// Live "what will Approve actually do to Monthly Forecast" preview — re-fetches on every relevant
// field change (the query string itself changes, which useFetch already refetches on), reusing the
// exact same cost/billing engine createMonthlyLine calls (see monthly.ts computeLineForMonth) so
// this can never show a number Approve wouldn't actually produce. Finance can catch a mistake
// (wrong project, deployment window not covering when they meant, a rate typo) here before it
// becomes a real MonthlyLine, instead of after Approve when fixing it means editing the Monthly
// Sheet by hand.
function ForecastPreview({ requestId, ctcEffectiveFrom, ctcEffectiveTill, projectId, deploymentStart, deploymentEnd, isBillable, rateUsd }: any) {
  const qs = new URLSearchParams({
    ctcEffectiveFrom: ctcEffectiveFrom || "", ctcEffectiveTill: ctcEffectiveTill || "",
    projectId: projectId || "", deploymentStart: deploymentStart || "", deploymentEnd: deploymentEnd || "",
    isBillable: String(!!isBillable), rateUsd: rateUsd === "" ? "" : String(rateUsd),
  }).toString();
  const { data, loading, error } = useFetch<any>(`/ctc-approvals/${requestId}/forecast-preview?${qs}`);
  const lockedMonths = (data?.months || []).filter((m: any) => m.locked);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="note">Monthly Forecast impact — what Approve will actually create, month by month:</div>
      {data?.compensation && <div className="subtitle" style={{ margin: "6px 0" }}>CTC basis: <b>{money(data.compensation.annual, data.compensation.currency)}</b>/yr annualized ({money(data.compensation.monthly, data.compensation.currency)}/mo) — the monthly cost below is this ÷ 12, prorated by days in the deployment window.</div>}
      {loading && <div className="subtitle" style={{ margin: "6px 0" }}>Calculating…</div>}
      {/* A locked ANCHOR month (Approve's own hard gate — createMonthlyLine refuses to create
          anything at all, not just skip that one month, when the very first month is locked)
          shows here as the request's own error, not a row in the table. */}
      {error && <div className="subtitle" style={{ margin: "6px 0", color: "var(--bad)" }}>⚠ {error}</div>}
      {data && !data.months?.length && <div className="subtitle" style={{ margin: "6px 0" }}>No months fall inside this deployment window yet — check the dates above.</div>}
      {!!lockedMonths.length && (
        <div className="subtitle" style={{ margin: "6px 0", color: "var(--bad)" }}>
          ⚠ {lockedMonths.map((m: any) => `${m.month} ${m.fiscalYear}`).join(", ")} {lockedMonths.length > 1 ? "are" : "is"} locked and falls inside this deployment window — Approve will only add the forecast to the unlocked months below. Unlock {lockedMonths.length > 1 ? "those months" : "that month"} first if you need it to take effect there too.
        </div>
      )}
      {data && !!data.months?.length && (
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Month</th><th>Project</th><th className="num">Cost</th>{data.isBillable && <><th className="num">Est. Hours</th><th className="num">Billing</th><th className="num">Invoice</th></>}</tr></thead>
          <tbody>
            {data.months.map((m: any) => { const isBench = m.isBenchGap || m.isBenchAfterEnd; return m.locked ? (
              <tr key={m.sheetId}>
                <td>{m.month} {m.fiscalYear}</td>
                <td colSpan={data.isBillable ? 5 : 2} style={{ color: "var(--bad)" }}>🔒 Locked — will not be updated</td>
              </tr>
            ) : (
              <tr key={`${m.sheetId}-${isBench ? "bench" : "proj"}`}>
                <td>{m.month} {m.fiscalYear}</td>
                <td>
                  {m.isBenchGap ? <span title="Before Deployment Start — not yet on this project">Bench (gap)</span>
                    : m.isBenchAfterEnd ? <span title="Past Deployment End — no project covers this month anymore" style={{ color: "var(--warn, #a8650a)" }}>Bench (after end)</span>
                    : data.projectName}
                </td>
                <td className="num">
                  <Masked>${Math.round(m.costUsd).toLocaleString()}</Masked>
                  {m.costDaysOf != null && <div style={{ fontSize: 11, color: "var(--muted)" }}>{m.costDays} of {m.costDaysOf} days</div>}
                </td>
                {data.isBillable && <>
                  <td className="num">{isBench ? "—" : d2(m.estimateHours)}</td>
                  <td className="num">{isBench ? "—" : <Masked>${Math.round(m.billingAmount).toLocaleString()}</Masked>}</td>
                  <td className="num">{isBench ? "—" : <Masked>${Math.round(m.invoiceAmount).toLocaleString()}</Masked>}</td>
                </>}
              </tr>
            ); })}
          </tbody>
        </table>
      )}
    </div>
  );
}
