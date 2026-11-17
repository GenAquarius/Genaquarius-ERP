// HR's Appraisal flow — a revised-CTC "Annual Performance Review" letter for an existing active
// employee. Generate → Preview → Issue mirrors Offers & Lifecycle; issuing emails the employee
// and hands the CTC change to Finance/CTO/CEO (see AppraisalApprovals.tsx) — nothing on the
// employee's CTC & Employment History changes until they approve it.
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { useFetch, Panel, Field, SelectField, Masked, useFiscalYears, isMasked } from "../../ui";
import { fmtDate, fmtDateTime } from "../../dateFormat";
import { useToast, GhostButton, AddButton, confirmDialog } from "../../components";
import { EmployeeDocumentsPanel } from "../shared/Masters";

const STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", GENERATED: "Generated", PREVIEWED: "Previewed", ISSUED: "Issued — Pending Finance Approval", APPROVED: "Approved", REJECTED: "Rejected" };
const STATUS_CLASS: Record<string, string> = { DRAFT: "", GENERATED: "accent", PREVIEWED: "accent", ISSUED: "warn", APPROVED: "good", REJECTED: "bad" };
const StatusPill = ({ s }: { s: string }) => <span className={`pill ${STATUS_CLASS[s] || ""}`}>{STATUS_LABEL[s] || s}</span>;

function modeFor(employee: any): "INDIA_COMPONENTS" | "CONTRACTOR" | "ANNUAL_OVERRIDE" {
  if (!employee) return "INDIA_COMPONENTS";
  if (employee.location === "INDIA" && employee.empType !== "CONTRACTOR") return "INDIA_COMPONENTS";
  if (employee.location === "INDIA" && employee.empType === "CONTRACTOR") return "CONTRACTOR";
  return "ANNUAL_OVERRIDE";
}

// Terminal either way (Finance's own final word, no further action expected from HR here) — kept
// together in one "Completed" tab rather than needing a third tab just for Rejected.
const APPRAISAL_DONE_STATUSES = ["APPROVED", "REJECTED"];

