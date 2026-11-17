import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { watchRoom } from "./realtime";
import { useToast, GhostButton, AddButton } from "./components";
import { fmtDate, fmtDateTime } from "./dateFormat";
import { DateInput } from "./dateInput";

// Module-level mirror of the current person's mask preference — kept in sync by MaskToggle (topbar)
// and useMaskNumbers() below, so the plain formatter functions (called deep inside render bodies,
// not hooks themselves) can check it synchronously without needing the user id threaded through
// every call site.
let maskedActive = true;
// Lets a page's OWN local money formatter (e.g. one that needs "en-IN" lakh/crore grouping fmt()
// itself doesn't do) check the same shared mask state synchronously, without becoming a hook —
// see Masters.tsx/CtcApprovals.tsx/AppraisalApprovals.tsx's own `money`/`ctcMoneyFor` functions,
// which used to skip masking entirely because they had no way to read this module-private flag.
export const isMasked = () => maskedActive;
export const fmt = (n: number, ccy = "USD") => {
  if (maskedActive) return "•••••";
  const sym = ccy === "INR" ? "₹" : ccy === "CAD" ? "C$" : "$";
  return sym + Math.round(n || 0).toLocaleString();
};
export const fmt2 = (n: number) => maskedActive ? "•••••" : (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// numeric value capped to <=2 decimals (drops trailing zeros) — for raw fields/inputs
export const d2 = (n: any) => { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 100) / 100 : n; };
export const fmtK = (n: number) => maskedActive ? "•••" : "$" + Math.round((n || 0) / 1000) + "K";
export const fmtM = (n: number) => maskedActive ? "•••" : "$" + ((n || 0) / 1e6).toFixed(2) + "M";
export const pct = (n: number) => (n || 0).toFixed(1) + "%";
export const marginClass = (m: number) => (m >= 40 ? "margin-good" : m >= 20 ? "margin-warn" : "margin-bad");

// A project's delivery region — ONSITE = US, everything else (OFFSHORE/HYBRID) = India.
export const projectRegion = (p: any): string => (p?.deliveryModel === "ONSITE" ? "US" : "INDIA");
// Canonical project label used everywhere a project is shown: "Name(REGION)" e.g. "LM(INDIA)",
// "LM(US)". Strips any pre-existing region suffix on the stored name so it never doubles up.
// Plain project name with any pre-existing region suffix stripped (no "(US)"/"(INDIA)" appended).
export const projectBaseName = (p: any): string =>
  String(p?.name || "").replace(/\s*\((?:US|India|INDIA|Canada|CANADA|HYBRID|Offshore|Onsite)\)\s*$/i, "").trim();
// Canonical project label shown everywhere — the plain name, with no "(US)"/"(INDIA)" region suffix.
export const projectLabel = (p: any): string => projectBaseName(p);

