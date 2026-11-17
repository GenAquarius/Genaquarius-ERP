// Company-wide date display format — HR-configurable from Company Settings -> Date & Time
// Format (pages/shared/People.tsx). Mirrors server/src/engine/dateFormat.ts's format registry
// exactly (same keys/labels) so a saved choice renders identically in the UI and in every
// generated document.
//
// Cached module-level (loaded once via loadDateFormatSetting(), called at app start in App.tsx)
// so every synchronous fmtDate() call everywhere in the codebase never needs to be async. Falls
// back to the same default as the server while loading/if the fetch fails.
import { api } from "./api";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ord(n: number): string {
  const v = n % 100, s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
const pad2 = (n: number) => String(n).padStart(2, "0");

export type DateFormatKey = keyof typeof DATE_FORMATS;

// Same keys/labels as server/src/engine/dateFormat.ts's DATE_FORMATS — keep in sync.
export const DATE_FORMATS = {
  MMM_D_ORD_YYYY: { label: "Jan 2nd, 2026", fmt: (d: Date) => `${MON[d.getMonth()]} ${ord(d.getDate())}, ${d.getFullYear()}` },
  MMM_DD_YYYY: { label: "Jan 02, 2026", fmt: (d: Date) => `${MON[d.getMonth()]} ${pad2(d.getDate())}, ${d.getFullYear()}` },
  MMM_D_YYYY: { label: "Jan 2, 2026", fmt: (d: Date) => `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` },
  DD_MMM_YYYY: { label: "02 Jan 2026", fmt: (d: Date) => `${pad2(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}` },
  DD_SLASH_MM_SLASH_YYYY: { label: "02/01/2026 (DD/MM/YYYY)", fmt: (d: Date) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` },
  MM_SLASH_DD_SLASH_YYYY: { label: "01/02/2026 (MM/DD/YYYY)", fmt: (d: Date) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}` },
  YYYY_DASH_MM_DASH_DD: { label: "2026-01-02 (ISO)", fmt: (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` },
  DD_DASH_MM_DASH_YYYY: { label: "02-01-2026", fmt: (d: Date) => `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}` },
  FULL_MONTH_D_YYYY: { label: "January 2, 2026", fmt: (d: Date) => `${MON_FULL[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` },
} as const;

export const TIME_FORMATS = {
  H12: { label: "12-hour (3:45 PM)" },
  H24: { label: "24-hour (15:45)" },
} as const;
export type TimeFormatKey = keyof typeof TIME_FORMATS;

let current: { dateFormat: DateFormatKey; timeFormat: TimeFormatKey } = { dateFormat: "MMM_D_ORD_YYYY", timeFormat: "H12" };
let loaded = false;
const listeners = new Set<() => void>();

export async function loadDateFormatSetting(): Promise<void> {
  try {
    const r = await api.get("/company-settings/date-time-format");
    if (r?.dateFormat && DATE_FORMATS[r.dateFormat as DateFormatKey]) current.dateFormat = r.dateFormat;
    if (r?.timeFormat && TIME_FORMATS[r.timeFormat as TimeFormatKey]) current.timeFormat = r.timeFormat;
  } catch { /* not logged in yet / transient — keep default, App.tsx retries after login */ }
  loaded = true;
  listeners.forEach((l) => l());
}

export function getDateFormatSetting() { return current; }
// Called right after a successful save (Company Settings) so every already-mounted component
// using fmtDate() re-renders with the new format immediately, no page reload needed.
export function setDateFormatCache(dateFormat: DateFormatKey, timeFormat: TimeFormatKey) {
  current = { dateFormat, timeFormat };
  listeners.forEach((l) => l());
}
// For components that need to re-render when the format changes (the Company Settings screen
// itself, and anywhere showing a live preview) — most call sites just call fmtDate() directly and
// don't need this, since a save is a rare admin action, not a live-updating value.
export function onDateFormatChange(cb: () => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }

// A bare "YYYY-MM-DD" (native <input type="date">'s value, and most API date-only fields) must be
// parsed as LOCAL calendar components, not handed to `new Date(string)` — the Date constructor
// treats that exact shape as UTC midnight, which then reads back a day EARLIER in any timezone
// west of UTC. Anything else (a full ISO timestamp, or an actual Date) parses normally.
function toLocalDate(d: Date | string): Date {
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(d);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = toLocalDate(d);
  if (isNaN(x.getTime())) return "—";
  return DATE_FORMATS[current.dateFormat].fmt(x);
}

export function fmtDateRange(a: Date | string | null | undefined, b: Date | string | null | undefined): string {
  if (!a || !b) return "—";
  const x = toLocalDate(a), y = toLocalDate(b);
  if (isNaN(x.getTime()) || isNaN(y.getTime())) return "—";
  const f = DATE_FORMATS[current.dateFormat].fmt;
  return `${f(x)} - ${f(y)}`;
}

function fmtTimePart(d: Date): string {
  const h = d.getHours(), m = pad2(d.getMinutes());
  if (current.timeFormat === "H24") return `${pad2(h)}:${m}`;
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${h < 12 ? "AM" : "PM"}`;
}
// Date + time, both per Company Settings -> Date & Time Format — replaces a raw
// `new Date(x).toLocaleString()` (audit trails, "Sent on"/"Uploaded"/"Queued" timestamps, etc.),
// which always used the browser's own locale regardless of the configured format.
export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = toLocalDate(d);
  if (isNaN(x.getTime())) return "—";
  return `${DATE_FORMATS[current.dateFormat].fmt(x)}, ${fmtTimePart(x)}`;
}
