import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { DateInput } from "./dateInput";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import LockOpenOutlinedIcon from "@mui/icons-material/LockOpenOutlined";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import PictureAsPdfRoundedIcon from "@mui/icons-material/PictureAsPdfRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";

// ---------------- Reusable MUI action controls (used app-wide) ----------------
export {
  EditOutlinedIcon, DeleteOutlineIcon, AddRoundedIcon, ContentCopyRoundedIcon,
  LockOutlinedIcon, LockOpenOutlinedIcon, DownloadRoundedIcon, CheckCircleRoundedIcon,
  VisibilityOutlinedIcon, PictureAsPdfRoundedIcon,
};

/** Small round icon action with a tooltip — replaces text "Edit"/"Delete"/etc. buttons. */
export function IconAction({ title, onClick, icon, color, disabled }: {
  title: string; onClick?: () => void; icon: React.ReactNode; color?: string; disabled?: boolean;
}) {
  return (
    <Tooltip title={title} arrow>
      <span>
        <IconButton size="small" onClick={onClick} disabled={disabled} sx={{ color: color || "var(--muted)", "&:hover": { color: color || "var(--accent)", background: "rgba(127,127,127,.12)" } }}>
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}
export const EditAction = (p: { onClick?: () => void; disabled?: boolean; title?: string }) =>
  <IconAction title={p.title || "Edit"} color="var(--accent)" icon={<EditOutlinedIcon fontSize="small" />} {...p} />;
export const DeleteAction = (p: { onClick?: () => void; disabled?: boolean; title?: string }) =>
  <IconAction title={p.title || "Delete"} color="#f87171" icon={<DeleteOutlineIcon fontSize="small" />} {...p} />;

/** Primary "Add / New" button with a leading icon. */
export function AddButton({ children, onClick, icon, ...p }: any) {
  return (
    <Button variant="contained" size="small" disableElevation onClick={onClick}
      startIcon={icon || <AddRoundedIcon />}
      sx={{ textTransform: "none", fontWeight: 600, borderRadius: "8px", minHeight: 36, px: 1.75, py: 0.6, boxShadow: "none", background: "var(--btn)", color: "var(--btn-fg)", "&:hover": { background: "var(--btn)", filter: "brightness(1.12)" } }} {...p}>
      {children}
    </Button>
  );
}
/** Secondary/ghost MUI button (outlined). */
export function GhostButton({ children, onClick, icon, ...p }: any) {
  return (
    <Button variant="outlined" size="small" onClick={onClick} startIcon={icon}
      sx={{ textTransform: "none", fontWeight: 600, borderRadius: "8px", minHeight: 36, px: 1.75, py: 0.6, color: "var(--text)", borderColor: "var(--border)", "&:hover": { borderColor: "var(--accent)", background: "rgba(127,127,127,.08)" } }} {...p}>
      {children}
    </Button>
  );
}

// ---------------- Confirm / prompt dialog (MUI, replaces native confirm/prompt) ----------------
export type ConfirmOpts = { title?: string; message?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; prompt?: boolean; defaultValue?: string; placeholder?: string };
let _confirmImpl: ((o: ConfirmOpts) => Promise<string | boolean | null>) | null = null;
/** Imperative confirm/prompt — await it anywhere. Returns boolean (confirm) or string|null (prompt). */
export function confirmDialog(o: ConfirmOpts): Promise<string | boolean | null> {
  if (_confirmImpl) return _confirmImpl(o);
  return Promise.resolve(o.prompt ? window.prompt(String(o.message || o.title || "")) : window.confirm(String(o.message || o.title || "")));
}
export const useConfirm = () => confirmDialog;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ o: ConfirmOpts; resolve: (v: any) => void } | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    _confirmImpl = (o) => new Promise((resolve) => { setText(o.defaultValue || ""); setState({ o, resolve }); });
    return () => { _confirmImpl = null; };
  }, []);
  const o = state?.o;
  const done = (v: any) => { state?.resolve(v); setState(null); };
  const cancelVal = o?.prompt ? null : false;
  return (
    <>
      {children}
      <Dialog open={!!state} onClose={() => done(cancelVal)} slotProps={{ paper: { sx: { bgcolor: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 2, minWidth: 400 } } }}>
        <DialogTitle sx={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 1 }}>
          {o?.danger && <WarningAmberRoundedIcon sx={{ color: "#e5484d" }} />} {o?.title || "Are you sure?"}
        </DialogTitle>
        <DialogContent>
          {o?.message && <div style={{ color: "var(--muted)", fontSize: 14 }}>{o.message}</div>}
          {o?.prompt && (
            <TextField autoFocus fullWidth size="small" value={text} onChange={(e) => setText(e.target.value)} placeholder={o.placeholder}
              onKeyDown={(e) => { if (e.key === "Enter") done(text || ""); }}
              sx={{ mt: 1.5, "& .MuiOutlinedInput-root": { color: "var(--text)" }, "& fieldset": { borderColor: "var(--border)" } }} />
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <GhostButton onClick={() => done(cancelVal)}>{o?.cancelLabel || "Cancel"}</GhostButton>
          <Button variant="contained" disableElevation onClick={() => done(o?.prompt ? (text || "") : true)}
            sx={{ textTransform: "none", fontWeight: 600, borderRadius: 2, background: o?.danger ? "#C4161C" : "var(--btn)", color: "#fff", "&:hover": { background: o?.danger ? "#9E1216" : "var(--btn)", filter: "brightness(1.1)" } }}>
            {o?.confirmLabel || "Confirm"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ---------------- Timesheet day-by-day detail table (shared) ----------------
const TS_CAL = ["Jan","Feb","Mar","Apr","May","June","July","Aug","Sep","Oct","Nov","Dec"];
const TS_WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
// `selectable` turns on a granular-reject mode (PM/Finance picking specific day/head rows to
// flag, each with its own comment) — every other existing caller omits it and gets back exactly
// today's plain read-only table. Rows are keyed by `${day}:${head||""}` since a day can have
// several entries (one per "Time Logged On" head). Already-`rejected` rows (from a PRIOR
// granular reject) render with a red background + their stored `rejectionComment`, regardless of
// `selectable`, so the employee's own expanded view also shows what was flagged.
export function TimesheetEntriesTable({
  periodMonth, periodYear, entries, selectable, selected, onToggle, comments, onCommentChange,
}: {
  periodMonth: number; periodYear: number; entries: any[]; selectable?: boolean;
  selected?: Set<string>; onToggle?: (key: string) => void;
  comments?: Record<string, string>; onCommentChange?: (key: string, value: string) => void;
}) {
  const rows = [...(entries || [])].sort((a, b) => a.day - b.day);
  const totalH = rows.reduce((s, e) => s + (e.leave ? 0 : +e.hours || 0), 0);
  const billableH = rows.reduce((s, e) => s + (e.leave || e.billable === false ? 0 : +e.hours || 0), 0);
  const nonBillableH = totalH - billableH;
  const leaves = rows.filter((e) => e.leave).length;
  if (!rows.length) return <div style={{ color: "var(--muted)", fontSize: 13 }}>No day entries recorded.</div>;
  return (
    <table>
      <thead><tr>{selectable && <th></th>}<th>Date</th><th>Day</th><th className="num">Hours</th><th>Type</th><th>Billable</th><th>Task</th><th>Comment</th>{selectable && <th>Rejection Comment</th>}</tr></thead>
      <tbody>
        {(() => {
          // Multiple tasks on the same day share one Date/Day cell (rowSpan), instead of
          // repeating the date on every task row — rows are already sorted by day above, so
          // same-day rows are always contiguous and the "first row of this day" check below is
          // enough to decide where the merged cell starts.
          const dayCounts = new Map<number, number>();
          rows.forEach((e) => dayCounts.set(e.day, (dayCounts.get(e.day) || 0) + 1));
          const seenDays = new Set<number>();
          return rows.map((e) => {
            const wd = TS_WD[new Date(periodYear, periodMonth - 1, e.day).getDay()];
            const weekend = wd === "Sun" || wd === "Sat";
            const key = `${e.day}:${e.head || ""}`;
            const isChecked = !!selected?.has(key);
            const isFirstOfDay = !seenDays.has(e.day);
            seenDays.add(e.day);
            const span = dayCounts.get(e.day) || 1;
            return (
              <tr key={key} style={e.rejected ? { background: "rgba(229,72,77,.12)" } : undefined}>
                {selectable && <td><input type="checkbox" checked={isChecked} onChange={() => onToggle?.(key)} /></td>}
                {isFirstOfDay && <td rowSpan={span}>{TS_CAL[periodMonth - 1]} {e.day}, {periodYear}</td>}
                {isFirstOfDay && <td rowSpan={span} style={{ color: weekend ? "var(--accent)" : undefined }}>{wd}</td>}
                <td className="num">{e.leave ? "—" : e.hours}</td>
                <td>{e.leave ? <span style={{ color: "#e5484d", fontWeight: 600 }}>Leave</span> : <span style={{ color: "#16a34a", fontWeight: 600 }}>Worked</span>}</td>
                <td>{e.leave ? "—" : e.billable === false ? <span style={{ color: "#f59e0b", fontWeight: 600 }}>Non-Billable</span> : <span style={{ color: "#6ea8ff", fontWeight: 600 }}>Billable</span>}</td>
                <td>{e.leave ? "—" : (e.head || "—")}</td>
                <td>{e.comment || "—"}{e.rejected && e.rejectionComment && <div style={{ color: "#e5484d", fontSize: 12, marginTop: 2 }}>⚠ {e.rejectionComment}</div>}</td>
                {selectable && (
                  <td>
                    <input value={comments?.[key] || ""} placeholder="Why this day needs fixing…" disabled={!isChecked}
                      onChange={(ev) => onCommentChange?.(key, ev.target.value)} style={{ width: 160 }} />
                  </td>
                )}
              </tr>
            );
          });
        })()}
        <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
          <td colSpan={selectable ? 3 : 2}>Total</td><td className="num">{totalH} h</td>
          <td colSpan={2} style={{ fontSize: 12, fontWeight: 600 }}><span style={{ color: "#6ea8ff" }}>{billableH}h billable</span> / <span style={{ color: "#f59e0b" }}>{nonBillableH}h non-billable</span></td>
          <td colSpan={selectable ? 3 : 2}>{leaves} leave day(s)</td>
        </tr>
      </tbody>
    </table>
  );
}

// ---------------- Modal ----------------
export function Modal({
  title, open, onClose, onSave, saveLabel = "Save", canSave = true, children, busy, wide,
}: {
  title: string; open: boolean; onClose: () => void; onSave?: () => void;
  saveLabel?: string; canSave?: boolean; busy?: boolean; children: React.ReactNode;
  wide?: boolean; // wider dialog for grid-heavy content (e.g. allocation grid)
}) {
  if (!open) return null;
  // Rendered through a portal straight onto <body> — NOT wherever <Modal> happens to be called
  // from in the tree. A `.modal-overlay` left as a normal descendant loses real viewport-fixed
  // positioning the instant it sits inside an ancestor with a CSS transform/filter/perspective —
  // including `backdrop-filter`, which `.panel` uses for its glass effect (see index.css). A modal
  // opened from deep inside a <Panel> (e.g. Assign Assets, invoked from a card in a mapped list
  // inside "Recently Completed") was being fixed-positioned relative to that PANEL's own box
  // instead of the screen — appearing wherever the panel happened to sit on the page (often well
  // below the fold, "centered" on a box that itself was mostly off-screen) instead of centered on
  // the actual viewport. Portaling to `document.body` — outside any such ancestor — fixes every
  // Modal usage in the app at once, not just this one.
  return createPortal(
    // "wide" modals (grid-heavy content like Assign Assets) are vertically centered — a wide modal
    // is usually short enough to fit the viewport, and top-anchoring it (the narrow-modal default,
    // which suits a short form) instead left it sitting close to the top with a large empty gap
    // below, reading as "opens near the top of the page, not as a centered popup".
    <div className={`modal-overlay${wide ? " wide" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={wide ? { maxWidth: "min(1100px, 96vw)", width: "min(1100px, 96vw)" } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <IconButton size="small" className="modal-x" onClick={onClose} sx={{ color: "var(--muted)", "&:hover": { color: "var(--text)" } }}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {onSave && (
          <div className="modal-foot">
            <GhostButton onClick={onClose} icon={<CloseRoundedIcon />}>Cancel</GhostButton>
            <AddButton onClick={onSave} disabled={!canSave || busy} icon={<SaveRoundedIcon />}>{busy ? "Saving…" : saveLabel}</AddButton>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Labeled inputs for use inside a Modal form-grid
export function Input({ label, required, full, ...p }: any) {
  return (
    <div className={full ? "full" : ""}>
      <label>{label} {required && <span className="req">*</span>}</label>
      {p.type === "date" ? <DateInput required={required} {...p} /> : <input {...p} />}
    </div>
  );
}
export function Select({ label, required, full, options, ...p }: any) {
  return (
    <div className={full ? "full" : ""}>
      <label>{label} {required && <span className="req">*</span>}</label>
      <select {...p}>{options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
    </div>
  );
}

// ---------------- Toast ----------------
interface ToastMsg { id: number; text: string; kind: "success" | "error"; }
const ToastCtx = createContext<{ show: (t: string, k?: "success" | "error") => void }>({ show: () => {} });
export const useToast = () => useContext(ToastCtx);

let _id = 1;
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const show = useCallback((text: string, kind: "success" | "error" = "success") => {
    const id = _id++;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
