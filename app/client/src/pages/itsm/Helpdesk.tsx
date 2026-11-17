// IT Helpdesk — employee portal (Dashboard, My Tickets, Raise Ticket, Asset Catalog, My Assigned
// Assets, Knowledge Base, Request an Asset, Elevated Access, Team Approvals for managers) and the
// IT-side Helpdesk Console (queue, asset inventory, catalog, knowledge-base documents).
// Server: routes/helpdesk.ts (/api/helpdesk/*).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Bar, Doughnut } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend } from "chart.js";
import { api } from "../../api";
import { useFetch, Panel } from "../../ui";
import { DateInput } from "../../dateInput";
import { fmtDate } from "../../dateFormat";
import { AddButton, GhostButton, Modal, useToast, confirmDialog, EditAction, DeleteAction } from "../../components";
import { useAuth } from "../../auth";
import { watchRoom } from "../../realtime";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

const dstr = (d: any) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const dtstr = (d: any) => (d ? new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const kb = (n?: number | null) => (n == null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const CATEGORIES = ["Hardware", "Software", "Network", "Access & Permissions", "Email & Collaboration", "Other"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const ASSET_TYPES = ["Laptop", "Monitor", "Mouse", "Headphones", "Type C Connector", "Keyboard", "Other"];
const ASSET_STATUSES = ["IN_STOCK", "ASSIGNED", "IN_REPAIR", "RETIRED", "MISSING"];
const ASSET_STATUS_PILL: Record<string, string> = { ASSIGNED: "good", IN_STOCK: "accent", IN_REPAIR: "warn", MISSING: "bad" };
const KB_CATS = ["Security", "IT Policy", "Networking", "Software", "Hardware", "General"];
const TYPE_ICON: Record<string, string> = { Laptop: "💻", Monitor: "🖥️", Mouse: "🖱️", Headphones: "🎧", "Type C Connector": "🔗", Keyboard: "⌨️", Other: "📦" };
const KB_ICON: Record<string, string> = { Security: "🔒", "IT Policy": "📋", Networking: "🌐", Software: "🧩", Hardware: "🖥️", General: "📄" };
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name || "");
const isPdfName = (name: string) => /\.pdf$/i.test(name || "");

/** In-app attachment viewer — an <img> for images, an <embed> (application/pdf) for PDFs, a plain
    Download link for anything else the browser can't render inline. Every "open attachment" click
    in this file goes through this instead of `window.open`ing the raw URL in a new tab. */
function AttachmentPreviewModal({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  return (
    <Modal title={`📎 ${name}`} open onClose={onClose} wide>
      {isImageName(name) ? (
        <img src={url} alt={name} style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto" }} />
      ) : isPdfName(name) ? (
        <embed src={url} type="application/pdf" style={{ width: "100%", height: "70vh", border: "1px solid var(--border)", borderRadius: 8 }} />
      ) : (
        <div style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>No in-app preview for this file type.</div>
        </div>
      )}
      <div style={{ marginTop: 10, textAlign: "right" }}><a href={url} download={name} target="_blank" rel="noreferrer">Download</a></div>
    </Modal>
  );
}
/** Small clickable attachment chip — opens the preview modal instead of a new tab. Reused for the
    ticket's own top-level attachment and every chat message's attachment. An image renders inline
    immediately (no click needed, chat-attachment style) via the same authenticated URL the modal
    already used for click-to-preview — clicking the inline image still opens the same enlarge
    modal. Every other file type is unchanged: a plain chip link. */
function AttachmentChip({ name, url }: { name: string; url: string }) {
  const [open, setOpen] = useState(false);
  if (isImageName(name)) {
    return (
      <>
        <div>
          <img
            src={url} alt={name} loading="lazy" onClick={() => setOpen(true)}
            style={{ display: "block", maxWidth: "100%", maxHeight: 320, borderRadius: 8, border: "1px solid var(--border)", cursor: "zoom-in", objectFit: "contain" }}
          />
          <a href="#" onClick={(e) => { e.preventDefault(); setOpen(true); }} style={{ fontSize: 11, color: "var(--muted)" }}>📎 {name}</a>
        </div>
        {open && <AttachmentPreviewModal name={name} url={url} onClose={() => setOpen(false)} />}
      </>
    );
  }
  return (
    <>
      <a href="#" onClick={(e) => { e.preventDefault(); setOpen(true); }}>📎 {name}</a>
      {open && <AttachmentPreviewModal name={name} url={url} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Renders admin-defined custom fields (Helpdesk Settings -> Workflow, Fields & Permissions ->
    Custom Fields) on the real Raise Ticket / Request an Asset / Elevated Access forms — generic,
    no arbitrary markup, same fixed input-type set the live preview uses. */
function CustomFieldsSection({ defs, values, onChange }: { defs: any[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  if (!defs || defs.length === 0) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)" }}>
      {defs.map((cf: any) => (
        <div key={cf.key}>
          <label className="hd-lbl">{cf.label} {cf.required ? <span className="req">*</span> : "(optional)"}</label>
          {cf.fieldType === "textarea" ? (
            <textarea rows={2} value={values[cf.key] || ""} onChange={(e) => onChange({ ...values, [cf.key]: e.target.value })} />
          ) : (
            <input type={cf.fieldType === "number" ? "number" : cf.fieldType === "date" ? "date" : "text"} value={values[cf.key] || ""} onChange={(e) => onChange({ ...values, [cf.key]: e.target.value })} />
          )}
        </div>
      ))}
    </div>
  );
}
/** Client-side mirror of the server's requirement check, so a missing required custom field is
    caught before submit instead of round-tripping to the API first. */
function missingCustomField(defs: any[], values: Record<string, string>): string | null {
  for (const cf of defs || []) if (cf.required && !String(values[cf.key] || "").trim()) return cf.label;
  return null;
}

/** Human status label + pill class, aware of request type, who rejected and access expiry.
    Prefers the server-computed `stageLabelText` (Helpdesk Settings -> stage relabeling) over the
    hardcoded default text — every endpoint that returns a ticket already attaches it (see
    hydrate() in routes/itsm/helpdesk.ts), so this reflects whatever an admin has configured
    without every call site needing to fetch /meta separately. The semantic color class (good/bad/
    warn/accent) stays fixed to the underlying status, not admin-configurable, so the color always
    still means what it says regardless of the label text. */
export function statusView(t: any): { label: string; cls: string } {
  const s = t.status;
  const base = t.stageLabelText as string | undefined;
  if (s === "PENDING_MANAGER") return { label: base || "Pending Manager Approval", cls: "warn" };
  if (s === "REJECTED") return { label: `${base || "Rejected"}${t.rejectedBy ? ` by ${t.rejectedBy === "MANAGER" ? "Manager" : "IT Support"}` : ""}`, cls: "bad" };
  if (s === "CANCELLED") return { label: base || "Cancelled", cls: "" };
  if (s === "RESOLVED" || s === "CLOSED") {
    if (t.type === "ASSET_REQUEST") return { label: base || (s === "CLOSED" ? "Closed" : "Assigned"), cls: "good" };
    if (t.type === "ELEVATED_ACCESS") {
      const exp = t.details?.expiresAt ? new Date(t.details.expiresAt) : null;
      return exp && exp < new Date() ? { label: "Expired", cls: "" } : { label: base || "Access Granted", cls: "good" };
    }
    return { label: base || (s === "CLOSED" ? "Closed" : "Resolved"), cls: "good" };
  }
  if (s === "OPEN" && t.approvalStatus === "APPROVED") return { label: base || "Approved · With IT", cls: "accent" };
  return { label: base || (s === "IN_PROGRESS" ? "In Progress" : s === "ON_HOLD" ? "On Hold" : "Open"), cls: s === "IN_PROGRESS" ? "warn" : "accent" };
}
const StatusPill = ({ t }: { t: any }) => { const v = statusView(t); return <span className={`pill ${v.cls}`} style={{ whiteSpace: "nowrap" }}>{v.label}</span>; };
const PageHead = ({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
    <div><h1>{title}</h1><div className="subtitle">{sub}</div></div>{right}
  </div>
);

// =====================================================================================
// Dashboard
// =====================================================================================
export function HelpdeskHome() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { data } = useFetch<any>("/helpdesk/summary");
  const stat = (icon: string, n: any, label: string, color: string) => (
    <div className="hd-stat"><div style={{ fontSize: 20 }}>{icon}</div><div style={{ fontSize: 24, fontWeight: 700, color }}>{n ?? "—"}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div></div>
  );
  const action = (icon: string, title: string, sub: string, to: string) => (
    <div className="hd-action" onClick={() => nav(to)}><div style={{ fontSize: 26 }}>{icon}</div><div style={{ fontWeight: 600, marginTop: 8 }}>{title}</div><div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{sub}</div></div>
  );
  return (
    <div className="hd-page">
      <div className="hd-hero">
        <div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>Welcome back</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{String(user?.name || "").split(" ")[0]} 👋</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>{user?.email}</div>
        </div>
        <button type="button" className="hd-hero-btn" onClick={() => nav("/helpdesk/raise")}>+ Raise a Ticket</button>
      </div>
      {data?.pendingApprovals > 0 && (
        <div className="note" style={{ cursor: "pointer" }} onClick={() => nav("/helpdesk/approvals")}>⚠ {data.pendingApprovals} request{data.pendingApprovals > 1 ? "s" : ""} from your team {data.pendingApprovals > 1 ? "are" : "is"} waiting for your approval → Pending Approval</div>
      )}
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginTop: 14 }}>
        {stat("🎫", data?.open, "Open", "#2563eb")}
        {stat("⚙️", data?.inProgress, "In Progress", "#d97706")}
        {stat("✅", data?.resolved, "Resolved", "#059669")}
        {stat("📋", data?.total, "Total", "var(--text)")}
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginTop: 14 }}>
        {action("🎫", "Raise a Support Ticket", "Report an issue with hardware, software, or network.", "/helpdesk/raise")}
        {action("🖥️", "Browse Asset Catalog", "Request peripherals — mice, keyboards, monitors & more.", "/helpdesk/catalog")}
        {action("🔑", "Elevated Access", "Request temporary admin credentials for critical tasks.", "/helpdesk/elevated-access")}
      </div>
      <div className="panel" style={{ marginTop: 14, padding: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <b>My Recent Tickets</b><a href="#" onClick={(e) => { e.preventDefault(); nav("/helpdesk/tickets"); }} style={{ fontSize: 13, fontWeight: 600 }}>View all →</a>
        </div>
        {(data?.recent || []).length === 0 && <div style={{ padding: 20, color: "var(--muted)" }}>No tickets yet.</div>}
        {(data?.recent || []).map((t: any) => (
          <div key={t.id} className="hd-list-row" onClick={() => nav(`/helpdesk/tickets?open=${t.id}`)}>
            <span className="hd-dot" style={{ background: statusView(t).cls === "good" ? "var(--good)" : "var(--warn)" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t.subject}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{t.ticketNo} · {t.category} · {String(t.createdAt).slice(0, 10)}</div>
            </div>
            <StatusPill t={t} />
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================================
// My Tickets + detail
// =====================================================================================
export function MyTickets() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data, reload } = useFetch<any[]>("/helpdesk/tickets");
  useEffect(() => {
    if (!user?.id) return;
    const cleanup = watchRoom(`helpdesk:user:${user.id}`, "helpdesk:activity", () => reload());
    return () => cleanup();
  }, [user?.id]);
  const [filter, setFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const openId = params.get("open") ? Number(params.get("open")) : null;
  const groups: Record<string, string[]> = { ALL: [], OPEN: ["PENDING_MANAGER", "OPEN", "ON_HOLD"], IN_PROGRESS: ["IN_PROGRESS"], RESOLVED: ["RESOLVED"], CLOSED: ["CLOSED", "REJECTED", "CANCELLED"] };
  const rows = (data || []).filter((t) => (filter === "ALL" || groups[filter].includes(t.status)) && (!q || `${t.subject} ${t.ticketNo} ${t.category}`.toLowerCase().includes(q.toLowerCase())));
  const nav = useNavigate();
  return (
    <div className="hd-page">
      <PageHead title="My Tickets" sub="Everything you've raised with IT — incidents, asset requests and elevated-access requests." right={<AddButton onClick={() => nav("/helpdesk/raise")}>Raise Ticket</AddButton>} />
      <Panel>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          {Object.keys(groups).map((k) => (
            <button key={k} type="button" className={`chip-btn ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
              {k === "ALL" ? "All" : k === "IN_PROGRESS" ? "In Progress" : cap(k)} <span style={{ opacity: 0.7 }}>{k === "ALL" ? (data || []).length : (data || []).filter((t) => groups[k].includes(t.status)).length}</span>
            </button>
          ))}
          <input placeholder="Search tickets…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260, marginLeft: "auto" }} />
        </div>
        <table><thead><tr><th>Ticket</th><th>Subject</th><th>Category</th><th>Priority</th><th>Raised</th><th>Updated</th><th>Status</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No tickets here.</td></tr>}
            {rows.map((t) => (
              <tr key={t.id} style={{ cursor: "pointer", fontWeight: t.unreadCount ? 700 : undefined }} onClick={() => setParams({ open: String(t.id) })}>
                <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{t.ticketNo}{!!t.unreadCount && <span className="pill accent" style={{ marginLeft: 6 }} title={`${t.unreadCount} unread`}>{t.unreadCount}</span>}</td><td>{t.subject}</td><td>{t.category}</td>
                <td><span className={`pill ${t.priority === "CRITICAL" || t.priority === "HIGH" ? "bad" : t.priority === "MEDIUM" ? "warn" : ""}`}>{cap(t.priority)}</span></td>
                <td style={{ whiteSpace: "nowrap" }}>{dstr(t.createdAt)}</td><td style={{ whiteSpace: "nowrap" }}>{dstr(t.updatedAt)}</td><td><StatusPill t={t} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {openId && <TicketDetail id={openId} onClose={() => { setParams({}); reload(); }} />}
    </div>
  );
}

export function TicketDetail({ id, onClose, console: isConsole, onChanged }: { id: number; onClose: () => void; console?: boolean; onChanged?: () => void }) {
  const { show } = useToast();
  const { user } = useAuth();
  const { data: t, reload } = useFetch<any>(`/helpdesk/tickets/${id}`, [id]);
  const { data: agents } = useFetch<any[]>(isConsole ? "/helpdesk/admin/agents" : "/helpdesk/meta");
  const { data: meta } = useFetch<any>("/helpdesk/meta");
  const [comment, setComment] = useState("");
  const [edit, setEdit] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [chatFile, setChatFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const chatFileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (t && isConsole) setEdit({ status: t.status, priority: t.priority, assignedToId: t.assignedToId || "", resolution: t.resolution || "" }); }, [t?.id, t?.updatedAt]);
  // Live — a reply from the other side (or a second tab) refreshes this open ticket instead of
  // going stale until manually closed/reopened. IT watches the shared queue-wide room; a requester
  // watches their own per-user room (they're not IT staff, so they can't join helpdesk:activity).
  useEffect(() => {
    const room = isConsole ? "helpdesk:activity" : `helpdesk:user:${user?.id}`;
    if (!isConsole && !user?.id) return;
    const cleanup = watchRoom(room, "helpdesk:activity", () => reload());
    return () => cleanup();
  }, [id, isConsole, user?.id]);
  // Marks read on open, and again every time the comment list actually grows while it's open —
  // covers "I was already looking at it when the reply came in" as well as "I just opened it".
  const lastMarkedCount = useRef(-1);
  useEffect(() => {
    if (!t) return;
    const n = (t.comments || []).length;
    if (n !== lastMarkedCount.current) { lastMarkedCount.current = n; api.post(`/helpdesk/tickets/${id}/mark-read`).catch(() => {}); }
  }, [id, t?.comments?.length]);
  const changed = () => { reload(); onChanged?.(); };
  const post = async (path: string, body?: any, msg?: string) => { try { await api.post(path, body); if (msg) show(msg); changed(); } catch (e: any) { show(e.message, "error"); } };
  if (!t) return <Modal title="Ticket" open onClose={onClose}><div>Loading…</div></Modal>;
  const mine = t.requesterUserId === user?.id;
  const d = t.details || {};
  const save = async () => {
    try { await api.put(`/helpdesk/admin/tickets/${t.id}`, { ...edit, assignedToId: edit.assignedToId || null }); show("Ticket updated"); changed(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const sendComment = async () => {
    if (!comment.trim() && !chatFile) return;
    if (chatFile && chatFile.size > 5 * 1024 * 1024) return show("Attachment must be 5 MB or smaller", "error");
    setSending(true);
    try {
      const body: any = { body: comment };
      if (chatFile) { body.attachmentName = chatFile.name; body.attachmentData = await fileToBase64(chatFile); }
      await api.post(`/helpdesk/tickets/${t.id}/comments`, body);
      setComment(""); setChatFile(null); changed();
    } catch (e: any) { show(e.message, "error"); } finally { setSending(false); }
  };
  return (
    <Modal title={`${t.ticketNo} · ${t.subject}`} open onClose={onClose} wide>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <StatusPill t={t} /><span className="pill">{t.category}</span><span className="pill">{cap(t.priority)} priority</span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>Raised {dtstr(t.createdAt)} by {t.requester?.name || "—"}{t.assignedTo ? ` · Assigned to ${t.assignedTo.name}` : ""}</span>
      </div>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div>
          <div className="hd-box"><div className="hd-box-lbl">{t.type === "INCIDENT" ? "Description" : "Reason / Justification"}</div><div style={{ whiteSpace: "pre-wrap" }}>{t.description}</div></div>
          {t.type === "ASSET_REQUEST" && <div className="hd-box"><div className="hd-box-lbl">Requested</div>{TYPE_ICON[d.assetType] || "📦"} {d.itemName} ({d.assetType})</div>}
          {t.type === "ELEVATED_ACCESS" && (
            <div className="hd-box"><div className="hd-box-lbl">Access</div>
              {d.accessLevel} on <b>{d.hostname}</b><br />From {dtstr(d.startAt)} for {d.durationDays} day(s) — expires {dtstr(d.expiresAt)}
            </div>
          )}
          {d.customFieldValues && Object.keys(d.customFieldValues).length > 0 && (
            <div className="hd-box">
              <div className="hd-box-lbl">Additional Details</div>
              {(meta?.customFields?.[t.type] || []).filter((cf: any) => d.customFieldValues[cf.key] !== undefined).map((cf: any) => (
                <div key={cf.key} style={{ fontSize: 13, marginBottom: 4 }}>{cf.label}: <b>{d.customFieldValues[cf.key]}</b></div>
              ))}
            </div>
          )}
          {t.approvalStatus && t.approvalStatus !== "NOT_REQUIRED" && (
            <div className={`hd-box ${t.approvalStatus === "REJECTED" ? "bad" : ""}`}><div className="hd-box-lbl">Manager approval</div>
              {t.approvalStatus === "PENDING" ? `Waiting on ${t.manager?.name || "your manager"}` : `${cap(t.approvalStatus)} by ${t.manager?.name || "manager"} on ${dtstr(t.managerDecisionAt)}`}
              {t.managerNote && <div style={{ fontStyle: "italic" }}>"{t.managerNote}"</div>}
            </div>
          )}
          {t.resolution && <div className={`hd-box ${t.status === "REJECTED" ? "bad" : "good"}`}><div className="hd-box-lbl">{t.status === "REJECTED" ? "Rejected by IT Support" : "Resolution"}</div><div style={{ whiteSpace: "pre-wrap" }}>{t.resolution}</div></div>}
          {t.hasAttachment && <AttachmentChip name={t.attachmentName} url={api.pdfUrl(`/helpdesk/tickets/${t.id}/attachment`)} />}
          {mine && !isConsole && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {["PENDING_MANAGER", "OPEN"].includes(t.status) && meta?.permissions?.[t.type]?.employeeCanWithdraw !== false && <GhostButton onClick={async () => { const r = await confirmDialog({ title: "Withdraw this request?", prompt: true, placeholder: "Reason (optional)", danger: true, confirmLabel: "Withdraw" }); if (r !== null && r !== false) post(`/helpdesk/tickets/${t.id}/cancel`, { reason: r }, "Withdrawn"); }}>Cancel Request</GhostButton>}
              {t.status === "RESOLVED" && t.type === "INCIDENT" && <AddButton onClick={() => post(`/helpdesk/tickets/${t.id}/close`, {}, "Ticket closed — thanks!")}>Confirm & Close</AddButton>}
              {t.status === "RESOLVED" && t.type === "INCIDENT" && meta?.permissions?.INCIDENT?.employeeCanReopen !== false && <GhostButton onClick={async () => { const r = await confirmDialog({ title: "Re-open ticket", prompt: true, placeholder: "What's still not working?" }); if (r !== null && r !== false) post(`/helpdesk/tickets/${t.id}/reopen`, { reason: r }, "Re-opened"); }}>Re-open</GhostButton>}
            </div>
          )}
          {isConsole && edit && (
            <div className="hd-box" style={{ marginTop: 12 }}>
              <div className="hd-box-lbl">IT actions</div>
              <div className="form-grid">
                <div><label>Status</label><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                  {(t.status === "PENDING_MANAGER" ? ["PENDING_MANAGER"] : []).concat(["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"]).map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                </select></div>
                <div><label>Priority</label><select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></div>
                <div className="full"><label>Assigned To</label><select value={edit.assignedToId} onChange={(e) => setEdit({ ...edit, assignedToId: e.target.value })}>
                  <option value="">— Unassigned —</option>{(Array.isArray(agents) ? agents : []).map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
                </select></div>
                <div className="full"><label>{edit.status === "REJECTED" ? "Rejection reason (shown to employee)" : "Resolution / notes to employee"}</label><textarea rows={3} value={edit.resolution} onChange={(e) => setEdit({ ...edit, resolution: e.target.value })} /></div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <AddButton onClick={save}>Save</AddButton>
                {t.type === "ASSET_REQUEST" && !["RESOLVED", "CLOSED", "REJECTED", "CANCELLED", "PENDING_MANAGER"].includes(t.status) && <GhostButton onClick={() => setAssignOpen(true)}>Assign an Asset…</GhostButton>}
                {t.type === "ELEVATED_ACCESS" && t.status === "OPEN" && !t.details?.credentialPassword && (
                  <AddButton onClick={async () => { if (!(await confirmDialog({ title: "Grant elevated access?", message: `Issues a temporary administrator credential to ${t.requester?.name || "the requester"} right now.` }))) return; post(`/helpdesk/admin/tickets/${t.id}/elevated-access/grant`, {}, "Access granted"); }}>Grant Access</AddButton>
                )}
              </div>
              {/* IT is an explicit fallback decision-maker for a PENDING_MANAGER request (see
                  canDecide in helpdesk.ts) — a slow/unavailable manager shouldn't be able to block
                  the console from handling something an employee raised. Previously this console
                  view only ever showed a passive "waiting on manager" note with no way to actually
                  act, even for a ticket type Settings has itCanApprove enabled for. */}
              {t.status === "PENDING_MANAGER" && t.type !== "INCIDENT" && meta?.permissions?.[t.type]?.itCanApprove !== false && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <AddButton onClick={async () => { if (!(await confirmDialog({ title: "Approve on the manager's behalf?", message: `Normally decided by ${t.manager?.name || "the reporting manager"}.` }))) return; post(`/helpdesk/approvals/${t.id}/approve`, {}, "Approved on manager's behalf"); }}>Approve (on manager's behalf)</AddButton>
                  <GhostButton onClick={async () => { const r = await confirmDialog({ title: "Reject on the manager's behalf?", prompt: true, placeholder: "Reason for rejecting", danger: true, confirmLabel: "Reject" }); if (r !== null && r !== false) post(`/helpdesk/approvals/${t.id}/reject`, { note: r }, "Rejected"); }}>Reject (on manager's behalf)</GhostButton>
                </div>
              )}
              {t.status === "PENDING_MANAGER" && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>Waiting on {t.manager?.name || "the manager"}{meta?.permissions?.[t.type]?.itCanApprove !== false ? " — IT can also decide it above." : "."}</div>}
              {t.type === "ELEVATED_ACCESS" && t.status === "OPEN" && !t.details?.credentialPassword && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>No manager approval was needed for this request — use Grant Access to issue the credential.</div>}
            </div>
          )}
        </div>
        <div>
          <div className="hd-box-lbl" style={{ marginBottom: 6 }}>Activity</div>
          <div className="hd-thread">
            {(t.comments || []).length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No updates yet.</div>}
            {(t.comments || []).map((c: any) => (
              <div key={c.id} className={`hd-msg ${c.authorUserId === user?.id ? "me" : ""}`}>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.authorName} · {dtstr(c.createdAt)}</div>
                {c.body && <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{c.body}</div>}
                {c.hasAttachment && <div style={{ marginTop: 4, fontSize: 13 }}><AttachmentChip name={c.attachmentName} url={api.pdfUrl(`/helpdesk/tickets/${t.id}/comments/${c.id}/attachment`)} /></div>}
              </div>
            ))}
          </div>
          {!["CLOSED", "CANCELLED"].includes(t.status) && (
            <div style={{ marginTop: 8 }}>
              <textarea rows={2} placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
              {chatFile && <div style={{ fontSize: 12, marginTop: 4 }}>📎 {chatFile.name} · {kb(chatFile.size)} <a href="#" onClick={(e) => { e.preventDefault(); setChatFile(null); }}>remove</a></div>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 8 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {/* Covers spec item 2 too — IT (or the requester) attaching a screenshot/PDF/doc
                      right here with or without any text is exactly "upload directly in the ticket". */}
                  <input ref={chatFileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setChatFile(f); e.target.value = ""; }} />
                  <GhostButton onClick={() => chatFileInput.current?.click()}>📎 Attach</GhostButton>
                </div>
                <AddButton disabled={sending || (!comment.trim() && !chatFile)} onClick={sendComment}>{sending ? "Sending…" : "Send"}</AddButton>
              </div>
            </div>
          )}
        </div>
      </div>
      {assignOpen && <AssignAssetModal ticket={t} onClose={() => setAssignOpen(false)} onDone={() => { setAssignOpen(false); changed(); }} />}
    </Modal>
  );
}

// =====================================================================================
// Raise a Support Ticket
// =====================================================================================
export function RaiseTicket() {
  const nav = useNavigate();
  const { show } = useToast();
  const { data: meta } = useFetch<any>("/helpdesk/meta");
  const categories: string[] = meta?.categories || CATEGORIES;
  const [f, setF] = useState({ subject: "", category: "", priority: "MEDIUM", description: "" });
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cfValues, setCfValues] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);
  const cfDefs = meta?.customFields?.INCIDENT || [];
  const pick = (fl?: File | null) => { if (!fl) return; if (fl.size > 5 * 1024 * 1024) return show("Attachment must be 5 MB or smaller", "error"); setFile(fl); };
  const submit = async () => {
    if (!f.subject.trim() || !f.category || !f.description.trim()) return show("Issue title, category and description are required", "error");
    if (meta?.fields?.INCIDENT?.attachmentFieldRequired && !file) return show(`${meta?.fieldLabels?.INCIDENT?.attachmentFieldVisible || "Attachment"} is required`, "error");
    const missing = missingCustomField(cfDefs, cfValues);
    if (missing) return show(`${missing} is required`, "error");
    setBusy(true);
    try {
      const body: any = { ...f, customFieldValues: cfValues };
      if (file) { body.attachmentName = file.name; body.attachmentData = await fileToBase64(file); }
      const t: any = await api.post("/helpdesk/tickets", body);
      show(`Ticket ${t.ticketNo} raised — IT will get back to you`);
      nav(`/helpdesk/tickets?open=${t.id}`);
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="hd-page narrow">
      <PageHead title="Raise a Support Ticket" sub="Describe your issue and our IT team will get back to you." />
      <div className="panel">
        <label className="hd-lbl">Issue Title <span className="req">*</span></label>
        <input value={f.subject} maxLength={190} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Laptop shows blue screen on start-up" />
        <div className="form-grid" style={{ marginTop: 4 }}>
          <div><label className="hd-lbl">Category <span className="req">*</span></label>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Select category</option>{categories.map((c) => <option key={c}>{c}</option>)}</select>
          </div>
          {meta?.fields?.INCIDENT?.priorityFieldVisible !== false && (
            <div><label className="hd-lbl">{meta?.fieldLabels?.INCIDENT?.priorityFieldVisible || "Priority"}</label>
              <div style={{ display: "flex", gap: 6 }}>{PRIORITIES.map((p) => <button key={p} type="button" className={`prio-btn ${f.priority === p ? `on ${p.toLowerCase()}` : ""}`} onClick={() => setF({ ...f, priority: p })}>{cap(p)}</button>)}</div>
            </div>
          )}
        </div>
        <label className="hd-lbl">Description <span className="req">*</span></label>
        <textarea rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Describe the issue — when it started, what you've already tried…" />
        {meta?.fields?.INCIDENT?.attachmentFieldVisible !== false && (<>
        <label className="hd-lbl">{meta?.fieldLabels?.INCIDENT?.attachmentFieldVisible || "Attachment"} {meta?.fields?.INCIDENT?.attachmentFieldRequired ? <span className="req">*</span> : "(optional)"}</label>
        <div className={`dropzone ${drag ? "drag" : ""}`} onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
          <div style={{ fontSize: 20 }}>📎</div>
          {file ? <div><b>{file.name}</b> · {kb(file.size)} <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFile(null); }}>remove</a></div>
            : <div>Drag & drop a file or <u style={{ color: "var(--accent)" }}>browse files</u></div>}
          <div style={{ fontSize: 11, color: "var(--muted)" }}>Screenshots, PDFs, logs — max 5 MB</div>
          <input ref={input} type="file" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        </>)}
        <CustomFieldsSection defs={cfDefs} values={cfValues} onChange={setCfValues} />
        <div style={{ display: "flex", gap: 8, marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <AddButton disabled={busy} onClick={submit} icon={<span />}>{busy ? "Submitting…" : "Submit Ticket"}</AddButton>
          <GhostButton onClick={() => nav(-1)}>Cancel</GhostButton>
        </div>
      </div>
    </div>
  );
}

// =====================================================================================
// Asset Catalog
// =====================================================================================
export function AssetCatalog() {
  const nav = useNavigate();
  const { data } = useFetch<any[]>("/helpdesk/catalog");
  const [cat, setCat] = useState("");
  const cats = Array.from(new Set((data || []).map((i) => i.category)));
  return (
    <div className="hd-page">
      <PageHead title="Asset Catalog" sub="IT equipment you can request. Requests go to your manager for approval, then IT assigns the asset." />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <button type="button" className={`chip-btn ${!cat ? "on" : ""}`} onClick={() => setCat("")}>All</button>
        {cats.map((c) => <button key={c} type="button" className={`chip-btn ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>{TYPE_ICON[c] || "📦"} {c}</button>)}
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {(data || []).filter((i) => !cat || i.category === cat).map((i) => (
          <div key={i.id} className="hd-action" style={{ cursor: "default", display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30 }}>{i.icon || TYPE_ICON[i.category] || "📦"}</div>
            <div style={{ fontWeight: 600, marginTop: 6 }}>{i.name}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 10px", flex: 1 }}>{i.description}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="pill">{i.category}</span>
              <AddButton onClick={() => nav(`/helpdesk/request-asset?item=${i.id}`)}>Request</AddButton>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================================
// My Assigned Assets
// =====================================================================================
export function MyAssets() {
  const nav = useNavigate();
  const { data } = useFetch<any[]>("/helpdesk/my-assets");
  const assets = data || [];
  const tiles = ["Laptop", "Monitor", "Mouse", "Headphones"];
  return (
    <div className="hd-page">
      <PageHead title="My Assigned Assets" sub="IT equipment currently issued to you. Contact IT Support if anything is missing or needs replacement." />
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
        {tiles.map((t) => {
          const n = assets.filter((a) => a.category === t).length;
          return (
            <div key={t} className={`asset-tile ${n ? "issued" : ""}`}>
              <div style={{ fontSize: 26 }}>{TYPE_ICON[t]}</div>
              <div><div style={{ fontWeight: 600, fontSize: 13 }}>{t}</div><div style={{ fontSize: 12, color: n ? "var(--good)" : "var(--muted)" }}>{n ? `${n} issued` : "Not issued"}</div></div>
            </div>
          );
        })}
      </div>
      <div className="panel">
        {assets.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 36 }}>📦</div>
            <div style={{ fontWeight: 600, marginTop: 8 }}>No assets assigned yet</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Contact your IT Support team to get equipment issued.</div>
          </div>
        ) : (
          <table><thead><tr><th>Asset</th><th>Asset ID</th><th>Make / Model</th><th>Serial No.</th><th>Issued On</th><th>Warranty Till</th><th>Status</th></tr></thead>
            <tbody>{assets.map((a) => (
              <tr key={a.id}><td>{TYPE_ICON[a.category] || "📦"} {a.name}</td><td style={{ fontWeight: 600 }}>{a.assetTag}</td><td>{[a.make, a.model].filter(Boolean).join(" ") || "—"}</td><td>{a.serialNo || "—"}</td><td>{dstr(a.assignedAt)}</td><td>{dstr(a.warrantyTill)}</td>
                <td><span className={`pill ${a.status === "ASSIGNED" ? "good" : "warn"}`}>{a.status === "ASSIGNED" ? "In use" : "In repair"}</span></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="hd-info">ⓘ If you notice a discrepancy in your assigned assets, or need to report a lost or damaged item, please <a href="#" onClick={(e) => { e.preventDefault(); nav("/helpdesk/raise"); }} style={{ fontWeight: 600 }}>raise a support ticket</a> with the asset ID and serial number.</div>
    </div>
  );
}

// =====================================================================================
// Knowledge Base
// =====================================================================================
export function KnowledgeBase() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const h = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(h); }, [q]);
  const { data } = useFetch<any[]>(`/helpdesk/kb?q=${encodeURIComponent(debounced)}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`, [debounced, cat]);
  const [reading, setReading] = useState<any>(null);
  const view = async (a: any) => {
    if (a.fileName) { window.open(api.pdfUrl(`/helpdesk/kb/${a.id}/file`), "_blank"); api.get(`/helpdesk/kb/${a.id}`).catch(() => {}); }
    else setReading(await api.get(`/helpdesk/kb/${a.id}`));
  };
  return (
    <div className="hd-page">
      <PageHead title="Knowledge Base" sub="IT and security documents — read and download only." />
      <div className="panel" style={{ marginBottom: 14 }}>
        <input placeholder="🔍  Search documents…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          <button type="button" className={`chip-btn ${!cat ? "on" : ""}`} onClick={() => setCat("")}>All</button>
          {KB_CATS.map((c) => <button key={c} type="button" className={`chip-btn ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>{KB_ICON[c]} {c}</button>)}
        </div>
      </div>
      {(data || []).length === 0 && <div className="panel" style={{ color: "var(--muted)" }}>No documents found.</div>}
      {(data || []).map((a) => (
        <div key={a.id} className="panel kb-row">
          <div className="kb-icon">{KB_ICON[a.category] || "📄"}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{a.title}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="pill">{a.category}</span>{a.fileName && <span>{a.fileName}</span>}{a.fileSize ? <span>{kb(a.fileSize)}</span> : null}<span>Uploaded: {fmtDate(a.createdAt)}</span>
            </div>
            {a.summary && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{a.summary}</div>}
          </div>
          <a href="#" onClick={(e) => { e.preventDefault(); view(a); }} style={{ fontWeight: 600, whiteSpace: "nowrap" }}>View →</a>
          {a.fileName && <a className="kb-dl" href={api.pdfUrl(`/helpdesk/kb/${a.id}/file?download=1`)}>⬇ Download</a>}
        </div>
      ))}
      {reading && <Modal title={reading.title} open onClose={() => setReading(null)} wide><div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{reading.body}</div></Modal>}
    </div>
  );
}

// =====================================================================================
// Request an Asset
// =====================================================================================
export function RequestAsset() {
  const { show } = useToast();
  const [params] = useSearchParams();
  const { data: catalog } = useFetch<any[]>("/helpdesk/catalog");
  const { data: mine, reload } = useFetch<any[]>("/helpdesk/tickets?type=ASSET_REQUEST");
  const { data: meta } = useFetch<any>("/helpdesk/meta");
  const [type, setType] = useState("");
  const [itemId, setItemId] = useState<string>(params.get("item") || "");
  const [other, setOther] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfValues, setCfValues] = useState<Record<string, string>>({});
  const cfDefs = meta?.customFields?.ASSET_REQUEST || [];
  const tiles: string[] = meta?.assetTypes || ["Laptop", "Monitor", "Mouse", "Headphones", "Type C Connector", "Other"];
  useEffect(() => { const it = (catalog || []).find((c) => String(c.id) === itemId); if (it) setType(ASSET_TYPES.includes(it.category) ? it.category : "Other"); }, [catalog, itemId]);
  const itemsOfType = (catalog || []).filter((c) => c.category === type);
  const submit = async () => {
    if (!type) return show("Select an asset type", "error");
    if (!reason.trim()) return show("Reason / justification is required", "error");
    const missing = missingCustomField(cfDefs, cfValues);
    if (missing) return show(`${missing} is required`, "error");
    setBusy(true);
    try {
      const r: any = await api.post("/helpdesk/asset-requests", { assetType: type, catalogItemId: itemId || null, otherItem: other, justification: reason, customFieldValues: cfValues });
      show(r.manager ? `Request ${r.ticketNo} sent to ${r.manager.name} for approval` : `Request ${r.ticketNo} sent to IT`);
      setType(""); setItemId(""); setOther(""); setReason(""); setCfValues({}); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const cancel = async (t: any) => { if (!(await confirmDialog({ title: "Cancel this request?", danger: true }))) return; try { await api.post(`/helpdesk/tickets/${t.id}/cancel`); show("Request cancelled"); reload(); } catch (e: any) { show(e.message, "error"); } };
  return (
    <div className="hd-page narrow">
      <PageHead title="Request an Asset" sub="Request IT hardware — goes to your manager for approval, then IT assigns it." />
      <div className="panel">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>New Asset Request</div>
        <label className="hd-lbl">Asset Type</label>
        <div className="type-grid">
          {tiles.map((t) => <button key={t} type="button" className={`type-tile ${type === t ? "on" : ""}`} onClick={() => { setType(t); setItemId(""); }}><div style={{ fontSize: 24 }}>{TYPE_ICON[t]}</div><div style={{ fontSize: 12 }}>{t}</div></button>)}
        </div>
        {type && itemsOfType.length > 0 && meta?.fields?.ASSET_REQUEST?.catalogBrowseVisible !== false && (
          <><label className="hd-lbl">{meta?.fieldLabels?.ASSET_REQUEST?.catalogBrowseVisible || "Catalog Item"} (optional)</label>
            <select value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">Any {type.toLowerCase()}</option>{itemsOfType.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></>
        )}
        {type === "Other" && !itemId && <><label className="hd-lbl">What do you need?</label><input value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. Laptop bag, webcam" /></>}
        <label className="hd-lbl">Reason / Justification <span className="req">*</span></label>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        <CustomFieldsSection defs={cfDefs} values={cfValues} onChange={setCfValues} />
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <AddButton disabled={busy} onClick={submit} icon={<span />}>{busy ? "Submitting…" : "Submit Request"}</AddButton>
          <GhostButton onClick={() => { setType(""); setItemId(""); setReason(""); }}>Cancel</GhostButton>
        </div>
      </div>
      <div style={{ fontWeight: 600, margin: "18px 0 8px" }}>My Requests</div>
      {(mine || []).length === 0 && <div className="panel" style={{ color: "var(--muted)" }}>No asset requests yet.</div>}
      {(mine || []).map((t) => (
        <div key={t.id} className="panel" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 22 }}>{TYPE_ICON[t.details?.assetType] || "📦"}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>{t.details?.itemName || t.subject}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{t.ticketNo} · {dstr(t.createdAt)}{t.manager ? ` · Approver: ${t.manager.name}` : ""}</div></div>
            <StatusPill t={t} />
            {["PENDING_MANAGER", "OPEN"].includes(t.status) && meta?.permissions?.ASSET_REQUEST?.employeeCanWithdraw !== false && <GhostButton onClick={() => cancel(t)}>Cancel</GhostButton>}
          </div>
          <div className="hd-box" style={{ marginTop: 10 }}><div className="hd-box-lbl">Your reason</div>"{t.description}"</div>
          {t.status === "REJECTED" && <div className="hd-box bad"><div className="hd-box-lbl">{statusView(t).label}</div>"{t.rejectedBy === "MANAGER" ? t.managerNote : t.resolution}"</div>}
          {t.status === "RESOLVED" && t.resolution && <div className="hd-box good"><div className="hd-box-lbl">IT Support</div>{t.resolution}</div>}
        </div>
      ))}
    </div>
  );
}

// =====================================================================================
// Elevated Access
// =====================================================================================
// Countdown "Xd Yh Zm" (or "Expired") to a target Date, ticking once a minute.
function useCountdown(target: Date | null) {
  const [, setTick] = useState(0);
  useEffect(() => { if (!target) return; const h = setInterval(() => setTick((n) => n + 1), 30000); return () => clearInterval(h); }, [target?.getTime()]);
  if (!target) return "";
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60000), d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The employee's approved-and-not-yet-expired elevated-access session, with the generated
    credential — shown as a banner above the request form so they don't have to dig into My
    Tickets to find the password IT/their manager just granted them. */
function ActiveSessionBanner({ t, onEnded }: { t: any; onEnded: () => void }) {
  const { show } = useToast();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = t.details || {};
  const expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
  const countdown = useCountdown(expiresAt);
  const copy = async () => { try { await navigator.clipboard.writeText(d.credentialPassword); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { show("Couldn't copy — select and copy manually", "error"); } };
  const endSession = async () => {
    if (!(await confirmDialog({ title: "End this session now?", message: "Your temporary administrator access will be revoked immediately.", danger: true }))) return;
    setBusy(true);
    try { await api.post(`/helpdesk/tickets/${t.id}/elevated-access/end`); show("Session ended"); onEnded(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="panel" style={{ marginBottom: 14, border: "1px solid var(--good)", background: "rgba(5,150,105,.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>🔓 Active Session — {t.ticketNo}</div>
        <span className="pill good">Expires in {countdown}</span>
      </div>
      <div className="form-grid">
        <div><label className="hd-lbl" style={{ margin: 0 }}>System</label><div>{d.hostname} ({d.deviceType})</div></div>
        <div><label className="hd-lbl" style={{ margin: 0 }}>Duration</label><div>{d.durationDays} day(s)</div></div>
        <div><label className="hd-lbl" style={{ margin: 0 }}>Administrator Account</label><div style={{ fontFamily: "monospace" }}>{d.credentialUsername}</div></div>
        <div>
          <label className="hd-lbl" style={{ margin: 0 }}>Temporary Password</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ padding: "3px 8px", background: "var(--panel2)", borderRadius: 6, fontSize: 13 }}>{d.credentialPassword}</code>
            <GhostButton onClick={copy}>{copied ? "Copied ✓" : "Copy"}</GhostButton>
          </div>
        </div>
      </div>
      <div className="hd-warn" style={{ marginTop: 10 }}>⚠ Do not share this password. End the session as soon as your work is complete.</div>
      <div style={{ marginTop: 10 }}><GhostButton disabled={busy} onClick={endSession}>{busy ? "Ending…" : "End Session Now"}</GhostButton></div>
    </div>
  );
}

export function ElevatedAccess() {
  const nav = useNavigate();
  const { show } = useToast();
  const { data: mine, reload } = useFetch<any[]>("/helpdesk/tickets?type=ELEVATED_ACCESS");
  const { data: meta } = useFetch<any>("/helpdesk/meta");
  const maxDays = meta?.elevatedAccessMaxDays || 7;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const [f, setF] = useState({ deviceType: "Windows", hostname: "", justification: "", startDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, startTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`, days: 1 });
  const [busy, setBusy] = useState(false);
  const [cfValues, setCfValues] = useState<Record<string, string>>({});
  const cfDefs = meta?.customFields?.ELEVATED_ACCESS || [];
  const start = new Date(`${f.startDate}T${f.startTime || "00:00"}:00`);
  const expires = isNaN(start.getTime()) ? null : new Date(start.getTime() + (Number(f.days) || 0) * 86400000);
  const activeSession = (mine || []).find((t) => t.status === "RESOLVED" && t.details?.credentialPassword && t.details?.expiresAt && new Date(t.details.expiresAt) > new Date() && !t.details?.sessionEndedAt);
  const pendingRequest = (mine || []).find((t) => ["PENDING_MANAGER", "OPEN"].includes(t.status));
  const blocked = !!activeSession || !!pendingRequest;
  const submit = async () => {
    if (!f.hostname.trim() || !f.justification.trim()) return show("System name and justification are required", "error");
    if (!(f.days >= 1 && f.days <= maxDays)) return show(`Access duration must be 1–${maxDays} days`, "error");
    const missing = missingCustomField(cfDefs, cfValues);
    if (missing) return show(`${missing} is required`, "error");
    setBusy(true);
    try {
      const r: any = await api.post("/helpdesk/elevated-access", { deviceType: f.deviceType, hostname: f.hostname, justification: f.justification, startAt: start.toISOString(), durationDays: Number(f.days), customFieldValues: cfValues });
      show(r.manager ? `Request ${r.ticketNo} sent to ${r.manager.name} for approval` : `Request ${r.ticketNo} sent to IT`);
      setF({ ...f, hostname: "", justification: "" }); setCfValues({}); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="hd-page">
      <PageHead title="Elevated Access" sub="Request temporary local admin access for your device." />
      {activeSession && <ActiveSessionBanner t={activeSession} onEnded={reload} />}
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(240px, 1fr)", alignItems: "start" }}>
        <div className="panel">
          <div className="hd-warn">⚠ All actions using admin credentials are logged. Misuse will result in immediate revocation.</div>
          {blocked && <div className="note" style={{ marginTop: 10 }}>{activeSession ? "You already have an active session above — end it or wait for it to expire before requesting another." : "You have a pending request awaiting approval — cancel it from My Request History before submitting a new one."}</div>}
          <label className="hd-lbl">Device Type <span className="req">*</span></label>
          <div className="grid cols-2">
            {["Windows", "Mac"].map((d) => (
              <button key={d} type="button" disabled={blocked} className={`type-tile left ${f.deviceType === d ? "on" : ""}`} onClick={() => setF({ ...f, deviceType: d })}>
                <div style={{ fontWeight: 600 }}>{d === "Windows" ? "🪟" : "🍎"} {d}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>Administrator account</div>
              </button>
            ))}
          </div>
          <label className="hd-lbl">Your System Name / Hostname <span className="req">*</span></label>
          <input disabled={blocked} value={f.hostname} onChange={(e) => setF({ ...f, hostname: e.target.value })} placeholder="Please enter your laptop name" />
          <label className="hd-lbl">Justification <span className="req">*</span></label>
          <textarea disabled={blocked} rows={3} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} placeholder="Why do you need admin access? e.g. Need to install approved software for project X" />
          {meta?.fields?.ELEVATED_ACCESS?.startDateTimeFieldVisible !== false && (
            <div className="form-grid">
              <div><label className="hd-lbl">Start Date</label><DateInput disabled={blocked} value={f.startDate} onChange={(e: any) => setF({ ...f, startDate: e.target.value })} /></div>
              <div><label className="hd-lbl">Start Time</label><input disabled={blocked} type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></div>
            </div>
          )}
          <label className="hd-lbl">Access Duration <span style={{ textTransform: "none", fontWeight: 400 }}>(max {maxDays} days)</span></label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><input disabled={blocked} type="number" min={1} max={maxDays} value={f.days} onChange={(e) => setF({ ...f, days: Math.max(1, Math.min(maxDays, Number(e.target.value) || 1)) })} style={{ width: 90 }} /> Days</div>
          {expires && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Access will expire on <b>{dtstr(expires)}</b></div>}
          <CustomFieldsSection defs={cfDefs} values={cfValues} onChange={setCfValues} />
          <button type="button" className="hd-submit" disabled={busy || blocked} onClick={submit}>⚠ {busy ? "Submitting…" : "Submit Request to Manager"}</button>
        </div>
        <div>
          <div className="panel">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>My Request History</div>
            {(mine || []).length === 0 && <div style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 10 }}>No requests yet.</div>}
            {(mine || []).map((t) => (
              <div key={t.id} className="hd-list-row" style={{ padding: "8px 0" }} onClick={() => nav(`/helpdesk/tickets?open=${t.id}`)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t.details?.hostname} · {t.details?.deviceType}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{t.ticketNo} · {t.details?.durationDays}d from {dstr(t.details?.startAt)}</div>
                </div>
                <StatusPill t={t} />
              </div>
            ))}
          </div>
          <div className="hd-help">
            <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: 0.5 }}>NEED HELP?</div>
            <div style={{ fontSize: 13, margin: "4px 0 10px" }}>If your request is urgent, contact IT Support directly.</div>
            <button type="button" onClick={() => nav("/helpdesk/raise")}>Contact IT Support</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================================
// Team Approvals (reporting manager)
// =====================================================================================
export function TeamApprovals() {
  const { show } = useToast();
  const [history, setHistory] = useState(false);
  const { data, reload } = useFetch<any[]>(`/helpdesk/approvals${history ? "?history=1" : ""}`, [history]);
  // A direct report raising a new Elevated Access/Asset request live-refreshes this list — the
  // manager doesn't need to manually reload to see it land under Pending Approval.
  useEffect(() => watchRoom("helpdesk:activity", "helpdesk:activity", reload), []);
  const decide = async (t: any, approve: boolean) => {
    let note: any = "";
    if (!approve) { note = await confirmDialog({ title: `Reject ${t.ticketNo}?`, prompt: true, placeholder: "Reason (shown to the employee)", danger: true, confirmLabel: "Reject" }); if (!note) return; }
    try { await api.post(`/helpdesk/approvals/${t.id}/${approve ? "approve" : "reject"}`, { note }); show(approve ? "Approved — sent to IT" : "Rejected"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div className="hd-page">
      <PageHead title="Pending Approval" sub="Asset and elevated-access requests from people who report to you. Approved requests go to IT." />
      <div style={{ marginBottom: 12 }}><button type="button" className={`chip-btn ${!history ? "on" : ""}`} onClick={() => setHistory(false)}>Pending</button> <button type="button" className={`chip-btn ${history ? "on" : ""}`} onClick={() => setHistory(true)}>Decided</button></div>
      <Panel>
        <table><thead><tr><th>Request</th><th>Employee</th><th>What</th><th>Reason</th><th>Raised</th><th>{history ? "Decision" : ""}</th></tr></thead>
          <tbody>
            {(data || []).length === 0 && <tr><td colSpan={6} style={{ color: "var(--muted)" }}>{history ? "Nothing decided yet." : "Nothing waiting on you."}</td></tr>}
            {(data || []).map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{t.ticketNo}</td>
                <td>{t.requester?.name}{t.employee?.empNo ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{t.employee.empNo}</div> : null}</td>
                <td>{t.type === "ELEVATED_ACCESS" ? <>🔑 {t.details?.accessLevel} on <b>{t.details?.hostname}</b><div style={{ fontSize: 11, color: "var(--muted)" }}>{t.details?.durationDays} day(s) from {dtstr(t.details?.startAt)}</div></> : <>{TYPE_ICON[t.details?.assetType] || "📦"} {t.details?.itemName}</>}</td>
                <td style={{ maxWidth: 320 }}>{t.description}</td>
                <td style={{ whiteSpace: "nowrap" }}>{dstr(t.createdAt)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{history ? <span className={`pill ${t.approvalStatus === "APPROVED" ? "good" : "bad"}`}>{t.approvalStatus}</span>
                  : <><AddButton onClick={() => decide(t, true)}>Approve</AddButton> <GhostButton onClick={() => decide(t, false)}>Reject</GhostButton></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// =====================================================================================
// IT Admin Dashboard — real metrics from routes/itsm/helpdesk.ts GET /admin/dashboard, live via
// Socket.IO (joins "helpdesk:activity", refetches on any ping — see engine/realtime.ts
// emitHelpdeskUpdate(), fired from every real mutation: new ticket/request, comment, status
// change, approval decision, access granted, password rotated, asset assigned).
// =====================================================================================
const CHART_COLORS = ["#7C9CFF", "#34D399", "#FBBF63", "#F87171", "#A78BFA", "#38BDF8", "#FB923C", "#4ADE80"];
// `onClick` makes this a deep-link into the exact filtered view the metric represents (reuses
// `.hd-action`'s existing hover-lift/accent-border affordance, same as the employee-portal quick
// tiles) — omitted, it's just a plain static panel, same as before.
function KpiCard({ label, value, sub, tone, onClick }: { label: string; value: React.ReactNode; sub?: string; tone?: "bad" | "good" | "warn"; onClick?: () => void }) {
  const color = tone === "bad" ? "var(--bad, #e5484d)" : tone === "good" ? "var(--good, #34D399)" : tone === "warn" ? "var(--warn, #FBBF63)" : "var(--text)";
  return (
    <div className={onClick ? "hd-action" : "panel"} style={{ padding: 16 }} onClick={onClick} title={onClick ? "Click to view" : undefined}>
      <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
export function HelpdeskDashboardPage() {
  const { data, reload } = useFetch<any>("/helpdesk/admin/dashboard");
  const nav = useNavigate();
  useEffect(() => {
    const cleanup = watchRoom("helpdesk:activity", "helpdesk:activity", () => reload());
    return () => cleanup();
  }, []);
  if (!data) return <div><h1>IT Admin Dashboard</h1><div>Loading…</div></div>;

  const statusOrder = ["PENDING_MANAGER", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"];
  const statusTotals: Record<string, number> = {};
  for (const r of data.ticketsByStatus) statusTotals[r.status] = (statusTotals[r.status] || 0) + r.count;
  const activeCount = (statusTotals.OPEN || 0) + (statusTotals.IN_PROGRESS || 0) + (statusTotals.ON_HOLD || 0);
  const openTicketOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } };

  return (
    <div>
      <h1>IT Admin Dashboard</h1>
      <div className="subtitle">Live metrics across tickets, assets and elevated access — updates automatically as things happen, no refresh needed.</div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", gap: 12, margin: "16px 0" }}>
        <KpiCard label="Active Tickets" value={activeCount} sub="Open / In Progress / On Hold" onClick={() => nav("/it-admin/tickets?active=1")} />
        <KpiCard label="SLA Overdue" value={data.sla.overdue} tone={data.sla.overdue > 0 ? "bad" : "good"} sub={`${data.sla.onTrack} on track`} onClick={() => nav("/it-admin/tickets?sla=overdue")} />
        <KpiCard label="Pending Approvals" value={data.pendingApprovals} tone={data.pendingApprovals > 0 ? "warn" : undefined} sub="Asset & access requests" onClick={() => nav("/it-admin/tickets?approvalStatus=PENDING")} />
        <KpiCard label="Active Access Sessions" value={data.elevatedAccess.active} sub="Elevated access, live" onClick={() => nav("/it-admin/access-reports?filter=ACTIVE")} />
        <KpiCard label="Rotation Needed" value={data.elevatedAccess.rotationNeeded} tone={data.elevatedAccess.rotationNeeded > 0 ? "bad" : "good"} sub="Expired credentials" onClick={() => nav("/it-admin/access-reports?filter=ROTATION")} />
      </div>

      {data.elevatedAccess.rotationNeeded > 0 && (
        <div className="note" style={{ cursor: "pointer", marginBottom: 14 }} onClick={() => nav("/it-admin/access-reports?filter=ROTATION")}>
          ⚠ {data.elevatedAccess.rotationNeeded} elevated-access credential{data.elevatedAccess.rotationNeeded > 1 ? "s need" : " needs"} rotation → Access Reports
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start", marginBottom: 16 }}>
        <Panel title="Tickets by Status">
          <div style={{ height: 240, cursor: "pointer" }} title="Click a bar to open Ticket Queue filtered by that status">
            <Bar options={{
              ...openTicketOptions,
              onClick: (_evt, elements) => { if (elements.length) nav(`/it-admin/tickets?status=${statusOrder[elements[0].index]}`); },
              onHover: (evt: any, elements) => { if (evt.native?.target) evt.native.target.style.cursor = elements.length ? "pointer" : "default"; },
            }} data={{
              labels: statusOrder.map((s) => s.replace(/_/g, " ")),
              datasets: [{ label: "Tickets", data: statusOrder.map((s) => statusTotals[s] || 0), backgroundColor: CHART_COLORS[0] }],
            }} />
          </div>
        </Panel>
        <Panel title="Incidents by Priority">
          <div style={{ height: 240 }} title="Click a slice to open Ticket Queue filtered by that priority">
            <Doughnut data={{
              labels: data.ticketsByPriority.map((r: any) => cap(r.priority)),
              datasets: [{ data: data.ticketsByPriority.map((r: any) => r.count), backgroundColor: CHART_COLORS }],
            }} options={{
              responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" as const } },
              onClick: (_evt, elements) => { if (elements.length) nav(`/it-admin/tickets?priority=${data.ticketsByPriority[elements[0].index].priority}`); },
              onHover: (evt: any, elements) => { if (evt.native?.target) evt.native.target.style.cursor = elements.length ? "pointer" : "default"; },
            }} />
          </div>
        </Panel>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start", marginBottom: 16 }}>
        <Panel title="Asset Inventory by Status">
          <div style={{ height: 220 }}>
            <Doughnut data={{
              labels: data.assetsByStatus.map((r: any) => r.status.replace(/_/g, " ")),
              datasets: [{ data: data.assetsByStatus.map((r: any) => r.count), backgroundColor: CHART_COLORS }],
            }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" as const } } }} />
          </div>
        </Panel>
        <Panel title="Agent Workload — active incidents assigned">
          {data.agentWorkload.length === 0 ? <div className="subtitle" style={{ margin: 0 }}>Nothing currently assigned.</div> : (
            <div style={{ height: 220 }}>
              <Bar options={{ ...openTicketOptions, indexAxis: "y" as const }} data={{
                labels: data.agentWorkload.map((r: any) => r.agent),
                datasets: [{ label: "Assigned", data: data.agentWorkload.map((r: any) => r.count), backgroundColor: CHART_COLORS[1] }],
              }} />
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Recent Activity — live">
        {data.recentActivity.length === 0 ? <div className="subtitle" style={{ margin: 0 }}>No activity yet.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {data.recentActivity.map((a: any) => (
              <div key={a.id} className="hd-list-row" style={{ padding: "8px 0" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}><b>{a.authorName}</b>{a.ticketNo ? <> on <b>{a.ticketNo}</b> — {a.subject}</> : null}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{a.body}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>{dtstr(a.at)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

// =====================================================================================
// IT Admin pages — Ticket Queue / Asset Inventory / Asset Catalog / Access Reports /
// Knowledge Base / Helpdesk Settings are each their OWN standalone page/route (no shared tab
// bar) — each nav item in the sidebar is a genuinely separate destination.
// =====================================================================================
function ConsolePage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <h1>{title}</h1>
      <div className="subtitle">{subtitle}</div>
      {children}
    </div>
  );
}
export function HelpdeskSettingsPage() {
  return <ConsolePage title="Helpdesk Settings" subtitle="Fully customize workflow stages, form fields, permissions, SLA and categories for the IT Helpdesk module."><ConsoleSettings /></ConsolePage>;
}
export function HelpdeskTicketQueuePage() {
  return <ConsolePage title="Ticket Queue" subtitle="All employee tickets — filter by status/type, open a ticket to update status, assign, resolve or reply."><ConsoleQueue /></ConsolePage>;
}
export function HelpdeskAssetInventoryPage() {
  return <ConsolePage title="Asset Inventory" subtitle="The IT asset inventory — add stock, assign equipment to employees, and track warranty/status."><ConsoleAssets /></ConsolePage>;
}
export function HelpdeskAssetCatalogAdminPage() {
  return <ConsolePage title="Asset Catalog" subtitle="The requestable asset catalog employees browse from Request an Asset."><ConsoleCatalog /></ConsolePage>;
}
export function HelpdeskAccessReportsPage() {
  return <ConsolePage title="Access Reports" subtitle="Elevated-access history — active sessions, expired credentials and password rotation."><ConsoleAccessReports /></ConsolePage>;
}
export function HelpdeskKbAdminPage() {
  return <ConsolePage title="Knowledge Base" subtitle="Knowledge-base documents — upload, edit and publish articles for employees."><ConsoleKb /></ConsolePage>;
}

// =====================================================================================
// IT — Access Reports (elevated access history, active/expired sessions, password rotation)
// =====================================================================================
function ConsoleAccessReports() {
  const { show } = useToast();
  const { data, reload } = useFetch<any[]>("/helpdesk/admin/access-reports");
  // Deep-linked from IT Admin Dashboard's "Active Access Sessions" (?filter=ACTIVE) and "Rotation
  // Needed" (?filter=ROTATION) cards — the chip control itself reflects the incoming filter.
  const [params] = useSearchParams();
  const urlFilter = params.get("filter");
  const [filter, setFilter] = useState<"ALL" | "ACTIVE" | "ROTATION">(urlFilter === "ACTIVE" || urlFilter === "ROTATION" ? urlFilter : "ALL");
  const rows = (data || []).filter((t) => filter === "ALL" || (filter === "ACTIVE" ? t.active : t.rotationNeeded));
  const rotate = async (t: any) => {
    if (!(await confirmDialog({ title: `Rotate password for ${t.ticketNo}?`, message: "Generates a new temporary administrator password and invalidates the old one." }))) return;
    try { await api.post(`/helpdesk/admin/tickets/${t.id}/rotate`); show("Password rotated"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  return (
    <Panel>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["ALL", "ACTIVE", "ROTATION"] as const).map((k) => (
          <button key={k} type="button" className={`chip-btn ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{k === "ALL" ? "All" : k === "ACTIVE" ? "Active Sessions" : "Rotation Needed"}</button>
        ))}
      </div>
      <table><thead><tr><th>Request</th><th>Employee</th><th>System</th><th>Granted</th><th>Expires</th><th>Source</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} style={{ color: "var(--muted)" }}>Nothing here.</td></tr>}
          {rows.map((t) => (
            <tr key={t.id}>
              <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{t.ticketNo}</td>
              <td>{t.requester?.name}</td>
              <td>{t.details?.hostname} <span style={{ color: "var(--muted)" }}>({t.details?.deviceType})</span></td>
              <td style={{ whiteSpace: "nowrap" }}>{t.details?.grantedAt ? dtstr(t.details.grantedAt) : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>{t.details?.expiresAt ? dtstr(t.details.expiresAt) : "—"}</td>
              <td style={{ fontSize: 11 }}>{(t.details?.credentialSource || "—").replace(/_/g, " ")}</td>
              <td>{t.active ? <span className="pill good">Active</span> : t.rotationNeeded ? <span className="pill warn">Rotation Needed</span> : t.details?.credentialPassword ? <span className="pill">Expired</span> : <StatusPill t={t} />}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {t.rotationNeeded && <GhostButton onClick={() => rotate(t)}>Rotate Password</GhostButton>}
                {t.rotationNeeded && String(t.details?.credentialSource || "").startsWith("INTUNE") && <a href="https://endpoint.microsoft.com" target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontSize: 12 }}>Open in Intune ↗</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// =====================================================================================
// IT — Helpdesk Settings: a real Workflow & Permission Builder, not just a settings form.
// Per request type (Incident / Asset Request / Elevated Access), an admin can rename the stages
// shown to users and toggle the handful of permission checks the app actually enforces
// server-side (see PERMISSION_DEFAULTS / stageLabel() in routes/itsm/helpdesk.ts) — every toggle
// here maps 1:1 to a real `perm(...)` check in a real route, nothing is decorative. The Live
// Preview pane mirrors that same logic client-side against the unsaved draft, so an admin sees
// exactly which stage label and which action buttons a given role would see, before publishing.
// Explicitly NOT built (see the chat, not hidden): a drag/drop canvas, new custom stages beyond
// the fixed set the engine actually understands, an automation/condition/rule engine, and a
// notification-template builder — those would mean running admin-authored logic in production.
// =====================================================================================
const STAGE_KEYS_BY_TYPE: Record<string, string[]> = {
  INCIDENT: ["PENDING_MANAGER", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"],
  ASSET_REQUEST: ["PENDING_MANAGER", "OPEN", "RESOLVED", "REJECTED", "CANCELLED"],
  ELEVATED_ACCESS: ["PENDING_MANAGER", "OPEN", "RESOLVED", "REJECTED", "CANCELLED"],
};
const DEFAULT_STAGE_LABELS_CLIENT: Record<string, Record<string, string>> = {
  INCIDENT: { PENDING_MANAGER: "Pending Manager Approval", OPEN: "Open", IN_PROGRESS: "In Progress", ON_HOLD: "On Hold", RESOLVED: "Resolved", CLOSED: "Closed", REJECTED: "Rejected", CANCELLED: "Cancelled" },
  ASSET_REQUEST: { PENDING_MANAGER: "Pending Manager Approval", OPEN: "Approved · With IT", RESOLVED: "Assigned", REJECTED: "Rejected", CANCELLED: "Cancelled" },
  ELEVATED_ACCESS: { PENDING_MANAGER: "Pending Manager Approval", OPEN: "Approved · With IT", RESOLVED: "Access Granted", REJECTED: "Rejected", CANCELLED: "Cancelled" },
};
const PERMISSION_DEFS_BY_TYPE: Record<string, { key: string; label: string }[]> = {
  INCIDENT: [
    { key: "requireResolutionNote", label: "IT must add a resolution note before resolving" },
    { key: "employeeCanReopen", label: "Employee can re-open a resolved ticket" },
    { key: "employeeCanWithdraw", label: "Employee can withdraw a pending/open ticket" },
  ],
  ASSET_REQUEST: [
    { key: "itCanApprove", label: "IT Support can approve/reject on the manager's behalf" },
    { key: "employeeCanWithdraw", label: "Employee can withdraw a pending/open request" },
  ],
  ELEVATED_ACCESS: [
    { key: "itCanApprove", label: "IT Support can approve/reject on the manager's behalf" },
    { key: "employeeCanWithdraw", label: "Employee can withdraw a pending/open request" },
  ],
};
const FIELD_DEFS_BY_TYPE: Record<string, { key: string; label: string; hasLabel?: boolean; requiredKey?: string }[]> = {
  INCIDENT: [
    { key: "priorityFieldVisible", label: "Show Priority selector", hasLabel: true },
    { key: "attachmentFieldVisible", label: "Show Attachment upload", hasLabel: true, requiredKey: "attachmentFieldRequired" },
  ],
  ASSET_REQUEST: [{ key: "catalogBrowseVisible", label: "Show Catalog Item picker", hasLabel: true }],
  ELEVATED_ACCESS: [{ key: "startDateTimeFieldVisible", label: "Show Start Date/Time pickers" }],
};
const DEFAULT_FIELD_LABELS_CLIENT: Record<string, Record<string, string>> = {
  INCIDENT: { priorityFieldVisible: "Priority", attachmentFieldVisible: "Attachment" },
  ASSET_REQUEST: { catalogBrowseVisible: "Catalog Item" },
  ELEVATED_ACCESS: {},
};
const URL_BY_TYPE: Record<string, string> = { INCIDENT: "/helpdesk/raise", ASSET_REQUEST: "/helpdesk/request-asset", ELEVATED_ACCESS: "/helpdesk/elevated-access" };
/** A custom field's disabled preview input, by type — same rendering both here (Settings live
    preview) and in the real forms below, so what an admin sees while configuring is exactly what
    ships. */
function CustomFieldPreviewInput({ cf }: { cf: { fieldType: string } }) {
  if (cf.fieldType === "textarea") return <textarea disabled rows={2} />;
  return <input disabled type={cf.fieldType === "number" ? "number" : cf.fieldType === "date" ? "date" : "text"} />;
}
/** A macOS/Chrome-style browser chrome around the live form preview — the "bigger, fuller-page,
    this-is-literally-the-real-page" treatment, not a small embedded panel. Exported so other
    builders (HR Workflow & Stage Configuration) share the exact same preview chrome. */
export function BrowserFrame({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", boxShadow: "0 12px 34px rgba(0,0,0,.28)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--panel2)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f57", display: "inline-block" }} />
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#febc2e", display: "inline-block" }} />
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#28c840", display: "inline-block" }} />
        <div style={{ flex: 1, marginLeft: 10, padding: "5px 12px", background: "var(--panel)", borderRadius: 6, fontSize: 11.5, color: "var(--muted)", fontFamily: "monospace" }}>🔒 genaquariusinternal.azurewebsites.net{url}</div>
      </div>
      <div style={{ padding: 26, background: "var(--bg, var(--panel))", maxHeight: 640, overflowY: "auto" }}>{children}</div>
    </div>
  );
}
const REQUEST_TYPES = [["INCIDENT", "Incident"], ["ASSET_REQUEST", "Asset Request"], ["ELEVATED_ACCESS", "Elevated Access"]] as const;
const PREVIEW_ROLES = ["Employee", "Manager", "IT Support"] as const;
const STAGE_CLASS: Record<string, string> = { PENDING_MANAGER: "warn", OPEN: "accent", IN_PROGRESS: "warn", ON_HOLD: "", RESOLVED: "good", CLOSED: "good", REJECTED: "bad", CANCELLED: "" };

/** Mirrors the real gating logic in TicketDetail/ConsoleQueue/TeamApprovals — computed purely
    from draft (unsaved) config, so the preview is honest about what will actually happen. */
function previewActions(type: string, stage: string, role: string, perm: Record<string, Record<string, boolean>>): string[] {
  const p = (k: string) => perm[type]?.[k] !== false;
  const out: string[] = [];
  if (role === "Employee") {
    if (["PENDING_MANAGER", "OPEN"].includes(stage) && p("employeeCanWithdraw")) out.push("Withdraw / Cancel Request");
    if (type === "INCIDENT" && stage === "RESOLVED") { out.push("Confirm & Close"); if (p("employeeCanReopen")) out.push("Re-open"); }
  }
  if (role === "Manager" && type !== "INCIDENT" && stage === "PENDING_MANAGER") out.push("Approve", "Reject");
  if (role === "IT Support") {
    if (type !== "INCIDENT" && stage === "PENDING_MANAGER" && p("itCanApprove")) out.push("Approve (on manager's behalf)", "Reject (on manager's behalf)");
    if (type === "ASSET_REQUEST" && stage === "OPEN") out.push("Assign an Asset…");
    if (type === "ELEVATED_ACCESS" && stage === "OPEN") out.push("Grant Access");
    if (type === "ELEVATED_ACCESS" && stage === "RESOLVED") out.push("Rotate Password (once expired)");
    if (!["RESOLVED", "CLOSED", "REJECTED", "CANCELLED"].includes(stage)) out.push("Change Status / Priority / Assignee");
  }
  return out;
}

/** Real, visually-faithful (read-only) replica of the actual Raise Ticket / Request an Asset /
    Elevated Access screen — same CSS classes the live forms use (hd-lbl, panel, req, type-grid,
    dropzone, form-grid) — reflecting live draft field-visibility, so this is a genuine "what the
    employee will see" preview, not an abstract summary. */
function FormPreview({ type, fields, fieldLabels, customFields, categories, assetTypes }: { type: string; fields: Record<string, boolean>; fieldLabels: Record<string, string>; customFields: any[]; categories: string[]; assetTypes: string[] }) {
  const on = (k: string) => fields[k] !== false;
  const lbl = (k: string, fallback: string) => fieldLabels?.[k] || fallback;
  const customBlock = customFields.length > 0 && (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--border)" }}>
      {customFields.map((cf) => (
        <div key={cf.key}>
          <label className="hd-lbl">{cf.label} {cf.required ? <span className="req">*</span> : "(optional)"}</label>
          <CustomFieldPreviewInput cf={cf} />
        </div>
      ))}
    </div>
  );
  if (type === "INCIDENT") return (
    <div className="panel" style={{ background: "var(--panel)" }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>Raise a Support Ticket</div>
      <label className="hd-lbl">Issue Title <span className="req">*</span></label>
      <input disabled placeholder="e.g. Laptop shows blue screen on start-up" />
      <div className="form-grid" style={{ marginTop: 4 }}>
        <div><label className="hd-lbl">Category <span className="req">*</span></label><select disabled><option>{categories[0] || "Hardware"}</option></select></div>
        {on("priorityFieldVisible") && <div><label className="hd-lbl">{lbl("priorityFieldVisible", "Priority")}</label><div style={{ display: "flex", gap: 6 }}>{PRIORITIES.map((p) => <span key={p} className="prio-btn">{cap(p)}</span>)}</div></div>}
      </div>
      <label className="hd-lbl">Description <span className="req">*</span></label>
      <textarea disabled rows={3} placeholder="Describe the issue — when it started, what you've already tried…" />
      {on("attachmentFieldVisible") && (<>
        <label className="hd-lbl">{lbl("attachmentFieldVisible", "Attachment")} {fields.attachmentFieldRequired ? <span className="req">*</span> : "(optional)"}</label>
        <div className="dropzone"><div style={{ fontSize: 20 }}>📎</div><div>Drag &amp; drop a file or <u style={{ color: "var(--accent)" }}>browse files</u></div></div>
      </>)}
      {customBlock}
    </div>
  );
  if (type === "ASSET_REQUEST") return (
    <div className="panel" style={{ background: "var(--panel)" }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>Request an Asset</div>
      <label className="hd-lbl">Asset Type</label>
      <div className="type-grid">{assetTypes.slice(0, 4).map((t) => <div key={t} className="type-tile">{TYPE_ICON[t] || "📦"}<div style={{ fontSize: 12 }}>{t}</div></div>)}</div>
      {on("catalogBrowseVisible") && (<><label className="hd-lbl">{lbl("catalogBrowseVisible", "Catalog Item")} (optional)</label><select disabled><option>Any laptop</option></select></>)}
      <label className="hd-lbl">Reason / Justification <span className="req">*</span></label>
      <textarea disabled rows={2} />
      {customBlock}
    </div>
  );
  return (
    <div className="panel" style={{ background: "var(--panel)" }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>Elevated Access</div>
      <label className="hd-lbl">Device Type <span className="req">*</span></label>
      <div className="grid cols-2"><div className="type-tile left">🪟 Windows</div><div className="type-tile left">🍎 Mac</div></div>
      <label className="hd-lbl">Your System Name / Hostname <span className="req">*</span></label><input disabled placeholder="Please enter your laptop name" />
      <label className="hd-lbl">Justification <span className="req">*</span></label><textarea disabled rows={2} />
      {on("startDateTimeFieldVisible") && (
        <div className="form-grid"><div><label className="hd-lbl">Start Date</label><input disabled type="date" /></div><div><label className="hd-lbl">Start Time</label><input disabled type="time" /></div></div>
      )}
      {customBlock}
    </div>
  );
}

// Laptop Handover Email template — IT Admin's own (separate from HR's email templates), styled
// and structured identically to the Offer Letter template editor (Subject/Body/Signature/Show
// Logo, editor left + live preview right). Only one key exists here (no per-key list), since IT
// Admin manages exactly one template from this screen.
const LAPTOP_TEMPLATE_PREVIEW_SAMPLE: Record<string, string> = {
  EmployeeName: "Aditi Sharma", EmployeeId: "1042", Department: "Engineering", Designation: "Software Engineer",
  Location: "INDIA", MobileNo: "+91 98765 43210", EmailId: "aditi.sharma@genaquarius.com",
  AssetsTable: "<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\" style=\"border-collapse:collapse;width:100%\"><thead><tr><th>Category</th><th>Make / Model</th><th>Serial No.</th></tr></thead><tbody><tr><td>Laptop</td><td>Dell — Latitude 5440</td><td>DL5440X92</td></tr><tr><td>Peripheral</td><td>Logitech — M185</td><td>LG185Q1</td></tr></tbody></table>",
};
function fillLaptopPreview(tpl: string): string {
  return String(tpl || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => LAPTOP_TEMPLATE_PREVIEW_SAMPLE[key] ?? `{{${key}}}`);
}
function LaptopHandoverTemplateSettings() {
  const { data, reload } = useFetch<any>("/it-admin/laptop-template");
  const { show } = useToast();
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [signature, setSignature] = useState(""); const [showLogo, setShowLogo] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data && !loaded) { setSubject(data.subject || ""); setBody(data.body || ""); setSignature(data.signature || ""); setShowLogo(data.showLogo !== false); setLoaded(true); }
  }, [data]);
  const save = async () => {
    setBusy(true);
    try { await api.put("/it-admin/laptop-template", { subject, body, signature, showLogo }); show("Saved"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  if (!loaded) return <Panel title="Laptop Handover Email Template"><div>Loading…</div></Panel>;
  return (
    <Panel title="Laptop Handover Email Template — sent by IT Admin once assets are assigned to a new hire">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div><label>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
          <div>
            <label>Body <span style={{ color: "var(--muted)", fontSize: 12 }}>(supports {"{{EmployeeName}}"}, {"{{EmployeeId}}"}, {"{{Department}}"}, {"{{Designation}}"}, {"{{Location}}"}, {"{{MobileNo}}"}, {"{{EmailId}}"}, and {"{{AssetsTable}}"} — auto-filled from the assets actually assigned to the employee, never entered manually)</span></label>
            <textarea rows={12} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div><label>Signature</label><textarea rows={3} style={{ width: "100%" }} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={"Regards,\nIT Team, GenAquarius"} /></div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={showLogo} onChange={(e) => setShowLogo(e.target.checked)} />
            Show GenAquarius logo below signature
          </label>
          <AddButton onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Template"}</AddButton>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Live preview</div>
          <div style={{ background: "#ffffff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 10, padding: 20, minHeight: 320, fontSize: 14, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #eee" }}>{fillLaptopPreview(subject) || <span style={{ color: "#9aa0ab" }}>Subject preview…</span>}</div>
            <div style={{ whiteSpace: "pre-wrap" }} dangerouslySetInnerHTML={{ __html: fillLaptopPreview(body).replace(/\n/g, "<br>") || "<span style=\"color:#9aa0ab\">Email body preview…</span>" }} />
            {signature && <div style={{ whiteSpace: "pre-wrap", marginTop: 18 }}>{fillLaptopPreview(signature)}</div>}
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
    </Panel>
  );
}

function ConsoleSettings() {
  const { show } = useToast();
  const { data, reload } = useFetch<any>("/helpdesk/admin/settings");
  const [f, setF] = useState<any>(null);
  const [type, setType] = useState<string>("INCIDENT");
  const [previewRole, setPreviewRole] = useState<string>("Employee");
  const [previewStage, setPreviewStage] = useState<string>("OPEN");
  useEffect(() => {
    if (data && !f) {
      const stageLabels: any = {}; const permissions: any = {}; const fields: any = {}; const fieldLabels: any = {};
      for (const t of Object.keys(DEFAULT_STAGE_LABELS_CLIENT)) stageLabels[t] = { ...DEFAULT_STAGE_LABELS_CLIENT[t], ...(data.stageLabels?.[t] || {}) };
      for (const t of Object.keys(PERMISSION_DEFS_BY_TYPE)) { permissions[t] = {}; for (const p of PERMISSION_DEFS_BY_TYPE[t]) permissions[t][p.key] = data.permissions?.[t]?.[p.key] !== false; }
      for (const t of Object.keys(FIELD_DEFS_BY_TYPE)) {
        fields[t] = {}; fieldLabels[t] = { ...DEFAULT_FIELD_LABELS_CLIENT[t], ...(data.fieldLabels?.[t] || {}) };
        for (const fd of FIELD_DEFS_BY_TYPE[t]) {
          fields[t][fd.key] = data.fields?.[t]?.[fd.key] !== false;
          if (fd.requiredKey) fields[t][fd.requiredKey] = data.fields?.[t]?.[fd.requiredKey] === true;
        }
      }
      const customFields: any = { INCIDENT: data.customFields?.INCIDENT || [], ASSET_REQUEST: data.customFields?.ASSET_REQUEST || [], ELEVATED_ACCESS: data.customFields?.ELEVATED_ACCESS || [] };
      setF({ slaHours: { ...data.slaHours }, categories: (data.categories || CATEGORIES).join("\n"), assetTypes: (data.assetTypes || ASSET_TYPES).join("\n"), managerApprovalRequired: { ...data.managerApprovalRequired }, elevatedAccessMaxDays: data.elevatedAccessMaxDays, stageLabels, permissions, fields, fieldLabels, customFields });
    }
  }, [data]);
  if (!f) return <div>Loading…</div>;
  const save = async () => {
    try {
      await api.put("/helpdesk/admin/settings", {
        slaHours: f.slaHours,
        categories: f.categories.split("\n").map((s: string) => s.trim()).filter(Boolean),
        assetTypes: f.assetTypes.split("\n").map((s: string) => s.trim()).filter(Boolean),
        managerApprovalRequired: f.managerApprovalRequired,
        elevatedAccessMaxDays: Number(f.elevatedAccessMaxDays) || 7,
        stageLabels: f.stageLabels, permissions: f.permissions, fields: f.fields, fieldLabels: f.fieldLabels, customFields: f.customFields,
      });
      show("Helpdesk settings saved — takes effect immediately for new requests"); reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  const liveCategories = f.categories.split("\n").map((s: string) => s.trim()).filter(Boolean);
  const liveAssetTypes = f.assetTypes.split("\n").map((s: string) => s.trim()).filter(Boolean);
  const stages = STAGE_KEYS_BY_TYPE[type];
  const actions = previewActions(type, previewStage, previewRole, f.permissions);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="SLA Policy — response due time by priority">
        <div className="form-grid">
          {PRIORITIES.map((p) => (
            <div key={p}><label>{cap(p)} (hours)</label><input type="number" min={1} value={f.slaHours[p]} onChange={(e) => setF({ ...f, slaHours: { ...f.slaHours, [p]: Number(e.target.value) } })} /></div>
          ))}
        </div>
      </Panel>
      <Panel title="Elevated Access & Approval">
        <div className="form-grid">
          <div><label>Asset requests require manager approval</label>
            <select value={f.managerApprovalRequired.ASSET_REQUEST ? "1" : "0"} onChange={(e) => setF({ ...f, managerApprovalRequired: { ...f.managerApprovalRequired, ASSET_REQUEST: e.target.value === "1" } })}><option value="1">Yes</option><option value="0">No — straight to IT</option></select>
          </div>
          <div><label>Elevated-access requests require manager approval</label>
            <select value={f.managerApprovalRequired.ELEVATED_ACCESS ? "1" : "0"} onChange={(e) => setF({ ...f, managerApprovalRequired: { ...f.managerApprovalRequired, ELEVATED_ACCESS: e.target.value === "1" } })}><option value="1">Yes</option><option value="0">No — straight to IT</option></select>
          </div>
          <div><label>Elevated-access max duration (days)</label><input type="number" min={1} max={30} value={f.elevatedAccessMaxDays} onChange={(e) => setF({ ...f, elevatedAccessMaxDays: e.target.value })} /></div>
        </div>
      </Panel>
      <LaptopHandoverTemplateSettings />
      <Panel title="Ticket Categories — one per line, shown on Raise Ticket">
        <textarea rows={6} value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} />
      </Panel>
      <Panel title="Asset Types — one per line, shown on Request an Asset">
        <textarea rows={6} value={f.assetTypes} onChange={(e) => setF({ ...f, assetTypes: e.target.value })} />
      </Panel>

      <Panel title="Workflow, Fields & Permissions — per request type, with a live real-screen preview">
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {REQUEST_TYPES.map(([k, l]) => (
            <button key={k} type="button" className={`chip-btn ${type === k ? "on" : ""}`} onClick={() => { setType(k); setPreviewStage(STAGE_KEYS_BY_TYPE[k][0]); }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 24 }}>
          {/* Left — narrow control rail. Every change here reflects instantly in the preview. */}
          <div style={{ width: 360, flexShrink: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Stage labels (shown to users)</div>
            {stages.map((s) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span className={`pill ${STAGE_CLASS[s]}`} style={{ minWidth: 150, textAlign: "center" }}>{s.replace(/_/g, " ")}</span>
                <input value={f.stageLabels[type][s]} maxLength={60} onChange={(e) => setF({ ...f, stageLabels: { ...f.stageLabels, [type]: { ...f.stageLabels[type], [s]: e.target.value } } })} />
              </div>
            ))}

            <div style={{ fontWeight: 600, fontSize: 13, margin: "16px 0 6px" }}>Form fields (show/hide, rename, require)</div>
            {FIELD_DEFS_BY_TYPE[type].map((fd) => (
              <div key={fd.key} style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={f.fields[type][fd.key]} onChange={(e) => setF({ ...f, fields: { ...f.fields, [type]: { ...f.fields[type], [fd.key]: e.target.checked } } })} />
                  <span style={{ fontSize: 13 }}>{fd.label}</span>
                </label>
                {fd.hasLabel && f.fields[type][fd.key] && (
                  <input style={{ marginTop: 6 }} placeholder="Field label shown to users" value={f.fieldLabels[type][fd.key] || ""} maxLength={40}
                    onChange={(e) => setF({ ...f, fieldLabels: { ...f.fieldLabels, [type]: { ...f.fieldLabels[type], [fd.key]: e.target.value } } })} />
                )}
                {fd.requiredKey && f.fields[type][fd.key] && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <input type="checkbox" style={{ width: "auto" }} checked={!!f.fields[type][fd.requiredKey]} onChange={(e) => setF({ ...f, fields: { ...f.fields, [type]: { ...f.fields[type], [fd.requiredKey!]: e.target.checked } } })} />
                    <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Make required</span>
                  </label>
                )}
              </div>
            ))}

            <div style={{ fontWeight: 600, fontSize: 13, margin: "16px 0 6px" }}>Custom fields — add your own to this screen</div>
            {(f.customFields[type] || []).map((cf: any, i: number) => (
              <div key={i} style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <input style={{ flex: 1 }} placeholder="Field label" value={cf.label} maxLength={40}
                    onChange={(e) => setF({ ...f, customFields: { ...f.customFields, [type]: f.customFields[type].map((x: any, xi: number) => xi === i ? { ...x, label: e.target.value } : x) } })} />
                  <button type="button" className="ghost" style={{ color: "var(--bad, #e5484d)" }}
                    onClick={() => setF({ ...f, customFields: { ...f.customFields, [type]: f.customFields[type].filter((_: any, xi: number) => xi !== i) } })}>✕</button>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <select value={cf.fieldType} onChange={(e) => setF({ ...f, customFields: { ...f.customFields, [type]: f.customFields[type].map((x: any, xi: number) => xi === i ? { ...x, fieldType: e.target.value } : x) } })}>
                    <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="textarea">Long text</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted)" }}>
                    <input type="checkbox" style={{ width: "auto" }} checked={!!cf.required} onChange={(e) => setF({ ...f, customFields: { ...f.customFields, [type]: f.customFields[type].map((x: any, xi: number) => xi === i ? { ...x, required: e.target.checked } : x) } })} /> Required
                  </label>
                </div>
              </div>
            ))}
            <GhostButton onClick={() => setF({ ...f, customFields: { ...f.customFields, [type]: [...(f.customFields[type] || []), { key: `cf_${Date.now().toString(36)}`, label: "New Field", fieldType: "text", required: false }] } })}>+ Add Custom Field</GhostButton>

            <div style={{ fontWeight: 600, fontSize: 13, margin: "16px 0 6px" }}>Permissions</div>
            {PERMISSION_DEFS_BY_TYPE[type].map((p) => (
              <label key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={f.permissions[type][p.key]} onChange={(e) => setF({ ...f, permissions: { ...f.permissions, [type]: { ...f.permissions[type], [p.key]: e.target.checked } } })} />
                <span style={{ fontSize: 13 }}>{p.label}</span>
              </label>
            ))}
          </div>

          {/* Right — dominant, full real-page live preview. Pure client-side, reflects the
              unsaved draft instantly as anything on the left is added, edited or removed. */}
          <div style={{ flex: 1, minWidth: 0, position: "sticky", top: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>🔍 Live Preview</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {PREVIEW_ROLES.map((r) => <button key={r} type="button" className={`chip-btn ${previewRole === r ? "on" : ""}`} onClick={() => setPreviewRole(r)}>{r}</button>)}
                <select value={previewStage} onChange={(e) => setPreviewStage(e.target.value)}>
                  {stages.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                </select>
              </div>
            </div>
            <div className="panel" style={{ background: "var(--panel2)", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{REQUEST_TYPES.find(([k]) => k === type)?.[1]} request</span>
                <span className={`pill ${STAGE_CLASS[previewStage]}`}>{f.stageLabels[type][previewStage]}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Viewing as <b>{previewRole}</b></div>
              {actions.length === 0
                ? <div style={{ fontSize: 12, color: "var(--muted)" }}>No actions available to this role at this stage.</div>
                : <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{actions.map((a) => <span key={a} className="pill accent" style={{ cursor: "default" }}>{a}</span>)}</div>}
            </div>
            <BrowserFrame url={URL_BY_TYPE[type]}>
              <FormPreview type={type} fields={f.fields[type]} fieldLabels={f.fieldLabels[type]} customFields={f.customFields[type] || []} categories={liveCategories} assetTypes={liveAssetTypes} />
            </BrowserFrame>
          </div>
        </div>
      </Panel>

      <div><AddButton onClick={save}>Save Settings</AddButton></div>
    </div>
  );
}

// Deep-linked from IT Admin Dashboard — every filter dimension here (status, SLA, priority,
// approval) is seedable from the URL so a dashboard card/chart click opens this EXACT filtered
// view, not just the Ticket Queue homepage (?status=, ?active=1, ?sla=overdue, ?priority=,
// ?approvalStatus=PENDING). The dropdown/chip controls themselves reflect whatever came in via
// the URL, not just the underlying data — so it's visibly, not just silently, filtered.
function ConsoleQueue() {
  const [params] = useSearchParams();
  const urlStatus = params.get("status");
  const urlActive = params.get("active") === "1";
  const [status, setStatus] = useState(urlStatus || (urlActive || !params.toString() ? "ACTIVE" : ""));
  const [type, setType] = useState(params.get("type") || "");
  const [priority, setPriority] = useState(params.get("priority") || "");
  const [slaOverdueOnly, setSlaOverdueOnly] = useState(params.get("sla") === "overdue");
  const [approvalStatus, setApprovalStatus] = useState(params.get("approvalStatus") || "");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const qs = `${status === "ACTIVE" ? "active=1" : status ? `status=${status}` : ""}${type ? `&type=${type}` : ""}${approvalStatus ? `&approvalStatus=${approvalStatus}` : ""}`;
  const { data, reload } = useFetch<any[]>(`/helpdesk/admin/tickets?${qs}`, [qs]);
  const { data: summary, reload: reloadSummary } = useFetch<any>("/helpdesk/admin/summary");
  useEffect(() => { const cleanup = watchRoom("helpdesk:activity", "helpdesk:activity", () => { reload(); reloadSummary(); }); return () => cleanup(); }, []);
  const count = (st: string[]) => (summary?.tickets || []).filter((r: any) => st.includes(r.status)).reduce((a: number, r: any) => a + r.count, 0);
  const rows = (data || [])
    .filter((t) => !q || `${t.ticketNo} ${t.subject} ${t.requester?.name || ""}`.toLowerCase().includes(q.toLowerCase()))
    .filter((t) => !priority || t.priority === priority)
    .filter((t) => !slaOverdueOnly || t.overdue);
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
        <div className="kpi"><div className="label">Open</div><div className="value">{count(["OPEN"])}</div></div>
        <div className="kpi"><div className="label">In Progress / On Hold</div><div className="value">{count(["IN_PROGRESS", "ON_HOLD"])}</div></div>
        <div className="kpi"><div className="label">Awaiting Manager</div><div className="value">{count(["PENDING_MANAGER"])}</div></div>
        <div className="kpi"><div className="label">Resolved</div><div className="value">{count(["RESOLVED", "CLOSED"])}</div></div>
      </div>
      <Panel>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="ACTIVE">Active (open / in progress / on hold)</option><option value="">All statuses</option>
            {["PENDING_MANAGER", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">All types</option><option value="INCIDENT">Incidents</option><option value="ASSET_REQUEST">Asset requests</option><option value="ELEVATED_ACCESS">Elevated access</option>
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ maxWidth: 160 }}>
            <option value="">All priorities</option>{PRIORITIES.map((p) => <option key={p} value={p}>{cap(p)}</option>)}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={slaOverdueOnly} onChange={(e) => setSlaOverdueOnly(e.target.checked)} /> SLA Overdue only
          </label>
          {approvalStatus && (
            <span className="pill warn" style={{ cursor: "pointer" }} title="Clear filter" onClick={() => setApprovalStatus("")}>
              Pending Approval only ✕
            </span>
          )}
          <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240, marginLeft: "auto" }} />
        </div>
        <table><thead><tr><th>Ticket</th><th>Subject</th><th>Requester</th><th>Category</th><th>Priority</th><th>Assigned</th><th>Raised</th><th>SLA</th><th>Status</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} style={{ color: "var(--muted)" }}>Queue is empty.</td></tr>}
            {rows.map((t) => (
              <tr key={t.id} style={{ cursor: "pointer", fontWeight: t.unreadCount ? 700 : undefined }} onClick={() => setOpen(t.id)}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{t.ticketNo}{!!t.unreadCount && <span className="pill accent" style={{ marginLeft: 6 }} title={`${t.unreadCount} unread`}>{t.unreadCount}</span>}</td><td>{t.subject}</td><td>{t.requester?.name}</td><td>{t.category}</td>
                <td><span className={`pill ${t.priority === "CRITICAL" || t.priority === "HIGH" ? "bad" : t.priority === "MEDIUM" ? "warn" : ""}`}>{cap(t.priority)}</span></td>
                <td>{t.assignedTo?.name || "—"}</td><td style={{ whiteSpace: "nowrap" }}>{dstr(t.createdAt)}</td>
                <td>{t.dueAt ? (t.overdue ? <span className="pill bad">Overdue</span> : <span style={{ fontSize: 11, color: "var(--muted)" }}>Due {dtstr(t.dueAt)}</span>) : "—"}</td>
                <td><StatusPill t={t} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {open && <TicketDetail id={open} console onClose={() => setOpen(null)} onChanged={() => { reload(); reloadSummary(); }} />}
    </div>
  );
}

function AssignAssetModal({ ticket, asset, onClose, onDone }: { ticket?: any; asset?: any; onClose: () => void; onDone: () => void }) {
  const { show } = useToast();
  const { data: assets } = useFetch<any[]>(asset ? "/helpdesk/meta" : "/helpdesk/admin/assets");
  const { data: emps } = useFetch<any[]>("/helpdesk/admin/employees");
  const [assetId, setAssetId] = useState<string>(asset ? String(asset.id) : "");
  const [employeeId, setEmployeeId] = useState<string>(ticket?.employeeId ? String(ticket.employeeId) : "");
  const wantType = ticket?.details?.assetType;
  const inStock = (Array.isArray(assets) ? assets : []).filter((a: any) => a.status === "IN_STOCK").sort((a: any, b: any) => (b.category === wantType ? 1 : 0) - (a.category === wantType ? 1 : 0));
  const save = async () => {
    if (!assetId || !employeeId) return show("Pick an asset and an employee", "error");
    try { await api.post(`/helpdesk/admin/assets/${assetId}/assign`, { employeeId, ticketId: ticket?.id }); show(ticket ? "Asset assigned — request resolved" : "Asset assigned"); onDone(); }
    catch (e: any) { show(e.message, "error"); }
  };
  return (
    <Modal title={asset ? `Assign ${asset.assetTag}` : `Assign an asset for ${ticket?.ticketNo}`} open onClose={onClose} onSave={save} saveLabel="Assign">
      {!asset && (
        <div><label>Asset (in stock){wantType ? ` — requested: ${wantType}` : ""}</label>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}><option value="">— select —</option>
            {inStock.map((a: any) => <option key={a.id} value={a.id}>{a.assetTag} · {a.name} ({a.category}){a.serialNo ? ` · SN ${a.serialNo}` : ""}</option>)}
          </select>
          {inStock.length === 0 && <div className="note">No in-stock assets. Add one under Asset Inventory first.</div>}
        </div>
      )}
      <div><label>Employee</label>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={!!ticket?.employeeId}><option value="">— select —</option>
          {(emps || []).map((e: any) => <option key={e.id} value={e.id}>{e.name}{e.empNo ? ` (${e.empNo})` : ""}</option>)}
        </select>
      </div>
    </Modal>
  );
}

// Read-only — the full assign→return lifecycle for one asset (every previous employee, who
// assigned/returned each cycle, and why). Nothing here is ever editable; it's a permanent record.
function AssetHistoryModal({ asset, onClose }: { asset: any; onClose: () => void }) {
  const { data: rows } = useFetch<any[]>(`/helpdesk/admin/assets/${asset.id}/history`);
  const empLabel = (e: any) => (e ? `${e.name}${e.empNo ? ` (${e.empNo})` : ""}` : "—");
  return (
    <Modal title={`Assignment History — ${asset.assetTag}`} open onClose={onClose}>
      {!rows?.length && <div className="note">No assignment history yet for this asset.</div>}
      {!!rows?.length && (
        <table><thead><tr><th>Employee</th><th>Assigned</th><th>Returned</th><th>Return Remark</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td>{empLabel(r.employee)}</td>
                <td>{fmtDate(r.assignedAt)}{r.assignedByName ? <div style={{ fontSize: 11, color: "var(--muted)" }}>by {r.assignedByName}</div> : null}</td>
                <td>{r.returnedAt ? <>{fmtDate(r.returnedAt)}{r.returnedByName ? <div style={{ fontSize: 11, color: "var(--muted)" }}>by {r.returnedByName}</div> : null}</> : <span className="pill accent">Currently assigned</span>}</td>
                <td style={{ maxWidth: 240, whiteSpace: "pre-wrap" }}>{r.returnRemark || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

const ASSET_STATUS_COLOR: Record<string, string> = { ASSIGNED: "#3ecf8e", IN_STOCK: "#6ea8ff", IN_REPAIR: "#fbbf24", MISSING: "#e5484d", RETIRED: "#94a3b8" };
const ASSET_STATUS_SHORT: Record<string, string> = { ASSIGNED: "issued", IN_STOCK: "stock", IN_REPAIR: "repair", MISSING: "missing", RETIRED: "retired" };
// One compact row, not a KPI grid — a small stacked-bar "chip" per asset type (issued/stock/repair/
// missing proportions at a glance) so the whole inventory's composition reads in a single glance
// without pushing the actual table down the page.
function AssetMetricsStrip({ assets }: { assets: any[] }) {
  const cats = Array.from(new Set(assets.map((a) => a.category))).sort((a, b) => ASSET_TYPES.indexOf(a) - ASSET_TYPES.indexOf(b));
  if (!cats.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      {cats.map((c) => {
        const items = assets.filter((a) => a.category === c);
        const total = items.length;
        const byStatus = ASSET_STATUSES.map((s) => [s, items.filter((a) => a.status === s).length] as const).filter(([, n]) => n > 0);
        return (
          <div key={c} title={byStatus.map(([s, n]) => `${n} ${ASSET_STATUS_SHORT[s] || s}`).join(" · ")}
            style={{ display: "flex", flexDirection: "column", gap: 3, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", background: "var(--panel2)", minWidth: 116 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
              <span>{TYPE_ICON[c] || "📦"}</span><span>{c}</span><span style={{ marginLeft: "auto", color: "var(--muted)", fontWeight: 400 }}>{total}</span>
            </div>
            <div style={{ display: "flex", height: 5, borderRadius: 3, overflow: "hidden", background: "var(--border)" }}>
              {byStatus.map(([s, n]) => <div key={s} style={{ width: `${(n / total) * 100}%`, background: ASSET_STATUS_COLOR[s] || "#94a3b8" }} />)}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {byStatus.map(([s, n]) => `${n} ${ASSET_STATUS_SHORT[s] || s}`).join(" · ")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConsoleAssets() {
  const { show } = useToast();
  const { data, reload } = useFetch<any[]>("/helpdesk/admin/assets");
  // Type/Category options come from the real Asset Catalog (Helpdesk Settings → Asset Types), same
  // source AssignAssetsSection already uses — so a newly added catalog type shows up here too,
  // without a code change, instead of a hard-coded list that drifts from what the catalog actually has.
  const { data: meta } = useFetch<any>("/helpdesk/meta");
  const catalogCategories: string[] = meta?.assetTypes || [];
  // Live — an asset assigned/returned from ANY other screen (IT Admin's own "Assign Assets" on a
  // Pending/Completed task, an employee's Request Asset, another Asset Inventory tab) pings this
  // same "helpdesk:activity" room every other IT Admin/Helpdesk console page already watches — this
  // page just wasn't listening yet, so it sat stale until a manual refresh.
  useEffect(() => { const cleanup = watchRoom("helpdesk:activity", "helpdesk:activity", () => reload()); return () => cleanup(); }, []);
  const [form, setForm] = useState<any>(null);
  const [assign, setAssign] = useState<any>(null);
  const [q, setQ] = useState("");
  const [st, setSt] = useState("");
  const [cat, setCat] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; updated: number; warnings: { row: number; assetTag: string; message: string }[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blank = { assetTag: "", name: "", category: "Laptop", make: "", model: "", serialNo: "", purchaseDate: "", warrantyTill: "", notes: "", status: "IN_STOCK" };
  const save = async () => {
    setBusy(true);
    try {
      if (form.id) await api.put(`/helpdesk/admin/assets/${form.id}`, form); else await api.post("/helpdesk/admin/assets", form);
      show("Asset saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const empLabel = (e: any) => (e ? `${e.name}${e.empNo ? ` (${e.empNo})` : ""}` : "—");
  const [historyAsset, setHistoryAsset] = useState<any>(null);
  // Return Remark is mandatory — the prompt dialog itself doubles as the confirmation step (title
  // + who currently has it), with the remark captured right there before anything is submitted.
  // Re-prompts on a blank remark instead of silently proceeding or silently cancelling.
  const unassign = async (a: any) => {
    let remark: string | boolean | null = null;
    while (true) {
      remark = await confirmDialog({ title: `Return ${a.assetTag} to stock?`, message: `Currently with ${empLabel(a.assignedEmployee)} — a return remark is required.`, prompt: true, placeholder: "Reason for return (e.g. employee exit, upgrade, damaged)" });
      if (remark === null) return; // cancelled
      if (String(remark).trim()) break;
    }
    try { await api.post(`/helpdesk/admin/assets/${a.id}/unassign`, { returnRemark: String(remark).trim() }); show("Returned to stock"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  const rows = (data || []).filter((a) => (!st || a.status === st) && (!cat || a.category === cat) && (!q || `${a.assetTag} ${a.name} ${a.serialNo || ""} ${a.assignedEmployee?.name || ""} ${a.assignedEmployee?.empNo || ""}`.toLowerCase().includes(q.toLowerCase())));
  const d10 = (x: any) => (x ? String(x).slice(0, 10) : "");
  const allSelected = rows.length > 0 && rows.every((a) => selected.has(a.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((a) => a.id)));
  const toggleOne = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const deleteSelected = async () => {
    const ok = await confirmDialog({ title: `Delete ${selected.size} asset${selected.size === 1 ? "" : "s"}?`, danger: true, message: "This permanently removes them from Asset Inventory, including any currently assigned to an employee. This cannot be undone." });
    if (!ok) return;
    setDeleting(true);
    try {
      const r: any = await api.post("/helpdesk/admin/assets/bulk-delete", { ids: Array.from(selected) });
      show(`${r.deleted} asset${r.deleted === 1 ? "" : "s"} deleted`);
      setSelected(new Set()); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setDeleting(false); }
  };
  const doExport = () => {
    // A temporary <a download> click instead of window.open — the export streams with
    // Content-Disposition: attachment already, but opening it in a new tab would leave a blank
    // tab behind; this triggers the save without navigating anywhere.
    const a = document.createElement("a");
    a.href = api.pdfUrl("/helpdesk/admin/assets/export");
    a.download = "";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
  const doImport = async (file: File) => {
    setImporting(true);
    try {
      const fileData = await fileToBase64(file);
      const r: any = await api.post("/helpdesk/admin/assets/import", { fileData });
      const warnCount = r.warnings?.length || 0;
      show(`Import complete — ${r.created} added, ${r.updated} updated${warnCount ? `, ${warnCount} row(s) need attention below` : ""}`, warnCount ? "error" : "success");
      setImportResult({ created: r.created, updated: r.updated, warnings: r.warnings || [] });
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setImporting(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  };

  // Add/Edit Asset — a full-page view (not a modal) so every field is always visible and
  // reachable regardless of screen size, rather than crammed into a fixed-height dialog.
  if (form) {
    return (
      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <GhostButton onClick={() => setForm(null)}>← Back to Asset Inventory</GhostButton>
          <h2 style={{ fontSize: 17, margin: 0 }}>{form.id ? `Edit ${form.assetTag}` : "Add Asset"}</h2>
        </div>
        <div className="form-grid" style={{ maxWidth: 860 }}>
          <div><label>Asset ID / Tag *</label><input value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value })} placeholder="GA-LT-0001" /></div>
          <div><label>Type</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
          <div className="full"><label>Asset Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Dell Latitude 5440" /></div>
          <div><label>Make</label><input value={form.make || ""} onChange={(e) => setForm({ ...form, make: e.target.value })} /></div>
          <div><label>Model</label><input value={form.model || ""} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>
          <div><label>Serial No.</label><input value={form.serialNo || ""} onChange={(e) => setForm({ ...form, serialNo: e.target.value })} /></div>
          {form.id && <div><label>Status</label><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{ASSET_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>}
          <div><label>Purchase Date</label><DateInput value={form.purchaseDate || ""} onChange={(e: any) => setForm({ ...form, purchaseDate: e.target.value })} /></div>
          <div><label>Warranty Till</label><DateInput value={form.warrantyTill || ""} onChange={(e: any) => setForm({ ...form, warrantyTill: e.target.value })} /></div>
          <div className="full"><label>Notes / Missing Remark</label><textarea rows={3} value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          <AddButton onClick={save} disabled={busy || !form.assetTag.trim() || !form.name.trim()}>{busy ? "Saving…" : "Save Asset"}</AddButton>
          <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <AssetMetricsStrip assets={data || []} />
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search tag, name, serial, employee…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <select value={st} onChange={(e) => setSt(e.target.value)} style={{ maxWidth: 180 }}><option value="">All Status</option>{ASSET_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
        <select value={cat} onChange={(e) => setCat(e.target.value)} style={{ maxWidth: 180 }}><option value="">All Types</option>{catalogCategories.map((c) => <option key={c} value={c}>{TYPE_ICON[c] || "📦"} {c}</option>)}</select>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {selected.size > 0 && <GhostButton disabled={deleting} onClick={deleteSelected} style={{ color: "var(--bad)", borderColor: "var(--bad)" }}>{deleting ? "Deleting…" : `Delete Selected (${selected.size})`}</GhostButton>}
          <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); }} />
          <GhostButton disabled={importing} onClick={() => fileInputRef.current?.click()}>{importing ? "Importing…" : "Import"}</GhostButton>
          <GhostButton onClick={doExport}>Export</GhostButton>
          <AddButton onClick={() => setForm(blank)}>Add Asset</AddButton>
        </div>
      </div>
      {importResult && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, background: "var(--panel2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13 }}>Import complete — <strong>{importResult.created}</strong> added, <strong>{importResult.updated}</strong> updated{importResult.warnings.length ? `, ${importResult.warnings.length} row(s) need correction` : ""}.</div>
            <GhostButton onClick={() => setImportResult(null)}>Dismiss</GhostButton>
          </div>
          {importResult.warnings.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Every row here failed to resolve to an EXISTING employee unambiguously — the
                  import never creates a new employee or guesses between two possible matches, it
                  always leaves these unassigned and surfaces them here for HR to fix by hand
                  (correct the sheet and re-import, or use Assign directly on the asset row). */}
              {importResult.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 12.5, color: "var(--bad)", border: "1px solid var(--bad)", borderRadius: 6, padding: "6px 10px", background: "rgba(239,68,68,.08)" }}>
                  <strong>Row {w.row}{w.assetTag ? ` — ${w.assetTag}` : ""}:</strong> {w.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table><thead><tr>
          <th style={{ width: 28 }}><input type="checkbox" style={{ width: "auto" }} checked={allSelected} onChange={toggleAll} title="Select all" /></th>
          <th>Asset ID</th><th>Asset Name</th><th>Type</th><th>Make / Model</th><th>Serial</th><th>Status</th><th>Assigned To</th><th></th>
        </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} style={{ color: "var(--muted)" }}>No assets yet.</td></tr>}
            {rows.map((a) => (
              <tr key={a.id}>
                <td><input type="checkbox" style={{ width: "auto" }} checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} /></td>
                <td style={{ fontWeight: 600 }}>{a.assetTag}</td><td>{a.name}</td><td>{TYPE_ICON[a.category] || "📦"} {a.category}</td><td>{[a.make, a.model].filter(Boolean).join(" ") || "—"}</td><td>{a.serialNo || "—"}</td>
                <td><span className={`pill ${ASSET_STATUS_PILL[a.status] || ""}`}>{a.status.replace("_", " ")}</span></td>
                <td>{a.assignedEmployee ? <>{empLabel(a.assignedEmployee)}<div style={{ fontSize: 11, color: "var(--muted)" }}>since {dstr(a.assignedAt)}</div></> : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <EditAction onClick={() => setForm({ ...blank, ...a, purchaseDate: d10(a.purchaseDate), warrantyTill: d10(a.warrantyTill) })} />
                  <GhostButton onClick={() => setHistoryAsset(a)}>History</GhostButton>
                  {a.status === "IN_STOCK" && <GhostButton onClick={() => setAssign(a)}>Assign</GhostButton>}
                  {a.status === "ASSIGNED" && <GhostButton onClick={() => unassign(a)}>Return</GhostButton>}
                  <DeleteAction onClick={async () => { if (!(await confirmDialog({ title: `Delete ${a.assetTag}?`, danger: true, message: a.assignedEmployee ? `Currently assigned to ${empLabel(a.assignedEmployee)}.` : undefined }))) return; try { await api.del(`/helpdesk/admin/assets/${a.id}`); show("Asset deleted"); reload(); } catch (e: any) { show(e.message, "error"); } }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {assign && <AssignAssetModal asset={assign} onClose={() => setAssign(null)} onDone={() => { setAssign(null); reload(); }} />}
      {historyAsset && <AssetHistoryModal asset={historyAsset} onClose={() => setHistoryAsset(null)} />}
    </Panel>
  );
}

function ConsoleCatalog() {
  const { show } = useToast();
  const { data, reload } = useFetch<any[]>("/helpdesk/admin/catalog");
  const [form, setForm] = useState<any>(null);
  const save = async () => {
    try { if (form.id) await api.put(`/helpdesk/admin/catalog/${form.id}`, form); else await api.post("/helpdesk/admin/catalog", form); show("Saved"); setForm(null); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  return (
    <Panel>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}><AddButton onClick={() => setForm({ name: "", category: "Laptop", description: "", icon: "", requiresApproval: true, active: true, order: 0 })}>Add Catalog Item</AddButton></div>
      <table><thead><tr><th></th><th>Name</th><th>Type</th><th>Description</th><th>Visible</th><th></th></tr></thead>
        <tbody>{(data || []).map((i) => (
          <tr key={i.id}><td style={{ fontSize: 20 }}>{i.icon || TYPE_ICON[i.category]}</td><td>{i.name}</td><td>{i.category}</td><td style={{ color: "var(--muted)" }}>{i.description}</td>
            <td>{i.active ? <span className="pill good">Yes</span> : <span className="pill">Hidden</span>}</td><td><EditAction onClick={() => setForm(i)} /></td></tr>
        ))}</tbody>
      </table>
      {form && (
        <Modal title={form.id ? "Edit Catalog Item" : "Add Catalog Item"} open onClose={() => setForm(null)} onSave={save}>
          <div className="form-grid">
            <div className="full"><label>Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>Type</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
            <div><label>Icon (emoji)</label><input value={form.icon || ""} onChange={(e) => setForm({ ...form, icon: e.target.value })} /></div>
            <div className="full"><label>Description</label><textarea rows={2} value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><label>Sort Order</label><input type="number" value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })} /></div>
            <div><label>Visible to employees</label><select value={form.active ? "1" : "0"} onChange={(e) => setForm({ ...form, active: e.target.value === "1" })}><option value="1">Yes</option><option value="0">No (hidden)</option></select></div>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

function ConsoleKb() {
  const { show } = useToast();
  const { data, reload } = useFetch<any[]>("/helpdesk/admin/kb");
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { ...form };
      if (form.file) { if (form.file.size > 10 * 1024 * 1024) throw new Error("Document must be 10 MB or smaller"); body.fileName = form.file.name; body.fileData = await fileToBase64(form.file); }
      delete body.file;
      if (form.id) await api.put(`/helpdesk/admin/kb/${form.id}`, body); else await api.post("/helpdesk/admin/kb", body);
      show("Document saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (a: any) => { if (!(await confirmDialog({ title: `Delete "${a.title}"?`, danger: true }))) return; try { await api.del(`/helpdesk/admin/kb/${a.id}`); show("Deleted"); reload(); } catch (e: any) { show(e.message, "error"); } };
  return (
    <Panel>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}><AddButton onClick={() => setForm({ title: "", category: "General", summary: "", tags: "", body: "", published: true, file: null })}>Upload Document</AddButton></div>
      <table><thead><tr><th>Title</th><th>Category</th><th>File</th><th className="num">Views</th><th>Published</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>{(data || []).map((a) => (
          <tr key={a.id}><td>{KB_ICON[a.category]} {a.title}</td><td>{a.category}</td>
            <td>{a.fileName ? <a href={api.pdfUrl(`/helpdesk/kb/${a.id}/file`)} target="_blank" rel="noreferrer">{a.fileName}</a> : <span style={{ color: "var(--muted)" }}>text article</span>} <span style={{ color: "var(--muted)", fontSize: 11 }}>{kb(a.fileSize)}</span></td>
            <td className="num">{a.views}</td><td>{a.published ? <span className="pill good">Yes</span> : <span className="pill">Draft</span>}</td><td>{dstr(a.createdAt)}</td>
            <td style={{ whiteSpace: "nowrap" }}><EditAction onClick={() => setForm({ ...a, file: null })} /><DeleteAction onClick={() => del(a)} /></td></tr>
        ))}</tbody>
      </table>
      {form && (
        <Modal title={form.id ? "Edit Document" : "Upload Document"} open onClose={() => setForm(null)} onSave={save} busy={busy}>
          <div className="form-grid">
            <div className="full"><label>Title *</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div><label>Category</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{KB_CATS.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div><label>Published</label><select value={form.published ? "1" : "0"} onChange={(e) => setForm({ ...form, published: e.target.value === "1" })}><option value="1">Yes — visible to employees</option><option value="0">Draft</option></select></div>
            <div className="full"><label>Document (PDF / DOCX / etc., max 10 MB){form.fileName ? ` — current: ${form.fileName}` : ""}</label><input type="file" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] || null })} /></div>
            <div className="full"><label>Short summary</label><input value={form.summary || ""} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></div>
            <div className="full"><label>Tags (comma-separated, used by search)</label><input value={form.tags || ""} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></div>
            <div className="full"><label>Article text (optional — used when there's no file)</label><textarea rows={4} value={form.body || ""} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
