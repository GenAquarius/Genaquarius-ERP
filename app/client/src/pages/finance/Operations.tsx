import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useFetch, fmt, Panel, Field, SelectField, downloadCsv, d2, useFiscalYears, useSelectedFy, getSelectedFy, projectLabel, Masked, useMaskNumbers, ProjectMultiSelect } from "../../ui";
import { fmtDate } from "../../dateFormat";
import { DataTable, useSortFilter, SortableHead, FilterToggle, asText } from "../../DataTable";
import { Modal, Input, Select, useToast, AddButton, EditAction, DeleteAction, confirmDialog } from "../../components";
import { useAuth } from "../../auth";

// ---------------- Monthly Sheet ----------------
const MS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const RES_COLS = [
  { key: "resourceName", label: "Resource" },
  { key: "location", label: "Location", get: (l: any) => l.employee?.location || "—" },
  { key: "projectName", label: "Project" },
  { key: "billable", label: "Billable?", get: (l: any) => (l.isBillable === false ? "Non-billable" : "Billable") },
  { key: "rateUsd", label: "Rate", num: true }, { key: "estimateHours", label: "Est Hrs", num: true },
  { key: "actualHours", label: "Act Hrs", num: true }, { key: "billingAmount", label: "Estimated Billing (USD)", num: true },
  { key: "invoiceAmount", label: "Actual Invoice (USD)", num: true }, { key: "costUsd", label: "Cost (USD)", num: true },
  // Sortable + filterable like every other column (`noSort` opts a column out of BOTH). The
  // real Yes/No value is injected in the component — it needs the month's other rows to know
  // who is on 2+ projects.
  { key: "doubleDip", label: "Double Dip", get: (l: any) => ((l.doubleDip || (+l.doubleDipIncentive || 0) > 0) ? "Yes" : "No") },
];
const EXP_COLS = [
  { key: "projectName", label: "Category" }, { key: "resourceName", label: "Description" },
  { key: "region", label: "Region", get: (l: any) => l.region || "—" },
  { key: "scope", label: "Allocation", get: (l: any) => (l.expenseScope === "PROJECT" ? `→ ${l.project?.name || "Project"}` : "Organization") },
  { key: "expenseType", label: "Type", get: (l: any) => (l.expenseType === "FIXED" ? "Fixed" : "Variable") },
  { key: "currency", label: "Currency", get: (l: any) => l.currency || "USD" },
  { key: "nativeAmount", label: "Amount", num: true, get: (l: any) => l.nativeAmount ?? l.costUsd },
  { key: "costUsd", label: "USD Cost", num: true },
];
function defaultNext(fy: string, month: string) {
  const i = MS.indexOf(month);
  if (i >= 0 && i < 11) return { fiscalYear: fy, month: MS[i + 1] };
  const m = fy.match(/FY(\d+)-(\d+)/);
  return { fiscalYear: m ? `FY${+m[1] + 1}-${+m[2] + 1}` : fy, month: "Apr" };
}

