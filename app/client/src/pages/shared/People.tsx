import React, { useState, useEffect } from "react";
import { api } from "../../api";
import { useFetch, fmt, Panel, Field, SelectField, EsignPanel, useMaskNumbers } from "../../ui";
import { DataTable, useSortFilter, SortableHead, FilterToggle } from "../../DataTable";
import { Modal, Input, Select, useToast, confirmDialog, AddButton } from "../../components";
import { useAuth } from "../../auth";
import { CountrySettings, BusinessUnitSettings, OrganizationSettings } from "../hrms/Hr";
import { DATE_FORMATS, setDateFormatCache, fmtDateTime } from "../../dateFormat";

const ROLES = ["CEO", "COO", "CTO", "FINANCE", "HR", "PROJECT_MANAGER", "EMPLOYEE", "CONTRACTOR", "INTERN", "IT_ADMIN", "QA"];

// ---------------- Users & Roles (admin) ----------------
export function Users() {
  const { show } = useToast();
  const { user: me } = useAuth();
  const { data, loading, reload } = useFetch<any[]>("/admin/users");
  const { data: tenant, reload: reloadTenant } = useFetch<any>("/admin/tenant/status");
  // For the Employee picker — someone with an EMPLOYEE/CONTRACTOR login but no employeeId link
  // gets "No employee record is linked to this user account" the moment they open Employee
  // Dashboard/My Profile/My Timesheet, with no self-service way to fix it until now.
  const { data: employees, reload: reloadEmployees } = useFetch<any[]>("/employees");
  const blank = { id: null, name: "", email: "", role: "EMPLOYEE", password: "", isActive: true, employeeId: "" };
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const valid = form && form.name.trim() && form.email.trim();
  const employeeById = new Map((employees || []).map((e: any) => [e.id, e]));
  // Full picker list for the Match Employee Emails review table — every active employee still
  // missing an email, sorted by name, so a wrong/missing suggestion can always be corrected to the
  // right person instead of being stuck with whatever the fuzzy-match algorithm guessed.
  const unmatchedEmployees = (employees || []).filter((e: any) => !e.exitDate && !e.email).sort((a: any, b: any) => a.name.localeCompare(b.name));

  const saveUser = async () => {
    if (!valid) return show("Name and Email are required", "error");
    setBusy(true);
    try {
      const employeeId = form.employeeId ? Number(form.employeeId) : null;
      if (form.id) { await api.put(`/admin/users/${form.id}`, { name: form.name, role: form.role, isActive: form.isActive, employeeId, ...(form.password ? { password: form.password } : {}) }); show("User updated"); }
      else { await api.post("/admin/users", { ...form, employeeId }); show("User added"); }
      setForm(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const delUser = async (u: any) => {
    if (!window.confirm(`Delete user ${u.name} (${u.email})? This cannot be undone.`)) return;
    try { await api.del(`/admin/users/${u.id}`); show("User deleted"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleAll = (rows: any[]) => {
    const selectable = rows.filter((u) => u.id !== me?.id).map((u) => u.id);
    setSelected(selected.size === selectable.length ? new Set() : new Set(selectable));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const bulkDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} selected user(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r: any = await api.post("/admin/users/bulk-delete", { ids: Array.from(selected) });
      show(`Deleted ${r.deleted} user(s)${r.skipped ? `; skipped ${r.skipped}` : ""}`);
      setSelected(new Set()); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const setRole = async (id: number, role: string) => { await api.put(`/admin/users/${id}/role`, { role }); show("Role updated"); reload(); };
  const consent = async () => { await api.post("/admin/tenant/consent", { authConfig: {} }); show("Tenant consent recorded"); reloadTenant(); };
  const importTenant = async () => {
    try {
      const r = await api.post("/admin/tenant/import", {});
      show(`Imported ${r.created} new user(s); ${r.skipped} already existed (role: MEMBER)${r.linked ? `; linked ${r.linked} existing login(s) to their Employee record` : ""}.`);
      reload();
    } catch (e: any) { show(e.message, "error"); }
  };

  // Match Employee Emails — read-only suggestions (real Entra name+email vs Employee Master
  // records missing an email), reviewed and confirmed here before anything is written. Each row:
  // { entraName, entraEmail, candidates: [{id,name,empNo}], selected, chosenEmployeeId }.
  const [matchRows, setMatchRows] = useState<any[] | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchApplying, setMatchApplying] = useState(false);
  const loadMatches = async () => {
    setMatchLoading(true);
    try {
      const rows: any[] = await api.get("/admin/tenant/match-employees");
      // email starts as the Entra-suggested one but is a freely-editable field per row — the
      // directory email itself can be wrong/outdated, so this isn't locked to what Entra returned.
      setMatchRows(rows.map((r) => ({ ...r, selected: r.candidates.length === 1, chosenEmployeeId: r.candidates[0]?.id ?? "", email: r.entraEmail })));
    } catch (e: any) { show(e.message, "error"); } finally { setMatchLoading(false); }
  };
  const applyMatches = async () => {
    const updates = (matchRows || [])
      .filter((r) => r.selected && r.chosenEmployeeId && r.email.trim())
      .map((r) => ({ employeeId: Number(r.chosenEmployeeId), email: r.email.trim() }));
    if (!updates.length) return show("Nothing selected", "error");
    setMatchApplying(true);
    try {
      const r: any = await api.post("/admin/tenant/apply-employee-emails", { updates });
      show(`Updated ${r.applied} employee email(s)`);
      setMatchRows(null);
      reloadEmployees();
    } catch (e: any) { show(e.message, "error"); } finally { setMatchApplying(false); }
  };

  return (
    <div>
      <h1>Users &amp; Roles</h1>
      <div className="subtitle">Add users manually or import everyone from the GenAquarius tenant. Admins assign CEO/CTO/Finance roles here.</div>

      <Panel title="GenAquarius Tenant (Microsoft Entra)" style={{ marginBottom: 14 }}>
        <div className="row" style={{ alignItems: "center" }}>
          <div><span className="pill">Status: {tenant?.status || "DISCONNECTED"}</span>
            {tenant?.lastSyncAt && <span className="pill" style={{ marginLeft: 8 }}>Last import: {fmtDateTime(tenant.lastSyncAt)}</span>}</div>
          <div style={{ flex: 0 }}><button className="ghost" onClick={consent}>Grant Admin Consent</button></div>
          <div style={{ flex: 0 }}><button onClick={importTenant} disabled={tenant?.status !== "CONNECTED"}>Import Employees</button></div>
          <div style={{ flex: 0 }}><button className="ghost" onClick={loadMatches} disabled={tenant?.status !== "CONNECTED" || matchLoading}>{matchLoading ? "Checking…" : "Match Employee Emails"}</button></div>
        </div>
        <div className="subtitle" style={{ marginTop: 8 }}>Imported people default to the <b>MEMBER</b> (employee) role; elevate to CEO/CTO/Finance in the table below. "Match Employee Emails" suggests Employee Master email backfills from the real Entra directory — nothing is written until you review and confirm.</div>
      </Panel>

      <div className="btn-row">
        <button onClick={() => setForm({ ...blank })}>＋ Add User</button>
        <button className="ghost" onClick={() => toggleAll(data || [])} style={{ marginLeft: 8 }}>{selected.size ? "Clear Selection" : "Select All"}</button>
        {selected.size > 0 && <button className="ghost" onClick={bulkDelete} disabled={busy} style={{ marginLeft: 8 }}>Delete Selected ({selected.size})</button>}
      </div>
      <Panel>{loading ? "Loading…" : <DataTable rows={data || []} pageSize={12} searchKeys={(u: any) => `${u.name} ${u.email} ${u.role}`}
        columns={[
          { key: "sel", label: "Select", noSort: true,
            render: (u: any) => u.id === me?.id ? null : <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} /> },
          { key: "name", label: "Name" }, { key: "email", label: "Email" },
          { key: "role", label: "Role (assign)", render: (u: any) => (
            <select value={u.role} onChange={(e) => setRole(u.id, e.target.value)} style={{ width: 150 }}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          ) },
          { key: "active", label: "Active", render: (u: any) => (u.isActive ? "Yes" : "No") },
          { key: "employee", label: "Linked Employee", render: (u: any) => {
            const emp = u.employeeId ? employeeById.get(u.employeeId) : null;
            return emp ? <span>{emp.name}{emp.empNo ? ` (${emp.empNo})` : ""}</span> : <span className="pill warn" title="Employee Dashboard / My Timesheet / My Profile won't work until this is linked">Not linked</span>;
          } },
          { key: "actions", label: "Actions", render: (u: any) => (
            <span style={{ whiteSpace: "nowrap" }}>
              <button className="ghost" onClick={() => setForm({ id: u.id, name: u.name, email: u.email, role: ROLES.includes(u.role) ? u.role : "EMPLOYEE", isActive: u.isActive !== false, password: "", employeeId: u.employeeId || "" })}>Edit</button>{" "}
              {u.id !== me?.id && <button className="ghost" onClick={() => delUser(u)}>Delete</button>}
            </span>
          ) },
        ]} />}</Panel>

      <Modal title={form?.id ? "Edit User" : "Add User"} open={!!form} onClose={() => setForm(null)} onSave={saveUser} busy={busy} canSave={!!valid} saveLabel={form?.id ? "Save" : "Add User"}>
        {form && <div className="form-grid">
          <Input label="Full Name" required value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} />
          <Input label="Email" required type="email" value={form.email} disabled={!!form.id} onChange={(e: any) => setForm({ ...form, email: e.target.value })} />
          <Select label="Role" value={form.role} onChange={(e: any) => setForm({ ...form, role: e.target.value })} options={ROLES.map((r) => ({ value: r, label: r }))} />
          {form.id && <Select label="Active" value={form.isActive ? "yes" : "no"} onChange={(e: any) => setForm({ ...form, isActive: e.target.value === "yes" })} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />}
          <Select label="Linked Employee" full value={form.employeeId || ""} onChange={(e: any) => setForm({ ...form, employeeId: e.target.value })}
            options={[{ value: "", label: "— none —" }, ...(employees || []).filter((e: any) => !e.exitDate).map((e: any) => ({ value: e.id, label: `${e.name}${e.empNo ? ` (${e.empNo})` : ""}` }))]} />
          <div className="subtitle full" style={{ margin: 0 }}>Required for EMPLOYEE/CONTRACTOR logins to use Employee Dashboard, My Timesheet and My Profile — without it those pages show "No employee record is linked to this user account."</div>
          <Input label="Password" value={form.password} onChange={(e: any) => setForm({ ...form, password: e.target.value })} placeholder={form.id ? "leave blank to keep current" : "default: password123"} />
        </div>}
      </Modal>

      <Modal title="Match Employee Emails" open={!!matchRows} onClose={() => setMatchRows(null)} wide
        onSave={applyMatches} busy={matchApplying} saveLabel={matchApplying ? "Applying…" : "Apply Selected"}
        canSave={!!matchRows?.some((r) => r.selected && r.chosenEmployeeId && r.email.trim())}>
        {matchRows && (
          matchRows.length === 0 ? (
            <div className="note">No suggested matches — every Entra directory name either already has an Employee email on file, or doesn't resemble any Employee Master name closely enough to suggest.</div>
          ) : (
            <>
              <div className="subtitle" style={{ marginTop: 0 }}>
                Nothing is written until you click Apply Selected. Rows with more than one possible match start unchecked — pick the right one (or leave unchecked to skip) before applying.
                {" "}The Email column starts pre-filled from Entra but is editable — correct it if it's wrong before applying.
                {" "}The Employee column lists every employee without an email on file, not just the suggested guess — if the suggestion is wrong, just pick the correct one from the dropdown.
              </div>
              <table><thead><tr><th></th><th>Entra Name</th><th>Email (editable)</th><th>Employee</th></tr></thead>
                <tbody>
                  {matchRows.map((r, i) => (
                    <tr key={i}>
                      <td><input type="checkbox" checked={r.selected} onChange={(e) => setMatchRows((rows: any[] | null) => rows!.map((x, j) => j === i ? { ...x, selected: e.target.checked } : x))} /></td>
                      <td>{r.entraName}</td>
                      <td><input type="email" value={r.email} style={{ minWidth: 220 }} onChange={(e) => setMatchRows((rows: any[] | null) => rows!.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} /></td>
                      <td>
                        <select value={r.chosenEmployeeId} onChange={(e) => setMatchRows((rows: any[] | null) => rows!.map((x, j) => j === i ? { ...x, chosenEmployeeId: e.target.value, selected: true } : x))}>
                          <option value="">— select —</option>
                          {r.candidates.length > 0 && (
                            <optgroup label="Suggested">
                              {r.candidates.map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.empNo ? ` (${c.empNo})` : ""}</option>)}
                            </optgroup>
                          )}
                          <optgroup label="All employees without an email on file">
                            {unmatchedEmployees.filter((e: any) => !r.candidates.some((c: any) => c.id === e.id)).map((e: any) => <option key={e.id} value={e.id}>{e.name}{e.empNo ? ` (${e.empNo})` : ""}</option>)}
                          </optgroup>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        )}
      </Modal>
    </div>
  );
}

// Adobe Sign (e-signature for Offer Letter / Appointment Letter / Service Agreement) — the
// Client Secret is typed here, into this running app, and stored server-side; it's never pasted
// into a chat or committed to source. The Secret field always starts showing the redacted
// placeholder GET already returns when one is on file — leave it as-is to keep the stored value,
// or type a new one to replace it (PUT swaps the placeholder back for the real value if untouched).
function AdobeSignSettings({ integ, reload }: any) {
  const { show } = useToast();
  const { user: me } = useAuth();
  const [clientId, setClientId] = useState(integ?.authConfig?.clientId || "");
  const [clientSecret, setClientSecret] = useState(integ?.authConfig?.clientSecret || "");
  const [shard, setShard] = useState(integ?.authConfig?.shard || "in1");
  const [testEmail, setTestEmail] = useState(integ?.authConfig?.testToEmail || me?.email || "");
  const [fromEmail, setFromEmail] = useState(integ?.authConfig?.testFromEmail || me?.email || "hr@genaquarius.com");
  const [busy, setBusy] = useState(false);
  // useState's initial value only applies on first mount — this component doesn't remount when
  // `reload()` fetches fresh data after Save, so without this effect the fields would silently
  // revert to blank on the very next render instead of showing what was just saved.
  useEffect(() => {
    setClientId(integ?.authConfig?.clientId || "");
    setClientSecret(integ?.authConfig?.clientSecret || "");
    setShard(integ?.authConfig?.shard || "in1");
    setTestEmail(integ?.authConfig?.testToEmail || me?.email || "");
    setFromEmail(integ?.authConfig?.testFromEmail || me?.email || "hr@genaquarius.com");
  }, [integ]);
  const saveTestDefaults = async () => {
    setBusy(true);
    try { await api.put("/integrations/ADOBE_SIGN", { authConfig: { testFromEmail: fromEmail, testToEmail: testEmail } }); show("Test defaults saved"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      // Saving credentials alone never claims CONNECTED — that's only true once the OAuth
      // handshake actually completes (server sets it, with a real accessToken, in
      // exchangeCodeForTokens). Otherwise this badge lies about a connection that was never
      // actually verified against Adobe.
      await api.put("/integrations/ADOBE_SIGN", { authConfig: { clientId, clientSecret, shard }, status: integ?.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED" });
      show("Adobe Sign credentials saved"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const redirectUri = `${window.location.origin}/api/adobe-sign/oauth/callback`;
  const webhookUrl = `${window.location.origin}/api/adobe-sign/webhook`;
  const thankYouUrl = `${window.location.origin}/api/adobe-sign/thank-you`;
  const { show: showCopied } = useToast();
  const copyRedirect = () => { navigator.clipboard.writeText(redirectUri).then(() => showCopied("Redirect URI copied")).catch(() => {}); };
  const copyWebhook = () => { navigator.clipboard.writeText(webhookUrl).then(() => showCopied("Webhook URL copied")).catch(() => {}); };
  const copyThankYou = () => { navigator.clipboard.writeText(thankYouUrl).then(() => showCopied("Thank-you page URL copied")).catch(() => {}); };
  return (
    <Panel title="Adobe Sign (E-Signature)" style={{ marginTop: 14 }}>
      <div className="subtitle" style={{ marginTop: 0 }}>Used to send Offer Letters, Appointment Letters and Service Agreements out for digital signature. Credentials are stored server-side only — this form never sends them anywhere but this app's own database.</div>
      <div className="form-grid">
        <Field label="Client ID (API Key)" value={clientId} onChange={(e: any) => setClientId(e.target.value)} placeholder="from Adobe Developer Console" />
        <Field label="Client Secret" value={clientSecret} onChange={(e: any) => setClientSecret(e.target.value)} placeholder="from Adobe Developer Console" />
        <div>
          <Field label="Data Center / Shard" value={shard} onChange={(e: any) => setShard(e.target.value.trim().toLowerCase())} placeholder="e.g. in1, na1, eu1" />
          <div className="subtitle" style={{ margin: "4px 0 0", fontSize: 11 }}>Find this in the URL you use to log into Adobe Sign — e.g. secure.<b>in1</b>.adobesign.com means "in1".</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label>OAuth Redirect URI — paste this exact value into your Adobe Developer Console project's "Redirect URI" field</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input readOnly value={redirectUri} style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }} onFocus={(e) => e.target.select()} />
          <button className="ghost" onClick={copyRedirect}>Copy</button>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Webhook URL — register this in your Adobe Developer Console project (Webhooks section) so signed documents come back automatically</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input readOnly value={webhookUrl} style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }} onFocus={(e) => e.target.select()} />
          <button className="ghost" onClick={copyWebhook}>Copy</button>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Post-Signing "Thank You" Page — paste this into Adobe's Account Settings → Account Setup → "Post Agreement Completion URL Redirect" so signers land here instead of Adobe's generic page</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input readOnly value={thankYouUrl} style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }} onFocus={(e) => e.target.select()} />
          <button className="ghost" onClick={copyThankYou}>Copy</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
        <button disabled={busy || !clientId || !clientSecret} onClick={save}>Save</button>
        <span className="badge">{integ?.status || "DISCONNECTED"}</span>
        {integ?.status === "CONNECTED" && <span className="subtitle" style={{ margin: 0 }}>Authorized — ready to send documents for signature.</span>}
        {integ?.status !== "CONNECTED" && integ?.authConfig?.lastError && <span className="subtitle" style={{ margin: 0, color: "var(--bad, #e5484d)" }}>Last error: {integ.authConfig.lastError}</span>}
        {clientId && clientSecret && integ?.status !== "CONNECTED" && (
          <a href={api.pdfUrl(`/adobe-sign/oauth/authorize`)}><button>Connect to Adobe Sign →</button></a>
        )}
      </div>
      {integ?.status === "CONNECTED" && (
        <div className="subtitle" style={{ marginTop: 6 }}>
          {integ.authConfig?.lastRefreshedAt && <>Last refreshed: {fmtDateTime(integ.authConfig.lastRefreshedAt)} · </>}
          {integ.authConfig?.tokenExpiresAt && <>Next refresh due: {fmtDateTime(integ.authConfig.tokenExpiresAt)}</>}
        </div>
      )}
      {integ?.status === "CONNECTED" && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Test E-Sign Flow</div>
          <div className="subtitle" style={{ marginTop: 0 }}>Sends a small test PDF through the full pipeline (send → sign → webhook → download) without touching any real Offer/Appointment/Service Agreement — the fastest way to confirm the connection and webhook are actually working end to end.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8 }}>
            <div style={{ flex: 1 }}><Field label="Send test document to" type="email" value={testEmail} onChange={(e: any) => setTestEmail(e.target.value)} placeholder="you@company.com" /></div>
            <div style={{ flex: 1 }}><Field label="Send From (must be a real, Graph-enabled mailbox)" type="email" value={fromEmail} onChange={(e: any) => setFromEmail(e.target.value)} placeholder="hr@genaquarius.com" /></div>
            <button className="ghost" disabled={busy} onClick={saveTestDefaults}>Save as Default</button>
          </div>
          <EsignPanel docType="TEST" docId={me?.id || 0} sendBody={{ email: testEmail, fromEmail }} sendLabel="Send Test Document" />
        </div>
      )}
    </Panel>
  );
}

// ---------------- Integrations (Tally + BoA + Adobe Sign) ----------------
export function Integrations() {
  const { user } = useAuth();
  // Forces a re-render on mask toggle — fmt() below reads the shared mask flag directly but
  // nothing else here subscribes to "masknumberschange", so the AR/reconciliation amounts stayed
  // frozen at whatever they showed on mount until the page itself remounted.
  useMaskNumbers(user?.id);
  const { data, loading, reload } = useFetch<any[]>("/integrations");
  const { data: recon } = useFetch<any>("/integrations/reconciliation");
  const { data: adobe, reload: reloadAdobe } = useFetch<any>("/integrations/ADOBE_SIGN");
  const [msg, setMsg] = useState("");
  const connect = async (p: string) => { await api.put(`/integrations/${p}`, { status: "CONNECTED", authConfig: {} }); reload(); };
  const sync = async (p: string) => { const r = await api.post(`/integrations/${p}/sync`, {}); setMsg(`${p} synced — AR ${fmt(r.receivables.totalAR)}, cash ${fmt(r.receivables.cashPosition)}`); reload(); };
  return (
    <div>
      <h1>External Integrations</h1>
      <div className="subtitle">Tally (AR + realized revenue) and Bank of America (cash) feed the CEO dashboard. Reconciled against issued invoices.</div>
      <Panel>{loading ? "Loading…" : <table>
        <thead><tr><th>Provider</th><th>Status</th><th>Last Sync</th><th></th></tr></thead>
        <tbody>{data?.map((i) => (
          <tr key={i.id}><td>{i.provider}</td><td><span className="badge">{i.status}</span></td>
            <td>{i.lastSyncAt ? fmtDateTime(i.lastSyncAt) : "—"}</td>
            <td><button className="ghost" onClick={() => connect(i.provider)}>Connect</button>{" "}
              <button onClick={() => sync(i.provider)}>Sync</button></td></tr>
        ))}</tbody>
      </table>}</Panel>
      {msg && <div className="ok">{msg}</div>}
      <div className="note">Adapters call the Tally and BoA APIs once credentials are configured; fetched AR/balances land in the reconciliation ledger and the CEO dashboard tiles update.</div>

      <AdobeSignSettings integ={adobe} reload={reloadAdobe} />

      <Panel title="Reconciliation — External Ledger vs Issued Invoices" style={{ marginTop: 14 }}>
        <div className="grid cols-2">
          <div>
            <h2>External ledger (Tally / BoA)</h2>
            <table><thead><tr><th>Provider</th><th>Type</th><th>Ref</th><th className="num">Amount</th></tr></thead>
              <tbody>{(recon?.ledger || []).map((l: any) => (
                <tr key={l.id}><td>{l.provider}</td><td>{l.type}</td><td>{l.customerRef}</td><td className="num">{fmt(l.amount, l.currency)}</td></tr>
              ))}</tbody></table>
          </div>
          <div>
            <h2>Issued invoices</h2>
            <table><thead><tr><th>Invoice</th><th>Client</th><th>Status</th><th className="num">Amount</th></tr></thead>
              <tbody>{(recon?.invoices || []).length === 0 ? <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No invoices yet.</td></tr> :
                (recon?.invoices || []).map((i: any) => (
                  <tr key={i.id}><td>{i.invoiceNo}</td><td>{i.client?.name}</td><td>{i.status}</td><td className="num">{fmt(i.totalAmount, i.currency)}</td></tr>
                ))}</tbody></table>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ---------------- Audit ----------------
// Build the hover text for an AI Report gap (what the user asked + how to support it).
const gapTip = (a: any) => {
  const g = a.after || {};
  return [
    `Prompt: ${g.prompt || "—"}`,
    "",
    `Why it couldn't be built: ${g.reason || "—"}`,
    g.suggestedTool ? `\nHow to implement: add tool → ${g.suggestedTool}` : "",
    (g.neededData || []).length ? `\nData needed: ${(g.neededData || []).join(", ")}` : "",
  ].filter(Boolean).join("\n");
};
// Small inline "Copy" button for an AI Report gap — copies the full gap text.
function CopyGapButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
    setDone(true); setTimeout(() => setDone(false), 1500);
  };
  return (
    <button className="ghost" onClick={copy} title="Copy the gap details" style={{ fontSize: 11, padding: "1px 7px", marginLeft: 6 }}>
      {done ? "Copied ✓" : "Copy"}
    </button>
  );
}
const AUDIT_COLS = [
  { key: "at", label: "When", value: (a: any) => a.at, render: (a: any) => fmtDateTime(a.at) },
  { key: "user", label: "User", value: (a: any) => a.user?.name || "—", render: (a: any) => a.user?.name || "—" },
  {
    key: "action", label: "Action",
    render: (a: any) => a.action === "AI_REPORT_GAP"
      ? <span style={{ display: "inline-flex", alignItems: "center" }}>
          <span title={gapTip(a)} style={{ borderBottom: "1px dotted var(--muted)", cursor: "help" }}>{a.action} ⓘ</span>
          <CopyGapButton text={gapTip(a)} />
        </span>
      : a.action,
  },
  {
    key: "entity", label: "Entity",
    value: (a: any) => `${a.entity} ${a.entityId}`,
    render: (a: any) => a.action === "AI_REPORT_GAP" && a.after?.prompt
      ? <span title={gapTip(a)} style={{ cursor: "help" }}>{a.entity} — “{String(a.after.prompt).slice(0, 60)}{String(a.after.prompt).length > 60 ? "…" : ""}”</span>
      : `${a.entity} ${a.entityId || ""}`,
  },
];
export function Audit() {
  const { user: me } = useAuth();
  const { show } = useToast();
  const { data, loading, reload } = useFetch<any[]>("/admin/audit");
  const deleteAll = async () => {
    if (!(await confirmDialog({ title: "Delete the entire audit log?", message: "This permanently deletes every audit entry and cannot be undone.", danger: true, confirmLabel: "Delete All" }))) return;
    try { await api.del("/admin/audit"); show("Audit log cleared"); reload(); } catch (e: any) { show(e.message, "error"); }
  };
  return (
    <div>
      <h1>Audit Log</h1>
      <div className="subtitle" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span>Immutable trail of sensitive actions. Entries auto-rotate — older than the retention window are purged automatically.</span>
        {me?.role === "CTO" && (data || []).length > 0 && (
          <button onClick={deleteAll} style={{ background: "#C4161C", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>Delete All</button>
        )}
      </div>
      <Panel>
        {loading ? "Loading…" : (
          <DataTable
            rows={data || []}
            columns={AUDIT_COLS}
            searchKeys={(a: any) => `${fmtDateTime(a.at)} ${a.user?.name || ""} ${a.action} ${a.entity} ${a.entityId || ""}`}
            empty="No audit entries yet."
          />
        )}
      </Panel>
    </div>
  );
}

// ---------------- Company Settings (admin) ----------------
// Country, Business Unit and Designation & Department are shared reference data consumed by
// both HR Settings (BU-scoped tabs) and Finance (BU-scoped cost/allocation reporting) — not
// HR-owned config — so they live here under Administration rather than inside HR Settings.
const COMPANY_SETTINGS_TAB_KEYS = ["country", "bu", "org", "dateformat"] as const;
export function CompanySettings() {
  const [tab, setTab] = useState<typeof COMPANY_SETTINGS_TAB_KEYS[number]>("country");
  const tabs: [typeof tab, string][] = [["country", "Country"], ["bu", "Business Unit"], ["org", "Designation & Department"], ["dateformat", "Date & Time Format"]];
  return (
    <div>
      <h1>Company Settings</h1>
      <div className="subtitle">Country, Business Unit and Designation &amp; Department — shared reference data used across HR and Finance.</div>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap" }}>
        {tabs.map(([k, label]) => (
          <div key={k} onClick={() => setTab(k)} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === k ? "var(--accent)" : "var(--muted)", borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent" }}>{label}</div>
        ))}
      </div>
      {tab === "country" && <CountrySettings />}
      {tab === "bu" && <BusinessUnitSettings />}
      {tab === "org" && <OrganizationSettings />}
      {tab === "dateformat" && <DateTimeFormatSettings />}
    </div>
  );
}

// Date & Time Format — a fixed, company-wide display standard (not a per-user/per-BU choice).
// This tab documents the standard; the single source of truth for the actual formatting logic is
// client/src/dateFormat.ts (UI) and server/src/engine/dateFormat.ts (every generated document —
// Offer/Appointment Letter, Appraisal, Invoice, FnF, Relieving Letter, Service Agreement, MSA/SOW,
// Timesheet exports — and every email template date placeholder). Changing the format means
// editing those two files, not a value here — this screen exists so the standard is visible and
// documented, per explicit decision not to make it a runtime-configurable dropdown.
function DateTimeFormatSettings() {
  const { show } = useToast();
  const { data, reload } = useFetch<any>("/company-settings/date-time-format");
  const [dateFormat, setDateFormat] = useState("");
  const [timeFormat, setTimeFormat] = useState("");
  const [loaded, setLoadedState] = useState(false);
  const [busy, setBusy] = useState(false);
  React.useEffect(() => {
    if (data && !loaded) { setDateFormat(data.dateFormat); setTimeFormat(data.timeFormat); setLoadedState(true); }
  }, [data, loaded]);
  const now = new Date();
  const preview = dateFormat && DATE_FORMATS[dateFormat as keyof typeof DATE_FORMATS] ? DATE_FORMATS[dateFormat as keyof typeof DATE_FORMATS].fmt(now) : "";
  const dirty = loaded && (dateFormat !== data.dateFormat || timeFormat !== data.timeFormat);
  const save = async () => {
    setBusy(true);
    try {
      await api.put("/company-settings/date-time-format", { dateFormat, timeFormat });
      setDateFormatCache(dateFormat as any, timeFormat as any);
      show("Date & Time Format saved — applied everywhere immediately"); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  if (!loaded) return <Panel title="Date & Time Format">Loading…</Panel>;
  return (
    <Panel title="Date & Time Format">
      <div className="subtitle" style={{ marginTop: 0 }}>
        The company-wide standard for how dates are displayed — applies across every screen and every generated document (Offer Letter, Appointment Letter, Appraisal, Invoice, FnF Settlement, Relieving Letter, Service Agreement, MSA/SOW, Timesheet exports) and every email template date placeholder. Changing this applies everywhere the moment you save it.
      </div>
      <div className="form-grid">
        <SelectField label="Date Format" value={dateFormat} onChange={(e: any) => setDateFormat(e.target.value)}
          options={(data.dateFormatOptions || []).map((o: any) => ({ value: o.key, label: o.label }))} />
        <SelectField label="Time Format" value={timeFormat} onChange={(e: any) => setTimeFormat(e.target.value)}
          options={(data.timeFormatOptions || []).map((o: any) => ({ value: o.key, label: o.label }))} />
      </div>
      <div className="note" style={{ marginTop: 10 }}>Preview — today's date: <b>{preview}</b></div>
      <div style={{ marginTop: 14 }}>
        <AddButton disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save"}</AddButton>
      </div>
    </Panel>
  );
}

// My Timesheet — calendar view + Employee→PM→Finance approval cycle (see TimesheetCalendar.tsx)
export { Timesheet } from "./TimesheetCalendar";
