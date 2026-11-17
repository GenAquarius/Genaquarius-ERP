import React, { useState, useEffect, useRef } from "react";
import { api } from "../../api";
import { useFetch, Panel, projectLabel, Field, fmt, ProjectMultiSelect } from "../../ui";
import { NeedYourAttention } from "../../NeedYourAttention";
import { watchRoom } from "../../realtime";
import { Modal, Input, Select, useToast, AddButton, GhostButton, EditAction, DeleteAction, TimesheetEntriesTable, confirmDialog } from "../../components";
import { useSortFilter, SortableHead, FilterToggle } from "../../DataTable";
import { FxRates } from "./Masters";
import { BusinessUnitFilterBar, TaxBracketsSettings, CloneFromDefaultBanner } from "../hrms/Hr";
import { TimesheetTemplatesTab } from "../finance/TimesheetTemplates";
import ThumbUpAltRoundedIcon from "@mui/icons-material/ThumbUpAltRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import DoneAllRoundedIcon from "@mui/icons-material/DoneAllRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import EditCalendarRoundedIcon from "@mui/icons-material/EditCalendarRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";

const CAL_NAMES = ["Jan","Feb","Mar","Apr","May","June","July","Aug","Sep","Oct","Nov","Dec"];
const calLabel = (m: number, y: number) => `${CAL_NAMES[m - 1]} ${y}`;

// ---------------- Shared: themed multi-select of projects ("Used By") ----------------
// A scrollable, checkbox list backed by the app theme variables, with selected
// items shown as removable chips. Selected ids are numbers (project ids).
const askReason = async () => confirmDialog({ title: "Reject timesheet?", prompt: true, danger: true, confirmLabel: "Reject", message: "Reason (sent back to the employee):", placeholder: "e.g. Hours look off for week 2" });

// Fiscal-month ordering (Apr..Mar) shared by F3/F8 selectors.
const FY_MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
// fiscal month label -> calendar month number (1..12). CAL_NAMES already uses the
// "June"/"July" spelling so CAL_NAMES[m-1] is the matching fiscal-month label.
const FY_TO_CAL: Record<string, number> = { Apr: 4, May: 5, June: 6, July: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12, Jan: 1, Feb: 2, Mar: 3 };

const TS_COLS = (extra: any) => [
  { key: "employee", label: "Employee", get: (t: any) => t.employee?.name },
  { key: "project", label: "Project", get: (t: any) => t.project?.name },
  { key: "period", label: "Period", get: (t: any) => t.periodYear * 100 + t.periodMonth },
  { key: "totalHours", label: "Hours", num: true },
  { key: "leaveDays", label: "Leave", num: true },
  extra,
];
const APPR_COLS = TS_COLS({ key: "days", label: "Days logged", num: true, get: (t: any) => (t.entries || []).length });
const FQ_COLS = TS_COLS({ key: "pm", label: "PM", get: (t: any) => t.approvedBy?.name });

// expandable detail row for a timesheet (day-by-day hours + tasks)
function useExpanded() {
  const [exp, setExp] = useState<Set<number>>(new Set());
  return { exp, toggle: (id: number) => setExp((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }) };
}