/** Export an array of rows (objects) to a downloadable CSV file. */
export function downloadCsv(filename: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

export function useFetch<T>(path: string, deps: any[] = []): { data: T | null; loading: boolean; reload: () => void; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // When `path` itself changes (e.g. a conditional path toggling between a real endpoint and a
  // harmless placeholder like "/health"), `data`/`loading` below still belong to the PREVIOUS path
  // for one render — the effect that fetches the new path hasn't run yet. Adjusting state here
  // during render (React's documented "adjust state when a prop changes" pattern) clears the stale
  // data synchronously instead of leaving a render where `loading` reads false but `data` is still
  // the old path's (possibly differently-shaped) response — that exact mismatch crashed Timesheet
  // Approvals' "By Month" toggle with "(x || []).map is not a function" (data briefly held /health's
  // plain object while loading hadn't flipped back to true yet).
  const [prevPath, setPrevPath] = useState(path);
  if (path !== prevPath) {
    setPrevPath(path);
    setData(null);
    setLoading(!!path);
  }
  useEffect(() => {
    // An empty/falsy path means "nothing to fetch yet" (e.g. a child panel that only has real
    // data once its parent entity is saved and gets a real id) — skip the call entirely rather
    // than firing a request at the bare API root.
    if (!path) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    api.get(path).then((d) => alive && setData(d)).catch((e) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [path, tick, ...deps]);
  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

// ONE app-wide "selected fiscal year". Every FY dropdown (dashboards, Monthly Forecast, reconciliations,
// expenses, invoicing…) reads and writes this, so picking FY25-26 on a dashboard makes the other
// screens (clients/projects revenue, forecast, expenses) show that same year instead of each page
// keeping its own separate, hard-coded FY26-27. Persisted in localStorage; in-tab changes broadcast
// through a window event so already-mounted screens follow immediately.
const SELECTED_FY_KEY = "app.fy";
const SELECTED_FY_EVT = "app-fy-change";
const DEFAULT_FY = "FY26-27";
/** Non-hook read of the selected FY (for event handlers / fetch calls that build their own URLs). */
export function getSelectedFy(): string {
  try { return localStorage.getItem(SELECTED_FY_KEY) || DEFAULT_FY; } catch { return DEFAULT_FY; }
}
/** [fy, setFy] — shared across all screens. `initial` (e.g. a ?fy= deep link) wins once and becomes the shared value. */
export function useSelectedFy(initial?: string): [string, (v: string) => void] {
  const [fy, setFyState] = useState<string>(() => initial || getSelectedFy());
  useEffect(() => {
    if (initial) { try { localStorage.setItem(SELECTED_FY_KEY, initial); } catch { /* storage blocked */ } window.dispatchEvent(new Event(SELECTED_FY_EVT)); }
    const sync = () => setFyState(getSelectedFy());
    window.addEventListener(SELECTED_FY_EVT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(SELECTED_FY_EVT, sync); window.removeEventListener("storage", sync); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setFy = (v: string) => {
    try { localStorage.setItem(SELECTED_FY_KEY, v); } catch { /* storage blocked */ }
    setFyState(v);
    window.dispatchEvent(new Event(SELECTED_FY_EVT));
  };
  return [fy, setFy];
}

// Shared list of fiscal-year labels (newest first) for every FY dropdown in the app.
// Sourced from /fiscal-years (self-healing: includes existing & past years that
// have data). Falls back to a sensible default before the fetch resolves.
export function useFiscalYears(): string[] {
  const { data } = useFetch<any[]>("/fiscal-years");
  const labels = (data || []).map((f: any) => f.label).filter(Boolean);
  return labels.length ? labels : ["FY26-27", "FY25-26"];
}

// ---- Dashboard display currency (USD / INR), set in Settings ----
export const getDisplayCcy = () => localStorage.getItem("displayCcy") || "USD";
export function setDisplayCcy(c: string) {
  localStorage.setItem("displayCcy", c);
  window.dispatchEvent(new Event("ccychange"));
}

// ---- "Mask Sensitive Numbers" — one per-person toggle (defaults to masked/hidden) shared across
// every screen showing CTC/financial figures, not a separate remembered state per page. Keyed by
// user id in localStorage so a shared browser profile can't leak one person's unmasked choice to
// whoever logs in next. fmt()/fmt2()/fmtK()/fmtM() below check it directly — any page already
// using those shared formatters (CTC Management, Monthly Forecast & Actuals, Invoice Generated,
// CEO Dashboard, etc.) gets masking for free with no per-page wiring.
const maskKey = (userId?: number | string) => `maskNumbers:${userId ?? "anon"}`;
export const getMaskNumbers = (userId?: number | string) => {
  const v = localStorage.getItem(maskKey(userId));
  return v === null ? true : v === "1"; // default: masked
};
export function setMaskNumbers(masked: boolean, userId?: number | string) {
  localStorage.setItem(maskKey(userId), masked ? "1" : "0");
  maskedActive = masked;
  window.dispatchEvent(new Event("masknumberschange"));
}
const MASK_PLACEHOLDER = "•••••";
// Call once near the app root (with the logged-in user's id) and again wherever a component needs
// to re-render on toggle — keeps `maskedActive` in sync and returns the current boolean for any
// component with its own bespoke number formatting (not going through fmt()/fmtK()/etc.).
export function useMaskNumbers(userId?: number | string): boolean {
  const [masked, setMasked] = useState(() => { maskedActive = getMaskNumbers(userId); return maskedActive; });
  useEffect(() => {
    maskedActive = getMaskNumbers(userId);
    setMasked(maskedActive);
    const h = () => { maskedActive = getMaskNumbers(userId); setMasked(maskedActive); };
    window.addEventListener("masknumberschange", h);
    return () => window.removeEventListener("masknumberschange", h);
  }, [userId]);
  return masked;
}
// Wraps any value/JSX that isn't already covered by fmt()/fmtK()/etc. (e.g. a raw
// `.toLocaleString()` figure) — hides it behind the same placeholder when masking is on.
// Deliberately does NOT take a userId and does NOT call useMaskNumbers(): every call site across
// the app omitted that prop (an easy mistake — nothing here required it), and useMaskNumbers(undefined)
// reads/writes a DIFFERENT localStorage key ("maskNumbers:anon") than the topbar toggle's real
// per-user one, then its own effect writes `maskedActive` back from THAT wrong key on every mount
// and on every "masknumberschange" event — silently stomping the real value straight back to
// masked=true right after the toggle set it to false. Reading the shared `isMasked()` flag directly
// (kept correct by the ONE real useMaskNumbers(user?.id) call in the topbar's MaskToggle) and just
// forcing a re-render on toggle sidesteps the whole per-key mismatch.
export function Masked({ children, placeholder = MASK_PLACEHOLDER }: { children: React.ReactNode; placeholder?: string }) {
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const h = () => forceRerender((n) => n + 1);
    window.addEventListener("masknumberschange", h);
    return () => window.removeEventListener("masknumberschange", h);
  }, []);
  return <>{isMasked() ? placeholder : children}</>;
}

// ---- Global table page size (records per page), set in Settings; default 20 ----
export const getPageSize = () => { const n = parseInt(localStorage.getItem("pageSize") || "", 10); return Number.isFinite(n) && n > 0 ? n : 20; };
export function setPageSize(n: number) {
  localStorage.setItem("pageSize", String(Math.max(1, Math.floor(n) || 20)));
  window.dispatchEvent(new Event("pagesizechange"));
}
/** Reactive page size — re-renders any table when the Settings value changes. */
export function usePageSize() {
  const [n, setN] = useState(getPageSize());
  useEffect(() => {
    const h = () => setN(getPageSize());
    window.addEventListener("pagesizechange", h);
    return () => window.removeEventListener("pagesizechange", h);
  }, []);
  return n;
}
/** Returns a money formatter that converts USD figures to the chosen display currency. */
export function useDisplayCurrency() {
  const [ccy, setCcy] = useState(getDisplayCcy());
  const { data } = useFetch<any[]>("/fx-rates");
  // Forces a re-render on mask toggle too, not just currency change — money() below reads the
  // shared `maskedActive` flag directly, but without this listener a dashboard already mounted
  // when the topbar's Mask toggle flips wouldn't re-render until something else (e.g. ccy change)
  // happened to trigger one.
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const h = () => setCcy(getDisplayCcy());
    const hMask = () => forceRerender((n) => n + 1);
    window.addEventListener("ccychange", h);
    window.addEventListener("masknumberschange", hMask);
    return () => { window.removeEventListener("ccychange", h); window.removeEventListener("masknumberschange", hMask); };
  }, []);
  const rate = (data || []).find((r: any) => r.context === "USD_INR")?.rate || 93;
  // USD → $K / $M ; INR → ₹ Lakh / ₹ Crore
  const abbrUsd = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + Math.round(n).toLocaleString("en-US");
  };
  const abbrInr = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e7) return "₹" + (n / 1e7).toFixed(2) + " Cr";
    if (a >= 1e5) return "₹" + (n / 1e5).toFixed(2) + " L";
    return "₹" + Math.round(n).toLocaleString("en-IN");
  };
  // Checks the SAME shared `maskedActive` flag fmt()/fmtK()/fmtM() read — this formatter used to
  // skip it entirely (it was written before the masking feature existed), so Finance Dashboard's
  // KPI tiles/Monthly Metrics table and the Executive Dashboard (the only two callers of
  // useDisplayCurrency) kept showing Revenue/Salary Expense/Total Cost/Profit in the clear even
  // with "Mask Sensitive Numbers" on.
  const money = (usd: number) => (maskedActive ? "•••••" : ccy === "INR" ? abbrInr((usd || 0) * rate) : abbrUsd(usd || 0));
  const moneyM = money; // alias — money() already abbreviates by magnitude
  return { ccy, rate, money, moneyM };
}

