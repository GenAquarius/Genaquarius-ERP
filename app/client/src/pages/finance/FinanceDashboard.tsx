import React, { useState } from "react";
import { Bar, Doughnut } from "react-chartjs-2";
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, LineElement, PointElement, Tooltip, Legend,
} from "chart.js";
import { useFetch, pct, marginClass, Panel, useDisplayCurrency, CostBreakdown, useFiscalYears, useSelectedFy, WorkforceDrillPopup, cellChangeTip, ForecastChangesPanel } from "../../ui";
import { useSortFilter, SortableHead, FilterToggle } from "../../DataTable";
import { NeedYourAttention } from "../../NeedYourAttention";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, LineElement, PointElement, Tooltip, Legend);
ChartJS.defaults.color = "#8b96b0";
ChartJS.defaults.borderColor = "#243049";

const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const CT_COLORS: Record<string, string> = { "Fixed Overhead": "#fbbf24", "Variable Overhead": "#6ea8ff", "Resource / Delivery (CTC)": "#34d399" };

export default function FinanceDashboard() {
  const [fy, setFy] = useSelectedFy();
  const [month, setMonth] = useState("ALL");
  const [showGP, setShowGP] = useState(true);
  const [rowPopup, setRowPopup] = useState<any>(null); // { month, roster } workforce drill-down
  const { ccy, rate, money } = useDisplayCurrency();
  const { data, loading } = useFetch<any>(`/dashboard/finance?fy=${fy}&month=${month}`, [fy, month]);
  const fyList = useFiscalYears();
  const rows = data ? (month === "ALL" ? data.rows : data.rows.filter((r: any) => r.month === month)) : [];
  const monthCols = [
    { key: "month", label: "Month", get: (r: any) => MONTHS.indexOf(r.month) },
    { key: "headCount", label: "Head Count", num: true, tip: "Distinct people with any resource line this month — one human = one head, regardless of projects or allocation %" },
    { key: "nonBillableAssigned", label: "Non-billable", num: true, tip: "Non-billable but ASSIGNED to a customer project (e.g. an unbilled month on the project) — part of the project team, counted in neither Bench nor Corporate" },
    { key: "bench", label: "Bench", num: true, tip: "Distinct people on a non-billable GenAquarius (Bench) row — cost only, no revenue" },
    { key: "corporate", label: "Corporate", num: true, tip: "Distinct people non-billable on an INTERNAL corporate project (Corporate / GenAquarius …). Someone non-billable on a CUSTOMER project counts as On Project, not Corporate" },
    { key: "billableHeadCount", label: "Billable (TB)", num: true, tip: "Billable (TB) = Onsite Billable + Offshore Billable + Double Dip (marked). Each marked double-dip fills a 2nd billable slot" },
    { key: "doubleDip", label: "Double Dip", num: true, tip: "People explicitly marked Double Dip (checkbox, or a saved incentive). Being on 2+ projects alone does NOT count" },
    { key: "offshoreBillable", label: "Offshore Bill.", num: true, tip: "Distinct billable people located India (or no location) with revenue this month — a person on 2 projects (incl. 50%+50% splits) counts once" },
    { key: "onsiteBillable", label: "Onsite Bill.", num: true, tip: "Distinct billable people located US / Canada / Caribbean with revenue this month — a person on 2 projects counts once" },
    { key: "salaryExpense", label: "Salary Expense", num: true, tip: "Sum of all resource (CTC) cost for the month — billable + bench + corporate, incl. bonus & double-dip incentives" },
    { key: "totalCost", label: "Total Cost", num: true, tip: "Salary Expense + all overhead / expense lines (fixed + variable) for the month" },
    { key: "revenue", label: "Revenue (TB)", num: true, tip: "Sum of Actual Invoice amounts across all billable resource lines for the month" },
    { key: "monthlyProfit", label: "Monthly Profit", num: true, tip: "Revenue (TB) − Total Cost" },
    ...(showGP ? [{ key: "netProfitPct", label: "PGP (Net %)", num: true }] : []),
  ];
  const projCols = [
    { key: "name", label: "Project" }, { key: "revenue", label: "Revenue", num: true }, { key: "cost", label: "Cost", num: true },
    ...(showGP ? [{ key: "margin", label: "Margin", num: true }] : []),
  ];
  const monthlySf = useSortFilter(rows, monthCols);
  const projSf = useSortFilter(data?.projects || [], projCols);
  if (loading || !data) return <div>Loading…</div>;

  const axisK = (v: any) => money(v);
  const scope = month === "ALL" ? "Full Year (Apr–Mar)" : month;
  // When a single month is picked, charts switch from yearly BAR (trend) to a
  // single-month DOUGHNUT (composition) — clearer for one period.
  const isMonth = month !== "ALL";
  const mrow: any = isMonth ? (rows[0] || {}) : {};
  const dMoney = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" as const }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed) } } } };
  const dCount = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" as const } } };

  return (
    <div>
      <NeedYourAttention />
      {rowPopup && (
        <WorkforceDrillPopup month={rowPopup.month} fy={fy} roster={rowPopup.roster} prevRoster={rowPopup.prevRoster} prevMonth={rowPopup.prevMonth} counts={rowPopup.counts} onClose={() => setRowPopup(null)} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Finance Dashboard — Actual Cost</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" }}>
          <button className="ghost" onClick={() => setShowGP(!showGP)} style={{ whiteSpace: "nowrap" }}>{showGP ? "Hide GP%" : "Show GP%"}</button>
          <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 120 }} title="Fiscal Year">
            {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 150 }} title="Period">
            <option value="ALL">Full Year (Apr–Mar)</option>
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div className="subtitle">Every metric mirrors the Actual Cost sheet · {fy} · {scope} · amounts in {ccy}</div>

      {/* KPI tiles */}
      <div className="grid kpi-row">
        <div className="kpi"><div className="label">Revenue (Total Billing)</div><div className="value">{money(data.totalRevenue)}</div></div>
        <div className="kpi"><div className="label">Salary Expense</div><div className="value">{money(data.totalSalary)}</div></div>
        <div className="kpi"><div className="label">Total Cost</div><div className="value">{money(data.totalCost)}</div></div>
        <div className="kpi"><div className="label">Profit</div><div className="value">{money(data.yearProfit)}</div><div className="sub">{data.totalRevenue ? pct((data.yearProfit / data.totalRevenue) * 100) : "—"} net</div></div>
      </div>

      <ForecastChangesPanel fiscalYear={fy} />

      {/* Charts */}
      <div className="grid charts-row" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
        <Panel title={`Revenue vs Total Cost vs Salary Expense · ${scope}`}>
          <div className="chart-wrap">
            {isMonth ? (
              <Doughnut data={{ labels: ["Revenue", "Total Cost", "Salary Expense"], datasets: [{ data: [mrow.revenue || 0, mrow.totalCost || 0, mrow.salaryExpense || 0], backgroundColor: ["#6ea8ff", "#f87171", "#fbbf24"] }] }} options={dMoney} />
            ) : (
              <Bar data={{
                labels: data.months,
                datasets: [
                  { label: "Revenue", data: data.monthlyRevenue, backgroundColor: "#6ea8ff", borderRadius: 4 },
                  { label: "Total Cost", data: data.monthlyCost, backgroundColor: "#f87171", borderRadius: 4 },
                  { label: "Salary Expense", data: data.monthlySalary, backgroundColor: "#fbbf24", borderRadius: 4 },
                ],
              }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { y: { ticks: { callback: axisK } } } }} />
            )}
          </div>
        </Panel>
        <Panel title={`Profit · ${scope}`}>
          <div className="chart-wrap">
            {isMonth ? (
              <Doughnut data={{ labels: ["Profit", "Total Cost"], datasets: [{ data: [Math.max(0, mrow.monthlyProfit || 0), mrow.totalCost || 0], backgroundColor: ["#34d399", "#f87171"] }] }} options={dMoney} />
            ) : (
              <Bar data={{
                labels: data.months,
                datasets: [{ label: "Profit", data: data.monthlyProfit, backgroundColor: data.monthlyProfit.map((v: number) => (v >= 0 ? "#34d399" : "#f87171")), borderRadius: 4 }],
              }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: axisK } } } }} />
            )}
          </div>
        </Panel>
        <Panel title={`Head Count vs Billable · ${scope}`}>
          <div className="note" style={{ marginBottom: 6, cursor: "help" }} title="Billable (TB) = Onsite Billable + Offshore Billable + Double Dip (marked) · Head Count = distinct people with any resource line">
            Billable (TB) = Onsite + Offshore + Double Dip (marked) · Head Count = distinct people — hover the table headers below for every formula
          </div>
          <div className="chart-wrap">
            {isMonth ? (
              <Doughnut data={{ labels: ["Billable", "Non-billable"], datasets: [{ data: [mrow.billableHeadCount || 0, Math.max(0, (mrow.headCount || 0) - (mrow.billableHeadCount || 0))], backgroundColor: ["#a78bfa", "#8b96b0"] }] }} options={dCount} />
            ) : (
              <Bar data={{
                labels: data.months,
                datasets: [
                  { label: "Head Count", data: data.monthlyHeadcount, backgroundColor: "#8b96b0", borderRadius: 4 },
                  { label: "Billable", data: data.monthlyBillable, backgroundColor: "#a78bfa", borderRadius: 4 },
                ],
              }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }} />
            )}
          </div>
        </Panel>
      </div>

      {/* Full monthly table — exact Actual Cost summary block */}
      <Panel title="Monthly Metrics (Actual Cost summary)" style={{ marginTop: 14 }}>
        <div style={{ marginBottom: 8 }}><FilterToggle sf={monthlySf} /></div>
        <table>
          <SortableHead cols={monthCols} sf={monthlySf} />
          <tbody>
            {monthlySf.view.map((r: any) => {
              const prevRow = r.monthIndex > 0 ? data.rows.find((x: any) => x.monthIndex === r.monthIndex - 1) : null;
              const curRoster = data.rosterByMonth?.[r.monthIndex] || {};
              const prevRoster = r.monthIndex > 0 ? data.rosterByMonth?.[r.monthIndex - 1] : null;
              const prevLabel = prevRow ? prevRow.month : null;
              const tip = (key: string, val: number, fmt?: (n: number) => string) =>
                cellChangeTip(key, val, prevRow ? prevRow[key] : undefined, curRoster, prevRoster, prevLabel, fmt || money);
              return (
                <tr key={r.month} style={{ cursor: "pointer" }} title="Click to list resources by category"
                  onClick={() => setRowPopup({
                    month: r.month, roster: curRoster, counts: r,
                    prevRoster, prevMonth: prevLabel,
                  })}>
                  <td>{r.month}</td>
                  <td className="num" title={tip("headCount", r.headCount)}>{r.headCount}</td>
                  <td className="num" title={tip("nonBillableAssigned", r.nonBillableAssigned || 0)}>{r.nonBillableAssigned || 0}</td>
                  <td className="num" title={tip("bench", r.bench)}>{r.bench}</td>
                  <td className="num" title={tip("corporate", r.corporate)}>{r.corporate}</td>
                  <td className="num" title={tip("billableHeadCount", r.billableHeadCount)}>{r.billableHeadCount}</td>
                  <td className="num" title={tip("doubleDip", r.doubleDip)}>{r.doubleDip}</td>
                  <td className="num" title={tip("offshoreBillable", r.offshoreBillable)}>{r.offshoreBillable}</td>
                  <td className="num" title={tip("onsiteBillable", r.onsiteBillable)}>{r.onsiteBillable}</td>
                  <td className="num" title={tip("salaryExpense", r.salaryExpense)}>{money(r.salaryExpense)}</td>
                  <td className="num" title={tip("totalCost", r.totalCost)}>{money(r.totalCost)}</td>
                  <td className="num" title={tip("revenue", r.revenue)}>{money(r.revenue)}</td>
                  <td className="num" title={tip("monthlyProfit", r.monthlyProfit)}>{money(r.monthlyProfit)}</td>
                  {showGP && <td className={"num " + marginClass(r.netProfitPct)} title={tip("netProfitPct", r.netProfitPct, pct)}>{pct(r.netProfitPct)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title={`Cost Breakdown by Cost Center — ${scope}`} style={{ marginTop: 14 }}>
        <CostBreakdown items={data.costBreakdown || []} money={money} />
      </Panel>

      <Panel title={`Fixed vs Variable Cost — ${scope}`} style={{ marginTop: 14 }}>
        <div className="grid cols-2">
          <div className="chart-wrap">
            <Doughnut data={{ labels: (data.costType || []).map((c: any) => c.category), datasets: [{ data: (data.costType || []).map((c: any) => c.cost), backgroundColor: (data.costType || []).map((c: any) => CT_COLORS[c.category] || "#a78bfa") }] }}
              options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c: any) => c.label + ": " + money(c.parsed) } } } }} />
          </div>
          <CostBreakdown items={data.costType || []} money={money} />
        </div>
      </Panel>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="Roll-ups (Transfer Pricing, Tax, Cash Flow)">
          <table><tbody>
            <tr><td>Internal / Overhead Cost</td><td className="num">{money(data.internalCost)}</td></tr>
            <tr><td>Revenue Run-Rate (×12)</td><td className="num">{money(data.revenueRunRate)}</td></tr>
            <tr><td>Transfer Pricing (15%)</td><td className="num">{money(data.transferPricing)}</td></tr>
            <tr><td>Tax (26% of 15%)</td><td className="num">{money(data.tax)}</td></tr>
            <tr><td>Cash Flow (30 days)</td><td className="num">{money(data.cashFlow30)}</td></tr>
            <tr><td>Cash Flow (60 days)</td><td className="num">{money(data.cashFlow60)}</td></tr>
            <tr><td><b>Net Profit After Tax</b></td><td className="num"><b>{money(data.netProfitAfterTax)}</b></td></tr>
          </tbody></table>
        </Panel>
        <Panel title="Per-Project Cost vs Revenue (full year)">
          <div style={{ marginBottom: 8 }}><FilterToggle sf={projSf} /></div>
          <table>
            <SortableHead cols={projCols} sf={projSf} />
            <tbody>
              {projSf.view.map((p: any) => (
                <tr key={p.name}><td>{p.name}</td><td className="num">{money(p.revenue)}</td><td className="num">{money(p.cost)}</td>{showGP && <td className={"num " + marginClass(p.margin)}>{pct(p.margin)}</td>}</tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
