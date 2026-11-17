// Employee Self-Service — My Profile, Onboarding Documents, Holiday Calendar, Leave &
// Attendance (employee-facing) + Leave Approvals / Onboarding Review (HR/manager-facing) +
// the Leave Policy tab used inside HR Admin Settings. Mirrors the look of Hr.tsx / People.tsx.
import React, { useState, useEffect } from "react";
import { Bar, Doughnut } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend } from "chart.js";
import { api } from "../../api";
import { useFetch, Panel, Field, SelectField } from "../../ui";
import { fmtDate } from "../../dateFormat";
import { watchRoom } from "../../realtime";
import { NeedYourAttention } from "../../NeedYourAttention";
import { Modal, Input, useToast, AddButton, GhostButton, confirmDialog } from "../../components";
import { useAuth } from "../../auth";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CloneFromDefaultBanner } from "./Hr";
import { RegularizationPermission, PeopleOrg, SalaryRevision } from "./EssExtras";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

// HR/admin-tier roles — matches server auth/auth.ts's HR_SETTINGS_ROLES. PROJECT_MANAGER can
// approve leave but can't see the full Employee list (masters.ts /employees is HR-tier-gated),
// so the comp-off credit picker below is restricted to this tier too.
const HR_SETTINGS_ROLES = ["HR", "CEO", "CTO", "FINANCE"];

const dstr = fmtDate;

function Tabs<T extends string>({ tab, setTab, items }: { tab: T; setTab: (t: T) => void; items: [T, string][] }) {
  return (
    <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap" }}>
      {items.map(([k, label]) => (
        <div key={k} onClick={() => setTab(k)} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === k ? "var(--accent)" : "var(--muted)", borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent" }}>{label}</div>
      ))}
    </div>
  );
}

// =====================================================================================
// My Profile (Profile fields + Onboarding Documents checklist)
// =====================================================================================
export function MyProfile() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"profile" | "docs" | "additional">(params.get("tab") === "docs" ? "docs" : params.get("tab") === "additional" ? "additional" : "profile");
  return (
    <div>
      <h1>My Profile</h1>
      <div className="subtitle">Your employee record. Salary/CTC are never shown here — contact HR for compensation details.</div>
      <Tabs tab={tab} setTab={setTab} items={[["profile", "Profile"], ["docs", "Onboarding Documents"], ["additional", "Additional Details"]]} />
      {tab === "profile" ? <ProfileTab /> : tab === "docs" ? <MyOnboardingDocs /> : <AdditionalDetailsTab />}
    </div>
  );
}

// One row editor shared by Education/Family/Nomination — each just a fixed small set of text/date
// inputs per row, add/remove freely. Not part of the HR-configurable field catalog (that's for the
// flat Personal/Address/Bank/PF/KYC fields only) since a repeating structure needs fixed columns.
function RepeatingListEditor({ title, columns, rows, setRows }: { title: string; columns: { key: string; label: string; type?: string }[]; rows: any[]; setRows: (r: any[]) => void }) {
  const addRow = () => setRows([...rows, Object.fromEntries(columns.map((c) => [c.key, ""]))]);
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));
  const updateRow = (i: number, key: string, value: string) => setRows(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  return (
    <Panel title={title} style={{ marginTop: 12 }}>
      {rows.length === 0 ? <div className="note">None added yet.</div> : (
        <table><thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}<th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}><input type={c.type || "text"} value={r[c.key] || ""} onChange={(e) => updateRow(i, c.key, e.target.value)} style={{ width: "100%" }} /></td>
                ))}
                <td><GhostButton onClick={() => removeRow(i)}>Remove</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <GhostButton style={{ marginTop: 8 }} onClick={addRow}>Add {title.replace(/s$/, "")}</GhostButton>
    </Panel>
  );
}

const PROFILE_SECTION_LABELS: Record<string, string> = { PERSONAL: "Personal", ADDRESS: "Address", BANK: "Bank Account", PF: "PF Account", KYC: "KYC / Other IDs" };
const SUBMISSION_STATUS_LABEL: Record<string, string> = { PENDING: "Pending HR Approval", APPROVED: "Approved", REJECTED: "Rejected — please review and resubmit" };
const SUBMISSION_STATUS_CLASS: Record<string, string> = { PENDING: "warn", APPROVED: "good", REJECTED: "bad" };

