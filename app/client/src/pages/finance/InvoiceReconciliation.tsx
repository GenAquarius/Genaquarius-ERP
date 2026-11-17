// Invoice Reconciliation — read-only, for a selected month: which billable Monthly Forecast
// resources have no invoice yet, which generated invoices haven't been sent, which have been sent,
// and where an invoiced amount drifted from the forecast's own Actual Invoice figure. Matching is
// exact — InvoiceAnnexure.lineId permanently links each invoiced row back to its originating
// Monthly Forecast line (see routes/finance/invoiceReconciliation.ts) — not a name/text heuristic.
//
// The PRIMARY, always-on comparison is Actual Invoice (Rate x Actual — what Monthly Forecast &
// Actuals itself labels "Actual Invoice") vs what's really on the generated invoice. The
// early-month Forecast/Estimate figure (Rate x Estimate) is a secondary, optional view — shown
// only behind "Show Forecast (Estimate)" below, off by default, per explicit instruction: this
// page is about what was actually billed vs what the forecast says was actually billed, not the
// original estimate.
//
// Every detail table gets a project-level rollup (count + amount per Client + Project) above it,
// and every KPI card scrolls straight down to its matching detail panel on click.
import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import { useFetch, Panel, useFiscalYears, useSelectedFy, useDisplayCurrency } from "../../ui";
import { fmtDate } from "../../dateFormat";

const MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

interface NotYetInvoiced { lineId: number; client: string; clientId: number | null; project: string; resourceName: string; actualInvoiceAmount: number; estimateAmount: number; }
interface NotSent { id: number; invoiceNo: string; client: string; clientId: number; project: string; amount: number; invoiceDate: string; }
interface Sent { id: number; invoiceNo: string; client: string; clientId: number; project: string; amount: number; invoiceDate: string; status: string; }
interface Mismatch { lineId: number; client: string; clientId: number | null; project: string; resourceName: string; actualInvoiceAmount: number; estimateAmount: number; invoicedAmount: number; invoicedCurrency: string; invoicedAmountUsd: number; difference: number; invoiceNo: string; invoiceId: number; }
interface ByProject { client: string; clientId: number | null; project: string; count: number; amount: number; }
interface ForecastBucket { count: number; amount: number; }
interface ReconData {
  notYetInvoiced: NotYetInvoiced[]; notSent: NotSent[]; sent: Sent[]; mismatches: Mismatch[];
  notYetInvoicedByProject: ByProject[]; notSentByProject: ByProject[]; sentByProject: ByProject[];
  totalForecastAmount: number;
  forecastBreakdown: { sent: ForecastBucket; notSent: ForecastBucket; mismatched: ForecastBucket; notYetInvoiced: ForecastBucket };
  kpis: {
    notYetInvoicedCount: number; notYetInvoicedAmount: number; notSentCount: number; notSentAmount: number;
    sentCount: number; sentAmount: number; mismatchCount: number; mismatchAmount: number;
    atRiskCount: number; atRiskAmount: number;
  };
}

const projectKey = (clientId: number | null, project: string) => `${clientId ?? ""}|${project}`;