export function MonthlySheet() {
  const { show } = useToast();
  const { user } = useAuth();
  // Forces a re-render on mask toggle — fmt()/Masked below read the shared mask flag directly but
  // nothing else here subscribes to "masknumberschange", so without this the whole Resources/
  // Expenses table stayed on whatever it showed at last render (stuck masked, or stuck unmasked)
  // until something unrelated (FY/month change, a refetch) happened to re-render the page.
  useMaskNumbers(user?.id);
  // Deep-link support: Invoice Reconciliation's "click amount → Monthly Forecast" links in with
  // ?fy=&month=&focusLine= — a one-time read on mount, not re-synced after (the FY/month selects
  // below take over from here, same as the plain localStorage-restore case).
  const [searchParams] = useSearchParams();
  const focusLine = searchParams.get("focusLine");
  // FY + month persist across refreshes (don't snap back to April / the first sheet).
  // Shared app-wide fiscal year (a ?fy= deep link wins and becomes the shared value).
  const [fy, setFy] = useSelectedFy(searchParams.get("fy") || undefined);
  const fyList = useFiscalYears();
  const { data: sheets, reload: reloadSheets } = useFetch<any[]>(`/monthly?fy=${fy}`, [fy]);
  const { data: employees } = useFetch<any[]>("/employees");
  const { data: projects } = useFetch<any[]>("/projects");
  // Closed projects (old per-resource projects superseded by Sub-Projects) drop out of every
  // picker below — except a row that's ALREADY assigned to one, so editing old data never shows
  // a blank/invalid selection. New assignments only ever see ACTIVE projects.
  const pickableProjects = (currentId?: any) => (projects || []).filter((p: any) => p.status !== "CLOSED" || (currentId != null && currentId !== "" && String(p.id) === String(currentId)));
  const { data: fxRates } = useFetch<any[]>("/fx-rates");
  const { data: expCats, reload: reloadCats } = useFetch<any[]>("/expense-categories");
  // CAD → USD factor (for CAD-billed clients whose rate is entered in CAD). Default 0.71.
  const canadaFactor = (fxRates || []).find((r: any) => r.context === "CANADA_FACTOR")?.rate || 0.71;
  // Show the CAD rate input when the PROJECT currency is CAD (currency is a project setting now).
  const isCadProject = (projectId: any) => (projects || []).find((p: any) => String(p.id) === String(projectId))?.currency === "CAD";
  // Rate is stored in USD; display/edit it in the client's currency (CAD or USD).
  const rateSym = (projectId: any) => (isCadProject(projectId) ? "CAD $" : "$");
  const usdToCcy = (rateUsd: number, projectId: any) => (isCadProject(projectId) ? d2((rateUsd || 0) / (canadaFactor || 0.71)) : d2(rateUsd || 0));
  const ccyToUsd = (val: any, projectId: any) => (isCadProject(projectId) ? d2(((+val) || 0) * (canadaFactor || 0.71)) : ((+val) || 0));
  const [sel, setSel] = useState<number | null>(null);
  // Restore the last-viewed month by name (ids differ per FY); fall back to the first sheet.
  const savedMonth = searchParams.get("month") || localStorage.getItem("ops.month") || "";
  const sheetId = sel ?? (sheets || []).find((s: any) => s.month === savedMonth)?.id ?? sheets?.[0]?.id ?? null;
  const { data: sheet, loading, reload } = useFetch<any>(sheetId ? `/monthly/${sheetId}` : "/health", [sheetId]);
  useEffect(() => { if (sheet?.month) localStorage.setItem("ops.month", sheet.month); }, [sheet?.month]);
  const resourceLines = (sheet?.lines || []).filter((l: any) => !l.isExpense);
  const expLines = (sheet?.lines || []).filter((l: any) => l.isExpense);
  const [selRow, setSelRow] = useState<number | null>(null); // click-to-select a row (highlighted, maintained)
  const rowSel = (id: number) => ({ onClick: () => setSelRow(id), style: { cursor: "pointer", background: selRow === id ? "rgba(110,168,255,.18)" : undefined } });
  // "Double Dip" — the same definition the dashboard's Double Dip count uses: a resource on 2+
  // BILLABLE projects this month, or one explicitly flagged / given an incentive. Being on two
  // billable projects IS the dip — it is what splits the person's CTC across the rows, whether
  // or not anyone ticked the box. Distinct PROJECTS, not rows, so two rows on the same project
  // don't read as a dip.
  // A non-billable row (bench/corporate) is never itself a dip, even if that person is billed on
  // two other projects — only their billable rows carry the flag.
  // Double Dip badge: ONLY rows explicitly marked (checkbox / saved incentive). A resource split
  // across 2+ projects (e.g. 50% + 50% allocation) is NOT auto-flagged — that's one billable person.
  const isDoubleDip = (l: any) => !!l.doubleDip || (+l.doubleDipIncentive || 0) > 0;
  // Feed the real Yes/No into the Double Dip column so sorting, filtering and the global search
  // all agree with the pill shown in the row.
  const resCols = React.useMemo(
    () => RES_COLS.map((c) => (c.key === "doubleDip" ? { ...c, get: (l: any) => (isDoubleDip(l) ? "Yes" : "No") } : c)),
    [resourceLines],
  );
  // Resource tab composition (distinct resources). Bench = non-billable on GenAquarius (Bench);
  // Corporate = non-billable on a real/corporate project; offshore billable = India (not US/Canada/Caribbean).
  const isBenchName = (n: string) => { const x = (n || "").trim().toLowerCase(); return x === "bench" || x.includes("(bench)"); };
  const isOnsiteLoc = (l: any) => ["US", "CANADA", "CARIBBEAN"].includes((l.employee?.location || "").toUpperCase());
  const distinct = (arr: any[]) => new Set(arr.map((l) => (l.resourceName || "").toLowerCase())).size;
  const isCorpName = (n: string) => { const x = (n || "").trim().toLowerCase(); return x.includes("corporate") || x.startsWith("genaquarius"); };
  // ONE category per person, by precedence: billable > On Project (non-billable) > Corporate >
  // Bench — e.g. billable 50% on one project + non-billable 50% on another = ONE billable head.
  const nameOf = (l: any) => (l.resourceName || "").toLowerCase();
  const billableNames = new Set(resourceLines.filter((l: any) => l.isBillable !== false).map(nameOf));
  const assignedNames = new Set(resourceLines.filter((l: any) => l.isBillable === false && !isBenchName(l.projectName) && !isCorpName(l.projectName)).map(nameOf).filter((n: string) => !billableNames.has(n)));
  const corporateNames = new Set(resourceLines.filter((l: any) => l.isBillable === false && !isBenchName(l.projectName) && isCorpName(l.projectName)).map(nameOf).filter((n: string) => !billableNames.has(n) && !assignedNames.has(n)));
  const benchNames = new Set(resourceLines.filter((l: any) => l.isBillable === false && isBenchName(l.projectName)).map(nameOf).filter((n: string) => !billableNames.has(n) && !assignedNames.has(n) && !corporateNames.has(n)));
  const benchCount = benchNames.size, corporateCount = corporateNames.size, assignedNBCount = assignedNames.size;
  // Onsite / offshore are DISTINCT PEOPLE — a person on 2 projects (double-dip or a 50%+50%
  // split) counts once. Billable (TB) = onsite + offshore + explicitly-marked double dips (a
  // marked double-dip fills a second billable slot) — same formula as the CEO dashboard. (The
  // PER_BILLABLE commission expense still charges per billable assignment on the server.)
  const ddCount = distinct(resourceLines.filter((l: any) => l.isBillable !== false && isDoubleDip(l)));
  const billableCount = distinct(resourceLines.filter((l: any) => l.isBillable !== false)) + ddCount;
  const offshoreBillableCount = distinct(resourceLines.filter((l: any) => l.isBillable !== false && !isOnsiteLoc(l)));
  const onsiteBillableCount = distinct(resourceLines.filter((l: any) => l.isBillable !== false && isOnsiteLoc(l)));
  // Offshore Double Dip Headcount: offshore resources explicitly marked Double Dip — fills a 2nd
  // offshore billable slot, same "fills a 2nd slot" rule as the overall Billable (TB) count above.
  const offshoreDoubleDipCount = distinct(resourceLines.filter((l: any) => l.isBillable !== false && !isOnsiteLoc(l) && isDoubleDip(l)));
  // What "Per offshore billable resource" incentives (e.g. Variable Pay) actually charge per
  // resource for = Offshore Billable Headcount + Offshore Double Dip Headcount, matching the
  // server's own offshoreBillableHeadcount() in monthly.ts exactly.
  const offshoreBillableTotal = offshoreBillableCount + offshoreDoubleDipCount;
  const namesOf = (rows: any[]) => Array.from(new Map(rows.map((l: any) => [nameOf(l), l.resourceName])).values()).sort();
  const offshoreBillableNames = namesOf(resourceLines.filter((l: any) => l.isBillable !== false && !isOnsiteLoc(l)));
  const offshoreDoubleDipNames = namesOf(resourceLines.filter((l: any) => l.isBillable !== false && !isOnsiteLoc(l) && isDoubleDip(l)));
  const [hcNamesOpen, setHcNamesOpen] = useState(false);
  // Total employee cost (USD) this month — basis for Dynamic (% of cost) expenses like "Loading 5%".
  const totalEmployeeCost = resourceLines.reduce((s: number, l: any) => s + (l.costUsd || 0), 0);
  const resTip = `Billable (TB) = Onsite + Offshore + Double Dip = ${onsiteBillableCount} + ${offshoreBillableCount} + ${ddCount} = ${billableCount}\n  Onsite (US/Canada/Caribbean, distinct people): ${onsiteBillableCount}\n  Offshore (India, distinct people): ${offshoreBillableCount}\n  Double Dip (marked — fills a 2nd billable slot): ${ddCount}\nCorporate (non-billable, internal corporate project): ${corporateCount}\nOn Project non-billable (assigned to a customer project, unbilled): ${assignedNBCount}\nBench (non-billable, unassigned): ${benchCount}`;
  // Deep-link support: Finance Dashboard's Workforce drill-down links in with ?fy=&month=&q=
  // (a resource name) — pre-fills the Resources search box so that one click lands exactly on
  // their line for the month shown there, same one-time-read-on-mount pattern as focusLine above.
  const [resQ, setResQ] = useState(() => searchParams.get("q") || "");
  const [expQ, setExpQ] = useState("");
  const [tab, setTab] = useState<"res" | "exp">("res"); // Resources tab vs Expenses/Overheads tab
  const searchRows = (rows: any[], cols: any[], q: string) => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) => cols.some((c) => asText(c.get ? c.get(r) : r[c.key]).includes(needle)));
  };
  const resSf = useSortFilter(searchRows(resourceLines, resCols, resQ), resCols);
  const expSf = useSortFilter(searchRows(expLines, EXP_COLS, expQ), EXP_COLS);

  // Jump to and highlight the line Invoice Reconciliation linked in from, once its sheet has loaded.
  useEffect(() => {
    if (!focusLine || !resourceLines.some((l: any) => l.id === Number(focusLine))) return;
    setTab("res");
    setSelRow(Number(focusLine));
    const el = document.getElementById(`ms-line-${focusLine}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusLine, resourceLines.length]);

  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<number, any>>({});
  const [busy, setBusy] = useState(false);
  const [clone, setClone] = useState<any>(null); // {targetFiscalYear,targetMonth,overwrite}
  const [addLine, setAddLine] = useState<any>(null); // {employeeId,projectId,rateUsd,estimateHours,actualHours}
  const [editRow, setEditRow] = useState<any>(null); // single-row edit modal: {kind:'res'|'exp', line, ...fields}
  // PCT_PREV_INVOICE live preview: the PREVIOUS month's invoice total for whichever projects are
  // currently checked, refetched as the % / project selection changes (empty path = useFetch skips it).
  const editRowCommIds: number[] = editRow?.kind === "exp" ? (editRow.commissionProjectIds || []) : [];
  const editRowBasisPath = editRow?.kind === "exp" && editRow.expenseCalc === "PCT_PREV_INVOICE" && sheetId && editRowCommIds.length
    ? `/monthly/${sheetId}/prev-invoice-basis?projectIds=${editRowCommIds.join(",")}` : "";
  const { data: editRowBasis } = useFetch<any>(editRowBasisPath, [editRowBasisPath]);

  // Later editable months already forecasted in this FY (locked months excluded).
  const futureMonths = () => (sheets || []).filter((s: any) => sheet && s.monthIndex > sheet.monthIndex && s.status !== "LOCKED");
  // Ask whether to cascade an add/edit/remove to those future months. Returns true=apply to all.
  const askFuture = async (verb: string): Promise<boolean> => {
    const fm = futureMonths();
    if (!fm.length) return false;
    return (await confirmDialog({
      title: "Apply to future months?",
      message: `Also ${verb} this in the ${fm.length} later forecasted month(s) of ${fy} — ${fm.map((s: any) => s.month).join(", ")}? Choose "${sheet.month} only" to limit it to this month.`,
      confirmLabel: "Apply to all future",
      cancelLabel: `${sheet.month} only`,
    })) === true;
  };

  // Net billable working days for this sheet's month + a country (holiday-aware), cached.
  const wdCache = React.useRef<Record<string, number>>({});
  const fetchWorkingDays = async (loc: string | null): Promise<number> => {
    const key = `${sheetId}:${(loc || "").toUpperCase()}`;
    if (wdCache.current[key] != null) return wdCache.current[key];
    try { const r = await api.get(`/monthly/${sheetId}/working-days?location=${encodeURIComponent(loc || "")}`); wdCache.current[key] = r.workingDays; return r.workingDays; }
    catch { return 22; }
  };
  const empLoc = (id: any) => (employees || []).find((e: any) => String(e.id) === String(id))?.location || null;

  // Picking an employee auto-fills Cost / CTC (USD/month) from their CTC Management record
  // (annual USD ÷ 12) and the month's working days. Guards against a stale pick.
  const pickAddLineEmployee = async (id: string) => {
    const loc = empLoc(id);
    setAddLine((s: any) => ({ ...s, employeeId: id, empLocation: loc }));
    if (!id) return;
    try {
      const c = await api.get(`/employees/${id}/cost`);
      const monthly = d2((c?.annualUsd || 0) / 12);
      // Hourly engagements (US Vendor / W2-No-Benefit) cost by their CTC rate × actual billable
      // work, computed server-side on save — leave Cost at 0 so it's auto-derived per month.
      const isHourlyCtc = c?.usEngagement === "W2_NO_BENEFIT" || c?.usEngagement === "VENDOR";
      const ctcDaily = isHourlyCtc && c?.rateBasis === "DAILY" && c?.dayRateUsd > 0;
      const ctcHourly = isHourlyCtc && !ctcDaily && c?.hourlyCostUsd > 0 ? c.hourlyCostUsd : 0;
      // Prorated monthly cost for THIS month — splits mid-month (empType, CTC) changes / joins / exits.
      let prorated = monthly, segs: any[] = [];
      if (!isHourlyCtc && sheet?.monthIndex) {
        try { const mc = await api.get(`/employees/${id}/monthly-cost?fiscalYear=${encodeURIComponent(fy)}&monthIndex=${sheet.monthIndex}`); if (mc?.costUsd != null) prorated = d2(mc.costUsd); segs = mc?.segments || []; } catch { /* fall back to flat monthly */ }
      }
      setAddLine((s: any) => (s && String(s.employeeId) === String(id) ? {
        ...s,
        ctcEngagement: c?.usEngagement || null,
        ctcHourlyCost: ctcHourly, ctcDayRate: ctcDaily ? c.dayRateUsd : 0,
        costUsd: isHourlyCtc ? 0 : prorated,
        ctcMonthly: isHourlyCtc ? 0 : prorated,
        costSegments: segs,
      } : s));
    } catch { /* leave Cost as-is; server still falls back to CTC on save */ }
    const wd = await fetchWorkingDays(loc);
    setAddLine((s: any) => (s && String(s.employeeId) === String(id) ? withDerivedHours({ ...s, workingDays: wd }) : s));
  };
  // Prorated-cost breakdown (only meaningful when 2+ (empType, CTC) segments fall in the month).
  const empLbl = (t: string | null) => t === "CONTRACTOR" ? "Contractor" : t === "VENDOR" ? "Vendor" : t === "W2_NO_BENEFIT" ? "W2/No Benefit" : t === "FULL_TIME" ? "Full-Time" : (t || "—");
  const renderSegs = (segs: any[]) => {
    if (!segs || segs.length < 2) return null;
    const total = segs.reduce((s: number, x: any) => s + (x.amountUsd || 0), 0);
    return <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
      <b>Prorated this month</b> — split by employment/CTC changes:
      {segs.map((s: any, i: number) => <div key={i}>• {empLbl(s.empType)} · {s.from} → {s.to} ({s.days}d) at {fmt(s.monthlyUsd)}/mo = <b>{fmt(s.amountUsd)}</b></div>)}
      <div style={{ marginTop: 4 }}>Total prorated cost = <b>{fmt(total)}</b></div>
    </div>;
  };
  // Add-dialog hour defaults. Until the user types over them, Billing Days / Estimate Hours /
  // Actual Hours track the month's working days at the picked project's hours-per-day (8 or 9).
  // Once edited by hand they're left alone, so Estimate and Actual stay independent exactly as
  // they are in Edit Resource Row. Without this the dialog would post the initial 0s.
  const withDerivedHours = (f: any) => {
    if (!f || f.hoursTouched) return f;
    const hpd = perDayOf(f.projectId);
    const days = d2((f.workingDays || 0) * windowFrac(f.deploymentStart, f.deploymentEnd));
    const hours = d2(days * hpd);
    return { ...f, billingDays: days, estimateHours: hours, actualHours: hours };
  };
  const saveNewLine = async () => {
    if (!addLine.employeeId || !addLine.projectId) return show("Pick an employee and a project", "error");
    if (addLine.isBillable) {
      if (addLine.billingMode === "MONTHLY" && !(+addLine.monthlyAmount > 0)) return show("Enter Monthly Billable Revenue", "error");
      if (addLine.billingMode === "DAILY" && !(+addLine.dayRate > 0)) return show("Enter the Day Rate", "error");
      if ((!addLine.billingMode || addLine.billingMode === "HOURLY") && !(+addLine.rateUsd > 0)) return show("Enter the hourly Rate", "error");
    }
    const applyFuture = await askFuture("add");
    setBusy(true);
    try { const r = await api.post(`/monthly/${sheetId}/lines`, { ...addLine, applyFuture }); show(`Resource added${applyFuture ? ` (+${r.propagated || 0} future month(s))` : ""}${r.benched ? ` · benched ${r.benched} month(s) after deployment end` : ""}${r.benchRemoved ? ` · absorbed ${r.benchRemoved} bench row(s)` : ""}`); setAddLine(null); reload(); reloadSheets(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const changeProject = async (lineId: number, projectId: string) => {
    await api.put(`/monthly/lines/${lineId}`, { projectId: projectId || null }); show("Project reassigned"); reload();
  };
  const delLine = async (l: any) => {
    if (!(await confirmDialog({ title: "Remove row?", message: `Remove ${l.resourceName} from ${sheet?.month} ${fy}?`, danger: true, confirmLabel: "Remove" }))) return;
    const applyFuture = await askFuture("remove");
    try {
      const r = await api.del(`/monthly/lines/${l.id}${applyFuture ? "?applyFuture=true" : ""}`);
      show(applyFuture ? `Removed (+${r.propagated || 0} future month(s))` : "Row removed"); reload(); reloadSheets();
    } catch (e: any) { show(e.message, "error"); }
  };
  // standard billable hours/day for a project (8 or 9), drives Billing Days ↔ Est Hours
  const perDayOf = (projectId: any) => Number((projects || []).find((p: any) => String(p.id) === String(projectId))?.billingHoursPerDay) || 8;
  // Calendar info for the currently-open sheet's month.
  const sheetCal = (() => {
    const mi = MS.indexOf(sheet?.month || ""); const sy = parseInt((fy.match(/FY(\d\d)/)?.[1] || "0"), 10) + 2000;
    const month0 = mi < 0 ? 0 : (mi + 3) % 12; const year = mi <= 8 ? sy : sy + 1;
    return { month0, year, days: new Date(year, month0 + 1, 0).getDate() };
  })();
  const daysInSheetMonth = sheetCal.days;
  // Deployment window proration (calendar days): the share of THIS sheet's month between the
  // Deployment Start and End dates (both inclusive; blank = open). 1 = whole month, 0 = not deployed.
  const windowFrac = (startStr?: string, endStr?: string) => {
    const first = new Date(sheetCal.year, sheetCal.month0, 1).getTime(), last = new Date(sheetCal.year, sheetCal.month0, sheetCal.days).getTime();
    const day = (v?: string) => (v ? new Date(v + "T00:00:00").getTime() : NaN);
    const from = Math.max(first, isNaN(day(startStr)) ? first : day(startStr)), to = Math.min(last, isNaN(day(endStr)) ? last : day(endStr));
    const days = Math.max(0, Math.round((to - from) / 86400000) + 1);
    return days / sheetCal.days;
  };
  // Apply a Start/End change to an Add/Edit row: cost (monthly-CTC people) and the derived hours /
  // billable days follow the deployed part of the month. `fullCost` = the whole-month cost to prorate.
  const applyWindow = (row: any, patch: any, fullCost: number) => {
    const nd = { ...row, ...patch };
    const frac = windowFrac(nd.deploymentStart, nd.deploymentEnd);
    if (+nd.ctcMonthly > 0 && !(+nd.ctcHourlyCost > 0)) nd.costUsd = d2(fullCost * frac);
    const wd = +nd.workingDays || 0;
    if (wd > 0) { const hpd = perDayOf(nd.projectId); const days = d2(wd * frac); nd.billingDays = days; nd.estimateHours = d2(days * hpd); nd.actualHours = d2(days * hpd); }
    return nd;
  };
  // open the single-row edit modal (resource or expense)
  const openEditRow = (l: any) => {
    if (l.isExpense) {
      // Preserve whatever headcount is CURRENTLY driving this row's amount — an explicit
      // override if one is saved, else back it out of the stored nativeAmount/perResourceInr —
      // rather than pre-filling the field with a freshly (re)computed live auto value. That way
      // opening Edit never silently swaps in a different number than what's actually in effect;
      // the user has to deliberately pick "Use auto-compute" to switch over.
      const pr = +l.perResourceInr || 0;
      const currentHc = l.headcountOverride != null ? Math.round(l.headcountOverride)
        : (pr > 0 && l.nativeAmount != null ? Math.round((+l.nativeAmount || 0) / pr) : null);
      setEditRow({ kind: "exp", line: l, projectName: l.projectName || EXP_CATS[0] || "Other", resourceName: l.resourceName || "", expenseType: l.expenseType || "VARIABLE", region: l.region || "INDIA", expenseScope: l.expenseScope === "PROJECT" ? "PROJECT" : "ORG", projectId: l.projectId || "", currency: l.currency || "USD", amount: l.nativeAmount ?? l.costUsd, expenseCalc: l.expenseCalc || "FIXED", perResourceInr: l.perResourceInr || 0, percentValue: l.percentValue || 5, offshoreHeadcount: currentHc ?? offshoreBillableTotal, commissionProjectIds: Array.isArray(l.commissionProjectIds) ? l.commissionProjectIds : [] });
      return;
    }
    const hpd = perDayOf(l.projectId); const mode = l.billingMode || "HOURLY";
    setEditRow({
      kind: "res", line: l, projectId: l.projectId || "", subProjectId: l.subProjectId || "", isBillable: l.isBillable !== false,
      billingMode: mode, rateUsd: l.rateUsd, dayRate: d2(l.rateUsd * hpd), monthlyAmount: d2(l.billingAmount),
      estimateHours: l.estimateHours, actualHours: l.actualHours,
      costUsd: d2((l.costUsd || 0) - (l.doubleDipIncentive || 0) - (l.bonus || 0)), // base cost (excl. add-ons)
      doubleDip: !!l.doubleDip || (+l.doubleDipIncentive || 0) > 0, doubleDipIncentive: d2(l.doubleDipIncentive || 0), allocationPct: l.allocationPct ?? 100,
      bonus: d2(l.bonus || 0), deploymentStart: l.deploymentStart ? String(l.deploymentStart).slice(0, 10) : "", deploymentEnd: l.deploymentEnd ? String(l.deploymentEnd).slice(0, 10) : "",
      workingDays: l.estimateHours ? Math.round(l.estimateHours / hpd) : 0,
      billingDays: l.actualHours ? +(l.actualHours / hpd).toFixed(2) : 0, // Billing Days ↔ Actual Hours
    });
    // refresh the holiday-aware working days display for this employee's country
    fetchWorkingDays(l.employee?.location || null).then((wd) => setEditRow((s: any) => (s && s.line?.id === l.id ? { ...s, workingDays: wd } : s)));
    // Hourly engagements (US W2/No-Benefit or Vendor): cost follows the CTC rate × actual billable
    // work — HOURLY → rate/hr × billable hours; DAILY → rate/day × billable days.
    if (l.employeeId) api.get(`/employees/${l.employeeId}/cost`).then((c: any) => setEditRow((s: any) => {
      if (!s || s.line?.id !== l.id) return s;
      const isHourlyCtc = c?.usEngagement === "W2_NO_BENEFIT" || c?.usEngagement === "VENDOR";
      const dayRate = (isHourlyCtc && c?.rateBasis === "DAILY" && c?.dayRateUsd > 0) ? c.dayRateUsd : null;
      const hourly = (isHourlyCtc && !dayRate && c?.hourlyCostUsd > 0) ? c.hourlyCostUsd : null;
      const patch: any = { ctcHourlyCost: hourly, ctcDayRate: dayRate, ctcEngagement: c?.usEngagement || null, ctcMonthly: isHourlyCtc ? 0 : d2((c?.annualUsd || 0) / 12) };
      if (hourly) patch.costUsd = d2(hourly * (+s.actualHours || 0));
      else if (dayRate) patch.costUsd = d2(dayRate * (+s.billingDays || 0));
      return { ...s, ...patch };
    })).catch(() => {});
    // Prorated month breakdown (mid-month empType/CTC changes) for display next to the cost.
    if (l.employeeId && sheet?.monthIndex) api.get(`/employees/${l.employeeId}/monthly-cost?fiscalYear=${encodeURIComponent(fy)}&monthIndex=${sheet.monthIndex}`)
      .then((mc: any) => setEditRow((s: any) => (s && s.line?.id === l.id ? { ...s, costSegments: mc?.segments || [], proratedMonthly: mc?.costUsd ?? null } : s))).catch(() => {});
  };
  const saveEditRow = async () => {
    const r = editRow;
    if (r.kind === "exp" && r.expenseScope === "PROJECT" && !r.projectId) return show("Pick a project to allocate this expense to", "error");
    if (r.kind === "exp" && r.expenseCalc === "PER_BILLABLE" && !(+r.perResourceInr > 0)) return show("Enter the per-billable-resource incentive (INR)", "error");
    if (r.kind === "exp" && r.expenseCalc === "DYNAMIC" && !(+r.percentValue > 0)) return show("Enter the percent of employee cost", "error");
    if (r.kind === "exp" && r.expenseCalc === "PCT_PREV_INVOICE") {
      if (!(+r.percentValue > 0)) return show("Enter the percent of project invoice", "error");
      if (!(r.commissionProjectIds || []).length) return show("Select at least one project to base the commission on", "error");
    }
    if (r.kind === "res" && r.isBillable) {
      if (r.billingMode === "MONTHLY" && !(+r.monthlyAmount > 0)) return show("Enter Monthly Billable Revenue", "error");
      if (r.billingMode === "DAILY" && !(+r.dayRate > 0)) return show("Enter the Day Rate", "error");
      if ((!r.billingMode || r.billingMode === "HOURLY") && !(+r.rateUsd > 0)) return show("Enter the hourly Rate", "error");
    }
    // HOURLY uses Estimate Hours (billing) and Actual/Billable Hours (invoice) separately;
    // DAILY/MONTHLY are derived server-side from working days.
    const body: any = r.kind === "res"
      ? { projectId: r.projectId || undefined, subProjectId: r.subProjectId || "", isBillable: r.isBillable, billingMode: r.billingMode, rateUsd: +r.rateUsd, dayRate: +r.dayRate, monthlyAmount: +r.monthlyAmount, billingDays: +r.billingDays, estimateHours: +r.estimateHours, actualHours: +r.actualHours, costUsd: +r.costUsd, doubleDip: !!r.doubleDip, doubleDipIncentive: r.doubleDip ? (+r.doubleDipIncentive || 0) : 0, allocationPct: +r.allocationPct || 100, bonus: +r.bonus || 0, deploymentStart: r.deploymentStart || null, deploymentEnd: r.deploymentEnd || null }
      : { projectName: r.projectName, resourceName: r.resourceName, expenseType: r.expenseType, region: r.region, expenseScope: r.expenseScope, projectId: r.expenseScope === "PROJECT" ? (r.projectId || null) : null, currency: r.currency, nativeAmount: +r.amount, expenseCalc: r.expenseCalc, perResourceInr: +r.perResourceInr, percentValue: +r.percentValue, headcountOverride: r.expenseCalc === "PER_BILLABLE" ? (r.offshoreHeadcount != null && r.offshoreHeadcount !== "" && +r.offshoreHeadcount !== offshoreBillableTotal ? Math.round(+r.offshoreHeadcount) : null) : null, commissionProjectIds: r.expenseCalc === "PCT_PREV_INVOICE" ? (r.commissionProjectIds || []) : [] };
    const applyFuture = await askFuture("edit");
    setBusy(true);
    try {
      const res = await api.put(`/monthly/lines/${r.line.id}`, { ...body, applyFuture });
      show(applyFuture ? `Saved · ${res.propagated || 0} future month(s)${res.added ? ` (${res.added} added)` : ""}${res.removed ? ` · ${res.removed} removed after deployment end` : ""}${res.benched ? ` · ${res.benched} benched` : ""}` : `Row saved${res.benched ? " · benched for the rest of the month" : ""}`); setEditRow(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Add Bench — open a pick-list of active employees NOT yet on this month's sheet, with
  // their cost, so the user can select who to add as Non-billable bench (or terminate).
  const [benchDlg, setBenchDlg] = useState<any>(null); // { candidates, selected:Set, loading }
  const loadBench = async () => {
    const r = await api.get(`/monthly/${sheetId}/bench-candidates`);
    return r.candidates || [];
  };
  const openBench = async () => {
    if (!sheetId) return;
    setBenchDlg({ candidates: [], selected: new Set(), loading: true });
    try { const c = await loadBench(); setBenchDlg({ candidates: c, selected: new Set(c.map((x: any) => x.id)), loading: false }); }
    catch (e: any) { show(e.message, "error"); setBenchDlg(null); }
  };
  const toggleBench = (id: number) => setBenchDlg((d: any) => { const s = new Set(d.selected); s.has(id) ? s.delete(id) : s.add(id); return { ...d, selected: s }; });
  const toggleAllBench = () => setBenchDlg((d: any) => { const all = d.candidates.length && d.candidates.every((c: any) => d.selected.has(c.id)); return { ...d, selected: new Set(all ? [] : d.candidates.map((c: any) => c.id)) }; });
  const addSelectedBench = async () => {
    const ids = [...(benchDlg?.selected || [])];
    if (!ids.length) return show("Select at least one employee", "error");
    setBusy(true);
    try { const r = await api.post(`/monthly/${sheetId}/bench`, { employeeIds: ids }); show(`Added ${r.added} to bench`); setBenchDlg(null); reload(); reloadSheets(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const terminateCandidate = async (c: any) => {
    if (!(await confirmDialog({ title: `Terminate ${c.name}?`, message: "Sets termination date to today and removes them from future months. They will not be benched.", danger: true, confirmLabel: "Terminate" }))) return;
    try {
      await api.post(`/employees/${c.id}/terminate`, { exitDate: new Date().toISOString().slice(0, 10) });
      show(`${c.name} terminated`);
      const list = await loadBench();
      setBenchDlg((d: any) => ({ ...d, candidates: list, selected: new Set([...(d?.selected || [])].filter((id: number) => list.some((x: any) => x.id === id))) }));
    } catch (e: any) { show(e.message, "error"); }
  };
  const clearMonth = async () => {
    if (!(await confirmDialog({ title: `Clear all rows for ${sheet?.month} ${fy}?`, message: "This removes every line in this month and cannot be undone.", danger: true, confirmLabel: "Clear month" }))) return;
    setBusy(true);
    try { const r = await api.del(`/monthly/${sheetId}/lines`); show(`Cleared ${r.deleted} row(s)`); setEditing(false); reload(); reloadSheets(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const clearMonthFuture = async () => {
    if (!(await confirmDialog({ title: `Clear ${sheet?.month} → March ${fy}?`, message: `This removes every line in ${sheet?.month} and every later editable month of ${fy} (up to March). Locked months are skipped. Cannot be undone.`, danger: true, confirmLabel: "Clear all" }))) return;
    setBusy(true);
    try { const r = await api.del(`/monthly/${sheetId}/lines?allFuture=true`); show(`Cleared ${r.deleted} row(s) across ${r.months} month(s)`); setEditing(false); reload(); reloadSheets(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  const change = (id: number, field: string, val: string) =>
    setEdits((s) => ({ ...s, [id]: { ...s[id], [field]: +val } }));
  const changeText = (id: number, field: string, val: string) =>
    setEdits((s) => ({ ...s, [id]: { ...s[id], [field]: val } }));

  const saveAll = async () => {
    const ids = Object.keys(edits);
    if (!ids.length) { setEditing(false); return; }
    setBusy(true);
    try {
      for (const id of ids) await api.put(`/monthly/lines/${id}`, edits[+id]); // send only changed fields
      show(`Saved ${ids.length} row(s)`); setEdits({}); setEditing(false); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const [addExp, setAddExp] = useState<any>(null);
  const addExpCommIds: number[] = addExp?.commissionProjectIds || [];
  const addExpBasisPath = addExp?.expenseCalc === "PCT_PREV_INVOICE" && sheetId && addExpCommIds.length
    ? `/monthly/${sheetId}/prev-invoice-basis?projectIds=${addExpCommIds.join(",")}` : "";
  const { data: addExpBasis } = useFetch<any>(addExpBasisPath, [addExpBasisPath]);
  const [newCat, setNewCat] = useState("");
  const EXP_CATS: string[] = (expCats || []).map((c: any) => c.name);
  const saveExpense = async () => {
    if (!addExp.category) return show("Pick a category", "error");
    if (addExp.expenseScope === "PROJECT" && !addExp.projectId) return show("Pick a project to allocate this expense to", "error");
    if (addExp.expenseCalc === "PER_BILLABLE" && !(+addExp.perResourceInr > 0)) return show("Enter the per-billable-resource incentive (INR)", "error");
    if (addExp.expenseCalc === "DYNAMIC" && !(+addExp.percentValue > 0)) return show("Enter the percent of employee cost", "error");
    if (addExp.expenseCalc === "PCT_PREV_INVOICE") {
      if (!(+addExp.percentValue > 0)) return show("Enter the percent of project invoice", "error");
      if (!(addExp.commissionProjectIds || []).length) return show("Select at least one project to base the commission on", "error");
    }
    const applyFuture = await askFuture("add");
    setBusy(true);
    try { const r = await api.post(`/monthly/${sheetId}/expense-lines`, { category: addExp.category, description: addExp.description, currency: addExp.currency, amount: addExp.amount, expenseType: addExp.expenseType, region: addExp.region, expenseScope: addExp.expenseScope, projectId: addExp.expenseScope === "PROJECT" ? addExp.projectId : undefined, expenseCalc: addExp.expenseCalc, perResourceInr: addExp.perResourceInr, percentValue: addExp.percentValue, headcountOverride: addExp.expenseCalc === "PER_BILLABLE" ? (addExp.offshoreHeadcount != null && addExp.offshoreHeadcount !== "" && +addExp.offshoreHeadcount !== offshoreBillableTotal ? Math.round(+addExp.offshoreHeadcount) : null) : null, commissionProjectIds: addExp.expenseCalc === "PCT_PREV_INVOICE" ? (addExp.commissionProjectIds || []) : [], applyFuture }); show(applyFuture ? `Expense added (+${r.propagated || 0} future month(s))` : "Expense added"); setAddExp(null); reload(); reloadSheets(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const addCategory = async () => {
    const n = newCat.trim(); if (!n) return;
    try { await api.post("/expense-categories", { name: n }); setNewCat(""); setAddExp((a: any) => ({ ...a, category: n })); reloadCats(); show("Category added"); }
    catch (e: any) { show(e.message, "error"); }
  };
  const delCategory = async (c: any) => { if (!(await confirmDialog({ title: `Delete category "${c.name}"?`, danger: true, confirmLabel: "Delete" }))) return; await api.del(`/expense-categories/${c.id}`); reloadCats(); show("Category deleted"); };
  // Apply Finance's default Fixed/Variable classification to every expense line (all months/years)
  const classifyExpenses = async () => {
    if (!(await confirmDialog({ title: "Auto-classify Fixed / Variable?", message: "Apply the default Fixed/Variable classification (by description) to every expense line across all months and years. You can still change any row individually afterwards.", confirmLabel: "Classify" }))) return;
    setBusy(true);
    try { const r = await api.post("/monthly/classify-expenses", {}); show(`Classified ${r.fixed} fixed + ${r.variable} variable (scanned ${r.scanned})`); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const cancel = () => { setEdits({}); setEditing(false); };

  const doClone = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/monthly/${sheetId}/clone`, clone);
      if (r.spread) {
        show(`Spread ${sheet?.month}'s plan to ${r.months} month(s): ${(r.monthNames || []).join(", ")} (${r.totalLines} rows)`);
        setClone(null); reloadSheets(); reload();
      } else {
        show(`Cloned to ${r.month} ${r.fiscalYear} (${r.clonedLines} rows)`);
        setClone(null);
        if (r.fiscalYear === fy) { reloadSheets(); setSel(r.id); } else { setFy(r.fiscalYear); setSel(r.id); }
      }
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const locked = !!sheet && sheet.status === "LOCKED";
  const toggleLock = async () => {
    await api.post(`/monthly/${sheetId}/${locked ? "unlock" : "lock"}`, {});
    show(locked ? "Month unlocked — editable" : "Month locked — read-only"); setEditing(false); reloadSheets(); reload();
  };

  const openClone = () => { const n = defaultNext(sheet.fiscalYear, sheet.month); setClone({ targetFiscalYear: n.fiscalYear, targetMonth: n.month, overwrite: false }); };

  return (
    <div>
      <h1>Monthly Forecast &amp; Actuals{sheet && <span style={{ color: "#6ea8ff", fontWeight: 800 }}> — {sheet.month} {fy}</span>}{locked && <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 700, color: "#ffb454" }}>🔒 LOCKED</span>}</h1>
      <div className="subtitle">Finance-owned per-month form. Rate × Estimate = Billing; Rate × Actual = Invoice.</div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ flex: "0 0 auto" }}><SelectField label="Fiscal Year" value={fy} onChange={(e: any) => { setFy(e.target.value); setSel(null); setEditing(false); }} style={{ width: 130 }}
          options={fyList.map((f) => ({ value: f, label: f }))} /></div>
        <div style={{ flex: "0 0 auto" }}><SelectField label="Month" value={sheetId || ""} onChange={(e: any) => { setSel(Number(e.target.value)); setEditing(false); setEdits({}); }} style={{ width: 170 }}
          options={(sheets || []).map((s) => ({ value: s.id, label: `${s.month} (${s.status}) · ${s._count.lines}` }))} /></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
          {!editing
            ? <button onClick={() => { setEditing(true); setEdits({}); }} disabled={!sheet?.lines || locked} title={locked ? "Unlock the month to edit" : ""}>✎ Edit</button>
            : <button onClick={saveAll} disabled={busy}>{busy ? "Saving…" : "💾 Save Changes"}</button>}
          {editing && <button onClick={cancel}>Cancel</button>}
          {fy === "FY26-27" && <button disabled={!sheet?.lines || busy || locked} onClick={clearMonth}>🗑 Clear Month</button>}
          {fy === "FY26-27" && <button disabled={!sheet || busy || locked} onClick={clearMonthFuture} title={`Clear ${sheet?.month} and every later month up to March`}>🗑 Clear → March</button>}
          <AddButton disabled={!sheet || locked} onClick={() => setAddLine({ employeeId: "", projectId: "", isBillable: true, billingMode: "HOURLY", rateUsd: 0, dayRate: 0, monthlyAmount: 0, billingDays: 0, workingDays: 0, estimateHours: 0, actualHours: 0, costUsd: 0, doubleDip: false, doubleDipIncentive: 0, allocationPct: 100, bonus: 0, deploymentStart: "", deploymentEnd: "", ctcMonthly: 0 })}>Add Resource</AddButton>
          <button disabled={!sheet || locked} onClick={openBench} title="Pick active employees not planned this month to add as Non-billable bench">🪑 Add Bench</button>
          <button disabled={!sheet} onClick={openClone}>⧉ Clone</button>
          <button disabled={!sheet} onClick={toggleLock}>{locked ? "🔓 Unlock" : "🔒 Lock"}</button>
          <button disabled={!sheet?.lines}
            onClick={() => downloadCsv(`monthly_${sheet?.month}.csv`, (sheet?.lines || []).map((l: any) => ({
              Resource: l.resourceName, Project: l.projectName, Rate: l.rateUsd, EstHrs: l.estimateHours,
              ActHrs: l.actualHours, Billing: l.billingAmount, Invoice: l.invoiceAmount, Cost: l.costUsd,
            })))}>Export CSV</button>
        </div>
      </div>

      {sheet?.totals && (() => {
        const resourceCost = resourceLines.reduce((s: number, l: any) => s + (l.costUsd || 0), 0);
        const expenseCost = expLines.reduce((s: number, l: any) => s + (l.costUsd || 0), 0);
        return <div className="grid kpi-row">
        <div className="kpi"><div className="label">Cost (Resource + Expense)</div><div className="value">{fmt(resourceCost + expenseCost)}</div><div className="sub">Resource {fmt(resourceCost)} · Expense {fmt(expenseCost)}</div></div>
        <div className="kpi"><div className="label">Billing (forecast)</div><div className="value">{fmt(sheet.totals.billing)}</div></div>
        <div className="kpi"><div className="label">Invoice (actual)</div><div className="value">{fmt(sheet.totals.invoice)}</div></div>
        <div className="kpi"><div className="label">Profit</div><div className="value">{fmt(sheet.profit)}</div></div>
      </div>; })()}

      {sheet?.lines && <div className="tabs" style={{ display: "flex", gap: 6, margin: "6px 0 12px", alignItems: "center" }}>
        <button onClick={() => setTab("res")} className={tab === "res" ? "" : "ghost"} title={resTip}>Resources ({billableCount})</button>
        <button onClick={() => setTab("exp")} className={tab === "exp" ? "" : "ghost"}>Expenses / Overheads ({expLines.length})</button>
        <span className="pill" title="Non-billable resources on GenAquarius (Bench) this month" style={{ marginLeft: 4, color: "var(--muted)" }}>🪑 Bench: {benchCount}</span>
        <span className="pill" title="Non-billable resources on an INTERNAL corporate project (Corporate / GenAquarius …)" style={{ color: "var(--muted)" }}>Corporate: {corporateCount}</span>
        {assignedNBCount > 0 && <span className="pill" title="Non-billable but ASSIGNED to a customer project (e.g. an unbilled month) — counted in neither Bench nor Corporate" style={{ color: "var(--muted)" }}>On Project (NB): {assignedNBCount}</span>}
      </div>}

      {tab === "res" && <Panel>
        {editing && <div className="ok" style={{ marginBottom: 8 }}>Editing — change Rate / Est Hrs / Act Hrs, then click <b>Save Changes</b>.</div>}
        {locked && <div className="note">🔒 This month is <b>locked</b> (read-only). Click <b>Unlock</b> to make changes. {fy !== "FY26-27" && "Prior-year months stay locked to protect historical data."}</div>}
        {editing && <div className="ok" style={{ marginBottom: 8 }}>Editing — change Rate / Est / Act Hrs, reassign a Project, or remove a line; then <b>Save Changes</b> (project/line changes save immediately).</div>}
        {!loading && sheet?.lines && <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <input placeholder="🔍 Search resources…" value={resQ} onChange={(e) => setResQ(e.target.value)} style={{ maxWidth: 280 }} />
          <FilterToggle sf={resSf} />
          <span className="label" style={{ color: "var(--muted)", fontSize: 12 }}>{resSf.view.length} row(s)</span>
        </div>}
        {loading || !sheet?.lines ? "Loading…" : <table>
          <SortableHead cols={resCols} sf={resSf} leading={<th style={{ width: 1, color: "var(--muted)" }}>#</th>} trailing={!locked ? <th>Actions</th> : undefined} />
          <tbody>{resSf.view.map((l: any, i: number) => {
            const e = edits[l.id] || {};
            return (
              <tr key={l.id} id={`ms-line-${l.id}`} {...rowSel(l.id)}>
                <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                <td>{l.resourceName}{isDoubleDip(l) && <span className="pill" title="Marked as Double Dip on this row" style={{ marginLeft: 6, color: "#fbbf24", borderColor: "#fbbf24" }}>Double Dip</span>}{(l.deploymentStart || l.deploymentEnd) && <span className="pill" title="Deployment window (prorated; benched after the end date)" style={{ marginLeft: 6, color: "var(--muted)" }}>{l.deploymentStart ? String(l.deploymentStart).slice(0, 10) : "…"} → {l.deploymentEnd ? String(l.deploymentEnd).slice(0, 10) : "…"}</span>}</td>
                <td>{l.employee?.location || "—"}</td>
                {editing
                  ? <td><select value={l.projectId || ""} onChange={(ev) => changeProject(l.id, ev.target.value)} style={{ width: 150 }}>
                      <option value="">{l.projectName || "—"}</option>
                      {(projects || []).map((p) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
                    </select></td>
                  : <td>{l.projectName}</td>}
                <td>{l.isBillable === false
                  ? <span className="pill" style={{ color: "var(--muted)" }}>Non-billable</span>
                  : <span className="pill" style={{ color: "var(--accent)" }}>Billable</span>}</td>
                {editing ? <>
                  <td className="num">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={isCadProject(l.projectId) ? "Entered in CAD; stored as USD" : "Entered in USD"}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: isCadProject(l.projectId) ? "#0a7ea4" : "var(--muted)" }}>{rateSym(l.projectId)}</span>
                      <input style={{ width: 70 }}
                        value={e.rateUsd != null ? usdToCcy(e.rateUsd, l.projectId) : usdToCcy(l.rateUsd, l.projectId)}
                        onChange={(ev) => change(l.id, "rateUsd", ccyToUsd(ev.target.value, l.projectId))} />
                    </span>
                  </td>
                  <td className="num"><input style={{ width: 60 }} value={e.estimateHours ?? d2(l.estimateHours)} onChange={(ev) => change(l.id, "estimateHours", ev.target.value)} /></td>
                  <td className="num"><input style={{ width: 60 }} value={e.actualHours ?? d2(l.actualHours)} onChange={(ev) => change(l.id, "actualHours", ev.target.value)} /></td>
                </> : <>
                  <td className="num"><Masked>{l.isBillable !== false
                    ? <span title={isCadProject(l.projectId) ? `US$${d2(l.rateUsd)}/hr` : ""}>{rateSym(l.projectId)}{usdToCcy(l.rateUsd, l.projectId)}</span>
                    : d2(l.rateUsd)}</Masked></td><td className="num">{d2(l.estimateHours)}</td><td className="num">{d2(l.actualHours)}</td>
                </>}
                <td className="num">{fmt(l.billingAmount)}</td><td className="num">{fmt(l.invoiceAmount)}</td><td className="num">{fmt(l.costUsd)}</td>
                <td>{isDoubleDip(l) ? <span className="pill" title="On 2+ billable projects this month, or has a double-dip incentive" style={{ color: "#fbbf24", borderColor: "#fbbf24" }}>Yes</span> : <span style={{ color: "var(--muted)" }}>No</span>}</td>
                {!locked && <td style={{ whiteSpace: "nowrap" }}><EditAction title="Edit row" onClick={() => openEditRow(l)} /><DeleteAction title="Remove row" onClick={() => delLine(l)} /></td>}
              </tr>
            );
          })}</tbody>
        </table>}
      </Panel>}

      {/* Expenses / Overheads — feeds the dashboard's Internal/Overhead cost & EBITDA */}
      {tab === "exp" && sheet?.lines && (() => {
        const expTotal = expLines.reduce((s: number, l: any) => s + (l.costUsd || 0), 0);
        return (
          <Panel title={`Expenses / Overheads — monthly total ${fmt(expTotal)} USD (flows into dashboard Internal Cost & EBITDA)`}>
            <div className="btn-row"><AddButton disabled={!sheet || locked} onClick={() => setAddExp({ category: EXP_CATS[0] || "Other", description: "", currency: "USD", amount: 0, expenseType: "VARIABLE", region: "INDIA", expenseScope: "ORG", projectId: "", expenseCalc: "FIXED", perResourceInr: 0, percentValue: 5, commissionProjectIds: [] })}>Add Expense</AddButton>
              <button disabled={busy} onClick={classifyExpenses} title="Apply the default Fixed/Variable classification to all expense lines">⚙ Classify Fixed/Variable</button>
              <input placeholder="🔍 Search expenses…" value={expQ} onChange={(e) => setExpQ(e.target.value)} style={{ maxWidth: 260 }} />
              <FilterToggle sf={expSf} /><span className="label" style={{ color: "var(--muted)", fontSize: 12 }}>{expSf.view.length} row(s)</span></div>
            <table>
              <SortableHead cols={EXP_COLS} sf={expSf} leading={<th style={{ width: 1, color: "var(--muted)" }}>#</th>} trailing={!locked ? <th>Actions</th> : undefined} />
              <tbody>
                {expSf.view.length === 0 ? <tr><td colSpan={!locked ? 10 : 9} style={{ color: "var(--muted)" }}>No overhead lines this month.</td></tr> :
                  expSf.view.map((l: any, i: number) => {
                    const e = edits[l.id] || {};
                    const native = l.nativeAmount ?? l.costUsd;
                    return (
                      <tr key={l.id} {...rowSel(l.id)}>
                        <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                        {editing
                          ? <td><select value={e.projectName ?? l.projectName ?? ""} onChange={(ev) => changeText(l.id, "projectName", ev.target.value)} style={{ width: 190 }}>
                              {[l.projectName, ...EXP_CATS.filter((c) => c !== l.projectName)].filter(Boolean).map((c: string) => <option key={c} value={c}>{c}</option>)}
                            </select></td>
                          : <td>{l.projectName}</td>}
                        {editing
                          ? <td><input value={e.resourceName ?? l.resourceName ?? ""} onChange={(ev) => changeText(l.id, "resourceName", ev.target.value)} /></td>
                          : <td>{l.resourceName}</td>}
                        {editing
                          ? <td><select value={e.region ?? l.region ?? ""} onChange={(ev) => changeText(l.id, "region", ev.target.value)} style={{ width: 90 }}><option value="">—</option><option value="INDIA">India</option><option value="US">US</option><option value="CANADA">Canada</option></select></td>
                          : <td>{l.region || "—"}</td>}
                        <td>{l.expenseScope === "PROJECT" ? <span className="pill" title="Allocated to a project — factors into its margin" style={{ color: "var(--accent)" }}>→ {l.project?.name || "Project"}</span> : "Org"}</td>
                        {editing
                          ? <td><select value={e.expenseType ?? l.expenseType ?? "VARIABLE"} onChange={(ev) => changeText(l.id, "expenseType", ev.target.value)} style={{ width: 100 }}><option value="VARIABLE">Variable</option><option value="FIXED">Fixed</option></select></td>
                          : <td><span className="pill">{l.expenseType === "FIXED" ? "Fixed" : "Variable"}</span></td>}
                        {editing
                          ? <td><select value={e.currency ?? l.currency ?? "USD"} onChange={(ev) => changeText(l.id, "currency", ev.target.value)} style={{ width: 80 }}>{["USD", "INR", "CAD"].map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                          : <td>{l.currency || "USD"}</td>}
                        {editing
                          ? <td className="num"><input style={{ width: 100 }} value={e.nativeAmount ?? d2(native)} onChange={(ev) => change(l.id, "nativeAmount", ev.target.value)} /></td>
                          : <td className="num">{d2(native)}</td>}
                        <td className="num">{fmt(l.costUsd)}</td>
                        {!locked && <td style={{ whiteSpace: "nowrap" }}><EditAction title="Edit row" onClick={() => openEditRow(l)} /><DeleteAction title="Remove row" onClick={() => delLine(l)} /></td>}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </Panel>
        );
      })()}

      <Modal title="Add Expense / Overhead" open={!!addExp} onClose={() => setAddExp(null)} onSave={saveExpense} busy={busy} saveLabel="Add Expense" canSave={!!addExp?.category}>
        {addExp && <div className="form-grid">
          <Select label="Category" value={addExp.category} onChange={(e: any) => setAddExp({ ...addExp, category: e.target.value })}
            options={EXP_CATS.map((c) => ({ value: c, label: c }))} />
          <Select label="Type (Fixed / Variable)" value={addExp.expenseType} onChange={(e: any) => setAddExp({ ...addExp, expenseType: e.target.value })}
            options={[{ value: "VARIABLE", label: "Variable" }, { value: "FIXED", label: "Fixed" }]} />
          <Select label="Region (Expense geography)" value={addExp.region} onChange={(e: any) => setAddExp({ ...addExp, region: e.target.value })}
            options={[{ value: "INDIA", label: "India" }, { value: "US", label: "US" }, { value: "CANADA", label: "Canada" }]} />
          <Select label="Expense Level" value={addExp.expenseScope} onChange={(e: any) => setAddExp({ ...addExp, expenseScope: e.target.value })}
            options={[{ value: "ORG", label: "Organization (overhead)" }, { value: "PROJECT", label: "Project (allocate to a project)" }]} />
          {addExp.expenseScope === "PROJECT" && <Select label="Allocate to Project" value={addExp.projectId} onChange={(e: any) => setAddExp({ ...addExp, projectId: e.target.value })}
            options={[{ value: "", label: "— select project —" }, ...pickableProjects(addExp.projectId).map((p: any) => ({ value: p.id, label: projectLabel(p) }))]} />}
          <Select label="Calculation" value={addExp.expenseCalc} onChange={(e: any) => setAddExp({ ...addExp, expenseCalc: e.target.value })}
            options={[{ value: "FIXED", label: "Fixed amount" }, { value: "PER_BILLABLE", label: "Per offshore billable resource (INR)" }, { value: "DYNAMIC", label: "Dynamic (% of employee cost)" }, { value: "PCT_PREV_INVOICE", label: "% of Project Invoice (previous month)" }]} />
          {addExp.expenseCalc === "PCT_PREV_INVOICE" ? <>
            <Input label="Percent of project invoice (%)" type="number" value={addExp.percentValue} onChange={(e: any) => setAddExp({ ...addExp, percentValue: e.target.value })} />
            <ProjectMultiSelect label="Allocate to Project(s) — commission basis" projects={projects || []} value={addExpCommIds} onChange={(ids) => setAddExp({ ...addExp, commissionProjectIds: ids })} />
            <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              {!addExpCommIds.length ? "Select at least one project above." : addExpBasis
                ? <><b>{d2(+addExp.percentValue || 0)}%</b> × {addExpBasis.prevMonth} {addExpBasis.prevFiscalYear}'s invoice total of the selected project(s) (<b>{fmt(addExpBasis.basisUsd)}</b>) = <b>{fmt(((+addExp.percentValue || 0) / 100) * addExpBasis.basisUsd)}</b>. Recomputes automatically if those invoices change.</>
                : "Loading previous month's invoice total…"}
            </div>
          </> : addExp.expenseCalc === "PER_BILLABLE" ? <>
            <Input label="Incentive per offshore billable resource (INR)" type="number" value={addExp.perResourceInr} onChange={(e: any) => setAddExp({ ...addExp, perResourceInr: e.target.value })} />
            <div className="full" style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}><Input label="Offshore Billable Headcount" type="number" value={addExp.offshoreHeadcount ?? offshoreBillableTotal} onChange={(e: any) => setAddExp({ ...addExp, offshoreHeadcount: e.target.value })} /></div>
              <button type="button" className="ghost" style={{ marginBottom: 2 }} onClick={() => setHcNamesOpen(true)}>View names</button>
            </div>
            {(() => { const hc = +(addExp.offshoreHeadcount ?? offshoreBillableTotal) || 0; const overridden = addExp.offshoreHeadcount != null && addExp.offshoreHeadcount !== "" && +addExp.offshoreHeadcount !== offshoreBillableTotal; return <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              ₹{d2(+addExp.perResourceInr || 0)} × <b>{hc}</b> offshore billable resource(s) = <b>₹{Math.round((+addExp.perResourceInr || 0) * hc).toLocaleString("en-IN")}</b> → USD. {overridden ? <>Using your <b>manual override ({hc})</b> — set it back to <b>{offshoreBillableTotal}</b> to auto-track.</> : <>Auto-tracks the month's live headcount: Offshore Billable (<b>{offshoreBillableCount}</b>) + Offshore Double Dip (<b>{offshoreDoubleDipCount}</b>) = <b>{offshoreBillableTotal}</b>; type a different number to override.</>}
            </div>; })()}
          </> : addExp.expenseCalc === "DYNAMIC" ? <>
            <Input label="Percent of employee cost (%)" type="number" value={addExp.percentValue} onChange={(e: any) => setAddExp({ ...addExp, percentValue: e.target.value })} />
            <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              <b>{d2(+addExp.percentValue || 0)}%</b> × total employee cost this month (<b>{fmt(totalEmployeeCost)}</b>) = <b>{fmt(((+addExp.percentValue || 0) / 100) * totalEmployeeCost)}</b>. Auto-recomputes as employee cost changes. (e.g. "Loading 5%")
            </div>
          </> : <>
            <Select label="Currency" value={addExp.currency} onChange={(e: any) => setAddExp({ ...addExp, currency: e.target.value })}
              options={["USD", "INR", "CAD"].map((c) => ({ value: c, label: c }))} />
            <Input label={`Amount (${addExp.currency})`} type="number" value={addExp.amount} onChange={(e: any) => setAddExp({ ...addExp, amount: e.target.value })} />
          </>}
          <Input label="Description" value={addExp.description} onChange={(e: any) => setAddExp({ ...addExp, description: e.target.value })} placeholder="e.g. Etheria Rent, GreyHR…" />
          <div className="full" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <label>Manage categories</label>
            <div className="row" style={{ gap: 6 }}>
              <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New category name" />
              <div style={{ flex: 0 }}><button className="ghost" onClick={addCategory} type="button">Add</button></div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {(expCats || []).map((c: any) => (
                <span key={c.id} className="pill">{c.name} <span style={{ cursor: "pointer", color: "var(--bad)" }} onClick={() => delCategory(c)}>✕</span></span>
              ))}
            </div>
          </div>
          <div className="subtitle full" style={{ margin: 0 }}>Amount is converted to USD (via FX rates) and added to this month only — increases Internal/Overhead cost, reduces EBITDA.</div>
        </div>}
      </Modal>


      <Modal title="Add Bench Resources" open={!!benchDlg} onClose={() => setBenchDlg(null)} onSave={addSelectedBench} busy={busy}
        saveLabel={`Add ${benchDlg?.selected?.size || 0} to Bench`} canSave={!!benchDlg?.selected?.size}>
        {benchDlg && (benchDlg.loading
          ? <div>Loading candidates…</div>
          : benchDlg.candidates.length === 0
            ? <div className="subtitle" style={{ margin: 0 }}>Every active employee is already on this month's sheet — no bench candidates.</div>
            : <div>
                <div className="subtitle" style={{ marginTop: 0 }}>Active employees <b>not</b> yet on {sheet?.month} {fy} (billable or non-billable). Select who to add as Non-billable bench (cost from CTC), or terminate.</div>
                <table>
                  <thead><tr>
                    <th><input type="checkbox" checked={benchDlg.candidates.every((c: any) => benchDlg.selected.has(c.id))} onChange={toggleAllBench} /></th>
                    <th>Name</th><th>Location</th><th>Type</th><th className="num">Monthly Cost</th><th></th>
                  </tr></thead>
                  <tbody>
                    {benchDlg.candidates.map((c: any) => (
                      <tr key={c.id}>
                        <td><input type="checkbox" checked={benchDlg.selected.has(c.id)} onChange={() => toggleBench(c.id)} /></td>
                        <td>{c.name}</td><td>{c.location || "—"}</td><td>{c.empType}</td>
                        <td className="num">{fmt(c.monthlyCost)}</td>
                        <td><button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => terminateCandidate(c)}>Terminate</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>)}
      </Modal>

      <Modal title="Add Line to Monthly Sheet" open={!!addLine} onClose={() => setAddLine(null)} onSave={saveNewLine} busy={busy} saveLabel="Add Line" canSave={!!(addLine?.employeeId && addLine?.projectId)}>
        {addLine && <div className="form-grid">
          <Select label="Employee" value={addLine.employeeId} onChange={(e: any) => pickAddLineEmployee(e.target.value)}
            options={[{ value: "", label: "— select employee —" }, ...(employees || []).map((emp) => ({ value: emp.id, label: emp.name }))]} />
          <Select label="Project" value={addLine.projectId} onChange={(e: any) => setAddLine(withDerivedHours({ ...addLine, projectId: e.target.value, subProjectId: "" }))}
            options={[{ value: "", label: "— select project —" }, ...pickableProjects().map((p) => ({ value: p.id, label: projectLabel(p) }))]} />
          {(() => {
            const subs = (projects || []).find((p) => String(p.id) === String(addLine.projectId))?.subProjects || [];
            // Optional — only shown once the chosen Project actually has Sub-Projects defined (see
            // the Project edit screen's own "Sub-Projects" panel); every other Project is unaffected.
            return subs.length > 0 && (
              <Select label="Sub-Project (optional — per-resource/per-cost-center billing)" value={addLine.subProjectId || ""} onChange={(e: any) => setAddLine({ ...addLine, subProjectId: e.target.value })}
                options={[{ value: "", label: "— none —" }, ...subs.map((sp: any) => ({ value: sp.id, label: sp.name }))]} />
            );
          })()}
          <Select label="Billable?" value={addLine.isBillable ? "BILLABLE" : "NON_BILLABLE"} onChange={(e: any) => setAddLine({ ...addLine, isBillable: e.target.value === "BILLABLE" })}
            options={[{ value: "BILLABLE", label: "Billable" }, { value: "NON_BILLABLE", label: "Non-billable (cost only)" }]} />
          {addLine.isBillable && (() => {
            const hpd = perDayOf(addLine.projectId);
            const cad = isCadProject(addLine.projectId);
            const cadRate = cad ? d2((+addLine.rateUsd || 0) / (canadaFactor || 0.71)) : 0;
            const isDay = addLine.billingMode === "DAILY";
            // Hours/days handlers mirror Edit Resource Row: Billing Days ↔ Actual Hours stay in
            // step, Estimate is independent. Editing any of them stops the working-day defaults
            // from overwriting the value.
            const setBD = (v: string) => setAddLine({ ...addLine, hoursTouched: true, billingDays: v, actualHours: d2(((+v) || 0) * hpd) });
            const setAct = (v: string) => setAddLine({ ...addLine, hoursTouched: true, actualHours: v, billingDays: +(((+v) || 0) / hpd).toFixed(2) });
            const setEst = (v: string) => setAddLine({ ...addLine, hoursTouched: true, estimateHours: v });
            const estDays = (+addLine.estimateHours || 0) ? d2((+addLine.estimateHours) / hpd) : "";
            const setEstDays = (v: string) => setAddLine({ ...addLine, hoursTouched: true, estimateHours: d2(((+v) || 0) * hpd) });
            // Revenue preview off the same Estimate/Actual the server will use, so what the
            // dialog shows is what the row lands on.
            const pvEst = +addLine.estimateHours || 0, pvAct = +addLine.actualHours || 0;
            const pvRate = isDay ? (+addLine.dayRate || 0) / hpd
              : addLine.billingMode === "MONTHLY" ? (pvEst ? (+addLine.monthlyAmount || 0) / pvEst : 0)
              : (+addLine.rateUsd || 0);
            return <>
              <Select label="Billable Type" value={addLine.billingMode} onChange={(e: any) => setAddLine(withDerivedHours({ ...addLine, billingMode: e.target.value }))}
                options={[{ value: "HOURLY", label: "Per Hour" }, { value: "DAILY", label: "Per Day" }, { value: "MONTHLY", label: "Per Month" }]} />
              {addLine.billingMode === "HOURLY" && <>
                {cad && <Input label="Rate (CAD/hr)" type="number" value={cadRate} onChange={(e: any) => setAddLine({ ...addLine, rateUsd: d2(((+e.target.value) || 0) * (canadaFactor || 0.71)) })} />}
                <Input label={cad ? "Rate (USD/hr) — auto from CAD" : "Rate (USD/hr)"} type="number" value={addLine.rateUsd} onChange={(e: any) => setAddLine({ ...addLine, rateUsd: e.target.value })} />
              </>}
              {isDay && <Input label="Day Rate (USD/day)" type="number" value={addLine.dayRate} onChange={(e: any) => setAddLine({ ...addLine, dayRate: e.target.value })} />}
              {addLine.billingMode === "MONTHLY" && <Input label="Monthly Billable Revenue (USD)" type="number" value={addLine.monthlyAmount} onChange={(e: any) => setAddLine({ ...addLine, monthlyAmount: e.target.value })} />}
              {/* Estimate vs Actual: Estimate drives Estimated Billing, Actual drives the Actual
                  Invoice. Per Day works in days; Per Hour / Per Month work in hours. */}
              {isDay ? <>
                <Input label={`Estimate Days (${addLine.workingDays || "?"} working days)`} type="number" value={estDays} onChange={(e: any) => setEstDays(e.target.value)} />
                <Input label="Billable Days (Actual)" type="number" value={addLine.billingDays ?? ""} onChange={(e: any) => setBD(e.target.value)} />
              </> : <>
                <Input label={`Billing Days (${addLine.workingDays || "?"} working days this month)`} type="number" value={addLine.billingDays ?? ""} onChange={(e: any) => setBD(e.target.value)} />
                <Input label="Estimate Hours" type="number" value={addLine.estimateHours ?? ""} onChange={(e: any) => setEst(e.target.value)} />
                <Input label="Actual / Billable Hours" type="number" value={addLine.actualHours ?? ""} onChange={(e: any) => setAct(e.target.value)} />
              </>}
              <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
                {cad && <div style={{ marginBottom: 4 }}>🇨🇦 Canadian project — billed at <b>C${d2(cadRate)}/hr</b> (= US${d2(pvRate)}/hr at factor {d2(canadaFactor)}).</div>}
                {isDay
                  ? <>Estimated Billing = Estimate Days × Day Rate (<b>{fmt((pvEst / hpd) * (+addLine.dayRate || 0))}</b>) · Actual Invoice = Billable Days × Day Rate (<b>{fmt((pvAct / hpd) * (+addLine.dayRate || 0))}</b>). Working days this month: <b>{addLine.workingDays || "?"}</b> (holidays/leave deducted).</>
                  : <>Rate <b>${d2(pvRate)}/hr</b> · Estimated Billing = Rate × Est Hours (<b>{fmt(pvRate * pvEst)}</b>) · Actual Invoice = Rate × Actual Hours (<b>{fmt(pvRate * pvAct)}</b>). Working days this month: <b>{addLine.workingDays || "?"}</b> (holidays/leave deducted).</>}
              </div>
              {(+addLine.ctcHourlyCost > 0 || +addLine.ctcDayRate > 0) && <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>
                {+addLine.ctcDayRate > 0
                  ? <>Day-rate CTC ({addLine.ctcEngagement === "VENDOR" ? "Vendor" : "W2/No Benefit"}): Cost = Day Rate <b>${d2(addLine.ctcDayRate)}/day</b> × Billable Days <b>{d2(pvAct / hpd)}</b> = <b>{fmt((+addLine.ctcDayRate) * (pvAct / hpd))}</b> (auto on save).</>
                  : <>Hourly CTC ({addLine.ctcEngagement === "VENDOR" ? "Vendor" : "W2/No Benefit"}): Cost = Rate <b>${d2(addLine.ctcHourlyCost)}/hr</b> × Billable Hours <b>{d2(pvAct)}</b> = <b>{fmt((+addLine.ctcHourlyCost) * pvAct)}</b> (auto on save).</>}
              </div>}
            </>;
          })()}
          <Input label="Deployment Start (blank = from month start)" type="date" value={addLine.deploymentStart || ""}
            onChange={(e: any) => setAddLine(applyWindow(addLine, { deploymentStart: e.target.value }, +addLine.ctcMonthly))} />
          <Input label="Deployment End (blank = open-ended)" type="date" value={addLine.deploymentEnd || ""}
            onChange={(e: any) => setAddLine(applyWindow(addLine, { deploymentEnd: e.target.value }, +addLine.ctcMonthly))} />
          {addLine.isBillable && <label className="full" style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!addLine.doubleDip} onChange={(e: any) => setAddLine({ ...addLine, doubleDip: e.target.checked, ...(e.target.checked ? {} : { doubleDipIncentive: 0 }) })} />
            <b>Double Dip Billing</b> — add an incentive on top of CTC cost
          </label>}
          {addLine.isBillable && addLine.doubleDip && <Input label="Double Dip Incentive (USD)" type="number" value={addLine.doubleDipIncentive} onChange={(e: any) => setAddLine({ ...addLine, doubleDipIncentive: e.target.value })} />}
          <Select label="Allocation (head count)" value={addLine.allocationPct} onChange={(e: any) => setAddLine({ ...addLine, allocationPct: +e.target.value })} options={[{ value: 100, label: "100% (1.0)" }, { value: 50, label: "50% (0.5)" }]} />
          <Input label="Bonus (USD)" type="number" value={addLine.bonus ?? 0} onChange={(e: any) => setAddLine({ ...addLine, bonus: e.target.value })} placeholder="0" />
          <Input label="Cost / CTC (USD / month)" type="number" value={addLine.costUsd} onChange={(e: any) => setAddLine({ ...addLine, costUsd: e.target.value })} placeholder="0 = auto from CTC" />
          {renderSegs(addLine.costSegments)}
          {(addLine.costSegments?.length > 1) && addLine.ctcMonthly != null && d2(addLine.ctcMonthly) !== d2(+addLine.costUsd) &&
            <button className="ghost full" style={{ justifySelf: "start" }} onClick={() => setAddLine({ ...addLine, costUsd: d2(addLine.ctcMonthly) })}>Set Cost to prorated total ({fmt(addLine.ctcMonthly)})</button>}
          {((+addLine.bonus || 0) > 0 || (addLine.doubleDip && +addLine.doubleDipIncentive > 0)) && <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>Total cost = CTC <b>{fmt(+addLine.costUsd || 0)}</b>{(+addLine.bonus || 0) > 0 ? <> + Bonus <b>{fmt(+addLine.bonus || 0)}</b></> : null}{(addLine.doubleDip && +addLine.doubleDipIncentive > 0) ? <> + Double Dip <b>{fmt(+addLine.doubleDipIncentive || 0)}</b></> : null} = <b>{fmt((+addLine.costUsd || 0) + (+addLine.bonus || 0) + (addLine.doubleDip ? (+addLine.doubleDipIncentive || 0) : 0))}</b>.</div>}
          {/* Cost Days — per-day cost × days, for a mid-month joiner/leaver. Same control the
              Edit Resource Row dialog offers; hourly-CTC staff cost by hours instead. */}
          {+addLine.ctcMonthly > 0 && !(+addLine.ctcHourlyCost > 0) && (() => {
            const perDay = d2((+addLine.ctcMonthly) / daysInSheetMonth);
            const costDays = perDay > 0 ? d2((+addLine.costUsd || 0) / perDay) : daysInSheetMonth;
            return <>
              <Input label={`Cost Days (of ${daysInSheetMonth})`} type="number" value={costDays}
                onChange={(e: any) => setAddLine({ ...addLine, costUsd: d2(perDay * ((+e.target.value) || 0)) })} />
              <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>Per-day cost <b>${perDay}</b> (CTC ${d2(addLine.ctcMonthly)}/mo ÷ {daysInSheetMonth} days) × <b>{costDays}</b> day(s) = <b>{fmt((+addLine.costUsd) || 0)}</b>. Set Cost Days for a part-month (joiner/leaver); full month = {daysInSheetMonth}.</div>
            </>;
          })()}
          <div className="subtitle full" style={{ margin: 0 }}>{addLine.isBillable ? <>Billable revenue from the billing type; Cost = CTC + Bonus + Double-Dip incentive. Set a <b>Deployment Start / End</b> to prorate cost and hours for a part month.</> : <>Non-billable: no revenue — only the monthly cost is recorded.</>} Leave <b>Cost</b> at 0 to auto-fill from CTC. After the <b>Deployment End</b> the person goes to the <b>Bench</b> (cost only — no estimate, no invoice) until their termination date; with "apply to future months" this is applied ahead automatically.</div>
        </div>}
      </Modal>

      <Modal title={editRow?.kind === "exp" ? "Edit Expense Row" : "Edit Resource Row"} open={!!editRow} onClose={() => setEditRow(null)} onSave={saveEditRow} busy={busy} saveLabel="Save Row">
        {editRow?.kind === "res" && <div className="form-grid">
          <div className="full"><label>Resource</label><div style={{ fontWeight: 600 }}>{editRow.line.resourceName}</div></div>
          <Select label="Project" value={editRow.projectId}
            onChange={(e: any) => { const pid = e.target.value; const pd = perDayOf(pid); setEditRow({ ...editRow, projectId: pid, subProjectId: "", billingDays: +(((+editRow.estimateHours || 0) / pd).toFixed(2)) }); }}
            options={[{ value: "", label: "— none —" }, ...pickableProjects(editRow.projectId).map((p) => ({ value: p.id, label: projectLabel(p) }))]} />
          {(() => {
            const subs = (projects || []).find((p) => String(p.id) === String(editRow.projectId))?.subProjects || [];
            return subs.length > 0 && (
              <Select label="Sub-Project (optional — per-resource/per-cost-center billing)" value={editRow.subProjectId || ""} onChange={(e: any) => setEditRow({ ...editRow, subProjectId: e.target.value })}
                options={[{ value: "", label: "— none —" }, ...subs.map((sp: any) => ({ value: sp.id, label: sp.name }))]} />
            );
          })()}
          <Select label="Billable?" value={editRow.isBillable ? "BILLABLE" : "NON_BILLABLE"} onChange={(e: any) => setEditRow({ ...editRow, isBillable: e.target.value === "BILLABLE" })}
            options={[{ value: "BILLABLE", label: "Billable" }, { value: "NON_BILLABLE", label: "Non-billable (cost only)" }]} />
          {editRow.isBillable && (() => {
            const hpd = perDayOf(editRow.projectId);
            const est = +editRow.estimateHours || 0, act = +editRow.actualHours || 0;
            const isDay = editRow.billingMode === "DAILY";
            const dayRate = +editRow.dayRate || 0;
            const rate = isDay ? dayRate / hpd
              : editRow.billingMode === "MONTHLY" ? (est ? (+editRow.monthlyAmount || 0) / est : 0)
              : (+editRow.rateUsd || 0);
            // Hourly engagements (W2/No-Benefit, Vendor): cost = CTC rate × actual billable work —
            // HOURLY → rate/hr × billable hours; DAILY → rate/day × billable days (hours ÷ hpd).
            const ctcHourly = +editRow.ctcHourlyCost > 0;
            const ctcDay = +editRow.ctcDayRate > 0;
            const costPatch = (actHours: number) =>
              ctcHourly ? { costUsd: d2((+editRow.ctcHourlyCost) * actHours) }
              : ctcDay ? { costUsd: d2((+editRow.ctcDayRate) * (hpd ? actHours / hpd : 0)) }
              : {};
            // Hours modes: Estimate independent; Billing Days ↔ Actual Hours.
            const setBD = (v: string) => { const a = +(((+v) || 0) * hpd).toFixed(2); setEditRow({ ...editRow, billingDays: v, actualHours: a, ...costPatch(a) }); };
            const setAct = (v: string) => { const a = (+v) || 0; setEditRow({ ...editRow, actualHours: v, billingDays: +(a / hpd).toFixed(2), ...costPatch(a) }); };
            // Per Day works in DAYS: Est Days drives estimate hours; Billable Days drives actual hours.
            const estDays = est ? d2(est / hpd) : ""; const billDays = editRow.billingDays ?? (act ? d2(act / hpd) : "");
            const setEstDays = (v: string) => setEditRow({ ...editRow, estimateHours: +(((+v) || 0) * hpd).toFixed(2) });
            const setBillDays = (v: string) => { const a = +(((+v) || 0) * hpd).toFixed(2); setEditRow({ ...editRow, billingDays: v, actualHours: a, ...costPatch(a) }); };
            // CAD-billed clients: enter the rate in CAD/hr; USD = CAD × Canada factor (CAD→USD).
            const canada = isCadProject(editRow.projectId);
            const cadRate = canada ? d2((+editRow.rateUsd || 0) / (canadaFactor || 0.71)) : 0;
            return <>
              <Select label="Billable Type" value={editRow.billingMode} onChange={(e: any) => setEditRow({ ...editRow, billingMode: e.target.value })}
                options={[{ value: "HOURLY", label: "Per Hour" }, { value: "DAILY", label: "Per Day" }, { value: "MONTHLY", label: "Per Month" }]} />
              {editRow.billingMode === "HOURLY" && canada && <Input label="Rate (CAD/hr)" type="number" value={cadRate}
                onChange={(e: any) => setEditRow({ ...editRow, rateUsd: d2(((+e.target.value) || 0) * (canadaFactor || 0.71)) })} />}
              {editRow.billingMode === "HOURLY" && <Input label={canada ? "Rate (USD/hr) — auto from CAD" : "Rate (USD/hr)"} type="number" value={editRow.rateUsd} onChange={(e: any) => setEditRow({ ...editRow, rateUsd: e.target.value })} />}
              {isDay && <Input label="Day Rate (USD/day)" type="number" value={editRow.dayRate} onChange={(e: any) => setEditRow({ ...editRow, dayRate: e.target.value })} />}
              {editRow.billingMode === "MONTHLY" && <Input label="Monthly Billable Revenue (USD)" type="number" value={editRow.monthlyAmount} onChange={(e: any) => setEditRow({ ...editRow, monthlyAmount: e.target.value })} />}
              {isDay ? <>
                <Input label={`Estimate Days (${editRow.workingDays || "?"} working days)`} type="number" value={estDays} onChange={(e: any) => setEstDays(e.target.value)} />
                <Input label="Billable Days (Actual)" type="number" value={billDays} onChange={(e: any) => setBillDays(e.target.value)} />
              </> : <>
                <Input label={`Billing Days (${editRow.workingDays || "?"} working days)`} type="number" value={editRow.billingDays ?? ""} onChange={(e: any) => setBD(e.target.value)} />
                <Input label="Estimate Hours" type="number" value={editRow.estimateHours} onChange={(e: any) => setEditRow({ ...editRow, estimateHours: e.target.value })} />
                <Input label="Actual / Billable Hours" type="number" value={editRow.actualHours} onChange={(e: any) => setAct(e.target.value)} />
              </>}
              <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
                {canada && <div style={{ marginBottom: 4 }}>🇨🇦 Canadian project — billed at <b>C${d2(cadRate)}/hr</b> (= US${d2(rate)}/hr at factor {d2(canadaFactor)}).</div>}
                {isDay
                  ? <>Estimated Billing = Estimate Days × Day Rate (<b>{fmt((est / hpd) * dayRate)}</b>) · Actual Invoice = Billable Days × Day Rate (<b>{fmt((act / hpd) * dayRate)}</b>). Working days this month: <b>{editRow.workingDays || "?"}</b> (holidays/leave deducted).</>
                  : <>Rate <b>${d2(rate)}/hr</b> · Estimated Billing = Rate × Est Hours (<b>{fmt(rate * est)}</b>) · Actual Invoice = Rate × Actual Hours (<b>{fmt(rate * act)}</b>). Working days this month: <b>{editRow.workingDays || "?"}</b> (holidays/leave deducted).</>}
              </div>
            </>;
          })()}
          {/* Deployment window: prorates cost + hours for a part month (calendar-day based); after the
              end date the person is benched (cost only) until termination. */}
          <Input label="Deployment Start (blank = from month start)" type="date" value={editRow.deploymentStart || ""}
            onChange={(e: any) => setEditRow(applyWindow(editRow, { deploymentStart: e.target.value }, +editRow.ctcMonthly))} />
          <Input label="Deployment End (blank = open-ended)" type="date" value={editRow.deploymentEnd || ""}
            onChange={(e: any) => setEditRow(applyWindow(editRow, { deploymentEnd: e.target.value }, +editRow.ctcMonthly))} />
          {(editRow.deploymentStart || editRow.deploymentEnd) && <div className="subtitle full" style={{ margin: 0 }}>Deployed <b>{Math.round(windowFrac(editRow.deploymentStart, editRow.deploymentEnd) * 100)}%</b> of {sheet?.month} {fy}. After the end date: <b>Bench</b> — cost only, no estimate / invoice — until termination. Tick "apply to future months" on save to update later months.</div>}
          {/* Double Dip Billing: a checkbox that reveals an incentive added on TOP of the CTC/base cost. */}
          {editRow.isBillable && <label className="full" style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!editRow.doubleDip} onChange={(e: any) => setEditRow({ ...editRow, doubleDip: e.target.checked, ...(e.target.checked ? {} : { doubleDipIncentive: 0 }) })} />
            <b>Double Dip Billing</b> — add an incentive on top of CTC cost
          </label>}
          {editRow.isBillable && editRow.doubleDip && <Input label="Double Dip Incentive (USD)" type="number" value={editRow.doubleDipIncentive} onChange={(e: any) => setEditRow({ ...editRow, doubleDipIncentive: e.target.value })} />}
          <Select label="Allocation (head count)" value={editRow.allocationPct ?? 100} onChange={(e: any) => setEditRow({ ...editRow, allocationPct: +e.target.value })} options={[{ value: 100, label: "100% (1.0)" }, { value: 50, label: "50% (0.5)" }]} />
          <Input label="Bonus (USD)" type="number" value={editRow.bonus ?? 0} onChange={(e: any) => setEditRow({ ...editRow, bonus: e.target.value })} placeholder="0" />
          <Input label="Cost / CTC (USD / month)" type="number" value={editRow.costUsd} onChange={(e: any) => setEditRow({ ...editRow, costUsd: e.target.value })} />
          {editRow.kind === "res" && (editRow.costSegments?.length > 1) && <>
            {renderSegs(editRow.costSegments)}
            {editRow.proratedMonthly != null && d2(editRow.proratedMonthly) !== d2(+editRow.costUsd) &&
              <button className="ghost full" style={{ justifySelf: "start" }} onClick={() => setEditRow({ ...editRow, costUsd: d2(editRow.proratedMonthly) })}>Set Cost to prorated total ({fmt(editRow.proratedMonthly)})</button>}
          </>}
          {((+editRow.bonus || 0) > 0 || (editRow.doubleDip && +editRow.doubleDipIncentive > 0)) && <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>Total cost = CTC <b>{fmt(+editRow.costUsd || 0)}</b>{(+editRow.bonus || 0) > 0 ? <> + Bonus <b>{fmt(+editRow.bonus || 0)}</b></> : null}{(editRow.doubleDip && +editRow.doubleDipIncentive > 0) ? <> + Double Dip <b>{fmt(+editRow.doubleDipIncentive || 0)}</b></> : null} = <b>{fmt((+editRow.costUsd || 0) + (+editRow.bonus || 0) + (editRow.doubleDip ? (+editRow.doubleDipIncentive || 0) : 0))}</b>.</div>}
          {/* Day-level cost: per-day = CTC monthly ÷ days-in-month; cost = per-day × Cost Days (for mid-month joiners/leavers). */}
          {editRow.kind === "res" && +editRow.ctcMonthly > 0 && !(+editRow.ctcHourlyCost > 0) && (() => {
            const perDay = d2((+editRow.ctcMonthly) / daysInSheetMonth);
            const costDays = perDay > 0 ? d2((+editRow.costUsd || 0) / perDay) : daysInSheetMonth;
            return <>
              <Input label={`Cost Days (of ${daysInSheetMonth})`} type="number" value={costDays}
                onChange={(e: any) => setEditRow({ ...editRow, costUsd: d2(perDay * ((+e.target.value) || 0)) })} />
              <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>Per-day cost <b>${perDay}</b> (CTC ${d2(editRow.ctcMonthly)}/mo ÷ {daysInSheetMonth} days) × <b>{costDays}</b> day(s) = <b>{fmt((+editRow.costUsd) || 0)}</b>. Set Cost Days for a part-month (joiner/leaver); full month = {daysInSheetMonth}.</div>
            </>;
          })()}
          {editRow.kind === "res" && +editRow.ctcHourlyCost > 0 && <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>
            Hourly-CTC employee ({editRow.ctcEngagement === "VENDOR" ? "Vendor" : "W2/No Benefit"}): Cost = CTC rate <b>${d2(editRow.ctcHourlyCost)}/hr</b> × Billable Hours <b>{d2(editRow.actualHours)}</b> = <b>{fmt((+editRow.ctcHourlyCost) * (+editRow.actualHours || 0))}</b>. Auto-updates with billable days; still editable.
          </div>}
          {editRow.kind === "res" && +editRow.ctcDayRate > 0 && <div className="subtitle full" style={{ margin: 0, color: "var(--muted)" }}>
            Day-rate CTC employee ({editRow.ctcEngagement === "VENDOR" ? "Vendor" : "W2/No Benefit"}): Cost = Day Rate <b>${d2(editRow.ctcDayRate)}/day</b> × Billable Days <b>{d2(editRow.billingDays || 0)}</b> = <b>{fmt((+editRow.ctcDayRate) * (+editRow.billingDays || 0))}</b>. Auto-updates with billable days; still editable.
          </div>}
          <div className="subtitle full" style={{ margin: 0 }}>{editRow.isBillable ? <>Revenue is computed from the billing type. <b>Per Day</b> / <b>Per Month</b> auto-fill billing days from the month's working days (holidays deducted).</> : <>Non-billable: no revenue — only <b>Cost</b> is kept.</>} On save you'll be asked whether to apply this to later forecasted months too.</div>
        </div>}
        {editRow?.kind === "exp" && <div className="form-grid">
          <Input label="Category" value={editRow.projectName} list="exp-cat-list" placeholder="Type a new category or pick an existing one"
            onChange={(e: any) => setEditRow({ ...editRow, projectName: e.target.value })} />
          <datalist id="exp-cat-list">{EXP_CATS.map((c: string) => <option key={c} value={c} />)}</datalist>
          <Select label="Type (Fixed / Variable)" value={editRow.expenseType} onChange={(e: any) => setEditRow({ ...editRow, expenseType: e.target.value })}
            options={[{ value: "VARIABLE", label: "Variable" }, { value: "FIXED", label: "Fixed" }]} />
          <Select label="Region (Expense geography)" value={editRow.region} onChange={(e: any) => setEditRow({ ...editRow, region: e.target.value })}
            options={[{ value: "INDIA", label: "India" }, { value: "US", label: "US" }, { value: "CANADA", label: "Canada" }]} />
          <Select label="Expense Level" value={editRow.expenseScope} onChange={(e: any) => setEditRow({ ...editRow, expenseScope: e.target.value })}
            options={[{ value: "ORG", label: "Organization (overhead)" }, { value: "PROJECT", label: "Project (allocate to a project)" }]} />
          {editRow.expenseScope === "PROJECT" && <Select label="Allocate to Project" value={editRow.projectId} onChange={(e: any) => setEditRow({ ...editRow, projectId: e.target.value })}
            options={[{ value: "", label: "— select project —" }, ...pickableProjects(editRow.projectId).map((p: any) => ({ value: p.id, label: projectLabel(p) }))]} />}
          <Input label="Description" value={editRow.resourceName} onChange={(e: any) => setEditRow({ ...editRow, resourceName: e.target.value })} />
          <Select label="Calculation" value={editRow.expenseCalc} onChange={(e: any) => setEditRow({ ...editRow, expenseCalc: e.target.value })}
            options={[{ value: "FIXED", label: "Fixed amount" }, { value: "PER_BILLABLE", label: "Per offshore billable resource (INR)" }, { value: "DYNAMIC", label: "Dynamic (% of employee cost)" }, { value: "PCT_PREV_INVOICE", label: "% of Project Invoice (previous month)" }]} />
          {editRow.expenseCalc === "PCT_PREV_INVOICE" ? <>
            <Input label="Percent of project invoice (%)" type="number" value={editRow.percentValue} onChange={(e: any) => setEditRow({ ...editRow, percentValue: e.target.value })} />
            <ProjectMultiSelect label="Allocate to Project(s) — commission basis" projects={projects || []} value={editRowCommIds} onChange={(ids) => setEditRow({ ...editRow, commissionProjectIds: ids })} />
            <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              {!editRowCommIds.length ? "Select at least one project above." : editRowBasis
                ? <><b>{d2(+editRow.percentValue || 0)}%</b> × {editRowBasis.prevMonth} {editRowBasis.prevFiscalYear}'s invoice total of the selected project(s) (<b>{fmt(editRowBasis.basisUsd)}</b>) = <b>{fmt(((+editRow.percentValue || 0) / 100) * editRowBasis.basisUsd)}</b>. Recomputes automatically if those invoices change.</>
                : "Loading previous month's invoice total…"}
            </div>
          </> : editRow.expenseCalc === "PER_BILLABLE" ? <>
            <Input label="Incentive per offshore billable resource (INR)" type="number" value={editRow.perResourceInr} onChange={(e: any) => setEditRow({ ...editRow, perResourceInr: e.target.value })} />
            <div className="full" style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}><Input label="Offshore Billable Headcount (current)" type="number" value={editRow.offshoreHeadcount ?? ""} onChange={(e: any) => setEditRow({ ...editRow, offshoreHeadcount: e.target.value })} /></div>
              <button type="button" className="ghost" style={{ marginBottom: 2 }} onClick={() => setHcNamesOpen(true)}>View names</button>
            </div>
            {(() => {
              const hc = +(editRow.offshoreHeadcount ?? 0) || 0;
              const matchesAuto = +editRow.offshoreHeadcount === offshoreBillableTotal;
              return <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
                ₹{d2(+editRow.perResourceInr || 0)} × <b>{hc}</b> current resource(s) = <b>₹{Math.round((+editRow.perResourceInr || 0) * hc).toLocaleString("en-IN")}</b> → USD.
                <div style={{ marginTop: 6 }}>
                  Auto-compute right now: Offshore Billable (<b>{offshoreBillableCount}</b>) + Offshore Double Dip (<b>{offshoreDoubleDipCount}</b>) = <b>{offshoreBillableTotal}</b>.{" "}
                  {matchesAuto ? <>Matches the current value — will keep auto-tracking on save.</> : <>
                    Differs from the current value (<b>{hc}</b>) — saving keeps <b>{hc}</b> frozen as a manual override until you switch it.{" "}
                    <button type="button" className="ghost" style={{ padding: "2px 8px" }} onClick={() => setEditRow({ ...editRow, offshoreHeadcount: String(offshoreBillableTotal) })}>Use auto-compute ({offshoreBillableTotal})</button>
                  </>}
                </div>
              </div>;
            })()}
          </> : editRow.expenseCalc === "DYNAMIC" ? <>
            <Input label="Percent of employee cost (%)" type="number" value={editRow.percentValue} onChange={(e: any) => setEditRow({ ...editRow, percentValue: e.target.value })} />
            <div className="subtitle full" style={{ margin: 0, background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
              <b>{d2(+editRow.percentValue || 0)}%</b> × total employee cost (<b>{fmt(totalEmployeeCost)}</b>) = <b>{fmt(((+editRow.percentValue || 0) / 100) * totalEmployeeCost)}</b>. Auto-recomputes as employee cost changes.
            </div>
          </> : <>
            <Select label="Currency" value={editRow.currency} onChange={(e: any) => setEditRow({ ...editRow, currency: e.target.value })}
              options={["USD", "INR", "CAD"].map((c) => ({ value: c, label: c }))} />
            <Input label={`Amount (${editRow.currency})`} type="number" value={editRow.amount} onChange={(e: any) => setEditRow({ ...editRow, amount: e.target.value })} />
          </>}
          <div className="subtitle full" style={{ margin: 0 }}>{editRow.expenseCalc === "PER_BILLABLE" ? "Recomputed automatically as billable headcount changes, unless you override the headcount above." : editRow.expenseCalc === "PCT_PREV_INVOICE" ? "Recomputed automatically from the previous month's invoices every time this sheet is viewed." : "Amount is converted to USD via FX."} On save you'll be asked whether to apply this to later forecasted months too.</div>
        </div>}
      </Modal>

      {/* Declared AFTER the Edit/Add Expense Row modal (and every modal above) on purpose — every
          .modal-overlay shares the same z-index, so ties resolve by DOM order and a modal opened
          from INSIDE another modal (like this one, via "View names") must come later in the tree
          or it paints underneath the still-open parent and looks like it never opened until the
          parent is closed. */}
      <Modal title="Offshore Billable Headcount" open={hcNamesOpen} onClose={() => setHcNamesOpen(false)}>
        <div className="subtitle" style={{ marginTop: 0 }}>Who this month's count of <b>{offshoreBillableTotal}</b> is made up of — {sheet?.month} {fy}.</div>
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Offshore Billable ({offshoreBillableCount})</div>
          {offshoreBillableNames.length ? (
            <table style={{ width: "100%" }}><tbody>
              {offshoreBillableNames.map((n, i) => (
                <tr key={n}>
                  <td style={{ padding: "3px 8px 3px 0", color: "var(--muted)", width: 1, whiteSpace: "nowrap" }}>{i + 1}.</td>
                  <td style={{ padding: "3px 0" }}>{n}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div style={{ color: "var(--muted)" }}>—</div>}
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>+ Offshore Double Dip ({offshoreDoubleDipCount})</div>
          {offshoreDoubleDipNames.length ? (
            <table style={{ width: "100%" }}><tbody>
              {offshoreDoubleDipNames.map((n, i) => (
                <tr key={n}>
                  <td style={{ padding: "3px 8px 3px 0", color: "var(--muted)", width: 1, whiteSpace: "nowrap" }}>{i + 1}.</td>
                  <td style={{ padding: "3px 0" }}>{n}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div style={{ color: "var(--muted)" }}>—</div>}
          <div className="subtitle" style={{ margin: "4px 0 0" }}>Double dip resources are already counted once above — this is their 2nd billable slot.</div>
        </div>
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 8, fontWeight: 600 }}>Total: {offshoreBillableCount} + {offshoreDoubleDipCount} = {offshoreBillableTotal}</div>
      </Modal>

      <Modal title={`Clone "${sheet?.month} ${sheet?.fiscalYear}" to…`} open={!!clone} onClose={() => setClone(null)} onSave={doClone} busy={busy} saveLabel={clone?.spreadFuture ? "Spread to all future" : "Clone Sheet"}>
        {clone && <div className="form-grid">
          <label className="full" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!clone.spreadFuture} onChange={(e) => setClone({ ...clone, spreadFuture: e.target.checked })} />
            <b>Spread to all later months of {sheet?.fiscalYear} (→ March)</b> — overwrite every editable month after {sheet?.month}
          </label>
          {!clone.spreadFuture && <>
            <Select label="Target Fiscal Year" value={clone.targetFiscalYear} onChange={(e: any) => setClone({ ...clone, targetFiscalYear: e.target.value })}
              options={["FY25-26", "FY26-27", "FY27-28"].map((v) => ({ value: v, label: v }))} />
            <Select label="Target Month" value={clone.targetMonth} onChange={(e: any) => setClone({ ...clone, targetMonth: e.target.value })}
              options={MS.map((m) => ({ value: m, label: m }))} />
            <label className="full" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={clone.overwrite} onChange={(e) => setClone({ ...clone, overwrite: e.target.checked })} />
              Replace target if it already exists (overwrites its rows)
            </label>
          </>}
          <div className="subtitle full" style={{ margin: 0 }}>{clone.spreadFuture
            ? <>Copies {sheet?.month}'s rows into <b>every later month up to March</b> in one go (each re-derives billing days from its own working days/holidays). Locked months are skipped.</>
            : <>Copies every row as the target month's starting values. The new sheet opens as a DRAFT you can edit.</>}</div>
        </div>}
      </Modal>
    </div>
  );
}

// ---------------- Expenses ----------------
export function Expenses() {
  const { show } = useToast();
  const [selFy] = useSelectedFy();
  const { data, loading, reload } = useFetch<any[]>(`/expenses?fy=${selFy}`, [selFy]);
  const blank = { id: null, scope: "INDIA", category: "", vendorName: "", amount: 0, currency: "INR", note: "" };
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const valid = form && form.category.trim() && +form.amount > 0;
  const save = async () => {
    if (!valid) return show("Category and a positive Amount are required", "error");
    setBusy(true);
    try { if (form.id) await api.put(`/expenses/${form.id}`, form); else await api.post("/expenses", { ...form, fiscalYear: selFy }); show("Expense saved"); setForm(null); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (x: any) => { if (!(await confirmDialog({ title: `Delete "${x.category}"?`, danger: true, confirmLabel: "Delete" }))) return; await api.del(`/expenses/${x.id}`); show("Expense deleted"); reload(); };
  return (
    <div>
      <h1>Expenses &amp; Vendors</h1><div className="subtitle">Rent, HRMS, recruiting, insurance, payroll tax, commissions, depreciation.</div>
      <div className="btn-row"><AddButton onClick={() => setForm({ ...blank })}>Add Expense</AddButton></div>
      <Panel>{loading ? "Loading…" : <DataTable rows={data || []} searchKeys={(x: any) => `${x.scope} ${x.category} ${x.vendorName}`}
        columns={[
          { key: "scope", label: "Scope" }, { key: "category", label: "Category" }, { key: "vendorName", label: "Vendor" },
          { key: "amount", label: "Amount", num: true, render: (x: any) => fmt(x.amount, x.currency) },
        ]}
        onEdit={(x) => setForm({ id: x.id, scope: x.scope, category: x.category, vendorName: x.vendorName || "", amount: x.amount, currency: x.currency, note: x.note || "" })}
        onDelete={del} />}</Panel>
      <Modal title={form?.id ? "Edit Expense" : "Add Expense"} open={!!form} onClose={() => setForm(null)} onSave={save} busy={busy} canSave={!!valid}>
        {form && <div className="form-grid">
          <Select label="Scope" value={form.scope} onChange={(e: any) => setForm({ ...form, scope: e.target.value })}
            options={["INDIA", "US_CANADA", "RESOURCING", "INTERNAL"].map((v) => ({ value: v, label: v }))} />
          <Input label="Category" required value={form.category} onChange={(e: any) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Office Rent" />
          <Input label="Vendor" value={form.vendorName} onChange={(e: any) => setForm({ ...form, vendorName: e.target.value })} />
          <Input label="Amount" required type="number" value={form.amount} onChange={(e: any) => setForm({ ...form, amount: e.target.value })} />
          <Select label="Currency" value={form.currency} onChange={(e: any) => setForm({ ...form, currency: e.target.value })}
            options={["INR", "USD", "CAD"].map((v) => ({ value: v, label: v }))} />
          <div className="full"><label>Note</label><textarea rows={2} value={form.note} onChange={(e: any) => setForm({ ...form, note: e.target.value })} /></div>
        </div>}
      </Modal>
    </div>
  );
}

// ---------------- Invoices ----------------
const MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

/**
 * useState that remembers its value in localStorage, so selections (client / project / month) survive
 * navigating away to another page and back — and a page refresh. Bad/absent JSON falls back to
 * `initial`, so a stale or hand-edited entry can never break the page.
 */
function useSticky<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw != null ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota/private mode */ } }, [key, v]);
  return [v, setV];
}
// localStorage handoff for "Send Selected as One Email" (Invoice Generated -> Email Invoices) —
// a plain key rather than React state/context since the two pages are separate route components
// with no shared parent to lift state into; Email Invoices reads+clears it once on mount.
const PENDING_BULK_SELECTION_KEY = "costing.invoice.emailBulk.pendingSelection";
const INV_COLS = [
  { key: "invoiceNo", label: "Invoice #" },
  { key: "client", label: "Client", get: (i: any) => i.client?.name },
  { key: "invoiceDate", label: "Date", get: (i: any) => i.invoiceDate },
  { key: "totalAmount", label: "Total", num: true },
  { key: "status", label: "Status" },
];
const ROLE_OPTIONS = ["Lead Developer", "Sr. Developer", "Developer", "Jr. Developer", "QA Engineer", "Sr. QA Engineer", "UI/UX Engineer", "Project Manager", "Business Analyst", "DevOps Engineer", "Data Engineer", "Architect"];
/** Role picker: a <select> of the standard roles (+ the current custom value) with a "Custom…" entry that
 *  turns the cell into a text box. A <datalist> can't do this — it hides every option that doesn't match
 *  the text already in the box, so a filled Role could never be switched from the dropdown. */
function RoleField({ value, placeholder, width, onChange }: { value: string; placeholder?: string; width: number; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(false);
  const v = (value || "").trim();
  const known = !v || ROLE_OPTIONS.includes(v);
  if (custom || !known) return (
    <input autoFocus={custom} style={{ width }} value={value || ""} placeholder={placeholder || "Type a role"} onChange={(e: any) => onChange(e.target.value)}
      onBlur={() => { if (known) setCustom(false); }} onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); if (known) setCustom(false); (e.target as any).blur(); } }} />
  );
  return (
    <select style={{ width }} value={v} title={v ? undefined : placeholder} onChange={(e: any) => { if (e.target.value === "__custom__") { onChange(""); setCustom(true); } else onChange(e.target.value); }}>
      <option value="">{placeholder ? `— ${placeholder} —` : "— no role —"}</option>
      {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
      <option value="__custom__">Custom…</option>
    </select>
  );
}

// Trigger a browser download for an in-memory Blob (used for the PDF preview / .eml draft).
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
// Extra-attachment picker shared by the single-invoice and bulk Email popups — Finance can add any
// number of supporting documents (timesheet, backup sheets, …) alongside the invoice PDF(s). Kept
// in `attachments` state as {fileName, contentType, fileData (base64)} so the same array is sent
// straight through to either /invoices/:id/send or /invoices/send-bulk.
// `existing` = attachments already persisted to InvoiceAttachment (uploaded earlier from the
// Generated Invoices table, or kept from a prior send) — shown alongside freshly-picked local
// files so nothing added once ever silently disappears from the preview again. Removing an
// `existing` one deletes it immediately (via `onRemoveExisting`), same as removing it from the
// table's own attachment list — there's exactly one stored copy, managed from either place.
function AttachmentPicker({ attachments, setAttachments, existing, onRemoveExisting }: {
  attachments: { fileName: string; contentType: string; fileData: string }[];
  setAttachments: (a: any[]) => void;
  existing?: { id: number; fileName: string }[];
  onRemoveExisting?: (id: number) => void;
}) {
  const { show } = useToast();
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    const added = [];
    for (const f of Array.from(files)) {
      try { added.push({ fileName: f.name, contentType: f.type || "application/octet-stream", fileData: await fileToBase64(f) }); }
      catch { show(`Could not read ${f.name}`, "error"); }
    }
    setAttachments([...attachments, ...added]);
  };
  return (
    <div className="full">
      <label>Additional Attachments (e.g. timesheet) — stored with the invoice once sent</label>
      <input type="file" multiple onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      {((existing?.length || 0) + attachments.length) > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {(existing || []).map((a) => (
            <div key={`existing-${a.id}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              📎 {a.fileName} <span className="subtitle" style={{ margin: 0 }}>(already saved)</span>
              <button type="button" className="ghost" style={{ padding: "1px 8px" }} onClick={() => onRemoveExisting?.(a.id)}>Remove</button>
            </div>
          ))}
          {attachments.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              📎 {a.fileName}
              <button type="button" className="ghost" style={{ padding: "1px 8px" }} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// Invoice Generated's own "supporting documents" widget under a row — the invoice PDF itself is
// always available via "View / Download PDF"; this manages the EXTRA documents (InvoiceAttachment
// rows) directly, independent of sending — upload/view/remove at any time, before or after the
// invoice has been sent. The same rows shown here are also what the Email Preview modal's
// Additional Attachments picker shows as "already saved", so either place stays in sync.
function InvoiceAttachmentsList({ invoiceId, attachments, onChanged }: { invoiceId: number; attachments?: { id: number; fileName: string }[]; onChanged: () => void }) {
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const picked = [];
      for (const f of Array.from(files)) {
        try { picked.push({ fileName: f.name, contentType: f.type || "application/octet-stream", fileData: await fileToBase64(f) }); }
        catch { show(`Could not read ${f.name}`, "error"); }
      }
      if (picked.length) { await api.post(`/invoices/${invoiceId}/attachments`, { attachments: picked }); onChanged(); }
    } catch (e: any) { show(e.message, "error"); }
    finally { setBusy(false); }
  };
  const remove = async (id: number) => {
    try { await api.del(`/invoices/attachments/${id}`); onChanged(); }
    catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
      {(attachments || []).map((a) => (
        <span key={a.id} className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <a href={api.pdfUrl(`/invoices/attachments/${a.id}`)} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>📎 {a.fileName}</a>
          <button type="button" onClick={() => remove(a.id)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1, color: "inherit" }}>✕</button>
        </span>
      ))}
      <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "2px 8px", fontSize: 11.5 }}>
        {busy ? "Uploading…" : "+ Add Attachment"}
        <input type="file" multiple disabled={busy} style={{ display: "none" }} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
      </label>
    </div>
  );
}

export function Invoices() {
  const { show } = useToast();
  const { user } = useAuth();
  // Forces a re-render on mask toggle — same reasoning as MonthlySheet's own call above.
  useMaskNumbers(user?.id);
  const { data, loading, reload } = useFetch<any[]>("/invoices");
  const { data: clients } = useFetch<any[]>("/clients");
  const { data: layouts } = useFetch<any[]>("/invoice-layouts");
  const [selFy] = useSelectedFy();
  const { data: opsSheets } = useFetch<any[]>(`/monthly?fy=${selFy}`, [selFy]); // month lock status
  const [g, setG] = useSticky<any>("costing.invoice.prepare", { clientId: "", project: "", month: "Apr" });
  const [draft, setDraft] = useState<any>(null);     // editable invoice draft before generation
  const [advOpen, setAdvOpen] = useState(false);     // ✨ Advanced Builder (wizard over the same draft)
  const [advStep, setAdvStep] = useState(0);
  const [advApplied, setAdvApplied] = useState<number | null>(null);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  // Live preview: ANY change made in the Advanced Builder re-renders the real invoice PDF on the
  // right pane (debounced 500ms; stale responses dropped; last good preview kept on errors).
  useEffect(() => {
    if (!advOpen || !draft) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob("/invoices/preview-pdf", { ...draftPayload(), skipRemember: true });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, draft]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);   // Generate is gated until hours are approved
  // "View Timesheet" (per explicit request: Finance should be able to see the generated
  // timesheet right here on Invoice Generate) — this screen works in fiscal-month-name + project-
  // name terms, but the export route needs a numeric projectId + calendar periodMonth/periodYear,
  // so resolve both from what's already on screen. FY_START_YEAR matches the "FY26-27" fiscal
  // year hardcoded elsewhere in this same component (the /monthly?fy= and /invoices/projects
  // calls above) — if that ever becomes selectable, this must be derived from the same source.
  const FY_START_YEAR = 2000 + Number(/FY(\d{2})/i.exec(getSelectedFy())?.[1] ?? 26);
  const FISCAL_MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  const fiscalToCalendar = (m: string): { month: number; year: number } | null => {
    const idx = FISCAL_MONTHS.indexOf(m);
    if (idx < 0) return null;
    return idx <= 8 ? { month: idx + 4, year: FY_START_YEAR } : { month: idx - 8, year: FY_START_YEAR + 1 };
  };
  const viewTimesheetProjectId = (clients || []).find((c: any) => String(c.id) === String(g.clientId))?.projects?.find((p: any) => p.name === g.project)?.id;
  const viewTimesheetPeriod = fiscalToCalendar(g.month);
  // Project options = the actual billable project-name groups on the sheet (lines may sit under a
  // sub-project or the client-level name), merged with the client's project records. Fetched with a
  // RAW request (not the shared api client) so a transient error can never bounce you to login.
  const [projOpts, setProjOpts] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!g.clientId || !g.month) { setProjOpts([]); return; }
      // Closed projects (old per-resource projects superseded by Sub-Projects) are excluded from
      // this fallback — they'd otherwise always show as an option even with zero billed lines,
      // since this list is seeded unconditionally from every Project record on the client.
      const recs = ((clients || []).find((c: any) => String(c.id) === String(g.clientId))?.projects || []).filter((p: any) => p.status !== "CLOSED");
      const byName = new Map<string, any>(recs.map((p: any) => [p.name, { name: p.name, billedLines: null }]));
      try {
        const res = await fetch(`/api/invoices/projects?clientId=${g.clientId}&month=${encodeURIComponent(g.month)}&fiscalYear=${getSelectedFy()}`, { credentials: "include" });
        if (res.ok) { const bill = await res.json(); for (const b of (bill || [])) byName.set(b.name, b); }
      } catch { /* keep the project-record fallback */ }
      if (!cancelled) setProjOpts([...byName.values()]);
    })();
    return () => { cancelled = true; };
  }, [g.clientId, g.month, clients]);

  // Load a fresh editable draft whenever client / project / month changes.
  const loadDraft = async (clientId: string, project: string, month: string, subProjectId?: string) => {
    setApproved(false); // re-approval required after any reload
    if (!clientId || !project || !month) { setDraft(null); return; }
    setDraftBusy(true);
    try {
      // Raw request (not the shared api client) so a transient 401/500 surfaces a real error
      // instead of bouncing to login or silently blanking.
      const spQs = subProjectId ? `&subProjectId=${encodeURIComponent(subProjectId)}` : "";
      const res = await fetch(`/api/invoices/draft?clientId=${clientId}&project=${encodeURIComponent(project)}&month=${encodeURIComponent(month)}&fiscalYear=${getSelectedFy()}${spQs}`, { credentials: "include" });
      if (!res.ok) { const t = await res.text(); let m = `HTTP ${res.status}`; try { m = JSON.parse(t).error || m; } catch { /* non-JSON */ } throw new Error(m); }
      const d = await res.json();
      setDraft({
        ...d,
        invoiceDate: (d.invoiceDate || "").slice(0, 10),
        dueDate: (d.dueDate || "").slice(0, 10),
        billingPeriodStart: (d.billingPeriodStart || "").slice(0, 10),
        billingPeriodEnd: (d.billingPeriodEnd || "").slice(0, 10),
        lineItems: (d.lineItems || []).map((x: any) => ({ ...x })),
        annexure: (d.annexure || []).map((x: any) => ({ ...x })),
      });
    } catch (e: any) { show("Couldn't load invoice draft: " + e.message, "error"); setDraft(null); } finally { setDraftBusy(false); }
  };
  useEffect(() => { loadDraft(g.clientId, g.project, g.month, g.subProjectId); /* eslint-disable-next-line */ }, [g.clientId, g.project, g.month, g.subProjectId]);
  // Sub-Projects of the chosen Project (per-resource/per-cost-center invoicing) — empty when none
  // are defined, so the picker simply doesn't show and existing combined-invoice behavior is
  // unaffected.
  const [subProjOpts, setSubProjOpts] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!g.clientId || !g.project) { setSubProjOpts([]); return; }
    api.get(`/invoices/sub-project-options?clientId=${g.clientId}&project=${encodeURIComponent(g.project)}`)
      .then((opts: any) => { if (!cancelled) setSubProjOpts(opts || []); }).catch(() => { if (!cancelled) setSubProjOpts([]); });
    return () => { cancelled = true; };
  }, [g.clientId, g.project]);

  const draftTotal = (draft?.lineItems || []).reduce((s: number, l: any) => s + (+l.amount || 0), 0);
  const setLI = (idx: number, patch: any) => setDraft((d: any) => { const items = [...d.lineItems]; items[idx] = { ...items[idx], ...patch }; return { ...d, lineItems: items }; });
  const addLI = () => setDraft((d: any) => ({ ...d, lineItems: [...d.lineItems, { description: "IT Services", hours: 0, rateUsd: 0, amount: 0 }] }));
  const rmLI = (idx: number) => setDraft((d: any) => ({ ...d, lineItems: d.lineItems.filter((_: any, i: number) => i !== idx) }));
  // Per-resource mode keeps Line Items built 1:1 FROM the Annexure (see buildLIFrom below) — any
  // Annexure edit (amount, rate, hours, etc.) must immediately rebuild Line Items too, or the
  // actually-billed amount (and everything downstream of it: the invoice total, the Monthly
  // Forecast sync on Generate) silently stays stuck at the old value even though the Annexure
  // itself shows the edit. Mirrors what setRole already does for a Role edit.
  const setAN = (idx: number, patch: any) => setDraft((d: any) => {
    const a = [...(d.annexure || [])]; a[idx] = { ...a[idx], ...patch };
    const nd = { ...d, annexure: a };
    return d.lineItemsPerResource ? { ...nd, lineItems: buildLIFrom(nd) } : nd;
  });
  const addAN = () => setDraft((d: any) => ({ ...d, annexure: [...(d.annexure || []), { resourceName: "", role: "", leave: null, billRate: 0, hours: 0, amount: 0 }] }));
  // Rebuild the Line Items from the Annexure rows: one line per resource ("IT Services - <Role>")
  // when the per-resource option is on, else the classic grouping by rate ("IT Services").
  const buildLIFrom = (d: any): any[] => {
    const hpd = +d.annexureHpd || 8;
    const rows = (d.annexure || []).filter((a: any) => (a.resourceName || "").trim() || +a.amount || +a.hours);
    let items: any[];
    if (d.lineItemsSumAll) {
      const hours = rows.reduce((s: number, a: any) => s + (+a.hours || 0), 0), amount = rows.reduce((s: number, a: any) => s + (+a.amount || 0), 0);
      const rate = hours ? d2(amount / hours) : 0;
      items = rows.length ? [{ description: "IT Services", rateUsd: rate, hours: d2(hours), dayRate: d2(rate * hpd), days: hpd ? d2(hours / hpd) : 0, amount: d2(amount) }] : [];
    } else if (d.lineItemsPerResource) {
      items = rows.map((a: any, i: number) => ({ description: `IT Services - ${(a.role || "").trim() || a.resourceName}`, resourceName: a.resourceName, lineId: a.lineId ?? null, detail: d.lineItems?.[i]?.detail || null, rateUsd: +a.billRate || 0, hours: +a.hours || 0, dayRate: d2((+a.billRate || 0) * hpd), days: hpd ? d2((+a.hours || 0) / hpd) : 0, amount: +a.amount || 0 }));
    } else {
      const byRate = new Map<number, { hours: number; amount: number }>();
      for (const a of rows) { const r = +a.billRate || 0; const g = byRate.get(r) || { hours: 0, amount: 0 }; g.hours += +a.hours || 0; g.amount += +a.amount || 0; byRate.set(r, g); }
      items = [...byRate.entries()].map(([r, g]) => ({ description: "IT Services", rateUsd: r, hours: d2(g.hours), dayRate: d2(r * hpd), days: hpd ? d2(g.hours / hpd) : 0, amount: d2(g.amount) }));
    }
    return items;
  };
  // The stored line-item description is "Service - Role" (e.g. "IT Services - Sr. Developer"); the form
  // shows it as two columns. A description without " - " is all Service (Role blank).
  const splitDesc = (desc: string) => { const s = String(desc || ""); const i = s.indexOf(" - "); return i < 0 ? { service: s, role: "" } : { service: s.slice(0, i), role: s.slice(i + 3) }; };
  const joinDesc = (service: string, role: string) => (role || "").trim() ? `${(service || "").trim()} - ${role.trim()}` : (service || "").trim();
  const setLIService = (idx: number, service: string) => setDraft((d: any) => { const items = [...d.lineItems]; const { role } = splitDesc(items[idx].description); items[idx] = { ...items[idx], description: joinDesc(service, role) }; return { ...d, lineItems: items }; });
  // Editing a Role on a line item also writes it to the matching Annexure row (per-resource mode keeps
  // the two lists 1:1), so the Role is remembered for next month's invoice.
  const setLIRole = (idx: number, role: string) => setDraft((d: any) => {
    const items = [...d.lineItems]; const { service } = splitDesc(items[idx].description);
    const aligned = d.lineItemsPerResource && (d.annexure || []).length === items.length ? d.annexure[idx] : null;
    items[idx] = { ...items[idx], description: joinDesc(service, (role || "").trim() || (aligned?.resourceName || "")) };
    let annexure = d.annexure || [];
    if (d.lineItemsPerResource && annexure.length === items.length) { annexure = [...annexure]; annexure[idx] = { ...annexure[idx], role }; }
    return { ...d, lineItems: items, annexure };
  });
  // Toggling a line-item mode rebuilds the Line Items immediately (no separate click needed).
  const setLIMode = (patch: any) => setDraft((d: any) => { const nd = { ...d, ...patch }; return { ...nd, lineItems: buildLIFrom(nd) }; });
  // Per-resource line items fall back to "IT Services - <resource name>" until a Role is typed; show that
  // as an EMPTY Role box (with the name as placeholder) so the suggestions dropdown isn't filtered away.
  const liRole = (l: any, idx: number) => {
    const { role } = splitDesc(l.description);
    const a = draft?.lineItemsPerResource && (draft.annexure || []).length === (draft.lineItems || []).length ? draft.annexure[idx] : null;
    const name = String(a?.resourceName || "").trim();
    return name && role.trim().toLowerCase() === name.toLowerCase() ? { role: "", placeholder: `role for ${name.split(/s+/)[0]}` } : { role, placeholder: "select role" };
  };
  // Editing a Role live-updates the matching "IT Services - <Role>" line when per-resource mode is on.
  const setRole = (idx: number, role: string) => setDraft((d: any) => { const a = [...(d.annexure || [])]; a[idx] = { ...a[idx], role }; const nd = { ...d, annexure: a }; return d.lineItemsPerResource ? { ...nd, lineItems: buildLIFrom(nd) } : nd; });
  const rmAN = (idx: number) => setDraft((d: any) => ({ ...d, annexure: (d.annexure || []).filter((_: any, i: number) => i !== idx) }));

  const draftPayload = () => draft && ({
    clientId: g.clientId, project: g.project, month: g.month, fiscalYear: getSelectedFy(),
    subProjectId: g.subProjectId || null,
    invoiceNo: draft.invoiceNo, invoiceDate: draft.invoiceDate, dueDate: draft.dueDate,
    billingPeriodStart: draft.billingPeriodStart, billingPeriodEnd: draft.billingPeriodEnd,
    poNumber: draft.poNumber, customerRefNo: draft.customerRefNo, paymentTerms: draft.paymentTerms, projectCode: draft.projectCode, projectTitle: draft.projectTitle,
    projectDescription: draft.projectDescription, currency: draft.currency, templateId: draft.templateId,
    billingEmail: draft.billingEmail, ccEmail: draft.ccEmail, bccEmail: draft.bccEmail, addressTo: draft.addressTo, attentionContact: draft.attentionContact, billToAddress: draft.billToAddress,
    layoutId: draft.layoutId || undefined, lineItemsPerResource: !!draft.lineItemsPerResource, lineItemsSumAll: !!draft.lineItemsSumAll, annexureHideLeaveRate: !!draft.annexureHideLeaveRate, annexureHideLeave: !!draft.annexureHideLeave, annexureHideBillRate: !!draft.annexureHideBillRate, annexureHideHours: !!draft.annexureHideHours, annexureHideRole: !!draft.annexureHideRole, annexureHide: !!draft.annexureHide, lineItemsHideHours: !!draft.lineItemsHideHours, lineItemsHideRate: !!draft.lineItemsHideRate, lineItemsDayBasis: !!draft.lineItemsDayBasis, annexureDayBasis: !!draft.annexureDayBasis, annexureSumTotal: !!draft.annexureSumTotal, lineItemsAddGst: !!draft.lineItemsAddGst, gstPercent: draft.gstPercent ?? 5, gstExclusive: !!draft.gstExclusive,
    lineItemsShowDesc: !!draft.lineItemsShowDesc, lineItemsMergeDesc: !!draft.lineItemsMergeDesc, lineItemsDesc: draft.lineItemsDesc || null,
    lineItemsShowResource: !!draft.lineItemsShowResource, lineItemsHideRole: !!draft.lineItemsHideRole, lineItemsSumTotal: !!draft.lineItemsSumTotal,
    columnLabels: draft.columnLabels && Object.keys(draft.columnLabels).length ? draft.columnLabels : undefined,
    lineItems: draft.lineItems, annexure: draft.annexure,
  });
  const previewDraftPdf = async () => {
    try { const blob = await api.postBlob("/invoices/preview-pdf", draftPayload()); window.open(URL.createObjectURL(blob), "_blank"); }
    catch (e: any) { show(e.message, "error"); }
  };
  // A LOCKED month is frozen: no approving hours and no generating invoices for it.
  const monthLocked = (opsSheets || []).find((s: any) => s.month === g.month)?.status === "LOCKED";
  const generate = async (overrideExisting?: boolean) => {
    if (!g.clientId) return show("Pick a client first", "error");
    if (monthLocked) return show(`${g.month} is locked — unlock the month to generate invoices.`, "error");
    if (!draft?.lineItems?.length) return show("Add at least one line item", "error");
    setBusy(true);
    try {
      const inv = await api.post("/invoices/generate", overrideExisting ? { ...draftPayload(), overrideExisting: true } : draftPayload());
      show(`Generated ${inv.invoiceNo} — ${inv.lineItems.length} line item(s)`); reload(); loadDraft(g.clientId, g.project, g.month);
    } catch (e: any) {
      // A manually-typed Invoice No that collides with an existing one is never silently
      // suffixed — the server asks first; confirm, then resubmit with the override flag, which
      // replaces the existing invoice (and its line items/annexure/attachments) with this one.
      if (/already exists\. Do you want to override it\?/.test(e.message)) {
        setBusy(false);
        if (await confirmDialog({ title: "Invoice number already exists", message: e.message, confirmLabel: "Override" })) return generate(true);
        return;
      }
      show(e.message, "error");
    } finally { setBusy(false); }
  };
  // Approve & Save: push the edited Annexure hours into the month's Actual/Billable Hours
  // Advanced Builder "Save as project defaults" — store every option on the PROJECT (no invoice).
  const saveAdvToProject = async () => {
    try { await api.post("/invoices/remember", draftPayload()); show("Saved — future drafts for this project open with these settings"); }
    catch (e: any) { show(e.message, "error"); }
  };
  // (updates Monthly Forecast & Actuals), then refresh the draft from the updated month.
  const approveHours = async () => {
    if (!g.clientId) return show("Pick a client first", "error");
    if (monthLocked) return show(`${g.month} is locked — unlock the month to change hours.`, "error");
    if (!(await confirmDialog({ title: "Approve & Save hours?", message: `This writes the Annexure hours into ${g.month}'s Actual / Billable Hours (and recomputes Actual Invoice + cost), updating Monthly Forecast & Actuals.`, confirmLabel: "Approve & Save" }))) return;
    setBusy(true);
    try {
      const r = await api.post("/invoices/approve-hours", { clientId: g.clientId, month: g.month, fiscalYear: getSelectedFy(), annexure: draft.annexure });
      show(`Approved — synced Actual/Billable Hours on ${r.updated} line(s) in ${r.month}`);
      // Do NOT reload the draft here — that would discard any values the user overrode
      // (invoice date/no, PO, description, etc.). The on-screen draft already matches what was saved.
      setApproved(true); // unlock Generate
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div>
      <h1>Invoices</h1><div className="subtitle">Review &amp; edit the draft, preview the PDF, then generate · sequential per client. Generated, sent and paid invoices live on <b>Existing Invoice</b> in the left nav.</div>
      <Panel title="Prepare Invoice" style={{ marginBottom: 14 }}>
        <div className="row">
          <SelectField label="Client" value={g.clientId} onChange={(e: any) => setG({ ...g, clientId: e.target.value, project: "" })}
            options={[{ value: "", label: "— select client —" }, ...(clients || []).map((c) => ({ value: c.id, label: c.name }))]} />
          <SelectField label="Project" value={g.project} onChange={(e: any) => setG({ ...g, project: e.target.value, subProjectId: "" })}
            options={[{ value: "", label: g.clientId ? "— select project —" : "— select client first —" }, ...projOpts.map((p: any) => ({ value: p.name, label: p.billedLines != null ? `${p.name} · ${p.billedLines} billed` : p.name }))]} />
          <SelectField label="Month" value={g.month} onChange={(e: any) => setG({ ...g, month: e.target.value })}
            options={MONTHS.map((m) => ({ value: m, label: m }))} />
          <div style={{ flex: 0 }}><label>&nbsp;</label><button className="ghost" onClick={() => loadDraft(g.clientId, g.project, g.month, g.subProjectId)} disabled={!g.clientId || !g.project || draftBusy}>↺ Reset to billed</button></div>
        </div>
        {subProjOpts.length > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            <SelectField label="Sub-Project (optional — one resource/cost-center's own invoice instead of the combined whole)" value={g.subProjectId || ""} onChange={(e: any) => setG({ ...g, subProjectId: e.target.value })}
              options={[{ value: "", label: "— combined (all resources) —" }, ...subProjOpts.map((sp: any) => ({ value: sp.id, label: sp.name }))]} />
          </div>
        )}
        {!g.clientId ? <div className="subtitle" style={{ marginTop: 8 }}>Pick a <b>client</b>, then a <b>project</b> and <b>month</b> with billable hours.</div>
          : !g.project ? <div className="subtitle" style={{ marginTop: 8 }}>Now pick a <b>project</b> for this client.</div>
          : draftBusy ? <div style={{ marginTop: 12 }}>Loading draft…</div>
          : !draft ? null
          : <div style={{ marginTop: 12 }}>
            {(draft.lineItems?.length === 0) && <div className="note" style={{ marginBottom: 12 }}>
              <b>No billable line items for {g.project || "this project"} in {g.month}.</b>{" "}
              {!draft.diag?.sheetFound ? <>There's no monthly sheet for {g.month} yet.</>
                : (draft.diag?.byProject?.length ? <>
                    This client's billable resource lines this month are under:
                    <ul style={{ margin: "6px 0 0 18px" }}>
                      {draft.diag.byProject.map((p: any, i: number) => <li key={i}><b>{p.projectName}</b> — {p.billedLines} billed line(s) {p.billableAmount > 0 ? `(${fmt(p.billableAmount)})` : "(0 billable amount — hours/rate not entered)"}</li>)}
                    </ul>
                    Pick the matching <b>Project</b> above (e.g. <b>{draft.diag.byProject[0]?.projectName}</b>), or enter Actual hours on the Monthly sheet so the line is billed.
                  </> : <>No billable resource lines (Actual Hours × Rate &gt; 0) exist for this client in {g.month}. Add hours on the Monthly Forecast &amp; Actuals sheet first.</>)}
            </div>}
            {/* Visual-only currency callout — no logic here, just so Rate/Amount fields below
                aren't mistaken for USD on a CAD-billed project (or vice versa). */}
            <div className="note" style={{ marginBottom: 12, borderColor: draft.currency === "CAD" ? "#0a7ea4" : undefined, color: draft.currency === "CAD" ? "#0a7ea4" : undefined }}>
              💱 This invoice bills in <b>{draft.currency || "USD"}</b> — every Rate / Day Rate / Amount field below (Line Items, Annexure, Approve &amp; Save Hours) is entered and shown in <b>{draft.currency || "USD"}</b>, not USD{draft.currency === "CAD" ? " (Monthly Forecast still stores it in USD internally and converts automatically)." : "."}
            </div>
            {/* Invoice details (editable) */}
            <div className="label" style={{ marginBottom: 6 }}>Invoice details</div>
            <div className="form-grid">
              <Input label="Invoice No" value={draft.invoiceNo} onChange={(e: any) => setDraft({ ...draft, invoiceNo: e.target.value })} />
              <Select label="Invoice Layout" value={draft.layoutId || ""} onChange={(e: any) => setDraft({ ...draft, layoutId: e.target.value })}
                options={[{ value: "", label: "— default —" }, ...(layouts || []).map((l: any) => ({ value: l.id, label: l.name + (l.isDefault ? " (default)" : "") }))]} />
              <Input label="Invoice Date" type="date" value={draft.invoiceDate} onChange={(e: any) => setDraft({ ...draft, invoiceDate: e.target.value })} />
              <Input label="Due Date" type="date" value={draft.dueDate} onChange={(e: any) => setDraft({ ...draft, dueDate: e.target.value })} />
              <Input label="Payment Terms" value={draft.paymentTerms || ""} onChange={(e: any) => setDraft({ ...draft, paymentTerms: e.target.value })} placeholder="from Project — e.g. Net 30 Days (blank = hidden)" />
              <Input label="Project Code" value={draft.projectCode || ""} onChange={(e: any) => setDraft({ ...draft, projectCode: e.target.value })} placeholder="from Project — editable" />
              <Input label="Project Title" value={draft.projectTitle || ""} onChange={(e: any) => setDraft({ ...draft, projectTitle: e.target.value })} placeholder="from Project — editable" />
              <Input label="PO Number" value={draft.poNumber || ""} onChange={(e: any) => setDraft({ ...draft, poNumber: e.target.value })} placeholder="from Project — editable" />
              <Input label="Customer Reference No" value={draft.customerRefNo || ""} onChange={(e: any) => setDraft({ ...draft, customerRefNo: e.target.value })} placeholder="from Project — editable" />
              <Input label="Service Description" value={draft.projectDescription} onChange={(e: any) => setDraft({ ...draft, projectDescription: e.target.value })} />
              <Input label="Billing Period Start" type="date" value={draft.billingPeriodStart} onChange={(e: any) => setDraft({ ...draft, billingPeriodStart: e.target.value })} />
              <Input label="Billing Period End" type="date" value={draft.billingPeriodEnd} onChange={(e: any) => setDraft({ ...draft, billingPeriodEnd: e.target.value })} />
              <Input label="TO Email (AP/billing)" full value={draft.billingEmail || ""} onChange={(e: any) => setDraft({ ...draft, billingEmail: e.target.value })} placeholder="from Project — editable, comma-separated" />
              <Input label="CC Email (AP/billing)" full value={draft.ccEmail || ""} onChange={(e: any) => setDraft({ ...draft, ccEmail: e.target.value })} placeholder="from Project — editable, comma-separated" />
              <Input label="BCC Email (AP/billing)" full value={draft.bccEmail || ""} onChange={(e: any) => setDraft({ ...draft, bccEmail: e.target.value })} placeholder="from Project — editable, comma-separated" />
              <Input label="Email Address To" value={draft.addressTo || ""} onChange={(e: any) => setDraft({ ...draft, addressTo: e.target.value })} placeholder="AP Team — used in the invoice email greeting" />
              <Input label="Attention Contact(s)" value={draft.attentionContact || ""} onChange={(e: any) => setDraft({ ...draft, attentionContact: e.target.value })} placeholder="from Project — editable" />
              <div className="full"><label>Bill-To Address</label><textarea rows={2} value={draft.billToAddress || ""} onChange={(e: any) => setDraft({ ...draft, billToAddress: e.target.value })} /></div>
            </div>
            {/* Line items (editable) */}
            <div className="label" style={{ margin: "12px 0 6px" }}>Service <span style={{ color: "var(--muted)", fontWeight: 400 }}>— line items (printed as "Service - Role")</span></div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsDayBasis} onChange={(e: any) => setDraft({ ...draft, lineItemsDayBasis: e.target.checked })} />
              Use <b>Day Rate &amp; Days</b> on Line Items (instead of Rate &amp; Hours) — {(+draft.annexureHpd || 8)}h/day
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsHideHours} onChange={(e: any) => setDraft({ ...draft, lineItemsHideHours: e.target.checked })} />
              Hide <b>{draft.lineItemsDayBasis ? "Days" : "Hours"}</b> column on this invoice's Line Items
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsHideRate} onChange={(e: any) => setDraft({ ...draft, lineItemsHideRate: e.target.checked })} />
              Hide <b>{draft.lineItemsDayBasis ? "Day Rate" : "Rate"}</b> column on this invoice's Line Items
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsPerResource} onChange={(e: any) => setLIMode({ lineItemsPerResource: e.target.checked, lineItemsSumAll: e.target.checked ? false : draft.lineItemsSumAll })} />
              <b>One line item per resource</b> — "IT Services - &lt;Role&gt;" (edit the Role here or in the Annexure — they stay in step)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsSumAll} onChange={(e: any) => setLIMode({ lineItemsSumAll: e.target.checked, lineItemsPerResource: e.target.checked ? false : draft.lineItemsPerResource })} />
              <b>Sum all as ONE "IT Services" row</b> — total hours, blended rate, total amount
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 6px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsAddGst} onChange={(e: any) => setDraft({ ...draft, lineItemsAddGst: e.target.checked })} />
              <b>Add GST</b> at <input type="number" style={{ width: 56 }} value={draft.gstPercent ?? 5} onChange={(e: any) => setDraft({ ...draft, gstPercent: e.target.value })} /> % <select style={{ width: "auto" }} value={draft.gstExclusive ? "EXCL" : "INCL"} onClick={(e: any) => e.stopPropagation()} onChange={(e: any) => setDraft({ ...draft, gstExclusive: e.target.value === "EXCL" })}><option value="INCL">Include — GST inside the amounts (backed out)</option><option value="EXCL">Exclude — GST added on top of the total</option></select>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsShowDesc} onChange={(e: any) => setDraft({ ...draft, lineItemsShowDesc: e.target.checked })} />
              <b>Description column</b> on this invoice's Line Items (remembered for next month)
            </label>
            {!!draft.lineItemsShowDesc && <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 6px", paddingLeft: 22 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsMergeDesc} onChange={(e: any) => setDraft({ ...draft, lineItemsMergeDesc: e.target.checked })} />
              One <b>merged cell</b> — a single Description spanning ALL resource rows
            </label>}
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsShowResource} onChange={(e: any) => setDraft({ ...draft, lineItemsShowResource: e.target.checked })} />
              <b>Resource column</b> — replace Service with each resource's name (like the Annexure)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsHideRole} onChange={(e: any) => setDraft({ ...draft, lineItemsHideRole: e.target.checked })} />
              Hide <b>Role</b> on this invoice's Line Items (the PDF prints the Service text alone)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 2px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.lineItemsSumTotal} onChange={(e: any) => setDraft({ ...draft, lineItemsSumTotal: e.target.checked })} />
              One merged <b>Total Amount</b> cell for ALL rows, centred (like the Annexure's sum total)
            </label>
            {(() => { const hideH = !!draft.lineItemsHideHours; const hideR = !!draft.lineItemsHideRate; const dayB = !!draft.lineItemsDayBasis; const hpd = +draft.annexureHpd || 8; const showD = !!draft.lineItemsShowDesc; const mergeD = !!draft.lineItemsMergeDesc; const showRes = !!draft.lineItemsShowResource; const hideRoleC = !!draft.lineItemsHideRole; const lc = 3 + (hideH ? 0 : 1) + (hideR ? 0 : 1) + (showD ? 1 : 0) - (hideRoleC ? 1 : 0); const pct = +draft.gstPercent || 0; const gstX = !!draft.gstExclusive; const gst = draft.lineItemsAddGst ? (gstX ? (draftTotal * pct) / 100 : draftTotal - draftTotal / (1 + pct / 100)) : 0; const grand = gstX ? draftTotal + gst : draftTotal; return <>
            <table>
              <thead><tr><th>{showRes ? "Resource" : "Service"}</th>{!hideRoleC && <th>Role</th>}{showD && <th>Description</th>}{!hideH && <th className="num">{dayB ? "Days" : "Hours"}</th>}{!hideR && <th className="num">{dayB ? "Day Rate" : "Rate"} ({draft.currency || "USD"})</th>}<th className="num">Amount ({draft.currency || "USD"})</th><th></th></tr></thead>
              <tbody>
                {draft.lineItems.length === 0 ? <tr><td colSpan={lc + 1} style={{ color: "var(--muted)" }}>No lines — add one, or pick a month with billable hours.</td></tr> :
                  draft.lineItems.map((l: any, idx: number) => (
                    <tr key={idx}>
                      <td>{showRes
                        ? <input style={{ width: "100%", minWidth: 120 }} placeholder="Resource name" value={l.resourceName || ""} onChange={(e: any) => setLI(idx, { resourceName: e.target.value })} />
                        : <input style={{ width: "100%", minWidth: 120 }} value={splitDesc(l.description).service} onChange={(e: any) => setLIService(idx, e.target.value)} />}</td>
                      {!hideRoleC && <td>{(() => { const r = liRole(l, idx); return <RoleField width={170} value={r.role} placeholder={r.placeholder} onChange={(v) => setLIRole(idx, v)} />; })()}</td>}
                      {showD && (mergeD
                        ? (idx === 0 ? <td rowSpan={draft.lineItems.length} style={{ verticalAlign: "top" }}><textarea style={{ width: 180, minHeight: 64 }} placeholder="One description for all rows" value={draft.lineItemsDesc || ""} onChange={(e: any) => setDraft({ ...draft, lineItemsDesc: e.target.value })} /></td> : null)
                        : <td><input style={{ width: 180 }} placeholder="Description" value={l.detail || ""} onChange={(e: any) => setLI(idx, { detail: e.target.value })} /></td>)}
                      {!hideH && (dayB
                        ? <td className="num"><input type="number" style={{ width: 90, textAlign: "right" }} value={l.days ?? 0} onChange={(e: any) => { const days = +e.target.value || 0; setLI(idx, { days, hours: d2(days * hpd), amount: d2((+l.dayRate || 0) * days) }); }} /></td>
                        : <td className="num"><input type="number" style={{ width: 90, textAlign: "right" }} value={l.hours} onChange={(e: any) => { const hours = +e.target.value || 0; setLI(idx, { hours, days: hpd ? d2(hours / hpd) : 0, amount: d2(hours * (+l.rateUsd || 0)) }); }} /></td>)}
                      {!hideR && (dayB
                        ? <td className="num"><input type="number" style={{ width: 90, textAlign: "right" }} value={l.dayRate ?? 0} onChange={(e: any) => { const dayRate = +e.target.value || 0; setLI(idx, { dayRate, rateUsd: hpd ? d2(dayRate / hpd) : 0, amount: d2(dayRate * (+l.days || 0)) }); }} /></td>
                        : <td className="num"><input type="number" style={{ width: 90, textAlign: "right" }} value={l.rateUsd} onChange={(e: any) => { const rateUsd = +e.target.value || 0; setLI(idx, { rateUsd, dayRate: d2(rateUsd * hpd), amount: d2((+l.hours || 0) * rateUsd) }); }} /></td>)}
                      <td className="num"><input type="number" style={{ width: 110, textAlign: "right" }} value={l.amount} onChange={(e: any) => setLI(idx, { amount: +e.target.value || 0 })} /></td>
                      <td><button className="ghost" onClick={() => rmLI(idx)}>✕</button></td>
                    </tr>
                  ))}
                {draft.lineItemsAddGst && <tr><td colSpan={lc - 1} style={{ textAlign: "right", color: "var(--muted)" }}>{gstX ? <>+ GST ({pct}%) on subtotal {fmt(draftTotal)}</> : <>incl. GST ({pct}%) — base {fmt(draftTotal - gst)}</>}</td><td className="num" style={{ color: "var(--muted)" }}>{fmt(gst)}</td><td></td></tr>}
                <tr><td colSpan={lc - 1} style={{ textAlign: "right", fontWeight: 600 }}>Total{gstX && gst ? " (incl. GST)" : ""}</td><td className="num" style={{ fontWeight: 600 }}>{fmt(grand)}</td><td></td></tr>
              </tbody>
            </table></>; })()}
            <button className="ghost" style={{ marginTop: 6 }} onClick={addLI}>+ Add line</button>
            {/* Annexure (per-resource breakdown, editable) — shown on the invoice PDF */}
            <div className="label" style={{ margin: "14px 0 6px" }}>Annexure (per-resource breakdown)</div>
            {(() => { const hideLeave = !!draft.annexureHideLeave || !!draft.annexureHideLeaveRate; const hideRate = !!draft.annexureHideBillRate || !!draft.annexureHideLeaveRate; const hideH = !!draft.annexureHideHours; const dayB = !!draft.annexureDayBasis; const hpd = +draft.annexureHpd || 8; const hideRole = !!draft.annexureHideRole; const hideAnnex = !!draft.annexureHide; const sumT = !!draft.annexureSumTotal; const annexTotal = d2((draft.annexure || []).reduce((s: number, a: any) => s + (+a.amount || 0), 0)); const cols = 3 + (hideRole ? 0 : 1) + (hideLeave ? 0 : 1) + (hideRate ? 0 : 1) + (hideH ? 0 : 1); return <>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={dayB} onChange={(e: any) => setDraft({ ...draft, annexureDayBasis: e.target.checked })} />
              Annexure on <b>Day Rate &amp; Days</b> (instead of Bill Rate &amp; Hours) — {hpd}h/day
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={hideLeave} onChange={(e: any) => setDraft({ ...draft, annexureHideLeave: e.target.checked, annexureHideLeaveRate: false })} />
              Hide <b>Leave</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={hideRate} onChange={(e: any) => setDraft({ ...draft, annexureHideBillRate: e.target.checked, annexureHideLeaveRate: false })} />
              Hide <b>{dayB ? "Day Rate" : "Bill Rate"}</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={hideH} onChange={(e: any) => setDraft({ ...draft, annexureHideHours: e.target.checked })} />
              Hide <b>{dayB ? "Days" : "Hours"}</b> column
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.annexureHideRole} onChange={(e: any) => setDraft({ ...draft, annexureHideRole: e.target.checked })} />
              Hide <b>Role</b> column (Role already typed still drives per-resource Line Items)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.annexureHide} onChange={(e: any) => setDraft({ ...draft, annexureHide: e.target.checked })} />
              <b>Hide the whole Annexure</b> on this invoice's PDF
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 6px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!draft.annexureSumTotal} onChange={(e: any) => setDraft({ ...draft, annexureSumTotal: e.target.checked })} />
              <b>Sum all resources as one total</b> (hide per-resource amount)
            </label>
            {hideAnnex ? <div className="note" style={{ margin: "4px 0" }}>Annexure is hidden on this invoice's PDF — untick <b>Hide the whole Annexure</b> to view or edit the resource rows.</div> : <table>
              <thead><tr><th>Name of Resource</th>{!hideRole && <th>Role</th>}<th>Time Logged On</th>{!hideLeave && <th>Leave</th>}{!hideRate && <th className="num">{dayB ? "Day Rate" : "Bill Rate"} ({draft.currency || "USD"})</th>}{!hideH && <th className="num">{dayB ? "Days" : "Hours"}</th>}<th className="num">Amount ({draft.currency || "USD"})</th><th></th></tr></thead>
              <tbody>
                {(draft.annexure || []).length === 0 ? <tr><td colSpan={cols + 1} style={{ color: "var(--muted)" }}>No annexure rows.</td></tr> :
                  draft.annexure.map((a: any, idx: number) => (
                    <tr key={idx}>
                      <td><input style={{ width: "100%" }} value={a.resourceName} onChange={(e: any) => setAN(idx, { resourceName: e.target.value })} /></td>
                      {!hideRole && <td><RoleField width={160} value={a.role || ""} placeholder="e.g. Sr. Developer" onChange={(v) => setRole(idx, v)} /></td>}
                      <td><input style={{ width: 130 }} value={a.timeLoggedOn || ""} placeholder="group label" onChange={(e: any) => setAN(idx, { timeLoggedOn: e.target.value })} /></td>
                      {!hideLeave && <td><input style={{ width: 70 }} value={a.leave || ""} onChange={(e: any) => setAN(idx, { leave: e.target.value })} /></td>}
                      {!hideRate && (dayB
                        ? <td className="num"><input type="number" style={{ width: 90, textAlign: "right" }} value={a.dayRate ?? 0} onChange={(e: any) => { const dayRate = +e.target.value || 0; setAN(idx, { dayRate, billRate: hpd ? d2(dayRate / hpd) : 0, amount: d2(dayRate * (+a.days || 0)) }); }} /></td>
                        : <td className="num"><input type="number" style={{ width: 90, textAlign: "right" }} value={a.billRate} onChange={(e: any) => { const billRate = +e.target.value || 0; setAN(idx, { billRate, dayRate: d2(billRate * hpd), amount: d2(billRate * (+a.hours || 0)) }); }} /></td>)}
                      {!hideH && (dayB
                        ? <td className="num"><input type="number" style={{ width: 80, textAlign: "right" }} value={a.days ?? 0} onChange={(e: any) => { const days = +e.target.value || 0; setAN(idx, { days, hours: d2(days * hpd), amount: d2((+a.dayRate || 0) * days) }); }} /></td>
                        : <td className="num"><input type="number" style={{ width: 80, textAlign: "right" }} value={a.hours} onChange={(e: any) => { const hours = +e.target.value || 0; setAN(idx, { hours, days: hpd ? d2(hours / hpd) : 0, amount: d2((+a.billRate || 0) * hours) }); }} /></td>)}
                      {sumT
                        ? (idx === 0 ? <td className="num" rowSpan={draft.annexure.length} style={{ verticalAlign: "middle", fontWeight: 600, borderLeft: "1px solid var(--border)" }} title="One combined total (untick “Sum all resources as one total” to edit per-resource amounts)"><Masked>{annexTotal.toLocaleString()}</Masked></td> : null)
                        : <td className="num"><input type="number" style={{ width: 110, textAlign: "right" }} value={a.amount} onChange={(e: any) => setAN(idx, { amount: +e.target.value || 0 })} /></td>}
                      <td><button className="ghost" onClick={() => rmAN(idx)}>✕</button></td>
                    </tr>
                  ))}
              </tbody>
            </table>}</>; })()}
            {monthLocked && <div className="note" style={{ marginTop: 8 }}>🔒 <b>{g.month} {getSelectedFy()} is locked.</b> Approving hours and generating invoices are disabled — unlock the month in Monthly Forecast &amp; Actuals to proceed.</div>}
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="ghost" onClick={addAN}>+ Add resource</button>
              <button className="ghost" onClick={() => { setAdvStep(0); setAdvOpen(true); }}>✨ Advanced Builder</button>
              {advOpen && draft && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
              <div className="modal-card" style={{ width: "min(1560px, 97vw)", maxWidth: "min(1560px, 97vw)", height: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>{"✨ Advanced Invoice Builder — " + (g.project || "") + " · " + g.month}</h3>
                  <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
                  <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
                </div>
                <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
                <div style={{ flex: "1 1 53%", overflowY: "auto", paddingRight: 6 }}>
                {(() => {
                  const cl = draft.columnLabels || {};
                  const setCL = (t: string, k: string, v: string) => setDraft({ ...draft, columnLabels: { ...cl, [t]: { ...(cl[t] || {}), [k]: v } } });
                  const Chip = ({ i, label }: any) => <span onClick={() => setAdvStep(i)} style={{ cursor: "pointer", padding: "6px 14px", borderRadius: 16, fontSize: 13, border: "1px solid var(--border, #556)", background: advStep === i ? "#7c5cff" : "transparent", color: advStep === i ? "#fff" : "inherit", fontWeight: advStep === i ? 700 : 400 }}>{label}</span>;
                  const Cb = ({ on, set, children }: any) => <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0", cursor: "pointer" }}><input type="checkbox" style={{ width: "auto" }} checked={!!on} onChange={(e: any) => set(e.target.checked)} />{children}</label>;
                  const Ren = ({ t, k, ph }: any) => <input style={{ width: 150, marginLeft: "auto" }} placeholder={ph} title={"Printed header (blank = " + ph + ")"} value={(cl[t] || {})[k] || ""} onChange={(e: any) => setCL(t, k, e.target.value)} />;
                  const Row = ({ children }: any) => <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "4px 0", borderBottom: "1px solid rgba(128,140,170,.18)" }}>{children}</div>;
                  const PRESETS = [
                    { name: "Per-Resource + Description", desc: "Resource rows · merged Description · merged Σ Total · Annexure with Role", patch: { lineItemsPerResource: true, lineItemsSumAll: false, lineItemsShowResource: true, lineItemsHideRole: false, lineItemsShowDesc: true, lineItemsMergeDesc: true, lineItemsSumTotal: true, lineItemsHideHours: false, lineItemsHideRate: false, annexureHide: false, annexureHideRole: false } },
                    { name: "Classic Service", desc: '"IT Services - Role" grouped by rate · full Annexure below', patch: { lineItemsPerResource: false, lineItemsSumAll: false, lineItemsShowResource: false, lineItemsShowDesc: false, lineItemsMergeDesc: false, lineItemsSumTotal: false, lineItemsHideHours: false, lineItemsHideRate: false, annexureHide: false } },
                    { name: "Summary Only", desc: "ONE summed IT Services row · no Annexure", patch: { lineItemsSumAll: true, lineItemsPerResource: false, lineItemsShowResource: false, lineItemsShowDesc: false, lineItemsMergeDesc: false, lineItemsSumTotal: false, annexureHide: true } },
                    { name: "Annexure First", desc: "One summary line · detailed Annexure (Role, Rate, Hours)", patch: { lineItemsSumAll: true, lineItemsPerResource: false, lineItemsShowDesc: false, annexureHide: false, annexureHideRole: false, annexureHideHours: false, annexureHideBillRate: false, annexureHideLeaveRate: false } },
                    { name: "Milestones / Fixed Fee", desc: "Manual rows · amounts only (no hours, no rate) · no Annexure", patch: { lineItemsPerResource: false, lineItemsSumAll: false, lineItemsHideHours: true, lineItemsHideRate: true, lineItemsShowDesc: true, lineItemsMergeDesc: false, annexureHide: true } },
                    { name: "Keep current", desc: "Start from this project's current settings", patch: {} },
                  ];
                  return <>
                    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                      {["1 · Template", "2 · Sections & mode", "3 · Columns & merges", "4 · Preview · Save · Generate"].map((t, i) => <Chip key={i} i={i} label={t} />)}
                    </div>
                    {advStep === 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                      {PRESETS.map((p, i) => <div key={i} onClick={() => { setLIMode(p.patch); setAdvApplied(i); }} style={{ border: advApplied === i ? "2px solid #7c5cff" : "1px solid var(--border, #556)", borderRadius: 10, padding: 12, cursor: "pointer" }}>
                        <b>{p.name}</b>{advApplied === i && <span style={{ marginLeft: 6, fontSize: 11, color: "#7c5cff" }}>applied ✓</span>}
                        <div className="subtitle" style={{ margin: "4px 0 0" }}>{p.desc}</div>
                      </div>)}
                      <div className="subtitle" style={{ gridColumn: "1 / -1", margin: 0 }}>A template only pre-sets the switches — fine-tune in steps 2–3. Nothing is stored until you Save or Generate.</div>
                    </div>}
                    {advStep === 1 && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
                      <div>
                        <div className="label">Service (Line Items) table — rows</div>
                        <Cb on={!draft.lineItemsPerResource && !draft.lineItemsSumAll} set={() => setLIMode({ lineItemsPerResource: false, lineItemsSumAll: false })}>Grouped by rate — "IT Services" rows</Cb>
                        <Cb on={draft.lineItemsPerResource} set={() => setLIMode({ lineItemsPerResource: true, lineItemsSumAll: false })}>One line per resource</Cb>
                        <Cb on={draft.lineItemsSumAll} set={() => setLIMode({ lineItemsSumAll: true, lineItemsPerResource: false })}><b>Sum ALL resources as one total row</b></Cb>
                        <div className="label" style={{ marginTop: 12 }}>Basis & tax</div>
                        <Cb on={draft.lineItemsDayBasis} set={(v: boolean) => setDraft({ ...draft, lineItemsDayBasis: v })}>Day basis — Days × Day Rate</Cb>
                        <Cb on={draft.lineItemsAddGst} set={(v: boolean) => setDraft({ ...draft, lineItemsAddGst: v })}>Add GST at <input type="number" style={{ width: 56 }} value={draft.gstPercent ?? 5} onClick={(e: any) => e.stopPropagation()} onChange={(e: any) => setDraft({ ...draft, gstPercent: e.target.value })} /> % <select style={{ width: "auto" }} value={draft.gstExclusive ? "EXCL" : "INCL"} onClick={(e: any) => e.stopPropagation()} onChange={(e: any) => setDraft({ ...draft, gstExclusive: e.target.value === "EXCL" })}><option value="INCL">Include (inside amounts)</option><option value="EXCL">Exclude (added on top)</option></select></Cb>
                      </div>
                      <div>
                        <div className="label">Annexure table</div>
                        <Cb on={!draft.annexureHide} set={(v: boolean) => setDraft({ ...draft, annexureHide: !v })}><b>Show the Annexure section</b> (per-resource breakdown)</Cb>
                        <Cb on={draft.annexureDayBasis} set={(v: boolean) => setDraft({ ...draft, annexureDayBasis: v })}>Day basis — Days × Day Rate</Cb>
                        <Cb on={draft.annexureSumTotal} set={(v: boolean) => setDraft({ ...draft, annexureSumTotal: v })}>Sum all resources as ONE merged total cell</Cb>
                        <div className="subtitle" style={{ marginTop: 8 }}>Column-level show/hide, renames and merges are in step 3 — for BOTH tables.</div>
                      </div>
                    </div>}
                    {advStep === 2 && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
                      <div>
                        <div className="label">Service table — columns · renames · merges</div>
                        <Row><Cb on={draft.lineItemsShowResource} set={(v: boolean) => setDraft({ ...draft, lineItemsShowResource: v })}><b>Resource name</b> first column (else Service text)</Cb><Ren t="li" k="c1" ph="Name of Resource" /></Row>
                        <Row><Cb on={!draft.lineItemsHideRole} set={(v: boolean) => setDraft({ ...draft, lineItemsHideRole: !v })}>Role (printed inside the Service text)</Cb></Row>
                        <Row><Cb on={draft.lineItemsShowDesc} set={(v: boolean) => setDraft({ ...draft, lineItemsShowDesc: v })}>Description column</Cb><Ren t="li" k="desc" ph="Description" /></Row>
                        {!!draft.lineItemsShowDesc && <Row><span style={{ width: 16 }} /><Cb on={draft.lineItemsMergeDesc} set={(v: boolean) => setDraft({ ...draft, lineItemsMergeDesc: v })}>ONE merged cell for all rows, text centred</Cb></Row>}
                        {!!draft.lineItemsShowDesc && !!draft.lineItemsMergeDesc && <textarea style={{ width: "100%", minHeight: 52, margin: "6px 0" }} placeholder="One description for all rows" value={draft.lineItemsDesc || ""} onChange={(e: any) => setDraft({ ...draft, lineItemsDesc: e.target.value })} />}
                        <Row><Cb on={!draft.lineItemsHideHours} set={(v: boolean) => setDraft({ ...draft, lineItemsHideHours: !v })}>{draft.lineItemsDayBasis ? "Days" : "Hours"}</Cb><Ren t="li" k="qty" ph={draft.lineItemsDayBasis ? "Days" : "Hours"} /></Row>
                        <Row><Cb on={!draft.lineItemsHideRate} set={(v: boolean) => setDraft({ ...draft, lineItemsHideRate: !v })}>{draft.lineItemsDayBasis ? "Day Rate" : "Rate per hour"}</Cb><Ren t="li" k="rate" ph={draft.lineItemsDayBasis ? "Day Rate" : "Rate per hour"} /></Row>
                        <Row><Cb on={draft.lineItemsSumTotal} set={(v: boolean) => setDraft({ ...draft, lineItemsSumTotal: v })}>Amount → ONE merged <b>Σ total</b> cell</Cb><Ren t="li" k="amt" ph="Amount" /></Row>
                      </div>
                      <div>
                        <div className="label">Annexure table — columns · renames · merges</div>
                        <Row><span>Name of Resource (always shown)</span><Ren t="ax" k="name" ph="Name of Resource" /></Row>
                        <Row><Cb on={!draft.annexureHideRole} set={(v: boolean) => setDraft({ ...draft, annexureHideRole: !v })}>Role</Cb><Ren t="ax" k="role" ph="Role" /></Row>
                        <Row><span>Time Logged On (auto when filled)</span><Ren t="ax" k="tlo" ph="Time Logged On" /></Row>
                        <Row><Cb on={!draft.annexureHideLeave && !draft.annexureHideLeaveRate} set={(v: boolean) => setDraft({ ...draft, annexureHideLeave: !v, annexureHideLeaveRate: false })}>Leave</Cb><Ren t="ax" k="leave" ph="Leave" /></Row>
                        <Row><Cb on={!draft.annexureHideBillRate && !draft.annexureHideLeaveRate} set={(v: boolean) => setDraft({ ...draft, annexureHideBillRate: !v, annexureHideLeaveRate: false })}>{draft.annexureDayBasis ? "Day Rate" : "Bill Rate"}</Cb><Ren t="ax" k="rate" ph={draft.annexureDayBasis ? "Day Rate" : "Bill Rate"} /></Row>
                        <Row><Cb on={!draft.annexureHideHours} set={(v: boolean) => setDraft({ ...draft, annexureHideHours: !v })}>{draft.annexureDayBasis ? "Days" : "Hours"}</Cb><Ren t="ax" k="qty" ph={draft.annexureDayBasis ? "Days" : "Hours"} /></Row>
                        <Row><Cb on={draft.annexureSumTotal} set={(v: boolean) => setDraft({ ...draft, annexureSumTotal: v })}>Amount → ONE merged <b>Σ total</b> cell</Cb><Ren t="ax" k="amt" ph="Amount" /></Row>
                        <div className="subtitle" style={{ marginTop: 8 }}>Rename boxes change the printed header only — blank keeps the default.</div>
                      </div>
                    </div>}
                    {advStep === 3 && <div>
                      <div className="label">Ready — same flow, permissions & comms as the standard page</div>
                      <div className="subtitle" style={{ margin: "4px 0 12px" }}>Preview the PDF, save these settings to <b>{g.project}</b> (every future month opens pre-selected), then Approve &amp; Generate exactly as usual. Generate creates a <b>DRAFT</b> — nothing is emailed. Bill-To / Attention / AP email still auto-populate from the Client record.</div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button className="ghost" onClick={previewDraftPdf}>👁 Preview PDF</button>
                        <button className="ghost" disabled={busy} onClick={saveAdvToProject}>💾 Save as project defaults</button>
                        <button className={approved ? "ghost" : ""} onClick={approveHours} disabled={busy || monthLocked} title={monthLocked ? "Month locked" : ""}>✓ Approve &amp; Save Hours{approved ? " ✓" : ""}</button>
                        {approved && <button onClick={() => generate()} disabled={busy || monthLocked || !draft.lineItems.length}>{busy ? "Generating…" : "Generate Invoice"}</button>}
                      </div>
                    </div>}
                    <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                      {advStep > 0 && <button className="ghost" onClick={() => setAdvStep(advStep - 1)}>← Back</button>}
                      {advStep < 3 && <button onClick={() => setAdvStep(advStep + 1)}>Next →</button>}
                      <span style={{ marginLeft: "auto" }} />
                      {advStep < 3 && <button className="ghost" onClick={previewDraftPdf}>👁 Preview PDF</button>}
                      {advStep < 3 && <button className="ghost" disabled={busy} onClick={saveAdvToProject}>💾 Save as project defaults</button>}
                    </div>
                  </>;
                })()}
                </div>
                <div style={{ flex: "1 1 47%", minWidth: 400, display: "flex", border: "1px solid rgba(128,140,170,.35)", borderRadius: 8, overflow: "hidden", background: "#3c414d" }}>
                  {advPdfUrl ? <iframe title="Live invoice preview" src={advPdfUrl + "#view=FitH"} style={{ width: "100%", height: "100%", border: "none" }} />
                    : <div style={{ margin: "auto", color: "#cfd6e4" }}>Building live preview…</div>}
                </div>
                </div>
              </div>
              </div>}
              <button className="ghost" onClick={previewDraftPdf}>👁 Preview PDF</button>
              {viewTimesheetProjectId && viewTimesheetPeriod && (
                <button className="ghost" onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export-report/${viewTimesheetProjectId}?format=xlsx&periodMonth=${viewTimesheetPeriod.month}&periodYear=${viewTimesheetPeriod.year}`), "_blank")} title="The timesheet(s) submitted for this project/period, laid out using its assigned template">📄 View Timesheet</button>
              )}
              <button className={approved ? "ghost" : ""} onClick={approveHours} disabled={busy || monthLocked} title={monthLocked ? "Month locked" : ""}>✓ Approve &amp; Save Hours{approved ? " ✓" : ""}</button>
              {approved && <button onClick={() => generate()} disabled={busy || monthLocked || !draft.lineItems.length}>{busy ? "Generating…" : "Generate Invoice"}</button>}
            </div>
            <div className="subtitle" style={{ marginTop: 4, color: "var(--muted)" }}>{approved ? <><b>Hours approved.</b> Review the draft, then <b>Generate Invoice</b> to store it.</> : <>Edit Annexure <b>Hours</b>, then <b>Approve &amp; Save Hours</b> to push them into {g.month}'s Actual/Billable Hours (updates Monthly Forecast &amp; Actuals). <b>Generate appears after approval.</b></>}</div>
            <div className="subtitle" style={{ marginTop: 6 }}>Edits affect only this invoice (line items, annexure &amp; details). Bill-To, Attention &amp; AP email auto-populate from the <b>Client</b> record onto the invoice. Generate creates a <b>DRAFT</b> — nothing is emailed.</div>
          </div>}
      </Panel>

    </div>
  );
}

// ---------------- Invoice Generated (generated / sent / paid lists, per client & month) ----------------
// Split out of the Invoices page: preparing a new invoice and working the existing ones are separate jobs.
export function ExistingInvoices() {
  const { show } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Forces a re-render on mask toggle — same reasoning as MonthlySheet's own call above.
  useMaskNumbers(user?.id);
  const { data, loading, reload } = useFetch<any[]>("/invoices");
  const { data: clients } = useFetch<any[]>("/clients");
  const [emailPrev, setEmailPrev] = useState<any>(null); // { invoice, to, subject, html, attachment, loading, drafting }
  const [listClientId, setListClientId] = useSticky<string>("costing.invoice.list.clientId", ""); // filter by client ("" = all)
  const [listMonth, setListMonth] = useSticky<string>("costing.invoice.list.month", "");            // filter by month ("" = all)
  // "Send Selected as One Email" — pick 2+ rows (same client only; checking a different client's
  // row starts a fresh selection, since one email = one recipient set) and combine them via the
  // SAME grouped-send mechanism Email Invoices uses, instead of building a second implementation.
  // selectedClientId is DERIVED from the selection itself (not separate state) so it can never go
  // stale relative to what's actually checked.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const selectedClientId = selected.size ? (data || []).find((x: any) => selected.has(x.id))?.clientId : null;
  const toggleSelect = (i: any) => {
    setSelected((s) => {
      if (s.size > 0 && selectedClientId != null && String(selectedClientId) !== String(i.clientId)) return new Set([i.id]); // different client — start fresh
      const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n;
    });
  };
  const selectedRows = (data || []).filter((i: any) => selected.has(i.id));
  const selectedMonths = new Set(selectedRows.map((i: any) => i.month));
  const sendSelectedAsOne = () => {
    if (selectedMonths.size !== 1) return;
    const { clientId, month } = selectedRows[0];
    try { localStorage.setItem(PENDING_BULK_SELECTION_KEY, JSON.stringify({ clientId, month, invoiceIds: [...selected] })); } catch { /* quota/private mode — Email Invoices falls back to its own default (select all) */ }
    navigate("/email-invoices");
  };

  const openPdf = (id: number) => window.open(api.pdfUrl(`/invoices/${id}/pdf`), "_blank");
  const setStatus = async (id: number, status: string) => { await api.put(`/invoices/${id}/status`, { status }); show(`Marked ${status}`); reload(); };
  // Preview the drafted email (recipients from the client's AP/billing email, body from template).
  const previewEmail = async (i: any) => {
    setEmailPrev({ invoice: i, loading: true });
    try {
      const r = await api.post(`/invoices/${i.id}/email-preview`, {});
      setEmailPrev({ invoice: i, to: r.to || "", cc: r.cc || "", bcc: r.bcc || "", subject: r.subject, html: r.html, attachment: r.attachment, templateName: r.templateName, attachments: [], existingAttachments: r.existingAttachments || [], loading: false });
    } catch (e: any) { show(e.message, "error"); setEmailPrev(null); }
  };
  // Removes an already-persisted attachment immediately (not deferred to Send/Draft) — same
  // InvoiceAttachment row the table's own list manages, so both stay in sync.
  const removeExistingAttachment = async (id: number) => {
    try {
      await api.del(`/invoices/attachments/${id}`);
      setEmailPrev((p: any) => p ? { ...p, existingAttachments: (p.existingAttachments || []).filter((a: any) => a.id !== id) } : p);
      reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  // Download the .eml so the user sends it from their OWN Outlook — never sends anything itself
  // (that's what the separate "Send Email" button + its confirmation popup is for, below).
  const openOutlookDraft = async () => {
    const p = emailPrev; if (!p) return;
    if (!p.to?.trim()) return show("Enter at least one recipient (set the client's TO email)", "error");
    setEmailPrev({ ...p, drafting: true });
    try {
      const blob = await api.postBlob(`/invoices/${p.invoice.id}/email-draft`, { to: p.to.trim(), cc: p.cc || "", bcc: p.bcc || "", html: p.html, subject: p.subject, attachments: p.attachments || [] });
      downloadBlob(blob, `${(p.invoice.invoiceNo || "invoice").replace(/\//g, "_")}.eml`);
      show("Outlook draft downloaded — open it to review & send from your mailbox");
      setEmailPrev(null);
    } catch (e: any) { show(e.message, "error"); setEmailPrev({ ...p, drafting: false }); }
  };
  // Actually sends from the app (Finance's own mailbox) — only ever reached after the confirmation
  // popup below, never from a stray click on the button itself. Marks the invoice Sent on success.
  const sendNow = async () => {
    const p = emailPrev; if (!p) return;
    if (!p.to?.trim()) return show("Enter at least one recipient (set the client's TO email)", "error");
    const alreadySent = p.invoice.status === "SENT" || p.invoice.status === "PAID";
    if (!(await confirmDialog({
      title: `Send ${p.invoice.invoiceNo} now?`,
      message: <>
        This sends the invoice email immediately from your own mailbox to: {p.to}{p.attachments?.length ? ` with ${p.attachments.length} extra attachment(s)` : ""}. This cannot be undone.
        {alreadySent && <div style={{ marginTop: 8, color: "var(--warn, #a8650a)" }}>⚠️ {p.invoice.invoiceNo} was already marked <b>{p.invoice.status}</b> — this will send it again.</div>}
      </>,
      confirmLabel: "Send Email",
    }))) return;
    setEmailPrev({ ...p, sending: true });
    try {
      await api.post(`/invoices/${p.invoice.id}/send`, { to: p.to.trim(), cc: p.cc || "", bcc: p.bcc || "", html: p.html, subject: p.subject, attachments: p.attachments || [] });
      show(`Email sent — ${p.invoice.invoiceNo} marked Sent`);
      setEmailPrev(null); reload();
    } catch (e: any) { show(e.message, "error"); setEmailPrev({ ...p, sending: false }); }
  };
  const delInvoice = async (i: any) => {
    if (!(await confirmDialog({ title: "Delete invoice?", message: `Delete ${i.invoiceNo}? This removes its line items and annexure and cannot be undone.`, danger: true, confirmLabel: "Delete" }))) return;
    try { await api.del(`/invoices/${i.id}`); show("Invoice deleted"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };

  return (
    <div>
      <h1>Invoice Generated</h1><div className="subtitle">Every invoice already generated — filter by client &amp; month, download the PDF, draft the email, or move it Sent → Paid.</div>
      {loading ? <Panel>Loading…</Panel> : (() => {
        const byStatus = (st: string) => (data || []).filter((i: any) => i.status === st && (!listClientId || String(i.clientId) === String(listClientId)) && (!listMonth || i.month === listMonth));
        const clientName = (clients || []).find((c: any) => String(c.id) === String(listClientId))?.name;
        const row = (i: any) => (
          <tr key={i.id}>
            <td><input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleSelect(i)} title={selectedClientId != null && String(selectedClientId) !== String(i.clientId) ? "Selecting this will start a new selection (combined emails are one client at a time)" : undefined} /></td>
            <td>{i.invoiceNo}</td><td>{i.client?.name}</td><td>{fmtDate(i.invoiceDate)}</td>
            <td className="num">{fmt(i.totalAmount, i.currency)}</td>
            <td style={{ whiteSpace: "nowrap" }}>
              <button className="ghost" onClick={() => openPdf(i.id)}>View / Download PDF</button>{" "}
              <button className="ghost" onClick={() => previewEmail(i)}>Preview &amp; Draft Email</button>{" "}
              {i.status === "DRAFT" && <button className="ghost" onClick={() => setStatus(i.id, "SENT")}>Mark Sent</button>}{" "}
              {i.status === "SENT" && <button className="ghost" onClick={() => setStatus(i.id, "PAID")}>Mark Paid</button>}{" "}
              {i.status === "PAID" && <button className="ghost" onClick={() => setStatus(i.id, "SENT")}>Mark Unpaid</button>}{" "}
              <button className="ghost" onClick={() => delInvoice(i)}>Delete</button>
              <InvoiceAttachmentsList invoiceId={i.id} attachments={i.attachments} onChanged={reload} />
            </td></tr>
        );
        const tbl = (title: string, rows: any[], empty: string) => (
          <Panel title={`${title} (${rows.length})`} style={{ marginTop: 14 }}>
            {rows.length === 0 ? <div className="subtitle">{empty}</div> : <table>
              <thead><tr><th></th><th>Invoice #</th><th>Client</th><th>Date</th><th className="num">Amount</th><th>Actions</th></tr></thead>
              <tbody>{rows.map(row)}</tbody>
            </table>}
          </Panel>
        );
        return <>
          <Panel style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ margin: 0, fontWeight: 600 }}>Show invoices for client</label>
              <select value={listClientId} onChange={(e: any) => setListClientId(e.target.value)} style={{ minWidth: 220 }}>
                <option value="">All clients</option>
                {(clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <label style={{ margin: "0 0 0 12px", fontWeight: 600 }}>Month</label>
              <select value={listMonth} onChange={(e: any) => setListMonth(e.target.value)} style={{ minWidth: 120 }}>
                <option value="">All months</option>
                {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {(listClientId || listMonth) && <button className="ghost" onClick={() => { setListClientId(""); setListMonth(""); }}>Clear</button>}
              {(clientName || listMonth) && <span className="subtitle" style={{ color: "var(--muted)" }}>Showing {clientName ? <b>{clientName}</b> : "all clients"}{listMonth ? <> · <b>{listMonth}</b></> : ""}</span>}
              {selected.size >= 2 && (
                <button
                  style={{ marginLeft: "auto" }}
                  disabled={selectedMonths.size !== 1}
                  title={selectedMonths.size !== 1 ? "Select invoices from the same month to combine them into one email" : undefined}
                  onClick={sendSelectedAsOne}
                >Send Selected ({selected.size}) as One Email →</button>
              )}
              {selected.size > 0 && <button className="ghost" onClick={() => setSelected(new Set())}>Clear Selection</button>}
            </div>
          </Panel>
          {(() => {
            const scope = [clientName, listMonth].filter(Boolean).join(" · ");
            return <>
              {tbl("Generated Invoices", byStatus("DRAFT"), scope ? `No generated invoices for ${scope}.` : "No generated invoices — prepare one above.")}
              {tbl("Sent Invoices", byStatus("SENT"), scope ? `No sent invoices for ${scope}.` : "No sent invoices yet.")}
              {tbl("Paid Invoices", byStatus("PAID"), scope ? `No paid invoices for ${scope}.` : "No paid invoices yet.")}
            </>;
          })()}
        </>;
      })()}
      <Modal title={`Email Invoice ${emailPrev?.invoice?.invoiceNo || ""}`} open={!!emailPrev} onClose={() => setEmailPrev(null)} wide>
        {emailPrev?.loading ? <div style={{ padding: 16 }}>Loading preview…</div> : emailPrev && <div className="form-grid">
          <Input label="To (from client TO email — comma-separated)" full value={emailPrev.to} onChange={(e: any) => setEmailPrev({ ...emailPrev, to: e.target.value })} placeholder="ap@client.com, billing@client.com" />
          <Input label="Cc (from client CC email — comma-separated)" full value={emailPrev.cc} onChange={(e: any) => setEmailPrev({ ...emailPrev, cc: e.target.value })} placeholder="manager@client.com" />
          <Input label="Bcc (from client BCC email — comma-separated)" full value={emailPrev.bcc} onChange={(e: any) => setEmailPrev({ ...emailPrev, bcc: e.target.value })} placeholder="archive@genaquarius.com" />
          <Input label="Subject" full value={emailPrev.subject} onChange={(e: any) => setEmailPrev({ ...emailPrev, subject: e.target.value })} />
          <div className="full"><label>Template</label><div>{emailPrev.templateName || "—"}</div></div>
          <div className="full"><label>Attachment</label><div>📎 {emailPrev.attachment}</div></div>
          <AttachmentPicker attachments={emailPrev.attachments || []} setAttachments={(a) => setEmailPrev({ ...emailPrev, attachments: a })} existing={emailPrev.existingAttachments} onRemoveExisting={removeExistingAttachment} />
          <div className="full"><label>Body (editable — click in and type to change before sending/drafting)</label>
            <div
              key={emailPrev.invoice?.id}
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => setEmailPrev({ ...emailPrev, html: (e.target as HTMLDivElement).innerHTML })}
              style={{ background: "#ffffff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 10, padding: 18, lineHeight: 1.6, fontSize: 14, outline: "none", cursor: "text" }}
              dangerouslySetInnerHTML={{ __html: emailPrev.html }}
            />
          </div>
          <div className="subtitle full">
            <b>Open in Outlook (draft)</b> downloads an <b>.eml</b> (including every saved attachment) — review and send from your own mailbox, nothing leaves the app.
            <b> Send Email</b> sends it immediately from your own mailbox (after you confirm) and marks this invoice <b>Sent</b>.
          </div>
          <div className="full" style={{ display: "flex", justifyContent: "flex-end", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <button className="ghost" disabled={emailPrev.loading} onClick={() => setEmailPrev(null)}>Cancel</button>
            <button className="ghost" disabled={emailPrev.loading || !emailPrev.to?.trim() || emailPrev.drafting} onClick={openOutlookDraft}>{emailPrev.drafting ? "Preparing…" : "Open in Outlook (draft)"}</button>
            <AddButton disabled={emailPrev.loading || !emailPrev.to?.trim() || emailPrev.sending} onClick={sendNow}>{emailPrev.sending ? "Sending…" : "Send Email"}</AddButton>
          </div>
        </div>}
      </Modal>
    </div>
  );
}

// "Select an existing generated timesheet, preview it, and select it as attachment" — per
// explicit request. Reuses the EXACT same InvoiceAttachment/bulk-attachments pipeline a manually
// uploaded file already goes through (so "Open in Outlook (draft)"/"Send Email" attach it exactly
// like any other Supporting Document, no separate mailer plumbing needed) — just fetches the real
// XLSX export (engine/templateDocumentEngine.ts, same route My Timesheet's own Export buttons
// use) client-side first and uploads ITS bytes instead of a hand-picked file.
const EI_FY_START_YEAR = 2026;
const EI_FISCAL_MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
function eiFiscalToCalendar(m: string): { month: number; year: number } | null {
  const idx = EI_FISCAL_MONTHS.indexOf(m);
  if (idx < 0) return null;
  return idx <= 8 ? { month: idx + 4, year: EI_FY_START_YEAR } : { month: idx - 8, year: EI_FY_START_YEAR + 1 };
}
function AttachGeneratedTimesheet({ clientId, month, clients, busy, setBusy, reload }: { clientId: string; month: string; clients: any[] | null; busy: boolean; setBusy: (b: boolean) => void; reload: () => void }) {
  const { show } = useToast();
  // Closed projects (old per-resource projects superseded by Sub-Projects) excluded — same
  // reasoning as every other project picker on this page.
  const projects = ((clients || []).find((c: any) => String(c.id) === String(clientId))?.projects || []).filter((p: any) => p.status !== "CLOSED");
  const [projectId, setProjectId] = useState("");
  const period = eiFiscalToCalendar(month);
  if (!projects.length || !period) return null;
  const exportUrl = (format: string) => api.pdfUrl(`/timesheet-templates/export-report/${projectId}?format=${format}&periodMonth=${period.month}&periodYear=${period.year}`);
  const attach = async () => {
    if (!projectId) return show("Pick a project first", "error");
    setBusy(true);
    try {
      const res = await fetch(exportUrl("xlsx"), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const fileData = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsDataURL(blob); });
      const projName = projects.find((p: any) => String(p.id) === String(projectId))?.name || "Project";
      await api.post(`/invoices/bulk-attachments`, { clientId, month, fiscalYear: getSelectedFy(), attachments: [{ fileName: `Timesheet_${projName}_${month}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileData }] });
      show("Timesheet attached"); reload();
    } catch (e: any) { show(e.message || "Could not generate/attach the timesheet", "error"); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Attach generated timesheet:</span>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ fontSize: 11.5 }}>
        <option value="">— select project —</option>
        {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {projectId && <a href={exportUrl("pdf") + "&inline=1"} target="_blank" rel="noreferrer" className="ghost" style={{ fontSize: 11.5, padding: "2px 8px", textDecoration: "none" }}>Preview</a>}
      <button type="button" className="ghost" disabled={!projectId || busy} onClick={attach} style={{ fontSize: 11.5, padding: "2px 8px" }}>{busy ? "Attaching…" : "Attach"}</button>
    </div>
  );
}

// ---------------- Email Invoices (bundle all of a client's invoices for a month) ----------------
export function EmailInvoices() {
  const { show } = useToast();
  const { data, loading } = useFetch<any[]>("/invoices");
  const { data: clients } = useFetch<any[]>("/clients");
  // Persists across visits — same reasoning/mechanism as Invoice Generated's listClientId/listMonth.
  const [bulk, setBulk] = useSticky<any>("costing.invoice.email.bulk", { clientId: "", month: "Apr" });
  const [prev, setPrev] = useState<any>(null);
  // Individual-or-group picker — defaults to EVERY matched invoice selected (so the existing
  // "send everything this month" workflow still takes zero extra clicks), but Finance can uncheck
  // any to send a subset. Also consumes a one-shot "Send Selected as One Email" handoff from the
  // Invoice Generated page (see PENDING_BULK_SELECTION_KEY) on first load for this client+month.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const pendingSelectionRef = React.useRef<{ clientId: string; month: string; invoiceIds: number[] } | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PENDING_BULK_SELECTION_KEY);
      if (raw) {
        const pending = JSON.parse(raw);
        pendingSelectionRef.current = pending;
        localStorage.removeItem(PENDING_BULK_SELECTION_KEY);
        // Actually navigate the page to the handed-off client+month — without this, `bulk` stays
        // on its own default ({clientId:"", month:"Apr"}) forever, the equality check below never
        // matches, and the pending selection is silently discarded (the page lands empty instead
        // of pre-filled, and if Finance then picks a month by hand — e.g. still showing "Apr", or
        // whatever they land on — the preview correctly reflects THAT month, not the one they
        // meant to send, which looks like "the month is wrong" from a dead handoff, not a
        // mis-render).
        setBulk({ clientId: pending.clientId, month: pending.month });
      }
    } catch { /* ignore malformed/missing */ }
  }, []);
  const matches = (data || []).filter((i: any) => String(i.clientId) === String(bulk.clientId) && i.month === bulk.month);
  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending && String(pending.clientId) === String(bulk.clientId) && pending.month === bulk.month) {
      setSelected(new Set((pending.invoiceIds || []).filter((id: number) => matches.some((m: any) => m.id === id))));
      pendingSelectionRef.current = null; // consume once
      return;
    }
    setSelected(new Set(matches.map((m: any) => m.id)));
    // eslint-disable-next-line
  }, [bulk.clientId, bulk.month, data]);
  // Batch-level "supporting documents" — the EXTRA documents shared across every invoice in this
  // client+month batch, independent of sending — upload/view/remove at any time, before or after
  // the batch has been sent. Same underlying InvoiceAttachment rows (fanned out one per invoice in
  // the batch, see POST /invoices/bulk-attachments) the bulk Email Preview modal's Additional
  // Attachments picker shows as "already saved", so either place stays in sync. Mirrors
  // InvoiceAttachmentsList's per-invoice widget on the Existing Invoice page.
  const [batchAttachments, setBatchAttachments] = useState<{ id: number; fileName: string }[]>([]);
  const [batchAttachBusy, setBatchAttachBusy] = useState(false);
  const loadBatchAttachments = async (clientId: string, month: string) => {
    if (!clientId || !month) { setBatchAttachments([]); return; }
    try { const r = await api.post(`/invoices/bulk-attachments`, { clientId, month, fiscalYear: getSelectedFy(), attachments: [] }); setBatchAttachments(r.attachments || []); }
    catch { setBatchAttachments([]); } // e.g. no generated invoices yet for this client+month
  };
  useEffect(() => { loadBatchAttachments(bulk.clientId, bulk.month); /* eslint-disable-next-line */ }, [bulk.clientId, bulk.month]);
  const uploadBatchAttachments = async (files: FileList | null) => {
    if (!files?.length || !bulk.clientId || !bulk.month) return;
    setBatchAttachBusy(true);
    try {
      const picked = [];
      for (const f of Array.from(files)) {
        try { picked.push({ fileName: f.name, contentType: f.type || "application/octet-stream", fileData: await fileToBase64(f) }); }
        catch { show(`Could not read ${f.name}`, "error"); }
      }
      if (picked.length) { const r = await api.post(`/invoices/bulk-attachments`, { clientId: bulk.clientId, month: bulk.month, fiscalYear: getSelectedFy(), attachments: picked }); setBatchAttachments(r.attachments || []); }
    } catch (e: any) { show(e.message, "error"); }
    finally { setBatchAttachBusy(false); }
  };
  // Removes a shared attachment from every invoice in the batch at once — keeps the page-level
  // widget AND an open preview modal (if any) in sync immediately, same UX as the single-invoice
  // page's removeExistingAttachment.
  const removeBatchAttachment = async (fileName: string) => {
    try {
      await api.del(`/invoices/bulk-attachments/${encodeURIComponent(fileName)}?clientId=${bulk.clientId}&month=${encodeURIComponent(bulk.month)}&fiscalYear=${getSelectedFy()}`);
      setBatchAttachments((cur) => cur.filter((a) => a.fileName !== fileName));
      setPrev((p: any) => p ? { ...p, existingAttachments: (p.existingAttachments || []).filter((a: any) => a.fileName !== fileName) } : p);
    } catch (e: any) { show(e.message, "error"); }
  };

  const previewBulk = async () => {
    if (!bulk.clientId || !bulk.month) return show("Select a client and month", "error");
    if (!selected.size) return show("Select at least one invoice", "error");
    setPrev({ loading: true });
    try {
      const r = await api.post(`/invoices/email-preview-bulk`, { clientId: bulk.clientId, month: bulk.month, selectedInvoiceIds: [...selected] });
      setPrev({ to: r.to || "", cc: r.cc || "", bcc: r.bcc || "", subject: r.subject, html: r.html, count: r.count, attachment: `${r.count} invoice PDF(s): ${(r.invoiceNos || []).join(", ")}`, templateName: r.templateName, attachments: [], existingAttachments: r.existingAttachments || [], perInvoiceAttachments: r.perInvoiceAttachments || [], loading: false });
    } catch (e: any) { show(e.message, "error"); setPrev(null); }
  };
  // Removes one PER-INVOICE attachment (not the shared/batch kind — those go through
  // removeBatchAttachment) from an open preview — reuses the same single-invoice DELETE route the
  // Existing Invoice page already uses, since a per-invoice InvoiceAttachment row is identical
  // either way.
  const removePerInvoiceAttachment = async (invoiceId: number, attachmentId: number) => {
    try {
      await api.del(`/invoices/attachments/${attachmentId}`);
      setPrev((p: any) => p ? { ...p, perInvoiceAttachments: (p.perInvoiceAttachments || []).map((g: any) => g.invoiceId === invoiceId ? { ...g, attachments: g.attachments.filter((a: any) => a.id !== attachmentId) } : g) } : p);
    } catch (e: any) { show(e.message, "error"); }
  };
  const openOutlook = async () => {
    const p = prev; if (!p) return;
    if (!p.to?.trim()) return show("Enter at least one recipient (set the client's TO email)", "error");
    setPrev({ ...p, drafting: true });
    try {
      const blob = await api.postBlob(`/invoices/email-draft-bulk`, { clientId: bulk.clientId, month: bulk.month, selectedInvoiceIds: [...selected], to: p.to.trim(), cc: p.cc || "", bcc: p.bcc || "", html: p.html, subject: p.subject, attachments: p.attachments || [] });
      const code = (clients || []).find((c: any) => String(c.id) === String(bulk.clientId))?.code || "client";
      downloadBlob(blob, `${code}-${bulk.month}-invoices.eml`);
      show("Outlook draft downloaded — open it to review & send from your mailbox");
      setPrev(null);
    } catch (e: any) { show(e.message, "error"); setPrev({ ...p, drafting: false }); }
  };
  // Actually sends from the app — only ever reached after the confirmation popup below.
  const sendBulkNow = async () => {
    const p = prev; if (!p) return;
    if (!p.to?.trim()) return show("Enter at least one recipient (set the client's TO email)", "error");
    const alreadySent = matches.filter((m: any) => selected.has(m.id) && (m.status === "SENT" || m.status === "PAID"));
    if (!(await confirmDialog({
      title: `Send ${p.count} invoice(s) now?`,
      message: <>
        This sends ONE email bundling {p.count} selected invoice PDF(s) for {bulk.month} immediately from your own mailbox to: {p.to}{p.attachments?.length ? ` with ${p.attachments.length} extra attachment(s)` : ""}. Every invoice in this batch will be marked Sent. This cannot be undone.
        {alreadySent.length > 0 && <div style={{ marginTop: 8, color: "var(--warn, #a8650a)" }}>⚠️ {alreadySent.length} of these ({alreadySent.map((m: any) => m.invoiceNo).join(", ")}) {alreadySent.length === 1 ? "was" : "were"} already sent before — this will send {alreadySent.length === 1 ? "it" : "them"} again.</div>}
      </>,
      confirmLabel: "Send Email",
    }))) return;
    setPrev({ ...p, sending: true });
    try {
      const r: any = await api.post(`/invoices/send-bulk`, { clientId: bulk.clientId, month: bulk.month, selectedInvoiceIds: [...selected], to: p.to.trim(), cc: p.cc || "", bcc: p.bcc || "", html: p.html, subject: p.subject, attachments: p.attachments || [] });
      show(`Email sent — ${r.count} invoice(s) marked Sent`);
      setPrev(null);
    } catch (e: any) { show(e.message, "error"); setPrev({ ...p, sending: false }); }
  };

  return (
    <div>
      <h1>Email Invoices</h1>
      <div className="subtitle">Send a client's generated invoices for a month individually or combined — pick which ones below. Recipients come from the Client's TO/CC/BCC. Draft it to Outlook, or send it directly — nothing goes out without your explicit confirmation.</div>
      <Panel>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <SelectField label="Month" value={bulk.month} onChange={(e: any) => setBulk({ ...bulk, month: e.target.value })} style={{ width: 130 }}
            options={MONTHS.map((m) => ({ value: m, label: m }))} />
          <SelectField label="Client" value={bulk.clientId} onChange={(e: any) => setBulk({ ...bulk, clientId: e.target.value })} style={{ width: 240 }}
            options={[{ value: "", label: "— select client —" }, ...(clients || []).map((c: any) => ({ value: c.id, label: c.name }))]} />
        </div>
        {loading ? <div className="subtitle" style={{ marginTop: 10 }}>Loading invoices…</div> : bulk.clientId && bulk.month && <div style={{ marginTop: 10 }}>
          <div className="subtitle" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>{matches.length} generated invoice(s) for this client in {bulk.month} — {selected.size} selected.</span>
            {matches.length > 0 && <>
              <button className="ghost" onClick={() => setSelected(new Set(matches.map((m: any) => m.id)))}>Select All</button>
              <button className="ghost" onClick={() => setSelected(new Set())}>Clear All</button>
            </>}
          </div>
          {matches.length > 0 && <table style={{ marginTop: 6 }}>
            <thead><tr><th></th><th>Invoice #</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>{matches.map((i: any) => (
              <tr key={i.id}>
                <td><input type="checkbox" checked={selected.has(i.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} /></td>
                <td>{i.invoiceNo}</td><td>{fmtDate(i.invoiceDate)}</td><td className="num">{fmt(i.totalAmount, i.currency)}</td>
                <td>{i.status === "SENT" || i.status === "PAID"
                  ? <span className="pill" title={`Already ${i.status === "PAID" ? "sent and paid" : "sent"} — selecting it will send it again`} style={{ color: "#1ea672" }}>✅ Already Sent{i.status === "PAID" ? " (Paid)" : ""}</span>
                  : <span className="pill" style={{ color: "var(--muted)" }}>Not sent yet</span>}</td>
              </tr>
            ))}</tbody>
          </table>}
          {matches.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="label" style={{ margin: "0 0 4px" }}>Supporting Documents (shared across this batch — e.g. a timesheet)</div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {batchAttachments.map((a) => (
                  <span key={a.id} className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <a href={api.pdfUrl(`/invoices/attachments/${a.id}`)} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>📎 {a.fileName}</a>
                    <button type="button" onClick={() => removeBatchAttachment(a.fileName)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1, color: "inherit" }}>✕</button>
                  </span>
                ))}
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "2px 8px", fontSize: 11.5 }}>
                  {batchAttachBusy ? "Uploading…" : "+ Add Attachment"}
                  <input type="file" multiple disabled={batchAttachBusy} style={{ display: "none" }} onChange={(e) => { uploadBatchAttachments(e.target.files); e.target.value = ""; }} />
                </label>
              </div>
              <AttachGeneratedTimesheet clientId={bulk.clientId} month={bulk.month} clients={clients} busy={batchAttachBusy} setBusy={setBatchAttachBusy}
                reload={() => loadBatchAttachments(bulk.clientId, bulk.month)} />
            </div>
          )}
          <button style={{ marginTop: 8 }} disabled={!selected.size} onClick={previewBulk}>Preview &amp; Draft Email ({selected.size} selected) → Outlook</button>
        </div>}
      </Panel>
      <Modal title={`Email ${prev?.count ?? ""} invoices — ${bulk.month}`} open={!!prev} onClose={() => setPrev(null)} wide>
        {prev?.loading ? <div style={{ padding: 16 }}>Loading preview…</div> : prev && <div className="form-grid">
          <Input label="To (from client TO email — comma-separated)" full value={prev.to} onChange={(e: any) => setPrev({ ...prev, to: e.target.value })} />
          <Input label="Cc (from client CC email — comma-separated)" full value={prev.cc} onChange={(e: any) => setPrev({ ...prev, cc: e.target.value })} />
          <Input label="Bcc (from client BCC email — comma-separated)" full value={prev.bcc} onChange={(e: any) => setPrev({ ...prev, bcc: e.target.value })} />
          <Input label="Subject" full value={prev.subject} onChange={(e: any) => setPrev({ ...prev, subject: e.target.value })} />
          <div className="full"><label>Template</label><div>{prev.templateName || "—"}</div></div>
          <div className="full"><label>Attachments</label><div>📎 {prev.attachment}</div></div>
          <div className="full subtitle" style={{ margin: 0 }}>Shared attachments below go to every invoice in this email; per-invoice attachments (if any) are listed separately underneath, one group per invoice, and get sent with the invoice number prefixed on their filename so they never collide.</div>
          <AttachmentPicker attachments={prev.attachments || []} setAttachments={(a) => setPrev({ ...prev, attachments: a })} existing={prev.existingAttachments} onRemoveExisting={(id: number) => { const a = (prev.existingAttachments || []).find((x: any) => x.id === id); if (a) removeBatchAttachment(a.fileName); }} />
          {(prev.perInvoiceAttachments || []).some((g: any) => g.attachments?.length > 0) && (
            <div className="full">
              <label>Per-Invoice Attachments</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                {(prev.perInvoiceAttachments || []).filter((g: any) => g.attachments?.length).map((g: any) => (
                  <div key={g.invoiceId} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px" }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Invoice {g.invoiceNo}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {g.attachments.map((a: any) => (
                        <span key={a.id} className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <a href={api.pdfUrl(`/invoices/attachments/${a.id}`)} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>📎 {a.fileName}</a>
                          <button type="button" onClick={() => removePerInvoiceAttachment(g.invoiceId, a.id)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1, color: "inherit" }}>✕</button>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="full"><label>Body (editable — click in and type to change before sending/drafting)</label>
            <div
              key={`${bulk.clientId}-${bulk.month}`}
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => setPrev({ ...prev, html: (e.target as HTMLDivElement).innerHTML })}
              style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, maxHeight: 240, overflow: "auto", outline: "none", cursor: "text" }}
              dangerouslySetInnerHTML={{ __html: prev.html }}
            />
          </div>
          <div className="subtitle full">
            <b>Open in Outlook (draft)</b> downloads an <b>.eml</b> — review and send from your own mailbox, nothing leaves the app.
            <b> Send Email</b> sends it immediately from your own mailbox (after you confirm) and marks every invoice in this batch <b>Sent</b>.
          </div>
          <div className="full" style={{ display: "flex", justifyContent: "flex-end", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <button className="ghost" disabled={prev.loading} onClick={() => setPrev(null)}>Cancel</button>
            <button className="ghost" disabled={prev.loading || !prev.to?.trim() || prev.drafting} onClick={openOutlook}>{prev.drafting ? "Preparing…" : "Open in Outlook (draft)"}</button>
            <AddButton disabled={prev.loading || !prev.to?.trim() || prev.sending} onClick={sendBulkNow}>{prev.sending ? "Sending…" : "Send Email"}</AddButton>
          </div>
        </div>}
      </Modal>
    </div>
  );
}