// Config-driven — the field catalog (HR Settings → Employee Profile Fields) is the only source of
// truth for what shows up here; nothing below is hardcoded per field.
function AdditionalDetailsTab() {
  const { data: fields } = useFetch<any[]>("/ess/profile-fields");
  const { data: submission, reload } = useFetch<any>("/ess/profile-submission");
  const { show } = useToast();
  const [values, setValues] = useState<Record<string, any>>({});
  const [education, setEducation] = useState<any[]>([]);
  const [family, setFamily] = useState<any[]>([]);
  const [nomination, setNomination] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  React.useEffect(() => {
    if (submission !== undefined && !loaded) {
      setValues(submission?.values || {});
      setEducation(submission?.education || []);
      setFamily(submission?.family || []);
      setNomination(submission?.nomination || []);
      setLoaded(true);
    }
  }, [submission, loaded]);

  const bySection = PROFILE_SECTION_LABELS && Object.keys(PROFILE_SECTION_LABELS).map((s) => ({ section: s, label: PROFILE_SECTION_LABELS[s], rows: (fields || []).filter((f: any) => f.section === s) }));
  const setValue = (key: string, v: any) => setValues((cur) => ({ ...cur, [key]: v }));

  const submit = async () => {
    const missing = (fields || []).filter((f: any) => f.required && !values[f.key]);
    if (missing.length) return show(`Please fill in required field: ${missing[0].label}`, "error");
    setBusy(true);
    try {
      await api.put("/ess/profile-submission", { values, education, family, nomination });
      show("Submitted for HR approval"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  if (!loaded) return <div>Loading…</div>;
  return (
    <div>
      {submission?.status && (
        <div className="note" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`pill ${SUBMISSION_STATUS_CLASS[submission.status]}`}>{SUBMISSION_STATUS_LABEL[submission.status]}</span>
          {submission.reviewNote && <span style={{ color: "var(--muted)" }}>— {submission.reviewNote}</span>}
        </div>
      )}
      {(bySection || []).filter((s) => s.rows.length > 0).map((s) => (
        <Panel key={s.section} title={s.label} style={{ marginTop: 12 }}>
          <div className="form-grid">
            {s.rows.map((f: any) => (
              f.fieldType === "BOOLEAN" ? (
                <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValue(f.key, e.target.checked)} /> {f.label}
                </label>
              ) : f.fieldType === "SELECT" ? (
                <SelectField key={f.id} label={f.label + (f.required ? " *" : "")} value={values[f.key] || ""} onChange={(e: any) => setValue(f.key, e.target.value)}
                  options={[{ value: "", label: "— select —" }, ...(f.options || []).map((o: string) => ({ value: o, label: o }))]} />
              ) : (
                <Field key={f.id} label={f.label + (f.required ? " *" : "")} type={f.fieldType === "DATE" ? "date" : f.fieldType === "NUMBER" ? "number" : "text"}
                  value={values[f.key] || ""} onChange={(e: any) => setValue(f.key, e.target.value)} />
              )
            ))}
          </div>
        </Panel>
      ))}
      <RepeatingListEditor title="Education" rows={education} setRows={setEducation}
        columns={[{ key: "institution", label: "Institution" }, { key: "degree", label: "Degree" }, { key: "fieldOfStudy", label: "Field of Study" }, { key: "yearOfCompletion", label: "Year" }]} />
      <RepeatingListEditor title="Family Members" rows={family} setRows={setFamily}
        columns={[{ key: "name", label: "Name" }, { key: "relation", label: "Relation" }, { key: "dateOfBirth", label: "Date of Birth", type: "date" }, { key: "gender", label: "Gender" }]} />
      <RepeatingListEditor title="Nominations" rows={nomination} setRows={setNomination}
        columns={[{ key: "name", label: "Name" }, { key: "relation", label: "Relation" }, { key: "percentage", label: "Percentage" }]} />
      <div style={{ marginTop: 14 }}>
        <AddButton disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Submit for HR Approval"}</AddButton>
      </div>
    </div>
  );
}

function ProfileTab() {
  const { data: me, loading, error, reload } = useFetch<any>("/ess/me");
  const { show } = useToast();
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  React.useEffect(() => { if (me) setF({ phone: me.phone || "", officialPhone: me.officialPhone || "", emergencyContactName: me.emergencyContactName || "", emergencyContactPhone: me.emergencyContactPhone || "", marriageAnniversary: me.marriageAnniversary ? me.marriageAnniversary.slice(0, 10) : "" }); }, [me?.id]);
  if (error) return <div className="note">{error}</div>;
  if (loading || !me || !f) return <div>Loading…</div>;

  const save = async () => {
    setBusy(true);
    try { await api.put("/ess/me", f); show("Profile updated"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const uploadPhoto = async (file: File) => {
    setBusy(true);
    try {
      const fileData = await fileToBase64(file);
      await api.post("/ess/photo", { fileName: file.name, fileData });
      show("Photo uploaded"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div className="grid cols-2">
      <Panel title="Profile Photo">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {me.photoFileData
            ? <img src={api.pdfUrl(`/ess/photo/${me.id}`)} alt="Profile" style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)" }} />
            : <div style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--panel2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 11 }}>No photo</div>}
          <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "6px 12px" }}>
            {busy ? "Uploading…" : me.photoFileData ? "Change Photo" : "Upload Photo"}
            <input type="file" accept="image/*" style={{ display: "none" }} disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ""; }} />
          </label>
        </div>
      </Panel>
      <Panel title="Employment Details (read-only)">
        <table><tbody>
          <tr><td>Employee ID</td><td className="num">{me.empNo || "—"}</td></tr>
          <tr><td>Name</td><td className="num">{me.name}</td></tr>
          <tr><td>Work Email</td><td className="num">{me.email || "—"}</td></tr>
          <tr><td>Designation</td><td className="num">{me.designation || "—"}</td></tr>
          <tr><td>Department</td><td className="num">{me.department || "—"}</td></tr>
          <tr><td>Reporting Manager</td><td className="num">{me.reportingManager || "—"}</td></tr>
          <tr><td>Joining Date</td><td className="num">{dstr(me.joiningDate)}</td></tr>
          <tr><td>Location</td><td className="num">{me.location || "—"}</td></tr>
          <tr><td>Employment Type</td><td className="num">{me.empType}</td></tr>
          <tr><td>Notice Period</td><td className="num">{me.noticePeriod || "—"}</td></tr>
          <tr><td>Probation Period</td><td className="num">{me.probationPeriod || "—"}</td></tr>
          <tr><td>Gender</td><td className="num">{me.gender ? me.gender.charAt(0) + me.gender.slice(1).toLowerCase() : "—"}</td></tr>
          <tr><td>Marital Status</td><td className="num">{me.maritalStatus ? me.maritalStatus.charAt(0) + me.maritalStatus.slice(1).toLowerCase() : "—"}</td></tr>
          <tr><td>Date of Birth</td><td className="num">{me.dateOfBirth ? dstr(me.dateOfBirth) : "—"}</td></tr>
          <tr><td>Address</td><td className="num">{[me.address, me.landmark, me.city, me.state, me.pincode].filter(Boolean).join(", ") || "—"}</td></tr>
        </tbody></table>
        {me.offer && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <GhostButton onClick={() => window.open(api.pdfUrl("/ess/me/offer-pdf"), "_blank")}>Download Offer Letter</GhostButton>
            <GhostButton onClick={() => window.open(api.pdfUrl("/ess/me/appointment-pdf"), "_blank")}>Download Appointment Letter</GhostButton>
          </div>
        )}
        <div className="note">Contact HR to correct anything above — this section isn't self-editable.</div>
      </Panel>
      <Panel title="Contact Details (editable)">
        <Field label="Personal Phone" value={f.phone} onChange={(e: any) => setF({ ...f, phone: e.target.value })} />
        <Field label="Official Phone" value={f.officialPhone} onChange={(e: any) => setF({ ...f, officialPhone: e.target.value })} />
        <Field label="Emergency Contact Name" value={f.emergencyContactName} onChange={(e: any) => setF({ ...f, emergencyContactName: e.target.value })} />
        <Field label="Emergency Contact Phone" value={f.emergencyContactPhone} onChange={(e: any) => setF({ ...f, emergencyContactPhone: e.target.value })} />
        {/* Not captured at Offer Generation (HR doesn't necessarily know it at hiring time) — the
            one profile field the employee fills in themselves, surfaced as a pending action below
            until they do. */}
        {me.maritalStatus === "MARRIED" && (
          <Field label="Marriage Anniversary" type="date" value={f.marriageAnniversary} onChange={(e: any) => setF({ ...f, marriageAnniversary: e.target.value })} />
        )}
        <AddButton style={{ marginTop: 10 }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</AddButton>
      </Panel>
    </div>
  );
}

