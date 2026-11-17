import React from "react";
import { Bar, Line, Doughnut } from "react-chartjs-2";
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  ArcElement, Tooltip, Legend,
} from "chart.js";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import { api } from "../../api";
import { Panel, COST_COLORS, useFiscalYears, useSelectedFy } from "../../ui";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend);
ChartJS.defaults.color = "#8b96b0";
ChartJS.defaults.borderColor = "#243049";

const EXAMPLES = [
  "Average salary for offshore for the current financial year, monthly and annually",
  "Average salary by project for onsite, for the year",
  "Project-wise revenue for FY26-27",
  "State-wise revenue report for the selected financial year — each client's revenue listed under its state",
  "Show me all expenses for the year",
  "Show and explain the detail of the Rent expense for the year",
  "Explain how the formula for cost (CTC) is worked out",
  "Who all did not submit their timesheet for November 2025?",
  "Forecast revenue if I add 5 resources in Nov and 5 in Dec",
  "Current month headcount by project — onsite, offshore, billable, non-billable and total",
  "Headcount by geography this month — full-time vs contractor, billable vs non-billable",
  "Explain why October's revenue and expenses increased or decreased vs September, by project — show me a chart",
];

// ---- Renderer: turns a Claude report-spec into the same look as the dashboards ----
function ReportRenderer({ spec }: { spec: any }) {
  if (!spec) return null;
  const chartOpts = (legend = true): any => ({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: legend, position: "bottom" } },
  });
  const palette = COST_COLORS;
  const areaRef = React.useRef<HTMLDivElement>(null);
  const fileBase = String(spec.title || "report").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60) || "report";
  const save = (name: string, href: string) => { const a = document.createElement("a"); a.href = href; a.download = name; a.click(); };
  // CSV of every table in the report (blank line + title between tables).
  const downloadTablesCsv = () => {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out: string[] = [];
    for (const t of spec.tables || []) {
      if (t.title) out.push(esc(t.title));
      out.push((t.columns || []).map((c: any) => esc(c.label)).join(","));
      for (const row of t.rows || []) out.push((t.columns || []).map((c: any) => esc(row[c.key])).join(","));
      out.push("");
    }
    if (!out.length) return;
    const url = URL.createObjectURL(new Blob(["﻿" + out.join("\n")], { type: "text/csv" }));
    save(`${fileBase}.csv`, url);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  // PNG of each chart, composited on a white background so it reads on any viewer.
  const downloadChartPngs = () => {
    const canvases = Array.from(areaRef.current?.querySelectorAll("canvas") || []) as HTMLCanvasElement[];
    canvases.forEach((cv, i) => {
      const out = document.createElement("canvas");
      out.width = cv.width; out.height = cv.height;
      const g = out.getContext("2d"); if (!g) return;
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, out.width, out.height); g.drawImage(cv, 0, 0);
      setTimeout(() => save(`${fileBase}_chart${i + 1}.png`, out.toDataURL("image/png")), i * 250);
    });
  };
  const hasCharts = !!(spec.charts || []).length, hasTables = !!(spec.tables || []).length;
  return (
    <div id="ai-report-area" ref={areaRef}>
      {/* Print / Save-as-PDF shows only the report, not the app chrome around it. */}
      <style>{`@media print { body * { visibility: hidden !important; } #ai-report-area, #ai-report-area * { visibility: visible !important; } #ai-report-area { position: absolute; left: 0; top: 0; width: 100%; background: #fff; color: #111; } .no-print { display: none !important; } }`}</style>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", marginBottom: 6 }}>
        <button className="ghost" onClick={() => window.print()} title="Opens the print dialog — choose “Save as PDF” to download the report with its charts">🖨 Print / Save as PDF</button>
        {hasCharts && <button className="ghost" onClick={downloadChartPngs} title="Downloads each chart as a PNG image">⬇ Charts (PNG)</button>}
        {hasTables && <button className="ghost" onClick={downloadTablesCsv} title="Downloads every table in the report as one CSV (opens in Excel)">⬇ Tables (CSV)</button>}
      </div>
      <h1 style={{ marginBottom: 2 }}>{spec.title || "Report"}</h1>
      {spec.subtitle && <div className="subtitle">{spec.subtitle}</div>}
      {spec.narrative && <p style={{ color: "var(--muted)", lineHeight: 1.6, maxWidth: 900 }}>{spec.narrative}</p>}

      {!!(spec.kpis || []).length && (
        <div className="grid kpi-row" style={{ marginTop: 8 }}>
          {spec.kpis.map((k: any, i: number) => (
            <div className="kpi" key={i}>
              <div className="label">{k.label}</div>
              <div className="value">{k.value}</div>
              {k.sub && <div className="sub">{k.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {!!(spec.charts || []).length && (
        <div className="grid charts-row" style={{ marginTop: 14 }}>
          {spec.charts.map((c: any, i: number) => {
            const datasets = (c.series || []).map((s: any, si: number) => ({
              label: s.name || "",
              data: s.data || [],
              backgroundColor: c.type === "doughnut" ? palette : palette[si % palette.length],
              borderColor: palette[si % palette.length],
              borderRadius: c.type === "bar" ? 4 : undefined,
              tension: c.type === "line" ? 0.3 : undefined,
              fill: false,
            }));
            const data = { labels: c.labels || [], datasets };
            return (
              <Panel title={c.title} key={i}>
                <div className="chart-wrap">
                  {c.type === "line" ? <Line data={data} options={chartOpts()} />
                    : c.type === "doughnut" ? <Doughnut data={data} options={chartOpts()} />
                      : <Bar data={data} options={chartOpts(datasets.length > 1)} />}
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {(spec.tables || []).map((t: any, i: number) => (
        <Panel title={t.title} key={i} style={{ marginTop: 14 }}>
          <table>
            <thead><tr>{(t.columns || []).map((col: any) => <th key={col.key} className={col.num ? "num" : ""}>{col.label}</th>)}</tr></thead>
            <tbody>
              {(t.rows || []).map((row: any, ri: number) => (
                <tr key={ri}>{(t.columns || []).map((col: any) => <td key={col.key} className={col.num ? "num" : ""}>{String(row[col.key] ?? "")}</td>)}</tr>
              ))}
              {!(t.rows || []).length && <tr><td colSpan={(t.columns || []).length} style={{ color: "var(--muted)" }}>No rows.</td></tr>}
            </tbody>
          </table>
        </Panel>
      ))}

      {!!(spec.insights || []).length && (
        <Panel title="Insights" style={{ marginTop: 14 }}>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            {spec.insights.map((s: string, i: number) => <li key={i}>{s}</li>)}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export default function AiReport() {
  const fyList = useFiscalYears();
  const [fy, setFy] = useSelectedFy();
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<any>(null);
  const [cfg, setCfg] = React.useState<any>(null);

  React.useEffect(() => { api.get("/ai-report/config").then(setCfg).catch(() => setCfg({ configured: false })); }, []);

  const run = async (p?: string) => {
    const q = (p ?? prompt).trim();
    if (!q) return;
    if (p) setPrompt(q);
    setBusy(true); setError(null); setResult(null);
    try { setResult(await api.post("/ai-report/query", { prompt: q, fy })); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const runStateRevenue = async () => {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await api.get(`/ai-report/state-revenue?fy=${encodeURIComponent(fy)}`)); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 8 }}><AutoAwesomeRoundedIcon /> AI Report</h1>
        <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 130 }} title="Fiscal Year">
          {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      <div className="subtitle">Ask in plain English — Claude pulls the real numbers and builds a report. Powered by your costing data, never invented.</div>

      {cfg && !cfg.configured && (
        <Panel style={{ marginBottom: 14, borderLeft: "3px solid var(--bad, #e5484d)" }}>
          <b>Claude API key not configured.</b> Add your Anthropic API key and pick a model in <b>Settings → AI Report</b> to enable this page.
        </Panel>
      )}

      <Panel style={{ marginBottom: 14 }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); }}
          placeholder="e.g. Average salary for offshore for the current financial year, monthly and annually"
          rows={3}
          style={{ width: "100%", resize: "vertical", padding: 10, fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <span className="subtitle" style={{ margin: 0 }}>Tip: ⌘/Ctrl + Enter to run · model: <b>{cfg?.model || "—"}</b></span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* Direct (no-AI) report for whichever fiscal year is selected here — FY25-26, FY26-27, … */}
            <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 110 }} title="Fiscal year for the State-wise Revenue report">
              {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <button className="ghost" disabled={busy} onClick={runStateRevenue}
              title={`State-wise revenue for ${fy} — each client's revenue under its State`}>State-wise Revenue · {fy}</button>
            <button onClick={() => run()} disabled={busy || !prompt.trim()}>{busy ? "Building report…" : "Generate Report"}</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="ghost" style={{ fontSize: 12 }} onClick={() => setPrompt(ex)} disabled={busy} title="Fill the prompt — then click Generate Report">{ex}</button>
          ))}
        </div>
      </Panel>

      {error && <Panel style={{ borderLeft: "3px solid var(--bad, #e5484d)" }}><b>Couldn't build the report:</b> {error}</Panel>}

      {result?.unsupported && (
        <Panel title="I can't build this one yet" style={{ borderLeft: "3px solid #fbbf24" }}>
          <p style={{ lineHeight: 1.6 }}>{result.unsupported.reason}</p>
          {result.unsupported.suggestedTool && <p className="subtitle" style={{ margin: "6px 0 0" }}>Suggested capability: <code>{result.unsupported.suggestedTool}</code></p>}
          {!!(result.unsupported.neededData || []).length && (
            <p className="subtitle" style={{ margin: "6px 0 0" }}>Needs: {result.unsupported.neededData.join(", ")}</p>
          )}
          <div className="note" style={{ marginTop: 10 }}>This gap has been logged (Admin → Audit Log) so the team can add the metric.</div>
        </Panel>
      )}

      {result?.spec && <ReportRenderer spec={result.spec} />}

      {result && !!(result.toolCalls || []).length && (
        <Panel title="How this was built" style={{ marginTop: 14 }}>
          <div className="subtitle" style={{ margin: 0 }}>Data tools called: {result.toolCalls.map((t: any) => t.name).join(" → ")}</div>
        </Panel>
      )}
    </div>
  );
}