// ---------------- Proxy timesheet editor (PM fills on a member's behalf) ----------------
type ProxyTarget = { employeeId: number; name: string; projectId: number; projectName: string; month: number; year: number };
type PCell = { hours: number; leave: boolean; comment: string };
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function ProxyTimesheetModal({ target, onClose, onSaved }: { target: ProxyTarget | null; onClose: () => void; onSaved: () => void }) {
  const { show } = useToast();
  const [cells, setCells] = useState<Record<number, PCell>>({});
  const [picked, setPicked] = useState<Set<number>>(new Set());   // F11 — days selected for bulk apply
  const [bulkHours, setBulkHours] = useState(8);
  const [bulkTask, setBulkTask] = useState("");
  const [busy, setBusy] = useState(false);
  // Real Timesheet id, once anything's actually been saved as a draft — Export Excel/PDF need a
  // real saved record to render (same /timesheet-templates/export route "My Timesheet"/PM
  // Approvals/Finance use), so bulk-filling the grid auto-saves a draft immediately (same "no
  // separate Save step" convention My Timesheet's own calendar already follows), instead of only
  // saving on the explicit Save Draft/Submit buttons at the bottom.
  const [savedId, setSavedId] = useState<number | null>(null);
  const persistDraft = async (c: Record<number, PCell>) => {
    if (!target) return;
    try {
      const ts: any = await api.post("/timesheets/proxy", {
        employeeId: target.employeeId, projectId: target.projectId, periodMonth: target.month, periodYear: target.year, submit: false,
        entries: Object.entries(c).map(([d, e]) => ({ day: +d, hours: e.hours, leave: e.leave, comment: e.comment })),
      });
      setSavedId(ts.id);
    } catch { /* best-effort — the explicit Save Draft/Submit buttons below still work either way */ }
  };
  // reset the grid each time we open for a different person/period
  React.useEffect(() => { setCells({}); setPicked(new Set()); setBulkTask(""); setSavedId(null); }, [target?.employeeId, target?.projectId, target?.month, target?.year]);
  if (!target) return null;
  const { month, year } = target;
  const first = new Date(year, month - 1, 1).getDay();
  const days = new Date(year, month, 0).getDate();
  const isWeekend = (d: number) => { const w = new Date(year, month - 1, d).getDay(); return w === 0 || w === 6; };
  const totalHours = Object.values(cells).reduce((s, c) => s + (c.leave ? 0 : +c.hours || 0), 0);
  const leaveDays = Object.values(cells).filter((c) => c.leave).length;
  const setDay = (d: number, patch: Partial<PCell>) => setCells((s) => { const base: PCell = { hours: 8, leave: false, comment: "" }; return { ...s, [d]: { ...base, ...s[d], ...patch } }; });
  const clearDay = (d: number) => setCells((s) => { const n = { ...s }; delete n[d]; return n; });
  const fillWeekdays = () => { const n: Record<number, PCell> = { ...cells }; for (let d = 1; d <= days; d++) if (!isWeekend(d)) n[d] = { hours: 8, leave: false, comment: n[d]?.comment || "" }; setCells(n); persistDraft(n); };
  const cellBg = (d: number, c?: PCell, sel?: boolean) => sel ? "var(--row-hover)" : c?.leave ? "rgba(229,72,77,.18)" : (c && c.hours > 0) ? "rgba(52,211,153,.16)" : isWeekend(d) ? "rgba(139,150,176,.14)" : "var(--panel2)";

  // --- F11 day selection helpers ---
  const togglePick = (d: number) => setPicked((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const selectAll = () => setPicked(new Set(Array.from({ length: days }, (_, i) => i + 1)));
  const selectWeekdays = () => setPicked(new Set(Array.from({ length: days }, (_, i) => i + 1).filter((d) => !isWeekend(d))));
  const selectNone = () => setPicked(new Set());
  const applyToSelected = () => {
    if (!picked.size) return show("Select one or more days first", "error");
    setCells((s) => {
      const n = { ...s };
      picked.forEach((d) => { n[d] = { hours: bulkHours, leave: false, comment: bulkTask || n[d]?.comment || "" }; });
      persistDraft(n);
      return n;
    });
    show(`Applied ${bulkHours}h${bulkTask ? ` · "${bulkTask}"` : ""} to ${picked.size} day(s)`);
  };

  const save = async (submit: boolean) => {
    setBusy(true);
    try {
      const ts: any = await api.post("/timesheets/proxy", {
        employeeId: target.employeeId, projectId: target.projectId, periodMonth: month, periodYear: year, submit,
        // `comment` carries the task/description for each day (compatible with the proxy endpoint)
        entries: Object.entries(cells).map(([d, c]) => ({ day: +d, hours: c.hours, leave: c.leave, comment: c.comment })),
      });
      setSavedId(ts.id);
      show(submit ? "Proxy timesheet submitted to Finance" : "Proxy draft saved"); onSaved(); onClose();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Proxy Timesheet — ${target.name} · ${target.projectName} · ${calLabel(month, year)}`} open={!!target} onClose={onClose} wide>
      {/* Bulk multi-select toolbar */}
      <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <span style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600 }}>Select days:</span>
          <GhostButton onClick={selectAll}>All</GhostButton>
          <GhostButton onClick={selectWeekdays}>Weekdays</GhostButton>
          <GhostButton onClick={selectNone}>None</GhostButton>
          <span style={{ color: "var(--accent)", fontSize: 12 }}>{picked.size} selected</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ width: 90 }}>
            <label style={{ marginTop: 0 }}>Hours</label>
            <input type="number" min={0} max={24} step={0.5} value={bulkHours} onChange={(e) => setBulkHours(+e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ marginTop: 0 }}>Task / description (applied to selected days)</label>
            <input value={bulkTask} onChange={(e) => setBulkTask(e.target.value)} placeholder="e.g. Sprint 12 development" />
          </div>
          <AddButton onClick={applyToSelected} icon={<DoneAllRoundedIcon />}>Apply to selected days</AddButton>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <GhostButton onClick={fillWeekdays}>Fill weekdays @ 8h</GhostButton>
        <GhostButton onClick={() => setCells({})}>Clear all</GhostButton>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{totalHours} h · {leaveDays} leave day(s)</span>
        {/* Same export route, same labels/style as My Timesheet / PM Approvals / Finance Approved
            Hours — needs a real saved draft first (see persistDraft, auto-run on every bulk fill),
            since the export renders from the actual saved Timesheet row, not local form state. */}
        {savedId != null && <>
          <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${savedId}?format=pdf&inline=1`), "_blank")} icon={<VisibilityOutlinedIcon />}>Preview (PDF)</GhostButton>
          <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${savedId}?format=xlsx`), "_blank")}>Export Excel</GhostButton>
        </>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
        {WD.map((d, i) => <div key={d} style={{ textAlign: "center", color: i === 0 || i === 6 ? "var(--accent)" : "var(--muted)", fontSize: 12, fontWeight: 600, padding: "4px 0" }}>{d}</div>)}
        {Array.from({ length: first }).map((_, i) => <div key={"b" + i} />)}
        {Array.from({ length: days }).map((_, i) => {
          const d = i + 1; const c = cells[d]; const sel = picked.has(d);
          return (
            <div key={d} style={{ minHeight: 104, borderRadius: 8, padding: 6, border: `1px solid ${sel ? "var(--accent)" : "var(--border)"}`, background: cellBg(d, c, sel) }}>
              <div style={{ fontSize: 12, color: "var(--text)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, cursor: "pointer" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={sel} onChange={() => togglePick(d)} />
                  <span style={{ fontWeight: isWeekend(d) ? 700 : 500, color: isWeekend(d) ? "var(--accent)" : "var(--text)" }}>{d}</span>
                </label>
                {c && <span onClick={() => clearDay(d)} style={{ cursor: "pointer", color: "var(--bad)", fontSize: 12, fontWeight: 700 }}>✕</span>}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, marginTop: 4, cursor: "pointer", color: "var(--muted)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={!!c?.leave} onChange={(e) => setDay(d, { leave: e.target.checked })} /> Leave
              </label>
              {!c?.leave && <>
                <input type="number" min={0} max={24} step={0.5} placeholder="h" value={c?.hours ?? ""} onChange={(e) => setDay(d, { hours: +e.target.value })} style={{ fontSize: 12, padding: "2px 4px", marginTop: 4 }} />
                <input placeholder="task" value={c?.comment ?? ""} onChange={(e) => setDay(d, { comment: e.target.value })} style={{ fontSize: 11, padding: "2px 4px", marginTop: 4 }} />
              </>}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <AddButton onClick={() => save(false)} disabled={busy} icon={<EditCalendarRoundedIcon />}>{busy ? "Saving…" : "Save Draft"}</AddButton>
        <AddButton onClick={() => save(true)} disabled={busy} icon={<SendRoundedIcon />}>{busy ? "Saving…" : "Save & Submit to Finance"}</AddButton>
      </div>
    </Modal>
  );
}

// ---------------- Timesheet Approvals (Project Manager + admins) ----------------
// One project's Filed/Missing breakdown for the "by month" mode (Project — filed vs missing for a
// period panel) — roster comes from Monthly Forecast (MonthlyLine, via /project-month-detail),
// NOT the static EmployeeProject assignment table the Client->Project cascade mode above still
// uses, since Monthly Forecast is what's actually billed that month (deployment start/end, bench
// moves honored) and is what the user asked this mode to be driven by. Self-contained — fetches
// its own data and reloads independently so one project's Approve/Reject doesn't refetch every
// other project's row in the list.
function ForecastProjectRow({ projectId, projectName, calMonth, year, setProxy }: { projectId: number; projectName: string; calMonth: number; year: number; setProxy: (p: ProxyTarget | null) => void }) {
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const { data, loading, reload } = useFetch<any>(open ? `/timesheets/project-month-detail?projectId=${projectId}&periodMonth=${calMonth}&periodYear=${year}` : "/health", [open, projectId, calMonth, year]);
  const rows: any[] = open ? (data?.rows || []) : [];
  const filed = rows.filter((r) => r.status !== "NOT_SUBMITTED");
  const missing = rows.filter((r) => r.status === "NOT_SUBMITTED");

  const approve = async (id: number) => { try { await api.post(`/timesheets/${id}/approve`, {}); show("Approved → sent to Finance"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const reject = async (id: number) => { const reason = await askReason(); if (reason === null) return; try { await api.post(`/timesheets/${id}/reject`, { reason: reason || "Rejected" }); show("Rejected"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const submitToFinance = async (id: number) => { try { await api.post(`/timesheets/${id}/submit`, {}); show("Submitted for approval"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const remind = async (employeeId: number, name: string) => {
    try { const r = await api.post("/timesheets/remind", { employeeId, projectId, month: calMonth, year }); show(`Reminder sent to ${r.reminded} for ${r.period}`); }
    catch (e: any) { show(e.message, "error"); }
  };
  const nudge = async (employeeId: number, name: string) => {
    try { await api.post(`/timesheets/nudge/${employeeId}`, { periodMonth: calMonth, periodYear: year }); show(`${name} will see a pending action until this timesheet clears approval`); }
    catch (e: any) { show(e.message, "error"); }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 600 }}>{projectName}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {open && <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export-report/${projectId}?periodMonth=${calMonth}&periodYear=${year}&format=xlsx`), "_blank")}>Export Report (Excel)</GhostButton>}
          <GhostButton icon={<VisibilityOutlinedIcon />} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "View"}</GhostButton>
        </div>
      </div>
      {open && (loading ? "Loading…" : (
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          <div>
            <h2>Filed ({filed.length})</h2>
            <table>
              <thead><tr><th>Employee</th><th className="num">Hours</th><th>Status</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
              <tbody>{filed.length === 0 ? <tr><td colSpan={4} style={{ color: "var(--muted)" }}>Nobody has filed yet.</td></tr> :
                filed.map((t: any) => (
                  <tr key={t.timesheetId}><td>{t.resourceName}</td><td className="num">{t.totalHours}</td><td>{t.status}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {t.status === "REJECTED" && <GhostButton onClick={() => submitToFinance(t.timesheetId)} icon={<SendRoundedIcon />}>Submit</GhostButton>}
                      {t.status === "SUBMITTED" && <><AddButton onClick={() => approve(t.timesheetId)} icon={<ThumbUpAltRoundedIcon />}>Approve</AddButton>{" "}<GhostButton onClick={() => reject(t.timesheetId)} icon={<CloseRoundedIcon />}>Reject</GhostButton></>}
                      {(t.status === "PM_APPROVED" || t.status === "FINANCE_APPROVED") && <span style={{ color: "var(--muted)", fontSize: 12 }}>{t.status === "FINANCE_APPROVED" ? "Finance ✓" : "with Finance"}</span>}
                    </td></tr>
                ))}</tbody>
            </table>
          </div>
          <div>
            <h2>Missing ({missing.length})</h2>
            <table>
              <thead><tr><th>Employee</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
              <tbody>{missing.length === 0 ? <tr><td colSpan={2} style={{ color: "var(--muted)" }}>Everyone deployed here has filed.</td></tr> :
                missing.map((m: any, i: number) => (
                  <tr key={m.employeeId ?? `n-${i}`}><td>{m.resourceName}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {m.employeeId && <>
                        <GhostButton onClick={() => remind(m.employeeId, m.resourceName)} icon={<NotificationsActiveRoundedIcon />}>Send Reminder</GhostButton>{" "}
                        <GhostButton onClick={() => nudge(m.employeeId, m.resourceName)}>Start Pending Action</GhostButton>{" "}
                        <AddButton onClick={() => setProxy({ employeeId: m.employeeId, name: m.resourceName, projectId, projectName, month: calMonth, year })} icon={<EditCalendarRoundedIcon />}>Proxy Timesheet</AddButton>
                      </>}
                    </td></tr>
                ))}</tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Approvals() {
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/timesheets/pending");
  // NOT /projects (admin-only — a PM reviewing approvals would get a 403 and see an empty
  // dropdown). This returns every project for admin/Finance, or just the ones a PM is actually
  // assigned to as PM, matching the same scoping /timesheets/pending itself already enforces.
  const { data: projects } = useFetch<any[]>("/timesheets/managed-projects");
  // Live — an employee submitting their timesheet, or a Timesheet pending-action opening/closing
  // anywhere, refreshes this queue without a manual reload.
  useEffect(() => watchRoom("pending:activity", "pending:activity", () => { reload(); reloadTeam(); reloadApv(); }), []);
  const { exp, toggle } = useExpanded();
  const sf = useSortFilter(data || [], APPR_COLS);

  // F8 — per-project filed vs missing for a chosen period (client → project cascade)
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const clients = React.useMemo(() => {
    const m = new Map<number, string>();
    (projects || []).forEach((p: any) => { if (p.client) m.set(p.client.id, p.client.name); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [projects]);
  // Closed projects excluded from this filed-vs-missing picker — same reasoning as every other
  // project picker touched by the Vancity/Clarien Sub-Project consolidation.
  const clientProjects = (projects || []).filter((p: any) => p.status !== "CLOSED" && (!clientId || String(p.client?.id) === clientId));
  const [fyMonth, setFyMonth] = useState("Apr");
  const [year, setYear] = useState(2026);
  const calMonth = FY_TO_CAL[fyMonth];
  const teamPath = projectId ? `/timesheets/approvals?projectId=${projectId}&month=${calMonth}&year=${year}` : "";
  const { data: team, loading: tl, reload: reloadTeam } = useFetch<{ filed: any[]; missing: any[] }>(teamPath || "/timesheets/pending", [projectId, calMonth, year]);
  const showTeam = !!projectId;
  const [proxy, setProxy] = useState<ProxyTarget | null>(null);

  // Alternate mode — skip Client/Project entirely, just a Month: every project Monthly Forecast
  // shows deployed that month (not just the ones a Client happens to be picked for).
  const [byMonth, setByMonth] = useState(false);
  const { data: forecastProjects, loading: fpLoading } = useFetch<any[]>(byMonth ? `/timesheets/projects-with-forecast?month=${calMonth}&year=${year}` : "/health", [byMonth, calMonth, year]);

  // Approved Timesheets — by Client & Month: a cross-project, approved-only view (PM_APPROVED or
  // FINANCE_APPROVED) so a PM/Finance can see everything cleared for a whole client at a glance,
  // instead of checking project-by-project. Own Client picker (independent of the Filed/Missing
  // cascade above), same Month/Year already selected on this page.
  const [apvClientId, setApvClientId] = useState("");
  const { data: apvRows, loading: apvLoading, reload: reloadApv } = useFetch<any[]>(
    apvClientId ? `/timesheets/approved-by-client?clientId=${apvClientId}&month=${calMonth}&year=${year}` : "/health",
    [apvClientId, calMonth, year]
  );

  const approve = async (id: number) => { try { await api.post(`/timesheets/${id}/approve`, {}); show("Approved → sent to Finance"); reload(); reloadTeam(); } catch (e: any) { show(e.message, "error"); } };
  const reject = async (id: number) => { const reason = await askReason(); if (reason === null) return; try { await api.post(`/timesheets/${id}/reject`, { reason: reason || "Rejected" }); show("Rejected"); reload(); reloadTeam(); reloadApv(); } catch (e: any) { show(e.message, "error"); } };
  const submitToFinance = async (id: number) => { try { await api.post(`/timesheets/${id}/submit`, {}); show("Submitted for approval"); reload(); reloadTeam(); } catch (e: any) { show(e.message, "error"); } };
  const remind = async (m: any) => {
    try { const r = await api.post("/timesheets/remind", { employeeId: m.id, projectId: Number(projectId), month: calMonth, year }); show(`Reminder sent to ${r.reminded} for ${r.period}`); }
    catch (e: any) { show(e.message, "error"); }
  };
  // Persistent pending action — shows as a badge on the employee's own Dashboard and repeats a
  // daily reminder email automatically until either the PM approves their submission or a PM/
  // CTO closes it manually — distinct from "Send Reminder" above, which is a one-off email only.
  const nudge = async (m: any) => {
    try { await api.post(`/timesheets/nudge/${m.id}`, { periodMonth: calMonth, periodYear: year }); show(`${m.name} will see a pending action until this timesheet clears approval`); }
    catch (e: any) { show(e.message, "error"); }
  };
  const projName = (projects || []).find((p: any) => String(p.id) === projectId)?.name || "";

  return (
    <div>
      <h1>Timesheet Approvals</h1>
      <NeedYourAttention />
      <div className="subtitle">Submitted by employees, awaiting <b>Project Manager</b> approval. Click <b>View</b> to see the day-by-day hours &amp; tasks. Approving forwards the timesheet to Finance.</div>

      <Panel title="Project — filed vs missing for a period" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 13 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}><input type="radio" checked={!byMonth} onChange={() => setByMonth(false)} /> By Project</label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}><input type="radio" checked={byMonth} onChange={() => setByMonth(true)} /> By Month — every active project deployed in Monthly Forecast</label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
          {!byMonth && <>
          <div><label style={{ display: "block", marginBottom: 4 }}>Client</label>
            <select value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(""); }} style={{ width: 200 }}>
              <option value="">— select client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label style={{ display: "block", marginBottom: 4 }}>Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 240 }} disabled={!clientId}>
              <option value="">{clientId ? "— select project —" : "— select client first —"}</option>
              {clientProjects.map((p: any) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
            </select></div>
          </>}
          <div><label style={{ display: "block", marginBottom: 4 }}>Month</label>
            <select value={fyMonth} onChange={(e) => setFyMonth(e.target.value)} style={{ width: 110 }}>
              {FY_MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select></div>
          <div><label style={{ display: "block", marginBottom: 4 }}>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(+e.target.value)} style={{ width: 90 }} /></div>
          {/* Whole-project report — every resource on this project for the selected period in one
              document (Summary Report + per-resource Task×Day grid), not just one person's sheet.
              Same route Finance's Invoice/Approved Hours screens use, now also open to the
              project's own assigned PM (routes/finance/timesheetTemplates.ts). */}
          {!byMonth && showTeam && <div style={{ display: "flex", gap: 8 }}>
            <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export-report/${projectId}?periodMonth=${calMonth}&periodYear=${year}&format=xlsx`), "_blank")}>Export Report (Excel)</GhostButton>
          </div>}
        </div>
        {byMonth ? (() => {
          // Array.isArray, not just truthy — the conditional path above sometimes still holds the
          // PREVIOUS path's response shape for one render (e.g. "/health"'s {ok,service} object)
          // before this fetch's own data lands; a plain `|| []` only catches null/undefined, not
          // "truthy but not an array", which is exactly what crashed this toggle before.
          const fp = Array.isArray(forecastProjects) ? forecastProjects : [];
          return fpLoading ? "Loading…" : fp.length === 0 ? <div style={{ color: "var(--muted)" }}>No project has anyone deployed in Monthly Forecast for {fyMonth} {year}.</div> :
            fp.map((p: any) => <ForecastProjectRow key={p.id} projectId={p.id} projectName={p.clientName ? `${p.name} (${p.clientName})` : p.name} calMonth={calMonth} year={year} setProxy={setProxy} />);
        })() : !showTeam ? <div style={{ color: "var(--muted)" }}>Select a project to see who has filed and who is missing for the chosen month.</div> :
         tl ? "Loading…" : (
          <div className="grid cols-2">
            <div>
              <h2>Filed ({team?.filed?.length || 0})</h2>
              <table>
                <thead><tr><th>Employee</th><th className="num">Hours</th><th>Status</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
                <tbody>{(team?.filed || []).length === 0 ? <tr><td colSpan={4} style={{ color: "var(--muted)" }}>Nobody has filed yet.</td></tr> :
                  team!.filed.map((t: any) => (
                    <tr key={t.id}><td>{t.employee?.name}</td><td className="num">{t.totalHours}</td><td>{t.status}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {(t.status === "DRAFT" || t.status === "REJECTED") && <GhostButton onClick={() => submitToFinance(t.id)} icon={<SendRoundedIcon />}>Submit</GhostButton>}
                        {t.status === "SUBMITTED" && <><AddButton onClick={() => approve(t.id)} icon={<ThumbUpAltRoundedIcon />}>Approve</AddButton>{" "}<GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject</GhostButton></>}
                        {(t.status === "PM_APPROVED" || t.status === "FINANCE_APPROVED") && <span style={{ color: "var(--muted)", fontSize: 12 }}>{t.status === "FINANCE_APPROVED" ? "Finance ✓" : "with Finance"}</span>}
                      </td></tr>
                  ))}</tbody>
              </table>
            </div>
            <div>
              <h2>Missing ({team?.missing?.length || 0})</h2>
              <table>
                <thead><tr><th>Employee</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
                <tbody>{(team?.missing || []).length === 0 ? <tr><td colSpan={2} style={{ color: "var(--muted)" }}>Everyone on this project has filed.</td></tr> :
                  team!.missing.map((m: any) => (
                    <tr key={m.id}><td>{m.name}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <GhostButton onClick={() => remind(m)} icon={<NotificationsActiveRoundedIcon />}>Send Reminder</GhostButton>{" "}
                        <GhostButton onClick={() => nudge(m)}>Start Pending Action</GhostButton>{" "}
                        <AddButton onClick={() => setProxy({ employeeId: m.id, name: m.name, projectId: Number(projectId), projectName: projName, month: calMonth, year })} icon={<EditCalendarRoundedIcon />}>Proxy Timesheet</AddButton>
                      </td></tr>
                  ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Approved Timesheets — by Client &amp; Month" style={{ marginBottom: 14 }}>
        <div className="subtitle" style={{ margin: "0 0 10px" }}>Every PM-approved or Finance-approved timesheet across a client's projects for {fyMonth} {year} — one place to confirm everything's cleared without checking project-by-project.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
          <div><label style={{ display: "block", marginBottom: 4 }}>Client</label>
            <select value={apvClientId} onChange={(e) => setApvClientId(e.target.value)} style={{ width: 200 }}>
              <option value="">— select client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
        </div>
        {!apvClientId ? <div style={{ color: "var(--muted)" }}>Select a client to see its approved timesheets for {fyMonth} {year}.</div> :
         apvLoading ? "Loading…" : (() => {
          const rows = Array.isArray(apvRows) ? apvRows : [];
          return (
          <table>
            <thead><tr><th>Employee</th><th>Project</th><th className="num">Hours</th><th>Status</th><th>Approved By (PM)</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
            <tbody>{rows.length === 0 ? <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No approved timesheets for this client in {fyMonth} {year}.</td></tr> :
              rows.map((t: any) => (
                <tr key={t.id}><td>{t.employeeName}</td><td>{t.projectName}</td><td className="num">{t.totalHours}</td>
                  <td><span className={`pill ${t.status === "FINANCE_APPROVED" ? "good" : "warn"}`}>{t.status === "FINANCE_APPROVED" ? "Finance ✓" : "with Finance"}</span></td>
                  <td>{t.approvedByName || "—"}</td>
                  <td style={{ textAlign: "right" }}><GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject</GhostButton></td>
                </tr>
              ))}</tbody>
          </table>
          );
        })()}
      </Panel>

      <Panel title="Awaiting Project Manager approval (all projects)">
        <div style={{ marginBottom: 8 }}><FilterToggle sf={sf} /></div>
        {loading ? "Loading…" : <table>
        <SortableHead cols={APPR_COLS} sf={sf} leading={<th></th>} trailing={<th style={{ textAlign: "right" }}>Action</th>} />
        <tbody>{sf.view.length === 0 ? <tr><td colSpan={8} style={{ color: "var(--muted)" }}>No submitted timesheets awaiting approval.</td></tr> :
          sf.view.map((t: any) => (
            <React.Fragment key={t.id}>
            <tr>
              <td><GhostButton onClick={() => toggle(t.id)} icon={<VisibilityOutlinedIcon />}>{exp.has(t.id) ? "Hide" : "View"}</GhostButton></td>
              <td>{t.employee?.name}</td><td>{t.project?.name}</td><td>{calLabel(t.periodMonth, t.periodYear)}</td>
              <td className="num">{t.totalHours}</td><td className="num">{t.leaveDays}</td>
              <td className="num">{(t.entries || []).length}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <AddButton onClick={() => approve(t.id)} icon={<ThumbUpAltRoundedIcon />}>Approve</AddButton>{" "}
                <GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject</GhostButton>
              </td>
            </tr>
            {exp.has(t.id) && (
              <tr><td colSpan={8} style={{ background: "var(--panel2)", padding: 12 }}>
                {/* Lets the PM download/check the actual document before deciding — same export
                    route "My Timesheet" uses for an employee's own sheet, already authorized
                    server-side for the assigned PM (routes/finance/timesheetTemplates.ts). */}
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${t.id}?format=xlsx`), "_blank")}>Export Excel</GhostButton>
                </div>
                <TimesheetEntriesTable periodMonth={t.periodMonth} periodYear={t.periodYear} entries={t.entries} />
              </td></tr>
            )}
            </React.Fragment>
          ))}</tbody>
      </table>}</Panel>

      <ProxyTimesheetModal target={proxy} onClose={() => setProxy(null)} onSaved={() => { reload(); reloadTeam(); }} />
    </div>
  );
}