export function AppraisalsList() {
  const { data, reload } = useFetch<any[]>("/appraisals");
  const navigate = useNavigate();
  const { show } = useToast();
  const [tab, setTab] = useState<"progress" | "completed">("progress");
  const inProgress = (data || []).filter((a) => !APPRAISAL_DONE_STATUSES.includes(a.status));
  const completed = (data || []).filter((a) => APPRAISAL_DONE_STATUSES.includes(a.status));
  const rows = tab === "progress" ? inProgress : completed;
  const del = async (a: any) => {
    if (!(await confirmDialog({ title: `Delete this rejected appraisal for ${a.employee?.name}?`, danger: true, confirmLabel: "Delete" }))) return;
    try { await api.del(`/appraisals/${a.id}`); show("Appraisal deleted"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Appraisals</h1>
        <AddButton onClick={() => navigate("/hr/appraisals/new")}>New Appraisal</AddButton>
      </div>
      <div className="subtitle">Revised-CTC "Annual Performance Review" letters for existing employees. Draft → Generated → Previewed → Issued (emailed + sent for Finance approval) → Approved/Rejected.</div>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", margin: "12px 0 16px" }}>
        <div onClick={() => setTab("progress")} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === "progress" ? "var(--accent)" : "var(--muted)", borderBottom: tab === "progress" ? "2px solid var(--accent)" : "2px solid transparent" }}>In Progress ({inProgress.length})</div>
        <div onClick={() => setTab("completed")} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === "completed" ? "var(--accent)" : "var(--muted)", borderBottom: tab === "completed" ? "2px solid var(--accent)" : "2px solid transparent" }}>Completed ({completed.length})</div>
      </div>
      <Panel>
        <table><thead><tr><th>Employee</th><th>Designation</th><th>Effective Date</th><th>Status</th>{tab === "completed" && <th></th>}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>{tab === "progress" ? "No appraisals in progress." : "No completed appraisals yet."}</td></tr>}
            {rows.map((a) => (
              <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/hr/appraisals/${a.id}`)}>
                <td>{a.employee?.name}</td><td>{a.designation}</td>
                <td>{fmtDate(a.effectiveDate)}</td>
                <td><StatusPill s={a.status} /></td>
                {tab === "completed" && (
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {a.status === "REJECTED" && <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => del(a)}>Delete</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export function GenerateAppraisal() {
  const { data: employees } = useFetch<any[]>("/employees");
  const { data: designations } = useFetch<any[]>("/hr-settings/designations");
  const fyList = useFiscalYears(); // newest first — fyList[0] is the current fiscal year
  const { show } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [designation, setDesignation] = useState("");
  // HR's own explicit call — the letter adds its own promotion paragraph ("Also, you are promoted
  // to the designation of X") when checked. Not auto-detected from any diff against the employee's
  // current designation, since that's too fragile (whitespace/casing, or re-entering the same title
  // on purpose).
  const [isPromotion, setIsPromotion] = useState(false);
  // Shown only when isPromotion is checked — the actual NEW title, distinct from the "Designation"
  // field above (which stays the employee's CURRENT title for reference). When set, this is what
  // gets submitted as the appraisal's designation (Annexure + promotion paragraph both use it), so
  // the letter never ends up naming a promotion while still showing the old title everywhere else.
  const [newDesignation, setNewDesignation] = useState("");
  const [reviewPeriod, setReviewPeriod] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [revisedCtc, setRevisedCtc] = useState("");
  const [monthlyCompensation, setMonthlyCompensation] = useState("");
  const [annualCostOverride, setAnnualCostOverride] = useState("");
  // Optional second step — a staged raise (e.g. "+11.5L now, +11.5L from Feb") communicated as ONE
  // letter but still becoming two correctly-dated CTC Record segments once Finance approves.
  const [hasSecondStep, setHasSecondStep] = useState(false);
  const [secondEffectiveDate, setSecondEffectiveDate] = useState("");
  const [secondRevisedCtc, setSecondRevisedCtc] = useState("");
  const [secondMonthlyCompensation, setSecondMonthlyCompensation] = useState("");
  const [secondAnnualCostOverride, setSecondAnnualCostOverride] = useState("");
  // Key Result Areas — optional, rendered as its own paragraph; also editable later in the Preview
  // & Edit letter text, same as any other wording.
  const [kra, setKra] = useState("");

  const active = (employees || []).filter((e: any) => !e.exitDate);
  const employee = active.find((e: any) => String(e.id) === employeeId);
  const mode = modeFor(employee);
  // Existing CTC — the employee's own latest CtcRecord (server already orders ctcRecords desc by
  // effectiveFrom), shown for reference right after picking them, before entering the revised figure.
  const currentCtc = employee?.ctcRecords?.[0];
  const currentCtcAnnual = currentCtc != null
    ? (currentCtc.annualCostOverride ?? ((currentCtc.basic || 0) + (currentCtc.hra || 0) + (currentCtc.otherAllowance || 0) + (currentCtc.specialAllowance || 0) + (currentCtc.conveyance || 0) + (currentCtc.communication || 0) + (currentCtc.meals || 0) + (currentCtc.books || 0) + (currentCtc.driver || 0) + (currentCtc.uniform || 0)) * 12 + (currentCtc.bonusAnnual || 0))
    : null;
  const currentCtcMoney = (n: number, ccy: string) => isMasked() ? "•••••" : (ccy === "USD" ? "$" : ccy === "CAD" ? "C$" : "₹") + Math.round(n || 0).toLocaleString("en-IN");
  // Review Period defaults to the current fiscal year the moment the list loads, but only while
  // HR hasn't touched it yet — never stomps a value they already picked.
  if (!reviewPeriod && fyList.length) setReviewPeriod(fyList[0]);

  const pick = (id: string) => {
    setEmployeeId(id);
    const e = active.find((x: any) => String(x.id) === id);
    // Employee Master's own current designation (may have changed since hire — promotions, role
    // changes) takes priority over the original hire-time Offer designation, which was the only
    // source used before and could show a stale title.
    setDesignation(e?.designation || e?.offer?.designation || "");
  };

  const create = async () => {
    if (!employeeId) return show("Select an employee", "error");
    if (!designation.trim()) return show("Designation is required", "error");
    if (isPromotion && !newDesignation.trim()) return show("New Designation is required for a promotion", "error");
    if (!effectiveDate) return show("Effective Date is required", "error");
    if (mode === "INDIA_COMPONENTS" && !revisedCtc) return show("Revised CTC is required", "error");
    if (mode === "CONTRACTOR" && !monthlyCompensation) return show("Revised Monthly Compensation is required", "error");
    if (mode === "ANNUAL_OVERRIDE" && !annualCostOverride) return show("Revised Annual CTC is required", "error");
    if (hasSecondStep) {
      if (!secondEffectiveDate) return show("Second step's Effective Date is required", "error");
      if (new Date(secondEffectiveDate) <= new Date(effectiveDate)) return show("Second step's date must be after the first Effective Date", "error");
      if (mode === "INDIA_COMPONENTS" && !secondRevisedCtc) return show("Second step's Revised CTC is required", "error");
      if (mode === "CONTRACTOR" && !secondMonthlyCompensation) return show("Second step's Revised Monthly Compensation is required", "error");
      if (mode === "ANNUAL_OVERRIDE" && !secondAnnualCostOverride) return show("Second step's Revised Annual CTC is required", "error");
    }
    setBusy(true);
    try {
      // A promotion's New Designation IS the appraisal's designation going forward — the letter's
      // Annexure and greeting must match the same title the promotion paragraph names, not the old one.
      const finalDesignation = isPromotion ? newDesignation.trim() : designation;
      const a = await api.post("/appraisals", {
        employeeId, designation: finalDesignation, isPromotion, reviewPeriod: reviewPeriod || undefined, effectiveDate, revisedCtc, monthlyCompensation, annualCostOverride,
        ...(hasSecondStep ? { secondEffectiveDate, secondRevisedCtc, secondMonthlyCompensation, secondAnnualCostOverride } : {}),
        kra: kra.trim() || undefined,
      });
      show("Appraisal created"); navigate(`/hr/appraisals/${a.id}`);
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div>
      <h1>New Appraisal</h1>
      <div className="subtitle">Select an existing active employee — Contractor and US/Canada employees use a flat revised figure; India Full-Time gets the full salary-bracket breakup.</div>
      <Panel style={{ marginTop: 12 }}>
        <div className="form-grid">
          <SelectField label="Employee" required value={employeeId} onChange={(e: any) => pick(e.target.value)}
            options={[{ value: "", label: "— select —" }, ...active.map((e: any) => ({ value: e.id, label: `${e.name} (${e.empNo || "no code"})` }))]} />
          <SelectField label="Designation" required value={designation} onChange={(e: any) => setDesignation(e.target.value)}
            options={[{ value: "", label: "— select —" }, ...(designations || []).map((d: any) => ({ value: d.name, label: d.name })), ...(designation && !(designations || []).some((d: any) => d.name === designation) ? [{ value: designation, label: `${designation} (current)` }] : [])]} />
          <SelectField label="Review Period" value={reviewPeriod} onChange={(e: any) => setReviewPeriod(e.target.value)}
            options={fyList.map((f) => ({ value: f, label: f }))} />
          <Field label="Effective Date" required type="date" value={effectiveDate} onChange={(e: any) => setEffectiveDate(e.target.value)} />
          {employee && (
            <div>
              <label>Existing CTC (Annual)</label>
              <div style={{ fontWeight: 600, padding: "8px 0" }}>
                {currentCtcAnnual != null ? <Masked>{currentCtcMoney(currentCtcAnnual, currentCtc?.currency || "INR")}</Masked> : "—"}
              </div>
            </div>
          )}
          {employee && mode === "INDIA_COMPONENTS" && <Field label="Revised CTC (Annual, INR)" required type="number" value={revisedCtc} onChange={(e: any) => setRevisedCtc(e.target.value)} />}
          {employee && mode === "CONTRACTOR" && <Field label="Revised Monthly Compensation (INR)" required type="number" value={monthlyCompensation} onChange={(e: any) => setMonthlyCompensation(e.target.value)} />}
          {employee && mode === "ANNUAL_OVERRIDE" && <Field label={`Revised Annual CTC (${employee.location === "US" ? "USD" : "CAD"})`} required type="number" value={annualCostOverride} onChange={(e: any) => setAnnualCostOverride(e.target.value)} />}
        </div>
        <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }} title="Adds its own paragraph to the letter: &quot;Also, you are promoted to the designation of &lt;New Designation&gt;.&quot;">
          <input type="checkbox" checked={isPromotion} onChange={(e) => setIsPromotion(e.target.checked)} />
          This is a promotion — mention the new designation in the letter
        </label>
        {isPromotion && (
          <div className="form-grid" style={{ marginTop: 4 }}>
            <SelectField label="New Designation" required value={newDesignation} onChange={(e: any) => setNewDesignation(e.target.value)}
              options={[{ value: "", label: "— select —" }, ...(designations || []).map((d: any) => ({ value: d.name, label: d.name }))]} />
          </div>
        )}
        {employee && (
          <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }} title="For a big raise given in two dated steps — one letter mentions both; two separate CTC Record segments still get created once Finance approves.">
            <input type="checkbox" checked={hasSecondStep} onChange={(e) => setHasSecondStep(e.target.checked)} />
            This is a staged raise — add a second step (another revision on a later date)
          </label>
        )}
        {employee && hasSecondStep && (
          <div className="form-grid" style={{ marginTop: 4 }}>
            <Field label="Second Step — Effective Date" required type="date" value={secondEffectiveDate} onChange={(e: any) => setSecondEffectiveDate(e.target.value)} />
            {mode === "INDIA_COMPONENTS" && <Field label="Second Step — Revised CTC (Annual, INR)" required type="number" value={secondRevisedCtc} onChange={(e: any) => setSecondRevisedCtc(e.target.value)} />}
            {mode === "CONTRACTOR" && <Field label="Second Step — Revised Monthly Compensation (INR)" required type="number" value={secondMonthlyCompensation} onChange={(e: any) => setSecondMonthlyCompensation(e.target.value)} />}
            {mode === "ANNUAL_OVERRIDE" && <Field label={`Second Step — Revised Annual CTC (${employee.location === "US" ? "USD" : "CAD"})`} required type="number" value={secondAnnualCostOverride} onChange={(e: any) => setSecondAnnualCostOverride(e.target.value)} />}
          </div>
        )}
        {employee && (
          <div className="full" style={{ marginTop: 8 }}>
            <label>Key Result Areas (KRA) — optional, prints as its own paragraph in the letter</label>
            <textarea value={kra} onChange={(e: any) => setKra(e.target.value)} rows={3} style={{ width: "100%", fontFamily: "inherit" }}
              placeholder="e.g. Help in pre-sales activities (client calls, preparing case studies, and assisting with proposals), and take AI sessions for the internal team." />
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <AddButton disabled={busy || !employeeId} onClick={create}>Create Appraisal</AddButton>
        </div>
      </Panel>
      {employee && <Panel style={{ marginTop: 14 }}>
        <EmployeeDocumentsPanel employeeId={employee.id} />
      </Panel>}
    </div>
  );
}

// HR can hand-edit the letter's actual wording — Save persists it (PUT /:id/preview-text), and
// Issue sends exactly whatever was last saved here (see buildPdfData on the server). "Reset to
// default wording" clears the hand-edit and reverts to the live auto-generated text.
function LetterTextPanel({ appraisalId }: { appraisalId: string }) {
  const { data, reload } = useFetch<{ body: string; isCustom: boolean }>(`/appraisals/${appraisalId}/preview-text`, [appraisalId]);
  const { show } = useToast();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only seed the textarea from the fetch the first time (or after a Save/Reset reload) — never
  // stomp what HR is actively typing on an unrelated re-render.
  if (data && text === null) setText(data.body);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/appraisals/${appraisalId}/preview-text`, { body: text || "" });
      show("Letter text saved — Issue will use this wording");
      // The textarea already shows exactly what was just saved — leave it alone. Only reload to
      // refresh the "Custom wording" badge (nulling `text` here would re-seed from `data`, which
      // still holds the PRE-save value until the reload's own fetch resolves — a race that made
      // the box briefly flash back to the old text).
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const resetDefault = async () => {
    if (!(await confirmDialog({ title: "Reset to default wording?", message: "Discards your hand-edited text and reverts to the auto-generated letter.", confirmLabel: "Reset" }))) return;
    setBusy(true);
    try {
      await api.put(`/appraisals/${appraisalId}/preview-text`, { body: "" });
      // Fetch the fresh auto-generated text directly rather than nulling `text` and waiting on
      // reload — same stale-data race as above, just for the reset path.
      const fresh = await api.get(`/appraisals/${appraisalId}/preview-text`);
      setText(fresh.body);
      show("Reverted to default wording");
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  if (!data) return null;
  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>Letter Text — Preview &amp; Edit</div>
        {data.isCustom && <span className="pill accent">Custom wording</span>}
      </div>
      <div className="subtitle" style={{ marginTop: 0 }}>This is exactly what will print on the PDF and go out when you click Issue. Edit, Save, and Preview Appraisal PDF again as many times as you like before issuing.</div>
      <textarea value={text ?? ""} onChange={(e) => setText(e.target.value)} rows={10} style={{ width: "100%", marginTop: 8, fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.5 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <AddButton disabled={busy} onClick={save}>Save Letter Text</AddButton>
        {data.isCustom && <GhostButton disabled={busy} onClick={resetDefault}>Reset to Default Wording</GhostButton>}
      </div>
    </div>
  );
}

export function AppraisalDetail() {
  const { id } = useParams();
  const { data: a, reload } = useFetch<any>(`/appraisals/${id}`);
  const fyList = useFiscalYears();
  const { show } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState<any>(null);
  // HR can correct/override the recipient right on this screen before Issuing — seeded from the
  // Employee Master record, but editable, and whatever's here wins (server: POST /:id/issue).
  const [issueEmail, setIssueEmail] = useState<string>("");
  useEffect(() => { if (a?.employee?.email != null) setIssueEmail(a.employee.email); }, [a?.employee?.email]);

  if (!a) return <div>Loading…</div>;

  const editable = ["DRAFT", "GENERATED"].includes(a.status);
  const deletable = ["DRAFT", "GENERATED", "PREVIEWED"].includes(a.status);

  const act = async (path: string, body?: any) => {
    setBusy(true);
    try {
      const r: any = await api.post(`/appraisals/${id}${path}`, body);
      if (r?.emailedEmployee !== undefined) show(`Issued${r.emailedEmployee ? " — emailed employee" : ""}${r.notified > 0 ? ` — notified ${r.notified} of ${r.totalRecipients} approver(s)` : ""}`);
      else show("Done");
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const startEdit = () => {
    setEf({
      designation: a.designation, isPromotion: !!a.isPromotion, reviewPeriod: a.reviewPeriod || "", effectiveDate: a.effectiveDate?.slice(0, 10) || "",
      revisedCtc: a.revisedCtc ?? "", monthlyCompensation: a.monthlyCompensation ?? "", annualCostOverride: a.annualCostOverride ?? "",
      hasSecondStep: !!a.secondEffectiveDate, secondEffectiveDate: a.secondEffectiveDate?.slice(0, 10) || "",
      secondRevisedCtc: a.secondRevisedCtc ?? "", secondMonthlyCompensation: a.secondMonthlyCompensation ?? "", secondAnnualCostOverride: a.secondAnnualCostOverride ?? "",
      kra: a.kra || "",
    });
    setEditing(true);
  };
  const saveEdit = async () => {
    if (ef.hasSecondStep && (!ef.secondEffectiveDate || new Date(ef.secondEffectiveDate) <= new Date(ef.effectiveDate))) {
      return show("Second step's date must be after the first Effective Date", "error");
    }
    setBusy(true);
    try {
      const { hasSecondStep, ...rest } = ef;
      await api.put(`/appraisals/${id}`, { ...rest, ...(hasSecondStep ? {} : { secondEffectiveDate: null, secondRevisedCtc: null, secondMonthlyCompensation: null, secondAnnualCostOverride: null }) });
      show("Appraisal updated — Generate again before Issuing");
      setEditing(false); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm(`Delete this appraisal for ${a.employee?.name}? This cannot be undone.`)) return;
    setBusy(true);
    try { await api.del(`/appraisals/${id}`); show("Appraisal deleted"); navigate("/hr/appraisals"); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  const mode = modeFor(a.employee);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{a.employee?.name} <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>{a.appraisalRef}</span></h1>
          <div className="subtitle">{a.designation}{a.reviewPeriod ? ` · ${a.reviewPeriod}` : ""} · Effective {fmtDate(a.effectiveDate)}{a.secondEffectiveDate ? ` · Second step ${fmtDate(a.secondEffectiveDate)}` : ""}</div>
        </div>
        <StatusPill s={a.status} />
      </div>
      <Panel style={{ marginTop: 12 }}>
        {!editing ? (
          <>
            <table><tbody>
              <tr><td>Employee ID</td><td className="num">{a.employee?.empNo || "—"}</td></tr>
              <tr><td>Employee Email</td><td className="num">
                {["DRAFT", "GENERATED", "PREVIEWED"].includes(a.status) ? (
                  <Field value={issueEmail} onChange={(e: any) => setIssueEmail(e.target.value)} placeholder="Email to send the appraisal letter to (testing: use your own — not saved to the employee)" />
                ) : (a.employee?.email || <span style={{ color: "var(--bad, #e5484d)" }}>No email on file — Issue will fail</span>)}
              </td></tr>
              <tr><td>Location / Type</td><td className="num">{a.countryCode} · {a.empType}</td></tr>
              {a.revisedCtc != null && <tr><td>Revised CTC (Annual)</td><td className="num"><Masked>₹{Math.round(a.revisedCtc).toLocaleString("en-IN")}</Masked></td></tr>}
              {a.monthlyCompensation != null && <tr><td>Revised Monthly Compensation</td><td className="num"><Masked>₹{Math.round(a.monthlyCompensation).toLocaleString("en-IN")}</Masked></td></tr>}
              {a.annualCostOverride != null && <tr><td>Revised Annual CTC</td><td className="num"><Masked>{a.countryCode === "US" ? "$" : "C$"}{Math.round(a.annualCostOverride).toLocaleString("en-IN")}</Masked></td></tr>}
              {a.secondEffectiveDate && <tr><td>Second Step — Effective Date</td><td className="num">{fmtDate(a.secondEffectiveDate)}</td></tr>}
              {a.secondRevisedCtc != null && <tr><td>Second Step — Revised CTC (Annual)</td><td className="num"><Masked>₹{Math.round(a.secondRevisedCtc).toLocaleString("en-IN")}</Masked></td></tr>}
              {a.secondMonthlyCompensation != null && <tr><td>Second Step — Revised Monthly Compensation</td><td className="num"><Masked>₹{Math.round(a.secondMonthlyCompensation).toLocaleString("en-IN")}</Masked></td></tr>}
              {a.secondAnnualCostOverride != null && <tr><td>Second Step — Revised Annual CTC</td><td className="num"><Masked>{a.countryCode === "US" ? "$" : "C$"}{Math.round(a.secondAnnualCostOverride).toLocaleString("en-IN")}</Masked></td></tr>}
              {a.kra && <tr><td>KRA</td><td className="num" style={{ whiteSpace: "pre-wrap", textAlign: "left" }}>{a.kra}</td></tr>}
              {a.reviewedAt && <tr><td>{a.status === "APPROVED" ? "Approved" : "Reviewed"} On</td><td className="num">{fmtDateTime(a.reviewedAt)}</td></tr>}
              {a.reviewNote && <tr><td>Review Note</td><td className="num">{a.reviewNote}</td></tr>}
            </tbody></table>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {a.status === "DRAFT" && <AddButton disabled={busy} onClick={() => act("/generate")}>Generate</AddButton>}
              {["GENERATED", "PREVIEWED"].includes(a.status) && <>
                <GhostButton disabled={busy} onClick={async () => { await act("/preview"); window.open(api.pdfUrl(`/appraisals/${id}/pdf`), "_blank"); }}>Preview Appraisal PDF</GhostButton>
                <AddButton disabled={busy || !issueEmail.trim()} onClick={() => act("/issue", { email: issueEmail.trim() })}>Issue Appraisal Letter</AddButton>
              </>}
              {["ISSUED", "APPROVED"].includes(a.status) && <GhostButton disabled={busy} onClick={() => window.open(api.pdfUrl(`/appraisals/${id}/pdf`), "_blank")}>View PDF</GhostButton>}
              {editable && <GhostButton disabled={busy} onClick={startEdit}>Edit</GhostButton>}
              {deletable && <GhostButton disabled={busy} onClick={del} style={{ color: "var(--bad, #e5484d)" }}>Delete</GhostButton>}
              <GhostButton onClick={() => navigate("/hr/appraisals")}>← All Appraisals</GhostButton>
            </div>
            {a.status === "ISSUED" && <div className="note" style={{ marginTop: 10 }}>Waiting on Finance/CTO/CEO to approve the revised CTC — nothing changes on {a.employee?.name}'s CTC & Employment History until then.</div>}
            {a.status === "APPROVED" && <div className="note" style={{ marginTop: 10 }}>Approved — a new CTC Record has been added to {a.employee?.name}'s Employment History{a.secondEffectiveDate ? ", plus a second dated segment for the staged step" : ""}.</div>}
            {["GENERATED", "PREVIEWED"].includes(a.status) && <LetterTextPanel appraisalId={id!} />}
          </>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Designation" required value={ef.designation} onChange={(e: any) => setEf({ ...ef, designation: e.target.value })} />
              <label className="full" style={{ display: "flex", alignItems: "center", gap: 8 }} title="Adds its own paragraph to the letter: &quot;Also, you are promoted to the designation of &lt;Designation&gt;.&quot;">
                <input type="checkbox" checked={ef.isPromotion} onChange={(e) => setEf({ ...ef, isPromotion: e.target.checked })} />
                This is a promotion — mention the new designation in the letter
              </label>
              <SelectField label="Review Period" value={ef.reviewPeriod} onChange={(e: any) => setEf({ ...ef, reviewPeriod: e.target.value })}
                options={[{ value: "", label: "— none —" }, ...fyList.map((f) => ({ value: f, label: f }))]} />
              <Field label="Effective Date" required type="date" value={ef.effectiveDate} onChange={(e: any) => setEf({ ...ef, effectiveDate: e.target.value })} />
              {a.revisedCtc != null && <Field label="Revised CTC (Annual)" type="number" value={ef.revisedCtc} onChange={(e: any) => setEf({ ...ef, revisedCtc: e.target.value })} />}
              {a.monthlyCompensation != null && <Field label="Revised Monthly Compensation" type="number" value={ef.monthlyCompensation} onChange={(e: any) => setEf({ ...ef, monthlyCompensation: e.target.value })} />}
              {a.annualCostOverride != null && <Field label="Revised Annual CTC" type="number" value={ef.annualCostOverride} onChange={(e: any) => setEf({ ...ef, annualCostOverride: e.target.value })} />}
            </div>
            <label className="full" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }} title="For a big raise given in two dated steps — one letter mentions both; two separate CTC Record segments still get created once Finance approves.">
              <input type="checkbox" checked={ef.hasSecondStep} onChange={(e) => setEf({ ...ef, hasSecondStep: e.target.checked })} />
              This is a staged raise — add a second step (another revision on a later date)
            </label>
            {ef.hasSecondStep && (
              <div className="form-grid" style={{ marginTop: 4 }}>
                <Field label="Second Step — Effective Date" required type="date" value={ef.secondEffectiveDate} onChange={(e: any) => setEf({ ...ef, secondEffectiveDate: e.target.value })} />
                {mode === "INDIA_COMPONENTS" && <Field label="Second Step — Revised CTC (Annual, INR)" required type="number" value={ef.secondRevisedCtc} onChange={(e: any) => setEf({ ...ef, secondRevisedCtc: e.target.value })} />}
                {mode === "CONTRACTOR" && <Field label="Second Step — Revised Monthly Compensation (INR)" required type="number" value={ef.secondMonthlyCompensation} onChange={(e: any) => setEf({ ...ef, secondMonthlyCompensation: e.target.value })} />}
                {mode === "ANNUAL_OVERRIDE" && <Field label={`Second Step — Revised Annual CTC (${a.countryCode === "US" ? "USD" : "CAD"})`} required type="number" value={ef.secondAnnualCostOverride} onChange={(e: any) => setEf({ ...ef, secondAnnualCostOverride: e.target.value })} />}
              </div>
            )}
            <div className="full" style={{ marginTop: 8 }}>
              <label>Key Result Areas (KRA) — optional, prints as its own paragraph in the letter</label>
              <textarea value={ef.kra} onChange={(e: any) => setEf({ ...ef, kra: e.target.value })} rows={3} style={{ width: "100%", fontFamily: "inherit" }} />
            </div>
            <div className="note" style={{ marginTop: 8 }}>Saving invalidates any prior Generate — Generate again before Issuing.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <AddButton disabled={busy} onClick={saveEdit}>Save Changes</AddButton>
              <GhostButton disabled={busy} onClick={() => setEditing(false)}>Cancel</GhostButton>
            </div>
          </>
        )}
      </Panel>
      {a.employee?.id && <Panel style={{ marginTop: 14 }}>
        <EmployeeDocumentsPanel employeeId={a.employee.id} />
      </Panel>}
    </div>
  );
}
