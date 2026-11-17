// Company-wide date display format — HR-configurable from Company Settings -> Date & Time
// Format (routes/shared/companySettings.ts), one single company-wide choice (not per-user/BU).
// Single source of truth for every generated document (Offer Letter, Appointment Letter,
// Invoice, Appraisal Letter, FnF Settlement, Relieving Letter, Service Agreement, MSA/SOW,
// Timesheet exports) and every email template date placeholder.
//
// Cached in-process (same pattern as engine/workflow.ts's publishedCache) — loaded once at
// server boot (see index.ts) and refreshed immediately whenever HR saves a new choice, so every
// synchronous fmtDate() call everywhere in the codebase never needs to be async.
import { prisma } from "../prisma";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ord(n: number): string {
  const v = n % 100, s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
const pad2 = (n: number) => String(n).padStart(2, "0");

export type DateFormatKey = keyof typeof DATE_FORMATS;

// Every option HR can pick in Company Settings -> Date & Time Format. `label` is what shows in
// the dropdown; `example` is rendered live against today's date; `fmt` is the real formatter.
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

const DEFAULT_DATE_FORMAT: DateFormatKey = "MMM_D_ORD_YYYY";
const DEFAULT_TIME_FORMAT: TimeFormatKey = "H12";

let current: { dateFormat: DateFormatKey; timeFormat: TimeFormatKey } = { dateFormat: DEFAULT_DATE_FORMAT, timeFormat: DEFAULT_TIME_FORMAT };

export async function loadDateTimeFormatSetting(): Promise<void> {
  try {
    const row = await prisma.companyDateTimeSetting.findUnique({ where: { id: 1 } });
    if (row) {
      current = {
        dateFormat: (DATE_FORMATS[row.dateFormat as DateFormatKey] ? row.dateFormat : DEFAULT_DATE_FORMAT) as DateFormatKey,
        timeFormat: (TIME_FORMATS[row.timeFormat as TimeFormatKey] ? row.timeFormat : DEFAULT_TIME_FORMAT) as TimeFormatKey,
      };
    }
  } catch { /* table not migrated yet / transient DB issue — keep the in-memory default */ }
}

export function getDateTimeFormatSetting() { return current; }
// Called by the save route right after writing the DB row — same "update in-memory cache
// immediately" pattern as invalidatePublishedWorkflowCache, so a save takes effect on the very
// next request, not after the next server restart.
export function setDateTimeFormatCache(dateFormat: DateFormatKey, timeFormat: TimeFormatKey) { current = { dateFormat, timeFormat }; }

// A bare "YYYY-MM-DD" string (e.g. straight from a client <input type="date">, not yet round-
// tripped through Prisma) must be parsed as LOCAL calendar components, not handed to `new
// Date(string)` — the Date constructor treats that exact shape as UTC midnight, which then reads
// back a day EARLIER whenever this process's TZ is west of UTC. A real Date (from Prisma) or a
// full ISO timestamp parses normally either way.
function toLocalDate(d: Date | string): Date {
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(d);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = toLocalDate(d);
  if (isNaN(x.getTime())) return "";
  return DATE_FORMATS[current.dateFormat].fmt(x);
}

export function fmtDateRange(a: Date | string | null | undefined, b: Date | string | null | undefined): string {
  if (!a || !b) return "";
  const x = toLocalDate(a), y = toLocalDate(b);
  if (isNaN(x.getTime()) || isNaN(y.getTime())) return "";
  const f = DATE_FORMATS[current.dateFormat].fmt;
  return `${f(x)} - ${f(y)}`;
}

// Shown as-is in Company Settings -> Date & Time Format (not a real date, just the example the
// format spec was originally given as).
export const DATE_FORMAT_EXAMPLE = "Jan 2nd 2026";