const DOC_STATUS_CLASS: Record<string, string> = { PENDING: "", SUBMITTED: "accent", APPROVED: "good", REJECTED: "bad" };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function MyOnboardingDocs() {
  const { data, reload } = useFetch<any[]>("/ess/onboarding-docs");
  const { show } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  const upload = async (docTypeId: number, file: File) => {
    setBusyId(docTypeId);
    try {
      const fileData = await fileToBase64(file);
      await api.post(`/ess/onboarding-docs/${docTypeId}`, { fileName: file.name, fileData });
      show("Document submitted for review"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusyId(null); }
  };

  return (
    <Panel title="Joining Document Checklist">
      <table><thead><tr><th>Document</th><th>Required</th><th>File</th><th>Status</th><th>HR Note</th><th></th></tr></thead>
        <tbody>
          {(data || []).length === 0 && <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No checklist configured yet.</td></tr>}
          {(data || []).map((d) => (
            <tr key={d.docTypeId}>
              <td>{d.docType.name}</td>
              <td>{d.docType.required ? "Yes" : "No"}</td>
              <td>{d.fileName || "—"}</td>
              <td><span className={`pill ${DOC_STATUS_CLASS[d.status] || ""}`}>{d.status}</span></td>
              <td style={{ color: "var(--muted)", fontSize: 12 }}>{d.note || "—"}</td>
              <td>
                {d.status !== "APPROVED" && (
                  <label className="ghost" style={{ display: "inline-block", cursor: "pointer", padding: "4px 10px" }}>
                    {busyId === d.docTypeId ? "Uploading…" : d.fileName ? "Re-upload" : "Upload"}
                    <input type="file" style={{ display: "none" }} disabled={busyId === d.docTypeId}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(d.docTypeId, f); e.target.value = ""; }} />
                  </label>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note">Upload each required document once — HR/Finance will review and mark it Approved or Rejected below. Rejected documents can be re-uploaded.</div>
    </Panel>
  );
}

// =====================================================================================
// Check-In / Check-Out — the daily-action home for items 1-2. Additive to (never touches)
// the existing "Mark Present/WFH" status flow in MarkAttendanceTab below: this only sets
// checkInTime/checkOutTime on the same AttendanceRecord row.
// =====================================================================================
const tstr = (d: any) => (d ? new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—");

function CheckInOutPanel() {
  const { data: today, reload } = useFetch<any>("/ess/attendance/today");
  const { show } = useToast();
  const [busy, setBusy] = useState(false);

  const checkIn = async () => {
    setBusy(true);
    try { await api.post("/ess/attendance/check-in"); show("Checked in"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const checkOut = async () => {
    setBusy(true);
    try { await api.post("/ess/attendance/check-out"); show("Checked out"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <Panel title="Check In / Check Out">
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <AddButton disabled={busy || !!today?.checkInTime} onClick={checkIn}>{busy ? "…" : "Check In"}</AddButton>
          <GhostButton disabled={busy || !today?.checkInTime || !!today?.checkOutTime} onClick={checkOut}>{busy ? "…" : "Check Out"}</GhostButton>
        </div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Check-in: <b style={{ color: "var(--text)" }}>{tstr(today?.checkInTime)}</b>
          &nbsp;·&nbsp;
          Check-out: <b style={{ color: "var(--text)" }}>{tstr(today?.checkOutTime)}</b>
        </div>
      </div>
    </Panel>
  );
}

// =====================================================================================
// Employee Dashboard — self-service landing page: an Overview tab (profile snapshot,
// check-in/out, leave balance chart, upcoming holidays, a "Track" panel and quick links)
// and a dedicated "Attendance, Regularization & Permission" tab.
// =====================================================================================
type DashTab = "overview" | "attendance" | "regularization" | "org" | "salary";
export function EmployeeDashboard() {
  const [params, setParams] = useSearchParams();
  const initial = (params.get("tab") || "overview") as DashTab;
  const [tab, setTabState] = useState<DashTab>(["overview", "attendance", "regularization", "org", "salary"].includes(initial) ? initial : "overview");
  const setTab = (t: DashTab) => { setTabState(t); setParams(t === "overview" ? {} : { tab: t }, { replace: true }); };
  const { data: me, loading, error } = useFetch<any>("/ess/me");
  if (error) return (
    <div>
      <h1>Employee Dashboard</h1>
      <div className="note">{error}</div>
    </div>
  );
  if (loading || !me) return <div>Loading…</div>;

  return (
    <div>
      <h1>Welcome, {String(me.name || "").split(" ")[0]}</h1>
      <div className="subtitle">Your profile, attendance, leave balance and upcoming holidays at a glance.</div>
      <Tabs tab={tab} setTab={setTab} items={[["overview", "Overview"], ["attendance", "Attendance"], ["regularization", "Regularization & Permission"], ["org", "People & Org Chart"], ["salary", "Salary & Designation Revision"]]} />
      {tab === "overview" ? <DashboardOverviewTab me={me} />
        : tab === "attendance" ? <AttendanceRegularizationPermissionTab />
        : tab === "regularization" ? <RegularizationPermission />
        : tab === "org" ? <PeopleOrg />
        : <SalaryRevision />}
    </div>
  );
}

function DashboardOverviewTab({ me }: { me: any }) {
  const navigate = useNavigate();
  const { data: balances } = useFetch<any[]>("/ess/leave-balances");
  const { data: holidays } = useFetch<any[]>("/ess/holidays");
  const { data: requests } = useFetch<any[]>("/ess/leave-requests");
  const { data: leaveTypes } = useFetch<any[]>("/ess/leave-types");
  const { data: pending, reload: reloadPending } = useFetch<{ actions: any[] }>("/ess/pending-actions");
  const pendingActions = pending?.actions || [];
  // Live — an onboarding doc getting reviewed or a Timesheet action being opened/closed by a
  // PM/CTO shows up here instantly, no manual refresh needed.
  useEffect(() => { if (me?.id) return watchRoom(`pending:${me.id}`, "pending:update", reloadPending); }, [me?.id]);

  const applicable = (balances || []).filter((b) => !b.informational);
  const upcomingHolidays = (holidays || [])
    .filter((h) => new Date(h.date) >= new Date(new Date().toDateString()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 5); // items 3-4: upcoming company/public + any other applicable (e.g. restricted) holidays
  const pendingRequests = (requests || []).filter((r) => r.status === "PENDING");
  const restricted = applicable.find((b) => b.leaveType.key === "FLOATING_RESTRICTED");
  const kpi = (label: string, value: any) => (
    <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div></div>
  );

  return (
    <div>
      {/* IT_ADMIN's own queue (provisioning/offboarding) — empty/no-op for every other role,
          since /dashboard/attention only returns items for roles that actually approve something. */}
      <NeedYourAttention />
      {pendingActions.length > 0 && (
        <Panel style={{ marginBottom: 14, border: "1px solid var(--warn)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>⚠ Pending Action{pendingActions.length > 1 ? "s" : ""}</div>
            <span className="pill warn">{pendingActions.length}</span>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {pendingActions.map((a, i) => (
              <div key={i} onClick={() => navigate(
                a.type === "ONBOARDING_DOCS" ? "/my-profile?tab=docs"
                : a.type === "MARRIAGE_ANNIVERSARY" || a.type === "PHOTO" ? "/my-profile?tab=profile"
                : a.type === "ADDITIONAL_PROFILE" ? "/my-profile?tab=additional"
                : "/timesheet"
              )} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 13 }}>{a.label}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}
      <div className="grid" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 14 }}>
        {kpi("Employee ID", me.empNo || "—")}
        {kpi("Employment Type", me.empType || "—")}
        {kpi("Joining Date", dstr(me.joiningDate))}
        {kpi("Pending Leave Requests", pendingRequests.length)}
      </div>

      <CheckInOutPanel />

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="Leave Balance">
          {applicable.length === 0 ? (
            <div style={{ color: "var(--muted)" }}>No leave balances configured yet.</div>
          ) : (
            <div className="chart-wrap">
              <Bar
                data={{
                  labels: applicable.map((b) => b.leaveType.name),
                  datasets: [{ label: "Available", data: applicable.map((b) => b.available), backgroundColor: "#6ea8ff", borderRadius: 4 }],
                }}
                options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
              />
            </div>
          )}
        </Panel>
        <Panel title="Upcoming Holidays">
          {upcomingHolidays.length === 0 ? (
            <div style={{ color: "var(--muted)" }}>No upcoming holidays configured.</div>
          ) : (
            <table><thead><tr><th>Date</th><th>Holiday</th></tr></thead>
              <tbody>{upcomingHolidays.map((h) => <tr key={h.id}><td>{dstr(h.date)}</td><td>{h.name}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>

      {/* Track section (item 5): leave permissions, restricted holidays, leave status, leave balance */}
      <Panel title="Track" style={{ marginTop: 14 }}>
        <div className="grid cols-2">
          <div>
            <h4 style={{ margin: "4px 0 8px" }}>Leave Permissions</h4>
            <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>Leave types enabled for your location ({me.location || "INDIA"}):</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(leaveTypes || []).length === 0 && <span style={{ color: "var(--muted)" }}>None configured.</span>}
              {(leaveTypes || []).map((t) => <span key={t.id} className="pill accent">{t.name}</span>)}
            </div>

            <h4 style={{ margin: "16px 0 8px" }}>Restricted Holiday (RH)</h4>
            {restricted ? (
              <div style={{ fontSize: 13 }}>Available: <b>{restricted.available}</b> of {restricted.accrued} day(s) this year.</div>
            ) : <div style={{ color: "var(--muted)" }}>Not configured for your location.</div>}
          </div>
          <div>
            <h4 style={{ margin: "4px 0 8px" }}>Leave Status</h4>
            {pendingRequests.length === 0 ? (
              <div style={{ color: "var(--muted)" }}>No pending leave requests.</div>
            ) : (
              <table><thead><tr><th>Type</th><th>From</th><th>To</th><th>Status</th></tr></thead>
                <tbody>{pendingRequests.map((r) => (
                  <tr key={r.id}><td>{r.leaveType.name}</td><td>{dstr(r.fromDate)}</td><td>{dstr(r.toDate)}</td><td><span className="pill accent">{r.status}</span></td></tr>
                ))}</tbody>
              </table>
            )}
            <h4 style={{ margin: "16px 0 8px" }}>Leave Balance</h4>
            <table><thead><tr><th>Type</th><th className="num">Available</th></tr></thead>
              <tbody>{applicable.map((b) => <tr key={b.leaveType.id}><td>{b.leaveType.name}</td><td className="num">{b.available}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </Panel>

      <Panel title="Quick Links" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <GhostButton onClick={() => navigate("/leave-attendance")}>Apply Leave / Mark Attendance</GhostButton>
          <GhostButton onClick={() => navigate("/my-profile")}>My Profile &amp; Onboarding Documents</GhostButton>
          <GhostButton onClick={() => navigate("/holiday-calendar")}>Full Holiday Calendar</GhostButton>
          <GhostButton onClick={() => navigate("/timesheet")}>My Timesheet</GhostButton>
          <GhostButton onClick={() => navigate("/helpdesk")}>IT Helpdesk</GhostButton>
        </div>
      </Panel>
    </div>
  );
}

// =====================================================================================
// Attendance, Regularization & Permission tab (item 6-7): view attendance records + a
// graphical monthly summary, raise a regularization request, raise a permission request,
// and track the status of both.
// =====================================================================================
const REQ_STATUS_CLASS = (s: string) => (s === "APPROVED" ? "good" : s === "REJECTED" ? "bad" : s === "CANCELLED" ? "" : "accent");

function AttendanceRegularizationPermissionTab() {
  const now = new Date();
  const [month] = useState(now.getMonth() + 1);
  const [year] = useState(now.getFullYear());
  const { data: records } = useFetch<any[]>(`/ess/attendance?month=${month}&year=${year}`, [month, year]);
  const { data: summary } = useFetch<any>(`/ess/attendance/summary?month=${month}&year=${year}`, [month, year]);

  return (
    <div>
      <CheckInOutPanel />

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="This Month's Attendance Summary">
          {summary && (summary.present + summary.wfh + summary.leave + summary.holiday + summary.unmarked) > 0 ? (
            <div className="chart-wrap">
              <Doughnut
                data={{
                  labels: ["Present", "Work From Home", "Leave", "Holiday", "Unmarked"],
                  datasets: [{ data: [summary.present, summary.wfh, summary.leave, summary.holiday, summary.unmarked], backgroundColor: ["#6ea8ff", "#34d399", "#fbbf24", "#a78bfa", "#f87171"] }],
                }}
                options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }}
              />
            </div>
          ) : <div style={{ color: "var(--muted)" }}>No attendance data yet this month.</div>}
        </Panel>
        <Panel title="Attendance Records — This Month">
          <table><thead><tr><th>Date</th><th>Status</th><th>Check In</th><th>Check Out</th></tr></thead>
            <tbody>
              {(records || []).length === 0 && <tr><td colSpan={4} style={{ color: "var(--muted)" }}>Nothing recorded this month yet.</td></tr>}
              {[...(records || [])].sort((a, b) => +new Date(b.date) - +new Date(a.date)).map((r) => (
                <tr key={r.id}><td>{dstr(r.date)}</td><td>{ATT_LABEL[r.status] || r.status}</td><td>{tstr(r.checkInTime)}</td><td>{tstr(r.checkOutTime)}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className="note">Missed a check-in/out or need a short permission? Use the <b>Regularization &amp; Permission</b> tab — you can apply for several dates at once and track Pending / History there.</div>
    </div>
  );
}

function RegularizationPanel() {
  const { show } = useToast();
  const { data: requests, reload } = useFetch<any[]>("/ess/attendance/regularization");
  const [f, setF] = useState({ date: "", requestedCheckIn: "", requestedCheckOut: "", reason: "" });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!f.date || !f.reason || (!f.requestedCheckIn && !f.requestedCheckOut)) return show("Date, reason and at least one requested time are required", "error");
    setBusy(true);
    try {
      await api.post("/ess/attendance/regularization", {
        date: f.date,
        requestedCheckIn: f.requestedCheckIn ? `${f.date}T${f.requestedCheckIn}:00` : null,
        requestedCheckOut: f.requestedCheckOut ? `${f.date}T${f.requestedCheckOut}:00` : null,
        reason: f.reason,
      });
      show("Regularization request submitted");
      setF({ date: "", requestedCheckIn: "", requestedCheckOut: "", reason: "" });
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const cancel = async (id: number) => {
    const ok = await confirmDialog({ title: "Cancel regularization request?", message: "This can't be undone." });
    if (!ok) return;
    try { await api.post(`/ess/attendance/regularization/${id}/cancel`); show("Cancelled"); reload(); } catch (e: any) { show(e.message, "error"); }
  };

  return (
    <Panel title="Attendance Regularization">
      <div className="subtitle" style={{ marginTop: 0 }}>Forgot to check in/out? Request a correction — it needs approval before it's applied.</div>
      <div className="form-grid">
        <Field label="Date" type="date" value={f.date} onChange={(e: any) => setF({ ...f, date: e.target.value })} />
        <Field label="Requested Check In" type="time" value={f.requestedCheckIn} onChange={(e: any) => setF({ ...f, requestedCheckIn: e.target.value })} />
        <Field label="Requested Check Out" type="time" value={f.requestedCheckOut} onChange={(e: any) => setF({ ...f, requestedCheckOut: e.target.value })} />
        <Field label="Reason" value={f.reason} onChange={(e: any) => setF({ ...f, reason: e.target.value })} />
      </div>
      <AddButton style={{ marginTop: 10 }} disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Raise Request"}</AddButton>

      <table style={{ marginTop: 14 }}><thead><tr><th>Date</th><th>Check In</th><th>Check Out</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {(requests || []).length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No regularization requests yet.</td></tr>}
          {(requests || []).map((r) => (
            <tr key={r.id}>
              <td>{dstr(r.date)}</td><td>{tstr(r.requestedCheckIn)}</td><td>{tstr(r.requestedCheckOut)}</td>
              <td><span className={`pill ${REQ_STATUS_CLASS(r.status)}`}>{r.status}</span></td>
              <td>{r.status === "PENDING" && <GhostButton onClick={() => cancel(r.id)}>Cancel</GhostButton>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function PermissionPanel() {
  const { show } = useToast();
  const { data: requests, reload } = useFetch<any[]>("/ess/permission-requests");
  const [f, setF] = useState({ date: "", fromTime: "", toTime: "", reason: "" });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!f.date || !f.fromTime || !f.toTime || !f.reason) return show("Date, from/to time and reason are required", "error");
    setBusy(true);
    try {
      await api.post("/ess/permission-requests", f);
      show("Permission request submitted");
      setF({ date: "", fromTime: "", toTime: "", reason: "" });
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const cancel = async (id: number) => {
    const ok = await confirmDialog({ title: "Cancel permission request?", message: "This can't be undone." });
    if (!ok) return;
    try { await api.post(`/ess/permission-requests/${id}/cancel`); show("Cancelled"); reload(); } catch (e: any) { show(e.message, "error"); }
  };

  return (
    <Panel title="Permission Request">
      <div className="subtitle" style={{ marginTop: 0 }}>Need to step out for a short while (e.g. leave 2 hours early)? Raise a permission request instead of applying for a full leave day.</div>
      <div className="form-grid">
        <Field label="Date" type="date" value={f.date} onChange={(e: any) => setF({ ...f, date: e.target.value })} />
        <Field label="From Time" type="time" value={f.fromTime} onChange={(e: any) => setF({ ...f, fromTime: e.target.value })} />
        <Field label="To Time" type="time" value={f.toTime} onChange={(e: any) => setF({ ...f, toTime: e.target.value })} />
        <Field label="Reason" value={f.reason} onChange={(e: any) => setF({ ...f, reason: e.target.value })} />
      </div>
      <AddButton style={{ marginTop: 10 }} disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Raise Request"}</AddButton>

      <table style={{ marginTop: 14 }}><thead><tr><th>Date</th><th>From</th><th>To</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {(requests || []).length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No permission requests yet.</td></tr>}
          {(requests || []).map((r) => (
            <tr key={r.id}>
              <td>{dstr(r.date)}</td><td>{r.fromTime}</td><td>{r.toTime}</td>
              <td><span className={`pill ${REQ_STATUS_CLASS(r.status)}`}>{r.status}</span></td>
              <td>{r.status === "PENDING" && <GhostButton onClick={() => cancel(r.id)}>Cancel</GhostButton>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// =====================================================================================
// Holiday Calendar (read-only)
// =====================================================================================
export function HolidayCalendar() {
  const { data } = useFetch<any[]>("/ess/holidays");
  const year = new Date().getFullYear();
  return (
    <div>
      <h1>Holiday Calendar</h1>
      <div className="subtitle">Public holidays configured for your location by HR (HR Admin Settings → Leave Policy).</div>
      <Panel>
        <table><thead><tr><th>Date</th><th>Day</th><th>Holiday</th></tr></thead>
          <tbody>
            {(data || []).length === 0 && <tr><td colSpan={3} style={{ color: "var(--muted)" }}>No holidays configured yet.</td></tr>}
            {(data || []).map((h) => (
              <tr key={h.id}><td>{dstr(h.date)}</td><td>{new Date(h.date).toLocaleDateString("en-US", { weekday: "long" })}</td><td>{h.name}</td></tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div className="note">{year} holidays shown here come from the same calendar Finance uses for billing-day calculations — HR keeps it up to date in one place.</div>
    </div>
  );
}

// =====================================================================================
// Leave & Attendance (employee-facing)
// =====================================================================================
export function LeaveAndAttendance() {
  const [tab, setTab] = useState<"leave" | "attendance">("leave");
  return (
    <div>
      <h1>Leave &amp; Attendance</h1>
      <div className="subtitle">Apply for leave against your live balance, and mark your daily attendance.</div>
      <Tabs tab={tab} setTab={setTab} items={[["leave", "Apply Leave"], ["attendance", "Mark Attendance"]]} />
      {tab === "leave" ? <ApplyLeaveTab /> : <MarkAttendanceTab />}
    </div>
  );
}

function ApplyLeaveTab() {
  const { show } = useToast();
  const { data: balances, reload: reloadBalances } = useFetch<any[]>("/ess/leave-balances");
  const { data: requests, reload: reloadRequests } = useFetch<any[]>("/ess/leave-requests");
  const { data: compOff, reload: reloadCompOff } = useFetch<any>("/ess/comp-off");
  const applicable = (balances || []).filter((b) => !b.informational);
  const [f, setF] = useState({ leaveTypeId: "", fromDate: "", toDate: "", reason: "" });
  const [busy, setBusy] = useState(false);

  const reloadAll = () => { reloadBalances(); reloadRequests(); reloadCompOff(); };

  const apply = async () => {
    if (!f.leaveTypeId || !f.fromDate || !f.toDate) return show("Leave type, From Date and To Date are required", "error");
    setBusy(true);
    try {
      const r: any = await api.post("/ess/leave-requests", f);
      show(r.warnings?.length ? `Applied (${r.days} day(s)) — ${r.warnings.join(" ")}` : `Applied for ${r.days} day(s)`);
      setF({ leaveTypeId: "", fromDate: "", toDate: "", reason: "" });
      reloadAll();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  const cancel = async (id: number) => {
    const ok = await confirmDialog({ title: "Cancel leave request?", message: "This can't be undone." });
    if (!ok) return;
    try { await api.post(`/ess/leave-requests/${id}/cancel`); show("Cancelled"); reloadAll(); } catch (e: any) { show(e.message, "error"); }
  };

  return (
    <>
      <Panel title="Leave Balance">
        <table><thead><tr><th>Leave Type</th><th className="num">Carried In</th><th className="num">Accrued</th><th className="num">Used</th><th className="num">Available</th></tr></thead>
          <tbody>
            {applicable.map((b) => (
              <tr key={b.leaveType.id}>
                <td>{b.leaveType.name}</td><td className="num">{b.carriedIn}</td><td className="num">{b.accrued}</td>
                <td className="num">{b.used}</td><td className="num" style={{ fontWeight: 700 }}>{b.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {compOff && <div className="note">Comp-Off available: <b>{compOff.available}</b> day(s){compOff.expiringSoon > 0 ? ` — ${compOff.expiringSoon} day(s) expiring within 7 days` : ""}.</div>}
      </Panel>

      <Panel title="Apply for Leave" style={{ marginTop: 14 }}>
        <div className="form-grid">
          <SelectField label="Leave Type" value={f.leaveTypeId} onChange={(e: any) => setF({ ...f, leaveTypeId: e.target.value })}
            options={[{ value: "", label: "— select —" }, ...applicable.map((b) => ({ value: b.leaveType.id, label: `${b.leaveType.name} (${b.available} available)` }))]} />
          <Field label="From Date" type="date" value={f.fromDate} onChange={(e: any) => setF({ ...f, fromDate: e.target.value })} />
          <Field label="To Date" type="date" value={f.toDate} onChange={(e: any) => setF({ ...f, toDate: e.target.value })} />
          <Field label="Reason" value={f.reason} onChange={(e: any) => setF({ ...f, reason: e.target.value })} />
        </div>
        <AddButton style={{ marginTop: 10 }} disabled={busy} onClick={apply}>{busy ? "Submitting…" : "Apply"}</AddButton>
        <div className="note">The Fri+Mon sandwich rule and consecutive-day caps (e.g. General Leave ≤ 3 days) are applied automatically. Requests exceeding your balance are blocked — contact HR about Leave Without Pay if needed.</div>
      </Panel>

      <Panel title="My Leave Requests" style={{ marginTop: 14 }}>
        <table><thead><tr><th>Leave Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Status</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {(requests || []).length === 0 && <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No leave requests yet.</td></tr>}
            {(requests || []).map((r) => (
              <tr key={r.id}>
                <td>{r.leaveType.name}</td><td>{dstr(r.fromDate)}</td><td>{dstr(r.toDate)}</td>
                <td className="num">{r.days}{r.sandwichDeducted > 0 ? ` (+${r.sandwichDeducted} sandwich)` : ""}</td>
                <td><span className={`pill ${r.status === "APPROVED" ? "good" : r.status === "REJECTED" ? "bad" : r.status === "CANCELLED" ? "" : "accent"}`}>{r.status}</span></td>
                <td>{r.reason || "—"}</td>
                <td>{r.status === "PENDING" && <GhostButton onClick={() => cancel(r.id)}>Cancel</GhostButton>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

const ATT_LABEL: Record<string, string> = { PRESENT: "Present", WFH: "Work From Home", LEAVE: "Leave", HOLIDAY: "Holiday", ABSENT: "Absent" };

function MarkAttendanceTab() {
  const { show } = useToast();
  const now = new Date();
  const [month] = useState(now.getMonth() + 1);
  const [year] = useState(now.getFullYear());
  const { data, reload } = useFetch<any[]>(`/ess/attendance?month=${month}&year=${year}`, [month, year]);
  const [busy, setBusy] = useState(false);
  const todayKey = now.toISOString().slice(0, 10);
  const todays = (data || []).find((r) => new Date(r.date).toISOString().slice(0, 10) === todayKey);

  const mark = async (status: string) => {
    setBusy(true);
    try { await api.post("/ess/attendance", { status }); show(`Marked ${ATT_LABEL[status]} for today`); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <Panel title="Mark Today's Attendance">
      <div style={{ marginBottom: 14 }}>
        {todays ? <span className="pill good">Today marked: {ATT_LABEL[todays.status] || todays.status}</span> : (
          <div style={{ display: "flex", gap: 8 }}>
            <AddButton disabled={busy} onClick={() => mark("PRESENT")}>Mark Present</AddButton>
            <GhostButton disabled={busy} onClick={() => mark("WFH")}>Mark Work From Home</GhostButton>
          </div>
        )}
      </div>
      <table><thead><tr><th>Date</th><th>Day</th><th>Status</th></tr></thead>
        <tbody>
          {(data || []).length === 0 && <tr><td colSpan={3} style={{ color: "var(--muted)" }}>Nothing marked this month yet.</td></tr>}
          {[...(data || [])].sort((a, b) => +new Date(b.date) - +new Date(a.date)).map((r) => (
            <tr key={r.id}><td>{dstr(r.date)}</td><td>{new Date(r.date).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}</td><td>{ATT_LABEL[r.status] || r.status}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="note">Leave and Holiday days are inferred automatically (from approved leave requests and the holiday calendar) on the HR attendance report — you only mark Present / Work From Home here.</div>
    </Panel>
  );
}

// =====================================================================================
// Leave Approvals (manager / HR / admin)
// =====================================================================================
const PERMISSION_TYPE_LABEL: Record<string, string> = { LATE_COMING: "Late Coming", EARLY_GOING: "Early Going", PERSONAL_WORK: "Personal Work (Short Leave)", OFFICIAL_DUTY: "On Duty / Official Work", CLIENT_VISIT: "Client Visit" };

export function LeaveApprovals() {
  const { show } = useToast();
  const { user } = useAuth();
  const canCreditCompOff = HR_SETTINGS_ROLES.includes(user?.role || "");
  const { data, reload } = useFetch<any[]>("/ess/leave-requests/pending");
  const { data: employees } = useFetch<any[]>(canCreditCompOff ? "/employees" : "/ess/leave-requests/pending"); // harmless re-fetch when not permitted — avoids a 403 for PM
  const { data: regRequests, reload: reloadReg } = useFetch<any[]>("/ess/attendance/regularization/pending");
  const { data: permRequests, reload: reloadPerm } = useFetch<any[]>("/ess/permission-requests/pending");
  const [creditForm, setCreditForm] = useState({ employeeId: "", days: "", note: "" });
  const [busy, setBusy] = useState(false);

  const approve = async (id: number) => { try { await api.post(`/ess/leave-requests/${id}/approve`); show("Approved"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const reject = async (id: number) => { try { await api.post(`/ess/leave-requests/${id}/reject`); show("Rejected"); reload(); } catch (e: any) { show(e.message, "error"); } };
  const approveReg = async (id: number) => { try { await api.post(`/ess/attendance/regularization/${id}/approve`); show("Regularization approved"); reloadReg(); } catch (e: any) { show(e.message, "error"); } };
  const rejectReg = async (id: number) => { try { await api.post(`/ess/attendance/regularization/${id}/reject`); show("Regularization rejected"); reloadReg(); } catch (e: any) { show(e.message, "error"); } };
  const approvePerm = async (id: number) => { try { await api.post(`/ess/permission-requests/${id}/approve`); show("Permission approved"); reloadPerm(); } catch (e: any) { show(e.message, "error"); } };
  const rejectPerm = async (id: number) => { try { await api.post(`/ess/permission-requests/${id}/reject`); show("Permission rejected"); reloadPerm(); } catch (e: any) { show(e.message, "error"); } };
  const creditCompOff = async () => {
    if (!creditForm.employeeId || !creditForm.days) return show("Employee and days are required", "error");
    setBusy(true);
    try { await api.post("/ess/comp-off/credit", creditForm); show("Comp-Off credited"); setCreditForm({ employeeId: "", days: "", note: "" }); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div>
      <h1>Leave Approvals</h1>
      <div className="subtitle">Pending leave requests company-wide (this app doesn't yet model a manager hierarchy — every approver sees every request, same scope as Timesheet Approvals).</div>
      <Panel>
        <table><thead><tr><th>Employee</th><th>Leave Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {(data || []).length === 0 && <tr><td colSpan={7} style={{ color: "var(--muted)" }}>Nothing pending.</td></tr>}
            {(data || []).map((r) => (
              <tr key={r.id}>
                <td>{r.employee.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>{r.employee.empNo}</span></td>
                <td>{r.leaveType.name}</td><td>{dstr(r.fromDate)}</td><td>{dstr(r.toDate)}</td>
                <td className="num">{r.days}{r.sandwichDeducted > 0 ? ` (+${r.sandwichDeducted})` : ""}</td>
                <td>{r.reason || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}><AddButton onClick={() => approve(r.id)}>Approve</AddButton>{" "}<GhostButton onClick={() => reject(r.id)}>Reject</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Pending Attendance Regularization Requests" style={{ marginTop: 14 }}>
        <table><thead><tr><th>Employee</th><th>Date</th><th>Requested Check In</th><th>Requested Check Out</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {(regRequests || []).length === 0 && <tr><td colSpan={6} style={{ color: "var(--muted)" }}>Nothing pending.</td></tr>}
            {(regRequests || []).map((r) => (
              <tr key={r.id}>
                <td>{r.employee.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>{r.employee.empNo}</span></td>
                <td>{dstr(r.date)}</td><td>{tstr(r.requestedCheckIn)}</td><td>{tstr(r.requestedCheckOut)}</td>
                <td>{r.reason || "—"}{r.remarks ? <div style={{ fontSize: 11, color: "var(--muted)" }}>Remarks: {r.remarks}</div> : null}</td>
                <td style={{ whiteSpace: "nowrap" }}><AddButton onClick={() => approveReg(r.id)}>Approve</AddButton>{" "}<GhostButton onClick={() => rejectReg(r.id)}>Reject</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Pending Permission Requests" style={{ marginTop: 14 }}>
        <table><thead><tr><th>Employee</th><th>Date</th><th>Type</th><th>From</th><th>To</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {(permRequests || []).length === 0 && <tr><td colSpan={7} style={{ color: "var(--muted)" }}>Nothing pending.</td></tr>}
            {(permRequests || []).map((r) => (
              <tr key={r.id}>
                <td>{r.employee.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>{r.employee.empNo}</span></td>
                <td>{dstr(r.date)}</td><td>{PERMISSION_TYPE_LABEL[r.permissionType] || "Permission"}</td><td>{r.fromTime}</td><td>{r.toTime}</td>
                <td>{r.reason || "—"}{r.remarks ? <div style={{ fontSize: 11, color: "var(--muted)" }}>Remarks: {r.remarks}</div> : null}</td>
                <td style={{ whiteSpace: "nowrap" }}><AddButton onClick={() => approvePerm(r.id)}>Approve</AddButton>{" "}<GhostButton onClick={() => rejectPerm(r.id)}>Reject</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {canCreditCompOff && (
        <Panel title="Credit Comp-Off" style={{ marginTop: 14 }}>
          <div className="subtitle" style={{ marginTop: 0 }}>Grant a comp-off day when an employee works a company holiday/weekend — it expires 30 days after credit (HR-configurable) unless availed sooner.</div>
          <div className="form-grid">
            <SelectField label="Employee" value={creditForm.employeeId} onChange={(e: any) => setCreditForm({ ...creditForm, employeeId: e.target.value })}
              options={[{ value: "", label: "— select —" }, ...(employees || []).map((e: any) => ({ value: e.id, label: `${e.name} (${e.empNo || "—"})` }))]} />
            <Field label="Days" type="number" step="0.5" value={creditForm.days} onChange={(e: any) => setCreditForm({ ...creditForm, days: e.target.value })} />
            <Field label="Note" value={creditForm.note} onChange={(e: any) => setCreditForm({ ...creditForm, note: e.target.value })} />
          </div>
          <AddButton style={{ marginTop: 10 }} disabled={busy} onClick={creditCompOff}>Credit Comp-Off</AddButton>
        </Panel>
      )}
    </div>
  );
}

// =====================================================================================
// Onboarding Documents Review (HR / Finance)
// =====================================================================================
export function OnboardingDocumentsReview() {
  const { show } = useToast();
  const { data, reload } = useFetch<any[]>("/ess/onboarding-docs/all");
  const [selEmployee, setSelEmployee] = useState<number | null>(null);
  const { data: checklist, reload: reloadChecklist } = useFetch<any[]>(`/ess/onboarding-docs/employee/${selEmployee || 0}`, [selEmployee]);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState<any>(null);

  const review = async (status: "APPROVED" | "REJECTED") => {
    try {
      await api.put(`/ess/onboarding-docs/${reviewing.id}/review`, { status, note });
      show(status === "APPROVED" ? "Document approved" : "Document rejected");
      setReviewing(null); setNote(""); reload(); reloadChecklist();
    } catch (e: any) { show(e.message, "error"); }
  };

  const employees = React.useMemo(() => {
    const m = new Map<number, string>();
    (data || []).forEach((d) => m.set(d.employee.id, `${d.employee.name} (${d.employee.empNo || "—"})`));
    return [...m.entries()];
  }, [data]);

  return (
    <div>
      <h1>Onboarding Documents</h1>
      <div className="subtitle">HR/Finance review of employee joining-document checklists.</div>
      <div className="grid cols-2">
        <Panel title="Submitted / Reviewed Documents">
          <table><thead><tr><th>Employee</th><th>Document</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(data || []).length === 0 && <tr><td colSpan={4} style={{ color: "var(--muted)" }}>Nothing submitted yet.</td></tr>}
              {(data || []).map((d) => (
                <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => setSelEmployee(d.employee.id)}>
                  <td>{d.employee.name}</td><td>{d.docType.name}</td>
                  <td><span className={`pill ${d.status === "APPROVED" ? "good" : d.status === "REJECTED" ? "bad" : "accent"}`}>{d.status}</span></td>
                  <td>{d.status === "SUBMITTED" && <GhostButton onClick={(e: any) => { e.stopPropagation(); setReviewing(d); }}>Review</GhostButton>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={selEmployee ? `Full Checklist — ${employees.find(([id]) => id === selEmployee)?.[1] || ""}` : "Select an employee"}>
          {selEmployee ? (
            <table><thead><tr><th>Document</th><th>Required</th><th>Status</th><th></th></tr></thead>
              <tbody>{(checklist || []).map((c: any) => (
                <tr key={c.docTypeId}>
                  <td>{c.docType.name}</td><td>{c.docType.required ? "Yes" : "No"}</td>
                  <td><span className={`pill ${c.status === "APPROVED" ? "good" : c.status === "REJECTED" ? "bad" : c.status === "SUBMITTED" ? "accent" : ""}`}>{c.status}</span></td>
                  <td>{c.status === "SUBMITTED" && <GhostButton onClick={() => setReviewing(c)}>Review</GhostButton>}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div style={{ color: "var(--muted)" }}>Click a row on the left, or an employee will appear here once you review one of their documents.</div>}
        </Panel>
      </div>

      <Modal title={`Review — ${reviewing?.docType?.name || ""}`} open={!!reviewing} onClose={() => setReviewing(null)}>
        {reviewing && (
          <div>
            <div className="note" style={{ marginTop: 0 }}>File: {reviewing.fileName || "—"}</div>
            <Input label="Note (optional)" value={note} onChange={(e: any) => setNote(e.target.value)} full />
            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
              <GhostButton onClick={() => review("REJECTED")}>Reject</GhostButton>
              <AddButton onClick={() => review("APPROVED")}>Approve</AddButton>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// =====================================================================================
// Additional Profile Details — HR review queue. Resolves each submission's flat `values` against
// the same EmployeeProfileFieldConfig catalog the employee's own form renders from, so a field
// renamed/added/removed in HR Settings shows correctly here with zero code changes.
// =====================================================================================
export function ProfileSubmissionsReview() {
  const { show } = useToast();
  const { data: submissions, reload } = useFetch<any[]>("/ess/profile-submissions?status=PENDING");
  const [sel, setSel] = useState<any>(null);
  // Resolved per the SELECTED submission's own employee businessUnitId — a BU with its own
  // independent field set (US & Canada, say) must review against ITS OWN labels, not whichever
  // BU happens to be selected elsewhere, or the company default.
  const buId = sel?.employee?.businessUnitId;
  const { data: fields } = useFetch<any[]>(`/hr-settings/profile-fields?businessUnitId=${buId ?? "null"}`, [buId]);
  const [note, setNote] = useState("");
  const fieldByKey = React.useMemo(() => new Map((fields || []).map((f: any) => [f.key, f])), [fields]);

  const review = async (status: "APPROVED" | "REJECTED") => {
    try {
      await api.post(`/ess/profile-submissions/${sel.employeeId}/review`, { status, note });
      show(status === "APPROVED" ? "Approved" : "Rejected"); setSel(null); setNote(""); reload();
    } catch (e: any) { show(e.message, "error"); }
  };

  return (
    <div>
      <h1>Additional Profile Details — Review</h1>
      <div className="subtitle">Employee-submitted Personal/Address/Bank/PF/KYC details, Education, Family and Nomination — awaiting HR approval.</div>
      <div className="grid cols-2">
        <Panel title={`Pending (${(submissions || []).length})`}>
          <table><thead><tr><th>Employee</th><th>Submitted</th><th></th></tr></thead>
            <tbody>
              {(submissions || []).length === 0 && <tr><td colSpan={3} style={{ color: "var(--muted)" }}>Nothing pending.</td></tr>}
              {(submissions || []).map((s: any) => (
                <tr key={s.id} style={{ cursor: "pointer", background: sel?.id === s.id ? "var(--panel2)" : undefined }} onClick={() => setSel(s)}>
                  <td>{s.employee?.name} ({s.employee?.empNo || "—"})</td>
                  <td style={{ color: "var(--muted)" }}>{fmtDate(s.submittedAt)}</td>
                  <td><GhostButton onClick={(e: any) => { e.stopPropagation(); setSel(s); }}>Review</GhostButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={sel ? `Details — ${sel.employee?.name}` : "Select a submission"}>
          {!sel ? <div style={{ color: "var(--muted)" }}>Click a row on the left.</div> : (
            <div>
              <table><tbody>
                {Object.entries(sel.values || {}).map(([key, v]: any) => (
                  <tr key={key}><td>{fieldByKey.get(key)?.label || key}</td><td className="num">{typeof v === "boolean" ? (v ? "Yes" : "No") : String(v || "—")}</td></tr>
                ))}
              </tbody></table>
              {(sel.education || []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Education</div>
                  <table><tbody>{sel.education.map((e: any, i: number) => <tr key={i}><td>{e.institution}</td><td>{e.degree}</td><td>{e.fieldOfStudy}</td><td className="num">{e.yearOfCompletion}</td></tr>)}</tbody></table>
                </div>
              )}
              {(sel.family || []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Family</div>
                  <table><tbody>{sel.family.map((e: any, i: number) => <tr key={i}><td>{e.name}</td><td>{e.relation}</td><td>{e.dateOfBirth}</td><td className="num">{e.gender}</td></tr>)}</tbody></table>
                </div>
              )}
              {(sel.nomination || []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Nomination</div>
                  <table><tbody>{sel.nomination.map((e: any, i: number) => <tr key={i}><td>{e.name}</td><td>{e.relation}</td><td className="num">{e.percentage}</td></tr>)}</tbody></table>
                </div>
              )}
              <Input label="Note (optional)" value={note} onChange={(e: any) => setNote(e.target.value)} full />
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <GhostButton onClick={() => review("REJECTED")}>Reject</GhostButton>
                <AddButton onClick={() => review("APPROVED")}>Approve</AddButton>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

// =====================================================================================
// Leave Policy — tab inside HR Admin Settings (Hr.tsx renders this)
// =====================================================================================
const COUNTRIES = [{ value: "INDIA", label: "India" }, { value: "US", label: "United States" }, { value: "CANADA", label: "Canada" }];

// Split out of LeavePolicySettings into its own HR Settings tab — the checklist isn't leave
// policy, it's the document set HR picks from on Generate Offer / Service Agreement, and having
// it buried under "Leave Policy" made it easy to miss.
export function OnboardingDocumentChecklistSettings({ businessUnitId = "null" }: { businessUnitId?: string }) {
  const { data: docTypes, reload: reloadDocTypes } = useFetch<any[]>(`/hr-settings/leave/onboarding-doc-types?businessUnitId=${businessUnitId}`, [businessUnitId]);
  const { show } = useToast();
  const [newDoc, setNewDoc] = useState("");
  const addDocType = async () => {
    if (!newDoc.trim()) return;
    await api.post("/hr-settings/leave/onboarding-doc-types", { name: newDoc, required: true, order: (docTypes || []).length, businessUnitId: businessUnitId === "null" ? null : Number(businessUnitId) });
    setNewDoc(""); show("Document type added"); reloadDocTypes();
  };
  const deleteDocType = async (id: number) => {
    const ok = await confirmDialog({ title: "Remove this document type from the checklist?", danger: true });
    if (!ok) return;
    await api.del(`/hr-settings/leave/onboarding-doc-types/${id}`); show("Removed"); reloadDocTypes();
  };
  if (docTypes && docTypes.length === 0 && businessUnitId !== "null") {
    return <CloneFromDefaultBanner businessUnitId={businessUnitId} cloneUrl="/hr-settings/leave/onboarding-doc-types/clone-to-bu" onCloned={reloadDocTypes} label="Onboarding Document Checklist" />;
  }
  return (
    <Panel title="Onboarding Document Checklist (all countries)">
      <div className="subtitle" style={{ marginTop: 0 }}>Add, rename or delete the documents HR can pick from when generating an Offer or Service Agreement — click a name to rename it.</div>
      <table><thead><tr><th>Document</th><th>Required</th><th></th></tr></thead>
        <tbody>{(docTypes || []).map((d) => (
          <tr key={d.id}>
            <td>
              <input defaultValue={d.name} style={{ width: "100%", background: "transparent", border: "1px solid transparent" }}
                onFocus={(e) => { e.target.style.border = "1px solid var(--border)"; }}
                onBlur={async (e) => { e.target.style.border = "1px solid transparent"; const name = e.target.value.trim(); if (name && name !== d.name) { await api.put(`/hr-settings/leave/onboarding-doc-types/${d.id}`, { name }); reloadDocTypes(); } }} />
            </td>
            <td><input type="checkbox" defaultChecked={d.required} onChange={async (e) => { await api.put(`/hr-settings/leave/onboarding-doc-types/${d.id}`, { required: e.target.checked }); reloadDocTypes(); }} /></td>
            <td><GhostButton onClick={() => deleteDocType(d.id)}>Delete</GhostButton></td>
          </tr>
        ))}</tbody>
      </table>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1 }}><Field label="New Document" value={newDoc} onChange={(e: any) => setNewDoc(e.target.value)} /></div>
        <AddButton onClick={addDocType}>Add</AddButton>
      </div>
    </Panel>
  );
}

export function LeavePolicySettings({ businessUnitId = "null" }: { businessUnitId?: string }) {
  // No independent Country picker here (removed by request) — leave policy follows the
  // selected Business Unit's own country; "Company Default" (businessUnitId "null") falls
  // back to India, the system's own default operating country everywhere else.
  const { data: bus } = useFetch<any[]>("/hr-settings/business-units");
  const selectedBu = (bus || []).find((b: any) => String(b.id) === businessUnitId);
  const country = selectedBu?.countryCode || "INDIA";
  const { data: types, reload } = useFetch<any[]>(`/hr-settings/leave/leave-types?countryCode=${country}&businessUnitId=${businessUnitId}`, [country, businessUnitId]);
  const { data: cfg, reload: reloadCfg } = useFetch<any>(`/hr-settings/leave/policy-config?countryCode=${country}&businessUnitId=${businessUnitId}`, [country, businessUnitId]);
  const { show } = useToast();
  const [newType, setNewType] = useState({ key: "", name: "" });
  const buId = businessUnitId === "null" ? null : Number(businessUnitId);

  const saveType = async (id: number, patch: any) => { await api.put(`/hr-settings/leave/leave-types/${id}`, patch); show("Saved"); reload(); };
  const addType = async () => {
    if (!newType.key.trim() || !newType.name.trim()) return show("Key and Name are required", "error");
    await api.post("/hr-settings/leave/leave-types", { ...newType, countryCode: country, businessUnitId: buId, order: (types || []).length });
    setNewType({ key: "", name: "" }); show("Leave type added"); reload();
  };
  const deleteType = async (id: number) => {
    const ok = await confirmDialog({ title: "Delete leave type?", danger: true, message: "Any existing balances/requests for it stay, but it can no longer be applied for." });
    if (!ok) return;
    await api.del(`/hr-settings/leave/leave-types/${id}`); show("Deleted"); reload();
  };
  const saveCfg = async (field: string, value: any) => { await api.put("/hr-settings/leave/policy-config", { countryCode: country, businessUnitId: buId, [field]: value }); show("Saved"); reloadCfg(); };
  const cloneTypes = async () => {
    try {
      const r: any = await api.post("/hr-settings/leave/leave-types/clone-to-bu", { businessUnitId: buId, countryCode: country });
      if (r.cloned === 0) show(`Country Default has no leave types configured for ${country} yet — add one below to get started (only India's leave policy has real entitlement numbers seeded so far).`, "error");
      else show(`Cloned ${r.cloned} leave type(s) from Country Default`);
      reload();
    } catch (e: any) { show(e.message, "error"); }
  };

  return (
    <div>
      {(types || []).length === 0 && businessUnitId !== "null" && (
        <div className="note" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <span>No Leave Types configured for this Business Unit yet — it currently falls back to the Country Default.</span>
          <AddButton onClick={cloneTypes}>Clone from Country Default</AddButton>
        </div>
      )}
      <Panel title={`Leave Types — ${COUNTRIES.find((c) => c.value === country)?.label || country}`}>
        <table><thead><tr>
          <th>Key</th><th>Name</th><th className="num">Accrual/mo</th><th className="num">Annual Qty</th>
          <th className="num">Max Carry Fwd</th><th className="num">Max Consec. Days</th><th>Probation Gated</th><th>Sandwich Elig.</th><th>Lapses Y/E</th><th></th>
        </tr></thead>
          <tbody>
            {(types || []).length === 0 && <tr><td colSpan={10} style={{ color: "var(--muted)" }}>No leave types configured for {country} yet — add one below.</td></tr>}
            {(types || []).map((t) => (
              <tr key={t.id}>
                <td>{t.key}</td>
                <td><input defaultValue={t.name} style={{ width: 160 }} onBlur={(e) => { if (e.target.value !== t.name) saveType(t.id, { name: e.target.value }); }} /></td>
                <td className="num"><input type="number" step="0.1" defaultValue={t.accrualPerMonth} style={{ width: 70, textAlign: "right" }} onBlur={(e) => { const v = Number(e.target.value); if (v !== t.accrualPerMonth) saveType(t.id, { accrualPerMonth: v }); }} /></td>
                <td className="num"><input type="number" placeholder="—" defaultValue={t.annualQuota ?? ""} style={{ width: 70, textAlign: "right" }} onBlur={(e) => { const raw = e.target.value; const v = raw === "" ? "" : Number(raw); if (v !== (t.annualQuota ?? "")) saveType(t.id, { annualQuota: v }); }} /></td>
                <td className="num"><input type="number" placeholder="—" defaultValue={t.maxCarryForward ?? ""} style={{ width: 70, textAlign: "right" }} onBlur={(e) => { const raw = e.target.value; const v = raw === "" ? "" : Number(raw); if (v !== (t.maxCarryForward ?? "")) saveType(t.id, { maxCarryForward: v }); }} /></td>
                <td className="num"><input type="number" placeholder="—" defaultValue={t.maxConsecutiveDays ?? ""} style={{ width: 70, textAlign: "right" }} onBlur={(e) => { const raw = e.target.value; const v = raw === "" ? "" : Number(raw); if (v !== (t.maxConsecutiveDays ?? "")) saveType(t.id, { maxConsecutiveDays: v }); }} /></td>
                <td><input type="checkbox" defaultChecked={t.requiresProbationComplete} onChange={(e) => saveType(t.id, { requiresProbationComplete: e.target.checked })} /></td>
                <td><input type="checkbox" defaultChecked={t.sandwichEligible} onChange={(e) => saveType(t.id, { sandwichEligible: e.target.checked })} /></td>
                <td><input type="checkbox" defaultChecked={t.lapsesAtYearEnd} onChange={(e) => saveType(t.id, { lapsesAtYearEnd: e.target.checked })} /></td>
                <td><GhostButton onClick={() => deleteType(t.id)}>Delete</GhostButton></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}><Field label="New Key (e.g. SICK)" value={newType.key} onChange={(e: any) => setNewType({ ...newType, key: e.target.value.toUpperCase() })} /></div>
          <div style={{ flex: 1 }}><Field label="New Leave Type Name" value={newType.name} onChange={(e: any) => setNewType({ ...newType, name: e.target.value })} /></div>
          <AddButton onClick={addType}>Add Leave Type</AddButton>
        </div>
        <div className="note">Blur a cell to save it. Accrual/mo drives month-by-month accrual (e.g. Earned Leave = 1); Annual Qty is a flat yearly grant instead (e.g. General Leave = 6) — set only one of the two per type.</div>
      </Panel>

      <Panel title="Global Policy Knobs" style={{ marginTop: 14 }}>
        {cfg && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <input type="checkbox" defaultChecked={cfg.sandwichEnabled} onChange={(e) => saveCfg("sandwichEnabled", e.target.checked)} />
              Sandwich-leave rule enabled (Fri + following Mon leave also deducts the Sat/Sun in between)
            </label>
            <Field label="Sandwich Rule — total days deducted (informational)" type="number" defaultValue={cfg.sandwichDays} onBlur={(e: any) => saveCfg("sandwichDays", Number(e.target.value))} />
            <Field label="Probation Period (days)" type="number" defaultValue={cfg.probationDays} onBlur={(e: any) => saveCfg("probationDays", Number(e.target.value))} />
            <Field label="Comp-Off Expiry (days from credit)" type="number" defaultValue={cfg.compOffExpiryDays} onBlur={(e: any) => saveCfg("compOffExpiryDays", Number(e.target.value))} />
            <Field label="EL Encashment Cap (days)" type="number" defaultValue={cfg.elEncashmentCapDays} onBlur={(e: any) => saveCfg("elEncashmentCapDays", Number(e.target.value))} />
            <Field label="EL Encashment Rate (₹/day)" type="number" defaultValue={cfg.elEncashmentRatePerDay} onBlur={(e: any) => saveCfg("elEncashmentRatePerDay", Number(e.target.value))} />
          </>
        )}
      </Panel>
    </div>
  );
}
