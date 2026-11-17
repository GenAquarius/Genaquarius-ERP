// Employee Dashboard extras — Regularization & Permission (batch apply with calendar picker,
// Pending / History), Org Chart + Directory, and Salary & Designation Revision.
// Server side: routes/ess.ts (/ess/regularization-permission/*, /ess/org-chart, /ess/salary-revisions).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Line } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from "chart.js";
import { api } from "../../api";
import { useFetch, Panel, fmt, useMaskNumbers } from "../../ui";
import { fmtDate } from "../../dateFormat";
import { AddButton, GhostButton, useToast, confirmDialog, DeleteAction } from "../../components";
import { useAuth } from "../../auth";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

const dstr = fmtDate;
const tstr = (d: any) => (d ? new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—");
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const STATUS_CLASS = (s: string) => (s === "APPROVED" || s === "RESOLVED" || s === "CLOSED" ? "good" : s === "REJECTED" ? "bad" : s === "CANCELLED" ? "" : "accent");

/** "1 year 2 months 5 days" between two dates. */
export function durationText(from: any, to: any = new Date()) {
  if (!from) return "—";
  const a = new Date(from), b = new Date(to);
  if (b < a) return "—";
  let y = b.getFullYear() - a.getFullYear(), m = b.getMonth() - a.getMonth(), d = b.getDate() - a.getDate();
  if (d < 0) { m -= 1; d += new Date(b.getFullYear(), b.getMonth(), 0).getDate(); }
  if (m < 0) { y -= 1; m += 12; }
  const parts = [y ? `${y} year${y > 1 ? "s" : ""}` : "", m ? `${m} month${m > 1 ? "s" : ""}` : "", `${d} day${d !== 1 ? "s" : ""}`].filter(Boolean);
  return parts.join(" ");
}

export function Segmented<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, string][] }) {
  return (
    <div className="seg">
      {items.map(([k, l]) => <button key={k} type="button" className={value === k ? "on" : ""} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

export function Avatar({ emp, size = 36 }: { emp: { id?: number; name?: string; hasPhoto?: boolean }; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = String(emp?.name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
  if (emp?.hasPhoto && emp.id && !broken) return <img className="avatar" src={api.pdfUrl(`/ess/photo/${emp.id}`)} onError={() => setBroken(true)} style={{ width: size, height: size }} alt="" />;
  return <div className="avatar initials" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</div>;
}

// =====================================================================================
// Regularization & Permission
// =====================================================================================
type Row = { key: number; type: string; fromTime: string; toTime: string; reason: string };
let rowSeq = 1;
const newRow = (): Row => ({ key: rowSeq++, type: "", fromTime: "", toTime: "", reason: "" });

export function RegularizationPermission() {
  const [view, setView] = useState<"apply" | "pending" | "history">("apply");
  const { data: requests, reload } = useFetch<any[]>("/ess/regularization-permission/requests");
  const pending = (requests || []).filter((r) => r.status === "PENDING");
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <Segmented value={view} onChange={setView} items={[["apply", "Apply"], ["pending", `Pending${pending.length ? ` (${pending.length})` : ""}`], ["history", "History"]]} />
      </div>
      {view === "apply" ? <ApplyView onDone={() => { reload(); setView("pending"); }} />
        : <RequestList rows={view === "pending" ? pending : (requests || []).filter((r) => r.status !== "PENDING")} reload={reload} pending={view === "pending"} />}
    </div>
  );
}

function ApplyView({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const { show } = useToast();
  const { data: me } = useFetch<any>("/ess/me");
  const { data: types } = useFetch<any[]>("/ess/regularization-permission/types");
  const { data: colleagues } = useFetch<any[]>("/ess/colleagues");
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [dates, setDates] = useState<Record<string, { rows: Row[]; open: boolean }>>({ [ymd(today)]: { rows: [newRow()], open: true } });
  const [cc, setCc] = useState<string[]>([]);
  const [ccPick, setCcPick] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  const m = cursor.getMonth() + 1, y = cursor.getFullYear();
  const { data: records } = useFetch<any[]>(`/ess/attendance?month=${m}&year=${y}`, [m, y]);
  const { data: holidays } = useFetch<any[]>("/ess/holidays");
  const holidaySet = useMemo(() => new Set((holidays || []).map((h) => String(h.date).slice(0, 10))), [holidays]);
  const recordByDay = useMemo(() => new Map((records || []).map((r) => [String(r.date).slice(0, 10), r])), [records]);

  const toggleDate = (key: string) => setDates((d) => {
    const n = { ...d };
    if (n[key]) delete n[key]; else n[key] = { rows: [newRow()], open: true };
    return n;
  });
  const setRow = (date: string, key: number, patch: Partial<Row>) => setDates((d) => ({ ...d, [date]: { ...d[date], rows: d[date].rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } }));
  const addRow = (date: string) => setDates((d) => ({ ...d, [date]: { ...d[date], rows: [...d[date].rows, newRow()] } }));
  const delRow = (date: string, key: number) => setDates((d) => {
    const rows = d[date].rows.filter((r) => r.key !== key);
    const n = { ...d };
    if (rows.length) n[date] = { ...d[date], rows }; else delete n[date];
    return n;
  });

  // Calendar grid (Sun-first, 6 rows)
  const first = new Date(y, m - 1, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const dayMark = (d: Date) => {
    const k = ymd(d);
    const rec = recordByDay.get(k);
    if (holidaySet.has(k)) return "holiday";
    if (rec?.checkInTime && !rec?.checkOutTime && k !== ymd(today)) return "partial";
    if (rec) return rec.status === "WFH" ? "wfh" : "present";
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    if (!isWeekend && d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) return "absent";
    return "";
  };

  const addCc = (email: string) => { if (email && !cc.includes(email)) setCc([...cc, email]); setCcPick(""); };
  const sortedDates = Object.keys(dates).sort();
  const typeKind = (k: string) => (types || []).find((t) => t.key === k)?.kind;

  const submit = async () => {
    const entries = sortedDates.flatMap((date) => dates[date].rows.map((r) => ({
      date, type: r.type, fromTime: r.fromTime, toTime: r.toTime, reason: r.reason,
      fromIso: r.fromTime ? new Date(`${date}T${r.fromTime}:00`).toISOString() : null,
      toIso: r.toTime ? new Date(`${date}T${r.toTime}:00`).toISOString() : null,
    })));
    if (!entries.length) return show("Pick at least one date on the calendar", "error");
    for (const e of entries) {
      if (!e.type) return show(`${dstr(parseYmd(e.date))}: select a Permission Type`, "error");
      if (!e.reason.trim()) return show(`${dstr(parseYmd(e.date))}: enter a reason`, "error");
      if (typeKind(e.type) === "PERMISSION" && (!e.fromTime || !e.toTime)) return show(`${dstr(parseYmd(e.date))}: From and To time are required`, "error");
      if (typeKind(e.type) === "REGULARIZATION" && !e.fromTime && !e.toTime) return show(`${dstr(parseYmd(e.date))}: enter check-in and/or check-out time`, "error");
      if (e.fromTime && e.toTime && e.fromTime >= e.toTime) return show(`${dstr(parseYmd(e.date))}: To time must be after From time`, "error");
    }
    setBusy(true);
    try {
      const r: any = await api.post("/ess/regularization-permission/apply", { entries, cc, remarks });
      show(`${r.created} request${r.created > 1 ? "s" : ""} submitted for approval`);
      setDates({}); setCc([]); setRemarks("");
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div className="rp-layout">
      <div>
        <div className="me-chip">
          <Avatar emp={{ id: me?.id, name: me?.name || user?.name, hasPhoto: !!me?.photoFileName }} size={42} />
          <div><div style={{ fontWeight: 600 }}>Me</div><div style={{ color: "var(--muted)", fontSize: 12 }}>#{me?.empNo || "—"}</div></div>
        </div>
        <div className="panel mini-cal">
          <div className="mc-head">
            <button type="button" className="icon-btn" onClick={() => setCursor(new Date(y, m - 2, 1))}>‹</button>
            <b>{MONTHS[m - 1]} {y}</b>
            <button type="button" className="icon-btn" onClick={() => setCursor(new Date(y, m, 1))}>›</button>
          </div>
          <div className="mc-grid">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="mc-dow">{d}</div>)}
            {cells.map((d) => {
              const k = ymd(d);
              const other = d.getMonth() !== m - 1;
              const mark = dayMark(d);
              return (
                <button type="button" key={k} onClick={() => toggleDate(k)}
                  className={`mc-day ${other ? "other" : ""} ${dates[k] ? "sel" : ""} ${k === ymd(today) ? "today" : ""}`}>
                  {d.getDate()}{mark && !other && <span className={`mc-dot ${mark}`} />}
                </button>
              );
            })}
          </div>
          <div className="mc-foot">
            <div style={{ color: "var(--muted)", fontSize: 12 }}>Jump To</div>
            <a href="#" onClick={(e) => { e.preventDefault(); setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); }} style={{ fontWeight: 600 }}>{dstr(today)}</a>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setShowLegend(!showLegend); }} style={{ fontSize: 13 }}>{showLegend ? "Hide" : "Show"} Legend</a>
          {showLegend && (
            <div className="panel" style={{ marginTop: 8, display: "grid", gap: 6, fontSize: 12 }}>
              {[["present", "Present"], ["wfh", "Work From Home"], ["partial", "Missing check-out"], ["absent", "Unmarked / absent"], ["holiday", "Holiday"]].map(([k, l]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}><span className={`mc-dot ${k}`} style={{ position: "static" }} />{l}</div>
              ))}
              <div style={{ color: "var(--muted)" }}>Click dates to add / remove them from this request.</div>
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="panel rp-top">
          <div>
            <label>Add CC</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {cc.map((e) => <span key={e} className="chip">{e}<button type="button" onClick={() => setCc(cc.filter((x) => x !== e))}>×</button></span>)}
              <select value={ccPick} onChange={(e) => addCc(e.target.value)} style={{ width: 220 }}>
                <option value="">+ Add CC</option>
                {(colleagues || []).filter((c) => !cc.includes(c.email)).map((c) => <option key={c.id} value={c.email}>{c.name}{c.empNo ? ` (${c.empNo})` : ""}</option>)}
              </select>
            </div>
          </div>
          <div className="rp-divider" />
          <div>
            <label>Remarks</label>
            <textarea rows={2} placeholder="Write Here" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </div>

        {sortedDates.length === 0 && <div className="panel" style={{ marginTop: 14, color: "var(--muted)", textAlign: "center", padding: 30 }}>Select one or more dates on the calendar to start a request.</div>}

        {sortedDates.map((date) => {
          const d = parseYmd(date);
          const rec = recordByDay.get(date);
          return (
            <div key={date} className="panel" style={{ marginTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16, flex: 1 }}>
                  {d.toLocaleDateString("en-GB", { weekday: "short" })}, {dstr(d)}
                  {rec && <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 400, color: "var(--muted)" }}>Recorded: in {tstr(rec.checkInTime)} · out {tstr(rec.checkOutTime)}</span>}
                </div>
                <button type="button" className="icon-btn" title={dates[date].open ? "Collapse" : "Expand"} onClick={() => setDates((x) => ({ ...x, [date]: { ...x[date], open: !x[date].open } }))}>{dates[date].open ? "︿" : "﹀"}</button>
                <button type="button" className="icon-btn" title="Remove this date" onClick={() => toggleDate(date)}>✕</button>
              </div>
              {dates[date].open && (
                <>
                  <div className="rp-row rp-head"><div>Permission Type</div><div>From Time - To Time</div><div>Reason</div><div /></div>
                  {dates[date].rows.map((r) => (
                    <div key={r.key} className="rp-row">
                      <select value={r.type} onChange={(e) => setRow(date, r.key, { type: e.target.value })}>
                        <option value="">Select</option>
                        {(types || []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                      </select>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="time" value={r.fromTime} onChange={(e) => setRow(date, r.key, { fromTime: e.target.value })} />
                        <span>-</span>
                        <input type="time" value={r.toTime} onChange={(e) => setRow(date, r.key, { toTime: e.target.value })} />
                      </div>
                      <textarea rows={2} placeholder="Enter Description" value={r.reason} onChange={(e) => setRow(date, r.key, { reason: e.target.value })} />
                      <DeleteAction title="Remove row" onClick={() => delRow(date, r.key)} />
                    </div>
                  ))}
                  {dates[date].rows.some((r) => typeKind(r.type) === "REGULARIZATION") && (
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>For a missed punch, From = actual check-in and To = actual check-out (either can be left blank).</div>
                  )}
                  <div style={{ textAlign: "right", marginTop: 8 }}>
                    <a href="#" onClick={(e) => { e.preventDefault(); addRow(date); }} style={{ fontWeight: 600 }}>+ Add More</a>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {sortedDates.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <GhostButton onClick={() => { setDates({}); setRemarks(""); setCc([]); }}>Clear</GhostButton>
            <AddButton disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Submit for Approval"}</AddButton>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestList({ rows, reload, pending }: { rows: any[]; reload: () => void; pending: boolean }) {
  const { show } = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const cancel = async (r: any) => {
    const ok = await confirmDialog({ title: "Cancel this request?", message: `${r.typeLabel} on ${dstr(r.date)}`, danger: true, confirmLabel: "Cancel request" });
    if (!ok) return;
    try {
      await api.post(r.kind === "REGULARIZATION" ? `/ess/attendance/regularization/${r.id}/cancel` : `/ess/permission-requests/${r.id}/cancel`);
      show("Request cancelled"); reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  const filtered = rows.filter((r) => (!status || r.status === status) && (!q || `${r.typeLabel} ${r.reason} ${r.remarks || ""}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <Panel>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <input placeholder="Search type / reason…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        {!pending && <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All statuses</option><option>APPROVED</option><option>REJECTED</option><option>CANCELLED</option>
        </select>}
      </div>
      <table><thead><tr><th>Date</th><th>Type</th><th>From – To</th><th>Reason</th><th>Remarks</th><th>Applied On</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {filtered.length === 0 && <tr><td colSpan={8} style={{ color: "var(--muted)" }}>{pending ? "No pending requests." : "No past requests."}</td></tr>}
          {filtered.map((r) => (
            <tr key={`${r.kind}-${r.id}`}>
              <td style={{ whiteSpace: "nowrap" }}>{dstr(r.date)}</td>
              <td>{r.typeLabel}</td>
              <td style={{ whiteSpace: "nowrap" }}>{r.kind === "REGULARIZATION" ? `${tstr(r.fromIso)} – ${tstr(r.toIso)}` : `${r.fromTime} – ${r.toTime}`}</td>
              <td>{r.reason}</td>
              <td style={{ color: "var(--muted)" }}>{r.remarks || "—"}{r.ccEmails ? <div style={{ fontSize: 11 }}>CC: {r.ccEmails.split(",").join(", ")}</div> : null}</td>
              <td style={{ whiteSpace: "nowrap" }}>{dstr(r.createdAt)}</td>
              <td><span className={`pill ${STATUS_CLASS(r.status)}`}>{r.status}</span></td>
              <td>{r.status === "PENDING" && <GhostButton onClick={() => cancel(r)}>Cancel</GhostButton>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// =====================================================================================
// Org Chart + Directory
// =====================================================================================
type OrgEmp = { id: number; name: string; empNo?: string; email?: string; designation?: string; department?: string; location?: string; managerId: number | null; hasPhoto: boolean; joiningDate?: string };

export function PeopleOrg() {
  const { data, loading, error } = useFetch<{ meId: number | null; employees: OrgEmp[] }>("/ess/org-chart");
  const [view, setView] = useState<"directory" | "org">("org");
  const [scope, setScope] = useState<"everyone" | "team">("everyone");
  const [q, setQ] = useState("");
  if (error) return <div className="note">{error}</div>;
  if (loading || !data) return <div>Loading…</div>;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <Segmented value={view} onChange={setView} items={[["directory", "Directory"], ["org", "Org Chart"]]} />
      </div>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 12 }}>
        {([["everyone", "Everyone"], ["team", "My Team"]] as const).map(([k, l]) => (
          <div key={k} onClick={() => setScope(k)} style={{ padding: "9px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", color: scope === k ? "var(--accent)" : "var(--text)", borderBottom: scope === k ? "2px solid var(--accent)" : "2px solid transparent" }}>{l}</div>
        ))}
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
          <input placeholder="Search by name, designation, department or ID" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340, borderRadius: 20 }} />
        </div>
        {view === "org" ? <OrgChart employees={data.employees} meId={data.meId} scope={scope} q={q} /> : <Directory employees={data.employees} meId={data.meId} scope={scope} q={q} />}
      </div>
    </div>
  );
}

function teamIds(employees: OrgEmp[], meId: number | null) {
  const me = employees.find((e) => e.id === meId);
  const ids = new Set<number>();
  if (!me) return ids;
  ids.add(me.id);
  if (me.managerId) { ids.add(me.managerId); employees.filter((e) => e.managerId === me.managerId).forEach((e) => ids.add(e.id)); }
  employees.filter((e) => e.managerId === me.id).forEach((e) => ids.add(e.id));
  return ids;
}
const matches = (e: OrgEmp, q: string) => !q || `${e.name} ${e.designation || ""} ${e.department || ""} ${e.empNo || ""}`.toLowerCase().includes(q.toLowerCase());

function Directory({ employees, meId, scope, q }: { employees: OrgEmp[]; meId: number | null; scope: string; q: string }) {
  const team = teamIds(employees, meId);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const [dept, setDept] = useState("");
  const depts = Array.from(new Set(employees.map((e) => e.department).filter(Boolean))).sort() as string[];
  const list = employees.filter((e) => (scope === "everyone" || team.has(e.id)) && matches(e, q) && (!dept || e.department === dept));
  return (
    <div style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{list.length} {list.length === 1 ? "person" : "people"}</div>
        <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ maxWidth: 220 }}><option value="">All departments</option>{depts.map((d) => <option key={d}>{d}</option>)}</select>
      </div>
      <div className="dir-grid">
        {list.map((e) => (
          <div key={e.id} className={`dir-card ${e.id === meId ? "me" : ""}`}>
            <Avatar emp={e} size={48} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{e.name}{e.id === meId && <span className="pill accent" style={{ marginLeft: 6 }}>You</span>}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{e.designation || "—"}{e.department ? ` · ${e.department}` : ""}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Emp ID · {e.empNo || "—"}{e.location ? ` · ${e.location}` : ""}</div>
              {e.email && <a href={`mailto:${e.email}`} style={{ fontSize: 12, wordBreak: "break-all" }}>{e.email}</a>}
              {e.managerId && byId.get(e.managerId) && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Reports to {byId.get(e.managerId)!.name}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrgChart({ employees, meId, scope, q }: { employees: OrgEmp[]; meId: number | null; scope: string; q: string }) {
  const byId = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const children = useMemo(() => {
    const m = new Map<number | null, OrgEmp[]>();
    for (const e of employees) { const k = e.managerId && byId.has(e.managerId) ? e.managerId : null; m.set(k, [...(m.get(k) || []), e]); }
    return m;
  }, [employees, byId]);
  const countAll = useMemo(() => {
    const memo = new Map<number, number>();
    const f = (id: number): number => { if (memo.has(id)) return memo.get(id)!; const c = (children.get(id) || []).reduce((a, k) => a + 1 + f(k.id), 0); memo.set(id, c); return c; };
    employees.forEach((e) => f(e.id));
    return memo;
  }, [employees, children]);
  const pathTo = (id: number) => { const p: number[] = []; let cur = byId.get(id)?.managerId ?? null; while (cur && !p.includes(cur)) { p.push(cur); cur = byId.get(cur)?.managerId ?? null; } return p; };

  const roots = useMemo(() => {
    if (scope === "team" && meId && byId.has(meId)) { const me = byId.get(meId)!; return [me.managerId && byId.has(me.managerId) ? byId.get(me.managerId)! : me]; }
    return children.get(null) || [];
  }, [scope, meId, byId, children]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  useEffect(() => {
    const s = new Set<number>(roots.map((r) => r.id));
    if (meId) { pathTo(meId).forEach((i) => s.add(i)); if (scope === "team") s.add(meId); }
    setExpanded(s);
  }, [roots, meId, scope]);

  const hits = q ? employees.filter((e) => matches(e, q)) : [];
  useEffect(() => {
    if (!q || !hits.length) return;
    setExpanded((s) => { const n = new Set(s); hits.slice(0, 20).forEach((h) => pathTo(h.id).forEach((i) => n.add(i))); return n; });
    setTimeout(() => document.getElementById(`oc-${hits[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }), 60);
  }, [q]);

  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const hitSet = new Set(hits.map((h) => h.id));

  const toggle = (id: number) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const Node = ({ e }: { e: OrgEmp }) => {
    const kids = children.get(e.id) || [];
    const open = expanded.has(e.id);
    return (
      <li>
        <div id={`oc-${e.id}`} className={`oc-card ${e.id === meId ? "me" : ""} ${hitSet.has(e.id) ? "hit" : ""} ${roots.some((r) => r.id === e.id) ? "root" : ""}`}>
          <Avatar emp={e} size={32} />
          <div style={{ textAlign: "left", minWidth: 0 }}>
            <div className="oc-name">{e.name}</div>
            <div className="oc-sub">{e.designation || "—"}</div>
            <div className="oc-sub">Emp ID · {e.empNo || "—"}</div>
          </div>
        </div>
        {kids.length > 0 && (
          <button type="button" className="oc-count" title={open ? "Collapse" : `Show ${kids.length} direct report(s)`} onClick={() => toggle(e.id)}>
            {open ? "−" : kids.length}
          </button>
        )}
        {open && kids.length > 0 && <ul>{kids.map((k) => <Node key={k.id} e={k} />)}</ul>}
      </li>
    );
  };

  return (
    <div className={`oc-shell ${full ? "full" : ""}`}>
      <div ref={wrap} className="oc-wrap"
        onMouseDown={(ev) => { if ((ev.target as HTMLElement).closest("button")) return; drag.current = { x: ev.clientX, y: ev.clientY, sl: wrap.current!.scrollLeft, st: wrap.current!.scrollTop }; }}
        onMouseMove={(ev) => { if (!drag.current) return; wrap.current!.scrollLeft = drag.current.sl - (ev.clientX - drag.current.x); wrap.current!.scrollTop = drag.current.st - (ev.clientY - drag.current.y); }}
        onMouseUp={() => (drag.current = null)} onMouseLeave={() => (drag.current = null)}>
        {roots.length === 0 ? <div style={{ padding: 40, color: "var(--muted)" }}>No reporting structure found. Set “Reporting Manager” in Employee Master to build the chart.</div> : (
          <div className="oc-tree" style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
            <ul>{roots.map((r) => <Node key={r.id} e={r} />)}</ul>
          </div>
        )}
      </div>
      <div className="oc-tools">
        <button type="button" title={full ? "Exit full screen" : "Full screen"} onClick={() => setFull(!full)}>{full ? "⤡" : "⤢"}</button>
        <button type="button" title="Expand all" onClick={() => setExpanded(new Set(employees.filter((e) => (countAll.get(e.id) || 0) > 0).map((e) => e.id)))}>⊕</button>
        <button type="button" title="Collapse all" onClick={() => setExpanded(new Set(roots.map((r) => r.id)))}>⊖</button>
        <button type="button" title="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}>+</button>
        <button type="button" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}>−</button>
      </div>
    </div>
  );
}

// =====================================================================================
// Salary & Designation Revision
// =====================================================================================
const compact = (n: number, ccy: string) => {
  if (ccy === "INR") return n >= 1e7 ? `${(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(2)}L` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`;
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`;
};

export function SalaryRevision() {
  const { user } = useAuth();
  const masked = useMaskNumbers(user?.id);
  const { data, loading, error } = useFetch<any>("/ess/salary-revisions");
  const [basis, setBasis] = useState<"monthly" | "annual">("monthly");
  if (error) return <div className="note">{error}</div>;
  if (loading || !data) return <div>Loading…</div>;
  const ccy = data.current?.currency || "INR";
  const val = (p: any) => (basis === "monthly" ? p.monthly : p.annual);
  const pts = [...(data.timeline || [])];
  // Extend the line to today so a flat (no-change) period is still visible.
  if (pts.length) pts.push({ ...pts[pts.length - 1], effectiveFrom: new Date().toISOString(), _now: true });
  const lastPct = data.lastRevision?.pct;
  const designations = data.designations || [];
  const lastDes = designations[designations.length - 1];

  return (
    <div>
      {masked && <div className="note" style={{ marginTop: 0, marginBottom: 14 }}>Amounts are hidden. Use the eye (mask) toggle at the top right to reveal them.</div>}
      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="panel" style={{ padding: 0 }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)" }}>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Duration since last revision</div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{durationText(data.lastRevisionDate)}</div>
          </div>
          <div style={{ padding: 16 }}>
            <div className="rev-hl">
              <div><div className="rev-lbl">Last Revision Period</div><div className="rev-val">{data.lastRevisionDate ? String(data.lastRevisionDate).slice(0, 10) : "—"}</div></div>
              <div className="rev-sep" />
              <div><div className="rev-lbl">Last Revision Percentage</div><div className="rev-val" style={{ color: lastPct == null ? "var(--muted)" : lastPct > 0 ? "var(--good)" : lastPct < 0 ? "var(--bad)" : "var(--bad)" }}>{lastPct == null ? "—" : `${lastPct}%`}</div></div>
            </div>
          </div>
        </div>
        <div className="panel" style={{ padding: 0 }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)" }}>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Current Designation</div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{data.currentDesignation || "—"}</div>
          </div>
          <div style={{ padding: 16 }}>
            <div className="rev-hl">
              <div><div className="rev-lbl">In Current Role Since</div><div className="rev-val">{lastDes?.effectiveDate ? String(lastDes.effectiveDate).slice(0, 10) : "—"}</div></div>
              <div className="rev-sep" />
              <div><div className="rev-lbl">Time in Role</div><div className="rev-val" style={{ fontSize: 16 }}>{lastDes?.effectiveDate ? durationText(lastDes.effectiveDate) : "—"}</div></div>
            </div>
          </div>
        </div>
      </div>

      <Panel>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>CTC Revision Timeline</div>
          <Segmented value={basis} onChange={setBasis} items={[["monthly", "Monthly"], ["annual", "Annual"]]} />
        </div>
        {pts.length === 0 ? <div style={{ color: "var(--muted)" }}>No CTC records on file yet.</div> : (
          <div className="chart-wrap">
            <Line
              data={{
                labels: pts.map((p) => new Date(p.effectiveFrom).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })),
                datasets: [{ label: `${basis === "monthly" ? "Monthly" : "Annual"} CTC (${ccy})`, data: pts.map(val), stepped: "before" as const, borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.10)", fill: true, pointRadius: pts.map((p) => (p._now ? 0 : 4)), pointBackgroundColor: "#f59e0b" }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: any) => (masked ? "•••••" : fmt(c.parsed.y, ccy)) } } },
                scales: { y: { ticks: { callback: (v: any) => (masked ? "•••" : compact(Number(v), ccy)) } } },
              }}
            />
          </div>
        )}
      </Panel>

      <Panel title="CTC Revision Details" style={{ marginTop: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table><thead><tr>
            <th>Revision Date</th><th>Payout Month</th><th className="num">Revised Monthly CTC</th><th className="num">Previous Monthly CTC</th><th>Duration Between Revisions</th><th className="num">Revision Amount</th><th className="num">Revision %</th>
          </tr></thead>
            <tbody>
              {(data.revisions || []).length === 0 && <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No revisions yet — your CTC is unchanged since {dstr(data.timeline?.[0]?.effectiveFrom)}.</td></tr>}
              {(data.revisions || []).map((r: any, i: number) => (
                <tr key={i}>
                  <td>{dstr(r.effectiveFrom)}</td>
                  <td>{new Date(r.effectiveFrom).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</td>
                  <td className="num">{fmt(r.revisedMonthly, r.currency)}</td>
                  <td className="num">{fmt(r.previousMonthly, r.previousCurrency)}</td>
                  <td>{durationText(r.previousFrom, r.effectiveFrom)}</td>
                  <td className="num">{r.amount == null ? "—" : fmt(r.amount, r.currency)}</td>
                  <td className="num" style={{ color: r.pct > 0 ? "var(--good)" : r.pct < 0 ? "var(--bad)" : undefined }}>{r.pct == null ? "—" : `${r.pct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Designation Revision" style={{ marginTop: 14 }}>
        {designations.length === 0 ? <div style={{ color: "var(--muted)" }}>No designation on file.</div> : (
          <div className="grid" style={{ gridTemplateColumns: "minmax(220px, 1fr) 2fr", alignItems: "start" }}>
            <div className="des-timeline">
              {[...designations].reverse().map((d: any, i: number) => (
                <div key={i} className={`des-item ${i === 0 ? "cur" : ""}`}>
                  <div className="des-dot" />
                  <div style={{ fontWeight: 600 }}>{d.designation}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{d.effectiveDate ? dstr(d.effectiveDate) : "Current"} · {d.source}</div>
                </div>
              ))}
            </div>
            <table><thead><tr><th>Effective Date</th><th>Previous Designation</th><th>Revised Designation</th><th>Duration in Previous Role</th><th>Source</th></tr></thead>
              <tbody>
                {[...designations].reverse().map((d: any, i: number, arr: any[]) => {
                  const prev = arr[i + 1];
                  return (
                    <tr key={i}>
                      <td>{d.effectiveDate ? dstr(d.effectiveDate) : "—"}</td>
                      <td>{d.previous || "—"}</td>
                      <td style={{ fontWeight: 600 }}>{d.designation}</td>
                      <td>{prev?.effectiveDate && d.effectiveDate ? durationText(prev.effectiveDate, d.effectiveDate) : "—"}</td>
                      <td>{d.source}{d.ref ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{d.ref}</div> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
