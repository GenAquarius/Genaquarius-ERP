// Expense Validation / Reconciliation — CTO's month-over-month view of every Expense/Overhead
// line in Monthly Forecast: current vs previous month, Added/Removed/Increased/Decreased/
// Unchanged, plus who last touched each one and when (sourced from the same audit trail the
// Finance/Executive Dashboard's "Recent Changes & Impact" panel reads). Read-only.
import React, { useState } from "react";
import { useFetch, Panel, useFiscalYears, useSelectedFy, useDisplayCurrency } from "../../ui";
import { fmtDateTime } from "../../dateFormat";

const MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const STATUS_PILL: Record<string, string> = { ADDED: "good", REMOVED: "bad", INCREASED: "warn", DECREASED: "", UNCHANGED: "" };

export default function ExpenseReconciliation() {
  const fyList = useFiscalYears();
  const [fy, setFy] = useSelectedFy();
  const [month, setMonth] = useState(MONTHS[new Date().getMonth() >= 3 ? new Date().getMonth() - 3 : new Date().getMonth() + 9]);
  const { money } = useDisplayCurrency();
  const { data, loading } = useFetch<any>(`/monthly/expense-reconciliation?fiscalYear=${fy}&month=${month}`, [fy, month]);
  const [statusFilter, setStatusFilter] = useState("ALL");

  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const visibleRows = statusFilter === "ALL" ? rows : rows.filter((r) => r.status === statusFilter);
  const s = data?.summary;

  const bar = (label: string, value: number, maxAbs: number) => (
    <div key={label}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
        <span>{label}</span><b style={{ color: value <= 0 ? "#34d399" : "#f87171" }}>{value >= 0 ? "+" : ""}{money(value)}</b>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
        <div style={{ width: `${maxAbs ? (Math.abs(value) / maxAbs) * 100 : 0}%`, height: "100%", background: value <= 0 ? "#34d399" : "#f87171" }} />
      </div>
    </div>
  );

  return (
    <div>
      <h1>Expense Validation / Reconciliation</h1>
      <div className="subtitle">Month-over-month comparison of every Expense/Overhead line in Monthly Forecast — what got added, removed, increased or decreased, and who last touched each one.</div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", margin: "14px 0" }}>
        <div><label style={{ display: "block", marginBottom: 4 }}>Fiscal Year</label>
          <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 130 }}>
            {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
          </select></div>
        <div><label style={{ display: "block", marginBottom: 4 }}>Month</label>
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 110 }}>
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select></div>
      </div>

      {loading || !data ? "Loading…" : <>
        <div className="subtitle" style={{ margin: "0 0 10px" }}>
          Comparing <b>{data.currentMonth.month} {data.currentMonth.fiscalYear}</b> against <b>{data.previousMonth.month} {data.previousMonth.fiscalYear}</b>.
        </div>

        <div className="grid kpi-row" style={{ marginBottom: 14 }}>
          <div className="kpi"><div className="label">Total Expense This Month</div><div className="value">{money(s?.totalCurrent || 0)}</div></div>
          <div className="kpi"><div className="label">Total Expense Previous Month</div><div className="value">{money(s?.totalPrevious || 0)}</div></div>
          <div className="kpi"><div className="label">Net Change</div><div className="value" style={{ color: (s?.totalDelta || 0) <= 0 ? "#34d399" : "#f87171" }}>{(s?.totalDelta || 0) >= 0 ? "+" : ""}{money(s?.totalDelta || 0)}</div></div>
          <div className="kpi"><div className="label">Added / Removed</div><div className="value">{s?.added || 0} / {s?.removed || 0}</div><div className="sub">Increased {s?.increased || 0} · Decreased {s?.decreased || 0} · Unchanged {s?.unchanged || 0}</div></div>
        </div>

        <Panel title="Biggest movers" style={{ marginBottom: 14 }}>
          {(() => {
            const top = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8);
            const maxAbs = Math.max(1, ...top.map((r) => Math.abs(r.delta)));
            return !top.length ? <div style={{ color: "var(--muted)" }}>No expense lines in either month.</div> :
              <div style={{ display: "grid", gap: 10 }}>{top.map((r) => bar(`${r.category} — ${r.description}`, r.delta, maxAbs))}</div>;
          })()}
        </Panel>

        <Panel title={`Every Expense Line (${visibleRows.length})`}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            {["ALL", "ADDED", "REMOVED", "INCREASED", "DECREASED", "UNCHANGED"].map((f) => (
              <button key={f} className={statusFilter === f ? "" : "ghost"} style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setStatusFilter(f)}>
                {f}{f !== "ALL" ? ` (${rows.filter((r) => r.status === f).length})` : ` (${rows.length})`}
              </button>
            ))}
          </div>
          <table>
            <thead><tr><th>Category</th><th>Description</th><th>Status</th><th className="num">This Month</th><th className="num">Previous Month</th><th className="num">Δ</th><th className="num">% Δ</th><th>Last Modified</th></tr></thead>
            <tbody>{!visibleRows.length ? <tr><td colSpan={8} style={{ color: "var(--muted)" }}>No expense lines match this filter.</td></tr> :
              visibleRows.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.category}</td><td>{r.description}</td>
                  <td><span className={`pill ${STATUS_PILL[r.status] || ""}`}>{r.status}</span></td>
                  <td className="num">{money(r.currentAmount)}</td>
                  <td className="num">{money(r.previousAmount)}</td>
                  <td className="num" style={{ color: r.delta <= 0 ? "#34d399" : "#f87171" }}>{r.delta >= 0 ? "+" : ""}{money(r.delta)}</td>
                  <td className="num">{r.previousAmount ? `${r.pctChange >= 0 ? "+" : ""}${r.pctChange.toFixed(1)}%` : "—"}</td>
                  <td style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {r.lastModifiedAt ? <>{fmtDateTime(r.lastModifiedAt)}<br />by {r.lastModifiedBy}</> : "No change history recorded"}
                  </td>
                </tr>
              ))}</tbody>
          </table>
        </Panel>
      </>}
    </div>
  );
}
