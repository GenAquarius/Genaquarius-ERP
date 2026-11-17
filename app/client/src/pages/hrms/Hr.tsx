import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router-dom";
import { Bar, Doughnut } from "react-chartjs-2";
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend,
} from "chart.js";
import { api } from "../../api";
import { useFetch, Panel, Field, SelectField, useFiscalYears, WorkforceDrillPopup, EsignPanel, useMaskNumbers, CandidateDocumentsPanel, cellChangeTip } from "../../ui";
import { fmtDate, fmtDateTime } from "../../dateFormat";
import { watchRoom } from "../../realtime";
import { useSortFilter, SortableHead, FilterToggle } from "../../DataTable";
import { useToast, GhostButton, AddButton, confirmDialog, Modal } from "../../components";
import { useAuth } from "../../auth";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { LeavePolicySettings, OnboardingDocumentChecklistSettings } from "./Ess";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import CalculateRoundedIcon from "@mui/icons-material/CalculateRounded";
import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DrawRoundedIcon from "@mui/icons-material/DrawRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import RadioButtonCheckedRoundedIcon from "@mui/icons-material/RadioButtonCheckedRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import MailRoundedIcon from "@mui/icons-material/MailRounded";
import ComputerRoundedIcon from "@mui/icons-material/ComputerRounded";
import LaptopRoundedIcon from "@mui/icons-material/LaptopRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import HowToRegRoundedIcon from "@mui/icons-material/HowToRegRounded";
import AssignmentIndRoundedIcon from "@mui/icons-material/AssignmentIndRounded";
import PersonRoundedIcon from "@mui/icons-material/PersonRounded";
import WorkRoundedIcon from "@mui/icons-material/WorkRounded";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import { NeedYourAttention } from "../../NeedYourAttention";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

// ---------------------------------------------------------------------------
// Shared status → label / pill-class / lifecycle-order helpers
// ---------------------------------------------------------------------------
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft", GENERATED: "Generated", PREVIEWED: "Previewed", SENT: "Sent",
  ACCEPTED: "Accepted", DECLINED: "Declined", EXPIRED: "Expired", WITHDRAWN: "Withdrawn", CANCELLED: "Cancelled",
  APPOINTMENT_GENERATED: "Appt. Generated", APPOINTMENT_PREVIEWED: "Appt. Previewed", APPOINTMENT_ISSUED: "Appt. Issued",
  JOINING_CONFIRMED: "Joined",
};
const STATUS_CLASS: Record<string, string> = {
  DRAFT: "", GENERATED: "accent", PREVIEWED: "accent", SENT: "warn",
  ACCEPTED: "good", APPOINTMENT_GENERATED: "accent", APPOINTMENT_PREVIEWED: "accent", APPOINTMENT_ISSUED: "warn",
  JOINING_CONFIRMED: "good", DECLINED: "bad", EXPIRED: "bad", WITHDRAWN: "bad", CANCELLED: "bad",
};
const LIFECYCLE = ["DRAFT", "GENERATED", "PREVIEWED", "SENT", "ACCEPTED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"];
// CONTRACTOR/INTERN skip the Appointment Letter stages entirely — Sent → Accepted → straight to
// Joined (see server hrOffers.ts's usesServiceAgreement()).
const CONTRACTOR_LIFECYCLE = ["DRAFT", "GENERATED", "PREVIEWED", "SENT", "ACCEPTED", "JOINING_CONFIRMED"];
const usesServiceAgreement = (t?: string | null) => t === "CONTRACTOR" || t === "INTERN";
// Renders a panel's fields in `order` (the keys array from its fetched fieldConfig, which already
// reflects any drag-to-reorder HR did in the Workflow Builder's Configure panel — see
// resolveStageFieldConfig/resolveOfferFieldConfig, engine/workflow.ts) instead of the order they
// happen to appear in this file's JSX. Each entry's `node` keeps its own existing fieldOn/gating
// logic completely unchanged — this only ever reorders, never changes what renders or why. A key
// with no matching catalog entry in `order` (shouldn't normally happen) keeps its original relative
// position, appended at the end, so nothing is ever silently dropped.
function orderedFields(nodes: { key: string; node: React.ReactNode }[], order?: string[] | null): React.ReactNode[] {
  if (!order || !order.length) return nodes.map((n) => n.node);
  const byKey = new Map(nodes.map((n) => [n.key, n.node]));
  const seen = new Set<string>();
  const out: React.ReactNode[] = [];
  for (const k of order) { if (byKey.has(k) && !seen.has(k)) { out.push(byKey.get(k)); seen.add(k); } }
  for (const n of nodes) if (!seen.has(n.key)) { out.push(n.node); seen.add(n.key); }
  return out;
}
const TERMINAL = ["DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"];
const StatusPill = ({ s }: { s: string }) => <span className={`pill ${STATUS_CLASS[s] || ""}`}>{STATUS_LABEL[s] || s}</span>;
// One small pill per document (Offer / Appointment Letter / Service Agreement) showing whether
// it's still pending, or was accepted/declined — and if accepted, whether that was captured
// digitally (Adobe Sign) or confirmed manually (email flow). null badge (document not applicable
// to this offer, e.g. no Appointment Letter for a Contractor) renders nothing.
// A document is "sent"/"issued" once it's actually gone out to the candidate — before that,
// PENDING means it just hasn't been generated/sent yet, not that anyone is waiting on a signature.
// Those are two very different situations for HR to act on. Rendered as a small single-letter
// chip (O/A/S) instead of a full-text pill — three of these plus a status word each blew the
// Acceptance column out wide; the detail lives in the hover tooltip, and AcceptanceLegend (shown
// once per page, not per row) spells out what the letters/colors mean.
const AWAITING_CANDIDATE_STATUSES = new Set(["SENT", "ISSUED"]);
function AcceptancePill({ label, badge, rawStatus }: { label: string; badge: { status: "PENDING" | "ACCEPTED" | "DECLINED"; method: "ADOBE_SIGN" | "EMAIL" | null } | null | undefined; rawStatus?: string }) {
  if (!badge) return null;
  let cls = "";
  let title: string;
  if (badge.status === "PENDING") {
    const awaiting = !!(rawStatus && AWAITING_CANDIDATE_STATUSES.has(rawStatus));
    cls = awaiting ? "warn" : "";
    title = awaiting ? `${label}: Acceptance Pending — sent, awaiting the candidate` : `${label}: Generation Pending — not yet sent`;
  } else {
    cls = badge.status === "ACCEPTED" ? "good" : "bad";
    title = `${label}: ${badge.status === "DECLINED" ? "Declined" : "Accepted"} (${badge.method === "ADOBE_SIGN" ? "digitally via Adobe Sign" : "confirmed via email"})`;
  }
  return (
    <span className={`pill ${cls}`} title={title}
      style={{ width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, marginRight: 3, fontWeight: 700, fontSize: 10, cursor: "default" }}>
      {label[0]}
    </span>
  );
}
function AcceptanceLegend() {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, color: "var(--muted)", margin: "8px 0" }}>
      <span><b>O</b>ffer · <b>A</b>ppointment · <b>S</b>LA</span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span className="pill" style={{ width: 14, height: 14, padding: 0, display: "inline-block" }} /> Not yet sent</span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span className="pill warn" style={{ width: 14, height: 14, padding: 0, display: "inline-block" }} /> Awaiting candidate</span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span className="pill good" style={{ width: 14, height: 14, padding: 0, display: "inline-block" }} /> Accepted</span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span className="pill bad" style={{ width: 14, height: 14, padding: 0, display: "inline-block" }} /> Declined</span>
      <span>Hover a chip for the exact status &amp; method.</span>
    </div>
  );
}
// What HR needs to click next, spelled out in the list itself instead of only being discoverable
// by opening the full offer — an offer sitting at "Accepted" with nothing else shown left HR
// guessing whether the next step (Generate Appointment Letter / Service Agreement, etc.) was
// already done by someone else or still waiting.
function nextActionFor(o: any): string {
  const isContractor = usesServiceAgreement(o.employmentType);
  const docName = o.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement";
  // Finance rejecting the CTC reverts status back to ACCEPTED/APPOINTMENT_ISSUED (the pre-
  // activation stage) so HR can fix it and re-confirm — but that raw status alone reads as a
  // brand-new "awaiting joining confirmation" case, hiding that it was already rejected once.
  if (o.ctcRejectedAt) return "⚠ CTC Rejected — fix CTC & re-confirm joining";
  switch (o.status) {
    case "DRAFT": return isContractor ? (o.employmentType === "INTERN" ? "Generate Internship Letter" : "Generate SLA") : "Generate Offer";
    case "GENERATED":
    case "PREVIEWED":
      return isContractor && o.serviceAgreement ? `Send ${docName}` : "Send Offer";
    case "SENT":
      if (isContractor && o.serviceAgreement) return o.serviceAgreementAcceptance?.status === "ACCEPTED" ? "Confirm Joining" : `Awaiting ${docName} confirmation`;
      return "Awaiting offer acceptance";
    case "ACCEPTED":
      return isContractor ? `Generate ${docName}` : "Generate Appointment Letter";
    case "APPOINTMENT_GENERATED":
    case "APPOINTMENT_PREVIEWED":
      return "Send Appointment Letter";
    case "APPOINTMENT_ISSUED":
      return o.appointmentAcceptance?.status === "ACCEPTED" ? "Confirm Joining" : "Awaiting appointment acceptance";
    case "DECLINED": return "Declined — no action";
    case "EXPIRED": return "Expired — no action";
    case "WITHDRAWN": return "Withdrawn — no action";
    case "CANCELLED": return "Cancelled — no action";
    case "JOINING_CONFIRMED": return "Activated";
    default: return "—";
  }
}
const EmploymentTypePill = ({ t }: { t: string }) => <span className={`pill ${t === "CONTRACTOR" ? "warn" : t === "INTERN" ? "accent" : "accent"}`}>{t === "CONTRACTOR" ? "Contractor" : t === "INTERN" ? "Intern" : "Employee"}</span>;
// CtcApprovalRequest.status, as seen from Onboarding History — null means no request exists at
// all (shouldn't happen for anyone activated after this feature shipped, but shown plainly if it does).
const CTC_STATUS_LABEL: Record<string, string> = { PENDING: "Pending Finance Approval", APPROVED: "Approved", REJECTED: "Rejected", NO_COST_TO_COMPANY: "Approved — No CTC Cost" };
const CTC_STATUS_CLASS: Record<string, string> = { PENDING: "warn", APPROVED: "good", REJECTED: "bad", NO_COST_TO_COMPANY: "good" };
const CtcStatusPill = ({ s }: { s: string | null }) => <span className={`pill ${s ? CTC_STATUS_CLASS[s] || "" : ""}`}>{s ? CTC_STATUS_LABEL[s] || s : "—"}</span>;

// =====================================================================================
// HR Dashboard
// =====================================================================================
// Drill-down behind a clickable Dashboard KPI tile — the actual rows behind the number
// (name, employee ID, joining date, project/status) instead of just a count.
function DashboardDrillModal({ kind, onClose }: { kind: string; onClose: () => void }) {
  const { data } = useFetch<any>(kind ? `/hr/dashboard/drilldown?kind=${kind}` : "/health");
  return (
    <Modal title={data?.title || "Loading…"} open={!!kind} onClose={onClose} wide>
      {!kind || !data?.rows ? <div style={{ color: "var(--muted)" }}>Loading…</div> : data.rows.length === 0 ? (
        <div style={{ color: "var(--muted)" }}>No records.</div>
      ) : (
        <table><thead><tr>
          <th>Name</th><th>{data.isOffers ? "Role" : "Employee ID"}</th><th>{data.isOffers ? "Proposed Joining" : "Date of Joining"}</th>
          <th>{data.isOffers ? "Status" : "Project"}</th>{!data.isOffers && <th>Location</th>}
        </tr></thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr key={r.id}>
                <td>{r.name}</td><td>{r.empNo || "—"}</td>
                <td>{r.joiningDate ? fmtDate(r.joiningDate) : "—"}</td>
                <td>{data.isOffers ? r.status : r.project}</td>
                {!data.isOffers && <td>{r.location || "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

const HR_DASH_MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
export function HrDashboard() {
  const { data, loading, reload: reloadDashboard } = useFetch<any>("/hr/dashboard");
  // Workflow-driven funnel (Sections 11-13/21-22) — stage list/order/counts come entirely from
  // whatever's published in Workflow & Stage Configuration, no fixed dashboard-side stage list.
  // Employee and Contractor are separate templates now (own stage list/order) — this toggle picks
  // which one the funnel (and "Needs Your Attention" below, which is derived from it) shows.
  const [funnelType, setFunnelType] = useState<"EMPLOYEE" | "CONTRACTOR">("EMPLOYEE");
  const { data: funnel, reload: reloadFunnel } = useFetch<any>(`/hr/dashboard/funnel?employmentType=${funnelType}`, [funnelType]);
  useEffect(() => watchRoom("esign:activity", "esign:activity", reloadFunnel), []);
  const navigate = useNavigate();
  const [drillKind, setDrillKind] = useState("");
  const { data: esignActivity, reload: reloadEsign } = useFetch<any[]>("/adobe-sign/recent-activity");
  // Real-time via Socket.IO instead of polling — pushed the instant any offer/appointment/service
  // agreement is signed or declined anywhere in the app. Also refreshes the KPI/"Needs Your
  // Attention" data, not just the activity feed — a sign/decline directly moves offersPending
  // Acceptance, appointmentPending etc., so leaving `data` stale there was the actual bug.
  useEffect(() => watchRoom("esign:activity", "esign:activity", () => { reloadEsign(); reloadDashboard(); }), []);
  // "Clear History" only dismisses this feed for this viewer (a per-browser preference, not
  // shared/synced) — the underlying EsignAgreement rows are never touched, so Employee Master and
  // the Offer's own e-signature panel still show everything regardless.
  const [esignClearedAt, setEsignClearedAt] = useState<number>(() => Number(localStorage.getItem("esignActivityClearedAt") || 0));
  const clearEsignHistory = () => { const now = Date.now(); localStorage.setItem("esignActivityClearedAt", String(now)); setEsignClearedAt(now); };
  const visibleEsignActivity = (esignActivity || []).filter((a: any) => new Date(a.updatedAt).getTime() > esignClearedAt);
  // Monthly Metrics — the same workforce table Finance sees, minus every financial column
  // (Salary Expense, Total Cost, Revenue, Monthly Profit, PGP) — stripped server-side, not just
  // hidden here, so this endpoint never sends HR that data at all.
  const [mmFy, setMmFy] = useState("FY26-27");
  const [mmMonth, setMmMonth] = useState("ALL");
  const [mmRowPopup, setMmRowPopup] = useState<any>(null);
  const fyList = useFiscalYears();
  const { data: mm } = useFetch<any>(`/dashboard/hr-monthly-metrics?fy=${mmFy}&month=${mmMonth}`, [mmFy, mmMonth]);
  const mmCols = [
    { key: "month", label: "Month", get: (r: any) => HR_DASH_MONTHS.indexOf(r.month) },
    { key: "headCount", label: "Head Count", num: true, tip: "Distinct people with any resource line this month" },
    { key: "nonBillableAssigned", label: "Non-billable", num: true, tip: "Non-billable but assigned to a customer project" },
    { key: "bench", label: "Bench", num: true, tip: "Distinct people on a non-billable Bench row" },
    { key: "corporate", label: "Corporate", num: true, tip: "Distinct people non-billable on an internal corporate project" },
    { key: "billableHeadCount", label: "Billable (TB)", num: true, tip: "Onsite + Offshore Billable + Double Dip (marked)" },
    { key: "doubleDip", label: "Double Dip", num: true, tip: "People explicitly marked Double Dip" },
    { key: "offshoreBillable", label: "Offshore Bill.", num: true, tip: "Billable people located India (or no location)" },
    { key: "onsiteBillable", label: "Onsite Bill.", num: true, tip: "Billable people located US / Canada / Caribbean" },
  ];
  const mmRows = mm ? (mmMonth === "ALL" ? mm.rows : mm.rows.filter((r: any) => r.month === mmMonth)) : [];
  const mmSf = useSortFilter(mmRows, mmCols);
  if (loading || !data) return <div>Loading…</div>;
  const kpi = (label: string, value: any, sub?: string, kind?: string) => (
    <div className={`kpi${kind ? " clickable" : ""}`} style={kind ? { cursor: "pointer" } : undefined} onClick={kind ? () => setDrillKind(kind) : undefined}>
      <div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}
    </div>
  );
  const closedTotal = data.declined + data.expired + data.withdrawn + data.cancelled;

  // "Needs Your Attention" — driven by the SAME published Workflow & Stage Configuration as the
  // funnel panel below (Sections: "all pages... show work as per Workflow & Stage Configuration"):
  // each configured stage still PENDING for at least one offer is an attention item, in the exact
  // order/names HR configured — no separate hardcoded stage list here anymore.
  const STAGE_ATTENTION_COLORS = ["#fbbf24", "#f87171", "#6ea8ff", "#a78bfa", "#34d399", "#f472b6", "#fb923c"];
  // Onboarding Flow's own list (OffersList) deliberately excludes any offer whose employeeId is
  // already set — "Once JOINING_CONFIRMED (employeeId set), an offer is done — it moves to
  // Onboarding History" (see its own comment). Any stage ordered AFTER Employee Activation
  // (Appointment Generation/Accepted, under the current default ordering) only ever has pending
  // offers that already HAVE an employeeId — clicking through to Onboarding Flow for those showed
  // nothing, even though the count itself was correct, because they'd already moved to Onboarding
  // History. Routing by each stage's own order relative to Employee Activation (not a hardcoded
  // stageType list) keeps this correct under any HR-configured stage order.
  const activationOrder = (funnel?.stages || []).find((s: any) => s.stageType === "EMPLOYEE_ACTIVATION")?.order;
  const attention = [
    ...(funnel?.stages || []).filter((s: any) => s.pending > 0).map((s: any, i: number) => ({
      label: `${s.name} — pending for ${s.pending} candidate(s)`, count: s.pending, color: STAGE_ATTENTION_COLORS[i % STAGE_ATTENTION_COLORS.length],
      target: activationOrder != null && s.order > activationOrder ? "/hr/onboarding-history" : "/hr/offers",
    })),
    { label: "CTC rejected by Finance — needs correction & resubmission", count: data.ctcRejected, color: "#e5484d", target: "/hr/offers" },
  ].filter((a) => a.count > 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>HR Dashboard</h1>
          <div className="subtitle">Workforce, offer pipeline &amp; appointment status</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <AddButton onClick={() => navigate("/hr/offers/new")}>Start Onboarding</AddButton>
          <GhostButton onClick={() => navigate("/hr/offers")}>Onboarding Flow</GhostButton>
          <GhostButton onClick={() => navigate("/employees")}>Employees</GhostButton>
        </div>
      </div>

      {/* Cross-cutting real-time attention widget (Section: "Need your Attention... present in
          all dashboards") — covers approval queues OUTSIDE the onboarding pipeline funnel below,
          e.g. Additional Profile Details submissions, which the bespoke stage-funnel "Needs Your
          Attention" panel further down never surfaced (it's scoped to onboarding stages only). */}
      <NeedYourAttention />

      {/* Workflow-driven funnel — stage order/labels/counts come entirely from whatever's
          published in Workflow & Stage Configuration; reordering there is reflected here
          automatically, no dashboard code change. */}
      <Panel
        title={`${funnelType === "EMPLOYEE" ? "Offer / Appointment / Joining" : "SLA / Document Collection / Joining"} Funnel — ${funnel?.workflowName || (funnelType === "EMPLOYEE" ? "Employee Lifecycle" : "Contractor Lifecycle")}${funnel?.workflowVersion ? ` v${funnel.workflowVersion}` : ""}`}
        style={{ marginTop: 14 }}
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            {(["EMPLOYEE", "CONTRACTOR"] as const).map((t) => (
              <button key={t} className={funnelType === t ? "" : "ghost"} style={{ fontWeight: funnelType === t ? 700 : 400, padding: "4px 10px" }} onClick={() => setFunnelType(t)}>
                {t === "EMPLOYEE" ? "Employee" : "Contractor"}
              </button>
            ))}
          </div>
        }
      >
        {!funnel?.stages?.length ? (
          <div className="note">No published {funnelType === "EMPLOYEE" ? "Employee" : "Contractor"} workflow yet.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            {funnel.stages.map((s: any, i: number) => {
              const pct = s.total ? Math.round((s.completed / s.total) * 100) : 0;
              const pctInProg = s.total ? Math.round((s.inProgress / s.total) * 100) : 0;
              return (
                <div key={s.key} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--panel2)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                    <div style={{ fontSize: 11.5, fontWeight: 700, minHeight: 28, lineHeight: 1.3 }}>{s.name}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "var(--good)" }}>{s.completed}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>/ {s.total}</div>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 6 }}>
                    {pct}% complete{s.inProgress ? ` · ${s.inProgress} in progress` : ""}
                  </div>
                  {/* Stacked bar: green = completed, amber = in progress, faint = still pending —
                      the old bar was completed-only, so a stage with plenty of activity but no
                      finishers yet looked completely empty. */}
                  <div style={{ height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden", display: "flex" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: "var(--good)" }} />
                    <div style={{ height: "100%", width: `${pctInProg}%`, background: "var(--warn)" }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* Needs Your Attention — the single most useful thing on this page: what to do next. */}
      <Panel style={{ marginTop: 14, marginBottom: 14, border: attention.length ? "1px solid var(--warn)" : undefined }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: attention.length ? 10 : 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{attention.length ? "⚠ Needs Your Attention" : "✓ All caught up"}</div>
          {attention.length > 0 && <span className="pill warn">{attention.reduce((s, a) => s + a.count, 0)} item(s)</span>}
        </div>
        {attention.length === 0 ? (
          <div className="subtitle" style={{ margin: 0 }}>No offers or appointments are waiting on HR action right now.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            {attention.map((a) => (
              <div key={a.label} onClick={() => navigate(a.target)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: a.color, flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 13 }}>{a.label}</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{a.count}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Hero metrics — the four numbers that matter most at a glance. Every tile is clickable —
          drills into the actual employees/offers behind the count via DashboardDrillModal. */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 14 }}>
        {kpi("Total Employees", data.totalEmployees, undefined, "totalEmployees")}
        {kpi("Active Employees", data.activeEmployees, undefined, "activeEmployees")}
        {kpi("On Bench", data.onBench, undefined, "onBench")}
        <div className="kpi" style={{ borderTopColor: data.pendingHrActions > 0 ? "var(--warn)" : undefined, cursor: "pointer" }} onClick={() => setDrillKind("pendingHrActions")}>
          <div className="label">Pending HR Actions</div>
          <div className="value" style={{ color: data.pendingHrActions > 0 ? "var(--warn)" : undefined }}>{data.pendingHrActions}</div>
        </div>
      </div>
      <DashboardDrillModal kind={drillKind} onClose={() => setDrillKind("")} />

      {visibleEsignActivity.length > 0 && (
        <Panel title="Recent E-Signature Activity" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            {/* Dismisses the feed for this viewer only — the underlying signed documents (and
                Employee Master / Offer records) are never touched, this is just a notification
                list, not the source of truth. */}
            <GhostButton onClick={clearEsignHistory}>Clear History</GhostButton>
          </div>
          <table><tbody>
            {visibleEsignActivity.map((a: any) => (
              <tr key={a.id} style={{ cursor: a.offer ? "pointer" : undefined }} onClick={() => a.offer && navigate(`/hr/offers/${a.offer.id}`)}>
                <td>{a.offer?.candidateName || "—"}</td>
                <td style={{ color: "var(--muted)" }}>{a.offer?.offerRef || ""}</td>
                <td>{a.docType.replace("_", " ")}</td>
                <td><span className={`pill ${a.status === "SIGNED" ? "good" : "bad"}`}>{a.status}</span></td>
                <td style={{ color: "var(--muted)" }}>{fmtDateTime(a.updatedAt)}</td>
              </tr>
            ))}
          </tbody></table>
        </Panel>
      )}

      {/* Charts — same visual language as the Finance / Executive dashboards */}
      <div className="grid charts-row" style={{ gridTemplateColumns: "2fr 1fr", marginBottom: 14 }}>
        <Panel title="Offer → Appointment → Joining Funnel (Offer + SLA)">
          <div className="chart-wrap">
            <Bar
              data={{
                labels: ["Generated", "Sent", "Accepted", "Joined", "Appt. Generated", "Appt. Issued", "Appt. Accepted"],
                datasets: [
                  {
                    // Employee (Offer) flow — the only one with an Appointment step at all. Appt.
                    // Generated/Issued/Accepted are shown AFTER Joined (not before) since, under
                    // the default stage order, Employee Activation/Joining happens before the
                    // Appointment Letter is even generated — putting them earlier misrepresented
                    // the actual sequence.
                    label: "Offer (Employee)",
                    data: [data.empGenerated, data.empSent, data.empAccepted, data.empJoined, data.empAppointmentGenerated, data.empAppointmentIssued, data.empAppointmentAccepted],
                    backgroundColor: "#6ea8ff",
                    borderRadius: 4,
                  },
                  {
                    // Contractor (SLA) flow — no Appointment step, so those three bars are always 0.
                    label: "SLA (Contractor)",
                    data: [data.slaGenerated, data.slaSent, data.slaAccepted, data.slaJoined, 0, 0, 0],
                    backgroundColor: "#fbbf24",
                    borderRadius: 4,
                  },
                ],
              }}
              options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: "bottom" } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
            />
          </div>
        </Panel>
        <Panel title="Workforce Composition">
          <div className="chart-wrap">
            <Doughnut
              data={{
                labels: ["Deployed", "Bench"],
                datasets: [{ data: [data.deployedOnProjects, data.onBench], backgroundColor: ["#6ea8ff", "#fbbf24"] }],
              }}
              options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }}
            />
          </div>
        </Panel>
      </div>

      {/* Detail — the granular numbers, kept below the fold since they're context, not action items. */}
      <h2 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".5px", margin: "16px 0 8px" }}>Workforce Detail</h2>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 14 }}>
        {kpi("New Joiners (MTD)", data.newJoiners, undefined, "newJoiners")}
        {kpi("Joining Next Month", data.joiningNextMonth, undefined, "joiningNextMonth")}
        {kpi("Deployed on Projects", data.deployedOnProjects, undefined, "deployedOnProjects")}
      </div>

      <h2 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".5px", margin: "16px 0 8px" }}>Offer &amp; Onboarding Detail</h2>
      <div className="grid" style={{ gridTemplateColumns: "repeat(5,1fr)", marginBottom: 14 }}>
        {kpi("Offers Generated", data.offersGenerated)}
        {kpi("Offers Sent", data.offersSent)}
        {kpi("Offers Accepted", data.offersAccepted)}
        {kpi("Joined", data.joined)}
        {kpi("Closed (Declined/Expired/Withdrawn/Cancelled)", closedTotal)}
      </div>

      <div className="note">{data.note}</div>

      {mmRowPopup && (
        <WorkforceDrillPopup month={mmRowPopup.month} fy={mmFy} roster={mmRowPopup.roster} prevRoster={mmRowPopup.prevRoster} prevMonth={mmRowPopup.prevMonth} counts={mmRowPopup.counts} onClose={() => setMmRowPopup(null)} />
      )}
      <Panel title="Monthly Metrics" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <div className="subtitle" style={{ margin: 0 }}>Same workforce metrics Finance sees — click a row to see who's counted where.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={mmFy} onChange={(e) => setMmFy(e.target.value)} style={{ width: 120 }} title="Fiscal Year">
              {fyList.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select value={mmMonth} onChange={(e) => setMmMonth(e.target.value)} style={{ width: 150 }} title="Period">
              <option value="ALL">Full Year (Apr–Mar)</option>
              {HR_DASH_MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 8 }}><FilterToggle sf={mmSf} /></div>
        <table>
          <SortableHead cols={mmCols} sf={mmSf} />
          <tbody>
            {mmSf.view.map((r: any) => {
              const prevRow = r.monthIndex > 0 ? mm?.rows.find((x: any) => x.monthIndex === r.monthIndex - 1) : null;
              const curRoster = mm?.rosterByMonth?.[r.monthIndex] || {};
              const prevRoster = r.monthIndex > 0 ? mm?.rosterByMonth?.[r.monthIndex - 1] : null;
              const prevLabel = prevRow ? prevRow.month : null;
              const tip = (key: string, val: number) => cellChangeTip(key, val, prevRow ? prevRow[key] : undefined, curRoster, prevRoster, prevLabel);
              return (
                <tr key={r.month} style={{ cursor: "pointer" }} title="Click to list resources by category"
                  onClick={() => setMmRowPopup({ month: r.month, roster: curRoster, counts: r, prevRoster, prevMonth: prevLabel })}>
                  <td>{r.month}</td>
                  <td className="num" title={tip("headCount", r.headCount)}>{r.headCount}</td>
                  <td className="num" title={tip("nonBillableAssigned", r.nonBillableAssigned || 0)}>{r.nonBillableAssigned || 0}</td>
                  <td className="num" title={tip("bench", r.bench)}>{r.bench}</td>
                  <td className="num" title={tip("corporate", r.corporate)}>{r.corporate}</td>
                  <td className="num" title={tip("billableHeadCount", r.billableHeadCount)}>{r.billableHeadCount}</td>
                  <td className="num" title={tip("doubleDip", r.doubleDip)}>{r.doubleDip}</td>
                  <td className="num" title={tip("offshoreBillable", r.offshoreBillable)}>{r.offshoreBillable}</td>
                  <td className="num" title={tip("onsiteBillable", r.onsiteBillable)}>{r.onsiteBillable}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// Shown at the top of every BU-scoped tab when the selected Business Unit has no rows of its
// own yet for that category — offers to clone the Country Default's current content as a
// starting point (the practical way to create a BU override, rather than a blank form).
export function CloneFromDefaultBanner({ businessUnitId, cloneUrl, onCloned, label }: { businessUnitId: string; cloneUrl: string; onCloned: () => void; label: string }) {
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  if (businessUnitId === "null") return null;
  const clone = async () => {
    setBusy(true);
    try { const r: any = await api.post(cloneUrl, { businessUnitId: Number(businessUnitId) }); show(r.reason || `Cloned ${r.cloned} ${label} from Country Default`); onCloned(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="note" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
      <span>No {label} configured for this Business Unit yet — it currently falls back to the Country Default.</span>
      <AddButton disabled={busy} onClick={clone}>{busy ? "Cloning…" : "Clone from Country Default"}</AddButton>
    </div>
  );
}

// Business Unit selector shared by every BU-scoped tab below — "null" = Company/Country
// Default (the original single-row behavior every category had before BU-scoping existed).
export function BusinessUnitFilterBar({ businessUnitId, setBusinessUnitId }: { businessUnitId: string; setBusinessUnitId: (v: string) => void }) {
  const { data: bus } = useFetch<any[]>("/hr-settings/business-units");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "10px 12px", background: "var(--panel2)", borderRadius: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Business Unit:</span>
      <select value={businessUnitId} onChange={(e) => setBusinessUnitId(e.target.value)} style={{ minWidth: 240 }}>
        <option value="null">Company Default</option>
        {(bus || []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {businessUnitId !== "null" && <span style={{ fontSize: 11, color: "var(--muted)" }}>Everything below now shows/edits this Business Unit's own overrides — falls back to Company Default wherever it hasn't set one.</span>}
    </div>
  );
}

// =====================================================================================
// HR Admin Settings — Business Unit is the primary selector: Salary & CTC, Tax, the 4
// document templates, Signature, Email, Leave Policy and Onboarding Doc Checklist all live
// *within* the selected Business Unit (falling back to the Company Default wherever that BU
// hasn't configured its own). Country, the Business Unit list itself, and Designation &
// Department stay global — a BU points to one Country, not the other way round, and job
// titles/departments are shared across the whole company today.
// =====================================================================================
const HR_SETTINGS_TAB_KEYS = ["ctc", "offer", "appointment", "service-agreement", "appraisal", "relieving", "msa", "sow", "signature", "email", "leave", "onboarding-docs", "holidays", "profile-fields"] as const;
export function HrSettings() {
  const location = useLocation();
  const [tab, setTab] = useState<typeof HR_SETTINGS_TAB_KEYS[number]>(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return (HR_SETTINGS_TAB_KEYS as readonly string[]).includes(t || "") ? (t as any) : "ctc";
  });
  const [globalTab, setGlobalTab] = useState<"workflow" | null>(null);
  // Remembered across tab switches and page reloads (same localStorage-preference pattern as
  // getDisplayCcy/getPageSize in ui.tsx) — HR shouldn't have to re-pick their Business Unit
  // every time they open a different HR Settings tab or come back later.
  const [businessUnitId, setBusinessUnitIdState] = useState(() => localStorage.getItem("hrSettingsBusinessUnitId") || "null");
  const setBusinessUnitId = (v: string) => { setBusinessUnitIdState(v); try { localStorage.setItem("hrSettingsBusinessUnitId", v); } catch { /* ignore (private mode, etc.) */ } };
  // GenAquarius LLC / Aquarius Technologies Limited (the US/Canada Business Units) don't generate
  // an Appointment Letter, Service Agreement or Appraisal Letter — the simplified US/Canada
  // onboarding flow doesn't have those stages — so those three template tabs are hidden for them
  // and MSA/SOW Template tabs appear instead. Every other Business Unit (India included) keeps
  // all four of its original tabs exactly as before, completely unaffected.
  const { data: allBusinessUnits } = useFetch<any[]>("/hr-settings/business-units");
  const selectedBu = (allBusinessUnits || []).find((b: any) => String(b.id) === businessUnitId);
  const isUsCanadaBu = !!selectedBu && (selectedBu.countryCode === "US" || selectedBu.countryCode === "CANADA");
  // Tax moved to Finance Settings (tax brackets drive payroll/CTC cost calculations, a Finance
  // concern) and Country/Business Unit/Designation & Department moved to Company Settings (both
  // under Administration) — they're shared reference data consumed by HR and Finance alike, not
  // HR-owned settings. Employee Profile Fields is now ALSO BU-scoped (a BU with no fields of its
  // own inherits the Company Default list) — Workflow & Stage Configuration stays a separate
  // global tab below since it's scoped by Country bucket, not individual Business Unit.
  const buTabs: [typeof tab, string][] = [
    ["ctc", "Salary & CTC"],
    ["profile-fields", "Employee Profile Fields"],
    // GenAquarius LLC / Aquarius Technologies Limited have no Offer Letter stage at all in the
    // simplified US/Canada flow (MSA + SOW cover every engagement there) — so the Offer Template
    // tab is hidden for them too, same as Appointment/Service Agreement/Appraisal below. Every
    // other Business Unit (India included) keeps it exactly as before.
    ...(isUsCanadaBu ? [] : ([["offer", "Offer Template"]] as [typeof tab, string][])),
    ...(isUsCanadaBu
      ? ([["msa", "MSA Template"], ["sow", "SOW Template"]] as [typeof tab, string][])
      : ([["appointment", "Appointment Template"], ["service-agreement", "Service Template"], ["appraisal", "Appraisal Template"]] as [typeof tab, string][])),
    // Unlike Appraisal/Appointment/Service Template above, this ISN'T hidden for US/Canada BUs —
    // an employee exits regardless of country, so every Business Unit needs this tab.
    ["relieving", "Relieving Letter"],
    ["signature", "Signature"], ["email", "Email"], ["leave", "Leave Policy"], ["onboarding-docs", "Onboarding Doc Checklist"], ["holidays", "Annual Leaves (Holiday)"],
  ];
  // If switching Business Unit hides the tab HR was already on (e.g. was on "Appointment
  // Template", switches to GenAquarius LLC), fall back to Salary & CTC rather than a blank pane.
  React.useEffect(() => {
    if (!buTabs.some(([k]) => k === tab)) setTab("ctc");
    // eslint-disable-next-line
  }, [isUsCanadaBu]);
  const globalTabs: [NonNullable<typeof globalTab>, string][] = [["workflow", "Workflow & Stage Configuration"]];
  return (
    <div>
      <h1>HR Settings</h1>
      <div className="subtitle">Salary, offer, appointment-letter, service-agreement and email rules live here — nothing is hard-coded in the offer engine.</div>

      <div style={{ display: "flex", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
        {globalTabs.map(([k, label]) => (
          <div key={k} onClick={() => setGlobalTab(globalTab === k ? null : k)} style={{ padding: "6px 12px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", color: globalTab === k ? "var(--accent)" : "var(--muted)", border: `1px solid ${globalTab === k ? "var(--accent)" : "var(--border)"}`, borderRadius: 6 }}>{label}</div>
        ))}
      </div>
      {globalTab ? (
        <div style={{ marginTop: 12 }}>
          {globalTab === "workflow" && <WorkflowBuilder />}
        </div>
      ) : (
        <>
          <BusinessUnitFilterBar businessUnitId={businessUnitId} setBusinessUnitId={setBusinessUnitId} />
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap" }}>
            {buTabs.map(([k, label]) => (
              <div key={k} onClick={() => setTab(k)} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === k ? "var(--accent)" : "var(--muted)", borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent" }}>{label}</div>
            ))}
          </div>
          {tab === "ctc" && <CtcBracketsSettings businessUnitId={businessUnitId} />}
          {tab === "offer" && <OfferTemplatesSettings businessUnitId={businessUnitId} />}
          {tab === "appointment" && <AppointmentTemplatesSettings businessUnitId={businessUnitId} />}
          {tab === "service-agreement" && <ServiceAgreementTemplateSettings businessUnitId={businessUnitId} />}
          {tab === "appraisal" && <AppraisalTemplatesSettings businessUnitId={businessUnitId} />}
          {tab === "relieving" && <RelievingLetterTemplatesSettings businessUnitId={businessUnitId} />}
          {tab === "msa" && <MsaSowTemplatesSettings businessUnitId={businessUnitId} docType="msa" />}
          {tab === "sow" && <MsaSowTemplatesSettings businessUnitId={businessUnitId} docType="sow" />}
          {tab === "signature" && <SignatureSettings businessUnitId={businessUnitId} />}
          {tab === "email" && <EmailTemplatesSettings businessUnitId={businessUnitId} />}
          {tab === "leave" && <LeavePolicySettings businessUnitId={businessUnitId} />}
          {tab === "onboarding-docs" && <OnboardingDocumentChecklistSettings businessUnitId={businessUnitId} />}
          {tab === "holidays" && <HolidaySettings businessUnitId={businessUnitId} />}
          {tab === "profile-fields" && <EmployeeProfileFieldsSettings businessUnitId={businessUnitId} />}
        </>
      )}
    </div>
  );
}

const PROFILE_FIELD_SECTIONS = [{ value: "PERSONAL", label: "Personal" }, { value: "ADDRESS", label: "Address" }, { value: "BANK", label: "Bank Account" }, { value: "PF", label: "PF Account" }, { value: "KYC", label: "KYC / Other IDs" }];
const PROFILE_FIELD_TYPES = [{ value: "TEXT", label: "Text" }, { value: "DATE", label: "Date" }, { value: "SELECT", label: "Dropdown" }, { value: "BOOLEAN", label: "Yes/No" }, { value: "NUMBER", label: "Number" }];

// Drives both the Employee Dashboard's "Additional Details" self-service form and HR's review
// screen — no field is ever hardcoded on either side, this catalog is the only source of truth
// for what fields exist, their type/options, and whether they're required.
function EmployeeProfileFieldsSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data: fields, reload } = useFetch<any[]>(`/hr-settings/profile-fields?businessUnitId=${businessUnitId}`, [businessUnitId]);
  const { show } = useToast();
  const [nf, setNf] = useState({ section: "PERSONAL", key: "", label: "", fieldType: "TEXT", options: "" });
  const bySection = PROFILE_FIELD_SECTIONS.map((s) => ({ ...s, rows: (fields || []).filter((f: any) => f.section === s.value) }));
  // Once this BU has ANY row of its own it's a fully independent set (server-side semantics) —
  // so "has its own rows" can't be told apart from "currently showing the inherited default" by
  // field CONTENT alone. Any create/edit/delete while on a non-default BU is this BU's own first
  // override row from that point on, so the Clone banner only needs to show before that happens —
  // tracked by whether a write has occurred THIS session, not re-derived from `fields`.
  const [hasOwnRows, setHasOwnRows] = useState(false);

  const addField = async () => {
    if (!nf.key.trim() || !nf.label.trim()) return show("Key and Label are required", "error");
    try {
      await api.post("/hr-settings/profile-fields", {
        section: nf.section, key: nf.key.trim().replace(/\s+/g, "_"), label: nf.label.trim(), fieldType: nf.fieldType,
        options: nf.fieldType === "SELECT" ? nf.options.split(",").map((o) => o.trim()).filter(Boolean) : undefined,
        order: (fields || []).filter((f: any) => f.section === nf.section).length,
        businessUnitId: businessUnitId === "null" ? undefined : Number(businessUnitId),
      });
      setNf({ section: nf.section, key: "", label: "", fieldType: "TEXT", options: "" });
      setHasOwnRows(true);
      show("Field added"); reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  const patch = async (id: number, data: any) => { await api.put(`/hr-settings/profile-fields/${id}`, data); reload(); };
  const del = async (id: number) => {
    const ok = await confirmDialog({ title: "Delete this field?", danger: true, message: "Any values already submitted for it stay on old submissions, but the field disappears from the form and review screen." });
    if (!ok) return;
    await api.del(`/hr-settings/profile-fields/${id}`); show("Deleted"); reload();
  };

  return (
    <div>
      <div className="subtitle" style={{ marginTop: 0 }}>Controls the "Additional Details" form on the Employee Dashboard and HR's review screen — add, edit, reorder-by-drag-free (use the order number), require or disable any field without touching code. A Business Unit with no fields of its own inherits the Company Default list entirely; adding one field here starts this Business Unit's own fully independent list.</div>
      {!hasOwnRows && (
        <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/profile-fields/clone-to-bu" label="profile field(s)"
          onCloned={() => { setHasOwnRows(true); reload(); }} />
      )}
      {bySection.map((s) => (
        <Panel key={s.value} title={s.label} style={{ marginBottom: 12 }}>
          {s.rows.length === 0 ? <div className="note">No fields yet.</div> : (
            <table><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Options (SELECT)</th><th>Order</th><th>Required</th><th>Enabled</th><th></th></tr></thead>
              <tbody>
                {s.rows.map((f: any) => (
                  <tr key={f.id}>
                    <td>
                      <input defaultValue={f.label} style={{ width: "100%", background: "transparent", border: "1px solid transparent" }}
                        onFocus={(e) => { e.target.style.border = "1px solid var(--border)"; }}
                        onBlur={(e) => { e.target.style.border = "1px solid transparent"; const label = e.target.value.trim(); if (label && label !== f.label) patch(f.id, { label }); }} />
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 11 }}>{f.key}</td>
                    <td style={{ color: "var(--muted)", fontSize: 12 }}>{PROFILE_FIELD_TYPES.find((t) => t.value === f.fieldType)?.label || f.fieldType}</td>
                    <td>
                      {f.fieldType === "SELECT" && (
                        <input defaultValue={(f.options || []).join(", ")} placeholder="Option A, Option B" style={{ width: "100%", background: "transparent", border: "1px solid transparent" }}
                          onFocus={(e) => { e.target.style.border = "1px solid var(--border)"; }}
                          onBlur={(e) => { e.target.style.border = "1px solid transparent"; patch(f.id, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) }); }} />
                      )}
                    </td>
                    <td style={{ width: 70 }}>
                      <input type="number" defaultValue={f.order} style={{ width: 60, background: "transparent", border: "1px solid var(--border)" }}
                        onBlur={(e) => { const order = Number(e.target.value) || 0; if (order !== f.order) patch(f.id, { order }); }} />
                    </td>
                    <td><input type="checkbox" defaultChecked={f.required} onChange={(e) => patch(f.id, { required: e.target.checked })} /></td>
                    <td><input type="checkbox" defaultChecked={f.enabled} onChange={(e) => patch(f.id, { enabled: e.target.checked })} /></td>
                    <td><GhostButton onClick={() => del(f.id)}>Delete</GhostButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ))}
      <Panel title="Add New Field">
        <div className="form-grid">
          <SelectField label="Section" value={nf.section} onChange={(e: any) => setNf({ ...nf, section: e.target.value })} options={PROFILE_FIELD_SECTIONS} />
          <Field label="Key (no spaces)" value={nf.key} onChange={(e: any) => setNf({ ...nf, key: e.target.value })} placeholder="e.g. bloodGroup" />
          <Field label="Label" value={nf.label} onChange={(e: any) => setNf({ ...nf, label: e.target.value })} placeholder="e.g. Blood Group" />
          <SelectField label="Field Type" value={nf.fieldType} onChange={(e: any) => setNf({ ...nf, fieldType: e.target.value })} options={PROFILE_FIELD_TYPES} />
          {nf.fieldType === "SELECT" && <Field label="Options (comma-separated)" value={nf.options} onChange={(e: any) => setNf({ ...nf, options: e.target.value })} placeholder="Option A, Option B" />}
        </div>
        <AddButton style={{ marginTop: 10 }} onClick={addField}>Add Field</AddButton>
      </Panel>
    </div>
  );
}

function CtcBracketsSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/ctc-brackets?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const [editing, setEditing] = useState<any>(null); // bracket being edited (component list)

  const saveComponent = async (bracketId: number, comp: any) => {
    if (comp.id) await api.put(`/hr-settings/components/${comp.id}`, comp);
    else await api.post(`/hr-settings/ctc-brackets/${bracketId}/components`, comp);
    show("Component saved"); reload();
  };

  return (
    <div>
      {(data || []).length === 0 && <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/ctc-brackets/clone-to-bu" onCloned={reload} label="CTC Brackets" />}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 14 }}>
      <Panel title="CTC Brackets">
        <table><thead><tr><th>Bracket</th><th className="num">Min</th><th className="num">Max</th><th>Reference</th></tr></thead>
          <tbody>
            {(data || []).map((b) => (
              <tr key={b.id} style={{ cursor: "pointer", background: editing?.id === b.id ? "var(--row-hover)" : undefined }} onClick={() => setEditing(b)}>
                <td>{b.name}</td><td className="num">{b.minCtc.toLocaleString()}</td><td className="num">{b.maxCtc == null ? "∞" : b.maxCtc.toLocaleString()}</td>
                <td style={{ fontSize: 11, color: "var(--muted)" }}>{b.referenceSheet}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>Click a bracket to edit its salary components on the right.</div>
      </Panel>
      <Panel title={editing ? `Salary Components — ${editing.name}` : "Select a bracket"}>
        {editing ? (
          <table><thead><tr><th>Component</th><th>Part</th><th className="num">% of CTC</th><th></th></tr></thead>
            <tbody>
              {(editing.components || []).map((c: any) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td><span className="pill">{c.part === "A" ? "Fixed" : "Flexi"}</span></td>
                  <td className="num">
                    <input type="number" step="0.01" defaultValue={c.pct} style={{ width: 80, textAlign: "right" }}
                      onBlur={(e) => { const pct = Number(e.target.value); if (pct !== c.pct) saveComponent(editing.id, { ...c, pct }); }} />
                  </td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div style={{ color: "var(--muted)" }}>No bracket selected.</div>}
        {editing && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>Percentages are of the total CTC (annual). They don't have to sum to exactly 100% while you're mid-edit.</div>}
      </Panel>
      </div>
    </div>
  );
}

export function TaxBracketsSettings({ businessUnitId }: { businessUnitId: string }) {
  const [regime, setRegime] = useState<"NEW" | "OLD">("NEW");
  const { data, reload } = useFetch<any[]>(`/hr-settings/tax-brackets?countryCode=INDIA&regime=${regime}&businessUnitId=${businessUnitId}`, [regime, businessUnitId]);
  const { data: regimeConfig, reload: reloadRegimeConfig } = useFetch<any>(`/hr-settings/tax-regime-config?countryCode=INDIA&regime=${regime}`, [regime]);
  const { show } = useToast();
  const saveRegimeConfig = async (field: string, value: number) => {
    await api.put("/hr-settings/tax-regime-config", { countryCode: "INDIA", regime, [field]: value });
    show("Saved"); reloadRegimeConfig();
  };
  const saveSlab = async (id: number, patch: any) => { await api.put(`/hr-settings/tax-brackets/${id}`, patch); show("Saved"); reload(); };
  const addSlab = async () => {
    const order = (data || []).length;
    await api.post("/hr-settings/tax-brackets", { countryCode: "INDIA", businessUnitId: businessUnitId === "null" ? null : Number(businessUnitId), regime, minIncome: 0, maxIncome: null, ratePct: 0, order });
    show("Slab added"); reload();
  };
  const deleteSlab = async (id: number) => {
    if (!window.confirm("Delete this tax slab?")) return;
    await api.del(`/hr-settings/tax-brackets/${id}`); show("Slab deleted"); reload();
  };
  return (
    <div>
    {(data || []).length === 0 && <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/tax-brackets/clone-to-bu" onCloned={reload} label="Tax Slabs" />}
    <div className="grid cols-2">
      <Panel title="Tax Slabs — India">
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <GhostButton onClick={() => setRegime("NEW")} style={regime === "NEW" ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>New Regime</GhostButton>
          <GhostButton onClick={() => setRegime("OLD")} style={regime === "OLD" ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>Old Regime</GhostButton>
        </div>
        <table><thead><tr><th className="num">Min</th><th className="num">Max</th><th className="num">Rate %</th><th></th></tr></thead>
          <tbody>
            {(data || []).map((s) => (
              <tr key={s.id}>
                <td className="num"><input type="number" defaultValue={s.minIncome} style={{ width: 90, textAlign: "right" }}
                  onBlur={(e) => { const v = Number(e.target.value); if (v !== s.minIncome) saveSlab(s.id, { minIncome: v }); }} /></td>
                <td className="num"><input type="number" placeholder="∞" defaultValue={s.maxIncome ?? ""} style={{ width: 90, textAlign: "right" }}
                  onBlur={(e) => { const raw = e.target.value; const v = raw === "" ? "" : Number(raw); if (v !== (s.maxIncome ?? "")) saveSlab(s.id, { maxIncome: raw === "" ? "" : v }); }} /></td>
                <td className="num"><input type="number" step="0.1" defaultValue={s.ratePct} style={{ width: 70, textAlign: "right" }}
                  onBlur={(e) => { const v = Number(e.target.value); if (v !== s.ratePct) saveSlab(s.id, { ratePct: v }); }} /></td>
                <td><GhostButton onClick={() => deleteSlab(s.id)}>Delete</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
        <AddButton style={{ marginTop: 10 }} onClick={addSlab}>+ Add Slab</AddButton>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>Leave Max blank for the top (open-ended) slab. Changes apply to every offer generated after saving — existing offer versions keep the numbers they were generated with.</div>
      </Panel>
      <Panel title={`Standard Deductions (India, ${regime === "NEW" ? "New" : "Old"} Regime)`}>
        {regimeConfig && (
          <>
            <Field key={`sd-${regime}`} label="Standard Deduction (₹/yr)" type="number" defaultValue={regimeConfig.standardDeduction} onBlur={(e: any) => saveRegimeConfig("standardDeduction", Number(e.target.value))} />
            <Field key={`cess-${regime}`} label="Cess %" type="number" defaultValue={regimeConfig.cessPct} onBlur={(e: any) => saveRegimeConfig("cessPct", Number(e.target.value))} />
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>Set independently per regime — switch the tab above to edit the other regime's deduction/cess.</div>
          </>
        )}
      </Panel>
    </div>
    </div>
  );
}

function OfferTemplatesSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/offer-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [body, setBody] = useState("");
  const saveBody = async () => { await api.put(`/hr-settings/offer-templates/${sel.id}`, { bodyText: body }); show("Template saved"); reload(); };

  // ✨ Advanced Builder — same bodyText being edited above, plus a live PDF preview pane that
  // re-renders (debounced 500ms) against a fake candidate as you type. Same pattern as the
  // Advanced Invoice Builder in Operations.tsx (Invoices()): postBlob → object URL → embed.
  const [advOpen, setAdvOpen] = useState(false);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !sel) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob("/hr-settings/offer-templates/preview-pdf", { bodyText: body, countryCode: sel.countryCode, minCtc: sel.minCtc, maxCtc: sel.maxCtc });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, body, sel?.id]);

  return (
    <div>
    {(data || []).length === 0 && <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/offer-templates/clone-to-bu" onCloned={reload} label="Offer Templates" />}
    <div className="grid cols-2">
      <Panel title="Offer Letter Templates">
        <table><thead><tr><th>Name</th><th>Country</th><th>CTC Range</th></tr></thead>
          <tbody>{(data || []).map((t) => (
            <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => { setSel(t); setBody(t.bodyText); }}>
              <td>{t.name}</td><td>{t.countryCode}</td><td>{t.minCtc.toLocaleString()} – {t.maxCtc == null ? "∞" : t.maxCtc.toLocaleString()}</td>
            </tr>
          ))}</tbody>
        </table>
      </Panel>
      <Panel title={sel ? `Edit — ${sel.name}` : "Select a template"}>
        {sel ? (
          <>
            <label>Body ({"{{"}Role{"}}"}, {"{{"}Designation{"}}"}, {"{{"}Ctc{"}}"}, {"{{"}OfferRef{"}}"}, {"{{"}Business{"}}"}, {"{{"}ProposedJoiningDate{"}}"}, {"{{"}CandidateFirstName{"}}"})</label>
            <textarea rows={16} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <AddButton onClick={saveBody}>Save Template</AddButton>
              <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
            </div>
          </>
        ) : <div style={{ color: "var(--muted)" }}>No template selected.</div>}
      </Panel>
      {advOpen && sel && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
        <div className="modal-card" style={{ width: "min(1400px, 96vw)", maxWidth: "min(1400px, 96vw)", height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{"✨ Advanced Offer Template Builder — " + sel.name}</h3>
            <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
            <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
          </div>
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ flex: "1 1 45%", display: "flex", flexDirection: "column", overflowY: "auto", paddingRight: 6 }}>
              <label>Body ({"{{"}Role{"}}"}, {"{{"}Designation{"}}"}, {"{{"}Ctc{"}}"}, {"{{"}OfferRef{"}}"}, {"{{"}Business{"}}"}, {"{{"}ProposedJoiningDate{"}}"}, {"{{"}CandidateFirstName{"}}"})</label>
              <textarea rows={26} style={{ width: "100%", flex: 1 }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="subtitle" style={{ marginTop: 6 }}>Preview uses a sample candidate ("Aditi Sharma") — never a real offer.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <AddButton onClick={saveBody}>Save Template</AddButton>
              </div>
            </div>
            <div style={{ flex: "1 1 55%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              {advPdfUrl ? <iframe title="Offer preview" src={advPdfUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      </div>}
    </div>
    </div>
  );
}

// MSA (Master Services Agreement) / SOW (Statement of Work) templates — US/Canada Vendor/
// Contractor engagements only (GenAquarius LLC / Aquarius Technologies Limited). Same simple
// list+edit pattern as OfferTemplatesSettings, PLUS the same live-PDF ✨ Advanced Builder (sample
// vendor/consultant/client data, not a real offer) — plus inline create, since these templates
// aren't necessarily pre-seeded for every Business Unit.
function MsaSowTemplatesSettings({ businessUnitId, docType }: { businessUnitId: string; docType: "msa" | "sow" }) {
  const endpoint = docType === "msa" ? "msa-templates" : "sow-templates";
  const label = docType === "msa" ? "MSA" : "SOW";
  const { data, reload } = useFetch<any[]>(`/hr-settings/${endpoint}?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [body, setBody] = useState("");
  const [nf, setNf] = useState({ name: "", entityName: "", entityAddress: "", governingLaw: "the State of California" });

  const select = (t: any) => { setSel(t); setBody(t.bodyText); };
  const saveBody = async () => { await api.put(`/hr-settings/${endpoint}/${sel.id}`, { bodyText: body }); show("Template saved"); reload(); };

  // ✨ Advanced Builder — same pattern as OfferTemplatesSettings: live PDF preview (debounced
  // 500ms) against sample vendor/consultant/client data, re-rendered via the real renderMsaSowPdf.
  const [advOpen, setAdvOpen] = useState(false);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !sel) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob(`/hr-settings/${endpoint}/preview-pdf`, { bodyText: body, entityName: sel.entityName, entityAddress: sel.entityAddress, governingLaw: sel.governingLaw });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, body, sel?.id]);
  const saveField = async (field: string, value: string) => { await api.put(`/hr-settings/${endpoint}/${sel.id}`, { [field]: value }); reload(); };
  const create = async () => {
    if (!nf.name.trim() || !nf.entityName.trim()) return show("Name and Entity Name are required", "error");
    const created: any = await api.post(`/hr-settings/${endpoint}`, { ...nf, businessUnitId: businessUnitId === "null" ? null : Number(businessUnitId), bodyText: "" });
    show(`${label} Template created`); setNf({ name: "", entityName: "", entityAddress: "", governingLaw: "the State of California" });
    reload(); select(created);
  };
  const del = async (delId: number) => {
    const ok = await confirmDialog({ title: `Delete this ${label} Template?`, danger: true });
    if (!ok) return;
    await api.del(`/hr-settings/${endpoint}/${delId}`); if (sel?.id === delId) setSel(null); show("Deleted"); reload();
  };

  return (
    <div className="grid cols-2">
      <Panel title={`${label} Templates`}>
        {(data || []).length === 0 ? <div className="note" style={{ marginBottom: 10 }}>No {label} Templates for this Business Unit yet — add one below.</div> : (
          <table><thead><tr><th>Name</th><th>Entity</th><th></th></tr></thead>
            <tbody>{(data || []).map((t) => (
              <tr key={t.id} style={{ cursor: "pointer", background: sel?.id === t.id ? "var(--row-hover)" : undefined }} onClick={() => select(t)}>
                <td>{t.name}</td><td>{t.entityName}</td>
                <td><GhostButton onClick={(e: any) => { e.stopPropagation(); del(t.id); }}>Delete</GhostButton></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <div className="subtitle" style={{ marginTop: 10 }}>
          Used only for a US/Canada Vendor/Contractor candidate (Stage 1's "Hired from Vendor" / "Contractor" engagement) —
          auto-filled from the Service Provider/consultant/rate/end-client fields captured there, then Preview/Email/Send-for-Signature/Upload from Offer Detail.
        </div>
        <Panel title={`+ New ${label} Template`} style={{ marginTop: 12 }}>
          <div className="form-grid">
            <Field label="Name" value={nf.name} onChange={(e: any) => setNf({ ...nf, name: e.target.value })} placeholder={`e.g. ${label} — Default`} />
            <Field label="Entity Name" value={nf.entityName} onChange={(e: any) => setNf({ ...nf, entityName: e.target.value })} placeholder="GenAquarius LLC" />
            <Field label="Entity Address" value={nf.entityAddress} onChange={(e: any) => setNf({ ...nf, entityAddress: e.target.value })} />
            {docType === "msa" && <Field label="Governing Law" value={nf.governingLaw} onChange={(e: any) => setNf({ ...nf, governingLaw: e.target.value })} />}
          </div>
          <AddButton style={{ marginTop: 10 }} onClick={create}>Create</AddButton>
        </Panel>
      </Panel>
      <Panel title={sel ? `Edit — ${sel.name}` : "Select a template"}>
        {sel ? (
          <>
            <div className="form-grid" style={{ marginBottom: 10 }}>
              <Field key={`en-${sel.id}`} label="Entity Name" defaultValue={sel.entityName} onBlur={(e: any) => saveField("entityName", e.target.value)} />
              <Field key={`ea-${sel.id}`} label="Entity Address" defaultValue={sel.entityAddress || ""} onBlur={(e: any) => saveField("entityAddress", e.target.value)} />
              {docType === "msa" && <Field key={`gl-${sel.id}`} label="Governing Law" defaultValue={sel.governingLaw || ""} onBlur={(e: any) => saveField("governingLaw", e.target.value)} />}
            </div>
            <label>Body ({"{{"}EntityName{"}}"}, {"{{"}EntityAddress{"}}"}, {"{{"}VendorName{"}}"}, {"{{"}VendorEin{"}}"}, {"{{"}VendorAddress{"}}"}, {"{{"}EffectiveDate{"}}"}{docType === "msa" ? <>, {"{{"}GoverningLaw{"}}"}</> : <>, {"{{"}ConsultantName{"}}"}, {"{{"}StartDate{"}}"}, {"{{"}ClientName{"}}"}, {"{{"}HourlyRate{"}}"}, {"{{"}EngagementDescription{"}}"}</>})</label>
            <textarea rows={20} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <AddButton onClick={saveBody}>Save Template</AddButton>
              <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
            </div>
          </>
        ) : <div style={{ color: "var(--muted)" }}>No template selected.</div>}
      </Panel>
      {advOpen && sel && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
        <div className="modal-card" style={{ width: "min(1400px, 96vw)", maxWidth: "min(1400px, 96vw)", height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{`✨ Advanced ${label} Template Builder — ${sel.name}`}</h3>
            <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
            <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
          </div>
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ flex: "1 1 45%", display: "flex", flexDirection: "column", overflowY: "auto", paddingRight: 6 }}>
              <label>Body ({"{{"}EntityName{"}}"}, {"{{"}EntityAddress{"}}"}, {"{{"}VendorName{"}}"}, {"{{"}VendorEin{"}}"}, {"{{"}VendorAddress{"}}"}, {"{{"}EffectiveDate{"}}"}{docType === "msa" ? <>, {"{{"}GoverningLaw{"}}"}</> : <>, {"{{"}ConsultantName{"}}"}, {"{{"}StartDate{"}}"}, {"{{"}ClientName{"}}"}, {"{{"}HourlyRate{"}}"}, {"{{"}EngagementDescription{"}}"}</>})</label>
              <textarea rows={26} style={{ width: "100%", flex: 1 }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="subtitle" style={{ marginTop: 6 }}>Preview uses a sample vendor/consultant/client — never a real offer.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <AddButton onClick={saveBody}>Save Template</AddButton>
              </div>
            </div>
            <div style={{ flex: "1 1 55%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              {advPdfUrl ? <iframe title={`${label} preview`} src={advPdfUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      </div>}
    </div>
  );
}

// Appraisal ("Annual Performance Review") letter template — same simple bodyText/{{placeholder}}
// Advanced Builder pattern as OfferTemplatesSettings above (a handful of flowing paragraphs, no
// clause library needed), just against a single template (no CTC-bracket variants).
function AppraisalTemplatesSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/appraisal-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [body, setBody] = useState("");
  const saveBody = async () => { await api.put(`/hr-settings/appraisal-templates/${sel.id}`, { name: sel.name, bodyText: body, isDefault: sel.isDefault }); show("Template saved"); reload(); };

  const [advOpen, setAdvOpen] = useState(false);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !sel) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob("/hr-settings/appraisal-templates/preview-pdf", { bodyText: body });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, body, sel?.id]);

  return (
    <div>
    {(data || []).length === 0 && <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/appraisal-templates/clone-to-bu" onCloned={reload} label="Appraisal Templates" />}
    <div className="grid cols-2">
      <Panel title="Appraisal Letter Templates">
        <table><thead><tr><th>Name</th><th>Default</th></tr></thead>
          <tbody>{(data || []).map((t) => (
            <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => { setSel(t); setBody(t.bodyText); }}>
              <td>{t.name}</td><td>{t.isDefault ? "Yes" : ""}</td>
            </tr>
          ))}</tbody>
        </table>
      </Panel>
      <Panel title={sel ? `Edit — ${sel.name}` : "Select a template"}>
        {sel ? (
          <>
            <label>Body ({"{{"}EmployeeName{"}}"}, {"{{"}Designation{"}}"}, {"{{"}RevisedCompensation{"}}"}, {"{{"}EffectiveDate{"}}"}, {"{{"}ReviewPeriod{"}}"})</label>
            <textarea rows={16} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <AddButton onClick={saveBody}>Save Template</AddButton>
              <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
            </div>
          </>
        ) : <div style={{ color: "var(--muted)" }}>No template selected.</div>}
      </Panel>
      {advOpen && sel && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
        <div className="modal-card" style={{ width: "min(1400px, 96vw)", maxWidth: "min(1400px, 96vw)", height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{"✨ Advanced Appraisal Template Builder — " + sel.name}</h3>
            <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
            <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
          </div>
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ flex: "1 1 45%", display: "flex", flexDirection: "column", overflowY: "auto", paddingRight: 6 }}>
              <label>Body ({"{{"}EmployeeName{"}}"}, {"{{"}Designation{"}}"}, {"{{"}RevisedCompensation{"}}"}, {"{{"}EffectiveDate{"}}"}, {"{{"}ReviewPeriod{"}}"})</label>
              <textarea rows={26} style={{ width: "100%", flex: 1 }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="subtitle" style={{ marginTop: 6 }}>Preview uses a sample employee ("Vaishali Lambat") — never a real employee.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <AddButton onClick={saveBody}>Save Template</AddButton>
              </div>
            </div>
            <div style={{ flex: "1 1 55%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              {advPdfUrl ? <iframe title="Appraisal preview" src={advPdfUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      </div>}
    </div>
    </div>
  );
}

// Relieving & Experience Certificate template — simple name/subject/body CRUD (no live-PDF
// Advanced Builder like Appraisal/Offer have; this letter has no CTC-bracket variant or clause
// library to justify one).
const RELIEVING_PLACEHOLDERS_LABEL = <>{"{{"}EmployeeName{"}}"}, {"{{"}Title{"}}"}, {"{{"}Pronoun{"}}"}, {"{{"}PronounSubj{"}}"}, {"{{"}PronounObj{"}}"}, {"{{"}CompanyName{"}}"}, {"{{"}Designation{"}}"}, {"{{"}Department{"}}"}, {"{{"}JoiningDate{"}}"}, {"{{"}LastWorkingDate{"}}"}, {"{{"}RelievedDate{"}}"}, {"{{"}ResignationDate{"}}"}</>;

function RelievingLetterTemplatesSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/relieving-letter-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Per-template signature override — blank falls back to the shared HR Signature, same convention
  // as the FnF Settlement Advanced Builder.
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryTitle, setSignatoryTitle] = useState("");
  const select = (t: any) => { setSel(t); setSubject(t.subject); setBody(t.bodyText); setSignatoryName(t.signatoryName || ""); setSignatoryTitle(t.signatoryTitle || ""); };
  const saveBody = async () => { await api.put(`/hr-settings/relieving-letter-templates/${sel.id}`, { name: sel.name, subject, bodyText: body, isDefault: sel.isDefault, signatoryName, signatoryTitle }); show("Template saved"); reload(); };

  const [advOpen, setAdvOpen] = useState(false);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !sel) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob("/hr-settings/relieving-letter-templates/preview-pdf", { subject, bodyText: body, signatoryName, signatoryTitle });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, subject, body, signatoryName, signatoryTitle, sel?.id]);
  // Letter-styled, directly-editable rich text view (contentEditable) instead of a plain monospace
  // textarea — looks like the actual document while typing, same pattern as Finance's invoice email
  // body editor (Operations.tsx). Placeholders ({{Token}}) stay visible as literal text since this
  // is a template, not a filled instance.
  const LETTER_STYLE: React.CSSProperties = {
    background: "#fff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 8,
    padding: "28px 34px", lineHeight: 1.7, fontSize: 14, fontFamily: "Georgia, 'Times New Roman', serif",
    outline: "none", cursor: "text", minHeight: 260, overflowY: "auto",
  };

  return (
    <div>
      {(data || []).length === 0 && <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/relieving-letter-templates/clone-to-bu" onCloned={reload} label="Relieving Letter Templates" />}
      <div className="grid cols-2">
        <Panel title="Relieving Letter Templates">
          <table><thead><tr><th>Name</th><th>Default</th></tr></thead>
            <tbody>{(data || []).map((t) => (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => select(t)}>
                <td>{t.name}</td><td>{t.isDefault ? "Yes" : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
        <Panel title={sel ? `Edit — ${sel.name}` : "Select a template"}>
          {sel ? (
            <>
              <Field label="Default Email Subject" value={subject} onChange={(e: any) => setSubject(e.target.value)} />
              <div className="grid cols-2" style={{ marginTop: 8 }}>
                <Field label="Signatory Name (blank = shared HR Signature)" value={signatoryName} onChange={(e: any) => setSignatoryName(e.target.value)} placeholder="e.g. Vivek Kaw" />
                <Field label="Signatory Title" value={signatoryTitle} onChange={(e: any) => setSignatoryTitle(e.target.value)} placeholder="e.g. CHRO, GenAquarius" />
              </div>
              <label style={{ marginTop: 8, display: "block" }}>Body ({RELIEVING_PLACEHOLDERS_LABEL})</label>
              <div
                key={sel.id}
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => setBody((e.target as HTMLDivElement).innerText.replace(/\n$/, ""))}
                dangerouslySetInnerHTML={{ __html: body.replace(/\n/g, "<br>") }}
                style={LETTER_STYLE}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <AddButton onClick={saveBody}>Save Template</AddButton>
                <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
              </div>
            </>
          ) : <div style={{ color: "var(--muted)" }}>No template selected.</div>}
        </Panel>
        {advOpen && sel && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
          <div className="modal-card" style={{ width: "min(1400px, 96vw)", maxWidth: "min(1400px, 96vw)", height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{"✨ Advanced Relieving Letter Template Builder — " + sel.name}</h3>
              <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
              <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
            </div>
            <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
              <div style={{ flex: "1 1 45%", display: "flex", flexDirection: "column", overflowY: "auto", paddingRight: 6 }}>
                <Field label="Default Email Subject" value={subject} onChange={(e: any) => setSubject(e.target.value)} />
                <div className="grid cols-2" style={{ marginTop: 8 }}>
                  <Field label="Signatory Name (blank = shared HR Signature)" value={signatoryName} onChange={(e: any) => setSignatoryName(e.target.value)} placeholder="e.g. Vivek Kaw" />
                  <Field label="Signatory Title" value={signatoryTitle} onChange={(e: any) => setSignatoryTitle(e.target.value)} placeholder="e.g. CHRO, GenAquarius" />
                </div>
                <label style={{ marginTop: 8 }}>Body ({RELIEVING_PLACEHOLDERS_LABEL}) — edit directly below, formatted like the real letter</label>
                <div
                  key={sel.id}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) => setBody((e.target as HTMLDivElement).innerText.replace(/\n$/, ""))}
                  dangerouslySetInnerHTML={{ __html: body.replace(/\n/g, "<br>") }}
                  style={{ ...LETTER_STYLE, flex: 1 }}
                />
                <div className="subtitle" style={{ marginTop: 6 }}>Preview uses a sample employee ("Tripurari Kumar Ojha") — never a real employee.</div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <AddButton onClick={saveBody}>Save Template</AddButton>
                </div>
              </div>
              <div style={{ flex: "1 1 55%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                {advPdfUrl ? <iframe title="Relieving letter preview" src={advPdfUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                  : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
              </div>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}

// The signatory shown on every generated Offer/Appointment/Appraisal/Service Agreement PDF —
// configurable here instead of the original hard-coded "Vivek Kaw / CHRO" + static asset image.
// Leaving Name/Title blank keeps each document's own original default wording.
function SignatureSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any>(`/hr-settings/signature?businessUnitId=${businessUnitId}`, [businessUnitId]);
  const { show } = useToast();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [imageData, setImageData] = useState<string | null>(null); // newly-picked file, base64 (no data: prefix) — null = keep existing
  const [busy, setBusy] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [nonce, setNonce] = useState(0); // bumped on save so the <img> re-fetches instead of showing a cached copy
  React.useEffect(() => { setLoadedOnce(false); }, [businessUnitId]); // re-load Name/Title when switching Business Unit
  if (data && !loadedOnce) { setLoadedOnce(true); setName(data.signatoryName === "Vivek Kaw" ? "" : data.signatoryName || ""); setTitle(data.signatoryTitle === "CHRO" ? "" : data.signatoryTitle || ""); }

  const onFile = (file?: File) => {
    if (!file) return;
    if (file.size > 500 * 1024) return show("Signature image must be under 500 KB", "error");
    const r = new FileReader();
    r.onload = () => setImageData(String(r.result).split(",")[1] || "");
    r.readAsDataURL(file);
  };
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { signatoryName: name || undefined, signatoryTitle: title || undefined, businessUnitId: businessUnitId === "null" ? null : Number(businessUnitId) };
      if (imageData !== null) body.imageData = imageData;
      await api.put("/hr-settings/signature", body);
      show("Signature saved"); setImageData(null); setNonce((n) => n + 1); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <Panel title="Signature">
      <div className="subtitle" style={{ marginTop: 0 }}>Shown on every generated Offer Letter, Appointment Letter, Appraisal Letter and Service Agreement. Leave Name/Title blank to keep each document's own default wording ("Vivek Kaw" / "CHRO").</div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label="Signatory Name (optional)" value={name} onChange={(e: any) => setName(e.target.value)} placeholder="Vivek Kaw" />
        <Field label="Signatory Title (optional)" value={title} onChange={(e: any) => setTitle(e.target.value)} placeholder="CHRO" />
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Signature Image</label>
        <input type="file" accept="image/*" onChange={(e: any) => onFile(e.target.files?.[0])} />
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
          {imageData ? (
            <img src={`data:image/png;base64,${imageData}`} alt="new signature" style={{ maxHeight: 48, background: "#fff", borderRadius: 6, padding: 4 }} />
          ) : data?.hasImage ? (
            <img src={api.pdfUrl(`/hr-settings/signature/image?v=${nonce}&businessUnitId=${businessUnitId}`)} alt="current signature" style={{ maxHeight: 48, background: "#fff", borderRadius: 6, padding: 4 }} />
          ) : (
            <span className="subtitle" style={{ margin: 0 }}>No image uploaded yet — documents use their own built-in script-style signature.</span>
          )}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <AddButton disabled={busy} onClick={save}>Save Signature</AddButton>
      </div>
    </Panel>
  );
}

function AppointmentTemplatesSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/appointment-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const tpl = (data || [])[0];
  const [clauses, setClauses] = useState<any[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  React.useEffect(() => { if (tpl) { setClauses(tpl.clauses || []); setDirty(false); } }, [tpl?.id]);

  const update = (i: number, patch: any) => { setClauses((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c))); setDirty(true); };
  const toggle = (i: number) => update(i, { enabled: !(clauses[i].enabled !== false) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= clauses.length) return;
    const next = [...clauses];
    [next[i], next[j]] = [next[j], next[i]];
    next.forEach((c, idx) => (c.order = idx));
    setClauses(next); setDirty(true);
  };
  const addClause = () => {
    const key = `clause_${Date.now()}`;
    setClauses((cs) => [...cs, { key, title: "New Clause", points: [""], enabled: true, order: cs.length }]);
    setOpenKey(key); setDirty(true);
  };
  const deleteClause = (i: number) => {
    if (!window.confirm(`Delete clause "${clauses[i].title}"? This can't be undone once saved.`)) return;
    setClauses((cs) => cs.filter((_, idx) => idx !== i).map((c, idx) => ({ ...c, order: idx })));
    setDirty(true);
  };
  const save = async () => { if (!tpl) return; await api.put(`/hr-settings/appointment-templates/${tpl.id}`, { clauses }); show("Saved"); setDirty(false); reload(); };

  // A clause's points may be a plain string (numbered "N.M") or {text, unnumbered?, subpoints?}
  // (a flowing paragraph with no number, or one with its own lettered a/b/c sub-list) — normalize
  // to objects for editing, and fall back for any pre-existing single-`body` clause.
  const pointsOf = (c: any): { text: string; unnumbered?: boolean; subpoints?: string[] }[] =>
    Array.isArray(c.points) ? c.points.map((p: any) => (typeof p === "string" ? { text: p } : p)) : c.body ? [{ text: c.body, unnumbered: true }] : [];
  const setPoints = (i: number, points: any[]) => update(i, { points });
  const updatePoint = (i: number, pi: number, patch: any) => {
    const pts = pointsOf(clauses[i]);
    pts[pi] = { ...pts[pi], ...patch };
    setPoints(i, pts);
  };
  const addPoint = (i: number) => setPoints(i, [...pointsOf(clauses[i]), { text: "" }]);
  const deletePoint = (i: number, pi: number) => setPoints(i, pointsOf(clauses[i]).filter((_, idx) => idx !== pi));
  const addSubpoint = (i: number, pi: number) => {
    const pts = pointsOf(clauses[i]);
    pts[pi] = { ...pts[pi], subpoints: [...(pts[pi].subpoints || []), ""] };
    setPoints(i, pts);
  };
  const updateSubpoint = (i: number, pi: number, si: number, text: string) => {
    const pts = pointsOf(clauses[i]);
    const subpoints = [...(pts[pi].subpoints || [])]; subpoints[si] = text;
    pts[pi] = { ...pts[pi], subpoints };
    setPoints(i, pts);
  };
  const deleteSubpoint = (i: number, pi: number, si: number) => {
    const pts = pointsOf(clauses[i]);
    pts[pi] = { ...pts[pi], subpoints: (pts[pi].subpoints || []).filter((_: any, idx: number) => idx !== si) };
    setPoints(i, pts);
  };

  // ✨ Advanced Builder — the SAME clause-editing UI below (renderClauseList()), reused verbatim
  // inside a wizard modal with a live PDF preview pane alongside it (debounced 500ms, re-renders
  // via the real renderAppointmentPdf() against a fake employee). Editing here or inline edits the
  // same `clauses` state — there is no separate/parallel copy of the data.
  const [advOpen, setAdvOpen] = useState(false);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !tpl) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob("/hr-settings/appointment-templates/preview-pdf", { clauses, countryCode: tpl.countryCode });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, clauses, tpl?.id]);

  const renderClauseList = () => (
    <>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
        Click a clause to view/edit it — every sub-point (rendered "N.1", "N.2", … on the PDF, matching the real Appointment Letter's own numbering) is its own editable line, not one big paragraph.
        Supports {"{{"}EmployeeName{"}}"}, {"{{"}EmployeeId{"}}"}, {"{{"}JoiningDate{"}}"}, {"{{"}ReportingManager{"}}"}, {"{{"}WorkLocation{"}}"} and other dynamic fields.
      </div>
      {clauses.map((c, i) => {
        const open = openKey === c.key;
        const pts = pointsOf(c);
        return (
          <div key={c.key} style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer", background: open ? "var(--panel2)" : undefined }}
              onClick={() => setOpenKey(open ? null : c.key)}>
              <span style={{ color: "var(--muted)", fontSize: 11, width: 18 }}>{i + 1}</span>
              <input value={c.title} onClick={(e) => e.stopPropagation()} onChange={(e) => update(i, { title: e.target.value })}
                style={{ flex: 1, background: "transparent", border: "none", color: "var(--text)", fontWeight: 600, fontSize: 13 }} />
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--muted)" }} onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={c.enabled !== false} onChange={() => toggle(i)} /> Included
              </label>
              <GhostButton onClick={(e: any) => { e.stopPropagation(); move(i, -1); }} disabled={i === 0}>↑</GhostButton>
              <GhostButton onClick={(e: any) => { e.stopPropagation(); move(i, 1); }} disabled={i === clauses.length - 1}>↓</GhostButton>
              <GhostButton onClick={(e: any) => { e.stopPropagation(); deleteClause(i); }}>Delete</GhostButton>
            </div>
            {open && (
              <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
                {pts.map((p, pi) => (
                  <div key={pi} style={{ marginBottom: 10, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ color: "var(--muted)", fontSize: 11, width: 34, paddingTop: 6 }}>{p.unnumbered ? "—" : `${i + 1}.${pts.slice(0, pi + 1).filter((x) => !x.unnumbered).length}`}</span>
                      <textarea rows={3} style={{ flex: 1 }} value={p.text} onChange={(e) => updatePoint(i, pi, { text: e.target.value })} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                          <input type="checkbox" checked={!!p.unnumbered} onChange={(e) => updatePoint(i, pi, { unnumbered: e.target.checked })} /> No number
                        </label>
                        <GhostButton onClick={() => deletePoint(i, pi)}>Delete</GhostButton>
                      </div>
                    </div>
                    {(p.subpoints || []).length > 0 && (
                      <div style={{ marginLeft: 42, marginTop: 6 }}>
                        {p.subpoints!.map((sp, si) => (
                          <div key={si} style={{ display: "flex", gap: 8, marginBottom: 4, alignItems: "flex-start" }}>
                            <span style={{ color: "var(--muted)", fontSize: 11, width: 18, paddingTop: 6 }}>{String.fromCharCode(97 + si)}.</span>
                            <textarea rows={2} style={{ flex: 1 }} value={sp} onChange={(e) => updateSubpoint(i, pi, si, e.target.value)} />
                            <GhostButton onClick={() => deleteSubpoint(i, pi, si)}>Delete</GhostButton>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginLeft: 42, marginTop: 4 }}>
                      <GhostButton onClick={() => addSubpoint(i, pi)}>+ Add sub-point (a, b, c…)</GhostButton>
                    </div>
                  </div>
                ))}
                <GhostButton onClick={() => addPoint(i)}>+ Add Point</GhostButton>
              </div>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <GhostButton onClick={addClause}>+ Add Clause</GhostButton>
        <AddButton onClick={save} disabled={!dirty}>{dirty ? "Save Changes" : "Saved"}</AddButton>
      </div>
    </>
  );

  if (!tpl) {
    if (!data) return <div>Loading…</div>;
    return <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/appointment-templates/clone-to-bu" onCloned={reload} label="Appointment Template" />;
  }
  return (
    <>
      <Panel title={`Clause Library — ${tpl.name}`}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
        </div>
        {renderClauseList()}
      </Panel>
      {advOpen && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
        <div className="modal-card" style={{ width: "min(1560px, 97vw)", maxWidth: "min(1560px, 97vw)", height: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{"✨ Advanced Appointment Letter Builder — " + tpl.name}</h3>
            <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
            <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
          </div>
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ flex: "1 1 52%", overflowY: "auto", paddingRight: 6 }}>{renderClauseList()}</div>
            <div style={{ flex: "1 1 48%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div className="subtitle" style={{ marginBottom: 6 }}>Preview uses a sample employee ("Aditi Sharma", 1234) — never a real employee.</div>
              {advPdfUrl ? <iframe title="Appointment preview" src={advPdfUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      </div>}
    </>
  );
}

// =====================================================================================
// Service Agreement (CONTRACTOR) — Clause Library + editable Services list. A dedicated
// component rather than a generalization of AppointmentTemplatesSettings above: the point
// shape is different here (align/servicesList/bankBlock vs unnumbered/subpoints), and the
// user's own guidance was "duplication is acceptable if generalizing risks the existing
// Appointment clause editor" — this never touches that component.
// =====================================================================================
function ServiceAgreementTemplateSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/service-agreement-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const tpl = (data || [])[0];
  const [clauses, setClauses] = useState<any[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  React.useEffect(() => { if (tpl) { setClauses(tpl.clauses || []); setServices(tpl.services || []); setDirty(false); } }, [tpl?.id]);

  const update = (i: number, patch: any) => { setClauses((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c))); setDirty(true); };
  const toggle = (i: number) => update(i, { enabled: !(clauses[i].enabled !== false) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= clauses.length) return;
    const next = [...clauses];
    [next[i], next[j]] = [next[j], next[i]];
    next.forEach((c, idx) => (c.order = idx));
    setClauses(next); setDirty(true);
  };
  const addClause = () => {
    const key = `clause_${Date.now()}`;
    setClauses((cs) => [...cs, { key, articleLabel: "", pointStyle: "plain", points: [""], enabled: true, order: cs.length }]);
    setOpenKey(key); setDirty(true);
  };
  const deleteClause = (i: number) => {
    if (!window.confirm(`Delete clause "${clauses[i].articleLabel || clauses[i].key}"? This can't be undone once saved.`)) return;
    setClauses((cs) => cs.filter((_, idx) => idx !== i).map((c, idx) => ({ ...c, order: idx })));
    setDirty(true);
  };
  const save = async () => { if (!tpl) return; await api.put(`/hr-settings/service-agreement-templates/${tpl.id}`, { clauses, services }); show("Saved"); setDirty(false); reload(); };

  const pointsOf = (c: any): { text: string; align?: string; servicesList?: boolean; bankBlock?: boolean }[] =>
    Array.isArray(c.points) ? c.points.map((p: any) => (typeof p === "string" ? { text: p } : p)) : [];
  const setPoints = (i: number, points: any[]) => update(i, { points });
  const updatePoint = (i: number, pi: number, patch: any) => {
    const pts = pointsOf(clauses[i]);
    pts[pi] = { ...pts[pi], ...patch };
    setPoints(i, pts);
  };
  const addPoint = (i: number) => setPoints(i, [...pointsOf(clauses[i]), { text: "" }]);
  const deletePoint = (i: number, pi: number) => setPoints(i, pointsOf(clauses[i]).filter((_, idx) => idx !== pi));

  const updateService = (i: number, text: string) => { setServices((s) => s.map((x, idx) => (idx === i ? text : x))); setDirty(true); };
  const addService = () => { setServices((s) => [...s, "New Service"]); setDirty(true); };
  const deleteService = (i: number) => { setServices((s) => s.filter((_, idx) => idx !== i)); setDirty(true); };
  const moveService = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= services.length) return;
    const next = [...services];
    [next[i], next[j]] = [next[j], next[i]];
    setServices(next); setDirty(true);
  };

  // ✨ Advanced Builder — the SAME clause + services editors below (renderClauseList() /
  // renderServicesList()), reused verbatim inside a wizard modal with a live PDF preview pane
  // alongside (debounced 500ms, re-renders via the real renderServiceAgreementPdf() against a
  // fake contractor). Editing here or inline edits the same `clauses`/`services` state.
  const [advOpen, setAdvOpen] = useState(false);
  const [advPdfUrl, setAdvPdfUrl] = useState<string | null>(null);
  const [advPdfBusy, setAdvPdfBusy] = useState(false);
  const advPdfSeq = React.useRef(0);
  React.useEffect(() => {
    if (!advOpen || !tpl) return;
    const seq = ++advPdfSeq.current;
    const t = setTimeout(async () => {
      setAdvPdfBusy(true);
      try {
        const blob = await api.postBlob("/hr-settings/service-agreement-templates/preview-pdf", { clauses, services, countryCode: tpl.countryCode });
        if (seq === advPdfSeq.current) setAdvPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep the previous preview on transient errors */ }
      finally { if (seq === advPdfSeq.current) setAdvPdfBusy(false); }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [advOpen, clauses, services, tpl?.id]);

  const renderClauseList = () => (
    <>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
        Each clause maps to an Article of the real Service Agreement (Article 1. Performance of Work, Article 2. Term and Termination, …). "Roman Heading" is how Article 3's "I. TERMS &amp; CONDITION" / "II. SERVICE PROVIDER EXPENSES" sub-sections are represented — two clauses sharing one Article, the second with a blank Article Label. Point Style controls how each point is marked: lettered (a, b, c…), bulleted (•) or plain (flowing paragraph). Wrap text in **double-asterisks** for bold, e.g. **{"{{"}EffectiveDate{"}}"}**. Supports {"{{"}EffectiveDate{"}}"}, {"{{"}ContractorName{"}}"}, {"{{"}AadharNumber{"}}"}, {"{{"}ContractorAddress{"}}"}, {"{{"}MonthlyCompensationAmount{"}}"}, {"{{"}MonthlyCompensationWords{"}}"} and the bank fields.
      </div>
      {clauses.map((c, i) => {
          const open = openKey === c.key;
          const pts = pointsOf(c);
          return (
            <div key={c.key} style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer", background: open ? "var(--panel2)" : undefined }}
                onClick={() => setOpenKey(open ? null : c.key)}>
                <span style={{ color: "var(--muted)", fontSize: 11, width: 18 }}>{i + 1}</span>
                <input value={c.articleLabel || ""} placeholder="(continuation — no Article heading)" onClick={(e) => e.stopPropagation()} onChange={(e) => update(i, { articleLabel: e.target.value })}
                  style={{ flex: 1, background: "transparent", border: "none", color: "var(--text)", fontWeight: 600, fontSize: 13 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--muted)" }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={c.enabled !== false} onChange={() => toggle(i)} /> Included
                </label>
                <GhostButton onClick={(e: any) => { e.stopPropagation(); move(i, -1); }} disabled={i === 0}>↑</GhostButton>
                <GhostButton onClick={(e: any) => { e.stopPropagation(); move(i, 1); }} disabled={i === clauses.length - 1}>↓</GhostButton>
                <GhostButton onClick={(e: any) => { e.stopPropagation(); deleteClause(i); }}>Delete</GhostButton>
              </div>
              {open && (
                <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "block" }}>Roman Heading (optional)</label>
                      <input value={c.romanHeading || ""} placeholder="e.g. I. TERMS &amp; CONDITION" onChange={(e) => update(i, { romanHeading: e.target.value })} style={{ width: 260 }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "block" }}>Point Style</label>
                      <select value={c.pointStyle || "plain"} onChange={(e) => update(i, { pointStyle: e.target.value })}>
                        <option value="lettered">Lettered (a, b, c…)</option>
                        <option value="bulleted">Bulleted (•)</option>
                        <option value="plain">Plain paragraph</option>
                      </select>
                    </div>
                  </div>
                  {pts.map((p, pi) => (
                    <div key={pi} style={{ marginBottom: 10, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <textarea rows={3} style={{ flex: 1 }} value={p.text} onChange={(e) => updatePoint(i, pi, { text: e.target.value })} />
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                            <input type="checkbox" checked={p.align === "center"} onChange={(e) => updatePoint(i, pi, { align: e.target.checked ? "center" : undefined })} /> Centered
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                            <input type="checkbox" checked={!!p.servicesList} onChange={(e) => updatePoint(i, pi, { servicesList: e.target.checked })} /> + Services list
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                            <input type="checkbox" checked={!!p.bankBlock} onChange={(e) => updatePoint(i, pi, { bankBlock: e.target.checked })} /> + Bank details block
                          </label>
                          <GhostButton onClick={() => deletePoint(i, pi)}>Delete</GhostButton>
                        </div>
                      </div>
                    </div>
                  ))}
                  <GhostButton onClick={() => addPoint(i)}>+ Add Point</GhostButton>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <GhostButton onClick={addClause}>+ Add Clause</GhostButton>
          <AddButton onClick={save} disabled={!dirty}>{dirty ? "Save Changes" : "Saved"}</AddButton>
        </div>
    </>
  );

  const renderServicesList = () => (
    <>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>Varies per engagement — the numbered "1) Technical Analysis, 2) Data Analysis, …" list on the Service Agreement.</div>
      {services.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <span style={{ color: "var(--muted)", fontSize: 11, width: 18 }}>{i + 1})</span>
          <input value={s} onChange={(e) => updateService(i, e.target.value)} style={{ flex: 1 }} />
          <GhostButton onClick={() => moveService(i, -1)} disabled={i === 0}>↑</GhostButton>
          <GhostButton onClick={() => moveService(i, 1)} disabled={i === services.length - 1}>↓</GhostButton>
          <GhostButton onClick={() => deleteService(i)}>Delete</GhostButton>
        </div>
      ))}
      <GhostButton onClick={addService} style={{ marginTop: 6 }}>+ Add Service</GhostButton>
    </>
  );

  if (!tpl) {
    if (!data) return <div>Loading…</div>;
    return <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/service-agreement-templates/clone-to-bu" onCloned={reload} label="Service Agreement Template" />;
  }
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
        <Panel title={`Clause Library — ${tpl.name}`}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <GhostButton onClick={() => setAdvOpen(true)}>✨ Advanced Builder</GhostButton>
          </div>
          {renderClauseList()}
        </Panel>
        <Panel title="Services (Article 1(a) numbered list)">
          {renderServicesList()}
        </Panel>
      </div>
      {advOpen && <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setAdvOpen(false); }}>
        <div className="modal-card" style={{ width: "min(1560px, 97vw)", maxWidth: "min(1560px, 97vw)", height: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{"✨ Advanced Service Agreement Builder — " + tpl.name}</h3>
            <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{advPdfBusy ? "⟳ updating live preview…" : "live preview — every change re-renders the PDF →"}</span>
            <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => setAdvOpen(false)}>✕ Close</button>
          </div>
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ flex: "1 1 40%", overflowY: "auto", paddingRight: 6 }}>
              {renderClauseList()}
              <div className="label" style={{ margin: "14px 0 6px" }}>Services (Article 1(a) numbered list)</div>
              {renderServicesList()}
            </div>
            <div style={{ flex: "1 1 60%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div className="subtitle" style={{ marginBottom: 6 }}>Preview uses a sample contractor ("Rahul Mehta") — never a real contractor.</div>
              {advPdfUrl ? <iframe title="Service Agreement preview" src={advPdfUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
            </div>
          </div>
        </div>
      </div>}
    </>
  );
}

const EMAIL_TEMPLATE_LABELS: Record<string, string> = {
  OFFER_EMAIL: "Offer Email",
  APPOINTMENT_EMAIL: "Appointment Letter Email",
  OFFER_WITHDRAWN_EMAIL: "Offer Withdrawn / Cancelled Email",
  SERVICE_AGREEMENT_EMAIL: "Service Agreement Email",
  SERVICE_AGREEMENT_WITHDRAWN_EMAIL: "Service Agreement Withdrawn / Cancelled Email",
  INTERNSHIP_LETTER: "Internship Letter (Intern — replaces the Contractor Service Agreement)",
  DOCUMENT_COLLECTION_REQUEST_EMAIL: "Mandatory Document Collection — Request Email",
  DOCUMENT_REJECTION_EMAIL: "Mandatory Document Collection — Rejected Documents Email",
  NEW_EMPLOYEE_CTC_APPROVAL: "New Employee — CTC Approval Notice (to Finance)",
  WELCOME_EMAIL: "Welcome Email (sent by IT Admin on O365 account creation)",
  IT_PROVISIONING_NOTIFICATION: "IT Admin — New Provisioning Request Notification",
  O365_ADMIN_EMAIL: "IT Admin — Office 365 Admin Approval Email",
  APPRAISAL_LETTER_EMAIL: "Annual Performance Review Email",
  APPRAISAL_LETTER_EMAIL_STAGE: "Annual Performance Review Email — 2-Stage (Staged Raise)",
  APPRAISAL_CTC_APPROVAL_REQUEST: "Appraisal CTC Approval Notice (to Finance)",
};
// Sample token values so the live preview reads naturally regardless of which HR email key is
// selected — every {{Token}} any of the 5 keys uses is covered here.
const EMAIL_PREVIEW_SAMPLE: Record<string, string> = {
  CandidateFirstName: "Aditi", Role: "Software Engineer", Designation: "Software Engineer", Business: "GenAquarius Technologies",
  ProposedJoiningDate: "20th Jan 2026", OfferRef: "OFR-2026-0142", OfferDate: "8th Jan 2026",
  EmployeeName: "Aditi Sharma", EmployeeId: "1042", DateOfAppointment: "20th Jan 2026",
  RevisedCompensation: "₹14,40,000/- per annum", EffectiveDate: "1st Oct 2026",
  SecondRevisedCompensation: "₹15,60,000/- per annum", SecondEffectiveDate: "1st Jan 2027",
  ReportingManager: "Sandeep Minocha", WorkLocation: "Noida Office",
  EmployeeType: "Employee", CtcSummary: "₹12,00,000 / annum", CtcEffectiveFrom: "18th Sep 2026", ProjectName: "Bench",
  DocumentList: "• PAN Card<br>• Educational Certificate – Highest Qualification<br>• Passport-size Photograph<br>• Last 3 Months' Salary Slips",
  UploadLink: "<a href=\"#\">Upload Documents</a>",
  RejectedDocumentsList: "1. Address Proof<br>&nbsp;&nbsp;&nbsp;Reason: Document is not clearly readable.",
  firstName: "Aditi", lastName: "Sharma", displayName: "Aditi Sharma", personalEmail: "aditi.sharma@example.com",
  jobTitle: "Software Engineer", department: "Engineering", requestId: "42", laptopConfiguration: "Dell Latitude 5440, i7, 512GB SSD",
  ram: "16 GB", requiredApplications: "MS Office, VS Code", requiredAccess: "GitHub, VPN", otherRequirements: "—",
  Date: "12th June 2026", CandidateName: "Devansh Dixit", Department: "IT", StartDate: "1st June 2026",
  EndDate: "31st July 2026", Location: "Hybrid", DurationText: "2 months (1st June 2026 to 31st July 2026)",
};
function fillPreview(tpl: string): string {
  return String(tpl || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => EMAIL_PREVIEW_SAMPLE[key] ?? `{{${key}}}`);
}
function EmailTemplatesSettings({ businessUnitId }: { businessUnitId: string }) {
  const { data, reload } = useFetch<any[]>(`/hr-settings/email-templates?businessUnitId=${businessUnitId}`);
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [signature, setSignature] = useState(""); const [showLogo, setShowLogo] = useState(true);
  const [busy, setBusy] = useState(false);
  const select = (t: any) => { setSel(t); setSubject(t.subject); setBody(t.body); setSignature(t.signature || ""); setShowLogo(t.showLogo !== false); };
  const save = async () => {
    setBusy(true);
    try { await api.put(`/hr-settings/email-templates/${sel.key}`, { subject, body, signature, showLogo, businessUnitId: businessUnitId === "null" ? null : Number(businessUnitId) }); show("Saved"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  if (data && data.length === 0 && businessUnitId !== "null") {
    return <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/email-templates/clone-to-bu" onCloned={reload} label="Email Templates" />;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 18 }}>
      <Panel title="Templates">
        {(data || []).map((t) => (
          <div key={t.key} style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 6, cursor: "pointer", background: sel?.key === t.key ? "var(--panel2)" : undefined }}
            onClick={() => select(t)}>{EMAIL_TEMPLATE_LABELS[t.key] || t.key}</div>
        ))}
      </Panel>
      {!sel ? <Panel title="Select a template"><div className="subtitle" style={{ marginTop: 0 }}>Pick a template on the left to edit it.</div></Panel> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          {/* ---- Left: editor ---- */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{EMAIL_TEMPLATE_LABELS[sel.key] || sel.key}</div>
            <Field label="Subject" value={subject} onChange={(e: any) => setSubject(e.target.value)} />
            <div>
              <label>Body <span style={{ color: "var(--muted)", fontSize: 12 }}>(supports {"{{CandidateFirstName}}"}, {"{{Role}}"}, {"{{OfferRef}}"}, {"{{EmployeeName}}"}, {"{{EmployeeId}}"} etc. — see the field on the actual generate screen for the exact tokens each email key fills)</span></label>
              <textarea rows={10} style={{ width: "100%" }} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div>
              <label>Signature</label>
              <textarea rows={4} style={{ width: "100%" }} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={"Warm regards,\nHR Team, GenAquarius"} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={showLogo} onChange={(e) => setShowLogo(e.target.checked)} />
              Show GenAquarius logo below signature
            </label>
            <AddButton onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Template"}</AddButton>
          </div>
          {/* ---- Right: live preview ---- */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Live preview</div>
            <div style={{ background: "#ffffff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 10, padding: 20, minHeight: 320, fontSize: 14, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #eee" }}>{fillPreview(subject) || <span style={{ color: "#9aa0ab" }}>Subject preview…</span>}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{fillPreview(body) || <span style={{ color: "#9aa0ab" }}>Email body preview…</span>}</div>
              {signature && <div style={{ whiteSpace: "pre-wrap", marginTop: 18 }}>{fillPreview(signature)}</div>}
              {showLogo && (
                <div style={{ marginTop: 18 }}>
                  <img src="/genaquarius.png" alt="GenAquarius" style={{ maxHeight: 56, maxWidth: 220 }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Filled with sample values (candidate "Aditi Sharma") — this is how the real email will read once sent.</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function CountrySettings() {
  const { data } = useFetch<any[]>("/hr-settings/countries");
  return (
    <Panel title="Country Configuration">
      <table><thead><tr><th>Country</th><th>Currency</th></tr></thead>
        <tbody>{(data || []).map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.currency}</td></tr>)}</tbody>
      </table>
      <div className="note">Standard Deduction &amp; Cess are configured per tax regime on the Tax tab, not here (they differ between Old and New Regime). Full country tax-slab editing is on the Tax tab (India only for now — US/Canada slabs aren't modeled yet).</div>
    </Panel>
  );
}

export function BusinessUnitSettings() {
  const { data, reload } = useFetch<any[]>("/hr-settings/business-units");
  const { show } = useToast();
  const [name, setName] = useState(""); const [countryCode, setCountryCode] = useState("INDIA");
  return (
    <Panel title="Business Units">
      <table><thead><tr><th>Business Unit</th><th>Country</th></tr></thead>
        <tbody>{(data || []).map((b) => <tr key={b.id}><td>{b.name}</td><td>{b.countryCode}</td></tr>)}</tbody>
      </table>
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Field label="New Business Unit" value={name} onChange={(e: any) => setName(e.target.value)} /></div>
        <SelectField label="Country" value={countryCode} onChange={(e: any) => setCountryCode(e.target.value)} options={[{ value: "INDIA", label: "India" }, { value: "US", label: "United States" }, { value: "CANADA", label: "Canada" }]} />
        <AddButton onClick={async () => { if (!name.trim()) return; await api.post("/hr-settings/business-units", { name, countryCode }); setName(""); show("Added"); reload(); }}>Add</AddButton>
      </div>
    </Panel>
  );
}

// Simple named-list CRUD (add / inline-rename / delete) — shared shape for both Designations
// and Departments, which feed Generate Offer's dropdowns instead of free text.
function NamedListSettings({ title, endpoint, placeholder }: { title: string; endpoint: string; placeholder: string }) {
  const { data, reload } = useFetch<any[]>(endpoint);
  const { show } = useToast();
  const [name, setName] = useState("");
  const add = async () => {
    if (!name.trim()) return;
    try { await api.post(endpoint, { name: name.trim() }); setName(""); show("Added"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const rename = async (id: number, newName: string, oldName: string) => {
    if (!newName.trim() || newName === oldName) return;
    try { await api.put(`${endpoint}/${id}`, { name: newName.trim() }); show("Renamed"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const del = async (id: number, itemName: string) => {
    if (!(await confirmDialog({ title: `Delete "${itemName}"?`, danger: true }))) return;
    try { await api.del(`${endpoint}/${id}`); show("Deleted"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  return (
    <Panel title={title}>
      <table><thead><tr><th>Name</th><th></th></tr></thead>
        <tbody>{(data || []).map((d: any) => (
          <tr key={d.id}>
            <td>
              <input defaultValue={d.name} style={{ width: "100%", background: "transparent", border: "1px solid transparent" }}
                onFocus={(e) => { e.target.style.border = "1px solid var(--border)"; }}
                onBlur={(e) => { e.target.style.border = "1px solid transparent"; rename(d.id, e.target.value, d.name); }} />
            </td>
            <td><GhostButton onClick={() => del(d.id, d.name)}>Delete</GhostButton></td>
          </tr>
        ))}</tbody>
      </table>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1 }}><Field label={`New ${placeholder}`} value={name} onChange={(e: any) => setName(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter") add(); }} /></div>
        <AddButton onClick={add}>Add</AddButton>
      </div>
    </Panel>
  );
}
// Designations ("Role" in the everyday sense — job titles) and Departments — both feed Generate
// Offer's dropdowns; managed together since they're both simple named lists for the org chart.
export function OrganizationSettings() {
  return (
    <div className="grid cols-2">
      <NamedListSettings title="Designations (Roles)" endpoint="/hr-settings/designations" placeholder="Designation" />
      <NamedListSettings title="Departments" endpoint="/hr-settings/departments" placeholder="Department" />
    </div>
  );
}

// Annual Leaves (Holidays) — moved here from its own top-level page so it follows the same
// Business Unit selector as every other HR Settings category. Country is derived from the
// selected Business Unit (no independent Country picker — same reasoning as Leave Policy):
// a BU's own calendar overrides the Company Default for its employees' Monthly Forecast
// billable-day calculations (engine/workdays.ts).
function HolidaySettings({ businessUnitId }: { businessUnitId: string }) {
  const { data: bus } = useFetch<any[]>("/hr-settings/business-units");
  const selectedBu = (bus || []).find((b: any) => String(b.id) === businessUnitId);
  const country = selectedBu?.countryCode || "INDIA";
  const buId = businessUnitId === "null" ? null : Number(businessUnitId);
  const { data, reload } = useFetch<any[]>(`/holidays?country=${country}&businessUnitId=${businessUnitId}`, [country, businessUnitId]);
  const { show } = useToast();
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const valid = form && form.date && form.name?.trim();
  const save = async () => {
    if (!valid) return show("Date and Holiday Name are required", "error");
    setBusy(true);
    try {
      if (form.id) await api.put(`/holidays/${form.id}`, form);
      else await api.post("/holidays", { ...form, country, businessUnitId: buId });
      show("Holiday saved"); setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async (h: any) => {
    if (!(await confirmDialog({ title: `Delete "${h.name}"?`, danger: true }))) return;
    try { await api.del(`/holidays/${h.id}`); show("Holiday deleted"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  const clone = async () => {
    try {
      const r: any = await api.post("/holidays/clone-to-bu", { businessUnitId: buId, country });
      if (r.cloned === 0) show(`Company Default has no holidays configured for ${country} yet — add one below to get started.`, "error");
      else show(`Cloned ${r.cloned} holiday(s) from Company Default`);
      reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div>
      {(data || []).length === 0 && businessUnitId !== "null" && (
        <div className="note" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <span>No holidays configured for this Business Unit yet — it currently falls back to the Company Default.</span>
          <AddButton onClick={clone}>Clone from Company Default</AddButton>
        </div>
      )}
      <Panel title={`Annual Leaves (Holidays) — ${country}`}>
        <div className="subtitle" style={{ marginTop: 0 }}>Public holidays for this Business Unit's country — feeds Monthly Forecast's billable-day calculation.</div>
        <table><thead><tr><th>Date</th><th>Holiday</th><th></th></tr></thead>
          <tbody>
            {(data || []).length === 0 && <tr><td colSpan={3} style={{ color: "var(--muted)" }}>No holidays yet.</td></tr>}
            {(data || []).map((h: any) => (
              <tr key={h.id}>
                <td>{fmtDate(h.date)}</td>
                <td>{h.name}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <GhostButton onClick={() => setForm({ id: h.id, date: h.date?.slice(0, 10), name: h.name })}>Edit</GhostButton>
                  <GhostButton onClick={() => del(h)}>Delete</GhostButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!form ? (
          <AddButton style={{ marginTop: 10 }} onClick={() => setForm({ id: null, date: "", name: "" })}>Add Holiday</AddButton>
        ) : (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field label="Date" required type="date" value={form.date} onChange={(e: any) => setForm({ ...form, date: e.target.value })} />
            <Field label="Holiday Name" required value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Republic Day / Thanksgiving" />
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <AddButton disabled={busy || !valid} onClick={save}>{form.id ? "Save Changes" : "Add"}</AddButton>
              <GhostButton disabled={busy} onClick={() => setForm(null)}>Cancel</GhostButton>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

// =====================================================================================
// Generate Offer — candidate/offer creation form (no Employee ID field)
// =====================================================================================
// `id` present (via the /hr/offers/:id/regenerate route) => Regenerate mode: pre-fills every
// field from the existing offer and, on submit, POSTs the edits to /regenerate (new version,
// same offer) instead of creating a new candidate. Candidate identity (name/email/phone/
// country/offer date) isn't accepted by /regenerate, so those show read-only for context.
// Documents HR attaches itself once generated (Offer/Appointment/Service Agreement) — never
// candidate-facing checklist items, so they're excluded from the Generate Offer selector even
// though they stay in the master list for Employee Master's own document panel.
const SYSTEM_GENERATED_DOC_NAMES = ["Offer Letter", "Appointment Letter", "Service Agreement"];
const PERIOD_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: `${n} Month${n > 1 ? "s" : ""}`, label: `${n} Month${n > 1 ? "s" : ""}` }));
const PHONE_RE = /^[0-9+\-\s()]{7,15}$/;

export function GenerateOffer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { show } = useToast();
  const { user } = useAuth();
  // "Save & Continue Later" — resuming a half-filled candidate form (?draftId=…) instead of
  // starting fresh or editing a real Offer. Mutually exclusive with `id` (a real Offer never has
  // a draft — regenerate always uses /hr/offers/:id/regenerate, a separate route with no `id`+
  // `draftId` overlap).
  const draftId = new URLSearchParams(location.search).get("draftId");
  const { data: draft } = useFetch<any>(draftId ? `/hr/offer-drafts/${draftId}` : "/health");
  const { data: bus } = useFetch<any[]>("/hr-settings/business-units");
  const { data: designations } = useFetch<any[]>("/hr-settings/designations");
  const { data: departments } = useFetch<any[]>("/hr-settings/departments");
  const { data: allEmployees } = useFetch<any[]>("/employees");
  const { data: existing } = useFetch<any>(id ? `/hr/offers/${id}` : "/health");
  const activeEmployees = (allEmployees || []).filter((e: any) => !e.exitDate);
  const today = new Date().toISOString().slice(0, 10);
  const defaultDeadline = (d: string) => new Date(new Date(d || today).getTime() + 3 * 86400000).toISOString().slice(0, 10);
  // Proposed Joining Date defaults to 10+ days out from the Offer Date — candidates almost always
  // need at least that much notice; HR can always override it.
  const defaultJoining = (d: string) => new Date(new Date(d || today).getTime() + 10 * 86400000).toISOString().slice(0, 10);
  const [f, setF] = useState<any>({
    candidateFirstName: "", candidateMiddleName: "", candidateLastName: "", candidateEmail: "", candidatePhone: "", candidateOfficialPhone: "", candidatePersonalEmail: "", candidateAddress: "", candidateCity: "", candidateLandmark: "", candidateState: "", candidatePincode: "", role: "", designation: "", employmentType: "EMPLOYEE", ctc: "", compensationType: "ANNUAL", compensationAmount: "", noCostToCompany: false,
    residentSameAsPermanent: true, residentAddress: "", residentCity: "", residentLandmark: "", residentState: "", residentPincode: "",
    gender: "", maritalStatus: "", dateOfBirth: "",
    uanPfDetails: "", // UAN / PF Details (if applicable) — India Full-Time Employee only, optional
    businessUnitId: "", countryCode: "INDIA", offerDate: today, proposedJoiningDate: defaultJoining(today),
    reportingManager: "Sandeep Minocha", workLocation: "Office", department: "IT",
    probationPeriod: "2 Months", noticePeriod: "2 Months", acceptanceDeadline: defaultDeadline(today),
    documentChecklist: null as string[] | null, // null = not yet defaulted from docTypes/existing
    // US/Canada simplified onboarding — "Compensation" section of Stage 1 (see Offer model's own
    // comment). All null/empty for India and for a US/Canada Full-Time Salaried engagement, where
    // `ctc` above (annual) is already the whole story.
    usEngagementType: "", billingBasis: "", hourlyRateUsd: "", hoursPerDay: "8", dayRate: "", monthlyAmount: "", workingDays: "260",
    vendorName: "", vendorEin: "", vendorAddress: "", endClientName: "", engagementDescription: "",
  });
  // Which fields even show up here, and which are required — config-driven (HR Settings -> Workflow
  // & Stage Configuration). Employee and Contractor are separate templates now, so this re-fetches
  // whenever HR toggles the Employment Type dropdown below.
  const { data: fieldConfig } = useFetch<any[]>(`/hr/offer-field-config?employmentType=${f.employmentType}&countryCode=${f.countryCode}`, [f.employmentType, f.countryCode]);
  const offerFieldOrder = (fieldConfig || []).map((x) => x.key);
  // candidateName/email/ctc/designation/joiningDate/reportingManager/department are hard server-side
  // requirements for any offer (hrOffers.ts POST /offers) — only the genuinely optional identity
  // fields (phone, address) are shown/hidden per HR Settings -> Workflow & Stage Configuration.
  const fieldEnabled = (key: string) => { const f2 = (fieldConfig || []).find((x) => x.key === key); return f2 ? f2.enabled !== false : true; };
  const fieldMandatory = (key: string) => !!(fieldConfig || []).find((x) => x.key === key)?.mandatory;
  // Stage 1's real name, as configured in Workflow & Stage Configuration — the page heading follows
  // it exactly instead of a hardcoded "Generate Offer" label, same vocabulary as the stepper/preview.
  const { data: stageInfo } = useFetch<any>(`/hr/offer-generation-stage-name?employmentType=${f.employmentType}&countryCode=${f.countryCode}`, [f.employmentType, f.countryCode]);
  // Scoped to the selected Business Unit (its own cloned checklist if it has one, else the global
  // default) — NOT every BU's rows merged together, which used to show each document name once per
  // BU that had cloned its own copy ("duplicated entries" bug in List of Joining Documents).
  const { data: allDocTypes } = useFetch<any[]>(`/hr-settings/leave/onboarding-doc-types?fallback=1&businessUnitId=${f.businessUnitId || "null"}`, [f.businessUnitId]);
  const docTypes = (allDocTypes || []).filter((d: any) => !SYSTEM_GENERATED_DOC_NAMES.includes(d.name));
  const [deadlineTouched, setDeadlineTouched] = useState(false);
  const [joiningTouched, setJoiningTouched] = useState(false);
  const [loaded, setLoaded] = useState(!id && !draftId);
  const [loadedDraftId, setLoadedDraftId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Resume + Aadhaar are part of the same merged Stage 1 form now — captured here, before the
  // candidate record is even created, instead of requiring a second visit to Offer Detail first.
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [aadhaarNumberInput, setAadhaarNumberInput] = useState("");
  const [aadhaarImageFile, setAadhaarImageFile] = useState<File | null>(null);
  const [panInput, setPanInput] = useState("");
  // Intern's simplified Stage 1 captures these too, same convention as Resume/Aadhaar above.
  const [educationCertificateFile, setEducationCertificateFile] = useState<File | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [educationCertificateBusy, setEducationCertificateBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  // US/Canada Stage 1's "Supporting Documents" — simple, fixed, HR-uploads-directly rows (no
  // checklist, no required/optional configuration), per the signed-off artifact. Keyed by docType
  // (SSN_SIN / WORK_AUTHORIZATION / DRIVERS_LICENSE / W9 / VOID_CHEQUE) — see OfferDocument model.
  const [usCanDocs, setUsCanDocs] = useState<Record<string, File | null>>({});
  const [usCanDocsBusy, setUsCanDocsBusy] = useState<Record<string, boolean>>({});
  const [customDocs, setCustomDocs] = useState<{ label: string; file: File }[]>([]);
  const [customDocLabel, setCustomDocLabel] = useState("");
  const [customDocFile, setCustomDocFile] = useState<File | null>(null);
  // "Save & Continue Later" used to only ever save `f` (plain form fields) — Resume/Aadhaar/PAN/
  // Education Certificate/Photo all live in their own File/text state above, so none of them
  // actually persisted: resuming a draft always asked HR to re-pick every file from scratch. Kept
  // deliberately OUT of `f` itself (a separate object) rather than merged in, since `f` is spread
  // directly into POST /hr/offers's body on submit — mixing megabyte-scale base64 blobs into that
  // would bloat every offer-creation request even when nothing came from a draft.
  const [draftFiles, setDraftFiles] = useState<{ resumeFileName?: string; resumeFileData?: string; aadhaarImageFileName?: string; aadhaarImageFileData?: string; educationCertificateFileName?: string; educationCertificateFileData?: string; photoFileName?: string; photoFileData?: string }>({});
  React.useEffect(() => {
    if (id && existing && !loaded) {
      setF({
        candidateFirstName: existing.candidateFirstName || "", candidateMiddleName: existing.candidateMiddleName || "", candidateLastName: existing.candidateLastName || "",
        candidateEmail: existing.candidateEmail, candidatePhone: existing.candidatePhone || "", candidateOfficialPhone: existing.candidateOfficialPhone || "", candidatePersonalEmail: existing.candidatePersonalEmail || "", candidateAddress: existing.candidateAddress || "",
        candidateCity: existing.candidateCity || "", candidateLandmark: existing.candidateLandmark || "", candidateState: existing.candidateState || "", candidatePincode: existing.candidatePincode || "",
        residentSameAsPermanent: existing.residentSameAsPermanent !== false, residentAddress: existing.residentAddress || "", residentCity: existing.residentCity || "",
        residentLandmark: existing.residentLandmark || "", residentState: existing.residentState || "", residentPincode: existing.residentPincode || "",
        gender: existing.gender || "", maritalStatus: existing.maritalStatus || "", dateOfBirth: existing.dateOfBirth ? existing.dateOfBirth.slice(0, 10) : "",
        uanPfDetails: existing.uanPfDetails || "",
        role: existing.role, designation: existing.designation, employmentType: existing.employmentType || "EMPLOYEE", ctc: String(existing.ctc), compensationType: existing.customFields?.compensationType || "ANNUAL", compensationAmount: existing.customFields?.compensationAmount != null ? String(existing.customFields.compensationAmount) : String(existing.ctc), noCostToCompany: !!existing.noCostToCompany,
        businessUnitId: existing.businessUnitId || "", countryCode: existing.countryCode,
        offerDate: existing.offerDate ? existing.offerDate.slice(0, 10) : "",
        proposedJoiningDate: existing.proposedJoiningDate ? existing.proposedJoiningDate.slice(0, 10) : "",
        reportingManager: existing.reportingManager || "",
        workLocation: existing.workLocation || "Office",
        department: existing.department || "",
        probationPeriod: existing.probationPeriod || "2 Months",
        noticePeriod: existing.noticePeriod || "2 Months",
        acceptanceDeadline: existing.acceptanceDeadline ? existing.acceptanceDeadline.slice(0, 10) : defaultDeadline(existing.offerDate),
        documentChecklist: existing.documentChecklist || null,
        usEngagementType: existing.usEngagementType || "", billingBasis: existing.billingBasis || "",
        hourlyRateUsd: existing.hourlyRateUsd != null ? String(existing.hourlyRateUsd) : "", hoursPerDay: existing.hoursPerDay != null ? String(existing.hoursPerDay) : (existing.customFields?.usComp?.hoursPerDay != null ? String(existing.customFields.usComp.hoursPerDay) : "8"),
        dayRate: existing.customFields?.usComp?.basis === "DAILY" ? String(existing.customFields.usComp.rate) : "",
        monthlyAmount: existing.customFields?.usComp?.basis === "MONTHLY" ? String(existing.customFields.usComp.rate) : "",
        workingDays: existing.customFields?.usComp?.workingDays != null ? String(existing.customFields.usComp.workingDays) : "260",
        vendorName: existing.vendorName || "", vendorEin: existing.vendorEin || "", vendorAddress: existing.vendorAddress || "",
        endClientName: existing.endClientName || "", engagementDescription: existing.engagementDescription || "",
      });
      setLoaded(true);
    }
  }, [id, existing, loaded]);
  React.useEffect(() => {
    if (draftId && draft && !loaded) {
      const fd = { ...(draft.formData || {}) };
      const extra: typeof draftFiles & { aadhaarNumberInput?: string; panInput?: string } = {};
      for (const k of ["aadhaarNumberInput", "panInput", "resumeFileName", "resumeFileData", "aadhaarImageFileName", "aadhaarImageFileData", "educationCertificateFileName", "educationCertificateFileData", "photoFileName", "photoFileData"] as const) {
        if (fd[k] !== undefined) { (extra as any)[k] = fd[k]; delete fd[k]; }
      }
      setF((cur: any) => ({ ...cur, ...fd }));
      if (extra.aadhaarNumberInput) setAadhaarNumberInput(extra.aadhaarNumberInput);
      if (extra.panInput) setPanInput(extra.panInput);
      setDraftFiles(extra);
      setLoadedDraftId(draft.id);
      setLoaded(true);
    }
  }, [draftId, draft, loaded]);
  const saveDraft = async () => {
    setBusy(true);
    try {
      const files = { ...draftFiles };
      if (resumeFile) { files.resumeFileName = resumeFile.name; files.resumeFileData = await fileToBase64(resumeFile); }
      if (aadhaarImageFile) { files.aadhaarImageFileName = aadhaarImageFile.name; files.aadhaarImageFileData = await fileToBase64(aadhaarImageFile); }
      if (educationCertificateFile) { files.educationCertificateFileName = educationCertificateFile.name; files.educationCertificateFileData = await fileToBase64(educationCertificateFile); }
      if (photoFile) { files.photoFileName = photoFile.name; files.photoFileData = await fileToBase64(photoFile); }
      const payload = { ...f, aadhaarNumberInput, panInput, ...files };
      const saved = loadedDraftId
        ? await api.put(`/hr/offer-drafts/${loadedDraftId}`, payload)
        : await api.post("/hr/offer-drafts", payload);
      setDraftFiles(files);
      setLoadedDraftId(saved.id);
      show("Saved — resume anytime from Onboarding Flow");
      navigate("/hr/offers");
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Default Business Unit to "GenAquarius Technologies Pvt Ltd" once the BU list has loaded — only
  // for a brand-new offer (never overrides a regenerate's existing selection), and only if HR
  // hasn't already picked something else themselves.
  React.useEffect(() => {
    if (!id && bus && !f.businessUnitId) {
      const defaultBu = bus.find((b: any) => b.name === "GenAquarius Technologies Pvt Ltd");
      if (defaultBu) setF((cur: any) => cur.businessUnitId ? cur : { ...cur, businessUnitId: defaultBu.id, countryCode: defaultBu.countryCode || cur.countryCode });
    }
    // eslint-disable-next-line
  }, [bus, id]);
  // Default the checklist to every "required" master document once the master list has loaded —
  // for a brand-new offer immediately, for a regenerate only if the offer didn't already snapshot
  // a selection (an existing snapshot always wins, so re-opening the form never silently resets it).
  React.useEffect(() => {
    if (allDocTypes && f.documentChecklist === null) {
      // Aadhaar is excluded from the default-checked set even if the master list marks it
      // "required" — it's already captured (number + image) right here in Stage 1, so asking for
      // a physical/uploaded copy again under "List of Joining Documents" is redundant. HR can
      // still check it manually if they genuinely want it printed. Same name-matching convention
      // engine/workflow.ts's resolveRequiredDocuments already uses for Aadhaar.
      setF((cur: any) => cur.documentChecklist === null ? { ...cur, documentChecklist: docTypes.filter((d: any) => d.required && !/aadhaar|aadhar/i.test(d.name || "")).map((d: any) => d.name) } : cur);
    }
    // eslint-disable-next-line
  }, [allDocTypes, f.documentChecklist]);
  const toggleDoc = (name: string) => {
    const list: string[] = f.documentChecklist || [];
    setF({ ...f, documentChecklist: list.includes(name) ? list.filter((n) => n !== name) : [...list, name] });
  };
  const selectAllDocs = () => setF({ ...f, documentChecklist: docTypes.map((d: any) => d.name) });
  const clearAllDocs = () => setF({ ...f, documentChecklist: [] });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  // Offer Date changing re-suggests the Acceptance Deadline (+3 days) — but only until HR
  // deliberately edits the deadline themselves, so a manual override is never silently clobbered.
  const setOfferDate = (e: any) => {
    const v = e.target.value;
    setF((cur: any) => ({
      ...cur, offerDate: v,
      acceptanceDeadline: deadlineTouched ? cur.acceptanceDeadline : defaultDeadline(v),
      proposedJoiningDate: joiningTouched ? cur.proposedJoiningDate : defaultJoining(v),
    }));
  };
  const setDeadline = (e: any) => { setDeadlineTouched(true); setF({ ...f, acceptanceDeadline: e.target.value }); };
  const setJoining = (e: any) => { setJoiningTouched(true); setF({ ...f, proposedJoiningDate: e.target.value }); };
  const isContractorForm = usesServiceAgreement(f.employmentType);
  // US/Canada simplified onboarding — Resume/Aadhaar/PAN and the rest of today's India-only
  // identity capture don't apply; a Vendor/Contractor engagement needs vendor fields instead of
  // (or in addition to) a flat CTC, feeding MsaSowAgreementPanel's MSA/SOW generation.
  const isUsCanada = f.countryCode === "US" || f.countryCode === "CANADA";
  // UAN / PF Details — India entity, Full-Time Employee (Offer + Appointment Letter) only; optional.
  const showUanPf = f.countryCode === "INDIA" && f.employmentType === "EMPLOYEE";
  // Contractor (India) compensation structure — Annual CTC / Monthly Salary / Daily Salary. The
  // annualized figure is kept in f.ctc so every existing validation/payload keeps working.
  const showCompStructure = f.employmentType === "CONTRACTOR" && !isUsCanada && !f.noCostToCompany;
  const setComp = (compensationType: string, compensationAmount: string) => {
    const a = Number(compensationAmount) || 0;
    const annual = compensationType === "ANNUAL" ? a : compensationType === "DAILY" ? a * 260 : a * 12;
    setF((cur: any) => ({ ...cur, compensationType, compensationAmount, ctc: compensationAmount === "" ? "" : String(Math.round(annual * 100) / 100) }));
  };
  // Corp to Corp (employmentType CONTRACTOR for US/Canada) is always a Vendor engagement now —
  // it's the only US Engagement value that bucket can have — so this no longer needs a
  // per-country branch.
  const isVendorEngagement = isUsCanada && f.employmentType === "CONTRACTOR";
  // Per-country document list — matches the artifact's Stage 1 "Supporting Documents" exactly;
  // the 4th slot differs by country (W-9 for US, Void Cheque for Canada). Each row's own
  // enabled/mandatory now comes from HR Settings -> Workflow & Stage Configuration
  // (US/Canada Supporting Documents section) via `configKey`, same as every other field here —
  // no longer hardcoded with no configuration.
  const usCanDocTypes = (f.countryCode === "CANADA"
    ? [
        { key: "SSN_SIN", configKey: "ssnSinDocument", label: "SIN Document" },
        { key: "WORK_AUTHORIZATION", configKey: "workAuthorizationDocument", label: "Work Permit", note: "Optional — if applicable" },
        { key: "DRIVERS_LICENSE", configKey: "driversLicenseDocument", label: "Driver's License / Photo ID" },
        { key: "VOID_CHEQUE", configKey: "w9VoidChequeDocument", label: "Void Cheque / Direct Deposit Form" },
      ]
    : [
        { key: "SSN_SIN", configKey: "ssnSinDocument", label: "SSN Document" },
        { key: "WORK_AUTHORIZATION", configKey: "workAuthorizationDocument", label: "Work Authorization (EAD / Visa)", note: "Optional — if applicable" },
        { key: "DRIVERS_LICENSE", configKey: "driversLicenseDocument", label: "Driver's License / Photo ID" },
        { key: "W9", configKey: "w9VoidChequeDocument", label: "W-9" },
      ]
  ).filter((dt) => fieldEnabled(dt.configKey));
  // Hourly engagements (US "W2 / No Benefit — Hourly" and "Hired from Vendor") don't type an
  // annual CTC directly — it's derived (rate × hours/day × 260 working days/yr) so `ctc` stays the
  // one authoritative annual figure every other part of the app (forecast, CTC Record) already
  // reads, exactly like the artifact's "Computed Annual CTC" readout.
  React.useEffect(() => {
    // Annualized CTC for every US/Canada structure (Annual is typed directly): hourly = rate x
    // hours/day x working days; daily = day rate x working days; monthly = monthly x 12. Hours/day
    // and working days/year are editable (defaults 8 / 260).
    if (isUsCanada && (f.billingBasis === "HOURLY" || f.billingBasis === "DAILY" || f.billingBasis === "MONTHLY")) {
      const hours = Number(f.hoursPerDay) || 8, days = Number(f.workingDays) || 260;
      const computed = f.billingBasis === "HOURLY" ? (Number(f.hourlyRateUsd) || 0) * hours * days
        : f.billingBasis === "DAILY" ? (Number(f.dayRate) || 0) * days : (Number(f.monthlyAmount) || 0) * 12;
      const rounded = Math.round(computed * 100) / 100;
      setF((cur: any) => cur.ctc === String(rounded) ? cur : { ...cur, ctc: String(rounded) });
    }
    // eslint-disable-next-line
  }, [f.countryCode, f.billingBasis, f.hourlyRateUsd, f.hoursPerDay, f.dayRate, f.monthlyAmount, f.workingDays]);
  // Structured US/Canada compensation sent to the server (which recomputes the annualized CTC).
  const usCompPayload = () => !isUsCanada ? {} : { usComp: {
    basis: f.billingBasis || "ANNUAL",
    rate: f.billingBasis === "HOURLY" ? Number(f.hourlyRateUsd) : f.billingBasis === "DAILY" ? Number(f.dayRate) : f.billingBasis === "MONTHLY" ? Number(f.monthlyAmount) : Number(f.ctc),
    hoursPerDay: Number(f.hoursPerDay) || 8, workingDays: Number(f.workingDays) || 260,
  } };
  const submit = async () => {
    // Contractor/Intern may genuinely be no-cost — ctc:"0" must pass here, not just a truthy
    // value (mirrors the same relaxation on the server's POST /offers validation).
    const ctcMissing = f.ctc === "" || f.ctc == null || Number.isNaN(Number(f.ctc)) || (Number(f.ctc) === 0 && !isContractorForm);
    // Names each missing field instead of a blanket "Please fill all required fields" — HR
    // otherwise had to hunt the whole form (across two/three sections) to find which one input
    // was actually still empty.
    const missingCore = [
      !f.candidateFirstName && "First Name", !f.candidateLastName && "Last Name", !f.candidateEmail && "Official Email",
      ctcMissing && "CTC", !f.designation && "Designation", !f.offerDate && "Offer Date", !f.proposedJoiningDate && "Proposed Joining Date",
      !f.reportingManager && "Reporting To", !f.department && "Department",
    ].filter(Boolean) as string[];
    if (missingCore.length) return show(`Please fill: ${missingCore.join(", ")}`, "error");
    if (f.candidatePhone && !PHONE_RE.test(f.candidatePhone)) return show("Phone number format is invalid", "error");
    if (isVendorEngagement && (!f.vendorName.trim() || !f.vendorEin.trim() || !f.endClientName.trim())) {
      return show("Service Provider (Vendor) Name, Vendor EIN and End Client Name are required for a Vendor/Contractor engagement", "error");
    }
    // Resume/Aadhaar only apply to a brand-new candidate here — a regenerate already has its own
    // (captured earlier, on this same merged stage); this mirrors the server's own gate exactly
    // (engine/workflow.ts unmetMandatoryOfferFields) so it can never block something the server
    // wouldn't also block, or vice versa. US/Canada never requires Resume (or Aadhaar/PAN, which
    // don't even show — see isUsCanada below) regardless of HR Settings config, per the signed-off
    // US/Canada onboarding design.
    if (!id) {
      // A file already saved into an earlier draft counts as "have it" just as much as a freshly
      // picked File — see draftFiles above.
      if (!isUsCanada && fieldEnabled("resume") && fieldMandatory("resume") && !resumeFile && !draftFiles.resumeFileData) return show("Resume is required", "error");
      if (!isUsCanada && fieldEnabled("aadhaar") && fieldMandatory("aadhaar")) {
        if (!/^\d{12}$/.test(aadhaarNumberInput)) return show("Aadhaar number must be 12 digits", "error");
        if (!aadhaarImageFile && !draftFiles.aadhaarImageFileData) return show("Aadhaar image is required", "error");
      } else if (!isUsCanada && aadhaarNumberInput && !/^\d{12}$/.test(aadhaarNumberInput)) {
        return show("Aadhaar number must be 12 digits", "error");
      }
      if (fieldEnabled("pan") && fieldMandatory("pan") && !/^[A-Z]{5}\d{4}[A-Z]$/.test(panInput)) return show("PAN must be in the format ABCDE1234F", "error");
      if (panInput && !/^[A-Z]{5}\d{4}[A-Z]$/.test(panInput)) return show("PAN must be in the format ABCDE1234F", "error");
      if (fieldEnabled("educationCertificate") && fieldMandatory("educationCertificate") && !educationCertificateFile && !draftFiles.educationCertificateFileData) return show("Education Certificate is required", "error");
      if (fieldEnabled("photo") && fieldMandatory("photo") && !photoFile && !draftFiles.photoFileData) return show("Photo is required", "error");
      // Every other optional field HR can mark Mandatory in Workflow & Stage Configuration —
      // previously only resume/Aadhaar/PAN actually blocked submission here, so toggling any of
      // these "mandatory" in the config was a no-op on the real form (identity/address fields are
      // all disabled on a regenerate, so this only ever applies to a brand-new candidate).
      if (fieldEnabled("candidateMiddleName") && fieldMandatory("candidateMiddleName") && !f.candidateMiddleName.trim()) return show("Middle Name is required", "error");
      if (fieldEnabled("phoneNumber") && fieldMandatory("phoneNumber") && !f.candidatePhone.trim()) return show("Phone is required", "error");
      if (fieldEnabled("officialPhone") && fieldMandatory("officialPhone") && !f.candidateOfficialPhone.trim()) return show("Official Phone is required", "error");
      if (fieldEnabled("candidatePersonalEmail") && fieldMandatory("candidatePersonalEmail") && !f.candidatePersonalEmail.trim()) return show("Personal Email is required", "error");
      if (fieldEnabled("gender") && fieldMandatory("gender") && !f.gender) return show("Gender is required", "error");
      if (fieldEnabled("maritalStatus") && fieldMandatory("maritalStatus") && !f.maritalStatus) return show("Marital Status is required", "error");
      if (fieldEnabled("dateOfBirth") && fieldMandatory("dateOfBirth") && !f.dateOfBirth) return show("Date of Birth is required", "error");
      if (fieldEnabled("businessUnitId") && fieldMandatory("businessUnitId") && !f.businessUnitId) return show("Business Unit is required", "error");
      if (fieldEnabled("address") && fieldMandatory("address") && !f.candidateAddress.trim()) return show("Address is required", "error");
      if (fieldEnabled("candidateCity") && fieldMandatory("candidateCity") && !f.candidateCity.trim()) return show("City is required", "error");
      if (fieldEnabled("candidateLandmark") && fieldMandatory("candidateLandmark") && !f.candidateLandmark.trim()) return show("Nearby Landmark is required", "error");
      if (fieldEnabled("candidateState") && fieldMandatory("candidateState") && !f.candidateState.trim()) return show("State is required", "error");
      if (fieldEnabled("candidatePincode") && fieldMandatory("candidatePincode") && !f.candidatePincode.trim()) return show("Pincode is required", "error");
      if (!f.residentSameAsPermanent) {
        if (fieldEnabled("residentAddress") && fieldMandatory("residentAddress") && !f.residentAddress.trim()) return show("Resident Address Line is required", "error");
        if (fieldEnabled("residentCity") && fieldMandatory("residentCity") && !f.residentCity.trim()) return show("Resident City is required", "error");
        if (fieldEnabled("residentLandmark") && fieldMandatory("residentLandmark") && !f.residentLandmark.trim()) return show("Resident Nearby Landmark is required", "error");
        if (fieldEnabled("residentState") && fieldMandatory("residentState") && !f.residentState.trim()) return show("Resident State is required", "error");
        if (fieldEnabled("residentPincode") && fieldMandatory("residentPincode") && !f.residentPincode.trim()) return show("Resident Pincode is required", "error");
      }
    }
    if (isVendorEngagement) {
      if (fieldEnabled("vendorAddress") && fieldMandatory("vendorAddress") && !f.vendorAddress.trim()) return show("Vendor Address is required", "error");
      if (fieldEnabled("engagementDescription") && fieldMandatory("engagementDescription") && !f.engagementDescription.trim()) return show("Engagement / Project Description is required", "error");
    }
    if (isUsCanada && (!id || isContractorForm)) {
      const missingDoc = usCanDocTypes.find((dt) => fieldMandatory(dt.configKey) && !usCanDocs[dt.key] && !(existing?.documents || []).find((d: any) => d.docType === dt.key));
      if (missingDoc) return show(`${missingDoc.label} is required`, "error");
    }
    if (!isUsCanada && fieldEnabled("documentChecklist") && fieldMandatory("documentChecklist") && !(f.documentChecklist || []).length) return show("At least one Joining Document must be selected", "error");
    setBusy(true);
    // Role field removed from the form (Designation covers the same purpose) — the server always
    // mirrors Designation into the offer's `role` column so every existing role-based renderer
    // (offer letter body, dashboards, dynamicFields.JobTitle, etc.) keeps working unchanged.
    try {
      if (id) {
        if (isContractorForm) {
          // Contractor/Intern have no Offer Letter/version-bump concept (their "SLA" document is
          // edited separately via Regenerate Service Agreement) — this is a plain edit of the base
          // candidate/engagement fields on the Offer itself, via the same generic PUT every other
          // still-editable (DRAFT/GENERATED/PREVIEWED) field on this record already goes through.
          await api.put(`/hr/offers/${id}`, {
            candidateFirstName: f.candidateFirstName, candidateMiddleName: f.candidateMiddleName || null, candidateLastName: f.candidateLastName,
            candidateEmail: f.candidateEmail, candidatePhone: f.candidatePhone || null, candidateOfficialPhone: f.candidateOfficialPhone || null, candidatePersonalEmail: f.candidatePersonalEmail || null, candidateAddress: f.candidateAddress || null,
            candidateCity: f.candidateCity || null, candidateLandmark: f.candidateLandmark || null, candidateState: f.candidateState || null, candidatePincode: f.candidatePincode || null,
            residentSameAsPermanent: f.residentSameAsPermanent, residentAddress: f.residentAddress || null, residentCity: f.residentCity || null,
            residentLandmark: f.residentLandmark || null, residentState: f.residentState || null, residentPincode: f.residentPincode || null,
            gender: f.gender || null, maritalStatus: f.maritalStatus || null, dateOfBirth: f.dateOfBirth || null,
            designation: f.designation, ctc: Number(f.ctc), ...(showCompStructure ? { compensationType: f.compensationType, compensationAmount: Number(f.compensationAmount) } : {}), noCostToCompany: f.noCostToCompany, businessUnitId: f.businessUnitId || null, countryCode: f.countryCode,
            offerDate: f.offerDate || null, proposedJoiningDate: f.proposedJoiningDate || null, reportingManager: f.reportingManager || null, workLocation: f.workLocation, department: f.department || null,
            probationPeriod: f.probationPeriod, noticePeriod: f.noticePeriod, acceptanceDeadline: f.acceptanceDeadline || null,
            documentChecklist: f.documentChecklist || [],
            usEngagementType: f.usEngagementType || null, billingBasis: f.billingBasis || null,
            hourlyRateUsd: f.hourlyRateUsd === "" ? null : Number(f.hourlyRateUsd), hoursPerDay: f.hoursPerDay === "" ? null : Number(f.hoursPerDay), ...usCompPayload(),
            vendorName: f.vendorName || null, vendorEin: f.vendorEin || null, vendorAddress: f.vendorAddress || null,
            endClientName: f.endClientName || null, engagementDescription: f.engagementDescription || null,
          });
          show("Candidate information updated"); navigate(`/hr/offers/${id}`);
        } else {
          await api.post(`/hr/offers/${id}/regenerate`, {
            candidateFirstName: f.candidateFirstName, candidateMiddleName: f.candidateMiddleName || null, candidateLastName: f.candidateLastName,
            candidateEmail: f.candidateEmail, candidatePhone: f.candidatePhone || null, candidateOfficialPhone: f.candidateOfficialPhone || null, candidatePersonalEmail: f.candidatePersonalEmail || null, candidateAddress: f.candidateAddress || null,
            gender: f.gender || null, maritalStatus: f.maritalStatus || null, dateOfBirth: f.dateOfBirth || null, countryCode: f.countryCode,
            offerDate: f.offerDate || null,
            designation: f.designation, ctc: Number(f.ctc), businessUnitId: f.businessUnitId || null, proposedJoiningDate: f.proposedJoiningDate || null,
            reportingManager: f.reportingManager || null, workLocation: f.workLocation, department: f.department || null,
            probationPeriod: f.probationPeriod, noticePeriod: f.noticePeriod, acceptanceDeadline: f.acceptanceDeadline || null,
            documentChecklist: f.documentChecklist || [],
            usEngagementType: f.usEngagementType || null, billingBasis: f.billingBasis || null,
            hourlyRateUsd: f.hourlyRateUsd === "" ? null : Number(f.hourlyRateUsd), hoursPerDay: f.hoursPerDay === "" ? null : Number(f.hoursPerDay), ...usCompPayload(),
            ...(showUanPf ? { uanPfDetails: f.uanPfDetails || null } : {}),
          });
          show("New version generated"); navigate(`/hr/offers/${id}`);
        }
      } else {
        const offer = await api.post("/hr/offers", { ...f, ...usCompPayload(), uanPfDetails: showUanPf ? f.uanPfDetails : null, ctc: Number(f.ctc), ...(showCompStructure ? {} : { compensationType: undefined, compensationAmount: undefined }), businessUnitId: f.businessUnitId || null });
        // Upload resume/Aadhaar right after creation, still on this one submit — Offer Detail then
        // opens with both already on file, no separate upload step needed before Generate Offer.
        if (resumeFile) {
          const fileData = await fileToBase64(resumeFile);
          await api.post(`/hr/offers/${offer.id}/resume`, { fileName: resumeFile.name, fileData });
        } else if (draftFiles.resumeFileData && draftFiles.resumeFileName) {
          await api.post(`/hr/offers/${offer.id}/resume`, { fileName: draftFiles.resumeFileName, fileData: draftFiles.resumeFileData });
        }
        if (aadhaarNumberInput.length === 12) {
          const body: any = { aadhaarNumber: aadhaarNumberInput };
          if (aadhaarImageFile) { body.fileName = aadhaarImageFile.name; body.fileData = await fileToBase64(aadhaarImageFile); }
          else if (draftFiles.aadhaarImageFileData && draftFiles.aadhaarImageFileName) { body.fileName = draftFiles.aadhaarImageFileName; body.fileData = draftFiles.aadhaarImageFileData; }
          await api.post(`/hr/offers/${offer.id}/aadhaar`, body);
        }
        if (panInput) await api.post(`/hr/offers/${offer.id}/pan`, { panNumber: panInput });
        if (educationCertificateFile) {
          const fileData = await fileToBase64(educationCertificateFile);
          await api.post(`/hr/offers/${offer.id}/education-certificate`, { fileName: educationCertificateFile.name, fileData });
        } else if (draftFiles.educationCertificateFileData && draftFiles.educationCertificateFileName) {
          await api.post(`/hr/offers/${offer.id}/education-certificate`, { fileName: draftFiles.educationCertificateFileName, fileData: draftFiles.educationCertificateFileData });
        }
        if (photoFile) {
          const fileData = await fileToBase64(photoFile);
          await api.post(`/hr/offers/${offer.id}/photo`, { fileName: photoFile.name, fileData });
        } else if (draftFiles.photoFileData && draftFiles.photoFileName) {
          await api.post(`/hr/offers/${offer.id}/photo`, { fileName: draftFiles.photoFileName, fileData: draftFiles.photoFileData });
        }
        if (isUsCanada) {
          for (const dt of usCanDocTypes) {
            const file = usCanDocs[dt.key];
            if (file) {
              const fileData = await fileToBase64(file);
              await api.post(`/hr/offers/${offer.id}/documents`, { docType: dt.key, label: dt.label, fileName: file.name, fileData });
            }
          }
          for (const cd of customDocs) {
            const fileData = await fileToBase64(cd.file);
            await api.post(`/hr/offers/${offer.id}/documents`, { docType: `CUSTOM:${cd.label}`, label: cd.label, fileName: cd.file.name, fileData });
          }
        }
        // Compute the actual offer (bracket/salary/tax) right here too — Stage 1 lands with
        // Generate, Preview, Send, Regenerate and Cancel all already available together, instead
        // of a separate "click Generate Offer again" step once on the wizard.
        try { await api.post(`/hr/offers/${offer.id}/generate`, {}); } catch { /* offer still exists; HR can retry Generate from Stage 1 */ }
        // The real Offer now exists for real — the saved draft (if this came from one) is done.
        if (loadedDraftId) { try { await api.del(`/hr/offer-drafts/${loadedDraftId}`); } catch { /* non-fatal cleanup */ } }
        show("Offer generated"); navigate(`/hr/offers/${offer.id}`);
      }
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // CTO-only testing convenience — fills every field (across all employment types; only the ones
  // actually shown for the current Employment Type matter) plus dummy uploads for Resume/Aadhaar/
  // Education Certificate/Photo, so a tester can click straight through to Generate Offer/SLA
  // without re-typing the whole form on every test pass. Never touches a real candidate — only
  // available on a brand-new (!id) Stage 1 form.
  const fillStubData = () => {
    const rand = Math.floor(Math.random() * 100000);
    const tinyFile = (name: string, type: string) => new File([`Stub test file — ${name} #${rand}`], name, { type });
    setF((cur: any) => ({
      ...cur,
      candidateFirstName: "Test", candidateMiddleName: "Stub", candidateLastName: `Candidate${rand}`,
      candidateEmail: "sandeepminocha@gmail.com", candidatePhone: "9876543210",
      candidateAddress: "123 Test Street", candidateCity: "Mumbai", candidateLandmark: "Near Test Landmark",
      candidateState: "Maharashtra", candidatePincode: "400001", residentSameAsPermanent: true,
      gender: "MALE", maritalStatus: "SINGLE", dateOfBirth: "1995-01-01",
      designation: (designations || [])[0]?.name || cur.designation || "Software Engineer",
      department: (departments || [])[0]?.name || cur.department || "IT",
      businessUnitId: cur.businessUnitId || (bus || [])[0]?.id || "",
      ctc: cur.noCostToCompany ? "0" : "600000",
      reportingManager: cur.reportingManager || (activeEmployees || [])[0]?.name || "Sandeep Minocha",
    }));
    setResumeFile(tinyFile("resume.pdf", "application/pdf"));
    setAadhaarNumberInput("234567890123");
    setAadhaarImageFile(tinyFile("aadhaar.jpg", "image/jpeg"));
    setPanInput("ABCDE1234F");
    setEducationCertificateFile(tinyFile("education-certificate.pdf", "application/pdf"));
    setPhotoFile(tinyFile("photo.jpg", "image/jpeg"));
    show("Stub test data filled — review and click Generate");
  };
  if (id && !loaded) return <div>Loading…</div>;
  if (draftId && !loaded) return <div>Loading…</div>;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <h1>{id ? `${isContractorForm ? "Edit Candidate Information" : "Regenerate Offer"} — ${[f.candidateFirstName, f.candidateMiddleName, f.candidateLastName].filter(Boolean).join(" ")}` : stageInfo ? `Stage ${stageInfo.order}: ${stageInfo.name}` : "Generate Offer"}</h1>
        {!id && user?.role === "CTO" && <GhostButton onClick={fillStubData}>Fill Test Data</GhostButton>}
      </div>
      <div className="subtitle">
        {id ? "Change what's needed below — submitting creates a new version; the previous version is kept for history." : "No Employee ID here — it's created automatically at Appointment Letter Generation, and only becomes active once you confirm joining."}
      </div>
      <SectionLabel>Candidate &amp; Position</SectionLabel>
      <Panel>
        <div className="form-grid">
          {/* Country chosen first — everything else on this merged stage (identity documents,
              Business Unit choices, and Compensation below) reacts to it. India is the default and
              behaves exactly as it always has when left untouched. */}
          {!id && fieldEnabled("countryCode") && <SelectField label="Country" value={f.countryCode} onChange={(e: any) => setF({ ...f, countryCode: e.target.value, businessUnitId: "" })}
            options={[{ value: "INDIA", label: "🇮🇳 India" }, { value: "US", label: "🇺🇸 United States" }, { value: "CANADA", label: "🇨🇦 Canada" }]} />}
          {/* Order within this identity-fields cluster follows fieldConfig's own sequence (HR's
              drag-to-reorder in the Workflow Builder) — Country (above, first) / Employment Type /
              Business Unit / Compensation (below) stay structurally fixed, since their onChange
              handlers have cross-field side effects and downstream fields react to their position
              being first, not just their value. */}
          {orderedFields([
            { key: "candidateFirstName", node: <Field key="candidateFirstName" label="First Name" required value={f.candidateFirstName} onChange={set("candidateFirstName")} /> },
            { key: "candidateMiddleName", node: fieldEnabled("candidateMiddleName") && <Field key="candidateMiddleName" label="Middle Name" required={fieldMandatory("candidateMiddleName")} value={f.candidateMiddleName} onChange={set("candidateMiddleName")} /> },
            { key: "candidateLastName", node: <Field key="candidateLastName" label="Last Name" required value={f.candidateLastName} onChange={set("candidateLastName")} /> },
            // candidateEmail is the official/work email (schema.prisma comment) — mislabeled "Personal
            // Email" for a long time, which collided with the genuinely-personal candidatePersonalEmail
            // field below (whose own placeholder always referred to "the official Email above").
            { key: "personalEmail", node: <Field key="personalEmail" label="Official Email" required type="email" value={f.candidateEmail} onChange={set("candidateEmail")} /> },
            { key: "phoneNumber", node: fieldEnabled("phoneNumber") && <Field key="phoneNumber" label="Personal Phone" required={fieldMandatory("phoneNumber")} value={f.candidatePhone} onChange={set("candidatePhone")} placeholder="e.g. +91 98765 43210" /> },
            { key: "officialPhone", node: fieldEnabled("officialPhone") && <Field key="officialPhone" label="Official Phone" required={fieldMandatory("officialPhone")} value={f.candidateOfficialPhone} onChange={set("candidateOfficialPhone")} placeholder="Company-issued number, if already assigned" /> },
            { key: "candidatePersonalEmail", node: fieldEnabled("candidatePersonalEmail") && <Field key="candidatePersonalEmail" label="Personal Email" required={fieldMandatory("candidatePersonalEmail")} type="email" value={f.candidatePersonalEmail} onChange={set("candidatePersonalEmail")} placeholder="distinct from the official Email above" /> },
            { key: "gender", node: fieldEnabled("gender") && <SelectField key="gender" label="Gender" required={fieldMandatory("gender")} value={f.gender} onChange={set("gender")}
              options={[{ value: "", label: "— select —" }, { value: "MALE", label: "Male" }, { value: "FEMALE", label: "Female" }, { value: "OTHER", label: "Other" }]} /> },
            { key: "maritalStatus", node: fieldEnabled("maritalStatus") && <SelectField key="maritalStatus" label="Marital Status" required={fieldMandatory("maritalStatus")} value={f.maritalStatus} onChange={set("maritalStatus")}
              options={[{ value: "", label: "— select —" }, { value: "SINGLE", label: "Single" }, { value: "MARRIED", label: "Married" }]} /> },
            { key: "dateOfBirth", node: fieldEnabled("dateOfBirth") && <Field key="dateOfBirth" label="Date of Birth" required={fieldMandatory("dateOfBirth")} type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} /> },
          ], offerFieldOrder)}
          {/* Interns are unpaid far more often than not — defaulting No Cost to Company on the
              instant Intern is picked saves HR a near-guaranteed extra click on almost every
              intern candidate, while still leaving it a real checkbox they can uncheck for the
              rarer paid internship. Only applies going TO Intern — switching away leaves whatever
              HR already had, same as any other field here. */}
          {/* US/Canada: exactly two choices — Employee (Full Time) or Corp to Corp — no Intern
              option there at all. Corp to Corp always means a Vendor engagement (1 US Engagement
              value below); Employee gets the real choice between W2 Full-Time and W2/No Benefit
              Hourly. Picking Corp to Corp here locks US Engagement to VENDOR immediately, same as
              picking Employee here resets it back to a real W2 choice (defaulting Full-Time). */}
          <SelectField label="Employment Type" value={f.employmentType} onChange={(e: any) => {
            const employmentType = e.target.value;
            const patch: any = { employmentType, ...(employmentType === "INTERN" ? { noCostToCompany: true, ctc: "0" } : {}) };
            if (isUsCanada) {
              if (employmentType === "CONTRACTOR") { patch.usEngagementType = "VENDOR"; patch.billingBasis = "HOURLY"; }
              else if (employmentType === "EMPLOYEE" && f.usEngagementType === "VENDOR") { patch.usEngagementType = "W2_FULL_TIME"; patch.billingBasis = "ANNUAL"; }
            }
            setF({ ...f, ...patch });
          }} disabled={!!id}
            options={isUsCanada
              ? [{ value: "EMPLOYEE", label: "Employee (Full Time)" }, { value: "CONTRACTOR", label: "Corp to Corp" }]
              : [{ value: "EMPLOYEE", label: "Employee (Offer + Appointment Letter)" }, { value: "CONTRACTOR", label: "Contractor (Service Agreement)" }, { value: "INTERN", label: "Intern (Service Agreement — simplified)" }]} />
          <SelectField label="Designation" required value={f.designation} onChange={set("designation")}
            options={[{ value: "", label: "— select —" }, ...(designations || []).map((d: any) => ({ value: d.name, label: d.name }))]} />
          {fieldEnabled("businessUnitId") && <SelectField label="Business Unit" required={fieldMandatory("businessUnitId")} value={f.businessUnitId} onChange={(e: any) => {
            const buId = e.target.value;
            const selectedBu = (bus || []).find((b: any) => String(b.id) === String(buId));
            setF({ ...f, businessUnitId: buId, countryCode: selectedBu ? selectedBu.countryCode : f.countryCode });
          }}
            // On a brand-new US/Canada candidate, only that country's own Business Unit(s) — e.g.
            // GenAquarius LLC / Aquarius Technologies Limited — are offered; India's list (and a
            // regenerate's existing selection) is completely unfiltered, unchanged from before.
            options={[{ value: "", label: "—" }, ...(bus || []).filter((b: any) => id || !isUsCanada || b.countryCode === f.countryCode).map((b: any) => ({ value: b.id, label: b.name }))]} />}
          {/* On a regenerate (`id` set), Country stays exactly as it always has — read-only,
              following the Business Unit — editing a candidate's country isn't supported. */}
          {id && fieldEnabled("countryCode") && <SelectField label="Country" value={f.countryCode} onChange={set("countryCode")} disabled={!!f.businessUnitId}
            title={f.businessUnitId ? "Follows the selected Business Unit's own country" : undefined}
            options={[{ value: "INDIA", label: "India" }, { value: "US", label: "United States" }, { value: "CANADA", label: "Canada" }]} />}
          {isContractorForm && fieldEnabled("noCostToCompany") && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: !!id ? "default" : "pointer", gridColumn: "1 / -1" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={f.noCostToCompany} disabled={!!id && !isContractorForm}
                onChange={(e: any) => setF({ ...f, noCostToCompany: e.target.checked, ctc: e.target.checked ? "0" : f.ctc })} />
              No Cost to Company (zero-cost — no CTC will be captured, excluded from headcount &amp; cost)
            </label>
          )}
          {/* US Engagement — same structure for both US and Canada now. Employee (Full Time) gets
              a real choice between W2 Full-Time (flat annual CTC) and W2/No Benefit Hourly
              (derives CTC from rate × hours/day). Corp to Corp has exactly one value (Vendor) —
              shown, not hidden, so the Candidate & Position card still states the engagement type
              explicitly, but with nothing to actually choose. */}
          {isUsCanada && (
            <SelectField label="US Engagement" required value={f.usEngagementType || "W2_FULL_TIME"} disabled={f.employmentType === "CONTRACTOR"} onChange={(e: any) => {
              const usEngagementType = e.target.value;
              const billingBasis = usEngagementType === "W2_FULL_TIME" ? "ANNUAL" : "HOURLY";
              setF({ ...f, usEngagementType, billingBasis });
            }}
              options={f.employmentType === "CONTRACTOR"
                ? [{ value: "VENDOR", label: "Hired from Vendor" }]
                : [{ value: "W2_FULL_TIME", label: "W2 Full-Time (With Benefits)" }, { value: "W2_NO_BENEFIT", label: "W2 / No Benefit — Hourly" }]} />
          )}
          {isUsCanada && (
            <SelectField label="Compensation Structure" required value={f.billingBasis || "ANNUAL"} onChange={(e: any) => setF({ ...f, billingBasis: e.target.value })}
              options={(f.employmentType === "CONTRACTOR" || f.usEngagementType === "W2_NO_BENEFIT" || f.usEngagementType === "VENDOR")
                ? [{ value: "HOURLY", label: "Hourly Rate" }, { value: "DAILY", label: "Daily Rate" }]
                : [{ value: "ANNUAL", label: "Annual Salary / CTC" }, { value: "MONTHLY", label: "Monthly Salary" }]} />
          )}
          {isUsCanada && (f.billingBasis === "HOURLY" || f.billingBasis === "DAILY" || f.billingBasis === "MONTHLY") ? (
            <>
              {f.billingBasis === "HOURLY" && <Field label={`Hourly Rate (${f.countryCode === "CANADA" ? "CAD" : "USD"})`} required type="number" value={f.hourlyRateUsd} onChange={set("hourlyRateUsd")} />}
              {f.billingBasis === "DAILY" && <Field label={`Daily Rate (${f.countryCode === "CANADA" ? "CAD" : "USD"})`} required type="number" value={f.dayRate} onChange={set("dayRate")} />}
              {f.billingBasis === "MONTHLY" && <Field label={`Monthly Salary (${f.countryCode === "CANADA" ? "CAD" : "USD"})`} required type="number" value={f.monthlyAmount} onChange={set("monthlyAmount")} />}
              {f.billingBasis === "HOURLY" && <Field label="Number of Hours (per day)" required type="number" value={f.hoursPerDay} onChange={set("hoursPerDay")} />}
              {(f.billingBasis === "HOURLY" || f.billingBasis === "DAILY") && <Field label="Working Days (per year)" required type="number" value={f.workingDays} onChange={set("workingDays")} />}
              <ReadOnlyField label="Computed Annual CTC" value={`${f.countryCode === "CANADA" ? "C$" : "$"}${(Number(f.ctc) || 0).toLocaleString()} = ${f.billingBasis === "HOURLY" ? `${f.countryCode === "CANADA" ? "C$" : "$"}${f.hourlyRateUsd || 0}/hr × ${f.hoursPerDay || 8} h/day × ${f.workingDays || 260} days` : f.billingBasis === "DAILY" ? `${f.countryCode === "CANADA" ? "C$" : "$"}${f.dayRate || 0}/day × ${f.workingDays || 260} days` : `${f.countryCode === "CANADA" ? "C$" : "$"}${f.monthlyAmount || 0}/month × 12`}`} />
            </>
          ) : showCompStructure ? (
            <>
              <SelectField label="Compensation Structure" required value={f.compensationType} onChange={(e: any) => setComp(e.target.value, f.compensationAmount)}
                options={[{ value: "ANNUAL", label: "Annual CTC" }, { value: "MONTHLY", label: "Monthly Salary" }, { value: "DAILY", label: "Daily Salary" }]} />
              <Field label={f.compensationType === "ANNUAL" ? "Annual CTC (INR)" : f.compensationType === "DAILY" ? "Daily Salary (INR)" : "Monthly Salary (INR)"} required type="number" value={f.compensationAmount} onChange={(e: any) => setComp(f.compensationType, e.target.value)} />
              <ReadOnlyField label="Annualized CTC" value={`₹${(Number(f.ctc) || 0).toLocaleString("en-IN")}${f.compensationType === "MONTHLY" ? " = monthly × 12" : f.compensationType === "DAILY" ? " = daily × 260 working days" : ""}`} />
            </>
          ) : (
            <Field label={f.countryCode === "CANADA" ? "CTC (Annual, CAD)" : "CTC (Annual)"} required={!f.noCostToCompany} disabled={f.noCostToCompany} type="number" value={f.noCostToCompany ? "0" : f.ctc} onChange={set("ctc")} />
          )}
          <Field label="Offer Date" required type="date" value={f.offerDate} onChange={setOfferDate} />
          <Field label="Proposed Joining Date" required type="date" value={f.proposedJoiningDate} onChange={setJoining} />
          {showUanPf && (
            <Field label="UAN / PF Details (if applicable)" value={f.uanPfDetails} onChange={set("uanPfDetails")}
              placeholder="e.g. UAN 100123456789 / PF No." maxLength={191} />
          )}
        </div>
        {/* Vendor/Contractor engagement (US "Hired from Vendor" or Canada "Contractor") — these
            feed MsaSowAgreementPanel's MSA/SOW generation directly (Offer.vendorName etc.). */}
        {isVendorEngagement && (
          <div className="form-grid" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--border)" }}>
            {/* vendorName/vendorEin/endClientName are hard-required below (line ~2204) once a
                Vendor engagement is picked — MsaSowAgreementPanel's whole MSA/SOW flow gates on
                offer.vendorName existing — so these stay always-shown, not configurable, same as
                any other `locked` field. */}
            <Field label="Service Provider (Vendor) Name" required value={f.vendorName} onChange={set("vendorName")} />
            <Field label="Vendor Federal EIN" required value={f.vendorEin} onChange={set("vendorEin")} />
            <Field label="End Client Name" required value={f.endClientName} onChange={set("endClientName")} />
            {fieldEnabled("vendorAddress") && <Field label="Vendor Address" required={fieldMandatory("vendorAddress")} value={f.vendorAddress} onChange={set("vendorAddress")} />}
            {fieldEnabled("engagementDescription") && <Field label="Engagement / Project Description" required={fieldMandatory("engagementDescription")} value={f.engagementDescription} onChange={set("engagementDescription")} />}
          </div>
        )}
        {id && <div className="note" style={{ marginTop: 8 }}>Employment Type can't be changed here — cancel and re-create the candidate under the correct type instead. Every other field above can be corrected and will apply to the next version.</div>}
        {designations && designations.length === 0 && <div className="note" style={{ marginTop: 8 }}>No designations configured yet — add some in HR Settings → Organization.</div>}
        {/* Same merged stage as the rest of this form now — captured here, before the candidate
            record even exists, instead of a separate step on Offer Detail afterward. Resume stays
            available for US/Canada too (just never mandatory there, regardless of HR Settings
            config) — Aadhaar/PAN are India-only and hidden outright. US/Canada's own SSN/SIN,
            Work Authorization, Driver's License, W-9/Void Cheque, and "+ Add Additional Document"
            rows render in their own fixed block further below (usCanDocTypes/OfferDocument) —
            not the India-only configurable "List of Joining Documents" checklist. */}
        {!id && (fieldEnabled("resume") || (!isUsCanada && fieldEnabled("aadhaar"))) && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {fieldEnabled("resume") && (() => {
              const hasResume = !!resumeFile || !!draftFiles.resumeFileData;
              const resumeMandatory = !isUsCanada && fieldMandatory("resume");
              return (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: `1px solid ${hasResume ? "var(--border)" : resumeMandatory ? "var(--bad)" : "var(--border)"}` }}>
                <div style={{ flex: 1, fontSize: 13 }}>
                  {resumeFile
                    ? <>✓ Resume selected: <b>{resumeFile.name}</b></>
                    : draftFiles.resumeFileData
                      ? <>✓ Resume saved in draft: <b>{draftFiles.resumeFileName}</b></>
                      : resumeMandatory
                        ? <span style={{ color: "var(--bad)" }}>⚠ Resume required</span>
                        : <span style={{ color: "var(--muted)" }}>Resume (optional)</span>}
                </div>
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                  {hasResume ? "Change" : "Choose Resume"}
                  <input type="file" style={{ display: "none" }} onChange={(e) => setResumeFile(e.target.files?.[0] || null)} />
                </label>
              </div>
              );
            })()}
            {!isUsCanada && fieldEnabled("aadhaar") && (() => {
              const hasAadhaarImage = !!aadhaarImageFile || !!draftFiles.aadhaarImageFileData;
              return (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: 10, borderRadius: 8, border: `1px solid ${(aadhaarNumberInput.length === 12 && hasAadhaarImage) ? "var(--border)" : fieldMandatory("aadhaar") ? "var(--bad)" : "var(--border)"}` }}>
                <div style={{ flex: 1, fontSize: 13, minWidth: 180 }}>
                  {aadhaarNumberInput.length === 12 && hasAadhaarImage
                    ? <>✓ Aadhaar ready: <b>{aadhaarNumberInput.replace(/\d(?=\d{4})/g, "•")}</b> — image <b>{aadhaarImageFile ? aadhaarImageFile.name : `${draftFiles.aadhaarImageFileName} (saved in draft)`}</b></>
                    : fieldMandatory("aadhaar")
                      ? <span style={{ color: "var(--bad)" }}>⚠ Aadhaar required — number and image</span>
                      : <span style={{ color: "var(--muted)" }}>Aadhaar (optional) — number and image</span>}
                </div>
                <input placeholder="12-digit Aadhaar number" value={aadhaarNumberInput} onChange={(e) => setAadhaarNumberInput(e.target.value)} style={{ width: 180 }} maxLength={12} />
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                  {aadhaarImageFile ? aadhaarImageFile.name : hasAadhaarImage ? "Change Aadhaar Image" : "Choose Aadhaar Image"}
                  <input type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={(e) => setAadhaarImageFile(e.target.files?.[0] || null)} />
                </label>
              </div>
              );
            })()}
            {!isUsCanada && fieldEnabled("pan") && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: 10, borderRadius: 8, border: `1px solid ${/^[A-Z]{5}\d{4}[A-Z]$/.test(panInput) ? "var(--border)" : fieldMandatory("pan") ? "var(--bad)" : "var(--border)"}` }}>
                <div style={{ flex: 1, fontSize: 13, minWidth: 180 }}>
                  {/^[A-Z]{5}\d{4}[A-Z]$/.test(panInput)
                    ? <>✓ PAN ready: <b>{panInput}</b></>
                    : fieldMandatory("pan")
                      ? <span style={{ color: "var(--bad)" }}>⚠ PAN required</span>
                      : <span style={{ color: "var(--muted)" }}>PAN (optional)</span>}
                </div>
                <input placeholder="ABCDE1234F" value={panInput} onChange={(e) => setPanInput(e.target.value.toUpperCase())} style={{ width: 140 }} maxLength={10} />
              </div>
            )}
          </div>
        )}
        {/* Intern's simplified flow captures these here too, same Stage 1 as the rest of this
            catalog. Also reachable on an already-created Intern via "Edit Candidate Information"
            (isContractorForm), unlike Resume/Aadhaar/PAN above which only apply to brand-new
            candidates — Intern's document set is meant to stay editable the same way its other
            candidate fields already are. */}
        {(!id || isContractorForm) && (fieldEnabled("educationCertificate") || fieldEnabled("photo")) && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {fieldEnabled("educationCertificate") && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: `1px solid ${(educationCertificateFile || existing?.educationCertificateFileName || draftFiles.educationCertificateFileData) ? "var(--border)" : fieldMandatory("educationCertificate") ? "var(--bad)" : "var(--border)"}` }}>
                <div style={{ flex: 1, fontSize: 13 }}>
                  {educationCertificateFile
                    ? <>✓ Education Certificate selected: <b>{educationCertificateFile.name}</b></>
                    : existing?.educationCertificateFileName
                      ? <>✓ Education Certificate on file: <b>{existing.educationCertificateFileName}</b></>
                      : draftFiles.educationCertificateFileData
                        ? <>✓ Education Certificate saved in draft: <b>{draftFiles.educationCertificateFileName}</b></>
                        : fieldMandatory("educationCertificate")
                          ? <span style={{ color: "var(--bad)" }}>⚠ Education Certificate required</span>
                          : <span style={{ color: "var(--muted)" }}>Education Certificate (optional)</span>}
                </div>
                {id && existing?.educationCertificateFileName && !educationCertificateFile && (
                  <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/education-certificate`), "_blank")}>View</GhostButton>
                )}
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                  {educationCertificateBusy ? "Uploading…" : (educationCertificateFile || existing?.educationCertificateFileName || draftFiles.educationCertificateFileData) ? "Replace" : "Choose File"}
                  <input type="file" style={{ display: "none" }} disabled={educationCertificateBusy} onChange={async (e) => {
                    const f2 = e.target.files?.[0] || null;
                    setEducationCertificateFile(f2);
                    if (f2 && id) { // editing an already-created offer — upload immediately, same as ManualSignedDocumentsPanel's Replace
                      setEducationCertificateBusy(true);
                      try { const fileData = await fileToBase64(f2); await api.post(`/hr/offers/${id}/education-certificate`, { fileName: f2.name, fileData }); show("Education Certificate uploaded"); }
                      catch (err: any) { show(err.message, "error"); } finally { setEducationCertificateBusy(false); }
                    }
                  }} />
                </label>
              </div>
            )}
            {fieldEnabled("photo") && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: `1px solid ${(photoFile || existing?.photoFileName || draftFiles.photoFileData) ? "var(--border)" : fieldMandatory("photo") ? "var(--bad)" : "var(--border)"}` }}>
                <div style={{ flex: 1, fontSize: 13 }}>
                  {photoFile
                    ? <>✓ Photo selected: <b>{photoFile.name}</b></>
                    : existing?.photoFileName
                      ? <>✓ Photo on file: <b>{existing.photoFileName}</b></>
                      : draftFiles.photoFileData
                        ? <>✓ Photo saved in draft: <b>{draftFiles.photoFileName}</b></>
                        : fieldMandatory("photo")
                          ? <span style={{ color: "var(--bad)" }}>⚠ Photo required</span>
                          : <span style={{ color: "var(--muted)" }}>Photo (optional)</span>}
                </div>
                {id && existing?.photoFileName && !photoFile && (
                  <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/photo`), "_blank")}>View</GhostButton>
                )}
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                  {photoBusy ? "Uploading…" : (photoFile || existing?.photoFileName || draftFiles.photoFileData) ? "Replace" : "Choose File"}
                  <input type="file" accept="image/*" style={{ display: "none" }} disabled={photoBusy} onChange={async (e) => {
                    const f2 = e.target.files?.[0] || null;
                    setPhotoFile(f2);
                    if (f2 && id) {
                      setPhotoBusy(true);
                      try { const fileData = await fileToBase64(f2); await api.post(`/hr/offers/${id}/photo`, { fileName: f2.name, fileData }); show("Photo uploaded"); }
                      catch (err: any) { show(err.message, "error"); } finally { setPhotoBusy(false); }
                    }
                  }} />
                </label>
              </div>
            )}
          </div>
        )}
        {isUsCanada && (!id || isContractorForm) && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {usCanDocTypes.map((dt) => {
              const file = usCanDocs[dt.key];
              const existingDoc = (existing?.documents || []).find((d: any) => d.docType === dt.key);
              const busy = !!usCanDocsBusy[dt.key];
              const has = !!file || !!existingDoc;
              return (
                <div key={dt.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: "1px solid var(--border)" }}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    {file
                      ? <>✓ {dt.label} selected: <b>{file.name}</b></>
                      : existingDoc
                        ? <>✓ {dt.label} on file: <b>{existingDoc.fileName}</b></>
                        : fieldMandatory(dt.configKey)
                          ? <span style={{ color: "var(--bad)" }}>⚠ {dt.label} required</span>
                          : <span style={{ color: "var(--muted)" }}>{dt.label} {dt.note || "(optional)"}</span>}
                  </div>
                  {id && existingDoc && !file && (
                    <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/documents/${dt.key}`), "_blank")}>View</GhostButton>
                  )}
                  <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                    {busy ? "Uploading…" : has ? "Replace" : "Upload"}
                    <input type="file" style={{ display: "none" }} disabled={busy} onChange={async (e) => {
                      const f2 = e.target.files?.[0] || null;
                      setUsCanDocs((cur) => ({ ...cur, [dt.key]: f2 }));
                      if (f2 && id) {
                        setUsCanDocsBusy((cur) => ({ ...cur, [dt.key]: true }));
                        try { const fileData = await fileToBase64(f2); await api.post(`/hr/offers/${id}/documents`, { docType: dt.key, label: dt.label, fileName: f2.name, fileData }); show(`${dt.label} uploaded`); }
                        catch (err: any) { show(err.message, "error"); } finally { setUsCanDocsBusy((cur) => ({ ...cur, [dt.key]: false })); }
                      }
                    }} />
                  </label>
                </div>
              );
            })}
            {customDocs.map((cd, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: "1px solid var(--border)" }}>
                <div style={{ flex: 1, fontSize: 13 }}>✓ {cd.label}: <b>{cd.file.name}</b></div>
                <GhostButton onClick={() => setCustomDocs((cur) => cur.filter((_, idx) => idx !== i))}>Remove</GhostButton>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input placeholder="Name a document not on this list…" value={customDocLabel} onChange={(e) => setCustomDocLabel(e.target.value)} style={{ flex: 1 }} />
              <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                Choose File
                <input type="file" style={{ display: "none" }} onChange={(e) => setCustomDocFile(e.target.files?.[0] || null)} />
              </label>
              <GhostButton onClick={async () => {
                if (!customDocLabel.trim() || !customDocFile) return show("Name the document and choose a file first", "error");
                if (id) {
                  try { const fileData = await fileToBase64(customDocFile); await api.post(`/hr/offers/${id}/documents`, { docType: `CUSTOM:${customDocLabel.trim()}`, label: customDocLabel.trim(), fileName: customDocFile.name, fileData }); show(`${customDocLabel.trim()} uploaded`); }
                  catch (err: any) { return show(err.message, "error"); }
                }
                setCustomDocs((cur) => [...cur, { label: customDocLabel.trim(), file: customDocFile }]);
                setCustomDocLabel(""); setCustomDocFile(null);
              }}>+ Add Additional Document</GhostButton>
            </div>
          </div>
        )}
      </Panel>

      {fieldEnabled("address") && (
        <>
          <SectionLabel>Address</SectionLabel>
          <Panel>
            <div className="note" style={{ marginBottom: 8 }}>Permanent Address (native/family address)</div>
            <div className="form-grid">
              <Field label="Address Line" required={fieldMandatory("address")} value={f.candidateAddress} onChange={set("candidateAddress")} disabled={!!id && !isContractorForm} placeholder="House / street / area" />
              {fieldEnabled("candidateCity") && <Field label="City" required={fieldMandatory("candidateCity")} value={f.candidateCity} onChange={set("candidateCity")} disabled={!!id && !isContractorForm} />}
              {fieldEnabled("candidateLandmark") && <Field label="Nearby Landmark" required={fieldMandatory("candidateLandmark")} value={f.candidateLandmark} onChange={set("candidateLandmark")} disabled={!!id && !isContractorForm} />}
              {fieldEnabled("candidateState") && <Field label="State" required={fieldMandatory("candidateState")} value={f.candidateState} onChange={set("candidateState")} disabled={!!id && !isContractorForm} />}
              {fieldEnabled("candidatePincode") && <Field label="Pincode" required={fieldMandatory("candidatePincode")} value={f.candidatePincode} onChange={set("candidatePincode")} disabled={!!id && !isContractorForm} />}
            </div>
            {fieldEnabled("residentSameAsPermanent") && <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <input type="checkbox" checked={f.residentSameAsPermanent} disabled={!!id && !isContractorForm}
                onChange={(e) => setF({ ...f, residentSameAsPermanent: e.target.checked })} />
              Resident Address (current/where equipment ships) is the same as Permanent Address
            </label>}
            {!f.residentSameAsPermanent && (
              <div className="form-grid" style={{ marginTop: 10 }}>
                {fieldEnabled("residentAddress") && <Field label="Resident Address Line" required={fieldMandatory("residentAddress")} value={f.residentAddress} onChange={set("residentAddress")} disabled={!!id && !isContractorForm} placeholder="House / street / area" />}
                {fieldEnabled("residentCity") && <Field label="Resident City" required={fieldMandatory("residentCity")} value={f.residentCity} onChange={set("residentCity")} disabled={!!id && !isContractorForm} />}
                {fieldEnabled("residentLandmark") && <Field label="Resident Nearby Landmark" required={fieldMandatory("residentLandmark")} value={f.residentLandmark} onChange={set("residentLandmark")} disabled={!!id && !isContractorForm} />}
                {fieldEnabled("residentState") && <Field label="Resident State" required={fieldMandatory("residentState")} value={f.residentState} onChange={set("residentState")} disabled={!!id && !isContractorForm} />}
                {fieldEnabled("residentPincode") && <Field label="Resident Pincode" required={fieldMandatory("residentPincode")} value={f.residentPincode} onChange={set("residentPincode")} disabled={!!id && !isContractorForm} />}
              </div>
            )}
          </Panel>
        </>
      )}

      <SectionLabel>Offer Terms</SectionLabel>
      <Panel>
        <div className="form-grid">
          <SelectField label="Reporting To" required value={f.reportingManager} onChange={set("reportingManager")}
            options={[{ value: "", label: "— select —" }, ...activeEmployees.map((e: any) => ({ value: e.name, label: `${e.name}${e.empNo ? ` (${e.empNo})` : ""}` }))]} />
          <SelectField label="Department" required value={f.department} onChange={set("department")}
            options={[{ value: "", label: "— select —" }, ...(departments || []).map((d: any) => ({ value: d.name, label: d.name }))]} />
          {fieldEnabled("acceptanceDeadline") && <Field label="Acceptance Deadline" required type="date" value={f.acceptanceDeadline} onChange={setDeadline} />}
          {/* India/general Contractor (Service Agreement) genuinely skips these — but the artifact's
              US/Canada Offer Terms card always shows Work Location/Probation/Notice Period, Vendor
              engagement or not, so isUsCanada overrides the usual isContractorForm hide. */}
          {(!isContractorForm || isUsCanada) && <>
            {fieldEnabled("workLocation") && <SelectField label="Work Location" required value={f.workLocation} onChange={set("workLocation")}
              options={[{ value: "Office", label: "Office" }, { value: "Hybrid", label: "Hybrid" }, { value: "Remote", label: "Remote" }]} />}
            {fieldEnabled("probationPeriod") && <SelectField label="Probation Period" required value={f.probationPeriod} onChange={set("probationPeriod")} options={PERIOD_OPTIONS} />}
            {fieldEnabled("noticePeriod") && <SelectField label="Notice Period" required value={f.noticePeriod} onChange={set("noticePeriod")} options={PERIOD_OPTIONS} />}
          </>}
        </div>
        <div className="note" style={{ marginTop: 8 }}>{isContractorForm ? "These carry forward to the Service Agreement automatically." : "These carry forward to the Appointment Letter automatically — you won't be asked again unless you want to change something at that stage."}</div>
        {departments && departments.length === 0 && <div className="note">No departments configured yet — add some in HR Settings → Organization.</div>}
      </Panel>

      {/* India/Contractor/Intern only — the artifact's US/Canada Stage 1 has no checklist-driven
          "what prints on the letter" concept at all (nothing in that flow generates a letter from
          a checklist); its own simple, fixed Supporting Documents list renders separately below. */}
      {!isUsCanada && fieldEnabled("documentChecklist") && (
        <>
          <SectionLabel>List of Joining Documents{fieldMandatory("documentChecklist") && <span style={{ color: "var(--bad)" }}> *</span>}</SectionLabel>
          <Panel>
            <div className="subtitle" style={{ marginTop: 0 }}>Uncheck anything not required for this {isContractorForm ? "contractor" : "candidate"} — checked items print on the generated {isContractorForm ? "Service Agreement" : "Offer Letter"}. Manage the master list in HR Settings → Onboarding Doc Checklist.{fieldMandatory("documentChecklist") && " At least one document must be selected."}</div>
            {!allDocTypes ? <div style={{ color: "var(--muted)" }}>Loading…</div> : docTypes.length === 0 ? (
              <div style={{ color: "var(--muted)" }}>No document types configured yet.</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "4px 0 8px" }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{(f.documentChecklist || []).length} of {docTypes.length} selected</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <GhostButton onClick={selectAllDocs}>Select All</GhostButton>
                    <GhostButton onClick={clearAllDocs}>Clear All</GhostButton>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "3px 8px" }}>
                  {docTypes.map((d: any) => {
                    const checked = (f.documentChecklist || []).includes(d.name);
                    // A directly-controlled checkbox with its own onChange, instead of a
                    // readOnly+pointerEvents:none input relying on the label's own onClick to
                    // bubble to it — that combination let the browser's native label→input click
                    // forwarding race the label's onClick handler (readOnly checkboxes still
                    // receive that forwarded click in some browsers), which could net out to no
                    // visible change on a single click. This is the standard, unambiguous pattern.
                    return (
                      <label key={d.id} style={{
                        display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 5, cursor: "pointer", fontSize: 12,
                        border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`, background: checked ? "var(--panel2)" : "transparent",
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleDoc(d.name)} style={{ width: 13, height: 13 }} />
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.name}>{d.name}</span>
                        {d.required && <span className="pill" style={{ fontSize: 9, padding: "0 5px" }}>Req</span>}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </Panel>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        {/* Not for a regenerate (`id` set) — that's editing an already-real Offer, there's nothing
            "in progress" to save separately from it. Available at any point in Stage 1, filled or
            not — saves exactly what's typed so far, with no validation. */}
        {!id && <GhostButton onClick={saveDraft} disabled={busy}>{busy ? "Saving…" : "Save & Continue Later"}</GhostButton>}
        {(() => {
          if (id && isContractorForm) return <AddButton onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save Changes →"}</AddButton>;
          const noun = usesServiceAgreement(f.employmentType) ? "SLA" : "Offer";
          const label = busy ? `${id ? "Regenerating" : "Generating"} ${noun}…` : `${id ? "Regenerate" : "Generate"} ${noun} →`;
          return <AddButton onClick={submit} disabled={busy}>{label}</AddButton>;
        })()}
      </div>
    </div>
  );
}

// Small uppercase mini-heading used to separate a long form into scannable sections — matches
// the section-label style already used on the HR Dashboard's "Workforce"/"Offer Pipeline" etc.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".5px", margin: "18px 0 8px" }}>{children}</h2>;
}

// =====================================================================================
// Offers & Lifecycle — list
// =====================================================================================
export function OffersList() {
  const { data: allData, reload } = useFetch<any[]>("/hr/offers");
  const { data: drafts, reload: reloadDrafts } = useFetch<any[]>("/hr/offer-drafts");
  // Live — a candidate signing/declining anywhere moves this list's Status/Acceptance columns,
  // so anyone with this page open sees it without a manual refresh.
  useEffect(() => watchRoom("esign:activity", "esign:activity", reload), []);
  const navigate = useNavigate();
  const { show } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [docsOffer, setDocsOffer] = useState<any>(null);
  // Once JOINING_CONFIRMED (employeeId set), an offer is done — it moves to Onboarding History
  // (its own page) instead of cluttering the in-progress lifecycle list.
  const data = (allData || []).filter((o) => !o.employeeId);
  const selectable = data.map((o) => o.id);
  const toggleAll = () => setSelected(selected.size === selectable.length ? new Set() : new Set(selectable));
  const toggleOne = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const bulkDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} selected candidate(s)/offer(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r: any = await api.post("/hr/offers/bulk-delete", { ids: Array.from(selected) });
      show(`Deleted ${r.deleted} offer(s)${r.skipped ? `; skipped ${r.skipped} (already active)` : ""}`);
      setSelected(new Set()); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const discardDraft = async (d: any) => {
    if (!window.confirm(`Discard the saved draft for "${d.label}"? This cannot be undone.`)) return;
    try { await api.del(`/hr/offer-drafts/${d.id}`); reloadDrafts(); } catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Onboarding Flow</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <GhostButton onClick={() => navigate("/hr/onboarding-history")}>Onboarding History →</GhostButton>
          <AddButton onClick={() => navigate("/hr/offers/new")}>Start Onboarding</AddButton>
        </div>
      </div>
      <div className="subtitle">Candidate Created → Offer Sent → Accepted → Appointment Letter (Employee ID created, hidden) → Issued → Joining Confirmed. Once activated, a candidate moves to Onboarding History.</div>
      {/* Half-filled Create Candidate forms HR saved with "Save & Continue Later" instead of
          finishing — no Offer row exists for these yet (see OfferDraftSave), so they'd otherwise
          be invisible anywhere in this app until resumed. */}
      {!!drafts?.length && (
        <Panel title={`Saved Drafts (${drafts.length})`} style={{ marginTop: 12, marginBottom: 12 }}>
          {drafts.map((d: any) => (
            <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{d.label}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>Saved {fmtDateTime(d.updatedAt)}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => navigate(`/hr/offers/new?draftId=${d.id}`)}>Resume</button>
                <GhostButton onClick={() => discardDraft(d)}>Discard</GhostButton>
              </div>
            </div>
          ))}
        </Panel>
      )}
      <AcceptanceLegend />
      <div className="btn-row">
        {selected.size > 0 && <GhostButton onClick={bulkDelete} disabled={busy}>Delete Selected ({selected.size})</GhostButton>}
      </div>
      <Panel>
        <table><thead><tr>
          <th>
            <input type="checkbox" checked={selectable.length > 0 && selected.size === selectable.length}
              ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < selectable.length; }}
              onChange={toggleAll} title={selected.size ? "Clear selection" : "Select all"} />
          </th>
          <th>Candidate</th><th>Type</th><th>CTC</th><th>Role</th><th>Status</th><th>Current Stage</th><th>Acceptance</th><th>Next Action</th><th>Employee ID</th><th></th>
        </tr></thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={11} style={{ color: "var(--muted)" }}>No offers in progress.</td></tr>}
            {data.map((o) => (
              <tr key={o.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/hr/offers/${o.id}`)}>
                <td><input type="checkbox" checked={selected.has(o.id)} onChange={() => {}} onClick={(e) => toggleOne(o.id, e)} /></td>
                <td>{o.candidateName}</td>
                <td><EmploymentTypePill t={o.employmentType || "EMPLOYEE"} /></td>
                <td className="num">{o.ctc.toLocaleString()}</td><td>{o.role}</td>
                <td>
                  <StatusPill s={o.status} />
                  {o.ctcRejectedAt && <span className="pill bad" style={{ marginLeft: 4 }} title={o.ctcRejectionNote || "CTC rejected by Finance"}>CTC Rejected</span>}
                </td>
                {/* Driven by the published Workflow & Stage Configuration (engine/workflow.ts) — every
                    configured stage, in configured order/name, not a hardcoded label — reorder/rename
                    a stage there and this follows. Dots show the full sequence; the pill highlights
                    the current one, same vocabulary as the Offer Detail stepper. */}
                <td style={{ fontSize: 12 }}>
                  {o.currentStage ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {(o.stages || []).map((s: any) => (
                        <span key={s.key} title={`${s.order}. ${s.name}${s.current ? " (current)" : s.status === "COMPLETED" || s.status === "SKIPPED" ? " — done" : ""}`}
                          style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: s.status === "COMPLETED" || s.status === "SKIPPED" ? "var(--good)" : s.current ? "var(--accent)" : "var(--border)" }} />
                      ))}
                      <span className="pill accent" style={{ marginLeft: 4 }} title={o.currentStage.stageType}>{o.currentStage.order}. {o.currentStage.name}</span>
                    </div>
                  ) : <span style={{ color: "var(--muted)" }}>—</span>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <AcceptancePill label="Offer" badge={o.offerAcceptance} rawStatus={o.status} />
                  <AcceptancePill label="Appointment" badge={o.appointmentAcceptance} rawStatus={o.appointmentLetter?.status} />
                  <AcceptancePill label="SLA" badge={o.serviceAgreementAcceptance} rawStatus={o.serviceAgreement?.status} />
                </td>
                <td style={{ fontSize: 12, color: "var(--text)" }}>{nextActionFor(o)}</td>
                <td style={{ color: "var(--muted)" }}>{o.reservedEmpNo ? <>{o.reservedEmpNo} <span className="pill">hidden</span></> : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}><GhostButton onClick={(e: any) => { e.stopPropagation(); setDocsOffer(o); }}>Documents</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <DocumentsModal offer={docsOffer} onClose={() => setDocsOffer(null)} />
    </div>
  );
}

// Everything a candidate has signed (Offer/Appointment/SLA, whichever apply for Employee vs
// Contractor/Intern) plus everything uploaded for Stage 3 Document Collection — one place to check
// the full paper trail without opening the full Offer Detail timeline. Shared by Offers &
// Lifecycle, Onboarding History and Employee Master's own "Offer & Onboarding" modal.
function DocumentsModal({ offer, onClose }: { offer: any; onClose: () => void }) {
  if (!offer) return null;
  return (
    <Modal title={`Documents — ${offer.candidateName}`} open onClose={onClose}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Signed Documents</div>
      <table><tbody>
        <tr>
          <td>{usesServiceAgreement(offer.employmentType) ? "SLA (Offer)" : "Offer Letter"}</td>
          <td className="num">{offer.offerAcceptance?.status || "PENDING"}</td>
          <td className="num">
            {offer.offerAcceptance?.method === "ADOBE_SIGN" && <GhostButton onClick={() => window.open(api.pdfUrl(`/adobe-sign/signed/OFFER/${offer.id}`), "_blank")}>Preview</GhostButton>}
            {offer.offerAcceptance?.method !== "ADOBE_SIGN" && offer.signedOfferFileName && <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${offer.id}/signed-offer`), "_blank")}>Preview</GhostButton>}
          </td>
        </tr>
        {offer.appointmentLetter && (
          <tr>
            <td>Appointment Letter</td>
            <td className="num">{offer.appointmentAcceptance?.status || "PENDING"}</td>
            <td className="num">
              {offer.appointmentAcceptance?.method === "ADOBE_SIGN" && <GhostButton onClick={() => window.open(api.pdfUrl(`/adobe-sign/signed/APPOINTMENT_LETTER/${offer.id}`), "_blank")}>Preview</GhostButton>}
              {offer.appointmentAcceptance?.method !== "ADOBE_SIGN" && offer.appointmentLetter?.signedFileName && <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${offer.id}/appointment/signed`), "_blank")}>Preview</GhostButton>}
            </td>
          </tr>
        )}
        {offer.serviceAgreement && (
          <tr>
            <td>{offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement (SLA)"}</td>
            <td className="num">{offer.serviceAgreementAcceptance?.status || "PENDING"}</td>
            <td className="num">
              {offer.serviceAgreementAcceptance?.method === "ADOBE_SIGN" && <GhostButton onClick={() => window.open(api.pdfUrl(`/adobe-sign/signed/SERVICE_AGREEMENT/${offer.id}`), "_blank")}>Preview</GhostButton>}
              {offer.serviceAgreementAcceptance?.method !== "ADOBE_SIGN" && offer.serviceAgreement?.signedFileName && <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${offer.id}/service-agreement/signed`), "_blank")}>Preview</GhostButton>}
            </td>
          </tr>
        )}
      </tbody></table>
      <CandidateDocumentsPanel offerId={offer.id} />
    </Modal>
  );
}

// =====================================================================================
// Onboarding History — candidates whose joining has been confirmed (employeeId set), split
// out of Offers & Lifecycle so the in-progress list doesn't accumulate completed onboardings.
// =====================================================================================
export function OnboardingHistory() {
  const { data: allData, reload } = useFetch<any[]>("/hr/offers");
  const navigate = useNavigate();
  const { show } = useToast();
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [docsOffer, setDocsOffer] = useState<any>(null);
  // A CTC rejection removes the Employee row entirely (see ctcApprovals.ts /:id/reject) — it still
  // belongs here as a rejected record, just without an employeeId to show alongside it anymore.
  const data = (allData || []).filter((o) => !!o.employeeId || !!o.ctcRejectedAt);
  // An active employee/contractor's history record is permanent — never selectable/deletable here.
  // Only a CTC-rejected record (no employeeId; the Employee row was already removed at rejection)
  // can be removed from this page.
  const deletableIds = data.filter((o) => !o.employeeId).map((o) => o.id);
  const ids = deletableIds;
  const toggleAll = () => setChecked(checked.size === ids.length ? new Set() : new Set(ids));
  const toggleOne = (id: number) => {
    const next = new Set(checked);
    next.has(id) ? next.delete(id) : next.add(id);
    setChecked(next);
  };
  const deleteChosen = async (chosenIds: number[], label: string) => {
    if (!chosenIds.length) return;
    if (!window.confirm(`Delete ${chosenIds.length} ${label} from Onboarding History? This removes the offer/appointment paper trail only — the Employee record in Employee Master is NOT deleted.`)) return;
    setBusy(true);
    try {
      const r: any = await api.post("/hr/offers/bulk-delete-history", { ids: chosenIds });
      show(`Deleted ${r.deleted} record(s)${r.skipped ? `; skipped ${r.skipped}` : ""}`);
      setChecked(new Set()); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Onboarding History</h1>
        <GhostButton onClick={() => navigate("/hr/offers")}>← Onboarding Flow</GhostButton>
      </div>
      <div className="subtitle">Every candidate who has completed Confirm Joining and is now a live Employee / Contractor. An active employee/contractor's record here is permanent and cannot be deleted — only a CTC-rejected record (🔒 shown for active ones; select/delete is available for rejected records only) can be removed.</div>
      <div className="btn-row">
        {checked.size > 0 && <GhostButton disabled={busy} onClick={() => deleteChosen(Array.from(checked), "selected record(s)")}>Delete Selected ({checked.size})</GhostButton>}
        {ids.length > 0 && <GhostButton disabled={busy} onClick={() => deleteChosen(ids, "record(s)")}>Delete All ({ids.length})</GhostButton>}
      </div>
      <Panel>
        <table><thead><tr>
          <th>
            <input type="checkbox" checked={ids.length > 0 && checked.size === ids.length}
              ref={(el) => { if (el) el.indeterminate = checked.size > 0 && checked.size < ids.length; }}
              onChange={toggleAll} title={checked.size ? "Clear selection" : "Select all"} />
          </th>
          <th>Candidate</th><th>Type</th><th>CTC</th><th>Role</th><th>Employee ID</th><th>CTC Status</th><th></th>
        </tr></thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={8} style={{ color: "var(--muted)" }}>No one has been activated yet.</td></tr>}
            {data.map((o) => (
              <tr key={o.id}>
                <td>{o.employeeId
                  ? <span title="Active employee/contractor — this history record is permanent and cannot be deleted">🔒</span>
                  : <input type="checkbox" checked={checked.has(o.id)} onChange={() => toggleOne(o.id)} />}</td>
                <td>{o.candidateName}</td>
                <td><EmploymentTypePill t={o.employmentType || "EMPLOYEE"} /></td>
                <td className="num">{o.ctc.toLocaleString()}</td><td>{o.role}</td>
                <td>
                  {o.ctcApprovalStatus === "REJECTED"
                    ? <span className="pill bad" title="CTC rejected — the Employee record was removed">{o.reservedEmpNo} (removed)</span>
                    : <span className="pill good">{o.reservedEmpNo}</span>}
                </td>
                <td><CtcStatusPill s={o.ctcApprovalStatus} /></td>
                <td style={{ display: "flex", gap: 6 }}>
                  <GhostButton onClick={() => navigate(`/hr/offers/${o.id}`)}>Offer History</GhostButton>
                  <GhostButton onClick={() => setDocsOffer(o)}>Documents</GhostButton>
                  {o.ctcApprovalStatus !== "REJECTED" && <GhostButton onClick={() => navigate("/employees")}>Employee Master →</GhostButton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <DocumentsModal offer={docsOffer} onClose={() => setDocsOffer(null)} />
    </div>
  );
}

// =====================================================================================
// Terminate Employee — its own left-navigation page (previously a per-row button buried in
// Employee Master). HR only specifies the termination date here; the real termination logic
// (FNF, cost proration, monthly-line removal) runs only once Finance/CTO/CEO approve it in
// Termination Approvals — same /request-termination call Employee Master used to make.
// =====================================================================================
export function TerminateEmployeePage() {
  const { data: employees, reload } = useFetch<any[]>("/employees");
  // Employees who already have a termination request sitting with Finance — shown as "Pending
  // Deployment End Date Approval" or "Pending FNF" (matching whichever queue it's actually in,
  // terminationApprovals.ts's own showFnfStage) and not selectable again, so HR can't fire off a
  // second request for them.
  const { data: pendingRows, reload: reloadPending } = useFetch<{ employeeId: number; stage: "DEPLOYMENT_END" | "FNF" }[]>("/employees/termination-pending-ids");
  const pendingMap = new Map((pendingRows || []).map((r) => [r.employeeId, r.stage]));
  const pendingSet = new Set(pendingMap.keys());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const active = (employees || []).filter((e: any) => !e.exitDate);
  const q = search.trim().toLowerCase();
  const filtered = q ? active.filter((e: any) => `${e.name} ${e.empNo || ""}`.toLowerCase().includes(q)) : active;
  const selected = active.find((e: any) => e.id === selectedId) || null;
  const selectedPending = !!selected && pendingSet.has(selected.id);

  return (
    <div>
      <h1>Terminate Employee</h1>
      <div className="subtitle">HR specifies the termination details (notice/basic/EL/reimbursement for a full-time employee, or deployment end date for a contractor) — Finance/CTO/CEO review and can override everything before approving.</div>
      <div className="grid cols-2" style={{ alignItems: "start", marginTop: 12 }}>
        <Panel title={`Active Employees (${active.length})`}>
          <Field label="Search" value={search} onChange={(e: any) => setSearch(e.target.value)} placeholder="Search by name or employee ID…" />
          <table style={{ marginTop: 10 }}><thead><tr><th>Name</th><th>Employee ID</th><th>Location</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>{active.length === 0 ? "No active employees." : "No matches."}</td></tr>}
              {filtered.map((e: any) => {
                const isPending = pendingSet.has(e.id);
                return (
                  <tr key={e.id} style={{ cursor: "pointer", background: selectedId === e.id ? "var(--panel2)" : undefined, opacity: isPending ? 0.65 : 1 }} onClick={() => setSelectedId(e.id)}>
                    <td>{e.name}</td><td>{e.empNo || "—"}</td><td>{e.location || "—"}</td>
                    <td>{e.empType === "FULL_TIME" ? "Full-Time" : "Contractor"}</td>
                    <td>{isPending ? <span className="badge" style={{ color: "var(--accent)" }}>{pendingMap.get(e.id) === "DEPLOYMENT_END" ? "Pending Deployment End Date Approval" : "Pending FNF"}</span> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
        {selected ? (
          selectedPending ? (
            <Panel title={`Termination — ${selected.name}`}>
              <div className="note">A termination request for {selected.name} is already {pendingMap.get(selected.id) === "DEPLOYMENT_END" ? "pending Deployment End Date approval" : "pending FNF finalization"} — nothing more to do here until Finance approves, finalizes, or rejects it.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <GhostButton onClick={() => setSelectedId(null)}>Close</GhostButton>
              </div>
            </Panel>
          ) : (
            <TerminationRequestForm key={selected.id} employee={selected} onDone={() => { setSelectedId(null); reload(); reloadPending(); }} />
          )
        ) : (
          <Panel title="Termination"><div style={{ color: "var(--muted)" }}>Select an employee on the left.</div></Panel>
        )}
      </div>
    </div>
  );
}

// Full-time employees: HR gives notice period + Basic (auto-pulled from CTC, editable); EL
// encashment (from the live leave balance) and notice-pay shortfall are auto-computed off those
// inputs but HR can override any of them before notifying Finance, who can override again at
// approval. Contractors/vendors instead just give a Deployment End Date — Finance's FnF for them
// is billing/invoice proration to that date (see terminateEmployee's billingEndDate), not these
// salary-derived components.
function TerminationRequestForm({ employee, onDone }: any) {
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const isFullTime = employee.empType === "FULL_TIME";
  // Required for a contractor (last billable day) and for a billable full-time resource (their
  // project's revenue/cost proration depends on it). Optional only for a non-billable full-time
  // employee — they'll sit on Bench in between if it's given, per Monthly Forecast's own
  // deployment-window/bench engine (approved as a separate Finance step).
  const deploymentEndRequired = !isFullTime || employee.isBillable !== false;
  const [exitDate, setExitDate] = useState(new Date().toISOString().slice(0, 10));
  const [deploymentEndDate, setDeploymentEndDate] = useState(isFullTime && !deploymentEndRequired ? "" : new Date().toISOString().slice(0, 10));
  // Contractor-only — overrides JUST the printed "Last Day of Working" on the FnF document; never
  // feeds into any salary/EL/notice-pay math. Defaults to today (same as Termination Date/
  // Deployment End Date above), matching today's unconditional behavior until overridden.
  const [fnfPrintDate, setFnfPrintDate] = useState(new Date().toISOString().slice(0, 10));
  // Contractor-only — when set, both the Salary-for-Days-Worked dollar amount below AND the FnF
  // document's printed "No. of Days Worked" count use THIS number instead of the auto-derived
  // "days from month-start (or joining) to Deployment End Date" — "Last Day of Working" (above)
  // is unaffected either way. Null = auto-derive, same as before this field existed.
  const [payableDaysOverride, setPayableDaysOverride] = useState<number | null>(null);
  // Contractor-only, purely informational — prints a "Leaves" row on the FnF document when set.
  const [leavesCount, setLeavesCount] = useState<number | null>(null);
  // Contractor-only — not every contractor is GST-registered. No GST Amount override here (this
  // form never collects a real FNF Amount — Finance determines that from billing/invoice — so
  // "18% of FNF Amount" has nothing to compute against yet); Finance's own panel has the amount
  // override once a real FNF Amount exists. Same default (on) as Finance's panel — just the
  // starting point, still reviewable/overridable at approval.
  const [includeGst, setIncludeGst] = useState(true);
  // Contractor-only — unpaid amount owed from a prior month, in INR. When set, the FnF document
  // splits Gross Payable Amount into an Arrear line + a This-Month line, and GST/TDS are computed
  // on the combined total instead of This Month alone.
  const [arrearAmount, setArrearAmount] = useState<number | null>(null);
  // Contractor-only — HR's own override of the auto-computed "Salary for Days Worked This Month"
  // (INR). Null = show/use the auto-computed contractorDaysWorkedSalaryInr() figure, same as
  // before this override existed. When set, it's sent as finalFnfAmount (converted to USD) so
  // Finance's approval panel starts from exactly what HR typed, instead of silently recomputing.
  const [daysWorkedSalaryOverride, setDaysWorkedSalaryOverride] = useState<number | null>(null);
  const [resignationDate, setResignationDate] = useState("");
  const [fnfFinalizationDate, setFnfFinalizationDate] = useState("");
  // Full-time only: skip Bench entirely past the Deployment End Date (same no-bench behavior a
  // contractor already gets) instead of the default — sitting on Bench until the Termination Date.
  const [noBenchMovement, setNoBenchMovement] = useState(false);
  // Has IT already disabled this employee's Office 365 account? If not, Finance gets one more
  // chance to flip it at final approval — whenever it becomes true, Finance/HR/IT admin get
  // notified to actually go deactivate it (see routes/terminationApprovals.ts's /approve).
  const [emailTerminated, setEmailTerminated] = useState(false);
  // Auto-derived from the employee's own Notice Period (Employee Master, e.g. "2 Months" → 60
  // days) when available, so HR doesn't have to re-type what's already on record — still editable.
  const noticePeriodDays = employee.noticePeriod ? (parseInt(employee.noticePeriod, 10) || 0) * 30 : 0;
  const [requiredNoticeDays, setRequiredNoticeDays] = useState(noticePeriodDays);
  const [servedNoticeDays, setServedNoticeDays] = useState(0);
  // "Notice Served Waiver" — unchecked (default), Notice Pay is Basic/30 × days actually SERVED.
  // Checked, the company waives the requirement that notice be served and pays the FULL required
  // notice period instead (Basic/30 × required), regardless of how many days were served. A
  // deliberate company choice, not an auto-detected condition — HR toggles it explicitly.
  const [payFullNoticePeriod, setPayFullNoticePeriod] = useState(false);
  // Resignation Date → Termination Date is the notice actually served — auto-fills Served
  // whenever either date is set/changed, still overridable by hand afterward.
  const setResignationDateAndRecalc = (v: string) => {
    setResignationDate(v);
    if (v && exitDate) {
      const days = Math.max(0, Math.round((new Date(exitDate + "T00:00:00").getTime() - new Date(v + "T00:00:00").getTime()) / 86400000));
      setServedNoticeDays(days);
      recompute(requiredNoticeDays, days);
    }
  };
  const [basicSalary, setBasicSalary] = useState(0);
  // Plain Basic (from the CTC record) — what Notice Pay actually prices off, shown next to Full
  // Pay so HR can see the two figures are different. Editing it recomputes Notice Pay inline.
  const [basicOnly, setBasicOnly] = useState(0);
  const [basicCurrency, setBasicCurrency] = useState("INR");
  const [elDays, setElDays] = useState(0);
  const [elAmount, setElAmount] = useState(0);
  // Remembered so editing EL Days by hand can recompute EL Amount (Days × rate) instead of just
  // sitting there unchanged — the suggestion endpoint is the only place this rate is known.
  const [elRatePerDay, setElRatePerDay] = useState(0);
  const [noticePay, setNoticePay] = useState(0);
  const [reimbursement, setReimbursement] = useState(0);
  // Salary for days already worked in the termination month, up to and including the
  // Termination Date (e.g. terminating on the 4th pays Basic/30 × 4 days) — auto-recomputed
  // whenever Termination Date or Basic changes, still editable by hand afterward.
  const [daysWorkedSalary, setDaysWorkedSalary] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // Contractor — Total CTC (annualUsd) fetched once so "Salary for Days Worked This Month" below
  // can be shown; full-time uses Full Pay/30 instead (has no bearing here).
  const [contractorAnnualUsd, setContractorAnnualUsd] = useState(0);
  const [contractorFxRate, setContractorFxRate] = useState(93);
  const [contractorCostLoaded, setContractorCostLoaded] = useState(false);
  if (!isFullTime && !contractorCostLoaded) {
    setContractorCostLoaded(true);
    api.get(`/employees/${employee.id}/cost`).then((c: any) => {
      setContractorAnnualUsd(c?.annualUsd || 0);
      setContractorFxRate(c?.fxRate || 93);
    }).catch(() => {});
  }
  // Contractor per-day rate, per explicit business rule: Total CTC ÷ 12 ÷ actual calendar days in
  // the termination month (not a flat 30, unlike the full-time Full-Pay/30 divisor above) × days
  // worked up to the Deployment End Date (a contractor's billing-end date, same as Finance's own
  // termination-approvals form uses) — informational only, always shown in INR.
  const contractorDaysWorkedSalaryInr = () => {
    const d = deploymentEndDate ? new Date(deploymentEndDate + "T00:00:00") : null;
    if (!d || isNaN(+d)) return 0;
    const year = d.getFullYear(), m0 = d.getMonth(), termDay = d.getDate();
    const daysInMonth = new Date(year, m0 + 1, 0).getDate();
    const jd = employee.joiningDate ? new Date(String(employee.joiningDate).slice(0, 10) + "T00:00:00") : null;
    const sameMonthJoin = !!jd && !isNaN(+jd) && jd.getFullYear() === year && jd.getMonth() === m0;
    const startDay = sameMonthJoin ? jd!.getDate() : 1;
    const sameDay = sameMonthJoin && startDay === termDay;
    // payableDaysOverride replaces the auto-derived day count entirely — the per-day rate (still
    // off the Deployment End Date's own calendar month) stays the same either way.
    const worked = payableDaysOverride != null ? payableDaysOverride : (sameDay ? 0 : Math.max(1, termDay - startDay + 1));
    const perDayUsd = daysInMonth ? (contractorAnnualUsd / 12) / daysInMonth : 0;
    return Math.round(perDayUsd * worked * contractorFxRate);
  };

  // BUG FIX: this previously never sent the CURRENT on-screen Basic/Full Pay/Reimbursement back
  // to the server, even though the server route already supports overriding them exactly for
  // this reason (see masters.ts's own comment: "may have already overridden Full Pay in their own
  // form — recalculating off the real CTC record only would ignore that override"). Every call
  // site below (Termination Date, Notice Period Required, Notice Period Served, Notice Served
  // Waiver) was silently resetting Basic and Full Pay back to the original CTC-record values the
  // instant any ONE of those other fields changed, discarding whatever HR had manually typed into
  // Basic/Full Pay moments earlier. Now always passes the current basicSalary/basicOnly/
  // reimbursement state through, so the server only recomputes what's actually supposed to change
  // (EL/Notice Pay/Days-Worked-Salary/TDS) and echoes back the SAME Basic/Full Pay instead of
  // overwriting them — exactly matching Finance's own already-correct recalculate() in
  // TerminationApprovals.tsx.
  const recompute = async (rn: number, sn: number, basicOverride?: number, exitDateOverride?: string, payFullOverride?: boolean) => {
    if (!isFullTime) return;
    try {
      // Only sent once genuinely populated (non-zero) — on the very first call, at component
      // mount, these are all still their initial 0 defaults, and the server treats an explicit
      // "0" as a real override rather than "not set" (it only falls back to the CTC record when
      // the param is missing/empty) — sending 0 here would zero out Basic/Full Pay on first load
      // instead of showing the real CTC-derived figures.
      const qs = new URLSearchParams({
        requiredNoticeDays: String(rn), servedNoticeDays: String(sn),
        exitDate: exitDateOverride ?? exitDate, payFullNoticePeriod: String(payFullOverride ?? payFullNoticePeriod),
      });
      const basicSalaryVal = basicOverride ?? basicSalary;
      if (basicSalaryVal) qs.set("basicSalary", String(basicSalaryVal));
      if (basicOnly) qs.set("basicOnly", String(basicOnly));
      if (reimbursement) qs.set("reimbursementAmount", String(reimbursement));
      const s: any = await api.get(`/employees/${employee.id}/termination-fnf-suggestion?${qs}`);
      if (!s.isFullTime) return;
      setBasicCurrency(s.basicCurrency);
      setBasicSalary(basicOverride ?? s.basicSalary);
      setBasicOnly(s.basicOnly || 0);
      setElDays(s.elEncashmentDays); setElAmount(s.elEncashmentAmount); setNoticePay(s.noticePayAmount);
      setElRatePerDay(s.elEncashmentRatePerDay || 0);
      setDaysWorkedSalary(s.daysWorkedSalary || 0);
    } catch { /* best-effort default — HR can still fill everything in manually */ }
  };
  const setElDaysAndRecalc = (days: number) => { setElDays(days); setElAmount(Math.round(days * elRatePerDay * 100) / 100); };
  const setExitDateAndRecalc = (v: string) => { setExitDate(v); recompute(requiredNoticeDays, servedNoticeDays, undefined, v); };
  if (!loaded) { setLoaded(true); recompute(noticePeriodDays, 0); }

  const submit = async () => {
    setBusy(true);
    try {
      const body: any = { exitDate, resignationDate: resignationDate || undefined, fnfFinalizationDate, emailTerminated };
      if (isFullTime) Object.assign(body, {
        requiredNoticeDays, servedNoticeDays, payFullNoticePeriod, basicSalary, basicOnly,
        elEncashmentDays: elDays, elEncashmentAmount: elAmount, noticePayAmount: noticePay, reimbursementAmount: reimbursement,
        daysWorkedSalary,
        deploymentEndDate: deploymentEndDate || undefined, noBenchMovement,
      });
      else Object.assign(body, {
        deploymentEndDate,
        fnfPrintDate: fnfPrintDate || undefined,
        payableDaysOverride: payableDaysOverride ?? undefined,
        leavesCount: leavesCount ?? undefined,
        includeGst,
        arrearAmount: arrearAmount ?? undefined,
        finalFnfAmount: daysWorkedSalaryOverride != null
          ? Math.round((daysWorkedSalaryOverride / (contractorFxRate || 93)) * 100) / 100
          : undefined,
      });
      const r: any = await api.post(`/employees/${employee.id}/request-termination`, body);
      show(r.terminatedImmediately
        ? `${employee.name} terminated and removed from the system — no Finance approval or FnF settlement needed for an intern.`
        : `Termination requested for ${employee.name}${r.notified > 0 ? ` — notified ${r.notified} of ${r.totalRecipients} approver(s)` : " — submitted for Finance approval"}`);
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Preview the FnF Settlement document with whatever's currently on screen — nothing is saved
  // yet (no request exists until Submit), so every field goes as a query param straight to the
  // employee-keyed preview route instead of the request-id-keyed one Finance uses later.
  const previewFnf = () => {
    const qs = new URLSearchParams({ exitDate, resignationDate: resignationDate || "", fnfFinalizationDate: fnfFinalizationDate || "", deploymentEndDate: deploymentEndDate || "" });
    if (isFullTime) {
      qs.set("requiredNoticeDays", String(requiredNoticeDays)); qs.set("servedNoticeDays", String(servedNoticeDays));
      qs.set("basicSalary", String(basicSalary)); qs.set("payFullNoticePeriod", String(payFullNoticePeriod));
      qs.set("basicOnly", String(basicOnly)); qs.set("reimbursementAmount", String(reimbursement));
      qs.set("elEncashmentDays", String(elDays)); qs.set("elEncashmentAmount", String(elAmount));
      qs.set("noticePayAmount", String(noticePay)); qs.set("daysWorkedSalary", String(daysWorkedSalary));
    } else {
      if (fnfPrintDate) qs.set("fnfPrintDate", fnfPrintDate);
      if (payableDaysOverride != null) qs.set("payableDaysOverride", String(payableDaysOverride));
      if (leavesCount != null) qs.set("leavesCount", String(leavesCount));
      qs.set("includeGst", String(includeGst));
      if (arrearAmount != null) qs.set("arrearAmount", String(arrearAmount));
      // Finance determines the real FNF Amount later from billing/invoice — this form never
      // collects one — but previewing with a hard 0 for Gross Payable/GST/TDS/Grand Total made the
      // whole document look broken rather than "not yet finalized". Seed it with the one real
      // estimate already on screen (Salary for Days Worked This Month, converted back to USD —
      // buildFnfPdfData expects finalFnfAmount in USD and multiplies by fxRate itself) so the
      // preview shows a sensible number; Finance's own screen still starts fresh/independent of it.
      const salaryInr = daysWorkedSalaryOverride ?? contractorDaysWorkedSalaryInr();
      qs.set("finalFnfAmount", String(Math.round((salaryInr / (contractorFxRate || 93)) * 100) / 100));
    }
    window.open(api.pdfUrl(`/employees/${employee.id}/fnf-request-preview.pdf?${qs.toString()}`), "_blank");
  };

  // Intern: no Finance approval, no FnF settlement at all — removed from the system directly as of
  // the Termination Date HR specifies (server short-circuits straight to terminateEmployee(), see
  // masters.ts's request-termination route). A completely separate, simpler form instead of
  // threading a third branch through every field below.
  if (employee.empType === "INTERN") {
    return (
      <Panel title={`Terminate Intern — ${employee.name}`}>
        <div className="note">Interns need no Finance approval and no FnF settlement — this removes {employee.name} from the system immediately as of the Termination Date below.</div>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label="Termination Date" required type="date" value={exitDate} onChange={(e: any) => setExitDate(e.target.value)} />
        </div>
        <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <input type="checkbox" checked={emailTerminated} onChange={(e) => setEmailTerminated(e.target.checked)} />
          Email Terminated — {employee.name}'s Office 365 account has already been disabled
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <AddButton disabled={busy || !exitDate} onClick={submit}>Terminate {employee.name}</AddButton>
          <GhostButton disabled={busy} onClick={onDone}>Cancel</GhostButton>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={`Termination — ${employee.name}`}>
      <div className="form-grid">
        <Field label="Resignation Date" type="date" value={resignationDate} onChange={(e: any) => setResignationDateAndRecalc(e.target.value)} />
        <Field label="FNF Finalization Date" required type="date" value={fnfFinalizationDate} onChange={(e: any) => setFnfFinalizationDate(e.target.value)} />
        <Field label="Termination Date" required type="date" value={exitDate} onChange={(e: any) => setExitDateAndRecalc(e.target.value)} />
        <Field label={deploymentEndRequired ? "Deployment End Date" : "Deployment End Date (optional)"} required={deploymentEndRequired} type="date" value={deploymentEndDate}
          placeholder={!deploymentEndRequired ? "Only if the project ends before the termination date" : undefined}
          onChange={(e: any) => setDeploymentEndDate(e.target.value)} />
      </div>
      {isFullTime && deploymentEndDate && (
        <>
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <input type="checkbox" checked={noBenchMovement} onChange={(e) => setNoBenchMovement(e.target.checked)} />
            No Bench Movement — remove {employee.name} from Monthly Forecast at the Deployment End Date instead of moving them to Bench
          </label>
          <div className="note" style={{ marginTop: 4 }}>
            {noBenchMovement
              ? <>{employee.name} will be removed from Monthly Forecast entirely from {fmtDate(deploymentEndDate + "T00:00:00")} once Finance approves the Deployment End Date — same as a contractor.</>
              : <>{employee.name} will sit on Bench from {fmtDate(deploymentEndDate + "T00:00:00")} through the Termination Date once Finance approves the Deployment End Date.</>}
          </div>
        </>
      )}
      <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input type="checkbox" checked={emailTerminated} onChange={(e) => setEmailTerminated(e.target.checked)} />
        Email Terminated — {employee.name}'s Office 365 account has already been disabled
      </label>
      {!emailTerminated && (
        <div className="note" style={{ marginTop: 4 }}>
          If left unchecked, Finance will get a chance to flip this at final approval — as soon as it's checked (by either of you), Finance/HR/the IT admin get notified to disable the account.
        </div>
      )}
      {isFullTime ? (
        <>
          <div className="note" style={{ marginTop: 8 }}>Full-time employee — specify the notice period; EL encashment, notice pay and reimbursement below feed into FnF. Every value is editable before sending to Finance.</div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label="Notice Period Required (days)" type="number" value={requiredNoticeDays} onChange={(e: any) => { const v = +e.target.value; setRequiredNoticeDays(v); recompute(v, servedNoticeDays); }} />
            <Field label="Notice Period Served (days)" type="number" value={servedNoticeDays} disabled={payFullNoticePeriod}
              title={payFullNoticePeriod ? "Not used while Notice Served Waiver is checked" : undefined}
              onChange={(e: any) => { const v = +e.target.value; setServedNoticeDays(v); recompute(requiredNoticeDays, v); }} />
            <Field label={`Basic (${basicCurrency}) — used for Notice Pay only`} type="number" value={basicOnly} onChange={(e: any) => {
              const basic = +e.target.value; setBasicOnly(basic);
              // Basic drives Notice Pay only — Full Pay (below) drives Days-Worked-Salary instead;
              // the two are deliberately different figures, see the checkbox label's own formula.
              const noticePayDays = payFullNoticePeriod ? requiredNoticeDays : servedNoticeDays;
              setNoticePay(Math.round((basic / 30) * noticePayDays * 100) / 100);
            }} />
            <Field label={`Full Pay (${basicCurrency}) — Basic + HRA + Special/Other Allowance`} type="number" value={basicSalary} onChange={(e: any) => {
              const basic = +e.target.value; setBasicSalary(basic);
              // Full Pay only drives Days-Worked-Salary — Notice Pay always prices off plain Basic
              // (the field above), never Full Pay, so it's deliberately NOT touched here.
              const day = exitDate ? new Date(exitDate + "T00:00:00").getDate() : 0;
              setDaysWorkedSalary(Math.round((basic / 30) * day * 100) / 100);
            }} />
            <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Waives the requirement that notice actually be served — pays the full required notice period instead of pay-for-days-served">
              <input type="checkbox" checked={payFullNoticePeriod} onChange={(e) => { const v = e.target.checked; setPayFullNoticePeriod(v); recompute(requiredNoticeDays, servedNoticeDays, undefined, undefined, v); }} />
              Notice Served Waiver — checked pays Basic/30 × Notice Period Required (ignores days served); unchecked pays Basic/30 × Notice Period Served
            </label>
          </div>
          <div className="note" style={{ marginTop: 4 }}>
            Working: Notice Pay = Basic ({basicCurrency} {basicOnly.toLocaleString()}) ÷ 30 × {payFullNoticePeriod ? requiredNoticeDays : servedNoticeDays} day(s) [{payFullNoticePeriod ? "Notice Period Required — waiver checked" : "Notice Period Served"}] = {basicCurrency} {noticePay.toLocaleString()}. Salary for Days Worked This Month = Full Pay ({basicCurrency} {basicSalary.toLocaleString()}) ÷ 30 = {basicCurrency} {Math.round(basicSalary / 30).toLocaleString()}/day → {basicCurrency} {daysWorkedSalary.toLocaleString()} total.
          </div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label="EL Encashment Days" type="number" value={elDays} onChange={(e: any) => setElDaysAndRecalc(+e.target.value)} />
            <Field label={`EL Encashment Amount (${basicCurrency})`} type="number" value={elAmount} onChange={(e: any) => setElAmount(+e.target.value)} />
            <Field label={`Notice Pay (${basicCurrency})`} type="number" value={noticePay} onChange={(e: any) => setNoticePay(+e.target.value)} />
            <Field label={`Reimbursement (${basicCurrency})`} type="number" value={reimbursement} onChange={(e: any) => setReimbursement(+e.target.value)} />
            <Field label={`Salary for Days Worked This Month (${basicCurrency})`} type="number" value={daysWorkedSalary} onChange={(e: any) => setDaysWorkedSalary(+e.target.value)} />
          </div>
          <div className="subtitle" style={{ margin: "10px 0", background: "var(--panel-2, rgba(127,127,127,.08))", borderRadius: 8, padding: "8px 12px" }}>
            Suggested FnF add-ons: EL encashment <b>{elAmount.toLocaleString()}</b> + Notice pay <b>{noticePay.toLocaleString()}</b> + Reimbursement <b>{reimbursement.toLocaleString()}</b> + Days worked this month <b>{daysWorkedSalary.toLocaleString()}</b> = <b>{(elAmount + noticePay + reimbursement + daysWorkedSalary).toLocaleString()}</b> {basicCurrency}. Finance confirms the final FnF amount at approval.
          </div>
        </>
      ) : (
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label="Salary for Days Worked This Month (INR)" type="number"
            value={daysWorkedSalaryOverride ?? contractorDaysWorkedSalaryInr()}
            onChange={(e: any) => setDaysWorkedSalaryOverride(e.target.value === "" ? null : +e.target.value)}
            title="Total CTC ÷ 12 ÷ days in the termination month × days worked (Deployment End Date, or Number of Days Worked below if set) — editable: overriding this becomes the starting FNF Amount Finance's approval panel loads." />
          <Field label="Number of Days Worked (overrides the days used above)" type="number" value={payableDaysOverride ?? ""} onChange={(e: any) => setPayableDaysOverride(e.target.value === "" ? null : +e.target.value)} />
          <Field label="Number of Leaves (printed on FnF document, if given)" type="number" value={leavesCount ?? ""} onChange={(e: any) => setLeavesCount(e.target.value === "" ? null : +e.target.value)} />
          <Field label="Arrear — Previous Month (INR, if owed)" type="number" value={arrearAmount ?? ""} onChange={(e: any) => setArrearAmount(e.target.value === "" ? null : +e.target.value)} />
          <div className="note full">Contractor/vendor — no Basic salary or notice period needed. Finance computes FnF from billing/invoice prorated to the Deployment End Date above.</div>
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Not every contractor is GST-registered — uncheck if this settlement shouldn't add GST on the FnF document">
            <input type="checkbox" checked={includeGst} onChange={(e) => setIncludeGst(e.target.checked)} />
            Include GST @ 18% on the FnF document
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Field label="Last Day of Working (printed on FnF document)" type="date" value={fnfPrintDate} onChange={(e: any) => setFnfPrintDate(e.target.value)} /></div>
            <GhostButton onClick={() => setFnfPrintDate(deploymentEndDate)} title="Copies Deployment End Date into this field">↺ Use Deployment End Date</GhostButton>
          </div>
          <div className="note full" style={{ marginTop: -4 }}>
            "Last Day of Working" prints as-is above regardless. "Number of Days Worked" also changes the printed "No. of Days Worked" count on the FnF document (to match the Salary figure), but never any other calculation. Finance can still review/override any of these at approval.
          </div>
        </div>
      )}
      <div className="note" style={{ marginTop: 8 }}>This only submits the request — Finance/CTO/CEO will review the full termination details and approve before anything changes on {employee.name}'s record.</div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <GhostButton disabled={busy} title="Preview the FnF Settlement document with the numbers currently on screen — nothing is saved yet" onClick={previewFnf}>Preview FnF PDF</GhostButton>
        <AddButton disabled={busy || !exitDate || !fnfFinalizationDate || (deploymentEndRequired && !deploymentEndDate)} onClick={submit}>Terminate and Notify Finance</AddButton>
        <GhostButton disabled={busy} onClick={onDone}>Cancel</GhostButton>
      </div>
    </Panel>
  );
}

// =====================================================================================
// Confirm Joining — Employee Activation: its own HR-module page (previously only reachable
// by opening a specific offer's full lifecycle detail). Lists every candidate ready to be
// activated — Employee offers with an issued Appointment Letter, Contractor offers with a
// generated Service Agreement — and lets HR fill in the same activation form (project,
// deployment window, billable) right here. The full Offer Lifecycle screen (OfferDetail)
// still shows this same panel in context, unchanged — this page is an additional, faster
// entry point onto the identical /confirm-joining action, not a replacement.
// =====================================================================================
export function ConfirmJoiningQueue() {
  const { data: offers, reload } = useFetch<any[]>("/hr/offers");
  // Live — HR sitting on this queue sees "Confirmation Pending" flip to "Ready to Activate" (or
  // "Declined") the instant a candidate signs/declines, no manual refresh needed.
  useEffect(() => watchRoom("esign:activity", "esign:activity", reload), []);
  const { data: projects } = useFetch<any[]>("/hr/projects");
  const { show } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  // employeeActivationReady comes from the workflow engine (server) — Appointment no longer has to
  // be Issued first now that it can be configured to run AFTER Employee Activation (the default
  // order). `=== true` (not just truthy) so a null (no workflow pinned yet — pre-engine offers)
  // falls back to the original fixed rule below instead of silently hiding the row.
  const ready = (offers || []).filter((o) => !o.employeeId && (
    usesServiceAgreement(o.employmentType) ? o.status === "ACCEPTED" && o.serviceAgreement
      : o.employeeActivationReady === true || (o.employeeActivationReady == null && o.status === "APPOINTMENT_ISSUED")
  ));
  const selected = ready.find((o) => o.id === selectedId) || ready[0] || null;
  const readyIds = ready.map((o) => o.id);
  const toggleAll = () => setChecked(checked.size === readyIds.length ? new Set() : new Set(readyIds));
  const toggleOne = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(checked);
    next.has(id) ? next.delete(id) : next.add(id);
    setChecked(next);
  };
  const deleteChosen = async (ids: number[], label: string) => {
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} ${label}? This removes the candidate's offer entirely and cannot be undone.`)) return;
    setBusy(true);
    try {
      const r: any = await api.post("/hr/offers/bulk-delete", { ids });
      show(`Deleted ${r.deleted} offer(s)${r.skipped ? `; skipped ${r.skipped} (already active)` : ""}`);
      setChecked(new Set()); setSelectedId(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div>
      <h1>Onboarding Activation</h1>
      <div className="subtitle">Candidates whose Appointment Letter has been issued (or, for Contractors, whose Service Agreement has been generated) — ready to be activated as a live Employee / Contractor.</div>
      <div className="btn-row">
        {checked.size > 0 && <GhostButton disabled={busy} onClick={() => deleteChosen(Array.from(checked), "selected candidate(s)")}>Delete Selected ({checked.size})</GhostButton>}
        {readyIds.length > 0 && <GhostButton disabled={busy} onClick={() => deleteChosen(readyIds, "candidate(s) in this queue")}>Delete All ({readyIds.length})</GhostButton>}
      </div>
      <div style={{ marginTop: 12 }}>
        <Panel title={`Awaiting Activation (${ready.length})`}>
          {ready.length === 0 && <div style={{ color: "var(--muted)" }}>Nothing waiting — every issued offer/agreement has already been activated.</div>}
          {ready.length > 0 && (
            <table><thead><tr>
              <th>
                <input type="checkbox" checked={checked.size > 0 && checked.size === readyIds.length}
                  ref={(el) => { if (el) el.indeterminate = checked.size > 0 && checked.size < readyIds.length; }}
                  onChange={toggleAll} title={checked.size ? "Clear selection" : "Select all"} />
              </th>
              <th>Candidate</th><th>Type</th><th>Role</th><th>ID</th><th>Status</th><th></th>
            </tr></thead>
              <tbody>
                {ready.map((o) => {
                  const acceptance = usesServiceAgreement(o.employmentType) ? o.serviceAgreementAcceptance : o.appointmentAcceptance;
                  const acceptedReady = acceptance?.status === "ACCEPTED";
                  return (
                    <tr key={o.id} style={{ cursor: "pointer", background: selected?.id === o.id ? "var(--panel2)" : undefined }} onClick={() => setSelectedId(o.id)}>
                      <td><input type="checkbox" checked={checked.has(o.id)} onChange={() => {}} onClick={(e) => toggleOne(o.id, e)} /></td>
                      <td>{o.candidateName}</td>
                      <td><EmploymentTypePill t={o.employmentType || "EMPLOYEE"} /></td>
                      <td>{o.role}</td>
                      <td style={{ color: "var(--muted)" }}>{o.reservedEmpNo} <span className="pill">hidden</span></td>
                      <td>
                        {acceptedReady
                          ? <span className="pill good">Ready to Activate</span>
                          : acceptance?.status === "DECLINED"
                            ? <span className="pill bad">Declined</span>
                            : <span className="pill warn">Confirmation Pending</span>}
                        {/* Finance already bounced this one back once — a re-submission still
                            shows "Ready to Activate" above (correctly), but without this HR could
                            easily miss that it's a retry, not a first-time confirm. */}
                        {o.ctcRejectedAt && <span className="pill bad" style={{ marginLeft: 4 }} title={o.ctcRejectionNote || "CTC rejected by Finance"}>Previously CTC Rejected</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <GhostButton onClick={(e: any) => { e.stopPropagation(); window.open(api.pdfUrl(`/hr/offers/${o.id}/pdf`), "_blank"); }}>View Offer</GhostButton>
                        {/* Only present when Appointment is configured to run before Employee
                            Activation (HR-reordered from the Workflow Builder) — the default
                            order generates it AFTER activation, so there's nothing to view yet. */}
                        {o.appointmentLetter && <GhostButton onClick={(e: any) => { e.stopPropagation(); window.open(api.pdfUrl(`/hr/offers/${o.id}/appointment/pdf`), "_blank"); }}>View Appointment</GhostButton>}
                        <GhostButton onClick={(e: any) => { e.stopPropagation(); navigate(`/hr/offers/${o.id}`); }}>Open full offer →</GhostButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
        {selected ? (
          <ConfirmJoiningPanel key={selected.id} offer={selected} projects={projects || []} busy={busy} setBusy={setBusy}
            contractor={usesServiceAgreement(selected.employmentType)} onReload={reload} onDone={() => { setSelectedId(null); reload(); }} />
        ) : (
          <Panel title="Confirm Joining" style={{ marginTop: 14 }}><div style={{ color: "var(--muted)" }}>Select a candidate above.</div></Panel>
        )}
      </div>
    </div>
  );
}

// Generic capture form for HR-defined Custom Fields on any one stage (added purely from the
// Workflow Builder, no code change) — renders whatever fields are configured for `stageKey`, in
// whatever type (text/number/date), and saves them into Offer.customFields. Renders nothing if
// the stage has no custom fields, so it's safe to mount unconditionally for every stage.
function CustomFieldsPanel({ offerId, stageKey, stageName }: { offerId: number; stageKey: string; stageName: string }) {
  const { data: fields, reload } = useFetch<any[]>(`/hr/offers/${offerId}/custom-fields/${stageKey}`);
  const { show } = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (fields && !touched) {
      const init: Record<string, string> = {};
      fields.forEach((f: any) => { init[f.key] = f.value ?? ""; });
      setValues(init);
    }
  }, [fields, touched]);
  if (!fields || fields.length === 0) return null;
  const set = (key: string) => (e: any) => { setTouched(true); setValues((v) => ({ ...v, [key]: e.target.value })); };
  const save = async () => {
    setBusy(true);
    try { await api.post(`/hr/offers/${offerId}/custom-fields/${stageKey}`, { values }); show("Saved"); setTouched(false); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Panel title={stageName} style={{ marginTop: 14 }}>
      <div className="form-grid">
        {fields.map((f: any) => (
          <Field key={f.key} label={f.label} required={f.mandatory}
            type={f.fieldType === "date" ? "date" : f.fieldType === "number" ? "number" : "text"}
            value={values[f.key] ?? ""} onChange={set(f.key)} />
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <AddButton disabled={busy} onClick={save}>Save</AddButton>
      </div>
    </Panel>
  );
}

// Mandatory Document Collection (Sections 14-19) — two ways to collect each document, either or
// both usable on the same offer: (1) email the candidate a secure self-serve upload link, or
// (2) HR uploads the document directly (handed over in person/another channel) — HR's own uploads
// are self-verified immediately. Either way, HR can move on to the next stage whenever they decide
// ("Move to Next Stage"), independent of whether every document is individually verified — that's
// a manual override, not a requirement. Shown on an EMPLOYEE offer once Accepted; which exact
// required documents apply (Aadhaar always excluded, PAN skipped if already captured) is resolved
// server-side from the published workflow (engine/workflow.ts resolveRequiredDocuments).
const DOC_STATUS_LABEL: Record<string, string> = { PENDING: "Not uploaded", UPLOADED: "Uploaded", SUBMITTED: "Submitted", VERIFIED: "Verified", REJECTED: "Rejected" };
const DOC_STATUS_CLASS: Record<string, string> = { PENDING: "", UPLOADED: "warn", SUBMITTED: "good", VERIFIED: "good", REJECTED: "bad" };
const PREVIEWABLE_EXT = new Set(["pdf", "png", "jpg", "jpeg"]);
function DocumentCollectionPanel({ offerId }: { offerId: number }) {
  const { data: request, reload } = useFetch<any>(`/hr/offers/${offerId}/document-collection`);
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const [uploadingDocType, setUploadingDocType] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  useEffect(() => watchRoom(`esign:OFFER:${offerId}`, "esign:update", reload), [offerId]);

  const send = async () => {
    setBusy(true);
    try {
      const r: any = await api.post(`/hr/offers/${offerId}/document-collection/send`, {});
      show(r.emailSent ? "Document collection request emailed to the candidate" : `Not emailed — ${r.emailReason || "see audit trail"}`, r.emailSent ? undefined : "error");
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const verify = async (candidateDocumentId: number, action: "VERIFY" | "REJECT") => {
    const note = action === "REJECT" ? window.prompt("Reason for rejection (shown to the candidate):") : undefined;
    if (action === "REJECT" && note === null) return;
    setVerifyingId(candidateDocumentId);
    try { await api.post(`/hr/offers/${offerId}/document-collection/verify`, { candidateDocumentId, action, note }); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setVerifyingId(null); }
  };
  const uploadManually = async (docType: string, file: File) => {
    setUploadingDocType(docType);
    try {
      const fileData = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      await api.post(`/hr/offers/${offerId}/document-collection/upload`, { docType, fileName: file.name, fileData });
      show("Document uploaded"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setUploadingDocType(null); }
  };
  const complete = async () => {
    if (!window.confirm("Move to the next stage now?")) return;
    setBusy(true);
    try { await api.post(`/hr/offers/${offerId}/document-collection/complete`, {}); show("Moved to next stage"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Section 5.3 — HR may reject several documents across a few Verify/Reject clicks before
  // sending one consolidated notice, rather than an email per rejection.
  const notifyRejections = async () => {
    setBusy(true);
    try {
      const r: any = await api.post(`/hr/offers/${offerId}/document-collection/notify-rejections`, {});
      show(r.emailSent ? `Notified the candidate — ${r.rejectedCount} document(s) need re-upload` : `Not emailed — ${r.emailReason || "see audit trail"}`, r.emailSent ? undefined : "error");
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  if (!request) return null;
  return (
    <Panel title="Mandatory Document Collection" style={{ marginTop: 14 }}>
      <div className="subtitle" style={{ marginTop: 0 }}>
        {request.sentAt ? `Email link sent ${fmtDateTime(request.sentAt)} — ` : ""}
        HR can also upload any document directly below, without waiting on the candidate.
        {request.completedAt && ` · Moved to next stage ${fmtDateTime(request.completedAt)}.`}
      </div>
      <table><thead><tr><th>Document</th><th>Status</th><th>Files</th><th /></tr></thead>
        <tbody>{(request.documents || []).map((d: any) => (
          <tr key={d.id}>
            <td>
              {d.label}{d.required === false && <span style={{ color: "var(--muted)" }}> (optional)</span>}
              {d.status === "REJECTED" && d.rejectionNote && <div style={{ fontSize: 11, color: "var(--bad)" }}>Reason: {d.rejectionNote}</div>}
              {d.status === "VERIFIED" && d.verifiedAt && <div style={{ fontSize: 11, color: "var(--muted)" }}>By {d.verifiedById ? "HR" : "Candidate"} · {fmtDate(d.verifiedAt)}</div>}
            </td>
            <td><span className={`pill ${DOC_STATUS_CLASS[d.status]}`}>{DOC_STATUS_LABEL[d.status] || d.status}</span></td>
            <td>
              {(Array.isArray(d.files) ? d.files : []).map((f: any, i: number) => {
                const url = api.pdfUrl(`/hr/offers/${offerId}/document-collection/file/${d.docType}/${i}`);
                return (
                  <div key={i}>
                    {/* Always opens the in-app popup — never a new tab/download-on-click. A file
                        type the browser can't render inline (e.g. .docx/.xlsx) still opens the
                        popup, it just shows a "no preview" fallback + an explicit Download button
                        inside it, instead of silently downloading the moment the name is clicked. */}
                    <GhostButton onClick={() => setPreview({ url, fileName: f.fileName })}>{f.fileName}</GhostButton>
                  </div>
                );
              })}
              {!(Array.isArray(d.files) && d.files.length) && <span style={{ color: "var(--muted)" }}>—</span>}
            </td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {d.status === "SUBMITTED" && (
                <>
                  <GhostButton icon={verifyingId === d.id ? <span className="spinner" /> : <CheckCircleRoundedIcon />} disabled={verifyingId === d.id} onClick={() => verify(d.id, "VERIFY")}>{verifyingId === d.id ? "Verifying…" : "Verify"}</GhostButton>
                  <GhostButton icon={<ReplayRoundedIcon />} disabled={verifyingId === d.id} onClick={() => verify(d.id, "REJECT")}>Request Re-upload</GhostButton>
                </>
              )}
              <label className="ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px" }}>
                <UploadFileRoundedIcon sx={{ fontSize: 16 }} /> {uploadingDocType === d.docType ? "Uploading…" : d.multipleFiles ? "HR Upload +" : "HR Upload"}
                <input type="file" style={{ display: "none" }} disabled={uploadingDocType === d.docType}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadManually(d.docType, f); e.target.value = ""; }} />
              </label>
            </td>
          </tr>
        ))}</tbody>
      </table>
      {(() => {
        // Move to Next Stage now requires every REQUIRED document individually VERIFIED (not just
        // uploaded) — HR request. Optional documents (e.g. Contractor's Salary Slips) never block.
        // This makes the button mostly a visible-progress indicator, since
        // maybeAutoCompleteDocumentCollection (server) already auto-advances the instant the last
        // required document is verified; this stays as the explicit manual trigger/confirmation.
        const pending = (request.documents || []).filter((d: any) => d.required !== false && d.status !== "VERIFIED");
        const rejectedCount = (request.documents || []).filter((d: any) => d.status === "REJECTED").length;
        return (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <GhostButton icon={<SendRoundedIcon />} disabled={busy} onClick={send}>{request.sentAt ? "Resend Email Link" : "Send Document Collection Request"}</GhostButton>
            {rejectedCount > 0 && <GhostButton icon={<ReplayRoundedIcon />} disabled={busy} onClick={notifyRejections}>Notify Candidate ({rejectedCount} rejected)</GhostButton>}
            {!request.completedAt && (
              <AddButton icon={<ArrowForwardRoundedIcon />} disabled={busy || pending.length > 0}
                title={pending.length ? `Waiting on verification: ${pending.map((d: any) => d.label).join(", ")}` : undefined}
                onClick={complete}>Move to Next Stage</AddButton>
            )}
            {!request.completedAt && pending.length > 0 && <span className="subtitle" style={{ margin: 0 }}>Verify every document before moving on.</span>}
          </div>
        );
      })()}
      <Modal title={preview?.fileName || "Preview"} open={!!preview} onClose={() => setPreview(null)}>
        {preview && (() => {
          const ext = (preview.fileName || "").split(".").pop()?.toLowerCase() || "";
          if (ext === "pdf") return <iframe title={preview.fileName} src={preview.url} style={{ width: "100%", height: "70vh", border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />;
          if (PREVIEWABLE_EXT.has(ext)) return <img src={preview.url} alt={preview.fileName} style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto", borderRadius: 8 }} />;
          return (
            <div style={{ textAlign: "center", padding: "30px 10px" }}>
              <div className="subtitle" style={{ margin: "0 0 14px" }}>No inline preview available for this file type ({ext ? `.${ext}` : "unknown"}).</div>
              <AddButton onClick={() => { const a = document.createElement("a"); a.href = preview.url; a.download = preview.fileName; document.body.appendChild(a); a.click(); document.body.removeChild(a); }}>Download {preview.fileName}</AddButton>
            </div>
          );
        })()}
      </Modal>
    </Panel>
  );
}

// =====================================================================================
// Offer Detail — one adaptive screen covering Preview/Send, Acceptance, Appointment
// Letter (generate/preview/issue) and Confirm Joining, driven by the offer's status.
// =====================================================================================
export function OfferDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const masked = useMaskNumbers(user?.id);
  const { data: offer, reload } = useFetch<any>(`/hr/offers/${id}`);
  const { data: projects } = useFetch<any[]>("/hr/projects");
  const { data: offerEsign, reload: reloadOfferEsign } = useFetch<any>(`/adobe-sign/status/OFFER/${id}`);
  // A Contractor has no separate Offer Letter — the Service Agreement IS the "sent" document, so
  // its e-signature status (not OFFER's, which never applies to a Contractor) is what determines
  // whether "Record Candidate Acceptance" is still a manual email-flow step or already handled.
  const { data: saEsignForOffer, reload: reloadSaEsignForOffer } = useFetch<any>(`/adobe-sign/status/SERVICE_AGREEMENT/${id}`);
  // Which Generate-Offer fields are even shown/required — config-driven (HR Settings -> Workflow &
  // Stage Configuration), so this page enforces exactly what's configured, not a fixed rule.
  // Employee and Contractor are separate templates now — scope by this offer's own employment type.
  const { data: fieldConfig } = useFetch<any[]>(`/hr/offer-field-config?employmentType=${offer?.employmentType || "EMPLOYEE"}&countryCode=${offer?.countryCode || ""}`, [offer?.employmentType, offer?.countryCode]);
  const fieldCfg = (key: string) => (fieldConfig || []).find((f) => f.key === key);
  // The offer's actual position in the CONFIGURED workflow (HR Settings -> Workflow & Stage
  // Configuration) — order/unlocked per stage, in configured order. Drives which of the
  // movable middle-section panels (Document Collection / Confirm Joining-Activation / Appointment)
  // render, and in what order, instead of a fixed DOM sequence.
  const { data: stageStatus, reload: reloadStageStatus } = useFetch<any[]>(`/hr/offers/${id}/stage-status`);
  // US/Canada's simplified 3-stage pipeline uses its own stageTypes for the exact same real
  // forms/panels as India's (CAPTURE_INFORMATION == Candidate Info/Generate Offer,
  // ONBOARDING_ACTIVATION == Confirm Joining/Employee Activation — see engine/workflow.ts's own
  // STAGE_TYPE_ALIASES). Every lookup below goes through stageByType, so aliasing it here once
  // fixes every call site — without this, a US/Canada offer could generate fine (Stage 1) but then
  // show a permanently blank Stage 3, since activationStage could never resolve.
  const STAGE_TYPE_ALIASES: Record<string, string[]> = { EMPLOYEE_ACTIVATION: ["ONBOARDING_ACTIVATION"], OFFER_GENERATION: ["CAPTURE_INFORMATION"] };
  const stageByType = (t: string) => (stageStatus || []).find((s: any) => s.stageType === t || (STAGE_TYPE_ALIASES[t] || []).includes(s.stageType));
  // Single-page wizard state — which configured stage's content is showing right now. Defaults to
  // whatever the engine says is "current" for this offer; HR can click any stage's tab to look at
  // (or, once unlocked, act on) it, exactly mirroring Workflow & Stage Configuration's own 7 stages.
  // Declared here (above the socket effect below) so that effect can read/clear it live.
  const [activeStep, setActiveStep] = useState<string | null>(null);
  // Escape hatch for "sent for e-signature but the candidate can't/won't complete Adobe Sign
  // digitally" (e.g. they emailed back a signed copy instead) — normally signing IS acceptance
  // with no manual step, but HR needs a way to record it by hand when that digital flow stalls.
  const [manualAcceptOverride, setManualAcceptOverride] = useState(false);
  // Live — the whole page (lifecycle stepper, acceptance badges, Confirm Joining gating) refreshes
  // the instant ANY of this offer's three documents is signed/declined, not just the EsignPanel
  // widget that already does its own live update — otherwise everything else here goes stale
  // until a manual reload.
  useEffect(() => {
    const onUpdate = (payload: any) => {
      reload(); reloadOfferEsign(); reloadSaEsignForOffer(); reloadStageStatus();
      // If the stage HR is currently pinned to (via an earlier tab/Next/Back click — activeStep
      // sticks once set, see below) is the one that just completed, snap the view forward to
      // whatever the engine now says is current instead of staying stuck on a finished stage —
      // this was the "need to refresh the page to see the next stage" bug.
      if (payload?.stageCompleted && payload.stageCompleted === activeStep) setActiveStep(null);
    };
    const cleanups = ["OFFER", "APPOINTMENT_LETTER", "SERVICE_AGREEMENT"].map((docType) =>
      watchRoom(`esign:${docType}:${id}`, "esign:update", onUpdate)
    );
    return () => cleanups.forEach((c) => c());
  }, [id, activeStep]);
  const { show } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [regenerateAppt, setRegenerateAppt] = useState(false);
  const [regenerateSa, setRegenerateSa] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [aadhaarBusy, setAadhaarBusy] = useState(false);
  const [aadhaarInput, setAadhaarInput] = useState("");
  const [aadhaarFile, setAadhaarFile] = useState<File | null>(null);
  const [panBusy, setPanBusy] = useState(false);
  const [panInput, setPanInput] = useState("");
  // Audit Trail is meta-information about the offer, not part of any one stage — collapsed behind
  // an icon by default instead of permanently taking up space under every single stage view.
  const [showAuditTrail, setShowAuditTrail] = useState(false);

  if (!offer) return <div>Loading…</div>;
  const isContractor = usesServiceAgreement(offer.employmentType);
  // Wizard step list — every enabled configured stage, in configured order (Contractor skips the
  // two stages it structurally has no document/letter for). effectiveStep is what's actually
  // showing right now: HR's own click, or (by default) whatever the engine says is current.
  // Intern's IT Provisioning and Confirm Joining/Activation show together under ONE tab (the
  // Activation stage's) instead of two separate clickable stages — IT Provisioning's own tab is
  // hidden from the sidebar here; its panel still renders, just folded into Activation's content
  // below (see itBlock/activationBlock/items). Employee/Contractor are untouched.
  //
  // Candidate Information's own tab is hidden the same way — it and Generate Internship Letter &
  // e-Sign (stage1Key below) already rendered the IDENTICAL combined content under either tab
  // (see the effectiveStep check further down), so having both as separate clickable stages just
  // meant Stage 2 never visibly showed anything of its own: clicking it looked exactly like Stage
  // 1, and the manual-confirm / e-sign acceptance UI that actually lives in that shared content
  // block was easy to miss entirely — HR reported acceptance always seeming to happen "on Stage 1"
  // with Stage 2 never doing anything, then jumping straight to Stage 3.
  const isIntern = offer.employmentType === "INTERN";
  // US/Canada direct-hire Employee (no vendor): Stage 2 (Agreement & Signature) has no MSA/SOW to
  // sign and auto-completes the instant Stage 1 is sent (see hrOffers.ts's /offers/:id/send and
  // engine/workflow.ts's CAPTURE_INFORMATION override) — it never shows any content and is never
  // actually "current" for more than an instant, so showing it as its own step just confused HR
  // ("Stage 2 already green, still on Stage 1?"). Hidden from the stepper ONLY for that path —
  // Corp-to-Corp genuinely signs an MSA/SOW there, so it keeps all 3 steps. The underlying
  // WorkflowStage (and the Workflow Builder's own view of it) is untouched either way — this is
  // purely which steps the wizard's own stepper counts/shows for THIS offer.
  const hideAgreementSignature = offer.countryCode && offer.countryCode !== "INDIA" && !offer.vendorName;
  const orderedStages = (stageStatus || []).filter((s: any) =>
    (!isContractor || !["APPOINTMENT_GENERATION", "APPOINTMENT_ACCEPTANCE"].includes(s.stageType))
    && !(isIntern && s.stageType === "IT_PROVISIONING")
    && !(isIntern && s.stageType === "CANDIDATE_INFO")
    && !(hideAgreementSignature && s.stageType === "AGREEMENT_SIGNATURE")
  );
  // If the engine's own "current stage" happens to be a now-hidden stage (IT Provisioning or,
  // for Intern, Candidate Information), land on its combined-content sibling tab instead of
  // falling all the way back to Stage 1.
  const currentStageKey = orderedStages.find((s: any) => s.current)?.key
    || (isIntern && stageByType("IT_PROVISIONING")?.current ? stageByType("EMPLOYEE_ACTIVATION")?.key : null)
    || (isIntern && stageByType("CANDIDATE_INFO")?.current ? stageByType("OFFER_GENERATION")?.key : null)
    || orderedStages[0]?.key || null;
  const effectiveStep = activeStep || currentStageKey;
  const effectiveIdx = orderedStages.findIndex((s: any) => s.key === effectiveStep);
  // Prefer an exact OFFER_GENERATION match — Intern's published workflow (unlike Contractor's
  // single combined stage) splits Candidate Information (CANDIDATE_INFO, order 1) and Generate
  // Internship Letter (OFFER_GENERATION, order 3) into two separate stages, and a plain "first
  // match in this array" here would grab CANDIDATE_INFO first, leaving Generate/Send never
  // rendering under its own tab. candidateInfoKey lets that earlier stage show the SAME combined
  // panel too, since there's nothing else configured to render under it on its own.
  const stage1Key = (stageStatus || []).find((s: any) => s.stageType === "OFFER_GENERATION")?.key
    || (stageStatus || []).find((s: any) => ["DATA_COLLECTION", "CANDIDATE_INFO", "CAPTURE_INFORMATION"].includes(s.stageType))?.key || null;
  const candidateInfoKey = (stageStatus || []).find((s: any) => s.stageType === "CANDIDATE_INFO")?.key || null;
  const stage2Key = (stageStatus || []).find((s: any) => s.stageType === "OFFER_ACCEPTANCE")?.key || null;
  const stageAppointmentAcceptedKey = (stageStatus || []).find((s: any) => s.stageType === "APPOINTMENT_ACCEPTANCE")?.key || null;
  const v = offer.activeVersionData;
  const ccy = offer.countryCode === "US" ? "USD" : offer.countryCode === "CANADA" ? "CAD" : "INR";
  const sym = ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹";
  const money = (n: number) => masked ? "•••••" : sym + Math.round(n || 0).toLocaleString("en-IN");
  // Once the offer has actually gone out (Sent onward), it's the active version — no more
  // Recalculate/Regenerate/New Version, only Cancel Offer (still allowed from a closed/terminal
  // status — Declined/Expired/Withdrawn/Cancelled — as HR's restart path).
  const canRegenerateOffer = !["SENT", "ACCEPTED", "APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED", "APPOINTMENT_ISSUED", "JOINING_CONFIRMED"].includes(offer.status);
  // The e-signature status that actually applies to THIS offer's own "sent" document — OFFER for
  // an Employee, SERVICE_AGREEMENT for a Contractor (who never has a separate Offer Letter).
  const relevantOfferEsign = isContractor ? saEsignForOffer : offerEsign;

  const call = async (path: string, body?: any) => {
    setBusy(true);
    try {
      const r = await api.post(`/hr/offers/${id}${path}`, body);
      if (r?.emailSent) show("Done — email sent to candidate");
      else if (r?.emailSent === false) show(`Done — email NOT sent (${r.emailReason || "see audit trail"})`, "error");
      else show("Done");
      reload(); reloadStageStatus(); return r;
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  const uploadResume = async (file: File) => {
    setResumeBusy(true);
    try {
      const fileData = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      await api.post(`/hr/offers/${id}/resume`, { fileName: file.name, fileData });
      show("Resume uploaded"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setResumeBusy(false); }
  };
  const saveAadhaar = async () => {
    if (!offer.aadhaarFileName && !aadhaarFile) return show("Upload the Aadhaar image (front/back) as well as the number", "error");
    setAadhaarBusy(true);
    try {
      const body: any = { aadhaarNumber: aadhaarInput };
      if (aadhaarFile) {
        body.fileName = aadhaarFile.name;
        body.fileData = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] || "");
          r.onerror = reject;
          r.readAsDataURL(aadhaarFile);
        });
      }
      await api.post(`/hr/offers/${id}/aadhaar`, body);
      show("Aadhaar captured"); setAadhaarInput(""); setAadhaarFile(null); reload();
    }
    catch (e: any) { show(e.message, "error"); } finally { setAadhaarBusy(false); }
  };
  const savePan = async () => {
    setPanBusy(true);
    try { await api.post(`/hr/offers/${id}/pan`, { panNumber: panInput }); show("PAN captured"); setPanInput(""); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setPanBusy(false); }
  };

  // Read-only recap of a lifecycle stage the offer has already reached — reused directly by
  // Stage 2's own wizard content below ("Offer Accepted" once past SENT).
  const stageDetail = (stage: string) => {
    const latestAudit = (offer.auditLogs || []).find((a: any) => a.toStatus === stage);
    const when = latestAudit ? fmtDateTime(latestAudit.at) : null;
    const row = (label: string, val: any) => <tr><td>{label}</td><td className="num">{val}</td></tr>;

    switch (stage) {
      case "DRAFT":
        return <table><tbody>
          {row("Candidate", offer.candidateName)}{row("Email", offer.candidateEmail)}{row("Role", offer.role)}{row("Designation", offer.designation)}
          {row("Created", when || "—")}
        </tbody></table>;

      case "GENERATED": case "PREVIEWED":
        return isContractor ? (
          <table><tbody>
            {row("Monthly Compensation", offer.serviceAgreement ? money(offer.serviceAgreement.monthlyCompensation) : "Not yet generated")}
            {offer.serviceAgreement?.dynamicFields?.EffectiveDate && row("Effective Date", fmtDate(offer.serviceAgreement.dynamicFields.EffectiveDate))}
          </tbody></table>
        ) : (
          <table><tbody>
            {row("Version", `v${offer.activeVersion} of ${offer.versions?.length || 1}`)}
            {v && row("Bracket", v.bracketName)}
            {v && row("Total CTC", money(v.salaryBreakup?.totalAnnual))}
            {v && row("Net Monthly", money(v.taxCalc?.netMonthly))}
          </tbody></table>
        );

      case "SENT":
        return <table><tbody>
          {row("Sent To", offer.candidateEmail)}{row("Sent On", offer.sentAt ? fmtDateTime(offer.sentAt) : "—")}
        </tbody></table>;

      case "ACCEPTED": {
        // The signed document itself — captured back into the app either way (Adobe Sign
        // downloads and stores it the moment it's signed; the manual flow is HR's own upload) —
        // was previously only linkable from the Onboarding History table, nowhere on the offer's
        // own Stage 1/2 acceptance view. HR jumping straight from Stage 1 to Stage 3 (Confirm
        // Joining/Activation) on an e-signed Intern/Contractor had no way to actually open and
        // verify what was signed before activating them.
        const signedUrl = offer.acceptanceMethod === "ADOBE_SIGN"
          ? api.pdfUrl(`/adobe-sign/signed/${isContractor ? "SERVICE_AGREEMENT" : "OFFER"}/${id}`)
          : (isContractor ? offer.serviceAgreement?.signedFileName : offer.signedOfferFileName)
            ? api.pdfUrl(isContractor ? `/hr/offers/${id}/service-agreement/signed` : `/hr/offers/${id}/signed-offer`)
            : null;
        return <table><tbody>
          {row("Method", offer.acceptanceMethod ? offer.acceptanceMethod.replace(/_/g, " ").toLowerCase() : "—")}
          {row("Accepted On", offer.acceptedAt ? fmtDateTime(offer.acceptedAt) : "—")}
          {offer.acceptanceNote && row("Note", offer.acceptanceNote)}
          {signedUrl && <tr><td colSpan={2}><GhostButton onClick={() => window.open(signedUrl, "_blank")}>View Signed Document</GhostButton></td></tr>}
        </tbody></table>;
      }

      case "APPOINTMENT_GENERATED": case "APPOINTMENT_PREVIEWED":
        return <table><tbody>
          {row("Employee ID", offer.employeeId ? offer.reservedEmpNo : `${offer.reservedEmpNo} (hidden until joining is confirmed)`)}
          {row("Reporting Manager", offer.appointmentLetter?.dynamicFields?.ReportingManager || "—")}
          {row("Work Location", offer.appointmentLetter?.dynamicFields?.WorkLocation || "—")}
          <tr><td colSpan={2}><GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/appointment/pdf`), "_blank")}>View Appointment PDF</GhostButton></td></tr>
        </tbody></table>;

      case "APPOINTMENT_ISSUED":
        return <table><tbody>
          {row("Issued On", offer.appointmentLetter?.issuedAt ? fmtDateTime(offer.appointmentLetter.issuedAt) : "—")}
          <tr><td colSpan={2}><GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/appointment/pdf`), "_blank")}>View Appointment PDF</GhostButton></td></tr>
        </tbody></table>;

      case "JOINING_CONFIRMED":
        return <table><tbody>
          {row(`${isContractor ? "Contractor" : "Employee"} ID`, offer.reservedEmpNo)}
          {row("Activated On", when || "—")}
          <tr><td colSpan={2}><Link to="/employees">View in Employee master →</Link></td></tr>
        </tbody></table>;

      default: return <div style={{ color: "var(--muted)" }}>—</div>;
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{offer.candidateName} <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>{offer.offerRef}</span></h1>
          <div className="subtitle">
            {offer.role} · {offer.designation} · <EmploymentTypePill t={offer.employmentType || "EMPLOYEE"} />
            {!isContractor && <> · {money(offer.ctc)} / annum</>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setShowAuditTrail((p) => !p)} title="Audit Trail — full history of actions on this offer"
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", padding: "6px 10px", fontSize: 13, color: showAuditTrail ? "var(--accent)" : "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <HistoryRoundedIcon sx={{ fontSize: 16 }} /> Audit Trail
          </button>
          <StatusPill s={offer.status} />
        </div>
      </div>
      {showAuditTrail && (
        <Panel title="Audit Trail" style={{ marginBottom: 14 }}>
          <table><tbody>
            {(offer.auditLogs || []).map((a: any) => (
              <tr key={a.id}><td style={{ fontSize: 11.5 }}>{fmtDateTime(a.at)}</td><td style={{ fontSize: 11.5 }}>{a.action}</td><td style={{ fontSize: 11.5, color: "var(--muted)" }}>{a.note}</td></tr>
            ))}
          </tbody></table>
        </Panel>
      )}

      {/* Vertical timeline (left) + active-stage detail card (right) — driven entirely by the
          offer's actual pinned Workflow & Stage Configuration (stageStatus, from
          /hr/offers/:id/stage-status), same order and same names HR configured there — not the
          fixed technical OfferStatus enum labels that used to render here regardless of config.
          The timeline doubles as the wizard's step navigator — click any stage to view it; only
          THAT stage's own content shows in the card on the right, never a previous one's, matching
          Workflow & Stage Configuration exactly. */}
      <div style={{ display: "flex", gap: 28, alignItems: "flex-start", marginTop: 16 }}>
        {orderedStages.length > 0 && (
          <div style={{ width: 250, flexShrink: 0, position: "relative", paddingTop: 2 }}>
            <div style={{ position: "absolute", left: 16, top: 8, bottom: 8, width: 2, background: "var(--border)" }} />
            {orderedStages.map((s: any) => {
              // s.done is the server's override-aware resolution — s.status alone stays "PENDING"
              // forever for stages like Offer/Appointment Generation, which never get a real
              // OfferStageProgress COMPLETED row by design, so they'd never show green without this.
              const done = s.done ?? (s.status === "COMPLETED" || s.status === "SKIPPED");
              const active = s.key === effectiveStep;
              const dotBg = done ? "var(--good)" : s.current ? "var(--accent)" : "var(--panel2)";
              const dotFg = done || s.current ? "#fff" : "var(--muted)";
              return (
                <button key={s.key} onClick={() => setActiveStep(s.key)} title={s.unlocked ? undefined : "Locked — earlier stages aren't complete yet"}
                  style={{ display: "flex", alignItems: "flex-start", gap: 12, width: "100%", textAlign: "left", background: active ? "var(--panel2)" : "none",
                    border: active ? "1px solid var(--accent)" : "1px solid transparent", borderRadius: 10, padding: "9px 10px", marginBottom: 4, cursor: "pointer" }}>
                  <div style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    background: dotBg, color: dotFg, border: "1px solid var(--border)", zIndex: 1, fontSize: 12, fontWeight: 700 }}>
                    {done ? <CheckRoundedIcon sx={{ fontSize: 16 }} /> : !s.unlocked ? <LockRoundedIcon sx={{ fontSize: 14 }} /> : s.order}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Stage {s.order}</div>
                    <div style={{ fontSize: 12.5, fontWeight: active ? 700 : 500, color: active ? "var(--text)" : done ? "var(--text)" : "var(--muted)", lineHeight: 1.3 }}>{s.name}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
      {TERMINAL.includes(offer.status) && <div className="note">This {isContractor ? "engagement" : "offer"} is closed ({STATUS_LABEL[offer.status]}) — no further action needed.</div>}

      {/* Wizard: Stage 1's own content only shows while Stage 1 is the selected step — clicking
          another stage's tab above hides this entirely, exactly the "zero gap, only this stage's
          info" rule. */}
      {(effectiveStep === stage1Key || (!!candidateInfoKey && effectiveStep === candidateInfoKey)) && (<>
      {(() => {
        const genStage = stageByType("OFFER_GENERATION") || stageByType("DATA_COLLECTION") || stageByType("CANDIDATE_INFO");
        return genStage && <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Stage {genStage.order} — {genStage.name}</div>;
      })()}
      {isContractor ? (
        <div className="grid cols-2">
          <Panel title="Candidate / Contractor Information">
            <table><tbody>
              <tr><td>First Name</td><td className="num">{offer.candidateFirstName || "—"}</td></tr>
              {fieldCfg("candidateMiddleName")?.enabled && offer.candidateMiddleName && <tr><td>Middle Name</td><td className="num">{offer.candidateMiddleName}</td></tr>}
              <tr><td>Last Name</td><td className="num">{offer.candidateLastName || "—"}</td></tr>
              <tr><td>Candidate Name</td><td className="num">{offer.candidateName}</td></tr>
              <tr><td>Official Email</td><td className="num">{offer.candidateEmail}</td></tr>
              {fieldCfg("phoneNumber")?.enabled && <tr><td>Phone</td><td className="num">{offer.candidatePhone || "—"}</td></tr>}
              {fieldCfg("address")?.enabled && <tr><td>Address</td><td className="num">{offer.candidateAddress || "—"}</td></tr>}
              {fieldCfg("aadhaar")?.enabled && <tr><td>Aadhaar</td><td className="num">{offer.aadhaarNumber || "—"}</td></tr>}
              <tr><td>Business Unit</td><td className="num">{offer.businessUnit?.name || "—"}</td></tr>
              <tr><td>Country</td><td className="num">{offer.countryCode}</td></tr>
              <tr><td>Proposed Effective Date</td><td className="num">{offer.proposedJoiningDate ? fmtDate(offer.proposedJoiningDate) : "—"}</td></tr>
            </tbody></table>
            {["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                {/* Contractor/Intern had no way at all to fix a typo in name/email/CTC/etc. once
                    past creation — Regenerate Service Agreement only edits the SLA's OWN fields
                    (compensation, bank/SLA-name or, for Intern, Location/Internship End Date), not
                    these base candidate/engagement fields on the Offer itself. Editable all the way
                    through SENT (the SLA is out for signature but not yet actually signed) — the
                    enclosing status check above is exactly that window; only ACCEPTED (signed)
                    onward blocks it, matching the server's own PUT /offers/:id gate. */}
                <GhostButton icon={<AutorenewRoundedIcon />} disabled={busy} onClick={() => navigate(`/hr/offers/${id}/regenerate`)}>Edit Candidate Information</GhostButton>
                <GhostButton disabled={busy} onClick={() => { if (window.confirm("Cancel this contractor engagement?")) call("/cancel"); }}>Cancel</GhostButton>
              </div>
            )}
          </Panel>

          {/* India's Service Agreement is irrelevant for a US/Canada Vendor/Contractor engagement —
              that uses MsaSowAgreementPanel (MSA + SOW) below instead. Never shown together. */}
          {!offer.vendorName && (offer.serviceAgreement && !regenerateSa ? (
            <Panel title={offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement"}>
              <table><tbody>
                <tr><td>Monthly Compensation</td><td className="num">{money(offer.serviceAgreement.monthlyCompensation)}</td></tr>
                <tr><td>Effective Date</td><td className="num">{offer.serviceAgreement.dynamicFields?.EffectiveDate ? fmtDate(offer.serviceAgreement.dynamicFields.EffectiveDate) : "—"}</td></tr>
                <tr><td>{offer.employmentType === "INTERN" ? "Intern Code" : "Contractor Code"}</td><td className="num">{offer.reservedEmpNo || "—"} <span className="pill">hidden</span></td></tr>
              </tbody></table>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                {["GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && (
                  <GhostButton disabled={busy} onClick={async () => { await call("/service-agreement/preview"); window.open(api.pdfUrl(`/hr/offers/${id}/service-agreement/pdf`), "_blank"); }}>Preview (PDF)</GhostButton>
                )}
                {["GENERATED", "PREVIEWED"].includes(offer.status) && (
                  <AddButton disabled={busy || offer.acceptanceMethod === "ADOBE_SIGN"}
                    title={offer.acceptanceMethod === "ADOBE_SIGN" ? "The Offer was accepted digitally via Adobe Sign — use Send for E-Signature below to keep the same digital flow." : undefined}
                    onClick={() => call("/service-agreement/send")}>Send {offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement"}</AddButton>
                )}
                {/* Still available on a closed (Declined/Expired/Withdrawn/Cancelled) engagement —
                    HR's restart path; voids any stale in-flight e-signature automatically. */}
                <GhostButton disabled={busy} onClick={() => setRegenerateSa(true)}>Regenerate {offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement"}</GhostButton>
              </div>
              {["GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && <EsignPanel docType="SERVICE_AGREEMENT" docId={offer.id} />}
            </Panel>
          ) : (
            ["DRAFT", "GENERATED", "PREVIEWED"].includes(offer.status) && (
              <ServiceAgreementGeneratePanel offer={offer} onDone={() => { setRegenerateSa(false); reload(); }} busy={busy} setBusy={setBusy}
                regenerate={!!offer.serviceAgreement} onCancel={offer.serviceAgreement ? () => setRegenerateSa(false) : undefined} />
            )
          ))}
          <MsaSowAgreementPanel offer={offer} />
          {/* Acceptance UI, folded directly into this same combined stage — ONLY when there's no
              separate OFFER_ACCEPTANCE-typed stage of its own (Contractor's workflow has one, and
              already renders AcceptancePanel under its own tab below via stage2Key; Intern's
              collapsed workflow has no such stage at all, so effectiveStep === stage2Key could
              never be true for Intern and this panel — manual confirm+upload, or the e-sign
              status/manual-override — never rendered anywhere. That's why this tab went visually
              blank the moment Send moved the offer status past GENERATED/PREVIEWED/SENT: neither
              the summary Panel above (before the fix just made it status-independent) nor any
              acceptance UI had a condition that matched). */}
          {!stage2Key && offer.serviceAgreement && (() => {
            const relevantEsign = saEsignForOffer;
            const esignPending = !!relevantEsign && relevantEsign.status !== "NOT_SENT" && relevantEsign.status !== "SIGNED";
            const showAcceptForm = ["GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && (!relevantEsign || relevantEsign.status === "NOT_SENT" || manualAcceptOverride);
            const pastAcceptance = !["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status);
            const docLabel = offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement";
            return (
              <>
                {showAcceptForm && <AcceptancePanel offer={offer} onDone={() => { setManualAcceptOverride(false); reload(); }} busy={busy} setBusy={setBusy} contractor />}
                {!showAcceptForm && pastAcceptance && (
                  <Panel title={`${docLabel} Accepted`}>
                    {stageDetail("ACCEPTED")}
                    {/* Explicit HR step for the e-sign path specifically — signing already recorded
                        the acceptance automatically (no separate confirm click needed for THAT),
                        but HR still needs a deliberate "I opened and reviewed the actual signed
                        document" moment before moving on to Confirm Joining & Activation, not just
                        an automatic status flip with an easy-to-miss link buried in a table row. */}
                    {offer.acceptanceMethod === "ADOBE_SIGN" && (
                      <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: "1px solid var(--accent)", background: "rgba(59,130,246,.08)" }}>
                        <div style={{ fontSize: 13, marginBottom: 8 }}>Signed digitally via Adobe Sign — open and review the signed {docLabel.toLowerCase()} before confirming joining.</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <GhostButton onClick={() => window.open(api.pdfUrl(`/adobe-sign/signed/SERVICE_AGREEMENT/${id}`), "_blank")}>View Signed Document</GhostButton>
                          <AddButton disabled={busy} onClick={async () => { await call("/acknowledge-acceptance"); setActiveStep(stageByType("EMPLOYEE_ACTIVATION")?.key || null); }}>Reviewed — Proceed to Confirm Joining &amp; Activation →</AddButton>
                        </div>
                      </div>
                    )}
                  </Panel>
                )}
                {!showAcceptForm && !pastAcceptance && esignPending && (
                  <Panel title="Awaiting Signature">
                    <div className="subtitle">
                      Waiting for the candidate to sign {docLabel.toLowerCase()} digitally via Adobe Sign — see the e-signature panel above.{" "}
                      <a href="#" onClick={(e) => { e.preventDefault(); setManualAcceptOverride(true); }}>Trouble with e-signature? Record acceptance manually instead →</a>
                    </div>
                  </Panel>
                )}
              </>
            );
          })()}
        </div>
      ) : (
        <div className="grid cols-2">
          {/* Left: candidate + salary + tax */}
          <Panel title="Candidate / Offer Information">
            {/* Wizard tab visibility already scopes this whole section to Stage 1 only (clicking
                Stage 1's tab is itself "go back and look" — no separate in-panel collapse needed). */}
            <table><tbody>
              <tr><td>Candidate Name</td><td className="num">{offer.candidateName}</td></tr>
              <tr><td>Official Email</td><td className="num">{offer.candidateEmail}</td></tr>
              <tr><td>Phone</td><td className="num">{offer.candidatePhone || "—"}</td></tr>
              <tr><td>Business Unit</td><td className="num">{offer.businessUnit?.name || "—"}</td></tr>
              <tr><td>Country</td><td className="num">{offer.countryCode}</td></tr>
              <tr><td>Offer Date</td><td className="num">{fmtDate(offer.offerDate)}</td></tr>
              <tr><td>Proposed Joining Date</td><td className="num">{offer.proposedJoiningDate ? fmtDate(offer.proposedJoiningDate) : "—"}</td></tr>
              <tr><td>Version</td><td className="num">v{offer.activeVersion} of {offer.versions?.length || 1}</td></tr>
            </tbody></table>
            {/* Shown/required exactly per HR Settings → Workflow & Stage Configuration's Offer
                Generation / Resume+Aadhaar stage field config (engine/workflow.ts
                resolveOfferFieldConfig) — the server-side guard (unmetMandatoryOfferFields) reads
                the identical config, so this can never show something the button doesn't enforce. */}
            {!offer.versions?.length && fieldConfig && (fieldCfg("resume")?.enabled || fieldCfg("aadhaar")?.enabled || fieldCfg("pan")?.enabled) && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {fieldCfg("resume")?.enabled && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: `1px solid ${offer.resumeFileName ? "var(--border)" : fieldCfg("resume")?.mandatory ? "var(--bad)" : "var(--border)"}` }}>
                    <div style={{ flex: 1, fontSize: 13 }}>
                      {offer.resumeFileName
                        ? <>✓ Resume on file: <b>{offer.resumeFileName}</b> <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/resume`), "_blank")}>Preview</GhostButton></>
                        : fieldCfg("resume")?.mandatory
                          ? <span style={{ color: "var(--bad)" }}>⚠ Resume required — upload the candidate's resume before generating the offer.</span>
                          : <span style={{ color: "var(--muted)" }}>Resume (optional)</span>}
                    </div>
                    <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                      {resumeBusy ? "Uploading…" : offer.resumeFileName ? "Re-upload" : "Upload Resume"}
                      <input type="file" style={{ display: "none" }} disabled={resumeBusy}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadResume(f); e.target.value = ""; }} />
                    </label>
                  </div>
                )}
                {fieldCfg("aadhaar")?.enabled && (() => {
                  const aadhaarComplete = !!offer.aadhaarNumber && !!offer.aadhaarFileName;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, borderRadius: 8, border: `1px solid ${aadhaarComplete ? "var(--border)" : fieldCfg("aadhaar")?.mandatory ? "var(--bad)" : "var(--border)"}` }}>
                      <div style={{ fontSize: 13 }}>
                        {aadhaarComplete
                          ? <>✓ Aadhaar on file: <b>{offer.aadhaarNumber.replace(/\d(?=\d{4})/g, "•")}</b> — image <b>{offer.aadhaarFileName}</b> <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${id}/aadhaar`), "_blank")}>Preview</GhostButton></>
                          : offer.aadhaarNumber && !offer.aadhaarFileName
                            ? <span style={{ color: "var(--bad)" }}>⚠ Number on file, but the Aadhaar image is still required — upload it below.</span>
                            : fieldCfg("aadhaar")?.mandatory
                              ? <span style={{ color: "var(--bad)" }}>⚠ Aadhaar required — capture both the candidate's Aadhaar number and a scanned image before generating the offer.</span>
                              : <span style={{ color: "var(--muted)" }}>Aadhaar (optional) — number and image</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <input placeholder="12-digit Aadhaar number" value={aadhaarInput} onChange={(e) => setAadhaarInput(e.target.value)} style={{ width: 180 }} maxLength={12} />
                        <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                          {aadhaarFile ? aadhaarFile.name : "Choose Aadhaar Image"}
                          <input type="file" accept="image/*,.pdf" style={{ display: "none" }}
                            onChange={(e) => setAadhaarFile(e.target.files?.[0] || null)} />
                        </label>
                        <GhostButton disabled={aadhaarBusy || aadhaarInput.length !== 12} onClick={saveAadhaar}>{aadhaarBusy ? "Saving…" : aadhaarComplete ? "Update" : "Save"}</GhostButton>
                      </div>
                    </div>
                  );
                })()}
                {fieldCfg("pan")?.enabled && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, borderRadius: 8, border: `1px solid ${offer.panNumber ? "var(--border)" : fieldCfg("pan")?.mandatory ? "var(--bad)" : "var(--border)"}` }}>
                    <div style={{ fontSize: 13 }}>
                      {offer.panNumber
                        ? <>✓ PAN on file: <b>{offer.panNumber}</b></>
                        : fieldCfg("pan")?.mandatory
                          ? <span style={{ color: "var(--bad)" }}>⚠ PAN required — capture the candidate's PAN number before generating the offer.</span>
                          : <span style={{ color: "var(--muted)" }}>PAN (optional)</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <input placeholder="ABCDE1234F" value={panInput} onChange={(e) => setPanInput(e.target.value.toUpperCase())} style={{ width: 140 }} maxLength={10} />
                      <GhostButton disabled={panBusy || !/^[A-Z]{5}\d{4}[A-Z]$/.test(panInput)} onClick={savePan}>{panBusy ? "Saving…" : offer.panNumber ? "Update" : "Save"}</GhostButton>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {canRegenerateOffer && ["DRAFT", "GENERATED", "PREVIEWED"].includes(offer.status) && (() => {
                const missing = !offer.versions?.length ? ([
                  fieldCfg("resume")?.mandatory && !offer.resumeFileName && "resume",
                  fieldCfg("aadhaar")?.mandatory && (!offer.aadhaarNumber || !offer.aadhaarFileName) && "Aadhaar (number + image)",
                  fieldCfg("pan")?.mandatory && !offer.panNumber && "PAN",
                ].filter(Boolean) as string[]) : [];
                return (
                  <GhostButton icon={<CalculateRoundedIcon />} disabled={busy || missing.length > 0}
                    title={missing.length ? `Capture the candidate's ${missing.join(" and ")} first` : undefined}
                    onClick={() => call("/generate")}>{offer.versions?.length ? "Recalculate Offer" : "Generate Offer"}</GhostButton>
                );
              })()}
              {/* The one action still available on a closed (Declined/Expired/Withdrawn/Cancelled)
                  offer — HR's escape hatch to restart the same candidate as a fresh revision
                  instead of a dead end. Voids any stale in-flight e-signature automatically. Hidden
                  once the offer has actually been sent — it's the active version from there on. */}
              {canRegenerateOffer && offer.versions?.length > 0 && <GhostButton icon={<AutorenewRoundedIcon />} disabled={busy} onClick={() => navigate(`/hr/offers/${id}/regenerate`)}>Regenerate Offer (New Version)</GhostButton>}
              {["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && v && (
                <GhostButton icon={<VisibilityRoundedIcon />} disabled={busy} onClick={async () => { await call("/preview"); window.open(api.pdfUrl(`/hr/offers/${id}/pdf`), "_blank"); }}>Preview Offer</GhostButton>
              )}
              {/* Both send paths stay disabled until Preview Offer has actually run (GENERATED ->
                  PREVIEWED) — see /offers/:id/preview and /offers/:id/send's server-side gate. */}
              {["DRAFT", "GENERATED", "PREVIEWED"].includes(offer.status) && v && (
                <AddButton icon={<SendRoundedIcon />} disabled={busy || offer.status !== "PREVIEWED"} title={offer.status !== "PREVIEWED" ? "Preview the offer first" : undefined} onClick={() => call("/send")}>Send Offer via Email</AddButton>
              )}
              {offer.status === "SENT" && <GhostButton icon={<ReplayRoundedIcon />} disabled={busy} onClick={() => call("/resend")}>Resend Offer</GhostButton>}
              {/* Available from the moment the candidate record exists — HR can abandon a mistaken
                  or no-longer-needed offer right here on Stage 1, same screen as Generate/Preview/
                  Send/Regenerate, without first having to send it. The server itself has never
                  required that (only blocks once the employee has actually joined) — only skips
                  the candidate withdrawal email if nothing was ever sent to notify them about. */}
              {["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && (
                <GhostButton icon={<CloseRoundedIcon />} disabled={busy}
                  onClick={() => { if (window.confirm("Cancel this offer?")) call("/cancel"); }}>Cancel Offer</GhostButton>
              )}
            </div>
            {v && <EsignPanel docType="OFFER" docId={offer.id} sendLabel="Send Offer via E-Signature" sendIcon={<DrawRoundedIcon />} disabled={offer.status !== "PREVIEWED"} disabledReason="Preview the offer first" />}
          </Panel>

          <MsaSowAgreementPanel offer={offer} />
          {v && <CustomizeSalaryPanel offerId={offer.id} version={v} money={money} canEdit={["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status)} onSaved={reload} />}
          {!v && <Panel title="Not generated yet"><div style={{ color: "var(--muted)" }}>Click Generate Offer to compute the CTC bracket, salary breakup and tax.</div></Panel>}
        </div>
      )}
      </>)}

      {/* Acceptance — same action for both employment types. Manual confirmation only applies to
          the plain-email flow: once the "sent" document (the Offer Letter for an Employee, or the
          Service Agreement for a Contractor — who never has a separate Offer Letter) is sent for
          e-signature (Adobe Sign), signing IS the candidate's acceptance and is captured
          automatically in real time — see EsignPanel above, no separate manual step here. */}
      {effectiveStep === stage2Key && (() => {
        const acceptStage = stageByType("OFFER_ACCEPTANCE");
        // Reachable from GENERATED/PREVIEWED too, not just SENT — HR may already have a copy
        // signed outside this app (see AcceptancePanel's Upload) and can skip Send entirely.
        const esignPending = !!relevantOfferEsign && relevantOfferEsign.status !== "NOT_SENT" && relevantOfferEsign.status !== "SIGNED";
        const showForm = ["GENERATED", "PREVIEWED", "SENT"].includes(offer.status) && (!relevantOfferEsign || relevantOfferEsign.status === "NOT_SENT" || manualAcceptOverride);
        const pastAcceptance = !["DRAFT", "GENERATED", "PREVIEWED", "SENT"].includes(offer.status);
        return (
          <>
            {acceptStage && <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginTop: 14 }}>Stage {acceptStage.order} — {acceptStage.name}</div>}
            {showForm && <AcceptancePanel offer={offer} onDone={() => { setManualAcceptOverride(false); reload(); }} busy={busy} setBusy={setBusy} contractor={isContractor} />}
            {!showForm && pastAcceptance && <Panel title={isContractor ? (offer.employmentType === "INTERN" ? "Internship Letter Accepted" : "Service Agreement Accepted") : "Offer Accepted"} style={{ marginTop: 10 }}>{stageDetail("ACCEPTED")}</Panel>}
            {!showForm && !pastAcceptance && esignPending && (
              <div className="subtitle">
                Waiting for the candidate to sign digitally via Adobe Sign — see the e-signature panel on Stage 1.{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setManualAcceptOverride(true); }}>Trouble with e-signature? Record acceptance manually instead →</a>
              </div>
            )}
            {!showForm && !pastAcceptance && !esignPending && offer.status === "SENT" && <div className="subtitle">Waiting for the candidate to sign digitally via Adobe Sign — see the e-signature panel on Stage 1.</div>}
            {!showForm && !pastAcceptance && offer.status !== "SENT" && <div className="subtitle">Not reached yet — generate the offer on Stage 1 first.</div>}
          </>
        );
      })()}

      {(() => {
        // Contractor and Employee both go through Document Collection -> IT Provisioning ->
        // Confirm Joining (the server routes have always supported Contractors on all three —
        // see hrOffers.ts's /document-collection and /it-provisioning gates); only Appointment
        // Generation stays Employee-only, since a Contractor structurally has no Appointment
        // Letter (orderedStages above already excludes it from the nav for a Contractor, so
        // appointmentBlock below is simply never selected into `effectiveStep` for one).
        // The three "movable" stages — Document Collection, Employee Activation (Confirm Joining)
        // and Appointment Generation — render in whatever order HR configured them in Workflow &
        // Stage Configuration (default: Activation before Appointment), not a fixed DOM order.
        // Offer Generation/Accepted stay fixed above (they're the necessary front of every
        // pipeline); each block's own internal visibility/gating logic is untouched.
        const docStage = stageByType("DOCUMENT_COLLECTION");
        const itStage = stageByType("IT_PROVISIONING");
        const activationStage = stageByType("EMPLOYEE_ACTIVATION");
        const appointmentStage = stageByType("APPOINTMENT_GENERATION");

        // Once this stage's own status is COMPLETED/SKIPPED, its full interactive panel recedes to
        // a one-line marker — same "only this stage's own info, not a previous one's" rule as
        // Stage 1/2 above, just applied to the dynamic middle stages too.
        const docDone = docStage?.status === "COMPLETED" || docStage?.status === "SKIPPED";
        // Employee's Document Collection stage comes AFTER Offer Acceptance by design, so it stays
        // gated on that. Contractor/Intern is the opposite — their published workflow puts Document
        // Collection (order 2) BEFORE SLA/Internship Letter generation (order 3), exactly per the
        // user's own spec ("Stage 1: capture basic info + documents... Stage 2: generate SLA"). The
        // status gate below (unchanged for Employee) was blocking it until ACCEPTED, a status
        // Contractor/Intern only reaches at their LATER SLA-acceptance stage — so it always showed
        // "Not reached yet" even though the stage itself was genuinely unlocked and first in order.
        // Always the real panel, done or not — it fetches and shows its own live/submitted state
        // (which documents, uploaded when, verified/rejected) rather than a bare "✓ completed" that
        // threw all of that away the moment HR revisited an already-finished stage's tab.
        const docBlock = (isContractor
          ? !["DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"].includes(offer.status)
          : !["DRAFT", "GENERATED", "PREVIEWED", "SENT", "DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"].includes(offer.status)) && (
          <>
            {docDone && <div className="subtitle" style={{ margin: "0 0 8px" }}>✓ Mandatory Document Collection completed.</div>}
            <DocumentCollectionPanel offerId={offer.id} />
          </>
        );

        // Its own standalone entry point — previously only reachable nested inside the Confirm
        // Joining page, which itself only unlocks once IT Provisioning is already complete (its
        // dependsOnKeys includes it_provisioning), a deadlock that made this stage unreachable from
        // the UI. Uses the same ItProvisioningPanel component Confirm Joining still shows too (that
        // one just becomes a no-op re-render once this has already sent the request).
        // Same reasoning as docBlock above — ItProvisioningPanel already defaults to a read-only
        // view of exactly what was submitted once existing.sentAt is set, so always rendering it
        // (instead of a bare "✓ completed") is what actually shows the captured data back.
        // BUG FIX: this previously also required `!offer.employeeId` — meaning the instant the
        // employee was actually activated (the normal, expected end state), clicking back onto
        // this stage's tab showed NOTHING at all, even though ItProvisioningPanel itself already
        // handles the post-completion read-only case correctly. Dropped that condition — only
        // `unlocked` + not-terminal still gate it, exactly like docBlock above.
        const itDone = itStage?.status === "COMPLETED" || itStage?.status === "SKIPPED";
        const itBlock = itStage && itStage.unlocked && !TERMINAL.includes(offer.status)
          && (<>
            {itDone && <div className="subtitle" style={{ margin: "0 0 8px" }}>✓ IT Provisioning Request completed.</div>}
            <ItProvisioningPanel offer={offer} />
          </>);

        // The real Confirm Joining form, inline — a separate page/navigation here just confused
        // the flow (Stage 5's tab should show Stage 5's actual work, not a link elsewhere). The
        // dedicated Confirm Joining queue page still exists separately for bulk cross-offer triage;
        // this is the same ConfirmJoiningPanel component either way, just embedded for this one offer.
        // BUG FIX: once `offer.employeeId` is set (activation already happened), this used to
        // render NOTHING at all when HR clicked back onto this stage's tab — unlike docBlock/
        // itBlock, which stayed visible read-only. Unlike those two, ConfirmJoiningPanel has no
        // built-in "already activated" read-only mode of its own (it's a live action form with no
        // offer.employeeId check inside it), so re-showing it unconditionally here would risk
        // exposing the live Activate button/CTC-preview form again on an already-activated offer —
        // show a plain read-only summary instead, built from the Employee record Confirm Joining
        // itself already created, rather than the interactive form.
        const activationBlock = activationStage && activationStage.unlocked && !TERMINAL.includes(offer.status)
          && (offer.employeeId
            ? (
              <Panel title={isContractor ? "Confirm Joining — Activate Contractor" : "Onboarding Activation"}>
                <div className="subtitle" style={{ margin: "0 0 8px" }}>✓ {isContractor ? "Contractor" : "Employee"} activated.</div>
                <table><tbody>
                  <tr><td>Employee ID</td><td className="num">{offer.employee?.empNo || offer.reservedEmpNo}</td></tr>
                  <tr><td>Joining Date</td><td className="num">{offer.employee?.joiningDate ? fmtDate(offer.employee.joiningDate) : "—"}</td></tr>
                  <tr><td>Designation</td><td className="num">{offer.employee?.designation || offer.designation || "—"}</td></tr>
                  <tr><td>Department</td><td className="num">{offer.employee?.department || offer.department || "—"}</td></tr>
                </tbody></table>
              </Panel>
            )
            : offer.status !== "JOINING_CONFIRMED" && (
              <ConfirmJoiningPanel offer={offer} projects={projects || []} busy={busy} setBusy={setBusy} contractor={isContractor} hideItProvisioning
                onDone={() => { reload(); reloadStageStatus(); }} />
            ));

        // Not-yet-generated must respect the stage's own dependsOnKeys (default: depends on
        // Employee Activation) — this was previously showing the Generate form the instant the
        // offer was Accepted, regardless of whether Document Collection/IT Provisioning/Activation
        // had actually finished, which is exactly the "stage shown out of turn" bug. Once it HAS
        // been generated, though, always show it — a real document that already exists can't be
        // hidden again just because some other stage's state changed afterward.
        const appointmentVisible = (["ACCEPTED", "JOINING_CONFIRMED"].includes(offer.status) && !!appointmentStage?.unlocked) || ["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(offer.status);
        const appointmentBlock = appointmentVisible && (
          <>
            {["ACCEPTED", "JOINING_CONFIRMED"].includes(offer.status) && (
              <AppointmentGeneratePanel offer={offer} onDone={reload} busy={busy} setBusy={setBusy}
                initial={{ ReportingManager: offer.reportingManager, WorkLocation: offer.workLocation, Department: offer.department, EmploymentType: offer.employmentBasis, NoticePeriod: offer.noticePeriod, ProbationPeriod: offer.probationPeriod }} />
            )}
            {["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(offer.status) && !regenerateAppt && (() => {
              // The Appointment Letter is the employee's formal HR document — it shouldn't go out
              // (by email or e-signature) before their official company email actually exists, so
              // both send actions stay disabled until IT Admin has approved the IT Provisioning
              // Request (Pending Tasks -> Approve). Preview/Regenerate are NOT gated by this — HR
              // can still prepare and review the letter before the account exists.
              const itReq = offer.itProvisioningRequest;
              const officialEmailReady = !!itReq?.emailCreatedAt;
              const emailNotReadyReason = !itReq
                ? "Send this offer to IT first (Stage 4 — IT Provisioning Request) before the appointment letter can be sent."
                : `Official email (${itReq.emailIdToCreate}) is still pending IT Admin's approval in Pending Tasks.`;
              return (
                <Panel title="Appointment Letter" style={{ marginTop: 14 }}>
                  <div>Employee ID <b>{offer.reservedEmpNo}</b>{offer.employeeId ? "" : " reserved — still hidden from the Employee master, Attendance, Project Allocation and Cost."}</div>
                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`pill ${officialEmailReady ? "good" : "warn"}`}>Official Email: {officialEmailReady ? "Created" : "Pending"}</span>
                    <span className="subtitle" style={{ margin: 0 }}>{officialEmailReady ? itReq!.emailIdToCreate : emailNotReadyReason}</span>
                  </div>
                  {/* All four appointment actions (Preview / Send by Email / Regenerate / Send by
                      E-Signature) share one flex row — EsignPanel renders its own inline badge +
                      button, and as a nested flex item it wraps together with these three instead
                      of forcing its own separate line below them. */}
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <GhostButton icon={<VisibilityRoundedIcon />} disabled={busy} onClick={async () => { await call("/appointment/preview"); window.open(api.pdfUrl(`/hr/offers/${id}/appointment/pdf`), "_blank"); }}>Preview Appointment</GhostButton>
                    {/* Both send paths stay disabled until Preview Appointment has actually run
                        (APPOINTMENT_GENERATED -> APPOINTMENT_PREVIEWED) AND the official email exists. */}
                    <AddButton icon={<SendRoundedIcon />} disabled={busy || offer.acceptanceMethod === "ADOBE_SIGN" || offer.status !== "APPOINTMENT_PREVIEWED" || !officialEmailReady}
                      title={!officialEmailReady ? emailNotReadyReason : offer.acceptanceMethod === "ADOBE_SIGN" ? "The Offer was accepted digitally via Adobe Sign — use Send Appointment Through E-Signature below to keep the same digital flow for the Appointment Letter." : offer.status !== "APPOINTMENT_PREVIEWED" ? "Preview the appointment first" : undefined}
                      onClick={() => call("/appointment/issue")}>Send Appointment Through Email</AddButton>
                    <GhostButton icon={<AutorenewRoundedIcon />} disabled={busy} onClick={() => setRegenerateAppt(true)}>Regenerate Appointment Letter</GhostButton>
                    <EsignPanel docType="APPOINTMENT_LETTER" docId={offer.id} sendLabel="Send Appointment Through E-Signature" sendIcon={<DrawRoundedIcon />} disabled={offer.status !== "APPOINTMENT_PREVIEWED" || !officialEmailReady} disabledReason={!officialEmailReady ? emailNotReadyReason : "Preview the appointment first"} />
                  </div>
                </Panel>
              );
            })()}
            {["APPOINTMENT_GENERATED", "APPOINTMENT_PREVIEWED"].includes(offer.status) && regenerateAppt && (
              <AppointmentGeneratePanel offer={offer} onDone={() => { setRegenerateAppt(false); reload(); }} busy={busy} setBusy={setBusy}
                initial={offer.appointmentLetter?.dynamicFields} regenerate onCancel={() => setRegenerateAppt(false)} />
            )}
          </>
        );

        // Any OTHER enabled+unlocked stage with HR-defined Custom Fields (Workflow Builder -> any
        // stage's "+ Add Custom Field") gets a generic capture panel here too — including stage
        // types with no dedicated real form of their own (Custom Stage, approvals, etc.), so a
        // Custom Field genuinely works on any stage, not just the four with a built-in panel.
        const coveredTypes = ["DOCUMENT_COLLECTION", "IT_PROVISIONING", "EMPLOYEE_ACTIVATION", "APPOINTMENT_GENERATION", "ONBOARDING_ACTIVATION", "CAPTURE_INFORMATION", "AGREEMENT_SIGNATURE"];
        const customFieldItems = (stageStatus || [])
          .filter((s: any) => !coveredTypes.includes(s.stageType) && s.unlocked && s.hasCustomFields)
          .map((s: any) => ({ key: `cf-${s.key}`, stage: s, order: s.order, node: <CustomFieldsPanel offerId={offer.id} stageKey={s.key} stageName={s.name} /> }));

        // Intern: IT Provisioning's tab is hidden (see orderedStages above), so its panel is
        // stacked together with Activation's under the one tab that's still visible.
        const items = [
          { key: "doc", stage: docStage, order: docStage?.order ?? 5, node: docBlock },
          { key: "it", stage: itStage, order: itStage?.order ?? 6, node: itBlock },
          { key: "act", stage: activationStage, order: activationStage?.order ?? 7,
            node: isIntern ? <>{itBlock}{activationBlock}</> : activationBlock },
          { key: "appt", stage: appointmentStage, order: appointmentStage?.order ?? 8, node: appointmentBlock },
          ...customFieldItems,
        ].sort((a, b) => a.order - b.order);

        // Wizard: only the tab HR actually clicked (or the current one, by default) renders here —
        // every other configured stage's content, including ones already completed, stays hidden.
        const selected = items.find((it) => it.stage?.key === effectiveStep);
        if (!selected) {
          // Appointment Accepted (last stage) has no interactive panel of its own — auto-completes
          // off the candidate's e-signature/manual confirmation, already shown via AcceptancePill
          // on Stage 6 (Appointment Generation)'s EsignPanel — this is just its own recap slot.
          if (effectiveStep === stageAppointmentAcceptedKey) {
            const acceptedStage = stageByType("APPOINTMENT_ACCEPTANCE");
            const accepted = offer.appointmentAcceptance?.status === "ACCEPTED";
            return (
              <>
                {acceptedStage && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 14, textTransform: "uppercase", letterSpacing: 0.4 }}>Stage {acceptedStage.order} — {acceptedStage.name}</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, padding: "12px 14px", borderRadius: 8, border: `1px solid var(${accepted ? "--good" : "--warn"})`, background: accepted ? "rgba(34,197,94,.08)" : "rgba(251,191,36,.08)" }}>
                  {accepted ? <CheckCircleRoundedIcon sx={{ color: "var(--good)" }} /> : <span className="spinner" />}
                  <div style={{ fontSize: 13 }}>
                    {accepted ? "Appointment Letter accepted by the candidate." : (
                      <>
                        Waiting for the candidate to accept the Appointment Letter, sent from Stage 6.
                        {appointmentStage && <GhostButton style={{ marginLeft: 10 }} onClick={() => setActiveStep(appointmentStage.key)}>Go to Stage 6 →</GhostButton>}
                      </>
                    )}
                  </div>
                </div>
              </>
            );
          }
          return null;
        }
        const selStage = selected.stage;
        return (
          <>
            {selStage && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 14, textTransform: "uppercase", letterSpacing: 0.4 }}>Stage {selStage.order} — {selStage.name}</div>}
            {selected.node || (
              <div className="subtitle" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {selStage?.unlocked ? "Not reached yet." : <><LockRoundedIcon sx={{ fontSize: 14 }} /> Locked — complete the earlier stages first.</>}
              </div>
            )}
            {(selStage?.stageType === "EMPLOYEE_ACTIVATION" || selStage?.stageType === "ONBOARDING_ACTIVATION") && offer.status === "JOINING_CONFIRMED" && (
              <Panel title={isContractor ? "Contractor Active" : "Employee Active"} style={{ marginTop: 14 }}>
                {isContractor ? "Contractor" : "Employee"} ID <b>{offer.reservedEmpNo}</b> is now active. <Link to="/employees">View in Employee master →</Link>
              </Panel>
            )}
          </>
        );
      })()}

      {/* Wizard navigation — Back always allowed (review only); Next only moves on once the
          selected stage is actually done, so HR can't skip ahead past real, unfinished work.
          `stage.done` is the server's already override-aware resolution (engine/workflow.ts's
          getOfferStageStatus) — read it directly rather than re-deriving the same overrides here a
          second time, which drifted out of sync with the server's own logic before (e.g. missed
          CAPTURE_INFORMATION's Corp-to-Corp case entirely, leaving Stage 1 permanently "not done"). */}
      {!TERMINAL.includes(offer.status) && orderedStages.length > 0 && (() => {
        const stageDone = (stage: any) => !!stage?.done;
        const canAdvance = stageDone(orderedStages[effectiveIdx]);
        return (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
            <GhostButton icon={<ChevronLeftRoundedIcon />} disabled={effectiveIdx <= 0} onClick={() => setActiveStep(orderedStages[Math.max(0, effectiveIdx - 1)]?.key || null)}>Back</GhostButton>
            <div className="subtitle" style={{ margin: 0 }}>Stage {effectiveIdx + 1} of {orderedStages.length}</div>
            <GhostButton
              disabled={effectiveIdx < 0 || effectiveIdx >= orderedStages.length - 1 || !canAdvance}
              title={!canAdvance ? "Finish this stage before moving on" : undefined}
              onClick={() => setActiveStep(orderedStages[Math.min(orderedStages.length - 1, effectiveIdx + 1)]?.key || null)}
              icon={<ChevronRightRoundedIcon />}>Next</GhostButton>
          </div>
        );
      })()}
        </div>
      </div>
    </div>
  );
}

// Per-employee salary-component override — applies ONLY to this offer's active version
// (never touches the HR Settings master bracket). Matches spec §10 "Customize Offer".
function CustomizeSalaryPanel({ offerId, version, money, canEdit, onSaved }: any) {
  const { show } = useToast();
  const [editing, setEditing] = useState(false);
  const [pcts, setPcts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  // A 0%-of-CTC component is configured but not applicable here — never shown during offer
  // generation/customization (same rule the Offer/Appointment PDFs apply in engine/hrPdf.ts).
  const visibleComponents = version.salaryBreakup.components.filter((c: any) => c.pct !== 0);
  const startEdit = () => {
    const init: Record<string, number> = {};
    visibleComponents.forEach((c: any) => (init[c.name] = c.pct));
    setPcts(init); setEditing(true);
  };
  const totalPct = Object.values(pcts).reduce((s, n) => s + (Number(n) || 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      const overrides: Record<string, { pct: number }> = {};
      Object.entries(pcts).forEach(([name, pct]) => (overrides[name] = { pct: Number(pct) || 0 }));
      await api.put(`/hr/offers/${offerId}/customize`, { overrides });
      show("Customization saved — applies to this offer only"); setEditing(false); onSaved();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Panel title={`Salary Breakup — ${version.bracketName}${version.overrides ? " (customized)" : ""}`}>
      <table><thead><tr><th>Component</th><th className="num">%</th><th className="num">Monthly</th><th className="num">Annual</th></tr></thead>
        <tbody>
          {visibleComponents.map((c: any) => (
            <tr key={c.name}>
              <td>{c.name} <span className="pill">{c.part === "A" ? "Fixed" : "Flexi"}</span></td>
              <td className="num">
                {editing ? (
                  <input type="number" step="0.01" value={pcts[c.name] ?? c.pct} style={{ width: 70, textAlign: "right" }}
                    onChange={(e) => setPcts((p) => ({ ...p, [c.name]: Number(e.target.value) }))} />
                ) : `${c.pct}%`}
              </td>
              <td className="num">{money(c.monthly)}</td><td className="num">{money(c.annual)}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700 }}><td>Total CTC</td><td className="num">{editing ? `${totalPct.toFixed(2)}%` : ""}</td><td className="num">{money(version.salaryBreakup.totalMonthly)}</td><td className="num">{money(version.salaryBreakup.totalAnnual)}</td></tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
        Tax (annual): {money(version.taxCalc.totalTax)} · Net monthly take-home: {money(version.taxCalc.netMonthly)}
      </div>
      {canEdit && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
          {!editing ? (
            <GhostButton onClick={startEdit}>Customize Offer</GhostButton>
          ) : (
            <>
              <AddButton disabled={busy} onClick={save}>Save Customization</AddButton>
              <GhostButton disabled={busy} onClick={() => setEditing(false)}>Cancel</GhostButton>
              {Math.abs(totalPct - 100) > 0.01 && <span style={{ fontSize: 11, color: "var(--warn)" }}>Components total {totalPct.toFixed(2)}% of CTC — doesn't have to be exactly 100%, but usually should be.</span>}
            </>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>Customizing changes this offer's own version only — the master CTC bracket in HR Settings is never touched, and every change is recorded in the audit trail below.</div>
    </Panel>
  );
}

// Section 12.1 — on the plain-email delivery path, HR must upload the candidate's countersigned
// document before Confirm Acceptance is even clickable (server also enforces this — see
// POST /offers/:id/accept / /service-agreement/confirm-acceptance — this is the UI reflecting the
// same rule, not the only guard).
// `contractor`: this same panel renders under BOTH the Offer Letter's own "Offer Accepted" stage
// AND, for Contractor/Intern, the "SLA Accepted" stage tab (OFFER_ACCEPTANCE stageType is shared
// by both workflows) — without branching here, a Contractor's HR would be confirming acceptance
// of a nonexistent "Offer Letter" (via /offers/:id/accept, storing into offer.signedOfferFileData)
// while the Service Agreement's own `status`/`signedFileData` — what IT Provisioning and Confirm
// Joining actually gate on — silently never gets touched. This was a real, reported bug: HR
// manually confirmed acceptance and uploaded the signed SLA here, saw "Acceptance recorded", but
// Send to IT still rejected with "Service Agreement acceptance has been confirmed" because nothing
// had actually updated `serviceAgreement.status`.
function AcceptancePanel({ offer, onDone, busy, setBusy, contractor }: any) {
  const offerId = offer.id;
  const { show } = useToast();
  // Config-driven (HR Settings -> Workflow & Stage Configuration, Record Acceptance section of
  // the Offer Acceptance stage) — same enabled/mandatory pattern as every other real form here.
  // Previously had no config wiring at all.
  const { data: fieldConfig } = useFetch<any[]>(`/hr/offers/${offerId}/stage-field-config/OFFER_ACCEPTANCE`);
  const fieldOn = (key: string) => !fieldConfig || (fieldConfig.find((f) => f.key === key)?.enabled !== false);
  const fieldReq = (key: string) => !!fieldConfig?.find((f) => f.key === key)?.mandatory;
  const [method, setMethod] = useState("EMAIL_REPLY");
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const docLabel = contractor ? (offer.employmentType === "INTERN" ? "Internship Letter" : "Service Agreement") : "Offer Letter";
  const signedPath = contractor ? "service-agreement/signed" : "signed-offer";
  const acceptPath = contractor ? "service-agreement/confirm-acceptance" : "accept";
  const signedFileName = contractor ? offer.serviceAgreement?.signedFileName : offer.signedOfferFileName;
  const signedUploadedAt = contractor ? offer.serviceAgreement?.signedUploadedAt : offer.signedOfferUploadedAt;
  const hasSignedDoc = !!signedFileName;
  const uploadSigned = async (file: File) => {
    setUploading(true);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/hr/offers/${offerId}/${signedPath}`, { fileName: file.name, fileData });
      show(`Signed ${docLabel.toLowerCase()} uploaded`); onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setUploading(false); }
  };
  const accept = async () => {
    setBusy(true);
    try { await api.post(`/hr/offers/${offerId}/${acceptPath}`, { acceptanceMethod: method, acceptanceNote: note }); show("Acceptance recorded"); onDone(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Only "decline" has an SLA-specific variant (also flips serviceAgreement.status so Confirm
  // Joining's own declined-check sees it) — "withdraw" is a broader candidacy concept with a
  // single generic /offers/:id/withdraw route shared by every employment type.
  const closeAs = async (path: string) => { setBusy(true); try { await api.post(`/hr/offers/${offerId}/${contractor && path === "decline" ? "service-agreement/" : ""}${path}`, {}); onDone(); } finally { setBusy(false); } };
  const acceptanceOrder = (fieldConfig || []).map((f: any) => f.key);
  return (
    <Panel title="Record Candidate Acceptance" style={{ marginTop: 14 }}>
      {orderedFields([
        { key: "signedDocument", node: (
          <div key="signedDocument" style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: `1px solid ${hasSignedDoc ? "var(--border)" : "var(--bad)"}`, marginBottom: 12 }}>
            <div style={{ flex: 1, fontSize: 13 }}>
              <strong>Signed {docLabel}</strong>{hasSignedDoc ? ` — ${signedFileName}` : " — required before Confirm Acceptance"}
              {signedUploadedAt && <div style={{ fontSize: 11, color: "var(--muted)" }}>Uploaded {fmtDateTime(signedUploadedAt)}</div>}
            </div>
            {hasSignedDoc && <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${offerId}/${signedPath}`), "_blank")}>View</GhostButton>}
            <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
              {uploading ? "Uploading…" : hasSignedDoc ? "Replace" : "Upload"}
              <input type="file" style={{ display: "none" }} disabled={uploading}
                onChange={(e) => { const f2 = e.target.files?.[0]; if (f2) uploadSigned(f2); e.target.value = ""; }} />
            </label>
          </div>
        ) },
        // Previously Employee-only — Contractor's acceptance tracking deserves the same method/
        // notes capture the Workflow Builder catalog already exposed for it.
        { key: "acceptanceMethod", node: fieldOn("acceptanceMethod") && <SelectField key="acceptanceMethod" label="How did the candidate accept?" required={fieldReq("acceptanceMethod")} value={method} onChange={(e: any) => setMethod(e.target.value)} options={[
          { value: "EMAIL_REPLY", label: "Replied to the offer email" },
          { value: "SELF_SERVE_LINK", label: "Self-serve link" },
          { value: "PHONE", label: "Verbal / phone" },
          { value: "SIGNED_COPY", label: "Signed physical copy" },
        ]} /> },
        { key: "acceptanceNote", node: fieldOn("acceptanceNote") && <Field key="acceptanceNote" label="Notes" required={fieldReq("acceptanceNote")} value={note} onChange={(e: any) => setNote(e.target.value)} /> },
      ], acceptanceOrder)}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <AddButton disabled={busy || !hasSignedDoc} title={!hasSignedDoc ? `Upload the signed ${docLabel.toLowerCase()} first` : undefined} onClick={accept}>Confirm Acceptance</AddButton>
        <GhostButton disabled={busy} onClick={() => closeAs("decline")}>Candidate Declined</GhostButton>
        <GhostButton disabled={busy} onClick={() => closeAs("withdraw")}>Withdrawn</GhostButton>
      </div>
    </Panel>
  );
}

// `regenerate` (with `initial` pre-fill from the existing appointment letter's own dynamicFields)
// => same form, reused for both the first-ever generate (offer just ACCEPTED, no data yet) and
// a later regenerate (APPOINTMENT_GENERATED/PREVIEWED) — /appointment/generate already upserts,
// so submitting again with edited values simply replaces the letter's dynamic fields in place.
const EMPLOYMENT_TYPE_OPTIONS = ["Full Time", "Part Time", "Intern"].map((v) => ({ value: v, label: v }));
const WORK_LOCATION_OPTIONS = [{ value: "Office", label: "Office" }, { value: "Hybrid", label: "Hybrid" }, { value: "Remote", label: "Remote" }];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// US/Canada Vendor/Contractor engagement (Offer.vendorName set) — MSA + SOW, the one-per-row
// Preview / Email / Send for Digital Signature / Upload Signed Copy actions from the US/Canada
// onboarding design. "Send for Digital Signature" reuses the exact same Adobe Sign pipeline as the
// India Offer/Appointment/Service Agreement (EsignPanel, unmodified) — just a new docType.
function MsaSowDocRow({ offer, docType, label }: { offer: any; docType: "MSA" | "SOW"; label: string }) {
  const { show } = useToast();
  const [emailing, setEmailing] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const preview = () => window.open(api.pdfUrl(`/hr/offers/${offer.id}/preview/${docType}`), "_blank");
  const sendEmail = async () => {
    if (!emailTo.trim()) return;
    setBusy(true);
    try { await api.post(`/hr/offers/${offer.id}/email/${docType}`, { to: emailTo.trim() }); show(`${label} emailed`); setEmailing(false); setEmailTo(""); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const uploadSigned = async (file: File) => {
    setBusy(true);
    try { await api.post(`/hr/offers/${offer.id}/signed/${docType}`, { fileName: file.name, fileData: await fileToBase64(file) }); show(`Signed ${label} uploaded`); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <GhostButton icon={<VisibilityRoundedIcon />} onClick={preview}>Preview</GhostButton>
        <GhostButton disabled={busy} onClick={() => setEmailing((x) => !x)}>Email</GhostButton>
        <GhostButton disabled={busy} onClick={() => uploadRef.current?.click()}>Upload Signed Copy</GhostButton>
        <input ref={uploadRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSigned(f); e.target.value = ""; }} />
      </div>
      {emailing && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <input type="email" placeholder="recipient@example.com" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} style={{ width: 240 }} />
          <AddButton disabled={busy || !emailTo.trim()} onClick={sendEmail}>Send</AddButton>
        </div>
      )}
      <EsignPanel docType={docType} docId={offer.id} sendLabel={`Send ${label} for Digital Signature`} sendIcon={<DrawRoundedIcon />} />
    </div>
  );
}

function MsaSowAgreementPanel({ offer }: { offer: any }) {
  if (!offer?.vendorName) return null;
  return (
    <Panel title="Agreement & Signature" style={{ marginBottom: 14 }}>
      <div className="subtitle" style={{ marginTop: -6, marginBottom: 4 }}>
        Vendor/Contractor engagement — Master Services Agreement with {offer.vendorName}, and a Statement of Work for this placement. Both must show Signed before Onboarding Activation.
      </div>
      <MsaSowDocRow offer={offer} docType="MSA" label="Master Services Agreement (MSA)" />
      <MsaSowDocRow offer={offer} docType="SOW" label="Statement of Work (SOW)" />
    </Panel>
  );
}

function AppointmentGeneratePanel({ offer, onDone, busy, setBusy, initial, regenerate, onCancel }: any) {
  const { show } = useToast();
  const i = initial || {};
  // Which of these fields even show up, and which are required — config-driven (HR Settings ->
  // Workflow & Stage Configuration, Appointment Generation stage), same pattern as Generate Offer.
  const { data: fieldConfig } = useFetch<any[]>(`/hr/offers/${offer.id}/stage-field-config/APPOINTMENT_GENERATION`);
  const fieldCfg = (key: string) => (fieldConfig || []).find((f) => f.key === key);
  const fieldOn = (key: string) => !fieldConfig || fieldCfg(key)?.enabled !== false;
  const [resumeBusy, setResumeBusy] = useState(false);
  const uploadResume = async (file: File) => {
    setResumeBusy(true);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/hr/offers/${offer.id}/resume`, { fileName: file.name, fileData });
      show("Resume uploaded"); onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setResumeBusy(false); }
  };
  const { data: departments } = useFetch<any[]>("/hr-settings/departments");
  const { data: allEmployees } = useFetch<any[]>("/employees");
  const { data: nextEmpNo } = useFetch<any>(regenerate ? "/health" : `/hr/offers/${offer.id}/next-emp-no`);
  const activeEmployees = (allEmployees || []).filter((e: any) => !e.exitDate);
  const [f, setF] = useState({
    reportingManager: i.ReportingManager || "", workLocation: i.WorkLocation || "Office", department: i.Department || "",
    employmentType: i.EmploymentType || "Full Time", noticePeriod: i.NoticePeriod || "2 Months", probationPeriod: i.ProbationPeriod || "2 Months",
    issuanceTiming: offer.appointmentLetter?.issuanceTiming || "ON_JOINING",
    empNo: offer.reservedEmpNo || "",
    emergencyContactPhone: i.EmergencyContactPhone || "",
  });
  const [empNoTouched, setEmpNoTouched] = useState(false);
  // Pre-fill the Employee ID box with the next auto-generated code once it loads — HR can still
  // type over it (checked for uniqueness server-side); a regenerate already has a real one via
  // offer.reservedEmpNo above and never overwrites it with a fresh suggestion.
  React.useEffect(() => {
    if (!regenerate && !empNoTouched && nextEmpNo?.empNo) setF((cur) => ({ ...cur, empNo: nextEmpNo.empNo }));
  }, [nextEmpNo, regenerate, empNoTouched]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const generate = async () => {
    if (!f.emergencyContactPhone.trim()) return show("Emergency Contact Number is required", "error");
    const missing = (fieldConfig || []).filter((c: any) => c.mandatory && c.key !== "emergencyContactPhone" && !String((f as any)[c.key] || "").trim());
    if (missing.length) return show(`${missing.map((m: any) => m.label).join(", ")} required`, "error");
    setBusy(true);
    try {
      await api.post(`/hr/offers/${offer.id}/appointment/generate`, f);
      show(regenerate ? "Appointment letter regenerated" : "Appointment letter generated — Employee ID created (hidden)");
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const appointmentOrder = (fieldConfig || []).map((c: any) => c.key);
  return (
    <Panel title={regenerate ? "Regenerate Appointment Letter" : "Generate Appointment Letter"} style={{ marginTop: 14 }}>
      {orderedFields([
        // Mandatory before HR can generate — see the server-side guard in
        // /offers/:id/appointment/generate.
        { key: "resume", node: (
          <div key="resume" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: 10, borderRadius: 8, border: `1px solid ${offer.resumeFileName ? "var(--border)" : "var(--bad)"}` }}>
            <div style={{ flex: 1, fontSize: 13 }}>
              {offer.resumeFileName
                ? <>✓ Resume on file: <b>{offer.resumeFileName}</b> <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${offer.id}/resume`), "_blank")}>Preview</GhostButton></>
                : <span style={{ color: "var(--bad)" }}>⚠ Resume required — upload the candidate's resume before generating the Appointment Letter.</span>}
            </div>
            <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
              {resumeBusy ? "Uploading…" : offer.resumeFileName ? "Re-upload" : "Upload Resume"}
              <input type="file" style={{ display: "none" }} disabled={resumeBusy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadResume(f); e.target.value = ""; }} />
            </label>
          </div>
        ) },
        { key: "formGrid", node: (
          <div key="formGrid" className="form-grid">
            {orderedFields([
              { key: "empNo", node: fieldOn("empNo") && <Field key="empNo" label="Employee ID" value={f.empNo} onChange={(e: any) => { setEmpNoTouched(true); setF({ ...f, empNo: e.target.value }); }}
                placeholder={nextEmpNo?.empNo || "Auto-generated"} /> },
              { key: "emergencyContactPhone", node: <Field key="emergencyContactPhone" label="Emergency Contact Number" required value={f.emergencyContactPhone} onChange={set("emergencyContactPhone")} placeholder="e.g. +91 98765 43210" /> },
              { key: "reportingManager", node: fieldOn("reportingManager") && <SelectField key="reportingManager" label="Reporting Manager" required={!!fieldCfg("reportingManager")?.mandatory} value={f.reportingManager} onChange={set("reportingManager")}
                options={[{ value: "", label: "— select —" }, ...activeEmployees.map((e: any) => ({ value: e.name, label: `${e.name}${e.empNo ? ` (${e.empNo})` : ""}` }))]} /> },
              { key: "workLocation", node: fieldOn("workLocation") && <SelectField key="workLocation" label="Work Location" required={!!fieldCfg("workLocation")?.mandatory} value={f.workLocation} onChange={set("workLocation")} options={WORK_LOCATION_OPTIONS} /> },
              { key: "department", node: fieldOn("department") && <SelectField key="department" label="Department" required={!!fieldCfg("department")?.mandatory} value={f.department} onChange={set("department")}
                options={[{ value: "", label: "— select —" }, ...(departments || []).map((d: any) => ({ value: d.name, label: d.name }))]} /> },
              { key: "employmentType", node: fieldOn("employmentType") && <SelectField key="employmentType" label="Employment Type" required={!!fieldCfg("employmentType")?.mandatory} value={f.employmentType} onChange={set("employmentType")} options={EMPLOYMENT_TYPE_OPTIONS} /> },
              { key: "noticePeriod", node: fieldOn("noticePeriod") && <SelectField key="noticePeriod" label="Notice Period" required={!!fieldCfg("noticePeriod")?.mandatory} value={f.noticePeriod} onChange={set("noticePeriod")} options={PERIOD_OPTIONS} /> },
              { key: "probationPeriod", node: fieldOn("probationPeriod") && <SelectField key="probationPeriod" label="Probation Period" required={!!fieldCfg("probationPeriod")?.mandatory} value={f.probationPeriod} onChange={set("probationPeriod")} options={PERIOD_OPTIONS} /> },
            ], appointmentOrder)}
          </div>
        ) },
      ], appointmentOrder)}
      <div style={{ fontSize: 11, color: "var(--muted)", margin: "8px 0" }}>
        {regenerate ? "Change what's needed and regenerate — the same reserved Employee ID is kept, only the letter's content is replaced." : "Employee ID is auto-generated and unique-checked on submit — edit it only if you specifically need a different code."}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <AddButton disabled={busy || !offer.resumeFileName} title={!offer.resumeFileName ? "Upload the candidate's resume first" : undefined} onClick={generate}>
          {regenerate ? "Regenerate Appointment Letter" : "Generate Appointment Letter"}
        </AddButton>
        {regenerate && <GhostButton disabled={busy} onClick={onCancel}>Cancel</GhostButton>}
      </div>
    </Panel>
  );
}

// `contractor` relabels this panel for the CONTRACTOR flow (no appointment-letter stage — this
// is reached directly from ACCEPTED) — same underlying /confirm-joining call either way, which
// branches server-side on offer.employmentType. Omitting the prop (EMPLOYEE) keeps every label
// exactly as before.
// Locked (read-only) field — same visual as the Employee field in Masters.tsx's own "Add CTC
// Record" modal when the employee is pre-selected: label + bold static value, no input.
function ReadOnlyField({ label, value }: { label: string; value: any }) {
  return <div><label>{label}</label><div style={{ fontWeight: 600 }}>{value}</div></div>;
}
const CTC_LOCATION_LABEL: Record<string, string> = { INDIA: "India (INR salary)", US: "United States (USD)", CANADA: "Canada (CAD)" };

// `firstname.lastname@genaquarius.com` — matches how every real mailbox in this app is named
// (hr@, sandeep.minocha@, anil.singh@) — just a starting suggestion, HR can edit it before sending.
function suggestEmail(name: string): string {
  const parts = String(name || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts.length ? `${parts.join(".")}@genaquarius.com` : "";
}

// HR's new-hire IT setup request — only reachable once acceptance is confirmed (shown by the
// caller, ConfirmJoiningPanel, only when `accepted`). Notifies the IT admin contact configured in
// Settings → External Integrations → System Settings with hardware/OS/email-id details plus the
// candidate's already-known info (name, designation, reporting manager, phone, joining date).
function ItProvisioningPanel({ offer, contractor }: { offer: any; contractor?: boolean }) {
  const { show } = useToast();
  // Config-driven (HR Settings -> Workflow & Stage Configuration, IT Provisioning stage) — same
  // pattern as Generate Offer/Appointment Generation. Email/OS/Laptop Configuration are hard
  // server-side requirements (see POST /offers/:id/it-provisioning) so always shown; Phone Number
  // is the one genuinely optional field here.
  const { data: fieldConfig } = useFetch<any[]>(`/hr/offers/${offer.id}/stage-field-config/IT_PROVISIONING`);
  const fieldOn = (key: string) => !fieldConfig || (fieldConfig.find((f) => f.key === key)?.enabled !== false);
  const existing = offer.itProvisioningRequest;
  // Defaults to "16 GB" (HR request) rather than a separate RAM field — still fully editable/
  // extendable, e.g. "16 GB, i5, 512GB SSD".
  const [laptopConfiguration, setLaptopConfiguration] = useState(existing?.laptopConfiguration || "16 GB");
  const [osRequirement, setOsRequirement] = useState(existing?.osRequirement || "Windows 11");
  const [emailIdToCreate, setEmailIdToCreate] = useState(existing?.emailIdToCreate || suggestEmail(offer.candidateName));
  const [phoneNumber, setPhoneNumber] = useState(existing?.phoneNumber || offer.candidatePhone || "");
  // Section 6.2 — Requested Applications/Access/Other Requirements are IT Provisioning fields,
  // config-driven enabled/mandatory pattern.
  const [requiredApplications, setRequiredApplications] = useState(existing?.requiredApplications || "");
  const [requiredAccess, setRequiredAccess] = useState(existing?.requiredAccess || "");
  const [otherRequirements, setOtherRequirements] = useState(existing?.otherRequirements || "");
  const [editing, setEditing] = useState(!existing?.sentAt);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!laptopConfiguration || !osRequirement || !emailIdToCreate) return show("Laptop configuration, OS requirement and Email ID to create are required.", "error");
    setBusy(true);
    try {
      const r: any = await api.post(`/hr/offers/${offer.id}/it-provisioning`, { laptopConfiguration, osRequirement, emailIdToCreate, phoneNumber, requiredApplications, requiredAccess, otherRequirements });
      if (r?.emailWarning) show(r.emailWarning, "error"); else show("IT provisioning request sent");
      setEditing(false);
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Ship-to address for the laptop/equipment — the Resident (current) Address, or Permanent
  // Address when the candidate never filled a separate one in at Offer Generation.
  const shipToAddress = [
    offer.residentSameAsPermanent ? offer.candidateAddress : offer.residentAddress,
    offer.residentSameAsPermanent ? offer.candidateLandmark : offer.residentLandmark,
    offer.residentSameAsPermanent ? offer.candidateCity : offer.residentCity,
    offer.residentSameAsPermanent ? offer.candidateState : offer.residentState,
    offer.residentSameAsPermanent ? offer.candidatePincode : offer.residentPincode,
  ].filter(Boolean).join(", ");
  const itOrder = (fieldConfig || []).map((f) => f.key);
  return (
    <Panel title="IT Provisioning Request" style={{ marginTop: 14 }}>
      <div className="note">Notifies IT to set up a laptop and email account ahead of {contractor ? "the contractor's" : "the employee's"} joining date.</div>
      <table style={{ marginTop: 8 }}><tbody>
        {orderedFields([
          { key: "firstName", node: fieldOn("firstName") && <tr key="firstName"><td>First Name</td><td className="num">{offer.candidateFirstName || "—"}</td></tr> },
          { key: "lastName", node: fieldOn("lastName") && <tr key="lastName"><td>Last Name</td><td className="num">{offer.candidateLastName || "—"}</td></tr> },
          { key: "candidateName", node: fieldOn("candidateName") && <tr key="candidateName"><td>Candidate Name</td><td className="num">{offer.candidateName}</td></tr> },
          { key: "personalEmail", node: fieldOn("personalEmail") && <tr key="personalEmail"><td>Official Email</td><td className="num">{offer.candidateEmail}</td></tr> },
          { key: "jobTitle", node: fieldOn("jobTitle") && <tr key="jobTitle"><td>Job Title</td><td className="num">{offer.designation}</td></tr> },
          { key: "department", node: fieldOn("department") && <tr key="department"><td>Department</td><td className="num">{offer.department || "—"}</td></tr> },
          { key: "reportingManagerContext", node: fieldOn("reportingManagerContext") && <tr key="reportingManagerContext"><td>Reporting Manager</td><td className="num">{offer.reportingManager || "—"}</td></tr> },
          { key: "proposedJoiningDateContext", node: fieldOn("proposedJoiningDateContext") && <tr key="proposedJoiningDateContext"><td>Proposed Joining Date</td><td className="num">{offer.proposedJoiningDate ? fmtDate(offer.proposedJoiningDate) : "—"}</td></tr> },
          { key: "shipToAddress", node: fieldOn("shipToAddress") && <tr key="shipToAddress"><td>Address (for equipment shipping)</td><td className="num">{shipToAddress || "—"}</td></tr> },
        ], itOrder)}
      </tbody></table>
      {editing ? (
        <>
          <div className="form-grid" style={{ marginTop: 10 }}>
            {orderedFields([
              { key: "phoneNumber", node: fieldOn("phoneNumber") && <Field key="phoneNumber" label="Phone Number" value={phoneNumber} onChange={(e: any) => setPhoneNumber(e.target.value)} /> },
              { key: "emailIdToCreate", node: <Field key="emailIdToCreate" label="Email ID to Create" required value={emailIdToCreate} onChange={(e: any) => setEmailIdToCreate(e.target.value)} /> },
              { key: "osRequirement", node: <SelectField key="osRequirement" label="OS Requirement" required value={osRequirement} onChange={(e: any) => setOsRequirement(e.target.value)}
                options={[{ value: "Windows 11", label: "Windows 11" }, { value: "Windows 10", label: "Windows 10" }, { value: "macOS", label: "macOS" }, { value: "Linux", label: "Linux" }, { value: "Other", label: "Other" }]} /> },
              { key: "laptopConfiguration", node: <Field key="laptopConfiguration" label="Laptop Configuration" required value={laptopConfiguration} onChange={(e: any) => setLaptopConfiguration(e.target.value)} placeholder="e.g. 16 GB, i5, 512GB SSD" /> },
              { key: "requiredApplications", node: fieldOn("requiredApplications") && <Field key="requiredApplications" label="Requested Applications" value={requiredApplications} onChange={(e: any) => setRequiredApplications(e.target.value)} placeholder="e.g. MS Office, VS Code" /> },
              { key: "requiredAccess", node: fieldOn("requiredAccess") && <Field key="requiredAccess" label="Access Requirements" value={requiredAccess} onChange={(e: any) => setRequiredAccess(e.target.value)} placeholder="e.g. GitHub, VPN" /> },
              { key: "otherRequirements", node: fieldOn("otherRequirements") && <Field key="otherRequirements" label="Other Hardware/Software Requirements" value={otherRequirements} onChange={(e: any) => setOtherRequirements(e.target.value)} /> },
            ], itOrder)}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <AddButton disabled={busy} onClick={send}>{existing?.sentAt ? "Resend to IT" : "Send to IT"}</AddButton>
            {existing?.sentAt && <GhostButton disabled={busy} onClick={() => setEditing(false)}>Cancel</GhostButton>}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <span className="pill good">Sent to IT {existing?.sentAt ? fmtDateTime(existing.sentAt) : ""}</span>
          <GhostButton disabled={busy} onClick={() => setEditing(true)}>Edit / Resend</GhostButton>
        </div>
      )}
    </Panel>
  );
}

export function ConfirmJoiningPanel({ offer, projects, onDone, onReload, busy, setBusy, contractor, hideItProvisioning }: any) {
  const { show } = useToast();
  // Config-driven (HR Settings -> Workflow & Stage Configuration, Employee Activation stage) — the
  // dates are all hard server-side requirements (POST /offers/:id/confirm-joining) so always shown;
  // Project/Billable/CTC Effective Till are the genuinely optional fields here.
  const { data: activationFieldConfig } = useFetch<any[]>(`/hr/offers/${offer.id}/stage-field-config/EMPLOYEE_ACTIVATION`);
  const activationFieldOn = (key: string) => !activationFieldConfig || (activationFieldConfig.find((f) => f.key === key)?.enabled !== false);
  const activationFieldMandatory = (key: string) => !!activationFieldConfig?.find((f) => f.key === key)?.mandatory;
  const { user } = useAuth();
  const masked = useMaskNumbers(user?.id);
  // Confirm Joining is gated on the candidate having actually confirmed acceptance of the
  // Appointment Letter (Employee) / Service Agreement (Contractor) — either automatically via
  // Adobe Sign, or manually here for the plain-email flow. Generating/issuing the document is NOT
  // the same as the candidate confirming it, so this is checked independently of offer.status.
  // EMPLOYEE: only actually required if an Appointment Letter already exists — the default
  // workflow order generates it AFTER activation, so there's nothing to accept yet at this point
  // and this precondition is simply not in play (the real gate is server-side, engine/workflow.ts,
  // driven by Document Collection + IT Provisioning instead — see the Activate button below).
  const acceptanceApplies = contractor || !!offer.appointmentLetter;
  const acceptDocType = contractor ? "SERVICE_AGREEMENT" : "APPOINTMENT_LETTER";
  const acceptance = contractor ? offer.serviceAgreementAcceptance : offer.appointmentAcceptance;
  const { data: acceptEsign } = useFetch<any>(`/adobe-sign/status/${acceptDocType}/${offer.id}`);
  const digitalInUse = acceptEsign && acceptEsign.status !== "NOT_SENT";
  const accepted = acceptanceApplies ? acceptance?.status === "ACCEPTED" : true;
  const declined = acceptanceApplies ? acceptance?.status === "DECLINED" : false;
  const itProvisioningSent = !!offer.itProvisioningRequest?.sentAt;
  const reloadKeepSelection = onReload || onDone;
  // Upload a copy already signed outside this app (paper signature, etc.) — lets HR skip
  // Issue/Send and e-sign entirely and go straight to Confirm Acceptance below. Same convention
  // as the Offer Letter's own AcceptancePanel upload, just for whichever of Appointment
  // Letter/Service Agreement applies to this offer.
  const signedDoc = contractor ? offer.serviceAgreement : offer.appointmentLetter;
  const signedDocPath = contractor ? "service-agreement/signed" : "appointment/signed";
  const [uploadingSigned, setUploadingSigned] = useState(false);
  const uploadSignedDoc = async (file: File) => {
    setUploadingSigned(true);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/hr/offers/${offer.id}/${signedDocPath}`, { fileName: file.name, fileData });
      show(`Signed ${contractor ? "Service Agreement" : "appointment letter"} uploaded`); reloadKeepSelection();
    } catch (e: any) { show(e.message, "error"); } finally { setUploadingSigned(false); }
  };
  const deleteSignedDoc = async () => {
    if (!window.confirm("Remove the uploaded signed document?")) return;
    try { await api.del(`/hr/offers/${offer.id}/${signedDocPath}`); show("Removed"); reloadKeepSelection(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const manualConfirmAcceptance = async () => {
    setBusy(true);
    try {
      await api.post(`/hr/offers/${offer.id}/${contractor ? "service-agreement" : "appointment"}/confirm-acceptance`);
      show("Acceptance confirmed"); reloadKeepSelection();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const manualDecline = async () => {
    if (!window.confirm(`Record the ${contractor ? "Service Agreement" : "Appointment Letter"} as declined?`)) return;
    setBusy(true);
    try {
      await api.post(`/hr/offers/${offer.id}/${contractor ? "service-agreement" : "appointment"}/decline`);
      show("Recorded as declined"); reloadKeepSelection();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const [actualJoiningDate, setDate] = useState(offer.proposedJoiningDate?.slice(0, 10) || new Date().toISOString().slice(0, 10));
  const [projectId, setProjectId] = useState("");
  // Same fields "Add Line to Monthly Sheet" (Operations) exposes — collected here so activation
  // adds the Monthly Sheet line itself instead of leaving HR to do it by hand afterward.
  const [deploymentStart, setDeploymentStart] = useState("");
  const [deploymentEnd, setDeploymentEnd] = useState("");
  const [isBillable, setIsBillable] = useState(false);
  // Bench isn't a client engagement — a resource sitting on Bench can never be billable, so force
  // (and lock) the checkbox off whenever no real project is picked.
  useEffect(() => { if (!projectId) setIsBillable(false); }, [projectId]);
  // The CTC Record activation will create — read-only preview of the offer's own approved salary
  // breakup (same buildCtcComponentsFromBreakup() the server uses to actually create it, so this
  // can never show something different from what gets saved). Effective From / Till are the only
  // fields HR can adjust here — everything else (amounts, location, employment type) is locked.
  const { data: ctcPreview } = useFetch<any>(`/hr/offers/${offer.id}/ctc-preview`);
  const [ctcEffectiveFrom, setCtcEffectiveFrom] = useState(offer.proposedJoiningDate?.slice(0, 10) || new Date().toISOString().slice(0, 10));
  const [ctcEffectiveTill, setCtcEffectiveTill] = useState("");
  const ccy = ctcPreview?.currency === "USD" ? "$" : ctcPreview?.currency === "CAD" ? "C$" : "₹";
  const ctcMoney = (n: number) => masked ? "•••••" : ccy + Math.round(n || 0).toLocaleString("en-IN");
  const confirm = async () => {
    // Bench (no project selected) has no deployment window to bound — only require these when a
    // real Project is chosen.
    if (projectId && (!deploymentStart || !deploymentEnd)) return show("Deployment Start and Deployment End are required.", "error");
    if (activationFieldMandatory("projectId") && !projectId) return show("Project is required.", "error");
    if (activationFieldMandatory("ctcEffectiveTill") && !ctcEffectiveTill) return show("CTC Effective Till is required.", "error");
    setBusy(true);
    try {
      const r = await api.post(`/hr/offers/${offer.id}/confirm-joining`, {
        actualJoiningDate, projectId: projectId || undefined,
        deploymentStart: deploymentStart || undefined, deploymentEnd: deploymentEnd || undefined, isBillable,
        ctcEffectiveFrom: ctcEffectiveFrom || undefined, ctcEffectiveTill: ctcEffectiveTill || undefined,
      });
      const note = r.noCostToCompany ? " — No Cost to Company, no CTC approval needed" : r.notified > 0 ? ` — CTC submitted for Finance approval (notified ${r.notified} of ${r.totalRecipients})` : " — CTC submitted for Finance approval";
      show(`${contractor ? "Contractor" : "Employee"} ${r.employee.empNo} activated${note}`);
      onDone();
    }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Onboarding never became real — candidate didn't show up, failed background check, etc. Reuses
  // the same generic /withdraw the Acceptance panel already offers, just reachable from this later
  // stage too (the reserved Employee/Contractor code is simply never activated).
  const reject = async () => {
    const reason = window.prompt(`Reject onboarding for ${contractor ? "Contractor" : "Employee"} ID ${offer.reservedEmpNo}? Enter a reason (optional):`);
    if (reason === null) return;
    setBusy(true);
    try { await api.post(`/hr/offers/${offer.id}/withdraw`, { reason: reason || "Onboarding rejected by HR" }); show("Onboarding rejected"); onDone(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Panel title={contractor ? "Confirm Joining — Activate Contractor" : "Onboarding Activation"} style={{ marginTop: 14 }}>
      <div className="note">This is the action that activates {contractor ? "Contractor" : "Employee"} ID <b>{offer.reservedEmpNo}</b> — creates the Employee master record now; the CTC record and Monthly Sheet line are submitted to Finance for approval before they take effect.</div>
      {!accepted && (
        <div className="note" style={{ marginTop: 8, color: "var(--warn)" }}>
          {declined
            ? `The ${contractor ? "Service Agreement" : "Appointment Letter"} was declined — activation is blocked until this is resolved.`
            : digitalInUse
              ? `Confirmation Pending — waiting for the candidate to sign or decline via Adobe Sign (see the e-signature panel above). This updates automatically in real time.`
              : `Confirmation Pending — the candidate hasn't confirmed acceptance of the ${contractor ? "Service Agreement" : "Appointment Letter"} yet.`}
          {!digitalInUse && !declined && acceptanceApplies && (
            <>
              {/* Already have a signed copy from outside this app (paper signature, etc.)? Upload
                  it here and Confirm Acceptance works immediately — no need to Issue/Send first. */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: 8, border: "1px solid var(--border)", marginTop: 8, background: "var(--panel2)" }}>
                <div style={{ flex: 1, fontSize: 12.5 }}>
                  {signedDoc?.signedFileName
                    ? <>✓ Signed {contractor ? "Service Agreement" : "appointment letter"} on file: <b>{signedDoc.signedFileName}</b></>
                    : <span style={{ color: "var(--muted)" }}>No signed copy uploaded yet — optional if sending for e-signature/email instead.</span>}
                </div>
                {signedDoc?.signedFileName && <GhostButton onClick={() => window.open(api.pdfUrl(`/hr/offers/${offer.id}/${signedDocPath}`), "_blank")}>View</GhostButton>}
                {signedDoc?.signedFileName && <GhostButton onClick={deleteSignedDoc}>Remove</GhostButton>}
                <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                  {uploadingSigned ? "Uploading…" : signedDoc?.signedFileName ? "Replace" : "Upload Signed Copy"}
                  <input type="file" style={{ display: "none" }} disabled={uploadingSigned}
                    onChange={(e) => { const f2 = e.target.files?.[0]; if (f2) uploadSignedDoc(f2); e.target.value = ""; }} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <AddButton disabled={busy || !signedDoc?.signedFileName} title={!signedDoc?.signedFileName ? `Upload the signed ${contractor ? "Service Agreement" : "appointment letter"} first` : undefined} onClick={manualConfirmAcceptance}>Confirm Acceptance</AddButton>
                <GhostButton disabled={busy} onClick={manualDecline}>Record as Declined</GhostButton>
              </div>
            </>
          )}
        </div>
      )}
      {/* acceptance can be null here even when accepted===true — acceptanceApplies is false (no
          Appointment Letter generated yet, the default Employee workflow order) forces `accepted`
          true as a "nothing to wait on" bypass, not a real acceptance record — only show this line
          when there's an actual acceptance to report. */}
      {accepted && acceptance && (
        <div className="note" style={{ marginTop: 8, color: "var(--good)" }}>
          ✓ {contractor ? "Service Agreement" : "Appointment Letter"} accepted {acceptance.method === "ADOBE_SIGN" ? "digitally via Adobe Sign" : "(confirmed manually — email flow)"}.
        </div>
      )}
      {offer.ctcRejectedAt && (
        <div className="note" style={{ marginTop: 8, color: "var(--bad)" }}>
          ⚠ Finance previously rejected this candidate's CTC{offer.ctcRejectionNote ? `: "${offer.ctcRejectionNote}"` : ""} — double-check the CTC record before resubmitting.
        </div>
      )}
      {/* Skipped when embedded in the wizard's own Stage — IT Provisioning already has its own
          dedicated stage/tab there; the standalone Confirm Joining queue page (no per-stage tabs)
          still shows it here since that's its only place to send the request. */}
      {accepted && !hideItProvisioning && <ItProvisioningPanel offer={offer} contractor={contractor} />}
      {(() => {
        // Field ORDER within each grid below follows activationFieldConfig's own sequence (already
        // reflects any HR drag-to-reorder from the Workflow Builder's Configure panel) — the grid
        // split itself (dates needing a project vs. the CTC-approval block) and the interstitial
        // note/Employee readout stay fixed; only relative order WITHIN each grid is config-driven.
        const activationOrder = (activationFieldConfig || []).map((f: any) => f.key);
        return (
      <>
      <div className="form-grid" style={{ marginTop: 10 }}>
        {orderedFields([
          { key: "actualJoiningDate", node: <Field key="actualJoiningDate" label={contractor ? "Actual Start Date" : "Actual Joining Date"} required type="date" value={actualJoiningDate} onChange={(e: any) => setDate(e.target.value)} /> },
          { key: "projectId", node: activationFieldOn("projectId") && <SelectField key="projectId" label="Project" required={activationFieldMandatory("projectId")} value={projectId} onChange={(e: any) => setProjectId(e.target.value)} options={[{ value: "", label: "Bench (default)" }, ...projects.map((p: any) => ({ value: p.id, label: p.name }))]} /> },
        ], activationOrder)}
      </div>
      <div className="note" style={{ marginTop: 12 }}>CTC Record to be submitted for Finance approval — read-only (reflects the offer's approved salary breakup); only the dates below can be changed here:</div>
      <div className="form-grid" style={{ marginTop: 6 }}>
        <ReadOnlyField label="Employee" value={offer.candidateName} />
        {orderedFields([
          { key: "ctcEffectiveFrom", node: <Field key="ctcEffectiveFrom" label="Effective From" required type="date" value={ctcEffectiveFrom} onChange={(e: any) => setCtcEffectiveFrom(e.target.value)} /> },
          { key: "ctcEffectiveTill", node: activationFieldOn("ctcEffectiveTill") && <Field key="ctcEffectiveTill" label={`Effective Till${activationFieldMandatory("ctcEffectiveTill") ? "" : " (optional)"}`} required={activationFieldMandatory("ctcEffectiveTill")} type="date" value={ctcEffectiveTill} onChange={(e: any) => setCtcEffectiveTill(e.target.value)} /> },
          // Bench (no project selected) has no deployment window to bound — only required once a
          // real Project is chosen.
          { key: "deploymentStart", node: <Field key="deploymentStart" label={`Deployment Start${projectId ? "" : " (optional)"}`} required={!!projectId} type="date" value={deploymentStart} onChange={(e: any) => setDeploymentStart(e.target.value)} /> },
          { key: "deploymentEnd", node: <Field key="deploymentEnd" label={`Deployment End${projectId ? "" : " (optional)"}`} required={!!projectId} type="date" value={deploymentEnd} onChange={(e: any) => setDeploymentEnd(e.target.value)} /> },
          { key: "isBillable", node: activationFieldOn("isBillable") && (
            <label key="isBillable" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 22, opacity: projectId ? 1 : 0.5 }} title={projectId ? undefined : "Bench is not a client engagement — cannot be billable"}>
              <input type="checkbox" checked={isBillable} disabled={!projectId} onChange={(e) => setIsBillable(e.target.checked)} /> Billable
            </label>
          ) },
        ], activationOrder)}
        <ReadOnlyField label="Location" value={CTC_LOCATION_LABEL[ctcPreview?.location] || ctcPreview?.location || "—"} />
        <ReadOnlyField label="Employment Type" value={ctcPreview?.empType === "CONTRACTOR" ? "Contractor" : ctcPreview?.empType === "INTERN" ? "Intern" : "Full-Time"} />
        {ctcPreview?.noCostToCompany && <ReadOnlyField label="CTC" value="No Cost to Company — no CTC record will be created" />}
        {ctcPreview?.mode === "ANNUAL_OVERRIDE" && <ReadOnlyField label="Annual CTC" value={ctcMoney(ctcPreview.annualCostOverride)} />}
        {usesServiceAgreement(ctcPreview?.mode) && !ctcPreview?.noCostToCompany && <ReadOnlyField label="Monthly Cost (INR)" value={ctcMoney(ctcPreview.basic)} />}
        {usesServiceAgreement(ctcPreview?.mode) && !ctcPreview?.noCostToCompany && <ReadOnlyField label="Annualized CTC (INR)" value={ctcMoney((ctcPreview.basic || 0) * 12)} />}
        {ctcPreview?.mode === "INDIA_COMPONENTS" && <>
          <ReadOnlyField label="Basic" value={ctcMoney(ctcPreview.basic)} />
          <ReadOnlyField label="HRA" value={ctcMoney(ctcPreview.hra)} />
          <ReadOnlyField label="Other Allowance" value={ctcMoney(ctcPreview.otherAllowance)} />
          <ReadOnlyField label="Special Allowance" value={ctcMoney(ctcPreview.specialAllowance)} />
          <ReadOnlyField label="Conveyance / Fuel" value={ctcMoney(ctcPreview.conveyance)} />
          <ReadOnlyField label="Communication" value={ctcMoney(ctcPreview.communication)} />
          <ReadOnlyField label="Meals & Ent." value={ctcMoney(ctcPreview.meals)} />
          <ReadOnlyField label="Books & Periodicals" value={ctcMoney(ctcPreview.books)} />
          <ReadOnlyField label="Driver" value={ctcMoney(ctcPreview.driver)} />
          <ReadOnlyField label="Uniform" value={ctcMoney(ctcPreview.uniform)} />
          <ReadOnlyField label="Annual Bonus" value={ctcMoney(ctcPreview.bonusAnnual)} />
        </>}
      </div>
      </>
        );
      })()}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <AddButton disabled={busy || (!!projectId && (!deploymentStart || !deploymentEnd)) || !accepted || !itProvisioningSent}
          title={
            !accepted ? `Waiting for the candidate to confirm acceptance of the ${contractor ? "Service Agreement" : "Appointment Letter"} (digitally or via HR's manual confirmation above) before activation can proceed.`
            : !itProvisioningSent ? "Send the IT Provisioning Request above first — IT needs the setup details before this candidate is activated."
            : projectId && (!deploymentStart || !deploymentEnd) ? "Deployment Start and Deployment End are required when a Project is selected."
            : undefined
          }
          onClick={confirm}>{contractor ? "Confirm Joining & Activate Contractor" : "Confirm Joining & Activate Employee"}</AddButton>
        <GhostButton disabled={busy} onClick={reject}>Reject Onboarding</GhostButton>
      </div>
    </Panel>
  );
}

// Contractor's "Generate Service Agreement" form — monthly compensation, effective date, Aadhar/ID,
// address and bank details. Same pre-filled-form pattern as AppointmentGeneratePanel above: submit
// posts to /generate on first use, /regenerate when editing an already-generated agreement (the
// reserved Contractor code stays stable either way — the server keeps it if already reserved).
function ServiceAgreementGeneratePanel({ offer, onDone, busy, setBusy, regenerate, onCancel }: any) {
  const { show } = useToast();
  const sa = offer.serviceAgreement;
  const f0 = sa?.dynamicFields || {};
  const isIntern = offer.employmentType === "INTERN";
  const defaultEnd = (start: string) => new Date(new Date(start || Date.now()).getTime() + 60 * 86400000).toISOString().slice(0, 10);
  const [f, setF] = useState({
    // Defaults to the annual CTC entered on Generate Offer, divided by 12 — still editable.
    // Structure picked at Stage 1 (Offer.customFields) or on this already-generated agreement
    // (dynamicFields); amount is in that structure's own unit. The monthlyCompensation fallback
    // covers agreements generated before the structure existed.
    // Stage 1's choice (Offer.customFields) wins over an older generated agreement's — editing the
    // candidate's structure after generating must show up on Regenerate, not the stale one.
    compensationType: (offer.customFields as any)?.compensationType || f0.CompensationType || "MONTHLY",
    compensationAmount: (offer.customFields as any)?.compensationAmount != null ? String((offer.customFields as any).compensationAmount)
      : f0.CompensationAmount != null ? String(f0.CompensationAmount)
      : sa?.monthlyCompensation ? String(sa.monthlyCompensation) : (offer.ctc ? String(Math.round(offer.ctc / 12)) : ""),
    effectiveDate: f0.EffectiveDate ? String(f0.EffectiveDate).slice(0, 10) : (offer.proposedJoiningDate?.slice(0, 10) || new Date().toISOString().slice(0, 10)),
    // Aadhaar pre-fills from the Offer's own Candidate Information (same identity document,
    // explicitly fine to reuse) once one exists (f0) or from the offer itself on first generation.
    // SLA Name/Address are deliberately NOT pre-filled from Candidate Information's First/Middle/
    // Last Name or Address — they're the Service Agreement's own independent fields (a contractor's
    // legal/billing name or registered address can differ from their candidate profile), so they
    // start blank except when re-editing an already-generated agreement (f0). None of this applies
    // to Intern — its Internship Letter has no bank/SLA-name/address clauses at all.
    slaName: f0.ContractorName || "", contractorAddress: f0.ContractorAddress || "",
    aadharNumber: f0.AadharNumber || offer.aadhaarNumber || "",
    bankAccountNumber: f0.BankAccountNumber || "", bankName: f0.BankName || "", bankIfsc: f0.BankIFSC || "", bankBranchName: f0.BankBranchName || "",
    // Intern-only: the letter's own Location/Duration fields (Contractor has neither — its
    // engagement isn't date-bounded the same way).
    internshipLocation: f0.Location || offer.workLocation || "Hybrid",
    internshipEndDate: f0.EndDateRaw ? String(f0.EndDateRaw).slice(0, 10) : defaultEnd(offer.proposedJoiningDate?.slice(0, 10)),
    // Explicit "No Cost to Company" checkbox (Contractor/Intern) — CTC becomes optional and no
    // CtcApprovalRequest/CtcRecord is ever created for this hire (see server hrOffers.ts). Defaults
    // from the choice already made at Stage 1 (Create Candidate) so HR isn't asked twice — still
    // editable here in case they change their mind before generating.
    noCostToCompany: sa ? !!sa.noCostToCompany : !!offer.noCostToCompany,
    // Numbered "Services" list of the agreement (Article 1(a)) — editable per agreement; seeded from
    // the generated agreement, else the template default below.
    services: (Array.isArray(f0.Services) ? f0.Services : []) as string[],
    servicesIntro: (f0.ServicesIntro || "") as string,
  });
  const { data: saTpls } = useFetch<any[]>("/hr-settings/service-agreement-templates");
  React.useEffect(() => {
    if (!saTpls || (f.services.length && f.servicesIntro)) return;
    const t = saTpls.find((x: any) => x.countryCode === offer.countryCode && Array.isArray(x.services) && x.services.length) || saTpls.find((x: any) => Array.isArray(x.services) && x.services.length);
    const introPt = (saTpls.find((x: any) => x.countryCode === offer.countryCode && Array.isArray(x.clauses)) || saTpls.find((x: any) => Array.isArray(x.clauses)))?.clauses
      ?.flatMap((c: any) => c.points || []).find((p: any) => p?.servicesList)?.text || "";
    setF((cur: any) => cur.servicesIntro ? cur : { ...cur, servicesIntro: introPt });
    setF((cur: any) => cur.services.length ? cur : { ...cur, services: t?.services || ["Technical Analysis", "Data Analysis", "QA", "Professional Services"] });
    // eslint-disable-next-line
  }, [saTpls]);
  const setSvc = (next: string[]) => setF((cur: any) => ({ ...cur, services: next }));
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const setChecked = (k: string) => (e: any) => setF({ ...f, [k]: e.target.checked });
  const compAmt = Number(f.compensationAmount) || 0;
  const compType = isIntern ? "MONTHLY" : f.compensationType;
  const compAnnual = compType === "ANNUAL" ? compAmt : compType === "DAILY" ? compAmt * 260 : compAmt * 12;
  const compPreview = { annual: compAnnual, monthly: compType === "MONTHLY" ? compAmt : compAnnual / 12 };
  // Config-driven (HR Settings -> Workflow & Stage Configuration, Service Agreement Terms section
  // of Stage 1) — same enabled/mandatory pattern as Generate Offer/IT Provisioning, so this real
  // form and the Workflow Builder's config/preview can never drift apart. Reads THIS offer's own
  // employment type's config (was hardcoded to CONTRACTOR, which silently fed an Intern offer
  // Contractor's field config) — an employment type with no config rows yet just defaults every
  // field "on, not mandatory" (fieldOn's own `!fieldConfig ||` fallback), which is harmless here
  // since Intern's bank/SLA fields are hidden outright below, not driven by this config at all.
  const { data: fieldConfig } = useFetch<any[]>(`/hr/offer-field-config?employmentType=${offer.employmentType}&countryCode=${offer.countryCode || ""}`);
  const fieldOn = (key: string) => !fieldConfig || (fieldConfig.find((x) => x.key === key)?.enabled !== false);
  const fieldReq = (key: string) => !!fieldConfig?.find((x) => x.key === key)?.mandatory;
  const generate = async () => {
    if (!f.noCostToCompany && !Number(f.compensationAmount)) return show("Compensation amount is required (or check \"No Cost to Company\")", "error");
    if (!isIntern) {
      if (fieldOn("slaName") && fieldReq("slaName") && !f.slaName.trim()) return show("SLA Name is required", "error");
      if (fieldOn("aadharNumber") && fieldReq("aadharNumber") && !f.aadharNumber.trim()) return show("Aadhar / ID Number is required", "error");
      if (fieldOn("contractorAddress") && fieldReq("contractorAddress") && !f.contractorAddress.trim()) return show("SLA Address is required", "error");
      if (fieldOn("bankName") && fieldReq("bankName") && !f.bankName.trim()) return show("Bank Name is required", "error");
      if (fieldOn("bankAccountNumber") && fieldReq("bankAccountNumber") && !f.bankAccountNumber.trim()) return show("Bank Account Number is required", "error");
      if (fieldOn("bankIfsc") && fieldReq("bankIfsc") && !f.bankIfsc.trim()) return show("IFSC is required", "error");
      if (fieldOn("bankBranchName") && fieldReq("bankBranchName") && !f.bankBranchName.trim()) return show("Branch Name is required", "error");
    } else {
      if (fieldOn("internshipLocation") && fieldReq("internshipLocation") && !f.internshipLocation.trim()) return show("Location is required", "error");
      if (!f.internshipEndDate) return show("Internship End Date is required", "error");
    }
    setBusy(true);
    try {
      const path = regenerate ? "regenerate" : "generate";
      await api.post(`/hr/offers/${offer.id}/service-agreement/${path}`, { ...f, compensationType: isIntern ? "MONTHLY" : f.compensationType, compensationAmount: f.noCostToCompany ? 0 : Number(f.compensationAmount), monthlyCompensation: f.noCostToCompany ? 0 : compPreview.monthly });
      show(regenerate ? (isIntern ? "Internship Letter regenerated" : "Service Agreement regenerated") : (isIntern ? "Internship Letter generated — Intern code created (hidden)" : "Service Agreement generated — Contractor code created (hidden)"));
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Panel title={isIntern ? (regenerate ? "Regenerate Internship Letter" : "Generate Internship Letter") : (regenerate ? "Regenerate Service Agreement" : "Generate Service Agreement")}>
      <div className="form-grid">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={f.noCostToCompany} onChange={setChecked("noCostToCompany")} />
          No Cost to Company (zero-cost — no CTC record, excluded from headcount &amp; cost)
        </label>
        {isIntern ? (
          <Field label="Monthly Compensation (INR)" required={!f.noCostToCompany} disabled={f.noCostToCompany} type="number" value={f.noCostToCompany ? "0" : f.compensationAmount} onChange={set("compensationAmount")} />
        ) : (
          <>
            <SelectField label="Compensation Structure" required value={f.compensationType} disabled={f.noCostToCompany} onChange={set("compensationType")}
              options={[{ value: "ANNUAL", label: "Annual CTC" }, { value: "MONTHLY", label: "Monthly Salary" }, { value: "DAILY", label: "Daily Salary" }]} />
            <Field label={f.compensationType === "ANNUAL" ? "Annual CTC (INR)" : f.compensationType === "DAILY" ? "Daily Salary (INR)" : "Monthly Salary (INR)"} required={!f.noCostToCompany} disabled={f.noCostToCompany} type="number" value={f.noCostToCompany ? "0" : f.compensationAmount} onChange={set("compensationAmount")} />
            {!f.noCostToCompany && <div><label>Annualized CTC</label><div style={{ fontWeight: 600 }}>₹{Math.round(compPreview.annual).toLocaleString("en-IN")}{f.compensationType === "DAILY" ? " (daily × 260 working days)" : f.compensationType === "MONTHLY" ? " (monthly × 12)" : ""}</div></div>}
          </>
        )}
        <Field label="Effective Date" required type="date" value={f.effectiveDate} onChange={set("effectiveDate")} />
        {isIntern ? (
          <>
            {fieldOn("internshipLocation") && <Field label="Location" required={fieldReq("internshipLocation")} value={f.internshipLocation} onChange={set("internshipLocation")} placeholder="e.g. Hybrid, Noida Office, Remote" />}
            <Field label="Internship End Date" required type="date" value={f.internshipEndDate} onChange={set("internshipEndDate")} />
          </>
        ) : (
          <>
            {/* Deliberately independent of Candidate Information's First/Middle/Last Name and Address
                above — this is what actually prints as {{ContractorName}}/{{ContractorAddress}} on
                the Service Agreement, never the candidate-info fields. */}
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Services intro wording</label>
              <textarea style={{ width: "100%", minHeight: 54, marginBottom: 8 }} value={f.servicesIntro} onChange={(e) => setF((cur: any) => ({ ...cur, servicesIntro: e.target.value }))} />
              <label>Services (numbered list in the agreement)</label>
              {f.services.map((sv: string, i: number) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                  <span style={{ width: 22, paddingTop: 6 }}>{i + 1})</span>
                  <input style={{ flex: 1 }} value={sv} onChange={(e) => setSvc(f.services.map((x: string, j: number) => (j === i ? e.target.value : x)))} />
                  <GhostButton onClick={() => setSvc(f.services.filter((_: string, j: number) => j !== i))}>✕</GhostButton>
                </div>
              ))}
              <GhostButton onClick={() => setSvc([...f.services, ""])}>+ Add service</GhostButton>
            </div>
            {fieldOn("slaName") && <Field label="SLA Name" required={fieldReq("slaName")} value={f.slaName} onChange={set("slaName")} placeholder="Name as it should appear on the Service Agreement" />}
            {fieldOn("aadharNumber") && <Field label="Aadhar / ID Number" required={fieldReq("aadharNumber")} value={f.aadharNumber} onChange={set("aadharNumber")} />}
            {fieldOn("contractorAddress") && <Field label="SLA Address" required={fieldReq("contractorAddress")} value={f.contractorAddress} onChange={set("contractorAddress")} placeholder="Address as it should appear on the Service Agreement" />}
            {fieldOn("bankName") && <Field label="Bank Name" required={fieldReq("bankName")} value={f.bankName} onChange={set("bankName")} />}
            {fieldOn("bankAccountNumber") && <Field label="Bank Account Number" required={fieldReq("bankAccountNumber")} value={f.bankAccountNumber} onChange={set("bankAccountNumber")} />}
            {fieldOn("bankIfsc") && <Field label="IFSC" required={fieldReq("bankIfsc")} value={f.bankIfsc} onChange={set("bankIfsc")} />}
            {fieldOn("bankBranchName") && <Field label="Branch Name" required={fieldReq("bankBranchName")} value={f.bankBranchName} onChange={set("bankBranchName")} />}
          </>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", margin: "8px 0" }}>
        {isIntern
          ? (regenerate ? "Change what's needed and regenerate — the same reserved Intern code is kept, only the letter's content is replaced." : "Generating creates the Intern code now. The code prints nowhere on the document itself and stays hidden everywhere else until you confirm joining.")
          : (regenerate ? "Change what's needed and regenerate — the same reserved Contractor code is kept, only the agreement's content is replaced." : "Generating creates the Contractor code now — a flat 10% TDS is applied to the monthly compensation, no CTC bracket or tax regime involved. The code prints nowhere on the document itself and stays hidden everywhere else until you confirm joining.")}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <AddButton disabled={busy} onClick={generate}>{regenerate ? "Regenerate Service Agreement" : "Generate Service Agreement"}</AddButton>
        {regenerate && onCancel && <GhostButton disabled={busy} onClick={onCancel}>Cancel</GhostButton>}
      </div>
    </Panel>
  );
}
