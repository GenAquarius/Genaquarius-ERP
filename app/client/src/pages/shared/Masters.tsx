import React, { useState, useEffect } from "react";
import { statesForGeography, stateLabelForGeography } from "../../geoStates";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useFetch, fmt, Panel, getDisplayCcy, setDisplayCcy, getPageSize, setPageSize, d2, projectLabel, projectBaseName, ESIGN_STATUS_LABEL, CandidateDocumentsPanel, isMasked, useMaskNumbers, Masked } from "../../ui";
import { watchRoom } from "../../realtime";
import { DataTable } from "../../DataTable";
import { Modal, Input, Select, AddButton, GhostButton, confirmDialog } from "../../components";
import { useToast } from "../../components";
import { isAdmin, useAuth } from "../../auth";
import { fmtDate } from "../../dateFormat";

function useAdminGate() { const { user } = useAuth(); return isAdmin(user?.role); }
// Breaks a long flat form-grid into clearly labeled sections — purely visual, no behavior change.
const SectionHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="full" style={{ marginTop: 14, paddingBottom: 4, borderBottom: "1px solid var(--border)", fontWeight: 700, fontSize: 13, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>
    {children}
  </div>
);
const confirmDel = (name: string) => confirmDialog({ title: `Delete "${name}"?`, message: "This cannot be undone.", danger: true, confirmLabel: "Delete" });

const FY_MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

// =====================================================================
// F4 — Employee per-month, per-project COST allocation grid.
// 12 month rows × N project columns; each cell is a percent; every allocated
// month must total 100% (live green/red indicator). Cost per project = pct ×
// the employee's monthly CTC cost.
// =====================================================================
function AllocationGrid({ employee, projects, onClose, onSaved }: { employee: any; projects: any[]; onClose: () => void; onSaved?: () => void }) {
  const { show } = useToast();
  const [fiscalYear, setFiscalYear] = useState("FY26-27");
  const [cols, setCols] = useState<number[]>([]);            // selected project ids (columns)
  const [grid, setGrid] = useState<Record<string, Record<number, number>>>({}); // month -> projId -> pct
  const [monthlyCost, setMonthlyCost] = useState(0);
  const [costDetail, setCostDetail] = useState<any>(null);   // {monthlyInr, annualUsd}
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const projById = (id: number) => projects.find((p) => p.id === id);

  // load the saved grid whenever employee or FY changes
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/allocations?employeeId=${employee.id}&fiscalYear=${encodeURIComponent(fiscalYear)}`)
      .then((d: any) => {
        if (!alive) return;
        setMonthlyCost(d.monthlyCostUsd || 0);
        const g: Record<string, Record<number, number>> = {};
        const colSet = new Set<number>();
        for (const r of d.rows || []) {
          g[r.month] = g[r.month] || {};
          g[r.month][r.projectId] = r.pct;
          colSet.add(r.projectId);
        }
        setGrid(g);
        setCols([...colSet]);
      })
      .catch((e: any) => alive && show(e.message, "error"))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [employee.id, fiscalYear]);

  // employee cost detail (Monthly CTC in INR + Annual USD) for the header summary
  useEffect(() => {
    let alive = true;
    api.get(`/employees/${employee.id}/cost`).then((c: any) => alive && setCostDetail(c)).catch(() => {});
    return () => { alive = false; };
  }, [employee.id]);

  const setCell = (month: string, projId: number, v: string) => {
    const pct = Math.max(0, Math.min(100, +v || 0));
    setGrid((g) => ({ ...g, [month]: { ...(g[month] || {}), [projId]: pct } }));
  };
  const monthTotal = (month: string) => cols.reduce((s, id) => s + (grid[month]?.[id] || 0), 0);

  const addCol = (id: number) => { if (id && !cols.includes(id)) setCols([...cols, id]); };
  const removeCol = (id: number) => {
    setCols(cols.filter((c) => c !== id));
    setGrid((g) => { const ng = { ...g }; for (const m of FY_MONTHS) if (ng[m]) { const row = { ...ng[m] }; delete row[id]; ng[m] = row; } return ng; });
  };

  // helpers
  const splitEvenly = (month: string) => {
    if (!cols.length) return;
    const each = Math.round((100 / cols.length) * 100) / 100;
    const row: Record<number, number> = {};
    cols.forEach((id, i) => { row[id] = i === cols.length - 1 ? Math.round((100 - each * (cols.length - 1)) * 100) / 100 : each; });
    setGrid((g) => ({ ...g, [month]: row }));
  };
  const copyPrev = (month: string) => {
    const idx = FY_MONTHS.indexOf(month);
    if (idx <= 0) return;
    const prev = FY_MONTHS[idx - 1];
    setGrid((g) => ({ ...g, [month]: { ...(g[prev] || {}) } }));
  };
  const oneTo = (month: string, projId: number) => {
    const row: Record<number, number> = {};
    cols.forEach((id) => { row[id] = id === projId ? 100 : 0; });
    setGrid((g) => ({ ...g, [month]: row }));
  };

  // F14 quick-fill state + actions
  const [yearProj, setYearProj] = useState<string>("");          // project for "100% whole year"
  const [copyMonth, setCopyMonth] = useState<string>("Apr");     // source month for "apply to all"

  // Assign one project 100% across ALL 12 months (clearing the others). Adds the
  // column if it isn't present yet so a single-project employee needs zero grid edits.
  const assignWholeYear = () => {
    const pid = +yearProj;
    if (!pid) return show("Pick a project first", "error");
    const nextCols = cols.includes(pid) ? cols : [...cols, pid];
    setCols(nextCols);
    const g: Record<string, Record<number, number>> = {};
    for (const m of FY_MONTHS) { const row: Record<number, number> = {}; nextCols.forEach((id) => { row[id] = id === pid ? 100 : 0; }); g[m] = row; }
    setGrid(g);
    show(`${projById(pid)?.name || "Project"} set to 100% for all 12 months`);
  };

  // Copy one month's split to every month.
  const applyToAll = () => {
    if (!cols.length) return show("Add project columns first", "error");
    const src = grid[copyMonth] || {};
    const g: Record<string, Record<number, number>> = {};
    for (const m of FY_MONTHS) g[m] = { ...src };
    setGrid(g);
    show(`Copied ${copyMonth}'s split to all months`);
  };

  const save = async () => {
    // validate each non-empty month sums to ~100
    for (const m of FY_MONTHS) {
      const t = monthTotal(m);
      if (t > 0 && Math.abs(t - 100) > 0.5) return show(`${m} totals ${t.toFixed(1)}% — must be 100% or empty`, "error");
    }
    const rows: { month: string; projectId: number; pct: number }[] = [];
    for (const m of FY_MONTHS) for (const id of cols) { const pct = grid[m]?.[id] || 0; if (pct > 0) rows.push({ month: m, projectId: id, pct }); }
    setBusy(true);
    try {
      // 1) save the monthly split; 2) sync project assignment (= the columns) so
      //    timesheets & approvals see the membership; 3) push the split into the
      //    Monthly Forecast cost lines so every dashboard reflects it.
      await api.put("/allocations", { employeeId: employee.id, fiscalYear, rows });
      await api.post(`/employees/${employee.id}/projects`, { projectIds: cols });
      const r = await api.post("/allocations/apply", { employeeId: employee.id, fiscalYear });
      show(`Saved · ${cols.length} project(s) assigned · applied to ${r.applied} cost line(s)` + (r.skippedLocked ? `, ${r.skippedLocked} locked skipped` : ""));
      onSaved?.();
    }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  const available = projects.filter((p) => !cols.includes(p.id));

  return (
    <Modal title={`${employee.name} — Project & Cost`} open onClose={onClose} onSave={save} saveLabel="Save & Apply" busy={busy} wide>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <Input label="Fiscal Year" value={fiscalYear} onChange={(e: any) => setFiscalYear(e.target.value)} placeholder="FY26-27" />
        {costDetail && <div className="kpi" style={{ minWidth: 150 }}><div className="label">Monthly CTC (INR)</div><div className="value" style={{ fontSize: 16 }}>{fmt(costDetail.monthlyInr, "INR")}</div></div>}
        <div className="kpi" style={{ minWidth: 150 }}><div className="label">Annual Cost (USD)</div><div className="value" style={{ fontSize: 16 }}>{fmt(costDetail?.annualUsd ?? monthlyCost * 12)}</div></div>
        <div className="kpi" style={{ minWidth: 150 }}><div className="label">Monthly Cost (USD)</div><div className="value" style={{ fontSize: 16 }}>{fmt(monthlyCost)}</div></div>
        <Select label="Add Project" value="" onChange={(e: any) => addCol(+e.target.value)}
          options={[{ value: "", label: "— add project —" }, ...available.map((p) => ({ value: p.id, label: projectLabel(p) }))]} />
      </div>

      {/* F14 — one-click quick-fill helpers */}
      <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", marginBottom: 14, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 200 }}>
            <label style={{ marginTop: 0 }}>Assign one project 100% — whole year</label>
            <select value={yearProj} onChange={(e) => setYearProj(e.target.value)}>
              <option value="">— pick project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
            </select>
          </div>
          <GhostButton onClick={assignWholeYear}>Set 100% × 12 months</GhostButton>
        </div>
        <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }} />
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 130 }}>
            <label style={{ marginTop: 0 }}>Copy a month's split…</label>
            <select value={copyMonth} onChange={(e) => setCopyMonth(e.target.value)}>
              {FY_MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <GhostButton onClick={applyToAll} disabled={!cols.length}>Apply to all months</GhostButton>
        </div>
      </div>

      {loading ? "Loading…" : !cols.length ? (
        <div style={{ color: "var(--muted)" }}>Add one or more project columns to begin allocating.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Month</th>
                {cols.map((id) => (
                  <th key={id} className="num">
                    {projById(id)?.name || id}
                    <button type="button" className="ghost" style={{ marginLeft: 6 }} onClick={() => removeCol(id)} title="Remove column">×</button>
                  </th>
                ))}
                <th className="num">Total</th>
                <th>Helpers</th>
              </tr>
            </thead>
            <tbody>
              {FY_MONTHS.map((m) => {
                const t = monthTotal(m);
                const ok = t === 0 || Math.abs(t - 100) <= 0.5;
                return (
                  <tr key={m}>
                    <td>{m}</td>
                    {cols.map((id) => (
                      <td key={id} className="num">
                        <input type="number" min={0} max={100} style={{ width: 70 }}
                          value={grid[m]?.[id] ?? ""} onChange={(e) => setCell(m, id, e.target.value)} />
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{fmt(monthlyCost * ((grid[m]?.[id] || 0) / 100))}</div>
                      </td>
                    ))}
                    <td className="num" style={{ fontWeight: 700, color: t === 0 ? "var(--muted)" : ok ? "#16a34a" : "#e5484d" }}>{t.toFixed(0)}%</td>
                    <td>
                      <button type="button" className="ghost" onClick={() => splitEvenly(m)}>Even</button>{" "}
                      <button type="button" className="ghost" onClick={() => copyPrev(m)} disabled={FY_MONTHS.indexOf(m) === 0}>Copy prev</button>{" "}
                      <select value="" onChange={(e) => e.target.value && oneTo(m, +e.target.value)} style={{ width: 90 }}>
                        <option value="">100% to…</option>
                        {cols.map((id) => <option key={id} value={id}>{projById(id)?.name}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="subtitle" style={{ marginTop: 8 }}>
            Each allocated month must total 100% (green); leave a month empty to mark it unallocated. The projects you add here also become this employee's <b>assigned projects</b> (used by timesheets &amp; approvals). <b>Save &amp; Apply</b> writes pct × monthly cost into each month's project cost lines, so the split flows into Monthly Forecast and every dashboard (locked months are skipped).
          </div>
        </div>
      )}
    </Modal>
  );
}

// =====================================================================
// Employees
// =====================================================================
// Employment-type options depend on location: US = Full Time / W2 No-Benefit / Vendor;
// India & Canada = Full Time / Contractor.
const EMP_TYPES: Record<string, { value: string; label: string }[]> = {
  US: [{ value: "FULL_TIME", label: "Full Time" }, { value: "W2_NO_BENEFIT", label: "W2 / No Benefit" }, { value: "VENDOR", label: "Vendor" }, { value: "INTERN", label: "Intern" }],
  INDIA: [{ value: "FULL_TIME", label: "Full Time" }, { value: "CONTRACTOR", label: "Contractor" }, { value: "INTERN", label: "Intern" }],
  CANADA: [{ value: "FULL_TIME", label: "Full Time" }, { value: "CONTRACTOR", label: "Contractor" }, { value: "INTERN", label: "Intern" }],
  OTHER: [{ value: "FULL_TIME", label: "Full Time" }, { value: "CONTRACTOR", label: "Contractor" }, { value: "INTERN", label: "Intern" }],
};
const EMP_TYPE_LABELS: Record<string, string> = { FULL_TIME: "Full Time", CONTRACTOR: "Contractor", VENDOR: "Vendor", W2_NO_BENEFIT: "W2 / No Benefit", INTERN: "Intern" };
const empTypeLabel = (t?: string) => (t ? EMP_TYPE_LABELS[t] || t.replace(/_/g, " ") : "—");
const empTypesFor = (loc: string) => EMP_TYPES[loc] || EMP_TYPES.OTHER;
// Employee Master's CTC column — the latest CtcRecord's ANNUAL figure in its own currency (an
// override for US/vendor engagements, else the INR component total × 12 + annual bonus).
const ctcAnnualFor = (e: any): number | null => {
  const c = e.ctcRecords?.[0];
  if (!c) return null;
  if (c.annualCostOverride != null) return c.annualCostOverride;
  const monthly = (c.basic || 0) + (c.hra || 0) + (c.otherAllowance || 0) + (c.specialAllowance || 0) + (c.conveyance || 0) + (c.communication || 0) + (c.meals || 0) + (c.books || 0) + (c.driver || 0) + (c.uniform || 0);
  return monthly * 12 + (c.bonusAnnual || 0);
};
const ctcMoneyFor = (n: number, ccy: string) => isMasked() ? "•••••" : (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹") + Math.round(n || 0).toLocaleString("en-IN");
export function Employees() {
  const admin = useAdminGate();
  const { user } = useAuth();
  // Forces a re-render on mask toggle — ctcMoneyFor() below reads the shared mask flag directly
  // (isMasked()) but nothing else in this component subscribes to "masknumberschange", so without
  // this the CTC column wouldn't update until something else happened to re-render the page.
  useMaskNumbers(user?.id);
  const isHr = user?.role === "HR";
  const isCto = user?.role === "CTO";
  // Narrower than the general admin gate — this one-shot, no-approval-step, no-FnF-paperwork
  // action (see masters.ts's own comment on this route) is Finance/CTO only; CEO and QA can still
  // do everything else admin can on this page, just not this specific button.
  const canTerminate = user?.role === "FINANCE" || isCto;
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/employees");
  const { data: projects } = useFetch<any[]>("/projects");
  const { data: designations } = useFetch<any[]>("/hr-settings/designations");
  const { data: departments } = useFetch<any[]>("/hr-settings/departments");
  const { data: businessUnits } = useFetch<any[]>("/hr-settings/business-units");
  const activeForManager = (data || []).filter((e: any) => !e.exitDate);
  // firstName/middleName/lastName are a FORM-ONLY convenience (mirrors the Offer form's own
  // candidateFirstName/Middle/Last split) — Employee.name stays the single source of truth in
  // the database; these three are joined into `name` right before every save (see save() below).
  const blank = { id: null, name: "", firstName: "", middleName: "", lastName: "", empNo: "", empType: "FULL_TIME", location: "INDIA", joiningDate: "", email: "", designation: "", department: "", reportingManager: "", emergencyContactName: "", emergencyContactPhone: "", confidential: false, businessUnitId: "", noticePeriod: "2 Months", probationPeriod: "2 Months", workLocation: "Office", phone: "", officialPhone: "", personalEmail: "", gender: "", maritalStatus: "", marriageAnniversary: "", address: "", dateOfBirth: "", city: "", landmark: "", state: "", pincode: "", sameAsPermanent: true, residentAddress: "", residentCity: "", residentLandmark: "", residentState: "", residentPincode: "" };
  // Best-effort split of a single `name` string back into first/middle/last for the edit form's
  // initial fill — a heuristic (first word / last word / anything between), never stored as such;
  // `name` itself remains untouched and authoritative everywhere else in the app.
  const splitName = (n: string) => {
    const parts = (n || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "", middleName: "", lastName: "" };
    if (parts.length === 1) return { firstName: parts[0], middleName: "", lastName: "" };
    return { firstName: parts[0], middleName: parts.slice(1, -1).join(" "), lastName: parts[parts.length - 1] };
  };
  const PERIOD_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: `${n} Month${n > 1 ? "s" : ""}`, label: `${n} Month${n > 1 ? "s" : ""}` }));
  const [form, setForm] = useState<any>(null);  // null = closed
  const [busy, setBusy] = useState(false);
  // HR now requests terminations from the dedicated "Terminate Employee" left-nav page
  // (Hr.tsx's TerminateEmployeePage) instead of a row button here — Finance/CTO/CEO still
  // review the full Terminate form (below) and approve in Termination Approvals.
  const [alloc, setAlloc] = useState<any>(null);  // employee whose Project & Cost grid is open
  const [hrDetail, setHrDetail] = useState<any>(null); // employee whose Offer/Onboarding detail is open
  const [locFilter, setLocFilter] = useState("ALL"); // ALL | INDIA | US | CANADA | OTHER
  const [termForm, setTermForm] = useState<any>(null); // { id, name, exitDate }
  // Same full multi-month Monthly Forecast impact preview Finance's own Termination Approvals
  // queue shows before approving — this direct one-shot button had none at all before, so Finance/
  // CTO using it never saw the downstream cost/revenue/bench impact until after committing.
  const [termPreview, setTermPreview] = useState<any>(null);
  useEffect(() => {
    if (!termForm?.id || !termForm?.exitDate) { setTermPreview(null); return; }
    let cancelled = false;
    api.get(`/employees/${termForm.id}/terminate-preview?exitDate=${termForm.exitDate}`)
      .then((p: any) => { if (!cancelled) setTermPreview(p); })
      .catch(() => { if (!cancelled) setTermPreview(null); });
    return () => { cancelled = true; };
  }, [termForm?.id, termForm?.exitDate]);
  const all = data || [];
  const active = all.filter((e: any) => !e.exitDate);
  const countFor = (loc: string) => active.filter((e: any) => (e.location || "OTHER") === loc).length;
  const rows = locFilter === "ALL" ? active : active.filter((e: any) => (e.location || "OTHER") === locFilter);
  // Termination-month cost calculator: prorate monthly cost by the chosen day basis + full FNF.
  const termCalc = (f: any) => {
    const d = f?.exitDate ? new Date(f.exitDate + "T00:00:00") : null;
    if (!d || isNaN(+d)) return { total: 0, perDay: 0, worked: 0, basisDays: 0, salary: 0 };
    const year = d.getFullYear(), m0 = d.getMonth(), termDay = d.getDate();
    const dim = new Date(year, m0 + 1, 0).getDate();
    // Employee joined THIS SAME MONTH — only count days from their joining date, not from the 1st,
    // or terminating the same month (even the same day) you joined overcounts as a near-full month
    // worked (25 days of basic salary for someone employed exactly 1 day was a real, reported bug).
    // The per-day RATE (basisDays below) still divides by the full month, same as any normal payroll
    // per-diem — only which days count as "worked" changes.
    const jd = f?.joiningDate ? new Date(f.joiningDate + "T00:00:00") : null;
    const sameMonthJoin = !!jd && !isNaN(+jd) && jd.getFullYear() === year && jd.getMonth() === m0;
    const startDay = sameMonthJoin ? jd!.getDate() : 1;
    // Joined and terminated the EXACT same day: zero days worked, not one — explicit business rule
    // (an inclusive day-count would otherwise floor at 1 for this specific case).
    const sameDay = sameMonthJoin && startDay === termDay;
    let wkTotal = 0, wkWorked = 0;
    for (let day = 1; day <= dim; day++) { const dow = new Date(year, m0, day).getDay(); if (dow !== 0 && dow !== 6) { wkTotal++; if (!sameDay && day >= startDay && day <= termDay) wkWorked++; } }
    const basisDays = f.basis === "WORKING" ? wkTotal : dim;
    const worked = f.basis === "WORKING" ? wkWorked : (sameDay ? 0 : Math.max(1, termDay - startDay + 1));
    const perDay = basisDays ? (+f.monthlyCost || 0) / basisDays : 0;
    const salary = perDay * worked;
    return { total: salary + (+f.fnfAmount || 0), perDay, worked, basisDays, salary };
  };
  const openTerminate = async (e: any) => {
    setTermForm({ id: e.id, name: e.name, joiningDate: e.joiningDate ? e.joiningDate.slice(0, 10) : null, exitDate: new Date().toISOString().slice(0, 10), fnfAmount: 0, basis: "WORKING", monthlyCost: 0, monthCost: null, invoiceAmount: null });
    try { const c = await api.get(`/employees/${e.id}/cost`); setTermForm((s: any) => (s && s.id === e.id ? { ...s, monthlyCost: d2((c?.annualUsd || 0) / 12) } : s)); } catch { /* keep 0 */ }
  };
  const saveTerminate = async () => {
    const c = termCalc(termForm);
    const monthCost = termForm.monthCost != null ? +termForm.monthCost : d2(c.total); // override or computed
    setBusy(true);
    const invoiceAmount = termForm.invoiceAmount != null && termForm.invoiceAmount !== "" ? +termForm.invoiceAmount : null;
    try { const r = await api.post(`/employees/${termForm.id}/terminate`, { exitDate: termForm.exitDate, fnfAmount: termForm.fnfAmount, basis: termForm.basis, monthCost, invoiceAmount }); show(`${termForm.name} terminated · ${termForm.exitDate?.slice(8)} day cost ${fmt(r.monthCost || 0)}${r.removedLines ? ` · removed ${r.removedLines} future line(s)` : ""}`); setTermForm(null); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const save = async () => {
    const name = [form.firstName, form.middleName, form.lastName].map((s: string) => (s || "").trim()).filter(Boolean).join(" ");
    if (!name.trim()) return show("First Name and Last Name are required", "error");
    if (!form.empNo?.trim()) return show("Employee Code is required", "error");
    const body = {
      ...form, name,
      // "Same as Permanent Address" mirrors Permanent → Resident right before sending, rather
      // than keeping two copies in sync live — unchecking it later reveals whatever was last
      // explicitly saved there (empty, the first time).
      ...(form.sameAsPermanent ? { residentAddress: form.address, residentCity: form.city, residentLandmark: form.landmark, residentState: form.state, residentPincode: form.pincode } : {}),
    };
    setBusy(true);
    try {
      if (form.id) await api.put(`/employees/${form.id}`, body); else await api.post("/employees", body);
      show(form.id ? "Employee updated" : "Employee added"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (e: any) => {
    if (!(await confirmDialog({ title: `Delete ${e.name}?`, message: "Permanently removes the employee and their CTC, timesheets, rates and allocations, and unlinks their past monthly rows. This cannot be undone.", danger: true, confirmLabel: "Delete" }))) return;
    try { await api.del(`/employees/${e.id}`); show("Employee deleted"); reload(); } catch (er: any) { show(er.message, "error"); }
  };

  return (
    <div>
      <h1>Employee Master</h1><div className="subtitle">Resources — full-time / part-time / contract, on one or many projects.</div>
      <div className="btn-row" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {admin && <AddButton onClick={() => setForm({ ...blank })}>Add Employee</AddButton>}
        <span className="label" style={{ color: "var(--muted)", fontSize: 12 }}>Location:</span>
        <select value={locFilter} onChange={(e) => setLocFilter(e.target.value)} style={{ width: 200 }}>
          <option value="ALL">All ({active.length})</option>
          <option value="INDIA">Offshore — India ({countFor("INDIA")})</option>
          <option value="US">US ({countFor("US")})</option>
          <option value="CANADA">Canada ({countFor("CANADA")})</option>
          <option value="OTHER">Other ({countFor("OTHER")})</option>
        </select>
      </div>
      <Panel>{loading ? "Loading…" : <DataTable rows={rows} searchKeys={(e: any) => `${e.empNo || ""} ${e.name} ${e.empType} ${e.location}`}
        columns={[
          { key: "empNo", label: "Code", value: (e: any) => e.empNo || "", render: (e: any) => e.empNo || "—" },
          { key: "name", label: "Name" }, { key: "empType", label: "Type", value: (e: any) => empTypeLabel(e.empType), render: (e: any) => empTypeLabel(e.empType) }, { key: "location", label: "Location" },
          {
            key: "status", label: "Status", noSort: true,
            // Not yet on Past/Terminated (exitDate is still null — that only happens once Finance
            // finalizes FnF), but no longer genuinely Active either once their Deployment End Date
            // has been approved (cost/project impact already applied, access already cut unless
            // they went to Bench) — every employment type moves to Past/Terminated on the exact
            // same trigger (FnF finalized), this just makes the in-between wait visible.
            render: (e: any) => !e.pendingTermination
              ? <span className="pill" style={{ color: "#34d399", borderColor: "#34d399" }}>Active</span>
              : e.pendingTermination.deactivated
                ? <span className="pill" style={{ color: "#f59e0b", borderColor: "#f59e0b" }} title={`Deactivated ${e.pendingTermination.deploymentEndDate ? "as of " + fmtDate(e.pendingTermination.deploymentEndDate) : ""} — moves to Past / Terminated once FnF is finalized${e.pendingTermination.fnfFinalizationDate ? " (target " + fmtDate(e.pendingTermination.fnfFinalizationDate) + ")" : ""}`}>Deactivated — Pending FnF</span>
                : <span className="pill" style={{ color: "var(--muted)" }} title="HR has requested termination; awaiting Finance's Deployment End Date approval">Termination Requested</span>,
          },
          { key: "projects", label: "Projects", value: (e: any) => e.projects?.map((p: any) => projectLabel(p.project)).join(", "), render: (e: any) => e.projects?.map((p: any) => projectLabel(p.project)).join(", ") || "—" },
          { key: "ctc", label: "CTC", value: (e: any) => ctcAnnualFor(e), render: (e: any) => {
            const c = e.ctcRecords?.[0]; if (!c) return "—";
            const annual = ctcAnnualFor(e); if (annual == null) return "—";
            const native = ctcMoneyFor(annual, c.currency);
            // Show the USD equivalent too (skip when the record is already in USD).
            if (c.currency === "USD" || e.ctcAnnualUsd == null) return native;
            return <span>{native}<br /><span className="subtitle">{ctcMoneyFor(e.ctcAnnualUsd, "USD")} USD</span></span>;
          } },
          {
            key: "onboarding", label: "Offer / Documents", noSort: true,
            render: (e: any) => (
              <button className="ghost" style={{ minHeight: 26, padding: "2px 10px", fontSize: 12 }} onClick={() => setHrDetail(e)}>
                {e.offer ? `${e.offer.offerRef} — View` : "View Documents"}
              </button>
            ),
          },
          ...(!isHr ? [{ key: "alloc", label: "", noSort: true, render: (e: any) => <button className="ghost" onClick={() => setAlloc(e)}>Project &amp; Cost</button> }] : []),
          ...(canTerminate ? [{ key: "term", label: "", noSort: true, render: (e: any) => e.pendingTermination
            ? <span style={{ color: "var(--muted)", fontSize: 12 }} title="Already in the Termination Approvals queue">In progress</span>
            : <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => openTerminate(e)}>Terminate</button> }] : []),
        ]}
        onEdit={(admin || isHr) ? (e) => {
          const sameAsPermanent = !e.residentAddress && !e.residentCity && !e.residentLandmark && !e.residentState && !e.residentPincode;
          setForm({
            id: e.id, name: e.name, ...splitName(e.name), empNo: e.empNo || "", empType: e.empType, location: e.location,
            joiningDate: e.joiningDate?.slice(0, 10) || "", email: e.email || "",
            designation: e.designation || "", department: e.department || "", reportingManager: e.reportingManager || "",
            emergencyContactName: e.emergencyContactName || "", emergencyContactPhone: e.emergencyContactPhone || "",
            confidential: !!e.confidential, businessUnitId: e.businessUnitId || "",
            noticePeriod: e.noticePeriod || "2 Months", probationPeriod: e.probationPeriod || "2 Months", workLocation: e.workLocation || "Office",
            phone: e.phone || "", officialPhone: e.officialPhone || "", personalEmail: e.personalEmail || "",
            gender: e.gender || "", maritalStatus: e.maritalStatus || "", marriageAnniversary: e.marriageAnniversary?.slice(0, 10) || "",
            address: e.address || "", dateOfBirth: e.dateOfBirth?.slice(0, 10) || "",
            city: e.city || "", landmark: e.landmark || "", state: e.state || "", pincode: e.pincode || "",
            sameAsPermanent,
            residentAddress: e.residentAddress || "", residentCity: e.residentCity || "", residentLandmark: e.residentLandmark || "",
            residentState: e.residentState || "", residentPincode: e.residentPincode || "",
          });
        } : undefined}
        onDelete={admin ? del : undefined} />}</Panel>

      <Modal title={`Terminate ${termForm?.name || ""}`} open={!!termForm} onClose={() => setTermForm(null)} onSave={saveTerminate} busy={busy} saveLabel="Terminate" canSave={!!termForm?.exitDate}>
        {termForm && (() => { const c = termCalc(termForm); const finalCost = termForm.monthCost != null ? +termForm.monthCost : d2(c.total); return <div className="form-grid">
          <Input label="Termination Date" required type="date" value={termForm.exitDate} onChange={(e: any) => setTermForm({ ...termForm, exitDate: e.target.value })} />
          <Select label="Day basis" value={termForm.basis} onChange={(e: any) => setTermForm({ ...termForm, basis: e.target.value })}
            options={[{ value: "WORKING", label: "Working days (Mon–Fri)" }, { value: "CALENDAR", label: "All days (incl. Sat/Sun)" }]} />
          <Input label="Monthly Cost (USD)" type="number" value={termForm.monthlyCost} onChange={(e: any) => setTermForm({ ...termForm, monthlyCost: e.target.value })} />
          <Input label="FNF Amount (USD)" type="number" value={termForm.fnfAmount ?? 0} onChange={(e: any) => setTermForm({ ...termForm, fnfAmount: e.target.value })} placeholder="Full & Final settlement" />
          <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
            Per-day cost <b><Masked>${d2(c.perDay)}</Masked></b> (<Masked>${d2(termForm.monthlyCost)}</Masked> ÷ {c.basisDays} {termForm.basis === "WORKING" ? "working" : "calendar"} days) × <b>{c.worked}</b> day(s) worked = salary <b>{fmt(c.salary)}</b> + FNF <b>{fmt(+termForm.fnfAmount || 0)}</b> = <b>{fmt(c.total)}</b>.
          </div>
          <div className="full" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Input label="Termination Month Cost (override)" type="number" value={finalCost} onChange={(e: any) => setTermForm({ ...termForm, monthCost: e.target.value })} /></div>
            <GhostButton onClick={() => setTermForm({ ...termForm, monthCost: null })}>↺ Use computed</GhostButton>
          </div>
          <div className="full" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Input label="Invoice Amount (override, USD)" type="number" value={termForm.invoiceAmount ?? ""} onChange={(e: any) => setTermForm({ ...termForm, invoiceAmount: e.target.value })} placeholder="blank = prorated to the termination date" /></div>
            <GhostButton onClick={() => setTermForm({ ...termForm, invoiceAmount: null })}>↺ Use prorated</GhostButton>
          </div>
          <div className="subtitle full" style={{ margin: 0 }}>This <b>final amount</b> ({fmt(finalCost)}) becomes <b>{termForm.name}</b>'s cost for the termination month in Monthly Forecast &amp; Actuals{termForm.invoiceAmount != null && termForm.invoiceAmount !== "" ? <>, and <b>{fmt(+termForm.invoiceAmount || 0)}</b> overrides their <b>Actual Invoice</b> for that month</> : <>; their Actual Invoice is prorated to the termination date (enter an override above to replace it)</>}. Rows from months <b>after</b> it are removed; locked months are untouched.</div>
          {termPreview?.found && (
            <div className="full">
              {!!termPreview.lines?.length && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                  {termPreview.month}: {termPreview.lines.map((l: any, i: number) => (
                    <span key={i}>{i > 0 && " · "}{l.projectName}: cost {fmt(l.costUsd)}, billing {fmt(l.billingAmount)}, invoice {fmt(l.invoiceAmount)}</span>
                  ))}
                </div>
              )}
              {!!termPreview.futureMonths?.length && (
                <>
                  <div className="note" style={{ marginBottom: 4 }}>
                    Impact on later months — {termPreview.goesToBench
                      ? "these project line(s) move to Bench (cost only, no revenue):"
                      : "these project line(s) are removed entirely:"}
                  </div>
                  <table>
                    <thead><tr><th>Month</th><th>Project(s)</th><th className="num">Lost Billing</th><th className="num">Lost Invoice</th><th className="num">{termPreview.goesToBench ? "Bench Cost" : "Cost Removed"}</th></tr></thead>
                    <tbody>
                      {termPreview.futureMonths.map((m: any, i: number) => (
                        <tr key={i}>
                          <td>{m.month} {m.fiscalYear}</td>
                          <td>{m.lines.join(", ")} <span className="pill">{m.outcome === "bench" ? "moves to Bench" : "removed"}</span></td>
                          <td className="num">{fmt(m.lostBilling)}</td>
                          <td className="num">{fmt(m.lostInvoice)}</td>
                          <td className="num">{fmt(m.outcome === "bench" ? m.benchCostUsd : m.lostCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>; })()}
      </Modal>

      <Modal title={form?.id ? "Edit Employee" : "Add Employee"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy}
        // New employees must come in with the full HR-compliance set. Editing an EXISTING
        // employee only requires Name + Employee Code — matching the server's own intent (PUT
        // /employees/:id never force-requires these) — so a legacy record missing several of
        // them at once (common pre-dating this fields' introduction) can still be edited for
        // anything else without first being made to backfill every gap in one sitting.
        canSave={!!form?.firstName?.trim() && !!form?.lastName?.trim() && !!form?.empNo?.trim() && (!!form?.id || (
          !!form?.personalEmail?.trim() && !!form?.phone?.trim() && !!form?.maritalStatus?.trim() && !!form?.dateOfBirth?.trim()
          && !!form?.designation?.trim() && !!form?.businessUnitId && !!form?.reportingManager?.trim() && !!form?.department?.trim()
          && !!form?.workLocation?.trim() && !!form?.probationPeriod?.trim() && !!form?.noticePeriod?.trim()
          && !!form?.email?.trim() && !!form?.joiningDate?.trim()
          && !!form?.emergencyContactName?.trim() && !!form?.emergencyContactPhone?.trim()
        ))}>
        {form && <div className="form-grid">
          <Input label="Employee Code" required value={form.empNo}
            onChange={(e: any) => setForm({ ...form, empNo: e.target.value })} placeholder="e.g. 1042" />
          <Input label="First Name" required={!form.id} value={form.firstName} onChange={(e: any) => setForm({ ...form, firstName: e.target.value })} placeholder="e.g. Jane" />
          <Input label="Middle Name" value={form.middleName} onChange={(e: any) => setForm({ ...form, middleName: e.target.value })} />
          <Input label="Last Name" required={!form.id} value={form.lastName} onChange={(e: any) => setForm({ ...form, lastName: e.target.value })} placeholder="e.g. Doe" />
          <Select label="Location" value={form.location} disabled={!!form.businessUnitId}
            title={form.businessUnitId ? "Follows the selected Business Unit's own country" : undefined}
            onChange={(e: any) => {
              const loc = e.target.value; const opts = empTypesFor(loc);
              const empType = opts.some((o) => o.value === form.empType) ? form.empType : opts[0].value;
              setForm({ ...form, location: loc, empType });
            }}
            options={["INDIA", "US", "CANADA", "OTHER"].map((v) => ({ value: v, label: v }))} />
          <Select label="Employment Type" value={form.empType} onChange={(e: any) => setForm({ ...form, empType: e.target.value })}
            options={empTypesFor(form.location)} />
          <Select label="Designation" required={!form.id} value={form.designation} onChange={(e: any) => setForm({ ...form, designation: e.target.value })}
            options={[{ value: "", label: "— select —" }, ...(designations || []).map((d: any) => ({ value: d.name, label: d.name }))]} />
          <Select label="Department" required={!form.id} value={form.department} onChange={(e: any) => setForm({ ...form, department: e.target.value })}
            options={[{ value: "", label: "— select —" }, ...(departments || []).map((d: any) => ({ value: d.name, label: d.name }))]} />
          <Select label="Reporting To" required={!form.id} value={form.reportingManager} onChange={(e: any) => setForm({ ...form, reportingManager: e.target.value })}
            options={[{ value: "", label: "— select —" }, ...activeForManager.filter((e: any) => e.id !== form.id).map((e: any) => ({ value: e.name, label: `${e.name}${e.empNo ? ` (${e.empNo})` : ""}` }))]} />
          <Select label="Business Unit" required={!form.id} value={form.businessUnitId} onChange={(e: any) => {
            const buId = e.target.value;
            const selectedBu = (businessUnits || []).find((b: any) => String(b.id) === String(buId));
            if (!selectedBu) { setForm({ ...form, businessUnitId: buId }); return; }
            const loc = selectedBu.countryCode;
            const opts = empTypesFor(loc);
            const empType = opts.some((o) => o.value === form.empType) ? form.empType : opts[0].value;
            setForm({ ...form, businessUnitId: buId, location: loc, empType });
          }}
            options={[{ value: "", label: "— none —" }, ...(businessUnits || []).map((b: any) => ({ value: b.id, label: b.name }))]} />
          <Select label="Work Location" required={!form.id} value={form.workLocation} onChange={(e: any) => setForm({ ...form, workLocation: e.target.value })}
            options={[{ value: "Office", label: "Office" }, { value: "Hybrid", label: "Hybrid" }, { value: "Remote", label: "Remote" }]} />
          <Select label="Probation Period" required={!form.id} value={form.probationPeriod} onChange={(e: any) => setForm({ ...form, probationPeriod: e.target.value })} options={PERIOD_OPTIONS} />
          <Select label="Notice Period" required={!form.id} value={form.noticePeriod} onChange={(e: any) => setForm({ ...form, noticePeriod: e.target.value })} options={PERIOD_OPTIONS} />
          <Input label="Joining Date" required={!form.id} type="date" value={form.joiningDate} onChange={(e: any) => setForm({ ...form, joiningDate: e.target.value })} />
          <Input label="Email" required={!form.id} type="email" value={form.email} onChange={(e: any) => setForm({ ...form, email: e.target.value })} placeholder="official/work email — used for timesheet reminders" />
          <Input label="Personal Email" required={!form.id} type="email" value={form.personalEmail} onChange={(e: any) => setForm({ ...form, personalEmail: e.target.value })} placeholder="distinct from the work Email above" />
          <Input label="Personal Phone" required={!form.id} value={form.phone} onChange={(e: any) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" />
          <Input label="Official Phone" value={form.officialPhone} onChange={(e: any) => setForm({ ...form, officialPhone: e.target.value })} placeholder="Company-issued number, if already assigned" />
          <Select label="Gender" value={form.gender} onChange={(e: any) => setForm({ ...form, gender: e.target.value })}
            options={[{ value: "", label: "— select —" }, { value: "Male", label: "Male" }, { value: "Female", label: "Female" }, { value: "Other", label: "Other" }]} />
          <Select label="Marital Status" required={!form.id} value={form.maritalStatus} onChange={(e: any) => setForm({ ...form, maritalStatus: e.target.value })}
            options={[{ value: "", label: "— select —" }, { value: "Single", label: "Single" }, { value: "Married", label: "Married" }, { value: "Other", label: "Other" }]} />
          <Input label="Date of Birth" required={!form.id} type="date" value={form.dateOfBirth} onChange={(e: any) => setForm({ ...form, dateOfBirth: e.target.value })} />
          <Input label="Marriage Anniversary" type="date" value={form.marriageAnniversary} onChange={(e: any) => setForm({ ...form, marriageAnniversary: e.target.value })} />
          <Input label="Emergency Contact Name" required={!form.id} value={form.emergencyContactName} onChange={(e: any) => setForm({ ...form, emergencyContactName: e.target.value })} />
          <Input label="Emergency Contact Number" required={!form.id} value={form.emergencyContactPhone} onChange={(e: any) => setForm({ ...form, emergencyContactPhone: e.target.value })} placeholder="e.g. +91 98765 43210" />
          <div className="full" style={{ fontWeight: 600, marginTop: 8 }}>Permanent Address</div>
          <Input label="Address Line" full value={form.address} onChange={(e: any) => setForm({ ...form, address: e.target.value })} placeholder="House / street / area" />
          <Input label="City" value={form.city} onChange={(e: any) => setForm({ ...form, city: e.target.value })} />
          <Input label="Nearby Landmark" value={form.landmark} onChange={(e: any) => setForm({ ...form, landmark: e.target.value })} />
          <Input label="State" value={form.state} onChange={(e: any) => setForm({ ...form, state: e.target.value })} />
          <Input label="Pincode" value={form.pincode} onChange={(e: any) => setForm({ ...form, pincode: e.target.value })} />
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <input type="checkbox" checked={!!form.sameAsPermanent} onChange={(e) => setForm({ ...form, sameAsPermanent: e.target.checked })} />
            Resident Address (current/where equipment ships) is the same as Permanent Address
          </label>
          {!form.sameAsPermanent && (<>
            <div className="full" style={{ fontWeight: 600, marginTop: 8 }}>Resident Address</div>
            <Input label="Address Line" full value={form.residentAddress} onChange={(e: any) => setForm({ ...form, residentAddress: e.target.value })} placeholder="House / street / area" />
            <Input label="City" value={form.residentCity} onChange={(e: any) => setForm({ ...form, residentCity: e.target.value })} />
            <Input label="Nearby Landmark" value={form.residentLandmark} onChange={(e: any) => setForm({ ...form, residentLandmark: e.target.value })} />
            <Input label="State" value={form.residentState} onChange={(e: any) => setForm({ ...form, residentState: e.target.value })} />
            <Input label="Pincode" value={form.residentPincode} onChange={(e: any) => setForm({ ...form, residentPincode: e.target.value })} />
          </>)}
          {isCto && (
            <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Hides this employee entirely from HR — only CEO/CTO/Finance can see them">
              <input type="checkbox" checked={!!form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} />
              Confidential (hidden from HR — visible only to CEO/CTO/Finance)
            </label>
          )}
        </div>}
      </Modal>

      {alloc && <AllocationGrid employee={alloc} projects={projects || []} onClose={() => setAlloc(null)} onSaved={reload} />}

      <Modal title={hrDetail ? `Offer & Onboarding — ${hrDetail.name}` : ""} open={!!hrDetail} onClose={() => setHrDetail(null)}>
        {hrDetail?.offer && (
          <div>
            <table><tbody>
              <tr><td>Offer Ref</td><td className="num">{hrDetail.offer.offerRef}</td></tr>
              <tr><td>Role</td><td className="num">{hrDetail.offer.role}</td></tr>
              <tr><td>Designation</td><td className="num">{hrDetail.offer.designation}</td></tr>
              <tr><td>Business Unit</td><td className="num">{hrDetail.offer.businessUnit?.name || "—"}</td></tr>
              <tr><td>CTC</td><td className="num">{fmt(hrDetail.offer.ctc, "INR")}</td></tr>
              <tr><td>Offer Date</td><td className="num">{hrDetail.offer.offerDate ? fmtDate(hrDetail.offer.offerDate) : "—"}</td></tr>
              <tr><td>Accepted</td><td className="num">{hrDetail.offer.acceptedAt ? fmtDate(hrDetail.offer.acceptedAt) : "—"}</td></tr>
              <tr><td>Offer Status</td><td className="num">{hrDetail.offer.status}</td></tr>
              <tr><td>Appointment Letter</td><td className="num">{hrDetail.offer.appointmentLetter?.status || "Not yet generated"}</td></tr>
              <tr><td>Appointment Issued</td><td className="num">{hrDetail.offer.appointmentLetter?.issuedAt ? fmtDate(hrDetail.offer.appointmentLetter.issuedAt) : "—"}</td></tr>
            </tbody></table>
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button className="ghost" onClick={() => window.open(api.pdfUrl(`/hr/offers/${hrDetail.offer.id}/pdf`), "_blank")}>View Offer Letter (PDF)</button>
              {hrDetail.offer.appointmentLetter && (
                <button className="ghost" onClick={() => window.open(api.pdfUrl(`/hr/offers/${hrDetail.offer.id}/appointment/pdf`), "_blank")}>View Appointment Letter (PDF)</button>
              )}
              <Link to={`/hr/offers/${hrDetail.offer.id}`}><button className="ghost">Open Full Offer Timeline &amp; Audit Trail →</button></Link>
            </div>
          </div>
        )}
        {hrDetail && <SignedDocumentsPanel employeeId={hrDetail.id} />}
        {hrDetail?.offer && <ManualSignedDocumentsPanel offer={hrDetail.offer} />}
        {hrDetail?.offer && <CandidateDocumentsPanel offerId={hrDetail.offer.id} />}
        {hrDetail && <EmployeeDocumentsPanel employeeId={hrDetail.id} />}
        {hrDetail && <GeneratedDocumentsPanel employeeId={hrDetail.id} />}
      </Modal>
    </div>
  );
}

// Relieving & Experience Certificate — generate (one action, pre-filled from the employee's own
// exit data), edit any field, preview the PDF, and send it to whatever email HR chooses (often the
// employee's PERSONAL email, since their GenAquarius account may already be deactivated). Once
// sent it's locked; re-rendering the PDF any time afterward IS how it stays "in Employee Master's
// document records" — no separate upload/storage step.
const dstr10 = (d: any) => (d ? String(d).slice(0, 10) : "");
export function RelievingLetterPanel({ employee }: { employee: any }) {
  const { data: letters, reload } = useFetch<any[]>(`/relieving-letters/employee/${employee.id}`, [employee.id]);
  const { show } = useToast();
  const [form, setForm] = useState<any>(null); // null = not generating/editing; object = form open
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [busy, setBusy] = useState(false);

  const startGenerate = () => {
    setForm({
      id: null, subject: "Relieving & Experience Certificate", date: dstr10(new Date().toISOString()),
      designation: employee.designation || "", department: employee.department || "", empNo: employee.empNo || "",
      joiningDate: dstr10(employee.joiningDate), lastWorkingDate: dstr10(employee.exitDate),
      relievedDate: dstr10(employee.exitDate ? new Date(new Date(employee.exitDate).getTime() + 86400000).toISOString() : ""),
      resignationDate: "",
    });
  };
  const startEdit = (l: any) => {
    setForm({
      id: l.id, subject: l.subject, date: dstr10(l.date), designation: l.designation || "", department: l.department || "", empNo: l.empNo || "",
      joiningDate: dstr10(l.joiningDate), lastWorkingDate: dstr10(l.lastWorkingDate), relievedDate: dstr10(l.relievedDate), resignationDate: dstr10(l.resignationDate),
    });
  };
  const save = async () => {
    setBusy(true);
    try {
      if (form.id) await api.put(`/relieving-letters/${form.id}`, form);
      else await api.post("/relieving-letters", { ...form, employeeId: employee.id });
      show(form.id ? "Relieving letter updated" : "Relieving letter generated");
      setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (l: any) => {
    if (!(await confirmDialog({ title: "Delete this relieving letter?", danger: true, confirmLabel: "Delete" }))) return;
    try { await api.del(`/relieving-letters/${l.id}`); show("Deleted"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  const openSend = (l: any) => { setSendingId(l.id); setSendTo(employee.offer?.candidateEmail || employee.email || ""); };
  const sendEmail = async () => {
    if (!sendTo.trim()) return show("Enter a recipient email", "error");
    setBusy(true);
    try {
      await api.post(`/relieving-letters/${sendingId}/send`, { to: sendTo.trim() });
      show(`Sent to ${sendTo.trim()}`);
      setSendingId(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  // Live PDF preview while generating/editing — same Advanced-Builder pattern as HR Settings'
  // template editor, but against this REAL employee + whatever's currently typed, not yet saved.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSeq = React.useRef(0);
  useEffect(() => {
    if (!form) { if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); } return; }
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const blob = await api.postBlob("/relieving-letters/preview-pdf", { ...form, employeeId: employee.id });
        if (seq === previewSeq.current) setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === previewSeq.current) setPreviewBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [form, employee.id]);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>Relieving &amp; Experience Letter</div>
        {!form && <AddButton onClick={startGenerate}>Generate Relieving Letter</AddButton>}
      </div>
      {(letters || []).length > 0 && !form && (
        <table style={{ marginBottom: 8 }}>
          <thead><tr><th>Subject</th><th>Date</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {(letters || []).map((l: any) => (
              <tr key={l.id}>
                <td>{l.subject}</td>
                <td>{fmtDate(l.date)}</td>
                <td><span className={`pill ${l.status === "SENT" ? "good" : "accent"}`}>{l.status === "SENT" ? `Sent to ${l.sentTo}` : "Generated"}</span></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => window.open(api.pdfUrl(`/relieving-letters/${l.id}/pdf`), "_blank")}>View PDF</button>{" "}
                  {l.status !== "SENT" && <>
                    <button className="ghost" onClick={() => startEdit(l)}>Edit</button>{" "}
                    <button className="ghost" onClick={() => openSend(l)}>Send Email</button>{" "}
                    <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => del(l)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sendingId != null && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
          <Input label="Send to (often the employee's personal email)" value={sendTo} onChange={(e: any) => setSendTo(e.target.value)} style={{ flex: 1 }} />
          <AddButton disabled={busy} onClick={sendEmail}>Send</AddButton>
          <GhostButton disabled={busy} onClick={() => setSendingId(null)}>Cancel</GhostButton>
        </div>
      )}
      {form && (
        <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <span className="subtitle" style={{ margin: 0 }}>{previewBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: "1 1 50%", minWidth: 0 }}>
              <div className="form-grid">
                <Input label="Subject" full value={form.subject} onChange={(e: any) => setForm({ ...form, subject: e.target.value })} />
                <Input label="Date" type="date" value={form.date} onChange={(e: any) => setForm({ ...form, date: e.target.value })} />
                <Input label="Employee Id" value={form.empNo} onChange={(e: any) => setForm({ ...form, empNo: e.target.value })} />
                <Input label="Designation" value={form.designation} onChange={(e: any) => setForm({ ...form, designation: e.target.value })} />
                <Input label="Department" value={form.department} onChange={(e: any) => setForm({ ...form, department: e.target.value })} />
                <Input label="Joining Date" type="date" value={form.joiningDate} onChange={(e: any) => setForm({ ...form, joiningDate: e.target.value })} />
                <Input label="Last Working Date" type="date" value={form.lastWorkingDate} onChange={(e: any) => setForm({ ...form, lastWorkingDate: e.target.value })} />
                <Input label="Relieved Effective Date" type="date" value={form.relievedDate} onChange={(e: any) => setForm({ ...form, relievedDate: e.target.value })} />
                <Input label="Resignation Date" type="date" value={form.resignationDate} onChange={(e: any) => setForm({ ...form, resignationDate: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <AddButton disabled={busy} onClick={save}>{form.id ? "Save Changes" : "Generate"}</AddButton>
                <GhostButton disabled={busy} onClick={() => setForm(null)}>Cancel</GhostButton>
              </div>
            </div>
            <div style={{ flex: "1 1 50%", minWidth: 0, display: "flex", flexDirection: "column" }}>
              {previewUrl ? <iframe title="Relieving letter preview" src={previewUrl} style={{ flex: 1, minHeight: 480, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, minHeight: 480, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      )}
      {!(letters || []).length && !form && <div className="subtitle" style={{ marginTop: 0 }}>No relieving letter generated yet.</div>}
    </div>
  );
}

// ---------------- Relieving Letter (own nav item — HR) — every terminated employee whose FnF is
// done (an APPROVED termination request), with Generate/Edit/Preview/Send moved here from Past /
// Terminated Employees per explicit request, instead of being buried in that page's detail modal.
export function RelievingLetters() {
  const { data: employees } = useFetch<any[]>("/employees");
  // Ids-only endpoint (not the full /termination-approvals?status=APPROVED, which is Finance/CTO/
  // CEO-only and carries financial detail HR shouldn't see) — HR can hit this one specifically to
  // know which terminated employees have their FnF finalized.
  const { data: fnfDoneEmployeeIds } = useFetch<number[]>("/termination-approvals/fnf-done-employee-ids");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const fnfDoneIds = new Set(fnfDoneEmployeeIds || []);
  const eligible = (employees || []).filter((e: any) => e.exitDate && fnfDoneIds.has(e.id))
    .filter((e: any) => !q.trim() || `${e.name} ${e.empNo || ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const selected = eligible.find((e: any) => e.id === selectedId) || eligible[0] || null;

  return (
    <div>
      <h1>Relieving Letter</h1>
      <div className="subtitle">Every terminated employee whose FnF Settlement is finalized — generate, edit, preview and send their Relieving &amp; Experience Certificate.</div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginTop: 12 }}>
        <div style={{ flex: "0 0 300px", minWidth: 0 }}>
        <Panel title={`Eligible (${eligible.length})`}>
          <input placeholder="🔍 Search by name or employee id…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
          {eligible.length === 0 && <div style={{ color: "var(--muted)" }}>{q.trim() ? "No matching employee." : "No terminated employee with FnF finalized yet."}</div>}
          {eligible.length > 0 && (
            <table><thead><tr><th>Name</th><th>Employee Id</th><th>Date</th></tr></thead><tbody>
              {eligible.map((e: any) => (
                <tr key={e.id} style={{ cursor: "pointer", background: selected?.id === e.id ? "var(--panel2)" : undefined }} onClick={() => setSelectedId(e.id)}>
                  <td>{e.name}</td>
                  <td style={{ color: "var(--muted)" }}>{e.empNo}</td>
                  <td>{e.exitDate ? fmtDate(e.exitDate) : "—"}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Panel>
        </div>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        {selected ? (
          <Panel title={`${selected.name} (${selected.empNo || "—"})`}>
            <RelievingLetterPanel employee={selected} />
          </Panel>
        ) : (
          <Panel title="Relieving Letter"><div style={{ color: "var(--muted)" }}>Select an employee on the left.</div></Panel>
        )}
        </div>
      </div>
    </div>
  );
}

// ---------------- Past / Terminated Employees (own nav item — Finance/HR/CTO) ----------------
export function PastEmployees() {
  const admin = useAdminGate();
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/employees");
  const [detail, setDetail] = useState<any>(null); // employee whose lifecycle detail is open
  const [lifecycle, setLifecycle] = useState<any>(null);
  const [loadingLifecycle, setLoadingLifecycle] = useState(false);
  const [q, setQ] = useState("");
  const terminated = (data || []).filter((e: any) => e.exitDate)
    .filter((e: any) => !q.trim() || `${e.name} ${e.empNo || ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  // Finance Send/Resend FnF Settlement — reuses the same POST .../fnf-settlement/send endpoint
  // FNF Pending's own just-approved panel calls, reachable here any time afterward too.
  const [sendingFnf, setSendingFnf] = useState(false);
  const [fnfSendTo, setFnfSendTo] = useState("");
  const [fnfBusy, setFnfBusy] = useState(false);

  const openDetail = async (e: any) => {
    setDetail(e); setLifecycle(null); setLoadingLifecycle(true); setSendingFnf(false);
    try { setLifecycle(await api.get(`/employees/${e.id}/lifecycle`)); } catch (er: any) { show(er.message, "error"); } finally { setLoadingLifecycle(false); }
  };
  const sendFnf = async () => {
    if (!fnfSendTo.trim()) return show("Enter a recipient email", "error");
    setFnfBusy(true);
    try {
      await api.post(`/termination-approvals/${lifecycle.terminationRequestId}/fnf-settlement/send`, { email: fnfSendTo.trim() });
      show(`FnF Settlement sent to ${fnfSendTo.trim()}`);
      setSendingFnf(false);
    } catch (er: any) { show(er.message, "error"); } finally { setFnfBusy(false); }
  };
  const reinstate = async (e: any) => {
    if (!(await confirmDialog({ title: `Reinstate ${e.name}?`, message: "They return to the active employee list.", confirmLabel: "Reinstate" }))) return;
    try { await api.post(`/employees/${e.id}/reinstate`); show(`${e.name} reinstated`); reload(); } catch (er: any) { show(er.message, "error"); }
  };
  const del = async (e: any) => {
    if (!(await confirmDialog({ title: `Delete ${e.name}?`, message: "Permanently removes the employee and their CTC, timesheets, rates and allocations, and unlinks their past monthly rows. This cannot be undone.", danger: true, confirmLabel: "Delete" }))) return;
    try { await api.del(`/employees/${e.id}`); show("Employee deleted"); reload(); } catch (er: any) { show(er.message, "error"); }
  };

  return (
    <div>
      <h1>Past / Terminated Employees</h1>
      <div className="subtitle">Kept for reference only — excluded from all headcount, billable / non-billable, and the bench. Click a row for their full lifecycle summary.</div>
      <input placeholder="🔍 Search by name or employee id…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280, margin: "8px 0" }} />
      <Panel>{loading ? "Loading…" : (
        <table>
          <thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Joining Date</th><th>Exit Date</th>{admin && <th></th>}</tr></thead>
          <tbody>
            {terminated.length === 0 && <tr><td colSpan={admin ? 6 : 5} style={{ color: "var(--muted)" }}>{q.trim() ? "No matching past employees." : "No past employees."}</td></tr>}
            {terminated.map((e: any) => (
              <tr key={e.id} style={{ cursor: "pointer" }} onClick={() => openDetail(e)}>
                <td>{e.name}</td><td>{e.location}</td><td>{empTypeLabel(e.empType)}</td>
                <td>{e.joiningDate ? fmtDate(e.joiningDate) : "—"}</td>
                <td>{e.exitDate ? fmtDate(e.exitDate) : "—"}</td>
                {admin && <td style={{ whiteSpace: "nowrap" }} onClick={(ev) => ev.stopPropagation()}>
                  <button className="ghost" onClick={() => reinstate(e)}>Reinstate</button>{" "}
                  <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => del(e)}>Delete</button>
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}</Panel>

      <Modal title={detail ? `Lifecycle — ${detail.name}` : ""} open={!!detail} onClose={() => setDetail(null)}>
        {loadingLifecycle ? "Loading…" : lifecycle && (
          <table><tbody>
            <tr><td>Joining Date</td><td className="num">{lifecycle.joiningDate ? fmtDate(lifecycle.joiningDate) : "—"}</td></tr>
            <tr><td>Resignation Date</td><td className="num">{lifecycle.resignationDate ? fmtDate(lifecycle.resignationDate) : "—"}</td></tr>
            <tr><td>Deployment End Date</td><td className="num">{lifecycle.deploymentEndDate ? fmtDate(lifecycle.deploymentEndDate) : "—"}</td></tr>
            <tr><td>Termination Date</td><td className="num">{lifecycle.exitDate ? fmtDate(lifecycle.exitDate) : "—"}</td></tr>
            <tr><td>Projects Deployed</td><td className="num">{lifecycle.projects.length ? lifecycle.projects.join(", ") : "—"}</td></tr>
            <tr><td>Total Revenue Generated</td><td className="num">{fmt(lifecycle.totalRevenue)}</td></tr>
            <tr><td>Total Expense (Cost) Incurred</td><td className="num">{fmt(lifecycle.totalCost)}</td></tr>
            <tr><td>Net Margin</td><td className="num">{fmt(lifecycle.totalRevenue - lifecycle.totalCost)}</td></tr>
          </tbody></table>
        )}
        {lifecycle?.hasFnfDocument && (
          <div style={{ marginTop: 12 }}>
            <button className="ghost" onClick={() => window.open(api.pdfUrl(`/employees/${detail.id}/fnf-document.pdf`), "_blank")}>Download FNF Settlement Document</button>
            {lifecycle?.hasFnfSettlementDocx && (
              <button className="ghost" style={{ marginLeft: 8 }} onClick={() => window.open(api.pdfUrl(`/employees/${detail.id}/fnf-settlement.docx`), "_blank")}>Download FnF Settlement (.docx)</button>
            )}
            {lifecycle?.terminationRequestId && !sendingFnf && (
              <button className="ghost" style={{ marginLeft: 8 }} onClick={() => { setSendingFnf(true); setFnfSendTo(detail.email || ""); }}>Send / Resend FnF Settlement</button>
            )}
            {sendingFnf && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
                <Input label="Send to" value={fnfSendTo} onChange={(e: any) => setFnfSendTo(e.target.value)} style={{ flex: 1 }} />
                <AddButton disabled={fnfBusy} onClick={sendFnf}>Send</AddButton>
                <GhostButton disabled={fnfBusy} onClick={() => setSendingFnf(false)}>Cancel</GhostButton>
              </div>
            )}
          </div>
        )}
        {/* Every document submitted across the employee's whole lifecycle — onboarding (Offer/
            Appointment Letter, e-signed copies, candidate-submitted ID/education proofs) and
            offboarding (FnF Settlement above) — same panels the active Employee Master's own
            "Offer & Onboarding" view uses, so nothing about a person disappears once they're
            terminated. `detail` already carries `.offer` from the same /employees list fetch. */}
        {detail?.offer && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Onboarding Documents</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <button className="ghost" onClick={() => window.open(api.pdfUrl(`/hr/offers/${detail.offer.id}/pdf`), "_blank")}>View Offer Letter (PDF)</button>
              {detail.offer.appointmentLetter && (
                <button className="ghost" onClick={() => window.open(api.pdfUrl(`/hr/offers/${detail.offer.id}/appointment/pdf`), "_blank")}>View Appointment Letter (PDF)</button>
              )}
            </div>
          </div>
        )}
        {detail && <SignedDocumentsPanel employeeId={detail.id} />}
        {detail?.offer && <ManualSignedDocumentsPanel offer={detail.offer} />}
        {detail?.offer && <CandidateDocumentsPanel offerId={detail.offer.id} />}
        {detail && <EmployeeDocumentsPanel employeeId={detail.id} />}
        {detail && <GeneratedDocumentsPanel employeeId={detail.id} />}
      </Modal>
    </div>
  );
}

const DOC_STATUS_CLASS: Record<string, string> = { PENDING: "", SUBMITTED: "accent", APPROVED: "good", REJECTED: "bad" };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Signed copies of the Offer / Appointment Letter / Service Agreement, once the candidate has
// e-signed (or declined) via Adobe Sign — pulled from the employee's own Offer record so this
// shows up here the moment reconcileAgreement() marks any of the three SIGNED/DECLINED, no matter
// which of the three documents it was. Updates live via Socket.IO while this modal is open.
function SignedDocumentsPanel({ employeeId }: { employeeId: number }) {
  const { data, reload } = useFetch<any[]>(`/employees/${employeeId}/esign-documents`);
  useEffect(() => watchRoom("esign:activity", "esign:activity", reload), [employeeId]);
  if (!data || data.length === 0) return null;
  const label: Record<string, string> = { OFFER: "Offer Letter", APPOINTMENT_LETTER: "Appointment Letter", SERVICE_AGREEMENT: "Service Agreement" };
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Signed Documents (Adobe Sign)</div>
      <table><tbody>
        {data.map((a: any) => (
          <tr key={a.id}>
            <td>{label[a.docType] || a.docType}</td>
            <td className="num">{ESIGN_STATUS_LABEL[a.status] || a.status}</td>
            <td className="num">{a.signedAt ? fmtDate(a.signedAt) : "—"}</td>
            <td className="num">
              {a.status === "SIGNED" && (
                <button className="ghost" onClick={() => window.open(api.pdfUrl(`/adobe-sign/signed/${a.docType}/${a.docId}`), "_blank")}>Preview</button>
              )}
            </td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

// HR's manually-uploaded signed copies (paper signature, etc.) for Offer/Appointment/Service
// Agreement — separate from SignedDocumentsPanel above, which only shows Adobe Sign's own signed
// documents. Same upload/view/delete mechanism as the Offer Detail wizard's own Confirm
// Acceptance panels — this is just a shortcut to it from the employee record directly, using the
// exact same routes, so it's never a second source of truth for the same file.
function ManualSignedDocumentsPanel({ offer }: { offer: any }) {
  const { show } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const contractor = offer.employmentType === "CONTRACTOR" || offer.employmentType === "INTERN";
  const slots: { label: string; path: string; fileName: string | null; accepted: boolean }[] = contractor
    ? [{ label: offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement", path: "service-agreement/signed", fileName: offer.serviceAgreement?.signedFileName || null, accepted: offer.serviceAgreement?.status === "ACCEPTED" }]
    : [
        { label: "Offer Letter", path: "signed-offer", fileName: offer.signedOfferFileName || null, accepted: !["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status) },
        ...(offer.appointmentLetter ? [{ label: "Appointment Letter", path: "appointment/signed", fileName: offer.appointmentLetter?.signedFileName || null, accepted: offer.appointmentLetter?.status === "ACCEPTED" }] : []),
      ];
  const upload = async (path: string, file: File) => {
    setBusy(path);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/hr/offers/${offer.id}/${path}`, { fileName: file.name, fileData });
      show("Signed document uploaded"); window.location.reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(null); }
  };
  const del = async (path: string) => {
    if (!window.confirm("Remove the uploaded signed document?")) return;
    setBusy(path);
    try { await api.del(`/hr/offers/${offer.id}/${path}`); show("Removed"); window.location.reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(null); }
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Signed Documents (Manual Upload)</div>
      <table><tbody>
        {slots.map((s) => (
          <tr key={s.path}>
            <td>{s.label}</td>
            <td className="num">{s.fileName || <span style={{ color: "var(--muted)" }}>Not uploaded</span>}</td>
            <td className="num" style={{ whiteSpace: "nowrap" }}>
              {s.fileName && <button className="ghost" onClick={() => window.open(api.pdfUrl(`/hr/offers/${offer.id}/${s.path}`), "_blank")}>View</button>}
              {s.fileName && !s.accepted && <button className="ghost" disabled={busy === s.path} onClick={() => del(s.path)}>Remove</button>}
              <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                {busy === s.path ? "Uploading…" : s.fileName ? "Replace" : "Upload"}
                <input type="file" style={{ display: "none" }} disabled={busy === s.path}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(s.path, f); e.target.value = ""; }} />
              </label>
            </td>
          </tr>
        ))}
      </tbody></table>
      <div className="note">Uploading a signed copy here works the same as on the Offer's own timeline — a document already signed outside this app.</div>
    </div>
  );
}

// Every document HR has (or should have) on file for one employee — Offer/Appointment/Service
// Agreement plus the full joining-document checklist — with upload and preview in one place.
// Shown inside the "Offer & Onboarding" modal above for EVERY employee, not just those onboarded
// through the newer HR Offer flow, since this is also how HR backfills documents for anyone
// imported before that flow existed.
export function EmployeeDocumentsPanel({ employeeId }: { employeeId: number }) {
  const { data, reload } = useFetch<any[]>(`/ess/onboarding-docs/employee/${employeeId}`);
  const { show } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  const upload = async (docTypeId: number, file: File) => {
    setBusyId(docTypeId);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/ess/onboarding-docs/employee/${employeeId}/${docTypeId}`, { fileName: file.name, fileData });
      show("Document uploaded"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusyId(null); }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Documents</div>
      <table><thead><tr><th>Document</th><th>File</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {(data || []).length === 0 && <tr><td colSpan={4} style={{ color: "var(--muted)" }}>Loading…</td></tr>}
          {(data || []).map((d) => (
            <tr key={d.docTypeId}>
              <td>{d.docType.name}{d.docType.required && <span className="pill" style={{ marginLeft: 6, fontSize: 10 }}>Required</span>}</td>
              <td>{d.fileName ? <a href={`/api/ess/onboarding-docs/${d.id}/file`} target="_blank" rel="noreferrer">{d.fileName}</a> : "—"}</td>
              <td><span className={`pill ${DOC_STATUS_CLASS[d.status] || ""}`}>{d.status}</span></td>
              <td>
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                  {busyId === d.docTypeId ? "Uploading…" : d.fileName ? "Replace" : "Upload"}
                  <input type="file" style={{ display: "none" }} disabled={busyId === d.docTypeId}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(d.docTypeId, f); e.target.value = ""; }} />
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note">Uploading here (as HR) marks the document Approved immediately — this is for attaching what HR already has on file, separate from the employee's own self-service submission and review queue.</div>
    </div>
  );
}

// Every SYSTEM-GENERATED document for this employee — SLA/Appointment Letter, every Appraisal
// letter ever issued, FnF Settlement, Relieving Letter — in one place. Distinct from
// SignedDocumentsPanel (Adobe Sign STATUS tracking) and EmployeeDocumentsPanel (self-uploaded
// onboarding docs like ID proof) above — this is "has the system generated this letter, and can
// I open it right now," not a workflow status or an upload.
export function GeneratedDocumentsPanel({ employeeId }: { employeeId: number }) {
  const { data } = useFetch<{ label: string; url: string; generatedAt: string | null }[]>(`/employees/${employeeId}/generated-documents`);
  if (!data || data.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Generated Documents</div>
      <table><thead><tr><th>Document</th><th>Date</th><th></th></tr></thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <td>{d.label}</td>
              <td style={{ color: "var(--muted)" }}>{d.generatedAt ? fmtDate(d.generatedAt) : "—"}</td>
              <td><button type="button" className="ghost" onClick={() => window.open(api.pdfUrl(d.url), "_blank")}>View</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Generic supporting-document list (MSA/SOW/any file) — shared by the Client and Project edit
// modals via the /clients/:id/attachments and /projects/:id/attachments routes (same Attachment
// table server-side, keyed by entityType). Upload/view/delete — no approval workflow needed here.
function AttachmentsPanel({ basePath, entityId }: { basePath: "clients" | "projects"; entityId: number }) {
  const { data, reload } = useFetch<any[]>(`/${basePath}/${entityId}/attachments`);
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/${basePath}/${entityId}/attachments`, { fileName: file.name, fileData });
      show("Document uploaded"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (id: number, name: string) => {
    if (!(await confirmDel(name))) return;
    try { await api.del(`/attachments/${id}`); show("Document deleted"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div className="full" style={{ marginTop: 8 }}>
      <label>Supporting Documents (MSA, SOW, etc.)</label>
      <table><tbody>
        {(data || []).length === 0 && <tr><td style={{ color: "var(--muted)" }}>No documents uploaded yet.</td></tr>}
        {(data || []).map((a: any) => (
          <tr key={a.id}>
            <td><a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer">{a.fileName}</a></td>
            <td style={{ color: "var(--muted)", fontSize: 12 }}>{fmtDate(a.uploadedAt)}</td>
            <td><button type="button" className="ghost" onClick={() => del(a.id, a.fileName)}>Delete</button></td>
          </tr>
        ))}
      </tbody></table>
      <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px", marginTop: 6 }}>
        {busy ? "Uploading…" : "Upload Document"}
        <input type="file" style={{ display: "none" }} disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
      </label>
    </div>
  );
}

// A lightweight, named child of a Project holding exactly the fields that vary per resource/
// cost-center within it (PO Number, Code, Customer Ref No, Title/Description) — see the server
// model's own schema comment. Lets a client like Vancity (Onsite/Offshore, each with several
// resources) manage per-resource invoice identity WITHOUT a separate fake Project per person.
// Two modes: pass `projectId` for an EXISTING Project (every change is an immediate API call,
// same as before) — or pass `draftRows`/`onDraftChange` for a Project still being CREATED (no
// projectId exists yet, so Sub-Projects are held as a plain local array and only actually get
// created, in one batch, right after the new Project itself is saved — see Projects()'s own save()).
function SubProjectsPanel({ projectId, draftRows, onDraftChange }: { projectId?: number; draftRows?: any[]; onDraftChange?: (rows: any[]) => void }) {
  const isDraft = !projectId;
  const fetched = useFetch<any[]>(isDraft ? "" : `/projects/${projectId}/sub-projects`);
  const data = isDraft ? (draftRows || []) : fetched.data;
  const reload = isDraft ? (() => {}) : fetched.reload;
  const { show } = useToast();
  const blank = { name: "", code: "", poNumber: "", customerRefNo: "", title: "", attentionContact: "", description: "", status: "ACTIVE" };
  const [draft, setDraft] = useState<any>(blank);
  const [adding, setAdding] = useState(false);
  // Identifies which row is being edited — the row's real id when persisted, or its array index
  // (negative-offset to never collide with a real id) when still a local draft row.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editRow, setEditRow] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const DRAFT_KEY_BASE = -1000000; // comfortably below any real id
  const add = async () => {
    if (!draft.name.trim()) return show("Sub-Project name is required", "error");
    if (isDraft) { onDraftChange?.([...(draftRows || []), draft]); setDraft(blank); setAdding(false); return; }
    setBusy(true);
    try { await api.post(`/projects/${projectId}/sub-projects`, draft); setDraft(blank); setAdding(false); show("Sub-Project added"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const save = async () => {
    if (editingId == null) return;
    if (isDraft) {
      const idx = DRAFT_KEY_BASE - editingId;
      const rows = [...(draftRows || [])]; rows[idx] = editRow;
      onDraftChange?.(rows); setEditingId(null); setEditRow(null);
      return;
    }
    setBusy(true);
    try { await api.put(`/sub-projects/${editingId}`, editRow); setEditingId(null); setEditRow(null); show("Sub-Project saved"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (id: number, name: string, idx?: number) => {
    if (!(await confirmDel(name))) return;
    if (isDraft) { onDraftChange?.((draftRows || []).filter((_, i) => i !== idx)); return; }
    try { await api.del(`/sub-projects/${id}`); show("Sub-Project deleted"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const startEdit = (row: any, idx: number) => { setEditingId(isDraft ? DRAFT_KEY_BASE - idx : row.id); setEditRow({ ...row }); };
  const cancelEdit = () => { setEditingId(null); setEditRow(null); };
  // Shared label+input grid used by both the inline "Edit" expansion and the "Add" form below —
  // keeps every field clearly labeled instead of cramming unlabeled inputs into table cells.
  const fieldsGrid = (row: any, setRow: (patch: any) => void) => (
    <div className="form-grid" style={{ marginTop: 8, background: "var(--panel-2, rgba(127,127,127,.06))", borderRadius: 8, padding: 10 }}>
      <Input label="Name" value={row.name} onChange={(e: any) => setRow({ name: e.target.value })} placeholder="e.g. resource name or cost-center" />
      <Input label="Project Code" value={row.code || ""} onChange={(e: any) => setRow({ code: e.target.value })} />
      <Input label="PO Number" value={row.poNumber || ""} onChange={(e: any) => setRow({ poNumber: e.target.value })} />
      <Input label="Customer Reference Number" value={row.customerRefNo || ""} onChange={(e: any) => setRow({ customerRefNo: e.target.value })} />
      <Input label="Project Title (shown on invoice)" value={row.title || ""} onChange={(e: any) => setRow({ title: e.target.value })} />
      <Input label="Attention" value={row.attentionContact || ""} onChange={(e: any) => setRow({ attentionContact: e.target.value })} placeholder="e.g. Amol Helwatkar" />
      <div className="full"><label>Project Description</label><textarea rows={2} value={row.description || ""} onChange={(e: any) => setRow({ description: e.target.value })} placeholder="default service/project description for this resource's invoices" /></div>
    </div>
  );
  return (
    <div className="full" style={{ marginTop: 8 }}>
      <div className="note" title="Lets several resources/cost-centers bill individually under this ONE Project — PO Number, Code, Title, Attention, Description remembered per Sub-Project (looked up from each resource's own invoice history), carried forward month to month, instead of creating a separate Project per person.">
        Add one row per resource or cost-center that needs its own PO Number/Code/Invoice identity. Leave empty to invoice this whole Project as one combined whole.
        {isDraft && <> These will be created as soon as you save the Project below.</>}
      </div>
      <table>
        <thead><tr><th>Name</th><th>Code</th><th>PO Number</th><th>Customer Ref No</th><th>Attention</th><th style={{ width: 120 }}></th></tr></thead>
        <tbody>
          {(data || []).length === 0 && <tr><td colSpan={6} style={{ color: "var(--muted)" }}>None yet — this Project invoices as a single combined whole.</td></tr>}
          {(data || []).map((sp: any, idx: number) => {
            const key = isDraft ? DRAFT_KEY_BASE - idx : sp.id;
            return (
              <React.Fragment key={key}>
                <tr>
                  <td>{sp.name}</td><td>{sp.code || "—"}</td><td>{sp.poNumber || "—"}</td><td>{sp.customerRefNo || "—"}</td><td>{sp.attentionContact || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="ghost" onClick={() => (editingId === key ? cancelEdit() : startEdit(sp, idx))}>{editingId === key ? "Close" : "Edit"}</button>{" "}
                    <button type="button" className="ghost" onClick={() => del(sp.id, sp.name, idx)}>Delete</button>
                  </td>
                </tr>
                {editingId === key && editRow && (
                  <tr><td colSpan={6}>
                    {fieldsGrid(editRow, (patch) => setEditRow({ ...editRow, ...patch }))}
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="ghost" disabled={busy} onClick={save}>Save</button>{" "}
                      <button type="button" className="ghost" disabled={busy} onClick={cancelEdit}>Cancel</button>
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {adding ? (
        <div style={{ marginTop: 10 }}>
          {fieldsGrid(draft, (patch) => setDraft({ ...draft, ...patch }))}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="ghost" disabled={busy} onClick={add}>Add Sub-Project</button>{" "}
            <button type="button" className="ghost" disabled={busy} onClick={() => { setAdding(false); setDraft(blank); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="ghost" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>+ Add Sub-Project</button>
      )}
    </div>
  );
}

// =====================================================================
// CTC
// =====================================================================
export function Ctc() {
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/ctc");
  const { data: emps } = useFetch<any[]>("/employees");
  // Same CAD→USD rate Operations.tsx's own CAD-project rate fields already use — here it's what
  // turns Finance's entered "Annual Salary (CAD)" into the USD-equivalent annualCostOverride the
  // cost engine expects (server re-derives the same conversion; this is only for the live preview
  // and for reverse-converting an existing CAD record's stored USD figure back for editing).
  const { data: fxRates } = useFetch<any[]>("/fx-rates");
  const canadaFactor = (fxRates || []).find((r: any) => r.context === "CANADA_FACTOR")?.rate || 0.71;
  const blank = { id: null, employeeId: "", effectiveFrom: "", effectiveTill: "", location: "INDIA", usEngagement: "W2", empType: "FULL_TIME", rateBasis: "HOURLY", annualSalaryUsd: 0, annualSalaryCad: 0, hourlyRateUsd: 0, dayRateUsd: 0, hoursPerDay: 8, workingDaysPerYear: 260, basic: 0, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0, communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0 };
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [histId, setHistId] = useState<number | null>(null); // employee whose change-history drawer is open
  // Vendor and W2/No-Benefits are hourly-based; W2 Fulltime (with benefits) is an annual salary.
  const isHourlyEng = (eng: string) => eng === "VENDOR" || eng === "W2_NO_BENEFIT";
  const isDayRate = (f: any) => String(f?.rateBasis || "HOURLY").toUpperCase() === "DAILY";
  // India contractors are billed at a flat monthly cost — no salary-component breakdown. The
  // CTC's OWN employment type (form.empType) drives this so a record can flip Contractor↔FTE.
  const selEmp = (emps || []).find((e: any) => String(e.id) === String(form?.employeeId));
  const isIndiaContractor = form?.location !== "US" && form?.empType === "CONTRACTOR";
  const ctcFxRate = (data || []).find((r: any) => r?.fxRate)?.fxRate || 93; // USD_INR for the monthly→annual USD preview
  const valid = form && form.employeeId && form.effectiveFrom && (
    form.location === "CANADA" ? +form.annualSalaryCad > 0
    : form.location === "US"
      ? (isHourlyEng(form.usEngagement)
          ? (isDayRate(form) ? +form.dayRateUsd > 0 && +form.workingDaysPerYear > 0 : +form.hourlyRateUsd > 0 && +form.hoursPerDay > 0)
          : +form.annualSalaryUsd > 0)
      : isIndiaContractor ? +form.basic > 0 : true
  );
  // Spell out exactly which required fields are still missing, so a disabled Save button
  // isn't a dead end — the hint renders inside the modal and updates as the user types.
  const missing: string[] = !form ? [] : [
    !form.employeeId && "Employee",
    !form.effectiveFrom && "Effective From",
    ...(form.location === "CANADA" ? [!(+form.annualSalaryCad > 0) && "Annual Salary (CAD)"]
      : form.location === "US"
      ? (isHourlyEng(form.usEngagement)
          ? (isDayRate(form)
              ? [!(+form.dayRateUsd > 0) && "Day Rate", !(+form.workingDaysPerYear > 0) && "Number of Working Days"]
              : [!(+form.hourlyRateUsd > 0) && "Hourly Rate", !(+form.hoursPerDay > 0) && "Number of Hours"])
          : [!(+form.annualSalaryUsd > 0) && "Annual Salary"])
      : isIndiaContractor ? [!(+form.basic > 0) && "Monthly Cost"] : []),
  ].filter(Boolean) as string[];
  const save = async () => {
    if (!valid) return show("Employee and Effective From are required", "error");
    setBusy(true);
    try {
      const r = form.id ? await api.put(`/ctc/${form.id}`, form) : await api.post("/ctc", form);
      show(r?.reflected ? `CTC saved · updated Cost on ${r.reflected} monthly line(s)` : "CTC saved");
      setForm(null); reload();
    }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (c: any) => { if (!(await confirmDel((c.employee?.name || "") + " CTC"))) return; await api.del(`/ctc/${c.id}`); show("CTC deleted"); reload(); };
  const F = (k: string, label: string) => <Input label={label} type="number" value={form[k]} onChange={(e: any) => setForm({ ...form, [k]: e.target.value })} />;

  // When picking an employee, default Effective From to their JOINING DATE and prefill
  // all salary values from their latest CTC record (if any).
  const pickEmployee = (employeeId: string) => {
    const emp = (emps || []).find((e: any) => String(e.id) === String(employeeId));
    const joinDate = emp?.joiningDate?.slice(0, 10) || "";
    const loc = emp?.location === "US" ? "US" : emp?.location === "CANADA" ? "CANADA" : "INDIA";
    // US empType → CTC engagement default: Vendor & W2/No-Benefit are hourly; Full-time → W2 salary.
    const engFromType = emp?.empType === "VENDOR" ? "VENDOR" : emp?.empType === "W2_NO_BENEFIT" ? "W2_NO_BENEFIT" : "W2";
    const latest = (data || [])
      .filter((c: any) => String(c.employeeId) === String(employeeId))
      .sort((a: any, b: any) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom))[0];
    if (latest) {
      show(`Prefilled from ${latest.employee?.name}'s latest CTC${joinDate ? "; Effective From set to joining date" : ""}`);
      setForm({
        ...form, employeeId,
        location: latest.usEngagement ? "US" : latest.currency === "CAD" ? "CANADA" : loc,
        effectiveFrom: joinDate || latest.effectiveFrom?.slice(0, 10) || "",
        usEngagement: latest.usEngagement || engFromType,
        empType: latest.empType || (emp?.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME"),
        rateBasis: latest.rateBasis || "HOURLY",
        annualSalaryUsd: latest.usEngagement === "W2" ? (latest.annualCostOverride || 0) : 0,
        // Reverse the same CAD→USD conversion the server applied on save, so editing shows back
        // (approximately) what was originally typed, not the stored USD-equivalent.
        annualSalaryCad: latest.currency === "CAD" ? d2((latest.annualCostOverride || 0) / (canadaFactor || 0.71)) : 0,
        hourlyRateUsd: latest.hourlyRateUsd || 0, dayRateUsd: latest.dayRateUsd || 0, hoursPerDay: latest.hoursPerDay || 8, workingDaysPerYear: latest.workingDaysPerYear || 260,
        basic: latest.basic, hra: latest.hra, otherAllowance: latest.otherAllowance, specialAllowance: latest.specialAllowance,
        conveyance: latest.conveyance, communication: latest.communication, meals: latest.meals, books: latest.books,
        driver: latest.driver, uniform: latest.uniform, bonusAnnual: latest.bonusAnnual,
      });
    } else {
      setForm({ ...form, employeeId, location: loc, usEngagement: engFromType, empType: emp?.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME", effectiveFrom: joinDate });
    }
  };

  // ONE row per employee — the change history (effective-dated segments) is managed inside it.
  const empRows = (() => {
    const byEmp = new Map<number, any[]>();
    for (const c of (data || [])) { if (!byEmp.has(c.employeeId)) byEmp.set(c.employeeId, []); byEmp.get(c.employeeId)!.push(c); }
    return Array.from(byEmp.entries()).map(([employeeId, recs]) => {
      const sorted = [...recs].sort((a, b) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom));
      return { employeeId, employee: sorted[0].employee, latest: sorted[0], records: sorted, count: sorted.length };
    });
  })();
  const histRecords = histId == null ? [] : (data || []).filter((c: any) => c.employeeId === histId)
    .sort((a: any, b: any) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom));
  const histEmp = histId == null ? null : ((emps || []).find((e: any) => e.id === histId) || histRecords[0]?.employee);
  const basisLabel = (c: any) => {
    if (c.currency === "CAD") return "Canada (CAD salary)";
    if (!c.usEngagement) return "India (INR)";
    if (c.usEngagement === "W2") return "W2 Fulltime (USD salary)";
    const rate = c.rateBasis === "DAILY" ? `$${c.dayRateUsd || 0}/day` : `$${c.hourlyRateUsd || 0}/hr`;
    return (c.usEngagement === "VENDOR" ? "Vendor" : "W2/No Benefits") + " · " + rate;
  };
  // Edit an existing segment (employee locked — you're inside one employee's history).
  const editSegment = (c: any) => setForm({
    id: c.id, employeeId: c.employeeId, lockEmp: true, effectiveFrom: c.effectiveFrom?.slice(0, 10), effectiveTill: c.effectiveTill ? c.effectiveTill.slice(0, 10) : "",
    location: c.usEngagement ? "US" : c.currency === "CAD" ? "CANADA" : (c.employee?.location === "US" ? "US" : "INDIA"),
    usEngagement: c.usEngagement || "W2",
    empType: c.empType || (c.employee?.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME"),
    rateBasis: c.rateBasis || "HOURLY",
    annualSalaryUsd: c.usEngagement === "W2" ? (c.annualCostOverride || 0) : 0,
    annualSalaryCad: c.currency === "CAD" ? d2((c.annualCostOverride || 0) / (canadaFactor || 0.71)) : 0,
    hourlyRateUsd: c.hourlyRateUsd || 0, dayRateUsd: c.dayRateUsd || 0, hoursPerDay: c.hoursPerDay || 8, workingDaysPerYear: c.workingDaysPerYear || 260,
    basic: c.basic, hra: c.hra, otherAllowance: c.otherAllowance, specialAllowance: c.specialAllowance, conveyance: c.conveyance, communication: c.communication, meals: c.meals, books: c.books, driver: c.driver, uniform: c.uniform, bonusAnnual: c.bonusAnnual,
  });
  // Add a NEW dated change for this employee — prefilled from their latest segment, with a blank
  // Effective From (you enter the date the change takes effect, e.g. the conversion date).
  const newSegment = (employeeId: number) => {
    const emp = (emps || []).find((e: any) => e.id === employeeId);
    const loc = emp?.location === "US" ? "US" : emp?.location === "CANADA" ? "CANADA" : "INDIA";
    const engFromType = emp?.empType === "VENDOR" ? "VENDOR" : emp?.empType === "W2_NO_BENEFIT" ? "W2_NO_BENEFIT" : "W2";
    const latest = (data || []).filter((c: any) => c.employeeId === employeeId).sort((a: any, b: any) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom))[0];
    if (latest) setForm({
      ...blank, employeeId, lockEmp: true, effectiveFrom: "",
      location: latest.usEngagement ? "US" : latest.currency === "CAD" ? "CANADA" : loc,
      annualSalaryCad: latest.currency === "CAD" ? d2((latest.annualCostOverride || 0) / (canadaFactor || 0.71)) : 0,
      usEngagement: latest.usEngagement || engFromType,
      empType: latest.empType || (emp?.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME"),
      rateBasis: latest.rateBasis || "HOURLY",
      annualSalaryUsd: latest.usEngagement === "W2" ? (latest.annualCostOverride || 0) : 0,
      hourlyRateUsd: latest.hourlyRateUsd || 0, dayRateUsd: latest.dayRateUsd || 0, hoursPerDay: latest.hoursPerDay || 8, workingDaysPerYear: latest.workingDaysPerYear || 260,
      basic: latest.basic, hra: latest.hra, otherAllowance: latest.otherAllowance, specialAllowance: latest.specialAllowance,
      conveyance: latest.conveyance, communication: latest.communication, meals: latest.meals, books: latest.books,
      driver: latest.driver, uniform: latest.uniform, bonusAnnual: latest.bonusAnnual,
    });
    else setForm({ ...blank, employeeId, lockEmp: true, location: loc, usEngagement: engFromType, empType: emp?.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME" });
  };
  return (
    <div>
      <h1>CTC Management</h1><div className="subtitle">One record per employee. Open <b>Manage history</b> to add or edit effective-dated employment-type / CTC changes over time.</div>
      <div className="btn-row"><AddButton onClick={() => setForm({ ...blank })}>Add Employee CTC</AddButton></div>
      <Panel>{loading ? "Loading…" : <DataTable rows={empRows} searchKeys={(r: any) => r.employee?.name || ""}
        columns={[
          { key: "emp", label: "Employee", value: (r: any) => r.employee?.name, render: (r: any) => r.employee?.name },
          { key: "empType", label: "Current Type", value: (r: any) => r.latest.empType || r.employee?.empType || "",
            render: (r: any) => empTypeLabel(r.latest.empType || r.employee?.empType) },
          { key: "basis", label: "Current Basis", value: (r: any) => basisLabel(r.latest), render: (r: any) => basisLabel(r.latest) },
          { key: "monthly", label: "Monthly CTC", num: true, value: (r: any) => r.latest.monthlyUsd ?? 0,
            render: (r: any) => (r.latest.monthlyUsd ? fmt(r.latest.monthlyUsd) : "—") },
          { key: "usd", label: "Annual CTC", num: true, value: (r: any) => r.latest.annualUsd ?? r.latest.annualCostOverride ?? 0,
            render: (r: any) => { const v = r.latest.annualUsd ?? r.latest.annualCostOverride ?? 0; return v ? fmt(v) : "—"; } },
          { key: "since", label: "Effective Since", value: (r: any) => r.latest.effectiveFrom, render: (r: any) => fmtDate(r.latest.effectiveFrom) },
          { key: "changes", label: "Changes", num: true, value: (r: any) => r.count, render: (r: any) => r.count },
          { key: "manage", label: "", noSort: true, render: (r: any) => <button className="ghost" onClick={() => setHistId(r.employeeId)}>Manage history</button> },
        ]} />}</Panel>

      {/* Per-employee change history — add/edit/delete effective-dated segments in one place. */}
      <Modal title={`CTC & Employment History — ${histEmp?.name || ""}`} open={histId != null} onClose={() => setHistId(null)} wide>
        <div className="btn-row" style={{ marginBottom: 10 }}><AddButton onClick={() => newSegment(histId!)}>Add Change</AddButton></div>
        {histRecords.length === 0 ? <div className="subtitle">No CTC records yet — click <b>Add Change</b> to add the first one.</div>
          : <table>
            <thead><tr><th>Effective From</th><th>Effective Till</th><th>Employment Type</th><th>Basis</th><th className="num">Monthly</th><th className="num">Annual</th><th></th></tr></thead>
            <tbody>
              {histRecords.map((c: any) => <tr key={c.id}>
                <td>{fmtDate(c.effectiveFrom)}</td>
                <td>{c.effectiveTill ? fmtDate(c.effectiveTill) : "—"}</td>
                <td>{empTypeLabel(c.empType || histEmp?.empType)}</td>
                <td>{basisLabel(c)}</td>
                <td className="num">{c.monthlyUsd ? fmt(c.monthlyUsd) : "—"}</td>
                <td className="num">{fmt(c.annualUsd ?? c.annualCostOverride ?? 0)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => editSegment(c)}>Edit</button>{" "}
                  <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => del(c)}>Delete</button>
                </td>
              </tr>)}
            </tbody>
          </table>}
        <div className="subtitle" style={{ marginTop: 8 }}>Each row is a period that takes effect on its date. Monthly cost is prorated across these segments when a change falls mid-month.</div>
      </Modal>
      <Modal title={form?.id ? "Edit CTC Record" : "Add CTC Record"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!valid}>
        {form && <div className="form-grid">
          {form.lockEmp
            ? <div className="full"><label>Employee</label><div style={{ fontWeight: 600 }}>{(emps || []).find((e: any) => String(e.id) === String(form.employeeId))?.name || histEmp?.name || "—"}</div></div>
            : <Select label="Employee" required value={form.employeeId} onChange={(e: any) => pickEmployee(e.target.value)}
                options={[{ value: "", label: "— select —" }, ...(emps || []).map((e) => ({ value: e.id, label: e.name }))]} />}
          <Input label="Effective From" required type="date" value={form.effectiveFrom} onChange={(e: any) => setForm({ ...form, effectiveFrom: e.target.value })} />
          <Input label="Effective Till (optional)" type="date" value={form.effectiveTill || ""} onChange={(e: any) => setForm({ ...form, effectiveTill: e.target.value })} />
          <Select label="Location" value={form.location} onChange={(e: any) => setForm({ ...form, location: e.target.value })}
            options={[{ value: "INDIA", label: "India (INR salary)" }, { value: "US", label: "United States (USD)" }, { value: "CANADA", label: "Canada (CAD salary)" }]} />

          {form.location === "CANADA" ? <>
            <Input label="Annual Salary (CAD)" required type="number" value={form.annualSalaryCad} onChange={(e: any) => setForm({ ...form, annualSalaryCad: e.target.value })} />
            <div className="full" style={{ background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              ≈ <b>{fmt((+form.annualSalaryCad || 0) * canadaFactor)}</b> USD for cost reporting
              <span className="subtitle" style={{ marginLeft: 8 }}>= C${d2(+form.annualSalaryCad || 0)} × {canadaFactor}</span>
            </div>
          </> : form.location === "US" ? <>
            <Select label="US Engagement" value={form.usEngagement} onChange={(e: any) => setForm({ ...form, usEngagement: e.target.value })}
              options={[
                { value: "W2", label: "W2 Fulltime (With Benefits)" },
                { value: "W2_NO_BENEFIT", label: "W2 / No Benefits — hourly" },
                { value: "VENDOR", label: "Hired from Vendor — hourly" },
              ]} />
            {!isHourlyEng(form.usEngagement)
              ? <Input label="Annual Salary (USD)" required type="number" value={form.annualSalaryUsd} onChange={(e: any) => setForm({ ...form, annualSalaryUsd: e.target.value })} />
              : <>
                  {/* Hourly engagements (Vendor / W2 No-Benefit) bill either by hourly rate or by day rate. */}
                  <Select label="Billing Basis" required value={isDayRate(form) ? "DAILY" : "HOURLY"} onChange={(e: any) => setForm({ ...form, rateBasis: e.target.value })}
                    options={[
                      { value: "HOURLY", label: "Hourly Rate" },
                      { value: "DAILY", label: "Day Rate" },
                    ]} />
                  {isDayRate(form)
                    ? <>
                        <Input label="Day Rate (USD)" required type="number" value={form.dayRateUsd} onChange={(e: any) => setForm({ ...form, dayRateUsd: e.target.value })} />
                        <Input label="Number of Working Days" required type="number" value={form.workingDaysPerYear} onChange={(e: any) => setForm({ ...form, workingDaysPerYear: e.target.value })} />
                        <div className="full" style={{ background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
                          Computed Annual CTC: <b>{fmt((+form.dayRateUsd || 0) * (+form.workingDaysPerYear || 0))}</b>
                          <span className="subtitle" style={{ marginLeft: 8 }}>= ${d2(+form.dayRateUsd || 0)}/day × {+form.workingDaysPerYear || 0} days</span>
                        </div>
                      </>
                    : <>
                        <Input label="Hourly Rate (USD)" required type="number" value={form.hourlyRateUsd} onChange={(e: any) => setForm({ ...form, hourlyRateUsd: e.target.value })} />
                        <Input label="Number of Hours" required type="number" value={form.hoursPerDay} onChange={(e: any) => setForm({ ...form, hoursPerDay: e.target.value })} />
                        <div className="full" style={{ background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
                          Computed Annual CTC: <b>{fmt((+form.hourlyRateUsd || 0) * (+form.hoursPerDay || 0) * (+form.workingDaysPerYear || 260))}</b>
                          <span className="subtitle" style={{ marginLeft: 8 }}>= ${d2(+form.hourlyRateUsd || 0)}/hr × {+form.hoursPerDay || 0} h/day × {+form.workingDaysPerYear || 260} days</span>
                        </div>
                      </>}
                </>}
          </> : <>
            {/* Effective-dated employment type for this India CTC segment — flips the form between a flat
                contractor monthly cost and the FTE salary-component breakdown. */}
            <Select label="Employment Type" value={form.empType === "CONTRACTOR" ? "CONTRACTOR" : "FULL_TIME"} onChange={(e: any) => setForm({ ...form, empType: e.target.value })}
              options={[{ value: "FULL_TIME", label: "Full-Time" }, { value: "CONTRACTOR", label: "Contractor" }]} />
            {isIndiaContractor ? <>
            {/* India contractor → flat monthly cost only (stored as Basic so it flows through the INR pipeline). */}
            <Input label="Monthly Cost (INR)" required type="number" value={form.basic}
              onChange={(e: any) => setForm({ ...form, basic: e.target.value, hra: 0, otherAllowance: 0, specialAllowance: 0, conveyance: 0, communication: 0, meals: 0, books: 0, driver: 0, uniform: 0, bonusAnnual: 0 })} />
            <div className="full" style={{ background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              Annual CTC: <b>{fmt((+form.basic || 0) * 12, "INR")}</b>
              <span className="subtitle" style={{ marginLeft: 8 }}>≈ {fmt((+form.basic || 0) * 12 / ctcFxRate)} USD · {fmt(+form.basic || 0, "INR")}/mo × 12 ÷ {ctcFxRate}</span>
            </div>
          </> : <>
            {F("basic", "Basic")}{F("hra", "HRA")}{F("otherAllowance", "Other Allowance")}{F("specialAllowance", "Special Allowance")}
            {F("conveyance", "Conveyance / Fuel")}{F("communication", "Communication")}{F("meals", "Meals & Ent.")}{F("books", "Books & Periodicals")}
            {F("driver", "Driver")}{F("uniform", "Uniform")}{F("bonusAnnual", "Annual Bonus")}
          </>}</>}
          {missing.length > 0 && <div className="full" style={{ color: "var(--danger, #d33)", fontSize: 13 }}>
            Required before saving: {missing.join(", ")}.
          </div>}
        </div>}
      </Modal>
    </div>
  );
}

// Annual Leaves (Holidays) moved to HR Settings → "Annual Leaves (Holiday)" tab (Hr.tsx's
// HolidaySettings), now organized under the Business Unit selector like every other HR
// Settings category, instead of its own top-level page.

// =====================================================================
// Clients
// =====================================================================
export function Clients() {
  const admin = useAdminGate();
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/clients");
  const { data: geos } = useFetch<any[]>("/geographies");
  // Currency, Invoice Template & Payment Terms are now PROJECT settings (see the Projects page).
  const blank = { id: null, name: "", legalEntityName: "", code: "", geographyId: "", state: "", stateIsOther: false, billToAddress: "", attentionContact: "", email: "", ccEmail: "", bccEmail: "", addressTo: "AP Team", logo: "" };
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const valid = form && form.name.trim() && form.code.trim();
  const onLogo = (file?: File) => {
    if (!file) return;
    if (file.size > 500 * 1024) return show("Logo must be under 500 KB", "error");
    const r = new FileReader();
    r.onload = () => setForm((f: any) => ({ ...f, logo: r.result as string }));
    r.readAsDataURL(file);
  };
  const save = async () => {
    if (!valid) return show("Name and Code are required", "error");
    setBusy(true);
    try { if (form.id) await api.put(`/clients/${form.id}`, form); else await api.post("/clients", form); show("Client saved"); setForm(null); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (c: any) => { if (!(await confirmDel(c.name))) return; try { await api.del(`/clients/${c.id}`); show("Client deleted"); reload(); } catch (e: any) { show(e.message, "error"); } };
  return (
    <div>
      <h1>Clients</h1><div className="subtitle">Fully dynamic. Currency, invoice template &amp; payment terms are set per <b>project</b>.</div>
      {admin && <div className="btn-row"><AddButton onClick={() => setForm({ ...blank })}>Add Client</AddButton></div>}
      <Panel>{loading ? "Loading…" : <DataTable rows={data || []} searchKeys={(c: any) => `${c.name} ${c.code}`}
        columns={[
          { key: "name", label: "Name" }, { key: "code", label: "Code" },
          { key: "geo", label: "Geography", value: (c: any) => c.geography?.name, render: (c: any) => c.geography?.name || "—" },
          { key: "state", label: "State", value: (c: any) => c.state, render: (c: any) => c.state || "—" },
        ]}
        onEdit={admin ? (c) => setForm({ id: c.id, name: c.name, legalEntityName: c.legalEntityName || c.name, code: c.code, geographyId: c.geographyId || "", state: c.state || "", stateIsOther: !!c.state && (() => { const l = statesForGeography((geos || []).find((x) => x.id === c.geographyId)?.code); return l.length > 0 && !l.includes(c.state); })(), billToAddress: c.billToAddress || "", attentionContact: c.attentionContact || "", email: c.email || "", ccEmail: c.ccEmail || "", bccEmail: c.bccEmail || "", addressTo: c.addressTo || "AP Team", logo: c.logo || "" }) : undefined}
        onDelete={admin ? del : undefined} />}</Panel>
      <Modal title={form?.id ? "Edit Client" : "Add Client"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!valid}>
        {form && <div className="form-grid">
          <Input label="Client Name" required value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Kira Learning" />
          <Input label="Legal Entity Name" value={form.legalEntityName} onChange={(e: any) => setForm({ ...form, legalEntityName: e.target.value })} placeholder="defaults to the client name" />
          <Input label="Code (for invoice #)" required value={form.code} onChange={(e: any) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. KIRA" />
          <Select label="Geography" value={form.geographyId} onChange={(e: any) => {
              // Changing geography repopulates the State list — clear a state that isn't in the new list.
              const g = (geos || []).find((x) => String(x.id) === String(e.target.value));
              const list = statesForGeography(g?.code);
              setForm({ ...form, geographyId: e.target.value, stateIsOther: false, state: list.length && !list.includes(form.state) ? "" : form.state });
            }}
            options={[{ value: "", label: "—" }, ...(geos || []).map((g) => ({ value: g.id, label: g.name }))]} />
          {(() => {
            const g = (geos || []).find((x) => String(x.id) === String(form.geographyId));
            const list = statesForGeography(g?.code);
            const label = stateLabelForGeography(g?.code);
            // US / Canada / India → dropdown of every state/province; other geographies → free text.
            // "Other (specify)" lets the user type a state/province that isn't in the list.
            return list.length
              ? <>
                  <Select label={label} value={form.stateIsOther ? "__OTHER__" : form.state}
                    onChange={(e: any) => e.target.value === "__OTHER__"
                      ? setForm({ ...form, stateIsOther: true, state: "" })
                      : setForm({ ...form, stateIsOther: false, state: e.target.value })}
                    options={[{ value: "", label: "— select —" }, ...list.map((s) => ({ value: s, label: s })), { value: "__OTHER__", label: "Other (specify)…" }]} />
                  {form.stateIsOther && <Input label={`Specify ${label}`} value={form.state} onChange={(e: any) => setForm({ ...form, state: e.target.value })} placeholder={`${label} not in the list`} />}
                </>
              : <Input label={label} value={form.state} onChange={(e: any) => setForm({ ...form, state: e.target.value })} placeholder={g ? "State / region (optional)" : "Select a geography first"} />;
          })()}
          {/* Currency, Invoice Template & Payment Terms moved to the Projects page. */}
          {/* Invoice email recipients — used by Preview & Draft Email (not printed on the PDF). */}
          <Input label="TO Email (AP/billing)" full value={form.email} onChange={(e: any) => setForm({ ...form, email: e.target.value })} placeholder="Comma-separated, e.g. ap@client.com, billing@client.com" />
          <Input label="CC Email (AP/billing)" full value={form.ccEmail} onChange={(e: any) => setForm({ ...form, ccEmail: e.target.value })} placeholder="Comma-separated CC list" />
          <Input label="BCC Email (AP/billing)" full value={form.bccEmail} onChange={(e: any) => setForm({ ...form, bccEmail: e.target.value })} placeholder="Comma-separated BCC list" />
          <Input label="Email Address To" value={form.addressTo} onChange={(e: any) => setForm({ ...form, addressTo: e.target.value })} placeholder="AP Team — greeting used in the invoice email" />
          <div className="full">
            <label>Client Logo (shown on invoices)</label>
            <input type="file" accept="image/*" onChange={(e: any) => onLogo(e.target.files?.[0])} />
            {form.logo && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
              <img src={form.logo} alt="logo" style={{ maxHeight: 48, maxWidth: 160, background: "#fff", borderRadius: 6, padding: 4 }} />
              <button type="button" className="ghost" onClick={() => setForm({ ...form, logo: "" })}>Remove</button>
            </div>}
          </div>
          {form.id ? <AttachmentsPanel basePath="clients" entityId={form.id} /> : <div className="full note">Save the client first to attach documents.</div>}
        </div>}
      </Modal>
    </div>
  );
}

// =====================================================================
// Projects
// =====================================================================
export function Projects() {
  const admin = useAdminGate();
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/projects");
  const { data: clients } = useFetch<any[]>("/clients");
  const { data: invTemplates } = useFetch<any[]>("/admin/invoice-templates");
  // Same underlying Project.timesheetTemplateId column the standalone "Project Template
  // Assignment" screen (Finance Settings → Timesheet Templates) writes to — this is just a
  // second, inline place to set it, not a parallel mechanism.
  const { data: tsTemplates } = useFetch<any[]>("/timesheet-templates");
  // Project Manager picker — restricted to Users with Role.PROJECT_MANAGER (server re-validates
  // this too). Deliberately a separate PUT from the Project save below: assigning/removing a PM
  // never touches EmployeeProject or MonthlyLine, so it can never affect Monthly Forecast.
  const { data: pmCandidates } = useFetch<any[]>("/projects/pm-candidates");
  const blank = { id: null, clientId: "", name: "", code: "", title: "", invoiceTemplateId: "", timesheetTemplateId: "", invoiceCode: "", invoiceNoFormat: "{InvoiceCode}{Year}{Month}", invoiceNameIncludeResource: false, annexureHideLeave: false, annexureHideBillRate: false, annexureHideHours: false, annexureHideRole: false, annexureHide: false, lineItemsHideHours: false, lineItemsHideRate: false, lineItemsDayBasis: false, lineItemsPerResource: false, lineItemsSumAll: false, annexureDayBasis: false, annexureSumTotal: false, lineItemsAddGst: false, gstPercent: 5, poNumber: "", customerRefNo: "", paymentTerms: "", description: "", billingEmail: "", ccEmail: "", bccEmail: "", addressTo: "AP Team", attentionContact: "", billToAddress: "", currency: "USD", paymentTermsDays: 30, billingType: "TNM", billingScope: "RESOURCE", deliveryModel: "OFFSHORE", status: "ACTIVE", billingHoursPerDay: 8, managerIds: [] as number[], pendingSubProjects: [] as any[] };
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const valid = form && form.clientId && form.name.trim();
  const save = async () => {
    if (!valid) return show("Client and Project Name are required", "error");
    setBusy(true);
    try {
      let id = form.id;
      const isNew = !id;
      if (id) await api.put(`/projects/${id}`, form);
      else { const created: any = await api.post("/projects", form); id = created.id; }
      // Separate call, on purpose — this only ever writes to ProjectManager, never
      // EmployeeProject/MonthlyLine, so it can never create a Monthly Forecast line.
      await api.put(`/projects/${id}/managers`, { employeeIds: form.managerIds || [] });
      // Sub-Projects added while creating a brand-new Project only exist as a local draft until
      // now (there was no projectId to save them against yet) — create them for real in one go
      // right after the Project itself gets its id.
      if (isNew && form.pendingSubProjects?.length) {
        for (const sp of form.pendingSubProjects) await api.post(`/projects/${id}/sub-projects`, sp);
      }
      show("Project saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (p: any) => { if (!(await confirmDel(p.name))) return; try { await api.del(`/projects/${p.id}`); show("Project deleted"); reload(); } catch (e: any) { show(e.message, "error"); } };
  // Closed projects (e.g. old per-resource projects superseded by Sub-Projects — see the Project
  // edit screen's own Sub-Projects panel) stay out of the way by default, but remain one click away
  // for historical reference/editing — never deleted, just hidden until asked for.
  const [showClosed, setShowClosed] = useState(false);
  const visibleRows = showClosed ? (data || []) : (data || []).filter((p: any) => p.status !== "CLOSED");
  return (
    <div>
      <h1>Projects</h1><div className="subtitle">Fixed-bid or T&amp;M · project/resource scope · onsite/offshore/hybrid.</div>
      <div className="btn-row" style={{ alignItems: "center" }}>
        {admin && <AddButton onClick={() => setForm({ ...blank })}>Add Project</AddButton>}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed projects ({(data || []).filter((p: any) => p.status === "CLOSED").length})
        </label>
      </div>
      <Panel>{loading ? "Loading…" : <DataTable rows={visibleRows} searchKeys={(p: any) => `${p.name} ${p.client?.name} ${p.billingType} ${p.deliveryModel}`}
        columns={[
          { key: "client", label: "Client", value: (p: any) => p.client?.name, render: (p: any) => p.client?.name }, { key: "name", label: "Project", value: (p: any) => projectBaseName(p), render: (p: any) => projectBaseName(p) },
          { key: "location", label: "Location", value: (p: any) => p.client?.geography?.name, render: (p: any) => p.client?.geography?.name || "—" },
          { key: "currency", label: "Currency" },
          { key: "billingType", label: "Type" }, { key: "billingScope", label: "Scope" }, { key: "deliveryModel", label: "Delivery" },
          { key: "pm", label: "Project Manager(s)", value: (p: any) => (p.managers || []).map((m: any) => m.employee?.name).join(", "), render: (p: any) => (p.managers?.length ? p.managers.map((m: any) => m.employee?.name).join(", ") : "—") },
        ]}
        onEdit={admin ? (p) => setForm({ id: p.id, clientId: p.clientId, name: p.name, code: p.code || "", title: p.title || "", invoiceTemplateId: p.invoiceTemplates?.[0]?.id || "", timesheetTemplateId: p.timesheetTemplateId || "", invoiceCode: p.invoiceCode || "", invoiceNoFormat: p.invoiceNoFormat || "{InvoiceCode}{Year}{Month}", invoiceNameIncludeResource: !!p.invoiceNameIncludeResource, annexureHideLeave: !!(p.annexureHideLeave || p.annexureHideLeaveRate), annexureHideBillRate: !!(p.annexureHideBillRate || p.annexureHideLeaveRate), annexureHideHours: !!p.annexureHideHours, annexureHideRole: !!p.annexureHideRole, annexureHide: !!p.annexureHide, lineItemsHideHours: !!p.lineItemsHideHours, lineItemsHideRate: !!p.lineItemsHideRate, lineItemsDayBasis: !!p.lineItemsDayBasis, lineItemsPerResource: !!p.lineItemsPerResource, lineItemsSumAll: !!p.lineItemsSumAll, annexureDayBasis: !!p.annexureDayBasis, annexureSumTotal: !!p.annexureSumTotal, lineItemsAddGst: !!p.lineItemsAddGst, gstPercent: p.gstPercent ?? 5, poNumber: p.poNumber || "", customerRefNo: p.customerRefNo || "", paymentTerms: p.paymentTerms || "", description: p.description || "", billingEmail: p.billingEmail || "", ccEmail: p.ccEmail || "", bccEmail: p.bccEmail || "", addressTo: p.addressTo || "AP Team", attentionContact: p.attentionContact || "", billToAddress: p.billToAddress || "", currency: p.currency || "USD", paymentTermsDays: p.paymentTermsDays ?? 30, billingType: p.billingType, billingScope: p.billingScope, deliveryModel: p.deliveryModel, status: p.status, billingHoursPerDay: p.billingHoursPerDay ?? 8, managerIds: (p.managers || []).map((m: any) => m.employeeId) }) : undefined}
        onDelete={admin ? del : undefined} />}</Panel>
      <Modal title={form?.id ? "Edit Project" : "Add Project"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!valid}>
        {form && <div className="form-grid">
          <SectionHeader>Basic Details</SectionHeader>
          <Select label="Client" required value={form.clientId} onChange={(e: any) => setForm({ ...form, clientId: e.target.value })}
            options={[{ value: "", label: "— select —" }, ...(clients || []).map((c) => ({ value: c.id, label: c.name }))]} />
          <Input label="Project Name" required value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} />
          <Input label="Project Code" value={form.code} onChange={(e: any) => setForm({ ...form, code: e.target.value })} />
          <div className="full">
            <label>Project Manager(s)</label>
            <select multiple value={(form.managerIds || []).map(String)} style={{ minHeight: 90 }}
              onChange={(e: any) => setForm({ ...form, managerIds: Array.from(e.target.selectedOptions).map((o: any) => Number(o.value)) })}>
              {(pmCandidates || []).map((u: any) => <option key={u.employeeId} value={u.employeeId}>{u.name}{u.empNo ? ` (${u.empNo})` : ""}</option>)}
            </select>
            <div className="note" style={{ marginTop: 4 }}>
              Only people with the <b>Project Manager</b> role appear here (ctrl/cmd-click to select multiple). This is purely "who manages this project" — it never adds anyone to Monthly Forecast or creates any cost/billing line.
            </div>
          </div>
          <SectionHeader>Billing Setup &amp; Templates</SectionHeader>
          <Input label="Project Title" value={form.title} onChange={(e: any) => setForm({ ...form, title: e.target.value })} placeholder="title shown on invoices" />
          <Select label="Currency" value={form.currency} onChange={(e: any) => setForm({ ...form, currency: e.target.value })}
            options={["USD", "INR", "CAD"].map((v) => ({ value: v, label: v }))} />
          <Input label="Payment Terms (days)" type="number" value={form.paymentTermsDays} onChange={(e: any) => setForm({ ...form, paymentTermsDays: e.target.value })} placeholder="net days → invoice Due Date" />
          <Select label="Invoice Template (issuer / bank)" value={form.invoiceTemplateId} onChange={(e: any) => setForm({ ...form, invoiceTemplateId: e.target.value })}
            options={[{ value: "", label: "— none (client default) —" }, ...(invTemplates || []).map((t: any) => ({ value: t.id, label: t.name }))]} />
          <Select label="Timesheet Template" value={form.timesheetTemplateId} onChange={(e: any) => setForm({ ...form, timesheetTemplateId: e.target.value })}
            options={[{ value: "", label: "— use Default Template —" }, ...(tsTemplates || []).map((t: any) => ({ value: t.id, label: `${t.name} v${t.version}` }))]} />
          <SectionHeader>Invoice Numbering</SectionHeader>
          <Input label="Invoice Code" value={form.invoiceCode} onChange={(e: any) => setForm({ ...form, invoiceCode: e.target.value })} placeholder="code used in invoice name ({InvoiceCode})" />
          <Input label="Invoice Name Format" full value={form.invoiceNoFormat} onChange={(e: any) => setForm({ ...form, invoiceNoFormat: e.target.value })} placeholder="blank = {InvoiceCode}{Year}{Month}. Tokens: {InvoiceCode} {ProjectCode} {ClientCode} {Year} {Month} {MMM} {MM} {YY} {YYYY} {ResourceName} {Seq}" />
          <label className="full" style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!form.invoiceNameIncludeResource} onChange={(e: any) => setForm({ ...form, invoiceNameIncludeResource: e.target.checked })} />
            Add <b>resource name</b> to the invoice name (appends <code>-{"{ResourceName}"}</code>)
          </label>
          <fieldset className="full" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", margin: 0, display: "grid", gap: 4 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>Annexure (per-resource breakdown)</legend>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureDayBasis} onChange={(e: any) => setForm({ ...form, annexureDayBasis: e.target.checked })} />
              Use <b>Day Rate &amp; Days</b> (instead of Bill Rate &amp; Hours)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureHideLeave} onChange={(e: any) => setForm({ ...form, annexureHideLeave: e.target.checked })} />
              Hide <b>Leave</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureHideBillRate} onChange={(e: any) => setForm({ ...form, annexureHideBillRate: e.target.checked })} />
              Hide <b>{form.annexureDayBasis ? "Day Rate" : "Bill Rate"}</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureHideHours} onChange={(e: any) => setForm({ ...form, annexureHideHours: e.target.checked })} />
              Hide <b>{form.annexureDayBasis ? "Days" : "Hours"}</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureHideRole} onChange={(e: any) => setForm({ ...form, annexureHideRole: e.target.checked })} />
              Hide <b>Role</b> column (Role still drives per-resource Line Items)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureHide} onChange={(e: any) => setForm({ ...form, annexureHide: e.target.checked })} />
              <b>Hide the whole Annexure</b> on the invoice PDF
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.annexureSumTotal} onChange={(e: any) => setForm({ ...form, annexureSumTotal: e.target.checked })} />
              <b>Sum all resources as one total</b> (no per-resource amount)
            </label>
          </fieldset>
          <fieldset className="full" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", margin: 0, display: "grid", gap: 4 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>Line Items</legend>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.lineItemsDayBasis} onChange={(e: any) => setForm({ ...form, lineItemsDayBasis: e.target.checked })} />
              Use <b>Day Rate &amp; Days</b> (instead of Rate &amp; Hours)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.lineItemsHideHours} onChange={(e: any) => setForm({ ...form, lineItemsHideHours: e.target.checked })} />
              Hide <b>{form.lineItemsDayBasis ? "Days" : "Hours"}</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.lineItemsHideRate} onChange={(e: any) => setForm({ ...form, lineItemsHideRate: e.target.checked })} />
              Hide <b>{form.lineItemsDayBasis ? "Day Rate" : "Rate"}</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.lineItemsPerResource} onChange={(e: any) => setForm({ ...form, lineItemsPerResource: e.target.checked, lineItemsSumAll: e.target.checked ? false : form.lineItemsSumAll })} />
              <b>One line item per resource</b> — "IT Services - &lt;Role&gt;" (Role comes from the invoice Annexure; default groups by rate as "IT Services")
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.lineItemsSumAll} onChange={(e: any) => setForm({ ...form, lineItemsSumAll: e.target.checked, lineItemsPerResource: e.target.checked ? false : form.lineItemsPerResource })} />
              <b>Sum all as ONE "IT Services" row</b> — total hours, blended rate, total amount
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!form.lineItemsAddGst} onChange={(e: any) => setForm({ ...form, lineItemsAddGst: e.target.checked })} />
              <b>Break out GST</b> at
              <input type="number" style={{ width: 60 }} value={form.gstPercent} onChange={(e: any) => setForm({ ...form, gstPercent: e.target.value })} /> % (already included in the total)
            </label>
          </fieldset>
          <SectionHeader>Invoice Details &amp; Contacts</SectionHeader>
          <Input label="PO Number" value={form.poNumber} onChange={(e: any) => setForm({ ...form, poNumber: e.target.value })} placeholder="client PO #" />
          <Input label="Customer Reference Number" value={form.customerRefNo} onChange={(e: any) => setForm({ ...form, customerRefNo: e.target.value })} />
          <Input label="Payment Terms" value={form.paymentTerms} onChange={(e: any) => setForm({ ...form, paymentTerms: e.target.value })} placeholder="e.g. Net 30 Days — shown on the invoice (blank = hidden)" />
          <div className="full"><label>Project Description</label><textarea rows={2} value={form.description} onChange={(e: any) => setForm({ ...form, description: e.target.value })} placeholder="default service/project description for invoices" /></div>
          {/* Invoice email recipients (TO/CC/BCC) & greeting now live on the Client. */}
          <Input label="Attention Contact(s)" full value={form.attentionContact} onChange={(e: any) => setForm({ ...form, attentionContact: e.target.value })} placeholder="Comma-separated, e.g. Brad Winters, Jane Doe" />
          <div className="full"><label>Bill-To Address</label><textarea rows={2} value={form.billToAddress} onChange={(e: any) => setForm({ ...form, billToAddress: e.target.value })} /></div>
          <SectionHeader>Delivery &amp; Billing Configuration</SectionHeader>
          <Select label="Billing Type" value={form.billingType} onChange={(e: any) => setForm({ ...form, billingType: e.target.value })}
            options={[{ value: "TNM", label: "Time & Material" }, { value: "FIXED", label: "Fixed Bid" }]} />
          <Select label="Billing Scope" value={form.billingScope} onChange={(e: any) => setForm({ ...form, billingScope: e.target.value })}
            options={[{ value: "RESOURCE", label: "Resource-level" }, { value: "PROJECT", label: "Project-level" }]} />
          <Select label="Delivery Model" value={form.deliveryModel} onChange={(e: any) => setForm({ ...form, deliveryModel: e.target.value })}
            options={["OFFSHORE", "ONSITE", "HYBRID"].map((v) => ({ value: v, label: v }))} />
          <Select label="Billing Hours / Day" value={String(form.billingHoursPerDay)} onChange={(e: any) => setForm({ ...form, billingHoursPerDay: Number(e.target.value) })}
            options={[{ value: "8", label: "8 hours/day" }, { value: "9", label: "9 hours/day" }]} />
          <Select label="Status" value={form.status} onChange={(e: any) => setForm({ ...form, status: e.target.value })}
            options={["ACTIVE", "CLOSED"].map((v) => ({ value: v, label: v }))} />
          <SectionHeader>Sub-Projects</SectionHeader>
          {form.id
            ? <SubProjectsPanel projectId={form.id} />
            : <SubProjectsPanel draftRows={form.pendingSubProjects} onDraftChange={(rows) => setForm({ ...form, pendingSubProjects: rows })} />}
          <SectionHeader>Attachments</SectionHeader>
          {form.id ? <AttachmentsPanel basePath="projects" entityId={form.id} /> : <div className="full note">Save the project first to attach documents.</div>}
        </div>}
      </Modal>
    </div>
  );
}

// =====================================================================
// FX Rates
// =====================================================================
export function FxRates() {
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/fx-rates");
  const blank = { id: null, context: "DEFAULT", baseCcy: "USD", quoteCcy: "INR", rate: 93, note: "" };
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const valid = form && form.context.trim() && +form.rate > 0;
  const save = async () => {
    if (!valid) return show("Context and a positive Rate are required", "error");
    setBusy(true);
    try { if (form.id) await api.put(`/fx-rates/${form.id}`, form); else await api.post("/fx-rates", form); show("FX rate saved"); setForm(null); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (r: any) => { if (!(await confirmDel(r.context))) return; await api.del(`/fx-rates/${r.id}`); show("FX rate deleted"); reload(); };

  // ---- F5: Fiscal Years (list / add / lock / unlock / rollover) ----
  const { data: fyears, reload: reloadFy } = useFetch<any[]>("/fiscal-years");
  const [fyForm, setFyForm] = useState<any>(null);
  const [fyBusy, setFyBusy] = useState(false);
  const saveFy = async () => {
    if (!fyForm?.label?.trim()) return show("Label is required (e.g. FY26-27)", "error");
    setFyBusy(true);
    try { await api.post("/fiscal-years", { label: fyForm.label.trim(), startMonth: +fyForm.startMonth || 4 }); show("Fiscal year added"); setFyForm(null); reloadFy(); }
    catch (e: any) { show(e.message, "error"); } finally { setFyBusy(false); }
  };
  const lockFy = async (fy: any) => {
    if (!(await confirmDialog({ title: `Close & lock ${fy.label}?`, message: "Every monthly sheet in this year will be locked and edits blocked.", danger: true, confirmLabel: "Close & Lock" }))) return;
    try { await api.post(`/fiscal-years/${fy.id}/lock`); show(`${fy.label} locked`); reloadFy(); } catch (e: any) { show(e.message, "error"); }
  };
  const unlockFy = async (fy: any) => { try { await api.post(`/fiscal-years/${fy.id}/unlock`); show(`${fy.label} re-opened`); reloadFy(); } catch (e: any) { show(e.message, "error"); } };
  const rolloverFy = async (fy: any) => {
    if (!(await confirmDialog({ title: `Roll over ${fy.label}?`, message: "Creates the next fiscal year and seeds its 12 monthly sheets as drafts.", confirmLabel: "Roll Over" }))) return;
    try { const r = await api.post(`/fiscal-years/${fy.id}/rollover`); show(`Created ${r.fiscalYear.label} (${r.seededSheets} sheets)`); reloadFy(); } catch (e: any) { show(e.message, "error"); }
  };
  const deleteFy = async (fy: any) => {
    if (!(await confirmDialog({ title: `Delete ${fy.label}?`, message: "Removes this OPEN fiscal year and its empty monthly sheets. Refused if any month already has data.", danger: true, confirmLabel: "Delete" }))) return;
    try { await api.del(`/fiscal-years/${fy.id}`); show(`${fy.label} deleted`); reloadFy(); } catch (e: any) { show(e.message, "error"); }
  };

  // ---- F6: Export full Excel workbook for a fiscal year ----
  const [exportFy, setExportFy] = useState("FY26-27");
  const exportExcel = () => window.open(api.pdfUrl(`/excel-export?fiscalYear=${encodeURIComponent(exportFy)}`), "_blank");

  const [displayCcy, setDC] = useState(getDisplayCcy());
  const changeDisplay = (c: string) => { setDC(c); setDisplayCcy(c); show(`Dashboards now show amounts in ${c}`); };
  const [perPage, setPerPage] = useState(getPageSize());
  const changePerPage = (n: number) => { const v = Math.max(1, Math.min(500, Math.floor(n) || 20)); setPerPage(v); setPageSize(v); show(`Tables now show ${v} records per page`); };

  // ---- AI Report (Claude) — API key + model ----
  const [ai, setAi] = useState<any>(null);          // { configured, source, model, models }
  const [aiKey, setAiKey] = useState("");           // write-only key entry (never pre-filled)
  const [aiModel, setAiModel] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const loadAi = () => api.get("/ai-report/config").then((c) => { setAi(c); setAiModel(c.model); }).catch(() => {});
  useEffect(() => { loadAi(); }, []);
  const saveAi = async () => {
    setAiBusy(true);
    try {
      await api.put("/ai-report/config", { apiKey: aiKey || undefined, model: aiModel || undefined });
      setAiKey(""); await loadAi(); show("AI Report settings saved");
    } catch (e: any) { show(e.message, "error"); } finally { setAiBusy(false); }
  };
  const clearAiKey = async () => {
    if (!(await confirmDialog({ title: "Remove stored API key?", message: "The AI Report page will fall back to the ANTHROPIC_API_KEY environment variable (if set).", danger: true, confirmLabel: "Remove" }))) return;
    setAiBusy(true);
    try { await api.put("/ai-report/config", { clearKey: true }); await loadAi(); show("Stored API key removed"); }
    catch (e: any) { show(e.message, "error"); } finally { setAiBusy(false); }
  };

  return (
    <div>
      <h1>Settings</h1><div className="subtitle">Display preferences, pagination, and per-context FX rates — no hardcoded divisors.</div>

      <Panel title="Dashboard Display Currency" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 auto" }}>
            <label style={{ display: "block", marginBottom: 4 }}>Show all dashboard numbers in</label>
            <select value={displayCcy} onChange={(e) => changeDisplay(e.target.value)} style={{ width: 180 }}>
              <option value="USD">USD ($)</option>
              <option value="INR">INR (₹)</option>
            </select>
          </div>
          <div className="subtitle" style={{ margin: 0, flex: 1, minWidth: 260 }}>
            CEO &amp; Finance dashboards convert USD figures to the selected currency using the <b>USD_INR</b> rate below.
          </div>
        </div>
      </Panel>

      <Panel title="Pagination" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 auto" }}>
            <label style={{ display: "block", marginBottom: 4 }}>Records per page</label>
            <input type="number" min={1} max={500} value={perPage} style={{ width: 180 }}
              onChange={(e) => changePerPage(+e.target.value)} />
          </div>
          <div className="subtitle" style={{ margin: 0, flex: 1, minWidth: 260 }}>
            Applied to <b>every paginated table</b> in the app (Employees, CTC, Clients, Projects, Rates, Users, Expenses…). Default 20.
          </div>
        </div>
      </Panel>

      <Panel title="AI Report (Claude)" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 280px" }}>
            <label style={{ display: "block", marginBottom: 4 }}>Anthropic API key</label>
            <input type="password" autoComplete="off" value={aiKey} onChange={(e) => setAiKey(e.target.value)}
              placeholder={ai?.configured ? `•••••• stored (${ai.source === "env" ? "from environment" : "saved"})` : "sk-ant-…"}
              style={{ width: "100%" }} />
          </div>
          <div style={{ flex: "0 0 auto" }}>
            <label style={{ display: "block", marginBottom: 4 }}>Model</label>
            <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} style={{ width: 280 }}>
              {(ai?.models || [{ id: aiModel, label: aiModel }]).map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <AddButton onClick={saveAi} disabled={aiBusy}>Save</AddButton>
          {ai?.source === "db" && <GhostButton onClick={clearAiKey} disabled={aiBusy}>Remove key</GhostButton>}
        </div>
        <div className="subtitle" style={{ marginTop: 10, lineHeight: 1.7 }}>
          Powers the <b>Dashboards → AI Report</b> page. The key is stored write-only (never shown again) and is used only server-side to call Claude.
          {" "}Status: <b style={{ color: ai?.configured ? "#16a34a" : "#e5484d" }}>{ai?.configured ? `Configured (${ai.source === "env" ? "environment variable" : "saved key"})` : "Not configured"}</b>.
          {" "}In production you can instead set the <code>ANTHROPIC_API_KEY</code> App Service setting and leave this blank.
        </div>
      </Panel>

      <Panel title="Fiscal Years" style={{ marginBottom: 14 }}>
        <div className="btn-row"><AddButton onClick={() => setFyForm({ label: "", startMonth: 4 })}>Add Fiscal Year</AddButton></div>
        <table>
          <thead><tr><th>Label</th><th className="num">Start Month</th><th>Status</th><th>Closed</th><th>Actions</th></tr></thead>
          <tbody>
            {(fyears || []).map((fy) => (
              <tr key={fy.id}>
                <td>{fy.label}</td>
                <td className="num">{["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][(fy.startMonth - 1) % 12] || fy.startMonth}</td>
                <td><span style={{ fontWeight: 700, color: fy.status === "LOCKED" ? "#e5484d" : "#16a34a" }}>{fy.status}</span></td>
                <td>{fy.closedAt ? fmtDate(fy.closedAt) : "—"}</td>
                <td>
                  {fy.status === "LOCKED"
                    ? <button className="ghost" onClick={() => unlockFy(fy)}>Unlock</button>
                    : <button className="ghost" onClick={() => lockFy(fy)}>Close &amp; Lock</button>}
                  {" "}<button className="ghost" onClick={() => rolloverFy(fy)}>Roll Over</button>
                  {fy.status !== "LOCKED" && <>{" "}<button className="ghost" style={{ color: "var(--bad)" }} onClick={() => deleteFy(fy)}>Delete</button></>}
                </td>
              </tr>
            ))}
            {!fyears?.length && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No fiscal years defined yet.</td></tr>}
          </tbody>
        </table>
        <div className="subtitle" style={{ marginTop: 10, lineHeight: 1.7 }}>
          <b>Close &amp; Lock</b> — freezes the year: every monthly sheet in it becomes read-only and all edits (rates, hours, cost, expenses, invoices feeding off it) are blocked. Use it once a financial year is finalized so historical numbers can't change. (<b>Unlock</b> reverses it if you need to correct something.)<br />
          <b>Roll Over</b> — opens the <i>next</i> financial year: creates e.g. FY27-28 from FY26-27 and seeds its 12 monthly sheets (Apr–Mar) as empty drafts, ready to plan. It does not touch the current year's data.<br />
          <b>Delete</b> — removes an <i>OPEN</i> year and its empty months. Refused if any month already has data, and locked years can't be deleted (unlock first).
        </div>
      </Panel>

      <Panel title="Export Excel Workbook" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 auto" }}>
            <label style={{ display: "block", marginBottom: 4 }}>Fiscal Year</label>
            <select value={exportFy} onChange={(e) => setExportFy(e.target.value)} style={{ width: 180 }}>
              {(fyears && fyears.length ? fyears.map((f) => f.label) : ["FY26-27"]).map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <AddButton onClick={exportExcel}>Export Excel</AddButton>
          <div className="subtitle" style={{ margin: 0, flex: 1, minWidth: 260 }}>
            Downloads an .xlsx with a tab per month (Resource/Project/Rate/Hrs/Billing/Invoice/Cost with live formulas), an Employee Cost tab, and a Summary tab that references the monthly tabs.
          </div>
        </div>
      </Panel>

      <Modal title="Add Fiscal Year" open={!!fyForm} onClose={() => setFyForm(null)} onSave={saveFy} busy={fyBusy} canSave={!!fyForm?.label?.trim()}>
        {fyForm && <div className="form-grid">
          <Input label="Label" required value={fyForm.label} onChange={(e: any) => setFyForm({ ...fyForm, label: e.target.value })} placeholder="e.g. FY26-27" />
          <Select label="Start Month" value={fyForm.startMonth} onChange={(e: any) => setFyForm({ ...fyForm, startMonth: e.target.value })}
            options={[{ value: 4, label: "April (Apr–Mar)" }, { value: 1, label: "January (Jan–Dec)" }]} />
        </div>}
      </Modal>

      <div className="btn-row"><AddButton onClick={() => setForm({ ...blank })}>Add FX Rate</AddButton></div>
      <Panel>{loading ? "Loading…" : <DataTable rows={data || []} searchKeys={(r: any) => `${r.context} ${r.baseCcy} ${r.quoteCcy} ${r.note}`}
        columns={[
          { key: "context", label: "Context" }, { key: "pair", label: "Pair", value: (r: any) => `${r.baseCcy}/${r.quoteCcy}`, render: (r: any) => `${r.baseCcy}/${r.quoteCcy}` },
          { key: "rate", label: "Rate", num: true, value: (r: any) => r.rate, render: (r: any) => d2(r.rate) }, { key: "note", label: "Note" },
        ]}
        onEdit={(r) => setForm({ id: r.id, context: r.context, baseCcy: r.baseCcy, quoteCcy: r.quoteCcy, rate: r.rate, note: r.note || "" })}
        onDelete={del} />}</Panel>
      <Modal title={form?.id ? "Edit FX Rate" : "Add FX Rate"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!valid}>
        {form && <div className="form-grid">
          <Input label="Context" required full value={form.context} onChange={(e: any) => setForm({ ...form, context: e.target.value })} placeholder="e.g. USD_INR, CANADA_FACTOR" />
          <Input label="Base Currency" value={form.baseCcy} onChange={(e: any) => setForm({ ...form, baseCcy: e.target.value })} />
          <Input label="Quote Currency" value={form.quoteCcy} onChange={(e: any) => setForm({ ...form, quoteCcy: e.target.value })} />
          <Input label="Rate" required type="number" value={form.rate} onChange={(e: any) => setForm({ ...form, rate: e.target.value })} />
          <Input label="Note" value={form.note} onChange={(e: any) => setForm({ ...form, note: e.target.value })} />
        </div>}
      </Modal>
    </div>
  );
}