function ByProjectTable({ rows, countLabel, money, activeKey, onPick }: { rows: ByProject[]; countLabel: string; money: (n: number) => string; activeKey?: string | null; onPick?: (r: ByProject) => void }) {
  if (!rows.length) return null;
  return (
    <table style={{ marginBottom: 14 }}>
      <thead><tr><th>S.N</th><th>Client</th><th>Project</th><th className="num">{countLabel}</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {rows.map((r, i) => {
          const k = projectKey(r.clientId, r.project);
          const active = activeKey === k;
          return (
            <tr key={k} style={active ? { background: "rgba(110,168,255,.14)" } : undefined}>
              <td style={{ color: "var(--muted)" }}>{i + 1}</td>
              <td>{r.client}</td>
              <td>{onPick ? <ProjectLink active={active} onClick={() => onPick(r)}>{r.project}</ProjectLink> : r.project}</td>
              <td className="num">{r.count}</td>
              <td className="num">{money(r.amount)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3} style={{ fontWeight: 600, textAlign: "right" }}>Total</td>
          <td className="num" style={{ fontWeight: 600 }}>{rows.reduce((s, r) => s + r.count, 0)}</td>
          <td className="num" style={{ fontWeight: 600 }}>{money(rows.reduce((s, r) => s + r.amount, 0))}</td>
        </tr>
      </tfoot>
    </table>
  );
}

// A clickable amount — takes you straight to where it lives, instead of leaving you to go hunt
// for it. Styled like a link so it reads as clickable at a glance.
function AmountLink({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <span onClick={onClick} title={title} style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "var(--muted)" }}>
      {children}
    </span>
  );
}

// Click a project to filter its own detail table down to just that project's rows; click again
// (or "Clear") to go back to everything. Active filter is bolded + underlined solid, not dotted,
// so it reads differently from a plain AmountLink.
function ProjectLink({ onClick, active, children }: { onClick: () => void; active: boolean; children: React.ReactNode }) {
  return (
    <span onClick={onClick} title={active ? "Showing only this project — click to clear" : "Show only this project's rows"} style={{ cursor: "pointer", fontWeight: active ? 700 : 400, textDecoration: "underline", textDecorationStyle: active ? "solid" : "dotted", textDecorationColor: active ? "var(--accent)" : "var(--muted)", color: active ? "var(--accent)" : undefined }}>
      {children}
    </span>
  );
}

// CAD amounts are shown in their own currency (never run through money(), which assumes USD) so
// Finance can tell at a glance this figure is CAD, not USD — per explicit request to make the CAD
// invoice value easy to spot and understand.
function CadBadge({ amount }: { amount: number }) {
  return <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: "#0a7ea4", border: "1px solid #0a7ea4", borderRadius: 4, padding: "1px 4px" }}>CAD {amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}

// A colored, clickable KPI card — scrolls to its detail panel on click, with a left accent bar and
// icon so the five metrics read at a glance instead of as identical gray boxes.
function KpiCard({ icon, color, label, value, sub, onClick, big }: { icon: string; color: string; label: string; value: React.ReactNode; sub: React.ReactNode; onClick: () => void; big?: boolean }) {
  return (
    <div
      className="kpi"
      onClick={onClick}
      title="Click to see the detail"
      style={{ cursor: "pointer", borderLeft: `4px solid ${color}`, background: big ? "rgba(255,255,255,.03)" : undefined }}
    >
      <div className="label">{icon} {label}</div>
      <div className="value" style={{ color: big ? color : undefined }}>{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

// A lightweight CSS-only stacked bar showing how the "at risk" dollar total splits across its
// three contributing categories — a visual read on where the gap mostly sits, no chart lib needed.
function CompositionBar({ segments }: { segments: { label: string; amount: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.amount, 0);
  if (total <= 0) return null;
  return (
    <div style={{ marginTop: 10, marginBottom: 4 }}>
      <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "rgba(255,255,255,.06)" }}>
        {segments.map((s) => (s.amount > 0 ? <div key={s.label} title={`${s.label}: ${Math.round((s.amount / total) * 100)}%`} style={{ width: `${(s.amount / total) * 100}%`, background: s.color }} /> : null))}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
        {segments.map((s) => (
          <span key={s.label} style={{ fontSize: 11.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: "inline-block" }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function InvoiceReconciliation() {
  const navigate = useNavigate();
  // FY + month persist across refreshes/navigation, same convention as Monthly Forecast's
  // ops.fy/ops.month — don't snap back to FY26-27/Apr every time this page is reopened.
  const [fy, setFy] = useSelectedFy();
  const [month, setMonth] = useState(() => localStorage.getItem("recon.month") || MONTHS[0]);
  const [showForecast, setShowForecast] = useState(false); // off by default — secondary/optional view
  useEffect(() => { localStorage.setItem("recon.month", month); }, [month]);
  const fyList = useFiscalYears();
  const { ccy, money } = useDisplayCurrency();
  const { data, loading } = useFetch<ReconData>(`/invoice-reconciliation?fiscalYear=${fy}&month=${month}`, [fy, month]);
  const goToForecastLine = (lineId: number) => navigate(`/monthly?fy=${fy}&month=${month}&focusLine=${lineId}`);
  const openInvoicePdf = (invoiceId: number) => window.open(api.pdfUrl(`/invoices/${invoiceId}/pdf`), "_blank");

  // Clicking a project (in a by-project rollup, or directly in a resource-detail row) filters that
  // table down to just that project; click the same one again to clear it. Each section gets its
  // own filter — picking a project in one doesn't affect the others.
  const [nyiFilter, setNyiFilter] = useState<string | null>(null);
  const toggleNyiFilter = (clientId: number | null, project: string) => {
    const k = projectKey(clientId, project);
    setNyiFilter((cur) => (cur === k ? null : k));
  };
  const [sentFilter, setSentFilter] = useState<string | null>(null);
  const toggleSentFilter = (clientId: number | null, project: string) => {
    const k = projectKey(clientId, project);
    setSentFilter((cur) => (cur === k ? null : k));
  };

  const panelRefs = {
    notYetInvoiced: useRef<HTMLDivElement>(null),
    notSent: useRef<HTMLDivElement>(null),
    sent: useRef<HTMLDivElement>(null),
    mismatches: useRef<HTMLDivElement>(null),
  };
  const scrollTo = (key: keyof typeof panelRefs) => panelRefs[key].current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const visibleNyi = (data?.notYetInvoiced || []).filter((r) => !nyiFilter || projectKey(r.clientId, r.project) === nyiFilter);
  const visibleSent = (data?.sent || []).filter((r) => !sentFilter || projectKey(r.clientId, r.project) === sentFilter);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <h1>Invoice Reconciliation</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 120 }} title="Fiscal Year">
            {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 130 }} title="Month">
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div className="subtitle">
        Cross-checks {fy} · {month} billable Monthly Forecast lines' <b>Actual Invoice</b> amount against what's really on the generated invoice — matched by the permanent invoice↔forecast link (amounts in {ccy}).
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12.5, cursor: "pointer" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={showForecast} onChange={(e) => setShowForecast(e.target.checked)} />
        Also show Forecast (Estimate) amount — the early-month Rate × Estimate projection, for reference only
      </label>

      {loading || !data ? <Panel>Loading…</Panel> : (
        <>
          <div className="grid kpi-row" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
            <KpiCard icon="🟡" color="#a8650a" label="Not Yet Invoiced" value={data.kpis.notYetInvoicedCount} sub={money(data.kpis.notYetInvoicedAmount)} onClick={() => scrollTo("notYetInvoiced")} />
            <KpiCard icon="🔵" color="#2f6fed" label="Generated, Not Sent" value={data.kpis.notSentCount} sub={money(data.kpis.notSentAmount)} onClick={() => scrollTo("notSent")} />
            <KpiCard icon="🟢" color="#1ea672" label="Sent" value={data.kpis.sentCount} sub={money(data.kpis.sentAmount)} onClick={() => scrollTo("sent")} />
            <KpiCard icon="🔴" color="#c0392b" label="Amount Mismatches" value={data.kpis.mismatchCount} sub={`${money(data.kpis.mismatchAmount)} gap`} onClick={() => scrollTo("mismatches")} />
            <KpiCard icon="⚠️" color="#e84393" big label="Needs Attention (Total)" value={data.kpis.atRiskCount} sub={`${money(data.kpis.atRiskAmount)} at risk`} onClick={() => scrollTo("notYetInvoiced")} />
          </div>
          <CompositionBar
            segments={[
              { label: "Not Yet Invoiced", amount: data.kpis.notYetInvoicedAmount, color: "#a8650a" },
              { label: "Generated, Not Sent", amount: data.kpis.notSentAmount, color: "#2f6fed" },
              { label: "Amount Mismatches (gap)", amount: data.kpis.mismatchAmount, color: "#c0392b" },
            ]}
          />

          <Panel style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div className="label" style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px" }}>Total Forecast Billing — {month}</div>
                <div style={{ fontSize: 24, fontWeight: 600 }}>{money(data.totalForecastAmount)}</div>
              </div>
              <div className="subtitle" style={{ margin: 0, maxWidth: 520, textAlign: "right" }}>
                Same figure as Monthly Forecast's <b>Invoice (actual)</b> tile and Finance Dashboard's <b>Revenue (Total Billing)</b> for {month} — every billable line's forecast amount, split below by what's actually happened to it.
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <span className="pill" style={{ cursor: "pointer" }} onClick={() => scrollTo("sent")}>🟢 Sent: {money(data.forecastBreakdown.sent.amount)} ({data.forecastBreakdown.sent.count})</span>
              <span className="pill" style={{ cursor: "pointer" }} onClick={() => scrollTo("notSent")}>🔵 Generated, Not Sent: {money(data.forecastBreakdown.notSent.amount)} ({data.forecastBreakdown.notSent.count})</span>
              <span className="pill" style={{ cursor: "pointer" }} onClick={() => scrollTo("mismatches")}>🔴 Mismatched: {money(data.forecastBreakdown.mismatched.amount)} ({data.forecastBreakdown.mismatched.count})</span>
              <span className="pill" style={{ cursor: "pointer" }} onClick={() => scrollTo("notYetInvoiced")}>🟡 Not Yet Invoiced: {money(data.forecastBreakdown.notYetInvoiced.amount)} ({data.forecastBreakdown.notYetInvoiced.count})</span>
            </div>
          </Panel>

          <Panel title={`Billable Resources With No Invoice Yet (${data.notYetInvoiced.length})`} style={{ marginTop: 14 }}>
            <div ref={panelRefs.notYetInvoiced} />
            {data.notYetInvoiced.length === 0 ? <div className="subtitle">Every billable resource this month has a matching invoice.</div> : (
              <>
                <div className="subtitle" style={{ marginTop: 0 }}>By project ({data.notYetInvoicedByProject.length}) — click a project to see its resource detail</div>
                <ByProjectTable rows={data.notYetInvoicedByProject} countLabel="Resources" money={money} activeKey={nyiFilter} onPick={(r) => toggleNyiFilter(r.clientId, r.project)} />
                {!nyiFilter ? (
                  <div className="subtitle">Click a project above to see its resource detail.</div>
                ) : (
                  <>
                    <div className="subtitle" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      Resource detail
                      <span className="pill" style={{ cursor: "pointer" }} onClick={() => setNyiFilter(null)}>Filtered to 1 project — Clear ✕</span>
                    </div>
                    <table>
                      <thead><tr><th>S.N</th><th>Client</th><th>Project</th><th>Resource</th><th className="num">Actual Invoice (Forecast)</th>{showForecast && <th className="num">Estimated (Forecast)</th>}</tr></thead>
                      <tbody>
                        {visibleNyi.map((r, i) => (
                          <tr key={r.lineId}>
                            <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                            <td>{r.client}</td>
                            <td><ProjectLink active={nyiFilter === projectKey(r.clientId, r.project)} onClick={() => toggleNyiFilter(r.clientId, r.project)}>{r.project}</ProjectLink></td>
                            <td>{r.resourceName}</td>
                            <td className="num"><AmountLink onClick={() => goToForecastLine(r.lineId)} title="Open this line in Monthly Forecast">{money(r.actualInvoiceAmount)}</AmountLink></td>
                            {showForecast && <td className="num" style={{ color: "var(--muted)" }}>{money(r.estimateAmount)}</td>}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={4} style={{ fontWeight: 600, textAlign: "right" }}>Total ({visibleNyi.length})</td>
                          <td className="num" style={{ fontWeight: 600 }}>{money(visibleNyi.reduce((s, r) => s + (r.actualInvoiceAmount || 0), 0))}</td>
                          {showForecast && <td className="num" style={{ fontWeight: 600, color: "var(--muted)" }}>{money(visibleNyi.reduce((s, r) => s + (r.estimateAmount || 0), 0))}</td>}
                        </tr>
                      </tfoot>
                    </table>
                  </>
                )}
              </>
            )}
          </Panel>

          <Panel title={`Generated But Not Sent (${data.notSent.length})`} style={{ marginTop: 14 }}>
            <div ref={panelRefs.notSent} />
            {data.notSent.length === 0 ? <div className="subtitle">Nothing is sitting in Draft for this month.</div> : (
              <>
                <div className="subtitle" style={{ marginTop: 0 }}>By project ({data.notSentByProject.length})</div>
                <ByProjectTable rows={data.notSentByProject} countLabel="Invoices" money={money} />
                <div className="subtitle">Invoice detail</div>
                <table>
                  <thead><tr><th>S.N</th><th>Invoice #</th><th>Client</th><th>Project</th><th>Invoice Date</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {data.notSent.map((inv, i) => (
                      <tr key={inv.id}>
                        <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                        <td>{inv.invoiceNo}</td>
                        <td>{inv.client}</td>
                        <td>{inv.project}</td>
                        <td>{fmtDate(inv.invoiceDate)}</td>
                        <td className="num"><AmountLink onClick={() => openInvoicePdf(inv.id)} title="Open this invoice">{money(inv.amount)}</AmountLink></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Panel>

          <Panel title={`Sent This Month (${data.sent.length})`} style={{ marginTop: 14 }}>
            <div ref={panelRefs.sent} />
            {data.sent.length === 0 ? <div className="subtitle">Nothing has been sent for this month yet.</div> : (
              <>
                <div className="subtitle" style={{ marginTop: 0 }}>By project ({data.sentByProject.length}) — click a client/project to see its Invoice # detail</div>
                <ByProjectTable rows={data.sentByProject} countLabel="Invoices" money={money} activeKey={sentFilter} onPick={(r) => toggleSentFilter(r.clientId, r.project)} />
                {!sentFilter ? (
                  <div className="subtitle">Click a client/project above to see its Invoice # detail.</div>
                ) : (
                  <>
                    <div className="subtitle" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      Invoice detail
                      <span className="pill" style={{ cursor: "pointer" }} onClick={() => setSentFilter(null)}>Filtered to 1 project — Clear ✕</span>
                    </div>
                    <table>
                      <thead><tr><th>S.N</th><th>Invoice #</th><th>Client</th><th>Project</th><th>Invoice Date</th><th>Status</th><th className="num">Amount</th></tr></thead>
                      <tbody>
                        {visibleSent.map((inv, i) => (
                          <tr key={inv.id}>
                            <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                            <td>{inv.invoiceNo}</td>
                            <td>{inv.client}</td>
                            <td><ProjectLink active={sentFilter === projectKey(inv.clientId, inv.project)} onClick={() => toggleSentFilter(inv.clientId, inv.project)}>{inv.project}</ProjectLink></td>
                            <td>{fmtDate(inv.invoiceDate)}</td>
                            <td><span className="pill" style={{ color: "#1ea672" }}>{inv.status}</span></td>
                            <td className="num"><AmountLink onClick={() => openInvoicePdf(inv.id)} title="Open this invoice">{money(inv.amount)}</AmountLink></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={6} style={{ fontWeight: 600, textAlign: "right" }}>Total ({visibleSent.length})</td>
                          <td className="num" style={{ fontWeight: 600 }}>{money(visibleSent.reduce((s, inv) => s + (inv.amount || 0), 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </>
                )}
              </>
            )}
          </Panel>

          <Panel title={`Amount Mismatches — Actual Invoice (Forecast) vs Invoiced (${data.mismatches.length})`} style={{ marginTop: 14 }}>
            <div ref={panelRefs.mismatches} />
            {data.mismatches.length === 0 ? <div className="subtitle">No gaps between Monthly Forecast's Actual Invoice and what was actually invoiced.</div> : (
              <>
                <div className="subtitle" style={{ marginTop: 0 }}>A CAD-billed invoice's own amount is shown in CAD (badge) — the gap on the right is always converted to and compared in USD, so a CAD project's currency conversion never shows up as a false gap.</div>
                <table>
                  <thead><tr><th>S.N</th><th>Client</th><th>Project</th><th>Resource</th><th>Invoice #</th><th className="num">Actual Invoice (Forecast)</th>{showForecast && <th className="num">Estimated (Forecast)</th>}<th className="num">Invoiced</th><th className="num">Gap (USD)</th></tr></thead>
                  <tbody>
                    {data.mismatches.map((m, i) => (
                      <tr key={m.lineId}>
                        <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                        <td>{m.client}</td>
                        <td>{m.project}</td>
                        <td>{m.resourceName}</td>
                        <td><AmountLink onClick={() => openInvoicePdf(m.invoiceId)} title="Open this invoice">{m.invoiceNo}</AmountLink></td>
                        <td className="num"><AmountLink onClick={() => goToForecastLine(m.lineId)} title="Open this line in Monthly Forecast">{money(m.actualInvoiceAmount)}</AmountLink></td>
                        {showForecast && <td className="num" style={{ color: "var(--muted)" }}>{money(m.estimateAmount)}</td>}
                        <td className="num">
                          <AmountLink onClick={() => openInvoicePdf(m.invoiceId)} title="Open this invoice">
                            {m.invoicedCurrency === "CAD" ? <CadBadge amount={m.invoicedAmount} /> : money(m.invoicedAmountUsd)}
                          </AmountLink>
                        </td>
                        <td className="num" style={{ color: m.difference < 0 ? "var(--bad, #c0392b)" : "var(--warn, #a8650a)" }}>{m.difference > 0 ? "+" : ""}{money(m.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} style={{ fontWeight: 600, textAlign: "right" }}>Total ({data.mismatches.length})</td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(data.mismatches.reduce((s, m) => s + (m.actualInvoiceAmount || 0), 0))}</td>
                      {showForecast && <td className="num" style={{ fontWeight: 600, color: "var(--muted)" }}>{money(data.mismatches.reduce((s, m) => s + (m.estimateAmount || 0), 0))}</td>}
                      <td className="num" style={{ fontWeight: 600 }}>{money(data.mismatches.reduce((s, m) => s + (m.invoicedAmountUsd || 0), 0))}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(data.mismatches.reduce((s, m) => s + (m.difference || 0), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
