import React from "react";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend,
} from "chart.js";
import { useFetch, fmt, pct, marginClass, Panel, useDisplayCurrency, CostBreakdown, COST_COLORS, useFiscalYears, useSelectedFy, ForecastChangesPanel } from "../../ui";
import { useSortFilter, SortableHead, FilterToggle } from "../../DataTable";
import { NeedYourAttention } from "../../NeedYourAttention";

const PROF_COLS = [
  { key: "name", label: "Customer" },
  { key: "geo", label: "Geo" },
  { key: "deliveryModel", label: "Model", get: (p: any) => (p.deliveryModel === "ONSITE" ? "Onsite" : "Offshore") },
  { key: "revenue", label: "Revenue", num: true }, { key: "cost", label: "Cost", num: true },
  { key: "profit", label: "Profit", num: true }, { key: "margin", label: "Margin", num: true },
];

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend);
ChartJS.defaults.color = "#8b96b0";
ChartJS.defaults.borderColor = "#243049";

const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const CT_COLORS: Record<string, string> = { "Fixed Overhead": "#fbbf24", "Variable Overhead": "#6ea8ff", "Resource / Delivery (CTC)": "#34d399" };

export default function CeoDashboard() {
  const [fy, setFy] = useSelectedFy();
  const [month, setMonth] = React.useState("ALL");
  const [profFilter, setProfFilter] = React.useState("ALL"); // ALL | ONSITE | OFFSHORE
  const [wfPopup, setWfPopup] = React.useState<any>(null); // {label, color, names[]} workforce slice drill-down
  const [wfView, setWfView] = React.useState<"list" | "visual">("list");
  const { ccy, rate, money, moneyM } = useDisplayCurrency();
  const { data, loading } = useFetch<any>(`/dashboard/ceo?fy=${fy}&month=${month}`, [fy, month]);
  const fyList = useFiscalYears();
  // Rules of Hooks: every hook must run on every render. Compute profRows from a
  // guarded `data` and call useSortFilter BEFORE the early return below — putting
  // it after made the hook count jump once data loaded, crashing the page.
  const profRows = ((data?.projects as any[]) || []).filter((p) =>
    profFilter === "ALL" ? true : profFilter === "ONSITE" ? p.deliveryModel === "ONSITE" : p.deliveryModel !== "ONSITE",
  );
  const profSf = useSortFilter(profRows, PROF_COLS);
  if (loading || !data) return <div>Loading…</div>;
  const axisK = (v: any) => money(v);

  const r = data.receivables;
  const past30 = r.aging.filter((a: any) => a.past30);
  const scope = month === "ALL" ? "Full Year (Apr–Mar)" : month;
  const isMonth = month !== "ALL"; // month view → doughnut composition; year → bar trend

  // group the customer projects so doughnut hovers can list their constituents
  const byGeo: Record<string, any[]> = {};
  const byDM: Record<string, any[]> = { ONSITE: [], OFFSHORE: [] };
  for (const p of data.projects as any[]) {
    (byGeo[p.geo] = byGeo[p.geo] || []).push(p);
    byDM[p.deliveryModel === "ONSITE" ? "ONSITE" : "OFFSHORE"].push(p);
  }
  // tooltip extra lines: the projects making up a slice (top 8 by revenue + overflow)
  const projLines = (arr: any[] = []) => {
    const s = [...arr].filter((p) => p.revenue > 0).sort((a, b) => b.revenue - a.revenue);
    const lines = s.slice(0, 8).map((p) => `  ${p.name}: ${money(p.revenue)}`);
    if (s.length > 8) lines.push(`  +${s.length - 8} more`);
    return lines.length ? ["", "Projects:", ...lines] : [];
  };
  const top5 = (data.projects as any[]).slice(0, 5);

  return (
    <div>
      <NeedYourAttention />
      {wfPopup && (() => {
        // "Name (ProjA, ProjB)" -> { name, projects[] } — same source strings as the List view
        // used before, just split apart so both views can style name/project/category distinctly
        // instead of one flat string. No data is dropped, only re-presented.
        const rows = wfPopup.names.map((raw: string) => {
          const m = /^(.*?)\s*\((.*)\)$/.exec(raw);
          return m ? { name: m[1], projects: m[2].split(",").map((p) => p.trim()).filter(Boolean) } : { name: raw, projects: [] as string[] };
        });
        const initials = (n: string) => n.trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
        return (
          <div onClick={() => setWfPopup(null)} style={{ position: "fixed", inset: 0, background: "rgba(5,9,18,.7)", backdropFilter: "blur(2px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--modal-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, width: 620, maxWidth: "92vw", maxHeight: "80vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.6)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
                <h2 style={{ margin: 0 }}><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: wfPopup.color, marginRight: 8 }} />{wfPopup.label} — {rows.length} resource(s)</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {(["list", "visual"] as const).map((v) => (
                      <button key={v} className="ghost" onClick={() => setWfView(v)}
                        style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, borderRadius: 0, background: wfView === v ? "var(--panel2)" : "transparent", color: wfView === v ? "var(--accent)" : "var(--muted)" }}>
                        {v === "list" ? "☰ List" : "▦ Visual"}
                      </button>
                    ))}
                  </div>
                  <button className="ghost" onClick={() => setWfPopup(null)}>✕ Close</button>
                </div>
              </div>
              {rows.length === 0 ? <div style={{ color: "var(--muted)" }}>No resources.</div> : wfView === "list" ? (
                <div style={{ columns: rows.length > 10 ? 2 : 1, columnGap: 24 }}>
                  {rows.map((r: any, i: number) => (
                    <div key={i} style={{ breakInside: "avoid", display: "flex", alignItems: "baseline", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span style={{ color: "var(--muted)", fontSize: 12, minWidth: 18 }}>{i + 1}.</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: "var(--text)" }}>{r.name}</div>
                        {r.projects.length > 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>{r.projects.join(", ")}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
                  {rows.map((r: any, i: number) => (
                    <div key={i} style={{ border: `1px solid ${wfPopup.color}55`, background: `${wfPopup.color}14`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 6 }}>
                      <span style={{ width: 36, height: 36, borderRadius: "50%", background: wfPopup.color, color: "#06101f", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{initials(r.name)}</span>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", lineHeight: 1.25 }}>{r.name}</div>
                      {r.projects.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "center" }}>
                          {r.projects.map((p: string, pi: number) => (
                            <span key={pi} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 20, background: "var(--panel2)", color: "var(--muted)", border: "1px solid var(--border)" }}>{p}</span>
                          ))}
                        </div>
                      ) : <div style={{ fontSize: 10, color: "var(--muted)" }}>—</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Executive Dashboard</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" }}>
          <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 120 }} title="Fiscal Year">
            {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 150 }} title="Period">
            <option value="ALL">Full Year (Apr–Mar)</option>
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div className="subtitle">Global revenue, projections, profitability, receivables & cash · {fy} · {scope}</div>

      <div className="grid kpi-row">
        <div className="kpi"><div className="label">Global Company Revenue</div><div className="value">{moneyM(data.totalRevenue)}</div><div className="sub">All geographies · {ccy}</div></div>
        <div className="kpi"><div className="label">EBITDA on Global Revenue</div><div className="value">{money(data.ebitda)} <span style={{fontSize:13}}>({pct(data.ebitdaMargin)})</span></div><div className="sub">After all customer + internal cost</div></div>
        <div className="kpi"><div className="label">Accounts Receivable</div><div className="value">{money(r.totalAR)}</div><div className="sub">{past30.length} invoice(s) past 30 days</div></div>
        <div className="kpi"><div className="label">Cash Position</div><div className="value">{money(r.cashPosition)}</div><div className="sub">Bank of America (synced)</div></div>
      </div>

      <ForecastChangesPanel fiscalYear={fy} />

      <div className="grid charts-row">
        <Panel title={`Revenue & Cost · ${scope}`}>
          <div className="chart-wrap">
            {isMonth ? (
              <Doughnut data={{ labels: ["Revenue", "Cost"], datasets: [{ data: [data.totalRevenue, data.customerCost + data.internalCost], backgroundColor: ["#6ea8ff", "#f87171"] }] }}
                options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed) } } } }} />
            ) : (
              <Bar data={{
                labels: data.months,
                datasets: [
                  { label: "Revenue", data: data.monthlyRevenue, backgroundColor: "#6ea8ff", borderRadius: 4 },
                  { label: "Cost", data: data.monthlyCost, backgroundColor: "#f87171", borderRadius: 4 },
                  { type: "line", label: "Profit (before tax)", data: data.monthlyRevenue.map((rv: number, i: number) => rv - data.monthlyCost[i]), borderColor: "#34d399", backgroundColor: "#34d399", tension: 0.3, pointRadius: 3 },
                ] as any,
              }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.dataset.label + ": " + money(c.parsed.y) } }, }, scales: { y: { ticks: { callback: axisK } } } }} />
            )}
          </div>
        </Panel>
        <Panel title="Revenue by Geography (US / Canada / Caribbean)">
          <div className="chart-wrap">
            <Doughnut data={{
              labels: Object.keys(data.geoRevenue),
              datasets: [{ data: Object.values(data.geoRevenue), backgroundColor: ["#6ea8ff", "#34d399", "#fbbf24", "#a78bfa"] }],
            }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed), afterLabel: (c: any) => projLines(byGeo[c.label]) } } } }} />
          </div>
        </Panel>
        <Panel title="Onsite vs Offshore Revenue">
          <div className="chart-wrap">
            <Doughnut data={{
              labels: ["Onsite", "Offshore"],
              datasets: [{ data: [data.onsiteRevenue, data.offshoreRevenue], backgroundColor: ["#a78bfa", "#34d399"] }],
            }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed), afterLabel: (c: any) => projLines(byDM[c.label === "Onsite" ? "ONSITE" : "OFFSHORE"]) } } } }} />
          </div>
        </Panel>
      </div>

      {data.workforce && (() => {
        const w = data.workforce;
        const populated = w.total.map((t: number, i: number) => (t > 0 ? i : -1)).filter((i: number) => i >= 0);
        const pieIdx = month !== "ALL" ? data.months.indexOf(month) : (populated.length ? populated[populated.length - 1] : 0);
        const roster = (w.rosterByMonth && w.rosterByMonth[pieIdx]) || {};
        const defs = [
          { label: "Onsite Billable", key: "onsiteBillable", color: "#6ea8ff" },
          { label: "Offshore Billable", key: "offshoreBillable", color: "#34d399" },
          { label: "Bench", key: "bench", color: "#fbbf24" },
          { label: "Corporate", key: "shadow", color: "#f472b6" },
          { label: "On Project (Non-billable)", key: "assigned", color: "#8b96b0" },
        ];
        const slices = defs.map((d) => ({ ...d, value: (w as any)[d.key][pieIdx] || 0 })).filter((s) => s.value > 0);
        const total = w.total[pieIdx] || 0;
        const scopeM = pieIdx >= 0 ? data.months[pieIdx] : "—";
        // Inline plugin: draw the head-count number on each slice.
        const countLabels = {
          id: "wfCountLabels",
          afterDatasetsDraw(chart: any) {
            const { ctx } = chart; const meta = chart.getDatasetMeta(0);
            meta.data.forEach((arc: any, i: number) => {
              const v = chart.data.datasets[0].data[i]; if (!v) return;
              const pos = arc.tooltipPosition();
              ctx.save(); ctx.fillStyle = "#0b1220"; ctx.font = "bold 14px sans-serif";
              ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(v), pos.x, pos.y); ctx.restore();
            });
          },
        };
        const openSlice = (i: number) => { const s = slices[i]; if (s) setWfPopup({ label: s.label, color: s.color, names: roster[s.key] || [] }); };
        return (
          <Panel title={`Workforce Composition · ${scopeM} · ${fy} (Total ${total})`} style={{ marginTop: 14 }}>
            <div className="chart-wrap" style={{ maxWidth: 460, margin: "0 auto" }}>
              <Doughnut data={{ labels: slices.map((s) => `${s.label} (${s.value})`), datasets: [{ data: slices.map((s) => s.value), backgroundColor: slices.map((s) => s.color) }] }}
                plugins={[countLabels]}
                options={{ responsive: true, maintainAspectRatio: false, onClick: (_e: any, els: any) => { if (els && els.length) openSlice(els[0].index); },
                  plugins: { legend: { position: "bottom", onClick: (_e: any, item: any) => openSlice(item.index) }, tooltip: { callbacks: {
                    label: (c: any) => `${slices[c.dataIndex].label}: ${c.parsed}`,
                    afterLabel: (c: any) => `Click to list all ${roster[slices[c.dataIndex].key]?.length || 0} resources`,
                  } } } }} />
            </div>
            {(() => { const g = (k: string) => ((w as any)[k]?.[pieIdx] || 0); const tb = g("onsiteBillable") + g("offshoreBillable") + g("doubleDip");
              const tips: [string, number, string][] = [
                ["Billable (TB)", tb, "Billable (TB) = Onsite Billable + Offshore Billable + Double Dip (marked). Each marked double-dip fills a 2nd billable slot."],
                ["Onsite Billable", g("onsiteBillable"), "Distinct billable people located US / Canada / Caribbean with revenue this month — a person on 2 projects counts once."],
                ["Offshore Billable", g("offshoreBillable"), "Distinct billable people located India (or no location) with revenue this month — a person on 2 projects (incl. 50%+50% splits) counts once."],
                ["Double Dip", g("doubleDip"), "People explicitly marked Double Dip (checkbox, or a saved incentive). Being on 2+ projects alone does NOT count."],
                ["Bench", g("bench"), "Distinct people on a non-billable GenAquarius (Bench) row — cost only, no revenue."],
                ["Corporate", g("shadow"), "Distinct people non-billable on an INTERNAL corporate project (Corporate / GenAquarius …)."],
                ["On Project (NB)", g("assigned"), "Non-billable but ASSIGNED to a customer project (e.g. an unbilled month) — counted in neither Bench nor Corporate."],
                ["Total Head Count", total, "Distinct people with any resource line this month — one human = one head, regardless of projects or allocation %."],
              ];
              return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 10 }}>
                {tips.map(([label, v, tip]) => <span key={label} className="pill" title={tip} style={{ cursor: "help" }}>{label}: <b>{v}</b></span>)}
              </div>; })()}
            <div className="note" style={{ marginTop: 8 }}>Hover any figure above for its exact formula. Composition for {scopeM} — counts shown on each slice. <b>Click a slice</b> (or legend) to see all resource names. {month === "ALL" ? "Showing the latest populated month — pick a month above to change it." : ""}</div>
          </Panel>
        );
      })()}

      <Panel title="Billable Head Count — Month on Month" style={{ marginTop: 14 }}>
        <div className="chart-wrap">
          <Bar data={{
            labels: data.months,
            datasets: [
              { label: "Billable Head Count", data: data.monthlyBillable, backgroundColor: "#a78bfa", borderRadius: 4 },
              { type: "line", label: "Total Head Count", data: data.monthlyHeadcount, borderColor: "#6ea8ff", backgroundColor: "#6ea8ff", tension: 0.3, pointRadius: 3 },
            ] as any,
          }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }} />
        </div>
        <div className="note" style={{ marginTop: 6, cursor: "help" }} title="Billable (TB) = Onsite Billable + Offshore Billable + Double Dip (marked) · Total Head Count = distinct people with any resource line">
          Billable (TB) = Onsite + Offshore + Double Dip (marked) · Total Head Count = distinct people
        </div>
      </Panel>

      <Panel title="Top 5 Customers by Revenue" style={{ marginTop: 14 }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          {top5.map((p: any, i: number) => (
            <div key={p.name} className="panel" style={{ borderLeft: "3px solid var(--accent)" }}>
              <div className="label" style={{ color: "var(--muted)", fontSize: 11 }}>#{i + 1} · {p.geo}</div>
              <div style={{ fontWeight: 600, margin: "4px 0", fontSize: 15 }}>{p.name}</div>
              <div style={{ fontSize: 18, color: "var(--accent)" }}>{money(p.revenue)}</div>
              <div className="label">Margin: {pct(p.margin)}</div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="Cost Breakdown by Cost Center">
          <div className="chart-wrap">
            <Doughnut data={{
              labels: (data.costBreakdown || []).map((c: any) => c.category),
              datasets: [{ data: (data.costBreakdown || []).map((c: any) => c.cost), backgroundColor: COST_COLORS }],
            }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed) } } } }} />
          </div>
        </Panel>
        <Panel title="Cost Breakdown — Detail (ties to Total Cost)">
          <CostBreakdown items={data.costBreakdown || []} money={money} />
        </Panel>
      </div>

      <Panel title={`Fixed vs Variable Cost · ${scope}`} style={{ marginTop: 14 }}>
        <div className="grid cols-2">
          <div className="chart-wrap">
            <Doughnut data={{ labels: (data.costType || []).map((c: any) => c.category), datasets: [{ data: (data.costType || []).map((c: any) => c.cost), backgroundColor: (data.costType || []).map((c: any) => CT_COLORS[c.category] || "#a78bfa") }] }}
              options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed) } } } }} />
          </div>
          <CostBreakdown items={data.costType || []} money={money} />
        </div>
      </Panel>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="Profitability of Each Customer">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span className="label" style={{ color: "var(--muted)", fontSize: 12 }}>Delivery:</span>
            <select value={profFilter} onChange={(e) => setProfFilter(e.target.value)} style={{ width: 160 }}>
              <option value="ALL">All ({data.projects.length})</option>
              <option value="OFFSHORE">Offshore (India) ({byDM.OFFSHORE.length})</option>
              <option value="ONSITE">Onsite (US) ({byDM.ONSITE.length})</option>
            </select>
            <FilterToggle sf={profSf} />
          </div>
          <table>
            <SortableHead cols={PROF_COLS} sf={profSf} />
            <tbody>
              {profSf.view.map((p: any) => (
                <tr key={p.name}>
                  <td>{p.name}</td><td>{p.geo}</td>
                  <td>{p.deliveryModel === "ONSITE" ? "Onsite" : "Offshore"}</td>
                  <td className="num">{money(p.revenue)}</td><td className="num">{money(p.cost)}</td>
                  <td className="num">{money(p.profit)}</td>
                  <td className={"num " + marginClass(p.margin)}>{pct(p.margin)}</td>
                </tr>
              ))}
              {profSf.view.length === 0 && <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No projects for this filter.</td></tr>}
            </tbody>
          </table>
        </Panel>
        <Panel title="Accounts Receivable — Past 30 Days">
          <table>
            <thead><tr><th>Invoice</th><th>Customer</th><th className="num">Amount</th><th className="num">Days Past Due</th></tr></thead>
            <tbody>
              {r.aging.length === 0 && <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No open receivables synced yet.</td></tr>}
              {r.aging.map((a: any) => (
                <tr key={a.invoiceNo}>
                  <td>{a.invoiceNo}</td><td>{a.client}</td>
                  <td className="num">{fmt(a.amount, a.currency)}</td>
                  <td className={"num " + (a.past30 ? "margin-bad" : "")}>{a.daysPastDue > 0 ? a.daysPastDue : "—"}</td>
                </tr>
              ))}
              {r.externalAR.map((a: any) => (
                <tr key={a.extId}>
                  <td>{a.extId}</td><td>{a.customerRef}</td>
                  <td className="num">{fmt(a.amount, a.currency)}</td>
                  <td className="num">via {a.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="note">AR &amp; Cash are sourced from external systems (Tally + Bank of America). Connect them in Admin → Integrations to replace the seeded sample rows.</div>
        </Panel>
      </div>
    </div>
  );
}