export const Panel: React.FC<{ title?: string; actions?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, actions, children, style }) => (
  <div className="panel" style={style}>
    {actions ? (
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        {title && <h2>{title}</h2>}
        {actions}
      </div>
    ) : (title && <h2>{title}</h2>)}
    {children}
  </div>
);

// Workforce category → color, shared by every "click a Monthly Metrics row to see who's counted
// where" drill-down (Finance Dashboard, HR Dashboard, …) so they always agree. Same order as the
// Monthly Metrics table's columns. `keys` are the rosterByMonth categories unioned to build this
// card's name list; `countKey` is the matching field on the row (`counts`/`r`) used for the
// numeric badge — some cards (Head Count, Billable (TB)) are a union of several raw categories,
// so their badge is the server's own total rather than just `names.length`.
export const WORKFORCE_CATS = [
  { label: "Head Count", keys: ["onsiteBillable", "offshoreBillable", "doubleDip", "assigned", "shadow", "bench"], countKey: "headCount", color: "#8b96b0" },
  { label: "On Project (Non-billable)", keys: ["assigned"], countKey: "nonBillableAssigned", color: "#60a5fa" },
  { label: "Bench", keys: ["bench"], countKey: "bench", color: "#fbbf24" },
  { label: "Corporate", keys: ["shadow"], countKey: "corporate", color: "#f472b6" },
  { label: "Billable (TB)", keys: ["onsiteBillable", "offshoreBillable", "doubleDip"], countKey: "billableHeadCount", color: "#a78bfa" },
  { label: "Double Dip", keys: ["doubleDip"], countKey: "doubleDip", color: "#fb923c" },
  { label: "Offshore Billable", keys: ["offshoreBillable"], countKey: "offshoreBillable", color: "#34d399" },
  { label: "Onsite Billable", keys: ["onsiteBillable"], countKey: "onsiteBillable", color: "#6ea8ff" },
];
// Roster entries arrive as "Name (Project A, Project B)" strings — split into columns for a
// cleaner table instead of one long inline sentence per row.
const splitRosterEntry = (entry: string): { name: string; project: string } => {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(entry);
  return m ? { name: m[1], project: m[2] } : { name: entry, project: "" };
};
// A card's name list can union several raw roster categories (e.g. Head Count, Billable (TB)) —
// dedupe by plain name, first occurrence wins, so a double-dip resource counted twice in the
// NUMBER still shows once in the NAME list.
const unionRosterEntries = (r: any, keys: string[]): string[] => {
  const seen = new Map<string, string>();
  for (const k of keys) for (const n of (r?.[k] || [])) {
    const name = splitRosterEntry(n).name;
    if (!seen.has(name)) seen.set(name, n);
  }
  return [...seen.values()];
};
// A resource name in the Workforce drill-down links straight to their Monthly Forecast line for
// that exact month — ?q= pre-fills the Resources tab's search box (Operations.tsx), so there's no
// need to know the line's id, just the month/FY/name already on screen here.
const ResourceLink = ({ name, fy, month }: { name: string; fy: string; month: string }) => (
  <Link to={`/monthly?fy=${encodeURIComponent(fy)}&month=${encodeURIComponent(month)}&q=${encodeURIComponent(name)}`}
    style={{ color: "inherit", textDecoration: "none" }} title={`Open ${month} ${fy}'s Monthly Forecast, filtered to ${name}`}>
    {name}
  </Link>
);
/** "Workforce — <month> <fy>" drill-down: every category (Onsite/Offshore Billable, Double Dip,
 * Bench, Corporate, On Project) as its own card, each person on their own Name | Project(s) row —
 * same data a plain "Name (Project)" list would show, laid out for much faster scanning. A second
 * view ("What Changed") compares against the previous month's same roster so Finance can verify
 * THIS month's headcount by seeing exactly who was added/removed per category, not just a number
 * that moved. Every name links to that resource's own Monthly Forecast line for the month shown. */
