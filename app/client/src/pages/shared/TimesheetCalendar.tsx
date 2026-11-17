import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useFetch, Panel, projectLabel } from "../../ui";
import { Modal, useToast, AddButton, GhostButton, TimesheetEntriesTable, useConfirm } from "../../components";
import { useSortFilter, SortableHead, FilterToggle } from "../../DataTable";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";

const MY_COLS = [
  { key: "project", label: "Project", get: (t: any) => t.project?.name },
  { key: "period", label: "Period", get: (t: any) => t.periodYear * 100 + t.periodMonth },
  { key: "totalHours", label: "Hours", num: true },
  { key: "leaveDays", label: "Leave", num: true },
  { key: "status", label: "Status" },
];
import { useAuth } from "../../auth";
import EventBusyRoundedIcon from "@mui/icons-material/EventBusyRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import ThumbUpAltRoundedIcon from "@mui/icons-material/ThumbUpAltRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import EditCalendarRoundedIcon from "@mui/icons-material/EditCalendarRounded";
import LibraryAddCheckRoundedIcon from "@mui/icons-material/LibraryAddCheckRounded";
import DoneAllRoundedIcon from "@mui/icons-material/DoneAllRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";

const Legend = ({ color, label }: { color: string; label: string }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--muted)" }}>
    <span style={{ width: 11, height: 11, borderRadius: 3, background: color, display: "inline-block" }} /> {label}
  </span>
);

const CAL: [string, number][] = [["Jan",1],["Feb",2],["Mar",3],["Apr",4],["May",5],["June",6],["July",7],["Aug",8],["Sep",9],["Oct",10],["Nov",11],["Dec",12]];
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const ADMIN = ["CEO", "CTO", "FINANCE", "QA"];
const STATUS: Record<string, { label: string; color: string }> = {
  DRAFT:            { label: "Draft",                  color: "#8b96b0" },
  SUBMITTED:        { label: "Submitted → PM",         color: "#fbbf24" },
  PM_APPROVED:      { label: "PM approved → Finance",   color: "#6ea8ff" },
  FINANCE_APPROVED: { label: "Finance approved ✓",      color: "#34d399" },
  REJECTED:         { label: "Rejected",               color: "#f87171" },
};

type Head = { head: string; hours: number; billable?: boolean };
type Cell = { hours: number; leave: boolean; comment: string; heads?: Head[]; rejected?: boolean; rejectionComment?: string };