// ---------------- Finance approval + Approved Hours ----------------
// Read-only — exactly what Approve & Reflect would do to the matching Monthly Forecast line
// (same server-side lookup, see resolveTimesheetTarget in timesheets.ts), shown before Finance
// actually commits to it.
function FinanceApprovePreview({ id }: { id: number }) {
  const { data: p, loading } = useFetch<any>(`/timesheets/${id}/finance-approve-preview`);
  if (loading) return <div className="note" style={{ marginBottom: 8 }}>Checking Monthly Forecast impact…</div>;
  if (!p?.found) return <div className="note" style={{ marginBottom: 8, color: "var(--bad, #e5484d)" }}>Won't reflect into Monthly Forecast — {p?.reason || "unknown reason"} ({p?.month} {p?.fiscalYear}).</div>;
  const hoursChanged = p.currentActualHours !== p.newActualHours;
  const invoiceChanged = p.currentInvoiceAmount !== p.newInvoiceAmount;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="note" style={{ marginBottom: 4 }}>Impact on Monthly Forecast — {p.month} {p.fiscalYear} ({p.projectName}), the current row vs. what Approve &amp; Reflect would change it to:</div>
      <table>
        <thead><tr><th>Field</th><th className="num">Current (today's row)</th><th className="num">After Approve &amp; Reflect</th></tr></thead>
        <tbody>
          <tr>
            <td>Actual Hours</td>
            <td className="num">{p.currentActualHours} h</td>
            <td className="num" style={hoursChanged ? { color: "var(--accent)", fontWeight: 700 } : undefined}>{p.newActualHours} h</td>
          </tr>
          <tr>
            <td>Invoice Amount (USD)</td>
            <td className="num">{fmt(p.currentInvoiceAmount)}</td>
            <td className="num" style={invoiceChanged ? { color: "var(--accent)", fontWeight: 700 } : undefined}>{fmt(p.newInvoiceAmount)}</td>
          </tr>
          <tr>
            <td style={{ color: "var(--muted)" }}>Billing Amount (unchanged by Finance approval)</td>
            <td className="num" colSpan={2} style={{ color: "var(--muted)" }}>{fmt(p.currentBillingAmount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Project+Month rollup of every submitted-or-later timesheet, Pending vs Approved — lets Finance
// see status at the project level instead of hunting through the resource-level queue below one
// row at a time. "View" expands into ProjectMonthDetail below.
const PM_STATUS_PILL: Record<string, string> = { APPROVED: "good", PENDING: "warn", REJECTED: "bad" };
function ProjectMonthStatusPanel() {
  const { data: overview, loading } = useFetch<any[]>("/timesheets/project-month-overview");
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "APPROVED">("ALL");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const rows = (overview || []).filter((r) => filter === "ALL" || r.status === filter);
  return (
    <Panel title="Projects — Timesheet Status by Month" style={{ marginBottom: 14 }}>
      <div className="subtitle" style={{ marginBottom: 8 }}>
        Every project/month with at least one submitted timesheet, rolled up Pending vs Approved. Click <b>View</b> to see everyone Monthly Forecast shows deployed that month and where each person's timesheet stands.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {(["ALL", "PENDING", "APPROVED"] as const).map((f) => (
          <GhostButton key={f} onClick={() => setFilter(f)} style={filter === f ? { fontWeight: 700, color: "var(--accent)" } : undefined}>{f === "ALL" ? "All" : f === "PENDING" ? "Pending" : "Approved"}</GhostButton>
        ))}
      </div>
      {loading ? "Loading…" : (
        <table>
          <thead><tr><th></th><th>Project</th><th>Month</th><th>Status</th><th className="num">Approved</th><th className="num">Pending</th><th className="num">Rejected</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={7} style={{ color: "var(--muted)" }}>Nothing to show.</td></tr> :
            rows.map((r) => {
              const key = `${r.projectId}-${r.periodYear}-${r.periodMonth}`;
              const open = expandedKey === key;
              return (
                <React.Fragment key={key}>
                  <tr>
                    <td><GhostButton icon={<VisibilityOutlinedIcon />} onClick={() => setExpandedKey(open ? null : key)}>{open ? "Hide" : "View"}</GhostButton></td>
                    <td>{r.projectName}</td><td>{calLabel(r.periodMonth, r.periodYear)}</td>
                    <td><span className={`pill ${PM_STATUS_PILL[r.status] || ""}`}>{r.status}</span></td>
                    <td className="num">{r.approved}</td><td className="num">{r.pending}</td><td className="num">{r.rejected}</td>
                  </tr>
                  {open && (
                    <tr><td colSpan={7} style={{ background: "var(--panel2)", padding: 12 }}>
                      <ProjectMonthDetail projectId={r.projectId} periodMonth={r.periodMonth} periodYear={r.periodYear} />
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

const PM_DETAIL_STATUS_LABEL: Record<string, string> = { NOT_SUBMITTED: "Not Submitted", DRAFT: "Draft (not submitted)", SUBMITTED: "Pending PM", PM_APPROVED: "Pending Finance", FINANCE_APPROVED: "Finance Approved", REJECTED: "Rejected" };
const PM_DETAIL_STATUS_CLASS: Record<string, string> = { SUBMITTED: "warn", PM_APPROVED: "warn", FINANCE_APPROVED: "good", REJECTED: "bad" };
// One Project+Month's full Monthly Forecast roster (not the static EmployeeProject assignment
// list — Monthly Forecast is what's actually billed that month) cross-referenced against each
// person's timesheet status, with per-resource day-by-day View.
function ProjectMonthDetail({ projectId, periodMonth, periodYear }: { projectId: number; periodMonth: number; periodYear: number }) {
  const { data, loading } = useFetch<any>(`/timesheets/project-month-detail?projectId=${projectId}&periodMonth=${periodMonth}&periodYear=${periodYear}`);
  const { exp, toggle } = useExpanded();
  if (loading) return <div>Loading…</div>;
  if (!data) return <div className="note">Couldn't load detail.</div>;
  return (
    <div>
      {!data.sheetFound && <div className="note" style={{ marginBottom: 8, color: "var(--bad, #e5484d)" }}>No {data.month} {data.fiscalYear} Monthly Forecast sheet found — showing timesheet filers only, not full Monthly Forecast deployment.</div>}
      <table>
        <thead><tr><th>Resource</th><th>Status</th><th className="num">Hours</th><th className="num">Leave</th><th></th></tr></thead>
        <tbody>
          {data.rows.length === 0 ? <tr><td colSpan={5} style={{ color: "var(--muted)" }}>Nobody deployed on this project for {data.month} {data.fiscalYear}.</td></tr> :
          data.rows.map((r: any, i: number) => (
            <React.Fragment key={r.employeeId ?? `n-${i}`}>
              <tr>
                <td>{r.resourceName}</td>
                <td><span className={`pill ${PM_DETAIL_STATUS_CLASS[r.status] || ""}`}>{PM_DETAIL_STATUS_LABEL[r.status] || r.status}</span></td>
                <td className="num">{r.totalHours ?? "—"}</td><td className="num">{r.leaveDays ?? "—"}</td>
                <td style={{ textAlign: "right" }}>{r.timesheetId && <GhostButton onClick={() => toggle(r.timesheetId)}>{exp.has(r.timesheetId) ? "Hide" : "View"}</GhostButton>}</td>
              </tr>
              {r.timesheetId && exp.has(r.timesheetId) && (
                <tr><td colSpan={5} style={{ background: "var(--panel)", padding: 10 }}>
                  <TimesheetEntriesTable periodMonth={periodMonth} periodYear={periodYear} entries={r.entries} />
                </td></tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApprovedHours() {
  const { show } = useToast();
  const { data: queue, loading: ql, reload: reloadQ } = useFetch<any[]>("/timesheets/finance-queue");
  const { data: approved, loading: al, reload: reloadA } = useFetch<any[]>("/timesheets/approved");
  // Live — a PM approving/rejecting (or an employee submitting) anywhere pings this same room
  // (emitPendingActionsUpdate), so Finance's own queue refreshes without a manual reload.
  useEffect(() => watchRoom("pending:activity", "pending:activity", () => { reloadQ(); reloadA(); }), []);
  const [fy, setFy] = useState("FY26-27");
  const [month, setMonth] = useState("All");                 // F3 — fiscal-month filter (Apr..Mar)
  const { exp, toggle } = useExpanded();
  // filter both tables by the selected fiscal month (calendar month match)
  const monthFilter = (rows: any[] | null) => (rows || []).filter((t) => month === "All" || t.periodMonth === FY_TO_CAL[month]);
  const fsf = useSortFilter(monthFilter(queue), FQ_COLS);
  const approvedRows = monthFilter(approved);
  const reloadBoth = () => { reloadQ(); reloadA(); };

  const financeApprove = async (id: number) => {
    try { const r = await api.post(`/timesheets/${id}/finance-approve`, {}); show(r?.mapping?.applied ? `Approved → reflected into ${r.mapping.month} ${r.mapping.fiscalYear} Invoice (${r.mapping.hours} h)` : `Approved (not reflected: ${r?.mapping?.reason || "no matching line"})`, r?.mapping?.applied ? "success" : "error"); reloadBoth(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const reject = async (id: number) => { const reason = await askReason(); if (reason === null) return; try { await api.post(`/timesheets/${id}/reject`, { reason: reason || "Rejected" }); show("Rejected"); reloadBoth(); } catch (e: any) { show(e.message, "error"); } };
  const reapply = async (id: number) => { try { const r = await api.post(`/timesheets/${id}/apply-to-sheet`, { fiscalYear: fy }); show(`Re-applied to ${r.month} ${r.fiscalYear}`); reloadA(); } catch (e: any) { show("Error: " + e.message, "error"); } };

  return (
    <div>
      <h1>Finance — Approved Hours</h1>
      <div className="subtitle">PM-approved timesheets awaiting <b>Finance</b> sign-off. Click <b>View</b> for day-by-day detail. Approving reflects the hours into that month's <b>Invoice column</b> on Forecast Monthly Revenue &amp; Expenses.</div>

      <ProjectMonthStatusPanel />

      <Panel title="Awaiting Finance Approval" style={{ marginBottom: 14 }}>
        <div style={{ marginBottom: 8 }}><FilterToggle sf={fsf} /></div>
        {ql ? "Loading…" : <table>
        <SortableHead cols={FQ_COLS} sf={fsf} leading={<th></th>} trailing={<th style={{ textAlign: "right" }}>Action</th>} />
        <tbody>{fsf.view.length === 0 ? <tr><td colSpan={8} style={{ color: "var(--muted)" }}>Nothing awaiting Finance approval.</td></tr> :
          fsf.view.map((t: any) => (
            <React.Fragment key={t.id}>
            <tr>
              <td><GhostButton onClick={() => toggle(t.id)} icon={<VisibilityOutlinedIcon />}>{exp.has(t.id) ? "Hide" : "View"}</GhostButton></td>
              <td>{t.employee?.name}</td><td>{t.project?.name}</td><td>{calLabel(t.periodMonth, t.periodYear)}</td>
              <td className="num">{t.totalHours}</td><td className="num">{t.leaveDays}</td><td>{t.approvedBy?.name || "—"}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <AddButton onClick={() => financeApprove(t.id)} icon={<ThumbUpAltRoundedIcon />}>Approve &amp; Reflect</AddButton>{" "}
                <GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject</GhostButton>
              </td>
            </tr>
            {exp.has(t.id) && (
              <tr><td colSpan={8} style={{ background: "var(--panel2)", padding: 12 }}>
                <FinanceApprovePreview id={t.id} />
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${t.id}?format=xlsx`), "_blank")}>Export Excel</GhostButton>
                </div>
                <TimesheetEntriesTable periodMonth={t.periodMonth} periodYear={t.periodYear} entries={t.entries} />
              </td></tr>
            )}
            </React.Fragment>
          ))}</tbody>
      </table>}</Panel>

      <div className="row" style={{ marginBottom: 10, alignItems: "flex-end", gap: 14 }}>
        <div style={{ flex: 0 }}><label>Month</label>
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 120 }}>
            <option value="All">All months</option>
            {FY_MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select></div>
        <div style={{ flex: 0 }}><label>Re-apply into Fiscal Year</label>
          <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 140 }}>
            <option value="FY26-27">FY26-27</option><option value="FY25-26">FY25-26</option>
          </select></div>
      </div>
      <Panel title="Finance Approved (reflected in monthly Invoice)">{al ? "Loading…" : <table>
        <thead><tr><th>Employee</th><th>Project</th><th>Period</th><th className="num">Hours</th><th className="num">Leave</th><th>PM</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
        <tbody>{approvedRows.length === 0 ? <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No finance-approved timesheets{month !== "All" ? ` for ${month}` : ""} yet.</td></tr> :
          approvedRows.map((t) => (
            <tr key={t.id}><td>{t.employee?.name}</td><td>{t.project?.name}</td><td>{calLabel(t.periodMonth, t.periodYear)}</td>
              <td className="num">{t.totalHours}</td><td className="num">{t.leaveDays}</td><td>{t.approvedBy?.name || "—"}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <GhostButton onClick={() => reapply(t.id)} icon={<ReplayRoundedIcon />}>Re-apply</GhostButton>{" "}
                <GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject</GhostButton>
              </td></tr>
          ))}</tbody>
      </table>}</Panel>
    </div>
  );
}

// ---------------- Invoice Templates (form-based, per region: US / Canada / India) ----------------
const TPL_COLS = [
  { key: "name", label: "Name" },
  { key: "region", label: "Region", get: (t: any) => t.layoutConfig?.region },
  { key: "issuer", label: "Issuer", get: (t: any) => t.issuerBlock?.company },
  { key: "bank", label: "Bank", get: (t: any) => t.bankDetails?.bankName },
  { key: "usedby", label: "Used by (projects)", get: (t: any) => (t.projects || []).map((p: any) => p.name).join(", ") },
];

// small inline chip list for table cells
function ChipList({ names }: { names: string[] }) {
  if (!names.length) return <span style={{ color: "var(--muted)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {names.map((n, i) => <span key={i} className="pill" style={{ color: "var(--text)" }}>{n}</span>)}
    </span>
  );
}
const blankTemplate = () => ({
  id: null, name: "", region: "US",
  company: "", address: "", website: "", contact: "",
  bankName: "", terms: "Net 30 Days", bankLines: "",
  projectIds: [] as number[],
});

// build the legacy/structured bank into verbatim lines for display when editing an old template
function legacyLines(b: any): string[] {
  const out: string[] = [];
  if (b.accountNumber) out.push(`${b.accountLabel || "Account #"}: ${b.accountNumber}`);
  else if (b.account) out.push(`ACCOUNT # ${b.account}, ROUTING # ${b.routingPaper} (Paper & Electronic) Or ${b.routingWire} (Wires)`);
  if (b.routingNumber) out.push(`${b.routingLabel || "Routing"}: ${b.routingNumber}`);
  if (b.swift) out.push(`SWIFT/BIC: ${b.swift}`);
  if (b.bankAddress) out.push(`Bank Address: ${b.bankAddress}`);
  if (b.officeAddress) out.push(`Office Address: ${b.officeAddress}`);
  return out;
}
function toForm(t: any) {
  const i = t.issuerBlock || {}, b = t.bankDetails || {};
  const lines = Array.isArray(b.lines) && b.lines.length ? b.lines : legacyLines(b);
  return {
    id: t.id, name: t.name, region: (t.layoutConfig && t.layoutConfig.region) || "US",
    company: i.company || "", address: (i.addressLines || []).join("\n"), website: i.website || "", contact: i.contact || "",
    bankName: b.bankName || "", terms: b.terms || "Net 30 Days", bankLines: lines.join("\n"),
    projectIds: (t.projects || []).map((p: any) => p.id),
  };
}
function toPayload(f: any) {
  return {
    name: f.name,
    issuerBlock: { company: f.company, addressLines: f.address.split("\n").map((s: string) => s.trimEnd()), website: f.website, contact: f.contact },
    bankDetails: { bankName: f.bankName, terms: f.terms, lines: f.bankLines.split("\n").map((s: string) => s.trim()).filter(Boolean) },
    layoutConfig: { region: f.region, showAnnexure: true },
    projectIds: (f.projectIds || []) as number[],
  };
}

// Consolidated Finance settings hub — mirrors the HR Settings tab pattern (see Hr.tsx's
// HrSettings) so every module's configuration knobs live under one Administration-level
// page instead of being scattered as separate top-level Finance nav items.
const FINANCE_SETTINGS_TAB_KEYS = ["tax", "fx", "invoice-templates", "fnf-settlement", "timesheet-templates", "email-templates"] as const;
export function FinanceSettings() {
  const [tab, setTab] = useState<typeof FINANCE_SETTINGS_TAB_KEYS[number]>("tax");
  const tabs: [typeof tab, string][] = [["tax", "Tax"], ["fx", "FX Rates"], ["invoice-templates", "Invoice & Email Templates"], ["fnf-settlement", "FnF Template"], ["timesheet-templates", "Timesheet Templates"], ["email-templates", "Email Templates"]];
  // Tax brackets are Business-Unit-scoped (same convention as HR Settings) — its own
  // independent localStorage key so picking a BU here doesn't affect HR Settings' selector.
  const [businessUnitId, setBusinessUnitIdState] = useState(() => localStorage.getItem("financeSettingsBusinessUnitId") || "null");
  const setBusinessUnitId = (v: string) => { setBusinessUnitIdState(v); try { localStorage.setItem("financeSettingsBusinessUnitId", v); } catch { /* ignore (private mode, etc.) */ } };
  // Email Templates gets its OWN BU selector, deliberately NOT shared with Tax's — a BU
  // selected on the Tax tab previously (persisted in localStorage) would otherwise silently
  // carry over and hide the company-default email templates behind a "clone first" banner,
  // since those always seed at businessUnitId:null.
  const [emailBusinessUnitId, setEmailBusinessUnitIdState] = useState(() => localStorage.getItem("financeSettingsEmailBusinessUnitId") || "null");
  const setEmailBusinessUnitId = (v: string) => { setEmailBusinessUnitIdState(v); try { localStorage.setItem("financeSettingsEmailBusinessUnitId", v); } catch { /* ignore (private mode, etc.) */ } };
  return (
    <div>
      <h1>Finance Settings</h1>
      <div className="subtitle">Tax brackets, FX rates and invoice layout/email-template configuration live here.</div>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap" }}>
        {tabs.map(([k, label]) => (
          <div key={k} onClick={() => setTab(k)} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === k ? "var(--accent)" : "var(--muted)", borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent" }}>{label}</div>
        ))}
      </div>
      {tab === "tax" && (<><BusinessUnitFilterBar businessUnitId={businessUnitId} setBusinessUnitId={setBusinessUnitId} /><TaxBracketsSettings businessUnitId={businessUnitId} /></>)}
      {tab === "fx" && <FxRates />}
      {tab === "invoice-templates" && <InvoiceTemplates />}
      {tab === "fnf-settlement" && <FnfSettlementTemplates />}
      {tab === "timesheet-templates" && <TimesheetTemplatesTab />}
      {tab === "email-templates" && (<><BusinessUnitFilterBar businessUnitId={emailBusinessUnitId} setBusinessUnitId={setEmailBusinessUnitId} /><FinanceEmailTemplatesSettings businessUnitId={emailBusinessUnitId} /></>)}
    </div>
  );
}

// ---------------- Finance's own templated emails (everything except Invoice emails, which stay
// on the separate invoice-email-template system below) — same HrEmailTemplate model/routes HR
// Settings' own Email Templates tab uses (Hr.tsx's EmailTemplatesSettings), just a different,
// Finance-specific key set and a different Settings location. ----------------
const FINANCE_EMAIL_TEMPLATE_LABELS: Record<string, string> = {
  FNF_SETTLEMENT_SEND: "FnF Settlement — Send to Email",
  TERMINATION_COMPLETED_NOTICE: "Termination Completed Notice",
  IT_DISABLE_ACCOUNT_NOTICE: "IT — Disable Account Notice",
  IT_PROVISIONING_CANCELLED: "IT Provisioning Cancelled",
};
const FINANCE_EMAIL_PREVIEW_SAMPLE: Record<string, string> = {
  EmployeeName: "Aditi Sharma", EmployeeFirstName: "Aditi", EmployeeId: "1042", SignatoryName: "HR Team, GenAquarius",
  ExitDate: "30th Sep 2026", MonthCost: "1,250.00", FnfAmount: "2,400.00", CandidateName: "Devansh Dixit",
};
function fillFinancePreview(tpl: string): string {
  return String(tpl || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => FINANCE_EMAIL_PREVIEW_SAMPLE[key] ?? `{{${key}}}`);
}
function FinanceEmailTemplatesSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/email-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const rows = (data || []).filter((t) => FINANCE_EMAIL_TEMPLATE_LABELS[t.key]);
  const [sel, setSel] = useState<any>(null);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [signature, setSignature] = useState(""); const [showLogo, setShowLogo] = useState(true);
  const [busy, setBusy] = useState(false);
  const select = (t: any) => { setSel(t); setSubject(t.subject); setBody(t.body); setSignature(t.signature || ""); setShowLogo(t.showLogo !== false); };
  const save = async () => {
    setBusy(true);
    try { await api.put(`/hr-settings/email-templates/${sel.key}`, { subject, body, signature, showLogo, businessUnitId: businessUnitId === "null" ? null : Number(businessUnitId) }); show("Saved"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  if (data && rows.length === 0 && businessUnitId !== "null") {
    return <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/email-templates/clone-to-bu" onCloned={reload} label="Email Templates" />;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 18 }}>
      <Panel title="Templates">
        {rows.map((t) => (
          <div key={t.key} style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 6, cursor: "pointer", background: sel?.key === t.key ? "var(--panel2)" : undefined }}
            onClick={() => select(t)}>{FINANCE_EMAIL_TEMPLATE_LABELS[t.key] || t.key}</div>
        ))}
      </Panel>
      {!sel ? <Panel title="Select a template"><div className="subtitle" style={{ marginTop: 0 }}>Pick a template on the left to edit it. Every Finance-triggered email except Invoice emails (which have their own template system under Invoice & Email Templates) is controlled here.</div></Panel> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{FINANCE_EMAIL_TEMPLATE_LABELS[sel.key] || sel.key}</div>
            <Field label="Subject" value={subject} onChange={(e: any) => setSubject(e.target.value)} />
            <div>
              <label>Body <span style={{ color: "var(--muted)", fontSize: 12 }}>(supports {"{{EmployeeName}}"}, {"{{EmployeeId}}"}, {"{{ExitDate}}"}, {"{{MonthCost}}"}, {"{{FnfAmount}}"}, {"{{CandidateName}}"} etc. depending on the key)</span></label>
              <textarea rows={10} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div>
              <label>Signature</label>
              <textarea rows={4} style={{ width: "100%" }} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={"Regards,\nFinance Team, GenAquarius"} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={showLogo} onChange={(e) => setShowLogo(e.target.checked)} />
              Show GenAquarius logo below signature
            </label>
            <AddButton onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Template"}</AddButton>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Live preview</div>
            <div style={{ background: "#ffffff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 10, padding: 20, minHeight: 320, fontSize: 14, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #eee" }}>{fillFinancePreview(subject) || <span style={{ color: "#9aa0ab" }}>Subject preview…</span>}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{fillFinancePreview(body) || <span style={{ color: "#9aa0ab" }}>Email body preview…</span>}</div>
              {signature && <div style={{ whiteSpace: "pre-wrap", marginTop: 18 }}>{fillFinancePreview(signature)}</div>}
              {showLogo && (
                <div style={{ marginTop: 18 }}>
                  <img src="/genaquarius.png" alt="GenAquarius" style={{ maxHeight: 56, maxWidth: 220 }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Filled with sample values — this is how the real email will read once sent.</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- FnF (Full & Final) Template .docx ----------------
// Same Advanced-Builder-with-live-preview pattern as the HR Offer/Appointment letter templates
// (Hr.tsx's OfferTemplatesSettings) — bodyText with {{placeholders}}, a debounced live preview
// pane. The real download/send is always .docx (engine/fnfDocx.ts); the preview here is an HTML
// rendering of the same filled body since a browser can't show .docx inline.
// Full-time and contractor FnF are different enough documents (Basic/Notice Pay/EL vs Gross
// Payable/GST/TDS) that every template is scoped to one employment type — shown as two separate
// lists, each with its own default, rather than one shared pool.
function FnfSettlementTemplates() {
  const { data, reload } = useFetch<any[]>("/termination-approvals/fnf-settlement-templates");
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  // Per-template signature override — blank means this document keeps signing off as the shared
  // HR Signature (HR Settings → Signature), same as before this feature existed.
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryTitle, setSignatoryTitle] = useState("");
  const PLACEHOLDERS = ["EmployeeName", "EmpNo", "Designation", "Department", "EmpType", "JoiningDate", "ExitDate", "ResignationDate", "FnfFinalizationDate", "TotalAmount", "Currency", "Note"];

  const create = async (empType: "FULL_TIME" | "CONTRACTOR") => {
    const tpl = await api.post("/termination-approvals/fnf-settlement-templates", { name: `New ${empType === "FULL_TIME" ? "Full-Time" : "Contractor"} FnF Template`, bodyText: "", empType });
    reload(); setSel(tpl); setName(tpl.name); setBody(tpl.bodyText || ""); setSignatoryName(tpl.signatoryName || ""); setSignatoryTitle(tpl.signatoryTitle || "");
  };
  const save = async () => { await api.put(`/termination-approvals/fnf-settlement-templates/${sel.id}`, { name, bodyText: body, signatoryName, signatoryTitle }); show("Template saved"); reload(); };
  const makeDefault = async () => { await api.put(`/termination-approvals/fnf-settlement-templates/${sel.id}`, { isDefault: true }); show("Set as default"); reload(); };
  const del = async (t: any) => {
    if (!(await confirmDialog({ title: `Delete template "${t.name}"?`, danger: true, confirmLabel: "Delete" }))) return;
    await api.del(`/termination-approvals/fnf-settlement-templates/${t.id}`); if (sel?.id === t.id) setSel(null); reload();
  };

  const [advOpen, setAdvOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !sel) return;
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const blob = await api.postBlob("/termination-approvals/fnf-settlement-templates/preview", { bodyText: body, empType: sel.empType, signatoryName, signatoryTitle });
        const html = await blob.text();
        if (seq === previewSeq.current) setPreviewHtml(html);
      } catch { /* keep previous preview on transient errors */ }
      finally { if (seq === previewSeq.current) setPreviewBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, body, signatoryName, signatoryTitle, sel?.id]);

  const list = (empType: "FULL_TIME" | "CONTRACTOR", label: string) => (
    <Panel title={`${label} FnF Templates`}>
      <div className="btn-row" style={{ marginBottom: 8 }}><AddButton onClick={() => create(empType)}>Add {label} Template</AddButton></div>
      <table><thead><tr><th>Name</th><th>Default</th><th /></tr></thead>
        <tbody>{(data || []).filter((t) => t.empType === empType).map((t) => (
          <tr key={t.id} style={{ cursor: "pointer", background: sel?.id === t.id ? "var(--panel2)" : undefined }} onClick={() => { setSel(t); setName(t.name); setBody(t.bodyText); setSignatoryName(t.signatoryName || ""); setSignatoryTitle(t.signatoryTitle || ""); }}>
            <td>{t.name}</td><td>{t.isDefault ? "✓" : ""}</td>
            <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}><DeleteAction onClick={() => del(t)} /></td>
          </tr>
        ))}
        {(data || []).filter((t) => t.empType === empType).length === 0 && <tr><td colSpan={3} style={{ color: "var(--muted)" }}>No {label.toLowerCase()} templates yet — the built-in default wording is used until you add one.</td></tr>}
        </tbody>
      </table>
    </Panel>
  );

  return (
    <div>
      <div className="grid cols-2">
        {list("FULL_TIME", "Full-Time")}
        {list("CONTRACTOR", "Contractor")}
      </div>
      <div style={{ marginTop: 14 }}>
        <Panel title={sel ? `Edit — ${sel.name}` : "Select a template"}>
          {sel ? (
            <>
              <Input label="Name" value={name} onChange={(e: any) => setName(e.target.value)} />
              <div className="grid cols-2" style={{ marginTop: 8 }}>
                <Input label="Signatory Name (blank = shared HR Signature)" value={signatoryName} onChange={(e: any) => setSignatoryName(e.target.value)} placeholder="e.g. Vivek Kaw" />
                <Input label="Signatory Title" value={signatoryTitle} onChange={(e: any) => setSignatoryTitle(e.target.value)} placeholder="e.g. Finance Head" />
              </div>
              <label style={{ marginTop: 8 }}>Body ({PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")})</label>
              <textarea rows={14} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <AddButton onClick={save}>Save Template</AddButton>
                {!sel.isDefault && <GhostButton onClick={makeDefault}>Set as Default</GhostButton>}
                <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
              </div>
            </>
          ) : <div style={{ color: "var(--muted)" }}>No template selected.</div>}
        </Panel>
      </div>
      {advOpen && sel && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
        <div className="modal-card" style={{ width: "min(1400px, 96vw)", maxWidth: "min(1400px, 96vw)", height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{"✨ Advanced FnF Template Builder — " + sel.name}</h3>
            <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{previewBusy ? "⟳ updating live preview…" : "live preview — every change re-renders it →"}</span>
            <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
          </div>
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ flex: "1 1 45%", display: "flex", flexDirection: "column", overflowY: "auto", paddingRight: 6 }}>
              <div className="grid cols-2">
                <Input label="Signatory Name (blank = shared HR Signature)" value={signatoryName} onChange={(e: any) => setSignatoryName(e.target.value)} placeholder="e.g. Vivek Kaw" />
                <Input label="Signatory Title" value={signatoryTitle} onChange={(e: any) => setSignatoryTitle(e.target.value)} placeholder="e.g. Finance Head" />
              </div>
              <label style={{ marginTop: 8 }}>Body ({PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")})</label>
              <textarea rows={26} style={{ width: "100%", flex: 1 }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="subtitle" style={{ marginTop: 6 }}>Preview uses a sample {sel.empType === "CONTRACTOR" ? "contractor" : "full-time"} settlement ({sel.empType === "CONTRACTOR" ? "\"Devina Bhatnagar\"" : "\"Venkatesan Iyer\""}) — never a real termination.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}><AddButton onClick={save}>Save Template</AddButton></div>
            </div>
            <div style={{ flex: "1 1 55%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              {previewHtml ? <iframe title="FnF preview" srcDoc={previewHtml} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      </div>}
    </div>
  );
}

export function InvoiceTemplates() {
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/admin/invoice-templates");
  const { data: projects } = useFetch<any[]>("/projects");
  const tsf = useSortFilter(data || [], TPL_COLS);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return show("Template name is required", "error");
    setBusy(true);
    try {
      if (form.id) await api.put(`/admin/invoice-templates/${form.id}`, toPayload(form));
      else await api.post(`/admin/invoice-templates`, toPayload(form));
      show("Template saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (t: any) => { if (!(await confirmDialog({ title: `Delete template "${t.name}"?`, danger: true, confirmLabel: "Delete" }))) return; try { await api.del(`/admin/invoice-templates/${t.id}`); show("Deleted"); reload(); } catch (e: any) { show(e.message, "error"); } };

  return (
    <div>
      <h1>Invoice &amp; Templates</h1>
      <div className="subtitle">Per-region invoice formats (US / Canada / India). Assign a template to each client; the invoice PDF uses it.</div>
      <div className="btn-row"><AddButton onClick={() => setForm(blankTemplate())}>Add Invoice Template</AddButton><FilterToggle sf={tsf} /></div>
      <Panel title={`Invoice Templates (${(data || []).length})`}>{loading ? "Loading…" : <table>
        <SortableHead cols={TPL_COLS} sf={tsf} trailing={<th style={{ textAlign: "right" }}>Actions</th>} />
        <tbody>{tsf.view.map((t: any) => (
          <tr key={t.id}>
            <td>{t.name}</td><td>{(t.layoutConfig && t.layoutConfig.region) || "—"}</td>
            <td>{t.issuerBlock?.company || "—"}</td><td>{t.bankDetails?.bankName || "—"}</td>
            <td><ChipList names={(t.projects || []).map((p: any) => p.name)} /></td>
            <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
              <EditAction onClick={() => setForm(toForm(t))} />
              <DeleteAction onClick={() => del(t)} />
            </td>
          </tr>
        ))}</tbody>
      </table>}</Panel>

      <Modal title={form?.id ? `Edit Invoice Template: ${form?.name}` : "Add Invoice Template"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!form?.name?.trim()} wide>
        {form && <div className="form-grid">
          <Input label="Template Name" required value={form.name} onChange={(e: any) => set("name", e.target.value)} placeholder="e.g. GenAquarius — US" />
          <Select label="Region" value={form.region} onChange={(e: any) => set("region", e.target.value)} options={["US", "CANADA", "INDIA"].map((v) => ({ value: v, label: v }))} />
          <div className="full" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, color: "var(--muted)", fontSize: 12 }}>Issuer (your company on the invoice)</div>
          <Input label="Company" value={form.company} onChange={(e: any) => set("company", e.target.value)} />
          <Input label="Website" value={form.website} onChange={(e: any) => set("website", e.target.value)} />
          <div className="full"><label>Address (one line per row)</label><textarea rows={2} value={form.address} onChange={(e) => set("address", e.target.value)} /></div>
          <Input label="Contact" full value={form.contact} onChange={(e: any) => set("contact", e.target.value)} placeholder="finance@genaquarius.com" />
          <div className="full" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, color: "var(--muted)", fontSize: 12 }}>Bank details (for payment)</div>
          <Input label="Bank Name" value={form.bankName} onChange={(e: any) => set("bankName", e.target.value)} />
          <Input label="Payment Terms" value={form.terms} onChange={(e: any) => set("terms", e.target.value)} />
          <div className="full"><label>Bank Details — one line per row (shown verbatim on the invoice; e.g. ACCOUNT #, Transit #, SWIFT, Bank Address, Office Address)</label>
            <textarea rows={6} value={form.bankLines} onChange={(e) => set("bankLines", e.target.value)} placeholder={"ACCOUNT # 325203479524, ROUTING # 121000358 (Paper & Electronic) Or 026009593 (Wires)\nBank Address: Bank of America N.A. 222 Broadway, New York, NY 10038\nOffice Address: 2795 E Bidwell St., Suite 100-662, Folsom, CA 95630 USA"} />
          </div>
          <div className="full" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, color: "var(--muted)", fontSize: 12 }}>Used By — projects that should use this invoice template</div>
          <ProjectMultiSelect projects={projects || []} value={form.projectIds || []} onChange={(ids) => set("projectIds", ids)} />
        </div>}
      </Modal>

      <EmailTemplates />
      <InvoiceLayouts />
    </div>
  );
}

// ---------------- Configurable Invoice Layout designer ----------------
const FIELD_LABEL: Record<string, string> = {
  logo: "Company Logo", title: "INVOICE Title", issuer: "Issuer Block", invoiceNo: "Invoice Number",
  invoiceDate: "Invoice Date", dueDate: "Due Date", projectTitle: "Project Title", projectCode: "Project Code",
  projectDescription: "Project Description", poNumber: "PO Number", customerRefNo: "Customer Ref No",
  billingPeriod: "Billing Period", attention: "Attention Contact(s)", clientLogo: "Client Logo", billTo: "Bill-To Block",
  // Optional fields the invoice carries — off by default, tick one to print it in the right-hand block.
  addressTo: "Address To", clientName: "Client Name", clientCode: "Client Code", billingMonth: "Billing Month",
  fiscalYear: "Fiscal Year", billingPeriodStart: "Billing Period From", billingPeriodEnd: "Billing Period To",
  currency: "Currency", invoiceTotal: "Invoice Total", status: "Status", billingEmail: "Billing Email (AP)",
};
const SECTION_LABEL: Record<string, string> = { lineItems: "Line Items table", bankDetails: "Bank Details", annexure: "Annexure" };
const A4 = { w: 595, h: 842 };

function InvoiceLayouts() {
  const { show } = useToast();
  const { data, reload } = useFetch<any[]>("/invoice-layouts");
  const { data: projects } = useFetch<any[]>("/projects");
  const [form, setForm] = useState<any>(null); // { id, name, isDefault, projectIds, config }
  const [busy, setBusy] = useState(false);
  // Selection is a SET of field keys: plain click selects one, Ctrl/Cmd- or Shift-click adds to the
  // group. A group can be aligned / evenly spaced / resized together, and dragged as one.
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ keys: string[]; base: Record<string, { x: number; y: number }>; sx: number; sy: number } | null>(null);
  // Fit the A4 page to the viewport height so the designer fills the screen.
  const [scale, setScale] = useState(0.85);
  useEffect(() => {
    const calc = () => setScale(Math.max(0.5, Math.min(1.15, (window.innerHeight - 96) / A4.h)));
    calc(); window.addEventListener("resize", calc); return () => window.removeEventListener("resize", calc);
  }, []);

  const openNew = async () => {
    const def = await api.get("/invoice-layouts/default");
    setForm({ id: null, name: "", isDefault: false, projectIds: [], config: def }); setSelKeys([]);
  };
  const openEdit = async (l: any) => {
    // Merge in any newer default fields (e.g. Attention) missing from an older saved layout.
    const def = await api.get("/invoice-layouts/default");
    const have = new Set((l.config?.headerFields || []).map((f: any) => f.key));
    const config = { ...def, ...l.config, headerFields: [...(l.config?.headerFields || []), ...def.headerFields.filter((f: any) => !have.has(f.key))] };
    setForm({ id: l.id, name: l.name, isDefault: !!l.isDefault, projectIds: (l.projects || []).map((p: any) => p.id), config }); setSelKeys([]);
  };
  const del = async (l: any) => { if (!(await confirmDialog({ title: `Delete layout "${l.name}"?`, message: "Projects using it fall back to the default.", danger: true, confirmLabel: "Delete" }))) return; await api.del(`/invoice-layouts/${l.id}`); show("Layout deleted"); reload(); };

  const cfg = form?.config;
  const updateField = (key: string, patch: any) => setForm((f: any) => ({ ...f, config: { ...f.config, headerFields: f.config.headerFields.map((x: any) => x.key === key ? { ...x, ...patch } : x) } }));
  // Patch several fields at once (group ops + group drag) in a single state update.
  const updateMany = (patches: Record<string, any>) => setForm((f: any) => ({ ...f, config: { ...f.config, headerFields: f.config.headerFields.map((x: any) => (patches[x.key] ? { ...x, ...patches[x.key] } : x)) } }));
  const updateSections = (sections: any[]) => setForm((f: any) => ({ ...f, config: { ...f.config, sections } }));
  const moveSection = (i: number, dir: number) => { const s = [...cfg.sections]; const j = i + dir; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j], s[i]]; updateSections(s); };

  // Drag header field boxes on the A4 canvas (screen px → PDF points). Everything in the current
  // selection moves by the same delta, so a group keeps its relative layout.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !canvasRef.current) return;
      const dx = Math.round((e.clientX - d.sx) / scale), dy = Math.round((e.clientY - d.sy) / scale);
      const patches: Record<string, any> = {};
      for (const k of d.keys) {
        const b = d.base[k];
        patches[k] = { x: Math.max(0, Math.min(545, b.x + dx)), y: Math.max(0, Math.min(820, b.y + dy)) };
      }
      updateMany(patches);
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [scale]);
  const onBoxDown = (e: React.MouseEvent, f: any) => {
    e.preventDefault();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const keys = additive ? (selKeys.includes(f.key) ? selKeys : [...selKeys, f.key]) : (selKeys.includes(f.key) && selKeys.length > 1 ? selKeys : [f.key]);
    setSelKeys(keys);
    const base: Record<string, { x: number; y: number }> = {};
    for (const k of keys) { const g = cfg.headerFields.find((x: any) => x.key === k); if (g) base[k] = { x: g.x, y: g.y }; }
    dragRef.current = { keys, base, sx: e.clientX, sy: e.clientY };
  };

  const previewPdf = async () => {
    try { const blob = await api.postBlob("/invoice-layouts/preview", { config: cfg }); window.open(URL.createObjectURL(blob), "_blank"); }
    catch (e: any) { show(e.message, "error"); }
  };
  const save = async () => {
    if (!form.name?.trim()) return show("Name the layout", "error");
    setBusy(true);
    try {
      const body = { name: form.name, isDefault: form.isDefault, projectIds: form.projectIds, config: cfg };
      if (form.id) await api.put(`/invoice-layouts/${form.id}`, body); else await api.post("/invoice-layouts", body);
      show("Layout saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const isSel = (k: string) => selKeys.includes(k);
  const pick = (k: string, additive: boolean) => setSelKeys((s) => (additive ? (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]) : [k]));
  const selFields: any[] = (cfg?.headerFields || []).filter((f: any) => isSel(f.key));
  const selField = selFields.length === 1 ? selFields[0] : null;
  // ---- Group ops (2+ selected) ----
  // Align the group into ONE column: same X and same right edge, so the renderer treats them as a
  // single label/value block; `side` picks whether the values sit flush left or flush right.
  const groupAlign = (side: "left" | "right") => {
    const x = Math.min(...selFields.map((f) => f.x));
    const right = Math.max(...selFields.map((f) => f.x + (f.w ?? 200)));
    const w = Math.max(60, right - x);
    updateMany(Object.fromEntries(selFields.map((f) => [f.key, { x, w, align: side }])));
  };
  // Equal vertical spacing: keep the topmost row, then repeat the average gap (min one row height).
  const spaceRowsEqually = () => {
    const rows = [...selFields].sort((a, b) => a.y - b.y);
    const span = rows[rows.length - 1].y - rows[0].y;
    const pitch = Math.max(13, Math.round(span / Math.max(1, rows.length - 1)) || 13);
    updateMany(Object.fromEntries(rows.map((f, i) => [f.key, { y: rows[0].y + i * pitch }])));
  };
  const groupWidth = () => { const w = Math.max(...selFields.map((f) => f.w ?? 200)); updateMany(Object.fromEntries(selFields.map((f) => [f.key, { w }]))); };
  const groupPatch = (patch: any) => updateMany(Object.fromEntries(selFields.map((f) => [f.key, patch])));

  return (
    <div style={{ marginTop: 24 }}>
      <h2>Invoice Layouts</h2>
      <div className="subtitle">Configure which fields show and where they sit on the invoice page. Assign a layout to projects; the default is used otherwise.</div>
      <div className="btn-row"><AddButton onClick={openNew}>Add Layout</AddButton></div>
      <Panel><table><thead><tr><th>Name</th><th>Default</th><th>Used By (projects)</th><th></th></tr></thead>
        <tbody>{(data || []).length === 0 ? <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No layouts yet — the built-in default is used.</td></tr> :
          (data || []).map((l: any) => <tr key={l.id}>
            <td>{l.name}</td><td>{l.isDefault ? <span className="pill">default</span> : "—"}</td>
            <td>{(l.projects || []).map((p: any) => p.name).join(", ") || "—"}</td>
            <td style={{ whiteSpace: "nowrap" }}><button className="ghost" onClick={() => openEdit(l)}>Edit</button> <button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => del(l)}>Delete</button></td>
          </tr>)}</tbody></table></Panel>

      {form && <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--bg, #0b0e14)", display: "flex", flexDirection: "column" }}>
        {/* Top bar */}
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <h3 style={{ margin: 0 }}>{form.id ? `Edit Layout: ${form.name || ""}` : "New Invoice Layout"}</h3>
          <div style={{ flex: 1 }} />
          <button className="ghost" onClick={previewPdf}>👁 Preview PDF</button>
          <button className="ghost" onClick={() => setForm(null)}>Cancel</button>
          <AddButton onClick={save} disabled={busy || !form.name?.trim()}>{busy ? "Saving…" : "Save Layout"}</AddButton>
        </div>
        <div style={{ flex: 1, display: "flex", gap: 16, overflow: "hidden", padding: 16 }}>
          {/* A4 canvas — fills the screen height; drag the visible field boxes to position them */}
          <div style={{ flex: "1 1 auto", overflow: "auto", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
            <div ref={canvasRef} style={{ position: "relative", flex: "0 0 auto", width: A4.w * scale, height: A4.h * scale, background: "#fff", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 2px 16px rgba(0,0,0,.4)", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: cfg.sectionsStartY * scale, left: 0, right: 0, borderTop: "1px dashed #c00", color: "#c00", fontSize: 10, paddingLeft: 4 }}>sections start ({cfg.sectionsStartY})</div>
              {cfg.headerFields.filter((f: any) => f.visible).map((f: any) => (
                <div key={f.key} onMouseDown={(e) => onBoxDown(e, f)} title={`${FIELD_LABEL[f.key] || f.key} — Ctrl/Shift-click to add to the group`}
                  style={{ position: "absolute", left: f.x * scale, top: f.y * scale, width: (f.w || 200) * scale, padding: "1px 5px", fontSize: 11, lineHeight: 1.3, cursor: "move", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: (f.align || "left") as any, border: isSel(f.key) ? "2px solid var(--accent)" : "1px solid #99b", background: isSel(f.key) ? "rgba(110,168,255,.22)" : "rgba(0,0,0,.04)", color: "#222", borderRadius: 3 }}>
                  {FIELD_LABEL[f.key] || f.key}
                </div>
              ))}
            </div>
          </div>
          {/* Right panel — meta, field toggles, inspector, sections */}
          <div style={{ flex: "0 0 360px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
            <div className="form-grid">
              <Input label="Layout Name" required value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} />
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={!!form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Default layout</label>
            </div>
            <ProjectMultiSelect projects={projects || []} value={form.projectIds} onChange={(ids) => setForm({ ...form, projectIds: ids })} />
            {(() => {
              // Two explicit groups: what is ON the page, and everything else the invoice can print but
              // currently doesn't. Splitting them is what makes the optional fields discoverable — in one
              // long scroll box the hidden ones sat below the fold and never showed on the canvas either.
              const shown = cfg.headerFields.filter((f: any) => f.visible);
              const hidden = cfg.headerFields.filter((f: any) => !f.visible);
              const chip = (f: any) => (
                <label key={f.key} onClick={(e) => pick(f.key, e.ctrlKey || e.metaKey || e.shiftKey)} title={f.visible ? "On the page — click to select, untick to hide" : "Tick to add it to the page"}
                  style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12, border: isSel(f.key) ? "1px solid var(--accent)" : "1px solid var(--border)", borderRadius: 6, padding: "2px 6px", cursor: "pointer", opacity: f.visible ? 1 : 0.75 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={f.visible} onChange={(e) => updateField(f.key, { visible: e.target.checked })} />{FIELD_LABEL[f.key] || f.key}
                </label>
              );
              return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <div className="label" style={{ marginBottom: 4 }}>On the page ({shown.length}) · click to select, Ctrl/Shift-click for a group</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 200, overflow: "auto" }}>{shown.map(chip)}</div>
                </div>
                <div>
                  <div className="label" style={{ marginBottom: 4 }}>Available to add ({hidden.length}) — tick to print it</div>
                  {hidden.length === 0 ? <div className="subtitle" style={{ color: "var(--muted)" }}>Every field is already on the page.</div>
                    : <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 200, overflow: "auto" }}>{hidden.map(chip)}</div>}
                </div>
              </div>;
            })()}
            {selFields.length > 1 && <div style={{ border: "1px solid var(--accent)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontWeight: 600 }}>Group: {selFields.length} fields selected</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{selFields.map((f: any) => FIELD_LABEL[f.key] || f.key).join(", ")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button className="ghost" onClick={() => groupAlign("left")}>⇤ Align left</button>
                <button className="ghost" onClick={() => groupAlign("right")}>Align right ⇥</button>
                <button className="ghost" onClick={spaceRowsEqually}>↕ Space rows equally</button>
                <button className="ghost" onClick={groupWidth}>↔ Same width</button>
              </div>
              <div className="form-grid">
                <Input label="Width (all)" type="number" value={Math.max(...selFields.map((f: any) => f.w ?? 200))} onChange={(e: any) => groupPatch({ w: +e.target.value || 0 })} />
                <Input label="Font Size (all)" type="number" value={selFields[0].fontSize ?? 9} onChange={(e: any) => groupPatch({ fontSize: +e.target.value || 9 })} />
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Align left/right puts the group in one column (same X and right edge) — labels stay flush left, values flush to the chosen side. Drag any box to move the whole group.</div>
              <button className="ghost" onClick={() => setSelKeys([])}>Clear selection</button>
            </div>}
            {selField && <div className="form-grid" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
              <div className="full" style={{ fontWeight: 600 }}>Selected: {FIELD_LABEL[selField.key] || selField.key}</div>
              <Input label="X" type="number" value={selField.x} onChange={(e: any) => updateField(selField.key, { x: +e.target.value || 0 })} />
              <Input label="Y" type="number" value={selField.y} onChange={(e: any) => updateField(selField.key, { y: +e.target.value || 0 })} />
              <Input label="Width" type="number" value={selField.w ?? 200} onChange={(e: any) => updateField(selField.key, { w: +e.target.value || 0 })} />
              <Input label="Font Size" type="number" value={selField.fontSize ?? 9} onChange={(e: any) => updateField(selField.key, { fontSize: +e.target.value || 9 })} />
              <Select label="Align" value={selField.align || "left"} onChange={(e: any) => updateField(selField.key, { align: e.target.value })} options={["left", "center", "right"].map((v) => ({ value: v, label: v }))} />
              <Input label="Label (blank = none)" value={selField.label ?? ""} onChange={(e: any) => updateField(selField.key, { label: e.target.value })} />
            </div>}
            <div>
              <div className="label" style={{ marginBottom: 4 }}>Sections (order &amp; show/hide)</div>
              {cfg.sections.map((s: any, i: number) => (
                <div key={s.key} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={s.visible} onChange={(e) => updateSections(cfg.sections.map((x: any) => x.key === s.key ? { ...x, visible: e.target.checked } : x))} />
                  <span style={{ flex: 1 }}>{SECTION_LABEL[s.key] || s.key}</span>
                  <button className="ghost" onClick={() => moveSection(i, -1)} disabled={i === 0}>↑</button>
                  <button className="ghost" onClick={() => moveSection(i, 1)} disabled={i === cfg.sections.length - 1}>↓</button>
                </div>
              ))}
              <Input label="Sections start Y" type="number" value={cfg.sectionsStartY} onChange={(e: any) => setForm({ ...form, config: { ...cfg, sectionsStartY: +e.target.value || 0 } })} />
            </div>
            <div className="subtitle" style={{ color: "var(--muted)" }}>Drag fields on the page, or fine-tune X/Y in the inspector. Ctrl/Shift-click to select several and align or space them as a group. Preview PDF uses sample data. Fields sharing the same X print as one block: labels flush left, values flush to the block's alignment, empty fields skipped (rows close up — no blank lines).</div>
          </div>
        </div>
      </div>}
    </div>
  );
}

// ---------------- Email / Signature templates (F7 / F10) ----------------
const EMAIL_COLS = [
  { key: "geography", label: "Geography" },
  { key: "name", label: "Name" },
  { key: "entityName", label: "Entity" },
  { key: "usedby", label: "Used By (projects)", get: (t: any) => (t.projects || []).map((p: any) => p.name).join(", ") },
  { key: "showLogo", label: "Logo", get: (t: any) => (t.showLogo ? "Yes" : "No") },
];
const DEFAULT_EMAIL_SUBJECT = "GenAquarius Invoice {Month}-{ProjectName}";
const blankEmail = () => ({ id: null, name: "", geography: "US", entityName: "", subject: DEFAULT_EMAIL_SUBJECT, body: "", signature: "", showLogo: true, isDefault: false, projectIds: [] as number[] });

// Themed multi-line editor (textarea) using theme variables so it doesn't look washed out.
function ThemedTextarea({ rows, value, onChange, placeholder }: { rows: number; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <textarea rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
      style={{ background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", width: "100%", lineHeight: 1.55, resize: "vertical" }} />
  );
}

function EmailTemplates() {
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/email-templates");
  const { data: projects } = useFetch<any[]>("/projects");
  const esf = useSortFilter(data || [], EMAIL_COLS);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return show("Template name is required", "error");
    setBusy(true);
    const payload = {
      name: form.name, geography: form.geography, entityName: form.entityName, subject: form.subject,
      body: form.body, signature: form.signature, showLogo: !!form.showLogo, isDefault: !!form.isDefault,
      projectIds: (form.projectIds || []) as number[],
    };
    try {
      if (form.id) await api.put(`/email-templates/${form.id}`, payload);
      else await api.post("/email-templates", payload);
      show("Email template saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (t: any) => { if (!(await confirmDialog({ title: `Delete email template "${t.name}"?`, danger: true, confirmLabel: "Delete" }))) return; try { await api.del(`/email-templates/${t.id}`); show("Deleted"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const seed = async () => { try { const r = await api.post("/email-templates/seed-defaults", {}); show(r.created ? `Loaded ${r.created} default template(s)` : "Defaults already present"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const edit = (t: any) => setForm({ id: t.id, name: t.name, geography: t.geography, entityName: t.entityName || "", subject: t.subject || DEFAULT_EMAIL_SUBJECT, body: t.body || "", signature: t.signature || "", showLogo: t.showLogo !== false, isDefault: !!t.isDefault, projectIds: (t.projects || []).map((p: any) => p.id) });

  return (
    <div style={{ marginTop: 24 }}>
      <h2>Email Templates</h2>
      <div className="subtitle">Per-geography invoice email body + signature (US / Canada / India). The GenAquarius logo renders below the signature when enabled.</div>
      <div className="btn-row">
        <AddButton onClick={() => setForm(blankEmail())}>Add Email Template</AddButton>
        <GhostButton onClick={seed} icon={<DoneAllRoundedIcon />}>Load default templates</GhostButton>
        <FilterToggle sf={esf} />
      </div>
      <Panel>{loading ? "Loading…" : <table>
        <SortableHead cols={EMAIL_COLS} sf={esf} trailing={<th style={{ textAlign: "right" }}>Actions</th>} />
        <tbody>{esf.view.length === 0 ? <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No email templates yet. Click <b>Load default templates</b> to seed US &amp; Canada.</td></tr> :
          esf.view.map((t: any) => (
            <tr key={t.id}>
              <td>{t.geography}</td><td>{t.name}{t.isDefault && <span className="pill" style={{ marginLeft: 6 }}>default</span>}</td>
              <td>{t.entityName || "—"}</td>
              <td><ChipList names={(t.projects || []).map((p: any) => p.name)} /></td>
              <td>{t.showLogo ? "Yes" : "No"}</td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                <EditAction onClick={() => edit(t)} />
                <DeleteAction onClick={() => del(t)} />
              </td>
            </tr>
          ))}</tbody>
      </table>}</Panel>

      <Modal title={form?.id ? `Edit Email Template: ${form?.name}` : "Add Email Template"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!form?.name?.trim()} wide>
        {form && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            {/* ---- Left: editor ---- */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Template details</div>
              <div className="form-grid" style={{ gap: 12 }}>
                <Input label="Template Name" required value={form.name} onChange={(e: any) => set("name", e.target.value)} placeholder="e.g. GenAquarius LLC — US" />
                <Select label="Geography" value={form.geography} onChange={(e: any) => set("geography", e.target.value)} options={["US", "CANADA", "INDIA"].map((v) => ({ value: v, label: v }))} />
                <Input label="Entity Name" full value={form.entityName} onChange={(e: any) => set("entityName", e.target.value)} placeholder="e.g. GenAquarius LLC" />
                <Input label="Email Subject" full value={form.subject} onChange={(e: any) => set("subject", e.target.value)} placeholder="e.g. GenAquarius Invoice {Month}-{Project Name}" />
                <ProjectMultiSelect projects={projects || []} value={form.projectIds || []} onChange={(ids) => set("projectIds", ids)} />
              </div>

              <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", borderTop: "1px solid var(--border)", paddingTop: 12 }}>Content</div>
              <div>
                <label>Email Body <span style={{ color: "var(--muted)", fontSize: 12 }}>(supports {"{{contactName}}"} and {"{{invoiceMonths}}"})</span></label>
                <ThemedTextarea rows={10} value={form.body} onChange={(v) => set("body", v)} placeholder={"Dear {{contactName}},\n\nPlease find attached the invoice for {{invoiceMonths}}.\n\nThank you."} />
              </div>
              <div>
                <label>Signature</label>
                <ThemedTextarea rows={5} value={form.signature} onChange={(v) => set("signature", v)} placeholder={"Regards,\nFinance Team\nGenAquarius"} />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "var(--text)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={!!form.showLogo} onChange={(e) => set("showLogo", e.target.checked)} />
                Show GenAquarius logo below signature
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "var(--text)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={!!form.isDefault} onChange={(e) => set("isDefault", e.target.checked)} />
                Use as the default template for this geography
              </label>
            </div>

            {/* ---- Right: live preview ---- */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Live preview</div>
              <div style={{ background: "#ffffff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 10, padding: 20, minHeight: 360, fontSize: 14, lineHeight: 1.6, boxShadow: "var(--glass-shadow)" }}>
                <div style={{ whiteSpace: "pre-wrap" }}>{form.body || <span style={{ color: "#9aa0ab" }}>Email body preview…</span>}</div>
                {form.signature && <div style={{ whiteSpace: "pre-wrap", marginTop: 18 }}>{form.signature}</div>}
                {form.showLogo && (
                  <div style={{ marginTop: 18 }}>
                    <img src="/genaquarius.png" alt="GenAquarius"
                      style={{ maxHeight: 56, maxWidth: 220 }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>This is how the invoice email will look. The logo renders below the signature when "Show GenAquarius logo" is checked.</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
