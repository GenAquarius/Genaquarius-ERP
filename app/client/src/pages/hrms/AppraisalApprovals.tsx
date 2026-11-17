// Finance's queue for the CTC change HR issued via the Appraisal flow (Appraisals.tsx). Approving
// performs "CTC & Employment History → Add CTC Record" for real — creating a new CtcRecord —
// pre-filled from the issued appraisal, matching the same read-only-preview + editable-dates
// pattern as Confirm Joining's own CTC approval (CtcApprovals.tsx).
import { useState } from "react";
import { api } from "../../api";
import { useFetch, Panel, Field, isMasked, useMaskNumbers } from "../../ui";
import { fmtDate } from "../../dateFormat";
import { useToast, GhostButton, AddButton } from "../../components";
import { useAuth } from "../../auth";

const CCY_SYM: Record<string, string> = { USD: "$", CAD: "C$", INR: "₹" };
const money = (n: number, ccy = "INR") => isMasked() ? "•••••" : (CCY_SYM[ccy] || "₹") + Math.round(n || 0).toLocaleString("en-IN");
function ReadOnlyField({ label, value }: { label: string; value: any }) {
  return <div><label>{label}</label><div style={{ fontWeight: 600 }}>{value}</div></div>;
}

export function AppraisalApprovals() {
  const { user } = useAuth();
  // Forces a re-render on mask toggle — money() above reads the shared mask flag directly
  // (isMasked()) but nothing else here subscribes to "masknumberschange".
  useMaskNumbers(user?.id);
  const { data: requests, reload } = useFetch<any[]>("/appraisal-approvals?status=ISSUED");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = requests || [];
  const selected = rows.find((r) => r.id === selectedId) || rows[0] || null;

  return (
    <div>
      <h1>Appraisal Approvals</h1>
      <div className="subtitle">Issued appraisal letters awaiting Finance/CTO/CEO sign-off on the revised CTC. Nothing changes on the employee's CTC & Employment History until Approved.</div>
      <div className="grid cols-2" style={{ alignItems: "start", marginTop: 12 }}>
        <Panel title={`Pending (${rows.length})`}>
          {rows.length === 0 && <div style={{ color: "var(--muted)" }}>Nothing pending — every issued appraisal has been reviewed.</div>}
          {rows.length > 0 && (
            <table><tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer", background: selected?.id === r.id ? "var(--panel2)" : undefined }} onClick={() => setSelectedId(r.id)}>
                  <td>{r.employee?.name}</td>
                  <td style={{ color: "var(--muted)" }}>{r.employee?.empNo}</td>
                  <td>{r.designation}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Panel>
        {selected ? (
          <AppraisalApprovalDetail key={selected.id} request={selected} busy={busy} setBusy={setBusy} onDone={() => { setSelectedId(null); reload(); }} />
        ) : (
          <Panel title="Review"><div style={{ color: "var(--muted)" }}>Select a pending appraisal on the left.</div></Panel>
        )}
      </div>
    </div>
  );
}

function AppraisalApprovalDetail({ request, busy, setBusy, onDone }: any) {
  const { show } = useToast();
  const [ctcEffectiveFrom, setCtcEffectiveFrom] = useState(request.effectiveDate.slice(0, 10));
  const [ctcEffectiveTill, setCtcEffectiveTill] = useState("");

  const isIndiaComponents = request.countryCode === "INDIA" && request.empType !== "CONTRACTOR";
  const isContractor = request.countryCode === "INDIA" && request.empType === "CONTRACTOR";
  const ccy = isIndiaComponents || isContractor ? "INR" : (request.countryCode === "US" ? "USD" : "CAD");
  const b = request.salaryBreakup;

  const approve = async () => {
    setBusy(true);
    try {
      const r: any = await api.post(`/appraisal-approvals/${request.id}/approve`, { ctcEffectiveFrom: ctcEffectiveFrom || undefined, ctcEffectiveTill: ctcEffectiveTill || undefined });
      show(`CTC Record added for ${request.employee?.name}${r.reflected ? ` — ${r.reflected} Monthly Forecast row(s) updated` : ""}`);
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const reject = async () => {
    const note = window.prompt(`Reject the appraisal for ${request.employee?.name}? Enter a reason (optional):`);
    if (note === null) return;
    setBusy(true);
    try { await api.post(`/appraisal-approvals/${request.id}/reject`, { note }); show("Appraisal rejected"); onDone(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <Panel title={`Review — ${request.employee?.name} (${request.employee?.empNo})`}>
      <div className="note">Proposed CTC Record (from the issued appraisal) — read-only; only the dates below can be changed here:</div>
      <div className="form-grid" style={{ marginTop: 6 }}>
        <ReadOnlyField label="Designation" value={request.designation} />
        <Field label="Effective From" required type="date" value={ctcEffectiveFrom} onChange={(e: any) => setCtcEffectiveFrom(e.target.value)} />
        <Field label="Effective Till (optional)" type="date" value={ctcEffectiveTill} onChange={(e: any) => setCtcEffectiveTill(e.target.value)} />
        {!isIndiaComponents && !isContractor && <ReadOnlyField label="Annual CTC" value={money(request.annualCostOverride, ccy)} />}
        {isContractor && <ReadOnlyField label="Monthly Cost" value={money(request.monthlyCompensation, ccy)} />}
        {isIndiaComponents && b && <>
          <ReadOnlyField label="Basic" value={money(b.components?.find((c: any) => c.name === "Basic Salary")?.monthly, ccy)} />
          <ReadOnlyField label="HRA" value={money(b.components?.find((c: any) => c.name === "HRA")?.monthly, ccy)} />
          <ReadOnlyField label="Special/Other Allowance" value={money(b.components?.find((c: any) => c.name === "Special / Other Allowance")?.monthly, ccy)} />
          <ReadOnlyField label="Total Monthly CTC" value={money(b.totalMonthly, ccy)} />
          <ReadOnlyField label="Total Annual CTC" value={money(b.totalAnnual, ccy)} />
        </>}
      </div>
      {request.secondEffectiveDate && (() => {
        const b2 = request.secondSalaryBreakup;
        return (
          <>
            <div className="note" style={{ marginTop: 14 }}>This is a staged raise — a SECOND CTC Record will also be created, effective from the date below:</div>
            <div className="form-grid" style={{ marginTop: 6 }}>
              <ReadOnlyField label="Second Step — Effective From" value={fmtDate(request.secondEffectiveDate)} />
              {!isIndiaComponents && !isContractor && <ReadOnlyField label="Second Step — Annual CTC" value={money(request.secondAnnualCostOverride, ccy)} />}
              {isContractor && <ReadOnlyField label="Second Step — Monthly Cost" value={money(request.secondMonthlyCompensation, ccy)} />}
              {isIndiaComponents && b2 && <ReadOnlyField label="Second Step — Total Annual CTC" value={money(b2.totalAnnual, ccy)} />}
            </div>
          </>
        );
      })()}
      <ForecastPreview requestId={request.id} ctcEffectiveFrom={ctcEffectiveFrom} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <GhostButton onClick={() => window.open(api.pdfUrl(`/appraisals/${request.id}/pdf`), "_blank")}>Preview Appraisal Letter (PDF)</GhostButton>
        <AddButton disabled={busy} onClick={approve}>Approve — Add CTC Record</AddButton>
        <GhostButton disabled={busy} onClick={reject}>Reject</GhostButton>
      </div>
    </Panel>
  );
}

// Live "what will Approve actually do to Monthly Forecast" preview — re-fetches whenever Effective
// From changes. Same purpose as CtcApprovals.tsx's own ForecastPreview (new-hire CTC), here showing
// the BEFORE/AFTER cost for an existing employee's already-planned months instead of new lines.
function ForecastPreview({ requestId, ctcEffectiveFrom }: { requestId: number; ctcEffectiveFrom: string }) {
  const { data, loading } = useFetch<{ months: { fiscalYear: string; monthIndex: number; month: string; currentCost: number; newCost: number; delta: number }[] }>(
    `/appraisal-approvals/${requestId}/forecast-preview?ctcEffectiveFrom=${ctcEffectiveFrom || ""}`, [ctcEffectiveFrom]
  );
  return (
    <div style={{ marginTop: 14 }}>
      <div className="note">Monthly Forecast impact — what Approve will actually change, month by month:</div>
      {loading && <div className="subtitle" style={{ margin: "6px 0" }}>Calculating…</div>}
      {data && !data.months?.length && <div className="subtitle" style={{ margin: "6px 0" }}>No planned months found for this employee yet.</div>}
      {data && !!data.months?.length && (
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Month</th><th className="num">Current Cost</th><th className="num">New Cost</th><th className="num">Change</th></tr></thead>
          <tbody>
            {data.months.map((m) => (
              <tr key={`${m.fiscalYear}-${m.monthIndex}`}>
                <td>{m.month} {m.fiscalYear}</td>
                <td className="num">{money(m.currentCost, "USD")}</td>
                <td className="num">{money(m.newCost, "USD")}</td>
                <td className="num" style={{ color: m.delta > 0 ? "var(--bad, #e5484d)" : m.delta < 0 ? "var(--good, #3ecf8e)" : undefined }}>
                  {m.delta > 0 ? "+" : ""}{money(m.delta, "USD")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