function StatusBadge({ s }: { s: string }) {
  const c = STATUS[s] || { label: s, color: "#8b96b0" };
  return <span style={{ background: c.color + "22", color: c.color, border: `1px solid ${c.color}55`, padding: "2px 8px", borderRadius: 20, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{c.label}</span>;
}

export function Timesheet() {
  const { user } = useAuth();
  const { show } = useToast();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExp = (id: number) => { const s = new Set(expanded); s.has(id) ? s.delete(id) : s.add(id); setExpanded(s); };
  // Granular reject — PM/Finance picks specific day/head rows (keyed "day:head") in the expanded
  // detail table instead of rejecting the whole sheet. Keyed per-timesheet so expanding a second
  // row doesn't carry over the first's selection.
  const [rejectSel, setRejectSel] = useState<Record<number, Set<string>>>({});
  const [rejectComments, setRejectComments] = useState<Record<number, Record<string, string>>>({});
  const toggleRejectKey = (tsId: number, key: string) => {
    const cur = new Set(rejectSel[tsId] || []);
    cur.has(key) ? cur.delete(key) : cur.add(key);
    setRejectSel({ ...rejectSel, [tsId]: cur });
  };
  const setRejectComment = (tsId: number, key: string, value: string) =>
    setRejectComments({ ...rejectComments, [tsId]: { ...(rejectComments[tsId] || {}), [key]: value } });
  const admin = ADMIN.includes(user?.role || "");
  const canApprove = admin || user?.role === "PROJECT_MANAGER";

  const [actAs, setActAs] = useState("");                       // admin: enter on behalf of this employee id
  const { data: emps } = useFetch<any[]>(admin ? "/timesheets/employees" : "/timesheets/my-projects-noop", []);
  const now = new Date();
  // Month comes FIRST: which Client/Project show is driven entirely by Monthly Forecast for
  // whichever period is selected here (see /timesheets/my-projects's own comment) — e.g. deployed
  // on 2 projects in Oct, nothing forecasted in Nov → Nov correctly shows no project at all.
  const [month, setMonth] = useState(now.getMonth() + 1);       // calendar month 1..12 — defaults to the current real month
  const [year, setYear] = useState(now.getFullYear());
  // Admin/PM "act on behalf" is intentionally unscoped here (see /my-projects's own comment) —
  // month/year only matter for a plain employee's own Monthly-Forecast-driven list, but are
  // harmless to always send since the server ignores them for admin/PM.
  const { data: projects } = useFetch<any[]>(`/timesheets/my-projects?month=${month}&year=${year}`, [actAs, month, year]);
  const { data: mine, reload } = useFetch<any[]>(`/timesheets/mine${admin && actAs ? `?employeeId=${actAs}` : ""}`, [actAs]);
  const mineSf = useSortFilter(mine || [], MY_COLS);

  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  // clients available for the SELECTED month = distinct clients of that period's Monthly Forecast
  // projects (re-derived from `projects` every time it refetches for a new month/employee).
  const clients = useMemo(() => {
    const m = new Map<number, string>();
    (projects || []).forEach((p: any) => { if (p.client) m.set(p.client.id, p.client.name); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [projects]);
  const clientProjects = (projects || []).filter((p: any) => !clientId || String(p.client?.id) === clientId);
  // The selected client/project may not exist in the NEW month's list (e.g. switching from a month
  // with 2 projects to one with none) — drop a selection that's no longer valid rather than silently
  // keeping a stale one picked.
  useEffect(() => {
    if (clientId && !clients.some((c) => String(c.id) === clientId)) { setClientId(""); setProjectId(""); }
    else if (projectId && !clientProjects.some((p: any) => String(p.id) === projectId)) setProjectId("");
  }, [projects]);
  // Template-driven field LABELS for this project's resolved template (section 14: data model
  // never changes — day/hours/leave/comment stays exactly as-is — only which label is painted on
  // top of the Hours/Comment inputs and which Approval-field labels show below the grid). Falls
  // back to the same defaults this screen always showed when no template resolves to anything odd.
  const { data: resolvedTpl } = useFetch<any>(`/timesheet-templates/resolved-config-for-project/${projectId || 0}`, [projectId]);
  const tplLabels = useMemo(() => {
    const sections: any[] = resolvedTpl?.config?.sections || [];
    const hoursSection = sections.find((s) => s.fields?.some((f: any) => f.type === "HOURS"));
    const hoursField = hoursSection?.fields?.find((f: any) => f.type === "HOURS");
    const commentsField = hoursSection?.fields?.find((f: any) => f.type === "TEXT" && f.id !== "date");
    const calcField = hoursSection?.fields?.find((f: any) => f.type === "CALCULATED");
    const approvalSection = sections.find((s) => s.fields?.some((f: any) => f.type === "APPROVAL"));
    const approvalFields = (approvalSection?.fields || []).filter((f: any) => f.type === "APPROVAL").sort((a: any, b: any) => a.order - b.order);
    return {
      hours: hoursField?.label || "Hours",
      comments: commentsField?.label || "Comment",
      total: calcField?.label || "Total",
      approvalFields,
    };
  }, [resolvedTpl]);
  const [cells, setCells] = useState<Record<number, Cell>>({});
  // Day-by-day detail (below the calendar) is hidden by default — an employee opts into seeing
  // it via "View", same as the PM Approvals page's own View/Hide toggle, rather than it always
  // being on screen (including after submit, when they're just checking what they sent).
  const [showDetail, setShowDetail] = useState(false);
  const [editDay, setEditDay] = useState<number | null>(null);
  const [draft, setDraft] = useState<Cell>({ hours: 8, leave: false, comment: "" });
  const [multi, setMulti] = useState(false);                      // multi-day select mode
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<Cell>({ hours: 8, leave: false, comment: "", heads: [{ head: "", hours: 8, billable: true }] });
  // Drag-select — mousedown on a day starts a drag, decides once (add vs. remove, based on
  // whether that first day was already selected) so every day the pointer then passes over gets
  // the SAME action rather than toggling back and forth as the mouse moves over them twice.
  const [dragging, setDragging] = useState(false);
  const [dragAdd, setDragAdd] = useState(true);
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, [dragging]);

  // the saved timesheet for the current selection (if any)
  const current = useMemo(() =>
    (mine || []).find((t) => String(t.projectId) === String(projectId) && t.periodMonth === month && t.periodYear === year),
    [mine, projectId, month, year]);

  // load saved entries into the grid whenever the selection identity changes. A day may have MANY
  // entries (one per "Time Logged On" head) — group them so each day's total = sum of its heads.
  useEffect(() => {
    const c: Record<number, Cell> = {};
    for (const e of current?.entries || []) {
      const d = e.day;
      if (!c[d]) c[d] = { hours: 0, leave: false, comment: "", heads: [] };
      if (e.leave) { c[d].leave = true; c[d].comment = c[d].comment || e.comment || ""; }
      else { c[d].heads!.push({ head: e.head || "", hours: +e.hours || 0, billable: e.billable !== false }); c[d].hours += (+e.hours || 0); c[d].comment = c[d].comment || e.comment || ""; }
      // PM/Finance flagged this specific day for correction (granular reject) — surfaced as a
      // stronger red than the plain "leave" tint below, distinct from the sheet-level
      // rejectedReason banner, so the employee can see exactly which days to fix.
      if (e.rejected) { c[d].rejected = true; c[d].rejectionComment = c[d].rejectionComment || e.rejectionComment || ""; }
    }
    setCells(c);
  }, [current?.id, projectId, month, year, actAs]);

  const editable = (!current || ["DRAFT", "REJECTED"].includes(current.status) || admin);
  const totalHours = Object.values(cells).reduce((s, c) => s + (c.leave ? 0 : +c.hours || 0), 0);
  const leaveDays = Object.values(cells).filter((c) => c.leave).length;

  const meta = useMemo(() => {
    const first = new Date(year, month - 1, 1).getDay();
    const days = new Date(year, month, 0).getDate();
    return { first, days };
  }, [year, month]);

  const openDay = (d: number) => {
    if (!editable) return;
    const c = cells[d];
    const heads = c && !c.leave && c.heads?.length ? c.heads.map((h) => ({ ...h })) : [{ head: "", hours: c && !c.leave ? (c.hours || 8) : 8, billable: true }];
    setDraft({ hours: c?.hours || 8, leave: !!c?.leave, comment: c?.comment || "", heads });
    setEditDay(d);
  };
  const saveDay = () => {
    if (editDay == null) return;
    const heads = draft.leave ? [] : (draft.heads || []).filter((h) => (+h.hours || 0) > 0 || (h.head || "").trim());
    const dayHours = heads.reduce((s, h) => s + (+h.hours || 0), 0);
    const n = { ...cells, [editDay]: { hours: draft.leave ? 0 : dayHours, leave: draft.leave, comment: draft.comment, heads } };
    setCells(n); setEditDay(null); persist(n, `${CAL[month - 1][0]} ${editDay} saved`);
  };
  const clearDay = () => { if (editDay == null) return; const n = { ...cells }; delete n[editDay]; setCells(n); setEditDay(null); persist(n, "Day cleared"); };

  const isWeekend = (d: number) => { const w = new Date(year, month - 1, d).getDay(); return w === 0 || w === 6; };
  const onDayClick = (d: number) => {
    if (!editable) return;
    if (multi) { const s = new Set(selected); s.has(d) ? s.delete(d) : s.add(d); setSelected(s); }
    else openDay(d);
  };
  // Drag-select, multi mode only — mousedown on a day decides add/remove from whether THAT day
  // was already selected, then every day the pointer enters while still held gets the same
  // action; mouseup (anywhere — see the window listener above) ends the drag. A plain click
  // (mousedown+mouseup, no drag) still just toggles the one day, same as before.
  const dayMouseDown = (d: number) => {
    if (!editable || !multi) return;
    const adding = !selected.has(d);
    setDragAdd(adding);
    setDragging(true);
    const s = new Set(selected);
    adding ? s.add(d) : s.delete(d);
    setSelected(s);
  };
  const dayMouseEnter = (d: number) => {
    if (!dragging || !multi) return;
    const s = new Set(selected);
    dragAdd ? s.add(d) : s.delete(d);
    setSelected(s);
  };
  const applyBulk = () => {
    if (!selected.size) return;
    const n = { ...cells };
    const cnt = selected.size;
    const heads = bulk.leave ? [] : (bulk.heads || []).filter((h) => (+h.hours || 0) > 0 || (h.head || "").trim());
    const dayHours = heads.reduce((s, h) => s + (+h.hours || 0), 0);
    selected.forEach((d) => { n[d] = { hours: bulk.leave ? 0 : dayHours, leave: bulk.leave, comment: bulk.comment, heads }; });
    setCells(n); setSelected(new Set()); persist(n, `Saved ${cnt} day(s)`);
  };
  // Clears entries for just the selected days (not the whole sheet) — e.g. selecting a week you
  // over-filled by mistake and starting those days fresh, without touching the rest of the month.
  const clearSelected = async () => {
    if (!selected.size) return;
    const cnt = selected.size;
    const ok = await confirm({ title: `Clear ${cnt} day(s)?`, danger: true, confirmLabel: "Clear", message: "Removes every entry for the selected day(s) on this project. This cannot be undone." });
    if (!ok) return;
    const n = { ...cells };
    selected.forEach((d) => { delete n[d]; });
    setCells(n); setSelected(new Set()); persist(n, `Cleared ${cnt} day(s)`);
  };
  // Resets the WHOLE month's sheet for this project back to empty — e.g. starting over rather
  // than clicking through every individual day. Only available while editable (DRAFT/REJECTED),
  // same gate as everything else on this screen.
  const resetTimesheet = async () => {
    if (!Object.keys(cells).length) return;
    const ok = await confirm({ title: "Reset entire timesheet?", danger: true, confirmLabel: "Reset", message: `Clears every entry for ${CAL[month - 1][0]} ${year} on this project. This cannot be undone.` });
    if (!ok) return;
    setCells({}); setSelected(new Set()); persist({}, "Timesheet reset");
  };
  const selectAllWeekdays = () => { const s = new Set<number>(); for (let d = 1; d <= meta.days; d++) if (!isWeekend(d)) s.add(d); setSelected(s); };
  const toggleMulti = () => { setMulti(!multi); setSelected(new Set()); };
  // cell background by state: leave=red, worked=green, weekend=muted, empty=panel
  const cellBg = (d: number, c?: Cell) => c?.rejected ? "rgba(229,72,77,.38)" : c?.leave ? "rgba(229,72,77,.18)" : (c && c.hours > 0) ? "rgba(52,211,153,.16)" : isWeekend(d) ? "rgba(139,150,176,.14)" : "var(--panel)";

  const bodyFor = (c: Record<number, Cell>) => ({
    projectId, periodMonth: month, periodYear: year,
    entries: Object.entries(c).flatMap(([d, x]) => {
      if (x.leave) return [{ day: +d, hours: 0, leave: true, comment: x.comment, head: null, billable: true }];
      const hs = (x.heads && x.heads.length) ? x.heads : [{ head: "", hours: x.hours, billable: true }];
      return hs.map((h) => ({ day: +d, hours: +h.hours || 0, leave: false, comment: x.comment, head: (h.head || "").trim() || null, billable: h.billable !== false }));
    }),
    ...(admin && actAs ? { employeeId: +actAs } : {}),
  });
  // Auto-save: any day change (single or bulk) persists the draft immediately, so there's
  // no separate "Save Draft" step. The only explicit action left is Submit for Approval.
  const persist = async (c: Record<number, Cell>, msg = "Saved") => {
    if (!projectId) return;
    try { await api.post("/timesheets", bodyFor(c)); show(msg); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  const submitForApproval = async () => {
    if (!projectId) return show("Pick a project first", "error");
    try { const ts = await api.post("/timesheets", bodyFor(cells)); await api.post(`/timesheets/${ts.id}/submit`, {}); show("Submitted to Project Manager"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };

  // approval-cycle actions (PM/Finance/admin) — usable right here to test the full flow
  const pmApprove = async (id: number) => { try { await api.post(`/timesheets/${id}/approve`, {}); show("PM approved → sent to Finance"); reload(); } catch (e: any) { show(e.message, "error"); } };
  // Loads a Draft/Rejected sheet from the list back into the calendar grid above for editing —
  // same selection the grid already reads from (`current` = mine/projectId/month/year), so no
  // separate edit form is needed, just point the calendar at this row's project/period.
  const editTimesheet = (t: any) => { setProjectId(String(t.projectId)); setMonth(t.periodMonth); setYear(t.periodYear); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const deleteTimesheet = async (id: number) => {
    const ok = await confirm({ title: "Delete this timesheet?", danger: true, confirmLabel: "Delete", message: "Removes this draft/rejected timesheet entirely — this cannot be undone." });
    if (!ok) return;
    try { await api.del(`/timesheets/${id}`); show("Timesheet deleted"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  const financeApprove = async (id: number) => {
    try { const r = await api.post(`/timesheets/${id}/finance-approve`, {}); show(r?.mapping?.applied ? `Finance approved → reflected into ${r.mapping.month} ${r.mapping.fiscalYear} Invoice` : `Finance approved (not reflected: ${r?.mapping?.reason || "no matching line"})`, r?.mapping?.applied ? "success" : "error"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const reject = async (id: number) => {
    const reason = await confirm({ title: "Reject timesheet?", prompt: true, danger: true, confirmLabel: "Reject", message: "Reason (sent back to the employee):", placeholder: "e.g. Hours look off for week 2" });
    if (reason === null) return;
    try { await api.post(`/timesheets/${id}/reject`, { reason: reason || "Rejected" }); show("Rejected"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  // Reject only the specific day(s)/head(s) checked in this sheet's expanded detail table —
  // each with its own comment — so the employee sees exactly which cells to fix, highlighted red.
  const rejectEntries = async (id: number) => {
    const keys = [...(rejectSel[id] || [])];
    if (!keys.length) return show("Select at least one day first", "error");
    const comments = rejectComments[id] || {};
    const entries = keys.map((k) => { const [day, head] = k.split(":"); return { day: +day, head: head || null, comment: comments[k] || "" }; });
    try {
      await api.post(`/timesheets/${id}/reject-entries`, { entries });
      show(`Rejected ${entries.length} day(s)`);
      setRejectSel({ ...rejectSel, [id]: new Set() });
      reload();
    } catch (e: any) { show(e.message, "error"); }
  };

  const stepHr = (s: string) => (["SUBMITTED", "PM_APPROVED", "FINANCE_APPROVED"].includes(s) ? 1 : 0) + (["PM_APPROVED", "FINANCE_APPROVED"].includes(s) ? 1 : 0) + (s === "FINANCE_APPROVED" ? 1 : 0);

  return (
    <div>
      <h1>My Timesheet</h1>
      <div className="subtitle">Pick a client, project &amp; month, then click any day to log hours or mark leave. <b>Entries save automatically</b> — click <b>Submit for Approval</b> when done. Flow: <b>You → Project Manager → Finance</b> → reflected in the monthly Invoice column.</div>
      {!admin && !user?.employeeId && <div className="note">Your login is not linked to an employee record. Ask an admin to link you.</div>}

      <Panel style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", columnGap: 14, rowGap: 12 }}>
          {admin && (
            <div style={{ flex: "0 0 auto", minWidth: 0 }}>
              <label style={{ display: "block", marginBottom: 4 }}>Employee (act on behalf)</label>
              <select value={actAs} onChange={(e) => setActAs(e.target.value)} style={{ width: 220 }}>
                <option value="">— select employee —</option>
                {(emps || []).map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ flex: "0 0 auto", minWidth: 0 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Period</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <GhostButton onClick={() => { const m = month === 1 ? 12 : month - 1; setMonth(m); if (m === 12) setYear(year - 1); }} icon={<ChevronLeftRoundedIcon />}>Prev</GhostButton>
              <select value={month} onChange={(e) => setMonth(+e.target.value)} style={{ width: 100 }}>
                {CAL.map(([m, n]) => <option key={n} value={n}>{m}</option>)}
              </select>
              <input type="number" value={year} onChange={(e) => setYear(+e.target.value)} style={{ width: 84 }} />
              <GhostButton onClick={() => { const m = month === 12 ? 1 : month + 1; setMonth(m); if (m === 1) setYear(year + 1); }} icon={<ChevronRightRoundedIcon />}>Next</GhostButton>
            </div>
          </div>
          <div style={{ flex: "0 0 auto", minWidth: 0 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Client</label>
            <select value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(""); }} style={{ width: 200 }} disabled={!clients.length}>
              <option value="">{clients.length ? "— select client —" : "— no project forecasted this month —"}</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ flex: "0 0 auto", minWidth: 0 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 230 }} disabled={!clientId}>
              <option value="">{clientId ? "— select project —" : "— select client first —"}</option>
              {clientProjects.map((p: any) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
            </select>
          </div>
          {!!projectId && (
            <div style={{ flex: "0 0 auto", minWidth: 0, display: "flex", alignItems: "flex-end", gap: 6 }}>
              <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/preview-for-project/${projectId}`), "_blank")}>Preview Timesheet</GhostButton>
              {/* Real downloadable export of the SAVED timesheet (needs a real timesheetId —
                  unlike Preview above, which works even before anything is saved) laid out using
                  this project's resolved template, same engine the live preview uses. */}
              {current && <>
                <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${current.id}?format=xlsx`), "_blank")}>Export Excel</GhostButton>
                <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${current.id}?format=pdf`), "_blank")}>Export PDF</GhostButton>
              </>}
            </div>
          )}
          {current && <div style={{ flex: "0 0 auto", alignSelf: "center", paddingBottom: 2 }}><StatusBadge s={current.status} /></div>}
        </div>
        {current?.status === "REJECTED" && current.rejectedReason && <div className="err" style={{ marginTop: 10 }}>Rejected: {current.rejectedReason}</div>}
      </Panel>

      <Panel title={`${CAL[month - 1][0]} ${year} — ${totalHours} ${tplLabels.hours} · ${leaveDays} leave day(s)`} style={{ marginBottom: 14 }}>
        {(!projectId || (admin && !actAs)) ? (
          <div style={{ color: "var(--muted)" }}>
            {admin && !actAs ? "Select an employee and project to begin."
              : !clients.length ? `No project is forecasted for you in ${CAL[month - 1][0]} ${year} — nothing to submit a timesheet against.`
              : "Select a project to begin."}
          </div>
        ) : (
          <>
            {/* toolbar: multi-select + legend */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 12 }}>
              {editable && <GhostButton onClick={toggleMulti} icon={multi ? <DoneAllRoundedIcon /> : <LibraryAddCheckRoundedIcon />}>{multi ? "Exit multi-select" : "Select multiple days"}</GhostButton>}
              {multi && editable && <>
                <GhostButton onClick={selectAllWeekdays}>All weekdays</GhostButton>
                <GhostButton onClick={() => setSelected(new Set())}>Deselect all</GhostButton>
                {selected.size > 0 && <GhostButton onClick={clearSelected}>Clear {selected.size} day(s)</GhostButton>}
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{selected.size} selected — click, or click-and-drag across days</span>
              </>}
              {editable && Object.keys(cells).length > 0 && <GhostButton onClick={resetTimesheet}>Reset entire timesheet</GhostButton>}
              <div style={{ flex: 1 }} />
              <Legend color="rgba(52,211,153,.6)" label="Worked" />
              <Legend color="rgba(139,150,176,.5)" label="Weekend" />
              <Legend color="rgba(229,72,77,.6)" label="Leave" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              {WD.map((d, i) => <div key={d} style={{ textAlign: "center", color: i === 0 || i === 6 ? "var(--accent)" : "var(--muted)", fontSize: 12, fontWeight: 600, padding: "4px 0" }}>{d}</div>)}
              {Array.from({ length: meta.first }).map((_, i) => <div key={"b" + i} />)}
              {Array.from({ length: meta.days }).map((_, i) => {
                const d = i + 1; const c = cells[d]; const sel = selected.has(d);
                return (
                  <div key={d} onClick={() => { if (!multi) onDayClick(d); }}
                    onMouseDown={() => dayMouseDown(d)} onMouseEnter={() => dayMouseEnter(d)}
                    title={c?.rejected ? `Flagged by PM/Finance: ${c.rejectionComment || "needs correction"}` : undefined}
                    style={{
                      minHeight: 66, borderRadius: 8, padding: 6, position: "relative",
                      cursor: editable ? "pointer" : "default", userSelect: dragging ? "none" : undefined,
                      outline: sel ? "2px solid var(--accent)" : c?.rejected ? "2px solid #e5484d" : "none", outlineOffset: -2,
                      border: c?.rejected ? "1px solid #e5484d" : "1px solid var(--border)", background: cellBg(d, c),
                    }}>
                    <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: isWeekend(d) ? 700 : 400 }}>{d}</span>
                      {c?.rejected ? <span title={c.rejectionComment || "Flagged for correction"} style={{ fontSize: 13 }}>⚠️</span> : c?.comment && <ChatBubbleOutlineRoundedIcon sx={{ fontSize: 13 }} titleAccess={c.comment} />}
                    </div>
                    {c?.rejected && <div style={{ color: "#e5484d", fontWeight: 700, fontSize: 11, marginTop: 2 }}>Fix &amp; resubmit</div>}
                    {c?.leave ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#e5484d", fontWeight: 700, fontSize: 13, marginTop: 6 }}><EventBusyRoundedIcon sx={{ fontSize: 16 }} /> Leave</div>
                    ) : c && c.hours > 0 ? (
                      <div style={{ color: "#16a34a", fontWeight: 700, fontSize: 18, marginTop: 4 }}>{c.hours}<span style={{ fontSize: 12, fontWeight: 500 }}>h</span></div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Read-only — the resolved template's own Approval-section field labels (Finance can
                rename/reorder/add to these), mapped onto the one real workflow this app actually
                runs (Draft → Submitted → PM → Finance). Known field ids map to their matching
                step; any other/renamed approval field just shows Pending — informational only,
                never a second approval mechanism alongside the Submit/Approve buttons below. */}
            {tplLabels.approvalFields.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel2)" }}>
                {tplLabels.approvalFields.map((f: any) => {
                  const done = current && (
                    (f.id === "employeeApproval" && ["SUBMITTED", "PM_APPROVED", "FINANCE_APPROVED"].includes(current.status)) ||
                    (f.id === "pmApproval" && ["PM_APPROVED", "FINANCE_APPROVED"].includes(current.status)) ||
                    (f.id === "financeApproval" && current.status === "FINANCE_APPROVED")
                  );
                  return (
                    <div key={f.id} style={{ fontSize: 12 }}>
                      <span style={{ color: "var(--muted)" }}>{f.label}: </span>
                      <span style={{ fontWeight: 600, color: done ? "#34d399" : "var(--muted)" }}>{done ? "✓ Done" : "Pending"}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* bulk editor for the selected days — same multi-task "heads" table as the single-day
                popup, applied identically to every selected day at once. */}
            {multi && editable && selected.size > 0 && (
              <div style={{ marginTop: 14, padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel2)" }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Set {selected.size} selected day(s) at once</div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginBottom: 8 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={bulk.leave} onChange={(e) => setBulk({ ...bulk, leave: e.target.checked })} /> Mark as leave
                </label>
                {!bulk.leave && (
                  <div style={{ marginBottom: 8 }}>
                    <label>{tplLabels.hours} by <b>Time Logged On</b> (head) — add a row per task, applied to every selected day</label>
                    <table style={{ width: "100%" }}>
                      <thead><tr><th style={{ textAlign: "left" }}>Time Logged On</th><th style={{ width: 90 }}>{tplLabels.hours}</th><th style={{ width: 80, textAlign: "center" }}>Billable</th><th style={{ width: 30 }}></th></tr></thead>
                      <tbody>
                        {(bulk.heads || []).map((h, i) => (
                          <tr key={i}>
                            <td><input style={{ width: "100%" }} value={h.head} placeholder="e.g. Project A / Support / Meetings" onChange={(e) => { const hs = [...(bulk.heads || [])]; hs[i] = { ...hs[i], head: e.target.value }; setBulk({ ...bulk, heads: hs }); }} /></td>
                            <td><input type="number" min={0} max={24} step={0.5} style={{ width: 80, textAlign: "right" }} value={h.hours} onChange={(e) => { const hs = [...(bulk.heads || [])]; hs[i] = { ...hs[i], hours: +e.target.value }; setBulk({ ...bulk, heads: hs }); }} /></td>
                            <td style={{ textAlign: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={h.billable !== false} onChange={(e) => { const hs = [...(bulk.heads || [])]; hs[i] = { ...hs[i], billable: e.target.checked }; setBulk({ ...bulk, heads: hs }); }} /></td>
                            <td><button className="ghost" onClick={() => setBulk({ ...bulk, heads: (bulk.heads || []).filter((_, j) => j !== i) })}>✕</button></td>
                          </tr>
                        ))}
                        <tr><td style={{ textAlign: "right", fontWeight: 600 }}>{tplLabels.total} / day</td><td style={{ textAlign: "right", fontWeight: 600 }}>{(bulk.heads || []).reduce((s, h) => s + (+h.hours || 0), 0)}h</td><td></td><td></td></tr>
                      </tbody>
                    </table>
                    <button className="ghost" style={{ marginTop: 6 }} onClick={() => setBulk({ ...bulk, heads: [...(bulk.heads || []), { head: "", hours: 0, billable: true }] })}>+ Add task</button>
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <div style={{ flex: 1, minWidth: 200 }}><label style={{ display: "block", marginBottom: 4 }}>{tplLabels.comments}</label><input value={bulk.comment} onChange={(e) => setBulk({ ...bulk, comment: e.target.value })} placeholder={bulk.leave ? "Leave reason" : "Note for all selected days (optional)"} /></div>
                  <AddButton onClick={applyBulk} icon={<LibraryAddCheckRoundedIcon />}>Apply to {selected.size} day(s)</AddButton>
                </div>
              </div>
            )}

            {editable && (
              <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <AddButton onClick={submitForApproval} icon={<SendRoundedIcon />}>Submit for Approval</AddButton>
                <span style={{ color: "var(--muted)", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}><EditCalendarRoundedIcon sx={{ fontSize: 15 }} /> Entries auto-save as you go — just submit when done.</span>
              </div>
            )}
          </>
        )}
      </Panel>

      {projectId && (!admin || actAs) && Object.keys(cells).length > 0 && (
        <Panel title="Day-by-day detail (this month)" style={{ marginBottom: 14 }}
          actions={<GhostButton onClick={() => setShowDetail(!showDetail)} icon={<VisibilityOutlinedIcon />}>{showDetail ? "Hide" : "View"}</GhostButton>}>
          {!showDetail ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Hidden by default — click View to see every logged day/task, including after you've submitted.</div>
          ) : (
          <>
          {/* One row PER TASK (head), not one summed row per day — otherwise a day (or, via bulk
              apply, many days) with several tasks logged collapses into a single blended-hours
              row here with no breakdown, even though the day's own popup and the server both
              already track each task separately. Mirrors bodyFor's own per-head flattening. */}
          <TimesheetEntriesTable periodMonth={month} periodYear={year}
            entries={Object.entries(cells).flatMap(([d, c]) => {
              if (c.leave) return [{ day: +d, hours: 0, leave: true, comment: c.comment, rejected: c.rejected, rejectionComment: c.rejectionComment, head: null, billable: true }];
              const hs = (c.heads && c.heads.length) ? c.heads : [{ head: "", hours: c.hours, billable: true }];
              return hs.map((h) => ({ day: +d, hours: +h.hours || 0, leave: false, comment: c.comment, head: h.head || null, rejected: c.rejected, rejectionComment: c.rejectionComment, billable: h.billable !== false }));
            })} />
          </>
          )}
        </Panel>
      )}

      <Panel title="My Timesheets">
        <div style={{ marginBottom: 8 }}><FilterToggle sf={mineSf} /></div>
        <table>
          <SortableHead cols={MY_COLS} sf={mineSf} leading={<th></th>} trailing={<th style={{ textAlign: "right" }}>Action</th>} />
          <tbody>{mineSf.view.length === 0 ? <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No timesheets yet.</td></tr> :
            mineSf.view.map((t: any) => (
              <React.Fragment key={t.id}>
              <tr>
                <td><GhostButton onClick={() => toggleExp(t.id)} icon={<VisibilityOutlinedIcon />}>{expanded.has(t.id) ? "Hide" : "View"}</GhostButton></td>
                <td>{t.project?.name}</td>
                <td>{CAL[t.periodMonth - 1][0]} {t.periodYear}</td>
                <td className="num">{t.totalHours}</td>
                <td className="num">{t.leaveDays}</td>
                <td><StatusBadge s={t.status} /></td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {(t.status === "DRAFT" || t.status === "REJECTED") && (
                    <>
                      <GhostButton onClick={() => editTimesheet(t)} icon={<EditOutlinedIcon />}>Edit</GhostButton>{" "}
                      <GhostButton onClick={() => deleteTimesheet(t.id)} icon={<DeleteOutlineIcon />}>Delete</GhostButton>{" "}
                    </>
                  )}
                  <GhostButton onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${t.id}?format=xlsx`), "_blank")}>Export</GhostButton>{" "}
                  {(t.status === "DRAFT" || t.status === "REJECTED") && (
                    <GhostButton onClick={async () => { setProjectId(String(t.projectId)); setMonth(t.periodMonth); setYear(t.periodYear); await api.post(`/timesheets/${t.id}/submit`, {}).then(() => { show("Submitted"); reload(); }).catch((e: any) => show(e.message, "error")); }} icon={<SendRoundedIcon />}>Submit</GhostButton>
                  )}
                  {t.status === "SUBMITTED" && canApprove && (
                    <>
                      <AddButton onClick={() => pmApprove(t.id)} icon={<ThumbUpAltRoundedIcon />}>Approve (PM)</AddButton>{" "}
                      <GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject All</GhostButton>
                    </>
                  )}
                  {t.status === "PM_APPROVED" && admin && (
                    <>
                      <AddButton onClick={() => financeApprove(t.id)} icon={<ThumbUpAltRoundedIcon />}>Approve (Finance)</AddButton>{" "}
                      <GhostButton onClick={() => reject(t.id)} icon={<CloseRoundedIcon />}>Reject All</GhostButton>
                    </>
                  )}
                  {t.status === "FINANCE_APPROVED" && <span style={{ color: "#34d399", fontSize: 12 }}>Reflected in Invoice ✓</span>}
                </td>
              </tr>
              {expanded.has(t.id) && (
                <tr><td colSpan={7} style={{ background: "var(--panel2)", padding: 12 }}>
                  <TimesheetEntriesTable periodMonth={t.periodMonth} periodYear={t.periodYear} entries={t.entries}
                    selectable={(t.status === "SUBMITTED" || t.status === "PM_APPROVED") && canApprove}
                    selected={rejectSel[t.id]} onToggle={(key) => toggleRejectKey(t.id, key)}
                    comments={rejectComments[t.id]} onCommentChange={(key, v) => setRejectComment(t.id, key, v)} />
                  {(t.status === "SUBMITTED" || t.status === "PM_APPROVED") && canApprove && (
                    <div style={{ marginTop: 8 }}>
                      <GhostButton disabled={!(rejectSel[t.id]?.size)} onClick={() => rejectEntries(t.id)} icon={<CloseRoundedIcon />}>
                        Reject Selected Day(s){rejectSel[t.id]?.size ? ` (${rejectSel[t.id].size})` : ""}
                      </GhostButton>
                    </div>
                  )}
                </td></tr>
              )}
              </React.Fragment>
            ))}</tbody>
        </table>
        {admin && <div className="note" style={{ marginTop: 10 }}>As an admin you can drive the whole cycle here: enter on behalf of an employee → Submit → Approve (PM) → Approve (Finance). Finance approval reflects the hours into that month's Invoice column on Forecast Monthly Revenue &amp; Expenses.</div>}
      </Panel>

      <Modal title={editDay ? `${CAL[month - 1][0]} ${editDay}, ${year}` : ""} open={editDay != null} onClose={() => setEditDay(null)} onSave={saveDay} saveLabel="Save Day">
        <div className="form-grid">
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={draft.leave} onChange={(e) => setDraft({ ...draft, leave: e.target.checked })} />
            Mark as leave day
          </label>
          {!draft.leave && (
            <div className="full">
              <label>{tplLabels.hours} by <b>Time Logged On</b> (head) — add a row per head you worked on</label>
              <table style={{ width: "100%" }}>
                <thead><tr><th style={{ textAlign: "left" }}>Time Logged On</th><th style={{ width: 90 }}>{tplLabels.hours}</th><th style={{ width: 80, textAlign: "center" }}>Billable</th><th style={{ width: 30 }}></th></tr></thead>
                <tbody>
                  {(draft.heads || []).map((h, i) => (
                    <tr key={i}>
                      <td><input style={{ width: "100%" }} value={h.head} placeholder="e.g. Project A / Support / Meetings" onChange={(e) => { const hs = [...(draft.heads || [])]; hs[i] = { ...hs[i], head: e.target.value }; setDraft({ ...draft, heads: hs }); }} /></td>
                      <td><input type="number" min={0} max={24} step={0.5} style={{ width: 80, textAlign: "right" }} value={h.hours} onChange={(e) => { const hs = [...(draft.heads || [])]; hs[i] = { ...hs[i], hours: +e.target.value }; setDraft({ ...draft, heads: hs }); }} /></td>
                      <td style={{ textAlign: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={h.billable !== false} onChange={(e) => { const hs = [...(draft.heads || [])]; hs[i] = { ...hs[i], billable: e.target.checked }; setDraft({ ...draft, heads: hs }); }} /></td>
                      <td><button className="ghost" onClick={() => setDraft({ ...draft, heads: (draft.heads || []).filter((_, j) => j !== i) })}>✕</button></td>
                    </tr>
                  ))}
                  <tr><td style={{ textAlign: "right", fontWeight: 600 }}>{tplLabels.total}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{(draft.heads || []).reduce((s, h) => s + (+h.hours || 0), 0)}h</td><td></td><td></td></tr>
                </tbody>
              </table>
              <button className="ghost" style={{ marginTop: 6 }} onClick={() => setDraft({ ...draft, heads: [...(draft.heads || []), { head: "", hours: 0, billable: true }] })}>+ Add head</button>
            </div>
          )}
          <div className="full"><label>{tplLabels.comments} {draft.leave ? "(leave reason)" : "(optional)"}</label>
            <textarea rows={3} value={draft.comment} onChange={(e) => setDraft({ ...draft, comment: e.target.value })} placeholder={draft.leave ? "e.g. Casual leave" : "What did you work on?"} />
          </div>
          {cells[editDay || -1] && <button className="ghost full" onClick={clearDay}>Clear this day</button>}
        </div>
      </Modal>
    </div>
  );
}