export function WorkforceDrillPopup({ month, fy, roster, prevRoster, prevMonth, counts, onClose }: { month: string; fy: string; roster: any; prevRoster?: any; prevMonth?: string; counts?: any; onClose: () => void }) {
  const [view, setView] = useState<"current" | "changes">("current");
  const hasPrev = !!prevRoster;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,9,18,.7)", backdropFilter: "blur(2px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--modal-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: 20, width: 920, maxWidth: "96vw", maxHeight: "86vh", overflow: "auto", boxShadow: "0 24px 70px rgba(0,0,0,.65)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0 }}>Workforce — {month} {fy}</h2>
            <div className="subtitle" style={{ margin: 0 }}>
              {view === "current" ? "Every person counted this month, grouped by category — click a name to open their Monthly Forecast line" : "Who was added or removed per category vs the previous month"}
            </div>
          </div>
          <button className="ghost" onClick={onClose}>✕ Close</button>
        </div>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button className={view === "current" ? "" : "ghost"} onClick={() => setView("current")}>This Month</button>
          <button className={view === "changes" ? "" : "ghost"} onClick={() => setView("changes")} disabled={!hasPrev} title={hasPrev ? undefined : "No earlier month in this fiscal year to compare against"}>
            What Changed vs Previous Month
          </button>
        </div>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
          {WORKFORCE_CATS.map((c) => {
            const names: string[] = unionRosterEntries(roster, c.keys);
            const prevNames: string[] = unionRosterEntries(prevRoster, c.keys);
            // Head Count / Billable (TB) union several raw categories, so their badge is the
            // server's own total (which can legitimately differ from names.length — e.g. a
            // double-dip resource fills a 2nd Billable slot but is still one name in the list).
            const wcount = counts?.[c.countKey] != null ? counts[c.countKey] : names.length;
            // Compared by plain NAME only (ignoring the project in parentheses) — a resource
            // reassigned to a different project within the SAME category shouldn't read as both an
            // add and a remove.
            const curSet = new Set(names.map((n) => splitRosterEntry(n).name));
            const prevSet = new Set(prevNames.map((n) => splitRosterEntry(n).name));
            const added = names.filter((n) => !prevSet.has(splitRosterEntry(n).name));
            const removed = prevNames.filter((n) => !curSet.has(splitRosterEntry(n).name));
            return (
              <div key={c.label} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", alignSelf: "start" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--panel2)", borderLeft: `4px solid ${c.color}` }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{c.label}</div>
                  {view === "current" ? (
                    <span className="pill" style={{ marginLeft: "auto", fontSize: 11 }}>{wcount}</span>
                  ) : (
                    <span style={{ marginLeft: "auto", fontSize: 11, display: "flex", gap: 6 }}>
                      {!!added.length && <span className="pill" style={{ background: "rgba(52,211,153,.18)", color: "#34d399" }}>+{added.length}</span>}
                      {!!removed.length && <span className="pill" style={{ background: "rgba(248,113,113,.18)", color: "#f87171" }}>−{removed.length}</span>}
                      {!added.length && !removed.length && <span className="pill">no change</span>}
                    </span>
                  )}
                </div>
                {view === "current" ? (
                  names.length === 0 ? (
                    <div style={{ padding: "10px 12px", color: "var(--muted)", fontSize: 12 }}>—</div>
                  ) : (
                    <table style={{ width: "100%" }}><tbody>
                      {names.map((n, i) => {
                        const { name, project } = splitRosterEntry(n);
                        return (
                          <tr key={i} style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                            <td style={{ padding: "6px 6px 6px 12px", fontSize: 12, color: "var(--muted)", width: 1 }}>{i + 1}</td>
                            <td style={{ padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}><ResourceLink name={name} fy={fy} month={month} /></td>
                            <td style={{ padding: "6px 12px", fontSize: 12, color: "var(--muted)" }}>{project}</td>
                          </tr>
                        );
                      })}
                    </tbody></table>
                  )
                ) : (
                  !added.length && !removed.length ? (
                    <div style={{ padding: "10px 12px", color: "var(--muted)", fontSize: 12 }}>No change from the previous month.</div>
                  ) : (
                    <table style={{ width: "100%" }}><tbody>
                      {added.map((n, i) => {
                        const { name, project } = splitRosterEntry(n);
                        return (
                          <tr key={`a${i}`} style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                            <td style={{ padding: "6px 6px 6px 12px", fontSize: 12, color: "#34d399", width: 1 }}>+ Added</td>
                            <td style={{ padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}><ResourceLink name={name} fy={fy} month={month} /></td>
                            <td style={{ padding: "6px 12px", fontSize: 12, color: "var(--muted)" }}>{project}</td>
                          </tr>
                        );
                      })}
                      {removed.map((n, i) => {
                        const { name, project } = splitRosterEntry(n);
                        return (
                          <tr key={`r${i}`} style={{ borderTop: (added.length || i) ? "1px solid var(--border)" : undefined }}>
                            <td style={{ padding: "6px 6px 6px 12px", fontSize: 12, color: "#f87171", width: 1 }}>− Removed</td>
                            <td style={{ padding: "6px 12px", fontSize: 13, whiteSpace: "nowrap" }}>
                              {prevMonth ? <ResourceLink name={name} fy={fy} month={prevMonth} /> : name}
                            </td>
                            <td style={{ padding: "6px 12px", fontSize: 12, color: "var(--muted)" }}>{project} <span style={{ fontStyle: "italic" }}>(last seen here, {prevMonth || "previous month"})</span></td>
                          </tr>
                        );
                      })}
                    </tbody></table>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Monthly Metrics column key -> its roster categories, read straight off WORKFORCE_CATS (single
// source of truth, so the per-cell tooltip and the "Workforce — <month>" drill-down always agree).
const HEADCOUNT_CAT_UNION: Record<string, string[]> = Object.fromEntries(WORKFORCE_CATS.map((c) => [c.countKey, c.keys]));
/** Plain-text hover tooltip for ONE Monthly Metrics cell: explains this month's number by diffing
 * its roster category against the previous month, right on the cell — no click needed. Falls back
 * to a plain value delta for $ / % columns, which have no roster to name names against. */
export function cellChangeTip(key: string, curVal: number, prevVal: number | undefined, roster: any, prevRoster: any, prevMonthLabel: string | null, fmt: (n: number) => string = String): string {
  if (prevVal == null || !prevMonthLabel) return `${fmt(curVal)} this month — first month shown, no earlier month to compare`;
  const cats = HEADCOUNT_CAT_UNION[key];
  if (!cats) {
    const d = curVal - prevVal;
    const sign = d > 0 ? "+" : "";
    return `${fmt(curVal)} this month vs ${fmt(prevVal)} in ${prevMonthLabel} (${sign}${fmt(d)})`;
  }
  const namesOf = (r: any) => new Set(unionRosterEntries(r, cats).map((n) => splitRosterEntry(n).name));
  const curNames = namesOf(roster), prevNames = namesOf(prevRoster);
  const added = [...curNames].filter((n) => !prevNames.has(n));
  const removed = [...prevNames].filter((n) => !curNames.has(n));
  const lines = [`${curVal} this month (${prevMonthLabel}: ${prevVal})`];
  if (added.length) lines.push(`+ Added: ${added.join(", ")}`);
  if (removed.length) lines.push(`− Removed: ${removed.join(", ")}`);
  if (!added.length && !removed.length) lines.push("No change in who's counted here vs last month.");
  return lines.join("\n");
}

/** Multi-project picker: a filterable checklist + removable chips for the selected ones. Shared
 * by anything that assigns one record to several projects at once (billing rate "Used By",
 * timesheet Approvals' project filter, a commission expense's "spread across these projects"). */
export function ProjectMultiSelect({ projects, value, onChange, label = "Used By (projects)" }: {
  projects: any[]; value: number[]; onChange: (ids: number[]) => void; label?: string;
}) {
  const [q, setQ] = useState("");
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  // Closed projects (old per-resource projects superseded by Sub-Projects) drop out of the
  // pickable checklist — but an EXISTING assignment to one stays visible as a removable chip
  // (via `selected`, sourced from the full unfiltered list) so it's never silently hidden/orphaned.
  const pickable = (projects || []).filter((p) => p.status !== "CLOSED" || value.includes(p.id));
  const filtered = pickable.filter((p) => !q.trim() || `${p.name} ${p.client?.name || ""}`.toLowerCase().includes(q.toLowerCase()));
  const selected = (projects || []).filter((p) => value.includes(p.id));
  return (
    <div className="full">
      <label>{label}</label>
      {selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {selected.map((p) => (
            <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 8px", borderRadius: 20, background: "var(--panel2)", border: "1px solid var(--border)", color: "var(--text)" }}>
              {p.name}
              <span onClick={() => toggle(p.id)} style={{ cursor: "pointer", color: "var(--bad)", fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
      )}
      <input placeholder="Filter projects…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      <div style={{ maxHeight: 168, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel2)", padding: 6 }}>
        {filtered.length === 0 ? <div style={{ color: "var(--muted)", fontSize: 13, padding: 6 }}>No projects.</div> :
          filtered.map((p) => (
            <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, cursor: "pointer", margin: 0, color: "var(--text)", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--row-hover)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <input type="checkbox" style={{ width: "auto" }} checked={value.includes(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.name}{p.client?.name ? <span style={{ color: "var(--muted)" }}> · {p.client.name}</span> : null}</span>
            </label>
          ))}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{value.length} project(s) selected</div>
    </div>
  );
}

/** Finance/Executive Dashboard — "What changed in Monthly Forecast & its impact" live feed.
 * Plain CSS bars (not Chart.js — this renders on pages that don't register chart.js elements) for
 * the cumulative $ impact across the fetched changes, plus a per-change table with before/after $
 * amounts. Live via socket.io (`forecast:changes`); hidden entirely when the admin has turned the
 * MONTHLY_FORECAST_IMPACT flow off from Administration → Notification Settings. */
export function ForecastChangesPanel({ fiscalYear }: { fiscalYear: string }) {
  const { data, reload } = useFetch<any>(`/monthly/forecast-changes?fiscalYear=${fiscalYear}&limit=25`, [fiscalYear]);
  useEffect(() => watchRoom("forecast:changes", "forecast:change", reload), []);
  if (!data || !data.enabled) return null;
  const rows: any[] = Array.isArray(data.rows) ? data.rows : [];
  const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
  const sum = (k: string) => rows.reduce((s, r) => s + (r.impact?.[k] || 0), 0);
  const totals = { revenueDelta: sum("revenueDelta"), salaryDelta: sum("salaryDelta"), totalCostDelta: sum("totalCostDelta"), profitDelta: sum("profitDelta") };
  const maxAbs = Math.max(1, ...Object.values(totals).map((v) => Math.abs(v)));
  const bar = (label: string, value: number) => (
    <div key={label}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
        <span>{label}</span><b style={{ color: value >= 0 ? "#34d399" : "#f87171" }}>{value >= 0 ? "+" : ""}{money(value)}</b>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "var(--border)", overflow: "hidden", position: "relative" }}>
        <div style={{ position: "absolute", left: value >= 0 ? "50%" : `${50 - (Math.abs(value) / maxAbs) * 50}%`, width: `${(Math.abs(value) / maxAbs) * 50}%`, height: "100%", background: value >= 0 ? "#34d399" : "#f87171" }} />
      </div>
    </div>
  );
  return (
    <Panel title={`Monthly Forecast — Recent Changes & Impact${rows.length ? ` (last ${rows.length})` : ""}`} style={{ marginTop: 14 }}>
      <div className="subtitle" style={{ margin: "0 0 10px" }}>Net $ impact of every line added/edited/removed in Monthly Forecast this fiscal year — live, updates the instant a change happens anywhere.</div>
      {!rows.length ? <div style={{ color: "var(--muted)" }}>No Monthly Forecast changes recorded yet for {fiscalYear}.</div> : <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 16 }}>
          {bar("Revenue", totals.revenueDelta)}
          {bar("Salary Expense", totals.salaryDelta)}
          {bar("Total Cost", totals.totalCostDelta)}
          {bar("Profit", totals.profitDelta)}
        </div>
        <table>
          <thead><tr><th>When</th><th>By</th><th>Action</th><th>What</th><th>Month</th><th className="num">Before</th><th className="num">After</th><th className="num">Profit Δ</th></tr></thead>
          <tbody>{rows.slice(0, 15).map((r: any) => {
            const amtBefore = r.isExpense ? r.before.costUsd : r.before.invoiceAmount;
            const amtAfter = r.isExpense ? r.after.costUsd : r.after.invoiceAmount;
            return (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap", fontSize: 12, color: "var(--muted)" }}>{fmtDateTime(r.at)}</td>
                <td>{r.by}</td>
                <td><span className={`pill ${r.action === "ADD" ? "good" : r.action === "REMOVE" ? "bad" : "warn"}`}>{r.action}</span></td>
                <td>{r.resourceName}{r.projectName ? ` — ${r.projectName}` : ""}</td>
                <td>{r.month}</td>
                <td className="num">{money(amtBefore)}</td>
                <td className="num">{money(amtAfter)}</td>
                <td className="num" style={{ color: r.impact.profitDelta >= 0 ? "#34d399" : "#f87171" }}>{r.impact.profitDelta >= 0 ? "+" : ""}{money(r.impact.profitDelta)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </>}
    </Panel>
  );
}

export const COST_COLORS = ["#6ea8ff", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee", "#f472b6", "#94a3b8", "#fb923c", "#4ade80"];

/** Cost-center breakdown table: Category | Amount | % of Total Cost, with an inline proportion bar. Ties to Total Cost. */
export function CostBreakdown({ items, money }: { items: { category: string; cost: number }[]; money: (n: number) => string }) {
  const total = items.reduce((s, i) => s + i.cost, 0);
  const denom = total || 1;
  return (
    <table>
      <thead><tr><th>Cost Center</th><th className="num">Amount</th><th className="num">% of Cost</th></tr></thead>
      <tbody>
        {items.map((it, i) => {
          const p = (it.cost / denom) * 100;
          return (
            <tr key={it.category}>
              <td>
                <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: COST_COLORS[i % COST_COLORS.length], marginRight: 8 }} />
                {it.category}
                <div style={{ height: 4, marginTop: 4, borderRadius: 2, background: COST_COLORS[i % COST_COLORS.length], opacity: 0.35, width: `${Math.max(2, p)}%` }} />
              </td>
              <td className="num">{money(it.cost)}</td>
              <td className="num">{p.toFixed(1)}%</td>
            </tr>
          );
        })}
        <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
          <td>Total Cost</td><td className="num">{money(total)}</td><td className="num">100%</td>
        </tr>
      </tbody>
    </table>
  );
}

export function Field({ label, ...p }: any) {
  const labelNode = <label>{label}{p.required && <span style={{ color: "var(--bad, #e5484d)" }}> *</span>}</label>;
  if (p.type === "date") return <div>{labelNode}<DateInput {...p} /></div>;
  return <div>{labelNode}<input {...p} /></div>;
}
export function SelectField({ label, options, ...p }: any) {
  return (
    <div><label>{label}{p.required && <span style={{ color: "var(--bad, #e5484d)" }}> *</span>}</label>
      <select {...p}>{options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
    </div>
  );
}

export const ESIGN_STATUS_LABEL: Record<string, string> = {
  NOT_SENT: "Not sent for signature", OUT_FOR_SIGNATURE: "Out for signature", SIGNED: "Signed", CANCELLED: "Cancelled", DECLINED: "Declined",
};
/** Send-for-e-signature / status / preview / confirm-acceptance panel — shared by Offer,
 * Appointment Letter and Service Agreement detail views. docType is "OFFER" | "APPOINTMENT_LETTER"
 * | "SERVICE_AGREEMENT"; docId is always Offer.id (the record all three hang off of). */
export function EsignPanel({ docType, docId, sendBody, sendLabel, sendIcon, disabled, disabledReason }: { docType: string; docId: number; sendBody?: any; sendLabel?: string; sendIcon?: React.ReactNode; disabled?: boolean; disabledReason?: string }) {
  const { data, reload } = useFetch<any>(`/adobe-sign/status/${docType}/${docId}`);
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  // Sending involves rendering the PDF, uploading it to Adobe, creating the agreement AND sending
  // GenAquarius's own invite email — genuinely several seconds, not instant. `busy` alone just
  // grays the button out with no explanation; this drives a visible spinner + status text instead
  // of leaving HR wondering whether the click even registered.
  const [sending, setSending] = useState(false);
  const status = data?.status || "NOT_SENT";
  // Auto-detect completion instead of requiring a manual "Refresh Status" click — Socket.IO
  // pushes an event the instant the webhook (or anyone else's action) changes this document's
  // agreement, and we just re-fetch when it fires. No polling interval.
  useEffect(() => watchRoom(`esign:${docType}:${docId}`, "esign:update", reload), [docType, docId]);
  const send = async () => {
    setBusy(true); setSending(true);
    try {
      const r: any = await api.post(`/adobe-sign/send/${docType}/${docId}`, sendBody);
      if (r?.emailWarning) show(r.emailWarning, "error"); else show("Sent for signature via Adobe Sign — invite email sent");
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); setSending(false); }
  };
  const resetTest = async () => {
    setBusy(true);
    try { await api.del(`/adobe-sign/status/${docType}/${docId}`); show("Reset — you can send again"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const resetSigned = async () => {
    if (!window.confirm("This document has already been signed — deleting removes the signed copy and the signature record entirely. Only do this to fix a genuine mistake. Continue?")) return;
    resetTest();
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      <span className="badge">{ESIGN_STATUS_LABEL[status] || status}</span>
      {(status === "NOT_SENT" || status === "CANCELLED" || status === "DECLINED") && (
        <>
          <AddButton icon={sendIcon} disabled={busy || disabled} title={disabled ? disabledReason : undefined} onClick={send}>{sendLabel || "Send for E-Signature (Adobe Sign)"}</AddButton>
          {sending && (
            // A popup overlay (not an inline status line) so it's impossible to miss during the
            // several-second wait — same dimmed backdrop as the app's own Modal, but with no close
            // button/click-outside-to-dismiss, since there's nothing to cancel mid-send.
            <div className="modal-overlay">
              <div className="modal-card" style={{ padding: "28px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
                <span className="spinner" style={{ width: 28, height: 28 }} />
                <div style={{ fontSize: 13.5 }}>Sending — rendering the document and creating the Adobe Sign agreement, this can take a few seconds…</div>
              </div>
            </div>
          )}
        </>
      )}
      {status === "OUT_FOR_SIGNATURE" && <GhostButton disabled={busy} onClick={reload}>Refresh Status</GhostButton>}
      {status === "SIGNED" && (
        <>
          <GhostButton onClick={() => window.open(api.pdfUrl(`/adobe-sign/signed/${docType}/${docId}`), "_blank")}>Preview Signed Document</GhostButton>
          <span className="subtitle" style={{ margin: 0 }}>Signed & accepted {data.confirmedAt ? fmtDate(data.confirmedAt) : ""}</span>
        </>
      )}
      {/* Once genuinely SIGNED (a real, executed document — not the Test lane), this is no longer a
          casual one-click action: the Offer/Appointment Letter/Service Agreement status has
          already advanced off the back of it, so an accidental delete here would desync them. */}
      {status !== "NOT_SENT" && status !== "SIGNED" && <GhostButton disabled={busy} onClick={resetTest}>Delete / Send Again</GhostButton>}
      {status === "SIGNED" && <GhostButton disabled={busy} onClick={resetSigned}>Delete Signed Record</GhostButton>}
    </div>
  );
}

/** Read-only list of whatever the candidate has uploaded for Stage 3 (Mandatory Document
 * Collection) — PAN/Education Certificate/Photo/Salary Slips etc., with per-document verification
 * status and a Preview for anything uploaded. Shared by Offers & Lifecycle (HR, mid-pipeline) and
 * Employee Master's "Offer & Onboarding" modal (once Confirm Joining has run) — both read off the
 * SAME CandidateDocument records via this one offer-keyed route, so there's exactly one place this
 * data lives, not two systems that can drift apart. */
export function CandidateDocumentsPanel({ offerId }: { offerId: number }) {
  const { data: request } = useFetch<any>(`/hr/offers/${offerId}/document-collection`);
  if (!request?.documents?.length) return null;
  const label: Record<string, string> = { PENDING: "Not uploaded", UPLOADED: "Uploaded", SUBMITTED: "Submitted", VERIFIED: "Verified", REJECTED: "Rejected" };
  const cls: Record<string, string> = { PENDING: "", UPLOADED: "warn", SUBMITTED: "good", VERIFIED: "good", REJECTED: "bad" };
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Documents Collected from Candidate</div>
      <table><tbody>
        {request.documents.map((d: any) => (
          <tr key={d.id}>
            <td>{d.label}{d.required === false && <span style={{ color: "var(--muted)" }}> (optional)</span>}</td>
            <td className="num"><span className={`pill ${cls[d.status] || ""}`}>{label[d.status] || d.status}</span></td>
            <td className="num">
              {(Array.isArray(d.files) ? d.files : []).map((f: any, i: number) => (
                <GhostButton key={i} style={{ marginLeft: 4 }} onClick={() => window.open(api.pdfUrl(`/hr/offers/${offerId}/document-collection/file/${d.docType}/${i}`), "_blank")}>{f.fileName}</GhostButton>
              ))}
              {!(Array.isArray(d.files) && d.files.length) && "—"}
            </td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}
