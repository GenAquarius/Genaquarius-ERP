// IT Admin module — version 1 is the new-hire O365 provisioning task queue behind the IT_ADMIN
// role. Asset Tracker and IT Service Requests are planned future additions to this same module
// (specs pending) — kept in its own file from the start so they can be added here later without
// touching HR's own pages again.
import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { useFetch, Panel } from "../../ui";
import { DateInput } from "../../dateInput";
import { fmtDate, fmtDateTime } from "../../dateFormat";
import { GhostButton, AddButton, Modal, useToast } from "../../components";
import { watchRoom } from "../../realtime";

// Section 7/8/9 — the Pending Task card shows every field of the request (no navigating elsewhere
// to see the full picture), lets IT Admin fill in the Microsoft 365 Display Name, and Approve
// creates the O365 mailbox action, emails the Office 365 Admin the full compiled request, and
// sends the new hire the Welcome Email — all off one click.
// IT Admin connects their OWN Microsoft account (must be a Global Admin/Privileged Role Admin to
// consent to the admin-restricted delegated scopes on Microsoft's own consent screen) — this app
// never holds a standing, tenant-wide permission to create users on its own. Once connected,
// enabling Automated Provisioning here makes Approve actually create the O365 mailbox (and assign
// the picked license) via Graph instead of just emailing a human to do it by hand.
function AutomatedProvisioningPanel() {
  const { data: status, reload } = useFetch<any>("/graph-admin/status");
  const { data: skus, reload: reloadSkus } = useFetch<any[]>("/graph-admin/license-skus");
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("graphAdminConnected");
    const error = params.get("graphAdminError");
    if (connected) { show(`Connected as ${connected}`); reload(); reloadSkus(); window.history.replaceState({}, "", "/it-admin"); }
    else if (error) { show(error, "error"); window.history.replaceState({}, "", "/it-admin"); }
    // eslint-disable-next-line
  }, []);

  const toggleEnabled = async (enabled: boolean) => {
    setBusy(true);
    try { await api.put("/graph-admin/settings", { enabled, licenseSkuIds: status?.licenseSkuIds, licenseSkuPartNumbers: status?.licenseSkuPartNumbers }); show(enabled ? "Automated Provisioning enabled" : "Automated Provisioning disabled"); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  // Multi-select — Graph's assignLicense call natively takes several SKUs at once, so an employee
  // can be auto-assigned e.g. both "Microsoft 365 E3" and a Teams add-on in the same Approve click.
  const toggleSku = async (skuId: string, skuPartNumber: string) => {
    const ids: string[] = status?.licenseSkuIds || [];
    const parts: string[] = status?.licenseSkuPartNumbers || [];
    const idx = ids.indexOf(skuId);
    const nextIds = idx === -1 ? [...ids, skuId] : ids.filter((_, i) => i !== idx);
    const nextParts = idx === -1 ? [...parts, skuPartNumber] : parts.filter((_, i) => i !== idx);
    setBusy(true);
    try { await api.put("/graph-admin/settings", { enabled: status?.enabled, licenseSkuIds: nextIds, licenseSkuPartNumbers: nextParts }); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  if (!status) return null;
  return (
    <Panel title="Automated Provisioning" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          {status.connected
            ? <div className="subtitle" style={{ margin: 0 }}>Connected as <b>{status.connectedByUpn}</b>{status.connectedAt ? ` · ${fmtDate(status.connectedAt)}` : ""}</div>
            : <div className="subtitle" style={{ margin: 0 }}>Not connected — Approve currently emails the Office 365 Admin to create the mailbox manually.</div>}
          {status.lastError && <div style={{ fontSize: 11, color: "var(--bad)" }}>Last error: {status.lastError}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!status.connected
            ? <a href={api.pdfUrl("/graph-admin/oauth/authorize")}><button>Connect Microsoft Admin Account →</button></a>
            : (
              <>
                {/* Re-runs the same consent flow (prompt=consent server-side, so this always shows
                    Microsoft's picker again) — needed whenever a newly-added Graph scope (e.g. the
                    Intune access-group step's Group.ReadWrite.All) isn't covered by the token this
                    admin already granted; a stale connection has no other way to pick it up. */}
                <a href={api.pdfUrl("/graph-admin/oauth/authorize")}><button className="ghost">Reconnect →</button></a>
                <GhostButton onClick={() => setOpen(!open)}>{open ? "Hide" : "Settings"}</GhostButton>
              </>
            )}
        </div>
      </div>
      {status.connected && open && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!status.enabled} disabled={busy} onChange={(e) => toggleEnabled(e.target.checked)} />
            Automatically create the O365 mailbox (and assign the license below) on Approve
          </label>
          <div>
            <label style={{ display: "block", fontSize: 11, marginBottom: 2 }}>Licenses to auto-assign (select any number)</label>
            {!skus?.length ? (
              <div className="note" style={{ marginTop: 4 }}>No license SKUs found in your tenant, or they haven't loaded yet.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
                {skus.map((s: any) => (
                  // minWidth:0 on the label (it's both a grid item AND a flex container) plus
                  // overflowWrap on the text span — without both, a long unbroken SKU part number
                  // (real Microsoft SKU names routinely run 25-40 chars with no spaces, e.g.
                  // "Microsoft_365_E3_EEA_(no_Teams)") doesn't wrap and spills past its 240px grid
                  // cell, visually overlapping the checkbox/text of the next cell over.
                  <label key={s.skuId} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", cursor: busy ? "default" : "pointer", minWidth: 0 }}>
                    <input type="checkbox" style={{ width: "auto", flexShrink: 0, marginTop: 2 }} disabled={busy} checked={(status.licenseSkuIds || []).includes(s.skuId)} onChange={() => toggleSku(s.skuId, s.skuPartNumber)} />
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.skuPartNumber} <span style={{ color: "var(--muted)" }}>({s.available}/{s.total} available)</span></span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// Shown before Approve (Pending Tasks) and before Confirm Deactivation (Offboarding) — fetches the
// applicable group list fresh every time it opens (onboarding: full configured catalog;
// offboarding: only groups the employee is CURRENTLY a member of, per spec), lets IT Admin
// Select All/Clear All/pick individually, then shows the per-group ✅/ℹ️/❌ results returned by the
// confirm action in place, so IT Admin never has to guess whether a group assignment/removal
// actually went through.
function GroupChecklistModal({ title, fetchUrl, confirmLabel, onConfirm, onClose }: {
  title: string; fetchUrl: string; confirmLabel: string; onConfirm: (ids: number[]) => Promise<any>; onClose: () => void;
}) {
  const { data: groups, loading } = useFetch<any[]>(fetchUrl);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const confirm = async () => {
    setBusy(true);
    try { const r: any = await onConfirm([...selected]); setResults(r?.groupResults || []); }
    finally { setBusy(false); }
  };
  const resultLabel = (r: any) => r.status === "ADDED" ? "✅ Added Successfully" : r.status === "REMOVED" ? "✅ Removed Successfully"
    : r.status === "ALREADY_MEMBER" ? "ℹ️ Already a Member" : r.status === "NOT_MEMBER" ? "ℹ️ Not a Member" : `❌ Failed${r.error ? ` — ${r.error}` : ""}`;
  return (
    <Modal title={title} open onClose={onClose} onSave={results ? undefined : confirm} canSave={!loading && !busy} saveLabel={busy ? "Working…" : confirmLabel}>
      {loading ? <div>Loading group memberships…</div> : results ? (
        <div>
          <table><thead><tr><th>Group</th><th>Result</th></tr></thead><tbody>
            {results.map((r: any) => <tr key={r.groupId}><td>{r.name}</td><td>{resultLabel(r)}</td></tr>)}
          </tbody></table>
          <GhostButton style={{ marginTop: 10 }} onClick={onClose}>Close</GhostButton>
        </div>
      ) : !(groups || []).length ? (
        <div className="note">{fetchUrl.includes("offboarding") ? "This employee isn't currently a member of any configured group — the account can still be deactivated." : "No groups configured yet (Admin Settings → Group Checklist, below)."}</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <GhostButton onClick={() => setSelected(new Set((groups || []).map((g: any) => g.id)))}>Select All</GhostButton>
            <GhostButton onClick={() => setSelected(new Set())}>Clear All</GhostButton>
          </div>
          {(groups || []).map((g: any) => (
            <label key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", cursor: "pointer" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={selected.has(g.id)} onChange={() => toggle(g.id)} />
              {g.name}
            </label>
          ))}
        </>
      )}
    </Modal>
  );
}

// Admin Settings — the group catalog both checklists above draw from. `name` must exactly match
// the group's real Entra displayName (resolved via Graph's findGroupByName when a checklist is
// confirmed) — a typo here just means that group silently never resolves, surfaced as a per-group
// ❌ Failed result rather than a hard error.
function GroupChecklistSettings() {
  const { data: groups, reload } = useFetch<any[]>("/it-admin/group-defs");
  const { show } = useToast();
  const [name, setName] = useState("");
  const [scope, setScope] = useState("BOTH");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await api.post("/it-admin/group-defs", { name: name.trim(), scope }); setName(""); reload(); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  const toggleEnabled = async (g: any) => { try { await api.put(`/it-admin/group-defs/${g.id}`, { enabled: !g.enabled }); reload(); } catch (e: any) { show(e.message, "error"); } };
  const remove = async (id: number) => { try { await api.del(`/it-admin/group-defs/${id}`); reload(); } catch (e: any) { show(e.message, "error"); } };
  return (
    <Panel title="Group Checklist — Configured Groups" style={{ marginBottom: 14 }}>
      <div className="subtitle" style={{ marginTop: 0 }}>Intune/Entra groups offered on the Pending Tasks Group Assignment Checklist and the Offboarding Deactivation Checklist. Name must exactly match the group's real display name in Entra.</div>
      {(groups || []).map((g: any) => (
        <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 13 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={g.enabled} onChange={() => toggleEnabled(g)} />
            {g.name} <span className="pill" style={{ fontSize: 10 }}>{g.scope}</span>
          </label>
          <GhostButton onClick={() => remove(g.id)}>Remove</GhostButton>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <input placeholder="Exact Entra group display name" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 240 }} />
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="BOTH">Both onboarding & offboarding</option>
          <option value="ONBOARDING">Onboarding only</option>
          <option value="OFFBOARDING">Offboarding only</option>
        </select>
        <GhostButton disabled={busy || !name.trim()} onClick={add}>{busy ? "Adding…" : "+ Add Group"}</GhostButton>
      </div>
    </Panel>
  );
}

// Shared by both the Pending Task card and the Recently Completed card — the underlying
// ItProvisioningRequest row always has this full detail (nothing is ever dropped), so both views
// read off the exact same fields rather than each hand-rolling their own partial subset.
// Resident Address ("current/where equipment ships") defaults to same-as-Permanent at Onboarding
// unless the candidate gave a different current address — same fallback hrOffers.ts itself uses
// when copying it onto the Employee record at Confirm Joining.
function shippingAddress(o: any): string {
  if (!o) return "";
  const sameAsPermanent = o.residentSameAsPermanent !== false;
  const line = sameAsPermanent ? o.candidateAddress : o.residentAddress;
  const city = sameAsPermanent ? o.candidateCity : o.residentCity;
  const landmark = sameAsPermanent ? o.candidateLandmark : o.residentLandmark;
  const state = sameAsPermanent ? o.candidateState : o.residentState;
  const pincode = sameAsPermanent ? o.candidatePincode : o.residentPincode;
  return [line, landmark, city, state, pincode].filter(Boolean).join(", ");
}

// Every field HR's own "Send to IT" form captures that IT Admin can also correct here before
// Approve — Personal Email is the one exception, updating the Offer itself (see the PUT/complete
// routes' own comment) rather than a local IT-only copy, since it's used all over onboarding.
const EDITABLE_FIELDS = ["personalEmail", "phoneNumber", "shipToAddress", "emailIdToCreate", "osRequirement", "laptopConfiguration", "requiredApplications", "requiredAccess", "otherRequirements"] as const;
type EditableField = typeof EDITABLE_FIELDS[number];
type EditState = { values: Record<EditableField, string>; setField: (k: EditableField, v: string) => void };

// `edit`, when passed, makes every HR-submitted field an editable input bound to the caller's own
// state instead of plain text — used only by the still-Pending card (Approve hasn't run yet);
// CompletedTaskCard renders this read-only as before.
function RequestDetailTable({ t, edit }: { t: any; edit?: EditState }) {
  const derivedAddress = shippingAddress(t.offer);
  const field = (key: EditableField, opts?: { textarea?: boolean }) => {
    if (!edit) return null;
    return opts?.textarea
      ? <textarea rows={2} value={edit.values[key]} onChange={(e) => edit.setField(key, e.target.value)} style={{ width: "100%" }} />
      : <input value={edit.values[key]} onChange={(e) => edit.setField(key, e.target.value)} style={{ width: "100%", textAlign: "right" }} />;
  };
  return (
    <table style={{ marginTop: 10 }}><tbody>
      <tr><td>First / Last Name</td><td className="num">{t.offer?.candidateFirstName || "—"} / {t.offer?.candidateLastName || "—"}</td></tr>
      <tr><td>Personal Email</td><td className="num">{field("personalEmail") ?? (t.offer?.candidateEmail || "—")}</td></tr>
      <tr><td>Job Title / Department</td><td className="num">{t.offer?.designation}{t.offer?.department ? ` / ${t.offer.department}` : ""}</td></tr>
      {(edit || t.phoneNumber) && <tr><td>Phone Number</td><td className="num">{field("phoneNumber") ?? t.phoneNumber}</td></tr>}
      <tr><td>Shipping Address</td><td className="num">{field("shipToAddress", { textarea: true }) ?? ((t.shipToAddress || derivedAddress) || "— not on file —")}</td></tr>
      <tr><td>Email ID to Create</td><td className="num">{field("emailIdToCreate") ?? t.emailIdToCreate}</td></tr>
      <tr><td>OS Requirement</td><td className="num">{field("osRequirement") ?? t.osRequirement}</td></tr>
      <tr><td>Laptop Configuration</td><td className="num">{field("laptopConfiguration") ?? t.laptopConfiguration}</td></tr>
      {(edit || t.requiredApplications) && <tr><td>Requested Applications</td><td className="num">{field("requiredApplications", { textarea: true }) ?? t.requiredApplications}</td></tr>}
      {(edit || t.requiredAccess) && <tr><td>Access Requirements</td><td className="num">{field("requiredAccess", { textarea: true }) ?? t.requiredAccess}</td></tr>}
      {(edit || t.otherRequirements) && <tr><td>Other Requirements</td><td className="num">{field("otherRequirements", { textarea: true }) ?? t.otherRequirements}</td></tr>}
    </tbody></table>
  );
}

function PendingTaskCard({ t, busy, onApprove }: { t: any; busy: boolean; onApprove: (offerId: number, displayName: string, emailAlreadyExists: boolean, edited: Record<EditableField, string>, groupIds: number[]) => Promise<any> }) {
  const { show } = useToast();
  const [displayName, setDisplayName] = useState(t.displayName || "");
  const initial: Record<EditableField, string> = {
    personalEmail: t.offer?.candidateEmail || "", phoneNumber: t.phoneNumber || "",
    shipToAddress: t.shipToAddress || shippingAddress(t.offer) || "",
    emailIdToCreate: t.emailIdToCreate || "", osRequirement: t.osRequirement || "", laptopConfiguration: t.laptopConfiguration || "",
    requiredApplications: t.requiredApplications || "", requiredAccess: t.requiredAccess || "", otherRequirements: t.otherRequirements || "",
  };
  const [values, setValues] = useState<Record<EditableField, string>>(initial);
  const setField = (k: EditableField, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const [savingEdit, setSavingEdit] = useState(false);
  const dirty = EDITABLE_FIELDS.some((k) => values[k] !== initial[k]);
  const saveEdits = async () => {
    setSavingEdit(true);
    try { await api.put(`/it-admin/tasks/${t.offerId}`, { displayName, ...values }); show("Saved"); }
    catch (e: any) { show(e.message, "error"); } finally { setSavingEdit(false); }
  };
  // "Email ID Already Created – Skip Account Creation" — the employee's M365 mailbox already
  // exists (set up outside this app). Approve still runs everything else exactly as normal
  // (license, Intune group, M365 manager, this app's own Users & Roles login, O365 Admin +
  // Welcome emails) — it only skips the actual mailbox-creation call, so it can never create a
  // duplicate account.
  const [emailAlreadyExists, setEmailAlreadyExists] = useState(false);
  // Approve (and the "Email ID Already Created" skip-creation path) both go through the Group
  // Assignment Checklist first — neither ever calls onApprove directly.
  const [showChecklist, setShowChecklist] = useState(false);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t.offer?.candidateName} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{t.offer?.employmentType === "CONTRACTOR" ? "Contractor" : "Employee"} · {t.offer?.designation}</span></div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Requested {t.sentAt ? fmtDateTime(t.sentAt) : "—"}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input placeholder="Microsoft 365 Display Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ minWidth: 220 }} />
          {dirty && <GhostButton disabled={savingEdit} onClick={saveEdits}>{savingEdit ? "Saving…" : "Save"}</GhostButton>}
          <AddButton disabled={busy} onClick={() => setShowChecklist(true)}>{busy ? "Working…" : "Approve"}</AddButton>
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12.5, cursor: "pointer" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={emailAlreadyExists} onChange={(e) => setEmailAlreadyExists(e.target.checked)} />
        Email ID Already Created – Skip Account Creation
      </label>
      <RequestDetailTable t={t} edit={{ values, setField }} />
      {showChecklist && (
        <GroupChecklistModal
          title={`Group Assignment Checklist — ${t.offer?.candidateName}`}
          fetchUrl={`/it-admin/tasks/${t.offerId}/group-checklist`}
          confirmLabel="Confirm & Approve"
          onConfirm={(ids) => onApprove(t.offerId, displayName, emailAlreadyExists, values, ids)}
          onClose={() => setShowChecklist(false)}
        />
      )}
    </div>
  );
}

// Assign Assets — the step right after Approve in the spec'd flow (Approve -> Assign Assets ->
// select available assets -> Assign -> Asset Inventory updated). Lives on the Recently Completed
// card because that's exactly where a task lands the moment Approve finishes, so "right after
// Approve" and "on the Recently Completed card" are the same place in this UI. Only assets
// currently IN_STOCK are offered — anything already ASSIGNED/IN_REPAIR/RETIRED/MISSING is excluded
// so an already-given-out asset can never be picked for a second employee.
// Opens as a proper Modal (fixed-position overlay, internally-scrolling body, buttons always
// visible in the footer) rather than expanding inline below the task card — inline used to land
// wherever the card happened to be scrolled to, effectively "appearing at the top of the page"
// for a card further down the Recently Completed list, and its Assign button could end up off
// screen with no obvious way to reach it without extra scrolling.
function AssignAssetsSection({ t, assets, reloadAssets, onClose }: { t: any; assets: any[] | null; reloadAssets: () => void; onClose: () => void }) {
  const { show } = useToast();
  const { data: meta } = useFetch<any>("/helpdesk/meta");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("");
  const [serialQuery, setSerialQuery] = useState("");
  const employeeId = t.offer?.employeeId;
  const inStock = (assets || []).filter((a: any) => a.status === "IN_STOCK");
  // Categories offered here are the real Asset Catalog list (Helpdesk Settings → Asset Types),
  // not just whatever happens to be in stock right now — so the filter still shows a category
  // even when nothing of it is currently available (empty result, not a missing option).
  const catalogCategories: string[] = meta?.assetTypes || [];
  const available = inStock.filter((a: any) =>
    (!category || a.category === category) &&
    (!serialQuery.trim() || (a.serialNo || "").toLowerCase().includes(serialQuery.trim().toLowerCase())));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const assign = async () => {
    if (!employeeId || selected.size === 0) return;
    setBusy(true);
    try {
      // The employee is taken entirely from the pending task's own offer record — never a
      // separate manual name/email entry — so this can't accidentally assign to the wrong person.
      for (const id of selected) await api.post(`/helpdesk/admin/assets/${id}/assign`, { employeeId });
      show(`${selected.size} asset${selected.size === 1 ? "" : "s"} assigned to ${t.offer?.candidateName}`);
      setSelected(new Set());
      reloadAssets();
      onClose();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  if (!employeeId) {
    return (
      <Modal title="Assign Assets" open onClose={onClose}>
        <div className="note">
          Assets can be assigned once {t.offer?.candidateName || "this employee"}'s Employee record exists — complete Confirm Joining / Employee Activation in the HR workflow first, then come back here to assign assets.
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Assign Assets to ${t.offer?.candidateName}`} open onClose={onClose}
      onSave={assign} canSave={selected.size > 0} saveLabel={busy ? "Assigning…" : `Assign ${selected.size || ""} Asset${selected.size === 1 ? "" : "s"}`} busy={busy} wide>
      {inStock.length === 0 ? (
        <div className="note">No available (in-stock) assets right now — add stock under Asset Inventory.</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ maxWidth: 200 }}>
              <option value="">All categories</option>
              {catalogCategories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input placeholder="Search by serial number…" value={serialQuery} onChange={(e) => setSerialQuery(e.target.value)} style={{ maxWidth: 220 }} />
          </div>
          {available.length === 0 ? (
            <div className="note">No in-stock assets match this filter.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
              {available.map((a: any) => (
                <label key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", cursor: "pointer", minWidth: 0 }}>
                  <input type="checkbox" style={{ width: "auto", flexShrink: 0, marginTop: 2 }} checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {a.assetTag} · {a.name} <span style={{ color: "var(--muted)" }}>({a.category})</span>
                    {(a.model || a.serialNo) && (
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{[a.model && `Model: ${a.model}`, a.serialNo && `SN: ${a.serialNo}`].filter(Boolean).join(" · ")}</div>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// Recently Completed — the full record was always saved (ItProvisioningRequest keeps every field
// permanently), it just wasn't shown here before; this reuses the exact same detail table as the
// Pending card plus completion-specific info (how the mailbox was created, license, email status).
// "Assigned Assets → Populate Existing Laptop Template → Preview → Send Email to Employee" —
// everything auto-resolved server-side (buildLaptopHandoverContent in itAdmin.ts), IT Admin only
// clicks Preview then Send. Button becomes "Resend" with a sent timestamp once sent, same
// precedent as welcomeEmailSentAt above.
// Full e-sign status for this employee's handover acknowledgment (docType "LAPTOP_HANDOVER",
// docId = offerId — same generic EsignAgreement/webhook machinery Offer/Appointment
// Letter/Service Agreement already use, see routes/shared/adobeSign.ts). NOT_SENT is the
// server's own shape for "no EsignAgreement row exists yet" (never sent, or sent as a plain
// email fallback when Adobe Sign wasn't connected at the time).
function LaptopHandoverStatusPill({ offerId }: { offerId: number }) {
  const { data: agreement, reload } = useFetch<any>(`/adobe-sign/status/LAPTOP_HANDOVER/${offerId}`);
  useEffect(() => watchRoom("esign:activity", "esign:activity", reload), []);
  if (!agreement || agreement.status === "NOT_SENT") return null;
  const label = agreement.status === "SIGNED" ? "Signed" : agreement.status === "DECLINED" ? "Declined" : "Awaiting signature";
  const cls = agreement.status === "SIGNED" ? "good" : agreement.status === "DECLINED" ? "bad" : "warn";
  return (
    <span className={`pill ${cls}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      Handover: {label}
      {agreement.status === "SIGNED" && (
        <a href={api.pdfUrl(`/adobe-sign/signed/LAPTOP_HANDOVER/${offerId}`)} target="_blank" rel="noreferrer" onClick={(e: any) => e.stopPropagation()} style={{ color: "inherit", textDecoration: "underline" }}>
          view
        </a>
      )}
    </span>
  );
}

function LaptopHandoverButton({ t }: { t: any }) {
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; html: string; email: string; location: string; building: string; assets: any[]; alreadySent: string | null } | null>(null);
  // Editable copies — Location/Building had no data source at all before Employee Activation,
  // and the recipient email couldn't be corrected here either. All three are now IT-editable
  // overrides (see PUT .../laptop-handover/fields) without touching the candidate's own record.
  const [email, setEmail] = useState("");
  const [location, setLocation] = useState("");
  const [building, setBuilding] = useState("");

  const openPreview = async () => {
    setOpen(true); setLoading(true);
    try {
      const p: any = await api.get(`/it-admin/tasks/${t.offerId}/laptop-handover`);
      setPreview(p); setEmail(p.email || ""); setLocation(p.location || ""); setBuilding(p.building || "");
    }
    catch (e: any) { show(e.message, "error"); setOpen(false); }
    finally { setLoading(false); }
  };
  const saveFields = async () => {
    setSaving(true);
    try {
      await api.put(`/it-admin/tasks/${t.offerId}/laptop-handover/fields`, { email, location, building });
      const p: any = await api.get(`/it-admin/tasks/${t.offerId}/laptop-handover`);
      setPreview(p); show("Saved — preview refreshed");
    } catch (e: any) { show(e.message, "error"); } finally { setSaving(false); }
  };
  const send = async () => {
    setSending(true);
    try {
      // Always save whatever's currently in the fields right before sending, so Send never fires
      // on stale values if IT edited something and forgot to click Save Changes first.
      await api.put(`/it-admin/tasks/${t.offerId}/laptop-handover/fields`, { email, location, building });
      const r: any = await api.post(`/it-admin/tasks/${t.offerId}/laptop-handover/send`);
      show(r.warning || (r.signing ? "Sent for signature" : "Laptop Handover email sent"), r.warning ? "error" : undefined);
      setOpen(false);
    }
    catch (e: any) { show(e.message, "error"); }
    finally { setSending(false); }
  };
  return (
    <>
      <LaptopHandoverStatusPill offerId={t.offerId} />
      <GhostButton onClick={(e: any) => { e.stopPropagation(); openPreview(); }}>
        {t.laptopHandoverEmailSentAt ? `Resend Laptop Handover (sent ${fmtDate(t.laptopHandoverEmailSentAt)})` : "Send Laptop Handover for Signature"}
      </GhostButton>
      <Modal title="Laptop Handover — Preview" open={open} onClose={() => setOpen(false)} onSave={preview && !loading ? send : undefined} saveLabel={sending ? "Sending…" : "Send for Signature"} canSave={!loading && !sending && !!preview?.assets?.length}>
        {loading ? <div>Loading…</div> : !preview ? null : (
          <>
            {!preview.assets.length && <div className="note" style={{ marginBottom: 10, color: "var(--bad)" }}>No assets are currently assigned to this employee — assign assets first (see "Assign Assets" above).</div>}
            <div className="note" style={{ marginBottom: 10 }}>Sends a signable PDF via Adobe Sign for the employee to acknowledge receipt. Falls back to a plain notification email (no signature captured) if Adobe Sign isn't connected.</div>
            <div className="form-grid" style={{ marginBottom: 10 }}>
              <div><label>To (recipient email)</label><input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} /></div>
              <div><label>Location</label><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Bangalore" style={{ width: "100%" }} /></div>
              <div><label>Building</label><input value={building} onChange={(e) => setBuilding(e.target.value)} placeholder="e.g. Building 1A, 2nd Floor" style={{ width: "100%" }} /></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
              <GhostButton onClick={saveFields} disabled={saving}>{saving ? "Saving…" : "Save Changes & Refresh Preview"}</GhostButton>
            </div>
            <div style={{ background: "#ffffff", color: "#1a1a1a", border: "1px solid var(--border)", borderRadius: 10, padding: 20, fontSize: 14, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 700, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #eee" }}>{preview.subject}</div>
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

function CompletedTaskCard({ t, assets, reloadAssets }: { t: any; assets: any[] | null; reloadAssets: () => void }) {
  const [open, setOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [viewingAssigned, setViewingAssigned] = useState(false);
  const automated = !!t.graphUserId;
  const employeeId = t.offer?.employeeId;
  // Derived straight from the live `assets` list (never from the task record itself) — so the
  // button reflects Asset Inventory's actual current state and flips the instant `reloadAssets()`
  // refetches it after an assignment, with no separate "task status" field to fall out of sync.
  const assignedAssets = (assets || []).filter((a: any) => employeeId && a.assignedEmployeeId === employeeId && a.status === "ASSIGNED");
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <div>
          <div style={{ fontWeight: 600 }}>{t.offer?.candidateName} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{t.displayName ? `· ${t.displayName}` : ""}</span></div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Approved {t.emailCreatedAt ? fmtDateTime(t.emailCreatedAt) : "—"}</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`pill ${automated ? "good" : ""}`}>{automated ? "Created automatically" : "Manual (emailed)"}</span>
          {t.licenseAssignedSku && <span className="pill good">License: {t.licenseAssignedSku}</span>}
          {t.provisioningError && <span className="pill bad" title={t.provisioningError}>Provisioning error</span>}
          <span className={`pill ${t.welcomeEmailSentAt ? "good" : "warn"}`}>Welcome email {t.welcomeEmailSentAt ? "sent" : "not sent"}</span>
          <span className={`pill ${t.laptopHandoverEmailSentAt ? "good" : "warn"}`}>Laptop handover {t.laptopHandoverEmailSentAt ? "sent" : "not sent"}</span>
          {assignedAssets.length > 0
            ? <GhostButton onClick={(e: any) => { e.stopPropagation(); setViewingAssigned(true); }}>✓ Assets Assigned ({assignedAssets.length}) — View</GhostButton>
            : <GhostButton onClick={(e: any) => { e.stopPropagation(); setAssigning(true); }}>Assign Assets</GhostButton>}
          <LaptopHandoverButton t={t} />
          <GhostButton onClick={(e: any) => { e.stopPropagation(); setOpen(!open); }}>{open ? "Hide" : "Details"}</GhostButton>
        </div>
      </div>
      {open && <RequestDetailTable t={t} />}
      {assigning && <AssignAssetsSection t={t} assets={assets} reloadAssets={reloadAssets} onClose={() => setAssigning(false)} />}
      {viewingAssigned && (
        <Modal title={`Assigned Assets — ${t.offer?.candidateName}`} open onClose={() => setViewingAssigned(false)}>
          <table>
            <thead><tr><th>Asset Name</th><th>Category</th><th>Asset ID</th><th>Serial Number</th><th>Assignment Date</th></tr></thead>
            <tbody>
              {assignedAssets.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.category}</td>
                  <td>{a.assetTag}</td>
                  <td>{a.serialNo || "—"}</td>
                  <td>{a.assignedAt ? fmtDate(a.assignedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <GhostButton onClick={() => { setViewingAssigned(false); setAssigning(true); }}>+ Assign More Assets</GhostButton>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Offboarding — queued automatically whenever HR/Finance deactivates or terminates someone
// (Masters.tsx direct Terminate, or either step of the two-step Finance-approval flow). One click
// disables O365 sign-in, frees the license(s), and removes them from the Intune access group, then
// emails Finance + HR that the account is deactivated.
function OffboardingTaskCard({ t, busy, onComplete }: { t: any; busy: boolean; onComplete: (id: number, alreadyDeactivated: boolean, removeGroupIds: number[]) => Promise<any> }) {
  // Mirrors Pending Tasks' own "Email ID Already Created – Skip Account Creation" checkbox — the
  // account was already disabled outside this app, so skip the Graph deactivation calls but still
  // mark the task complete and notify Finance/HR.
  const [alreadyDeactivated, setAlreadyDeactivated] = useState(false);
  // "Already Deactivated" skips every Graph call (see the route's own comment) — including the
  // memberships fetch the checklist needs, so that path goes straight to Deactivate with no
  // checklist step. Otherwise: Deactivate Account always opens the checklist first.
  const [showChecklist, setShowChecklist] = useState(false);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t.employee?.name} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{t.employee?.empNo ? `· ${t.employee.empNo}` : ""}</span></div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{t.employee?.designation}{t.employee?.department ? ` · ${t.employee.department}` : ""}{t.employee?.email ? ` · ${t.employee.email}` : ""}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Queued {fmtDateTime(t.createdAt)}</div>
</div>
        <button disabled={busy} onClick={() => alreadyDeactivated ? onComplete(t.id, true, []) : setShowChecklist(true)}>{busy ? "Deactivating…" : "Deactivate Account"}</button>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12.5, cursor: "pointer" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={alreadyDeactivated} onChange={(e) => setAlreadyDeactivated(e.target.checked)} />
        Email ID Already Deactivated – Skip Account Deactivation
      </label>
      {showChecklist && (
        <GroupChecklistModal
          title={`Deactivation Checklist — ${t.employee?.name}`}
          fetchUrl={`/it-admin/offboarding-tasks/${t.id}/group-checklist`}
          confirmLabel="Confirm Deactivation"
          onConfirm={(ids) => onComplete(t.id, false, ids)}
          onClose={() => setShowChecklist(false)}
        />
      )}
    </div>
  );
}

function CompletedOffboardingCard({ t }: { t: any }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t.employee?.name} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{t.employee?.empNo ? `· ${t.employee.empNo}` : ""}</span></div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Deactivated {t.completedAt ? fmtDateTime(t.completedAt) : "—"}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className={`pill ${t.accountDisabled ? "good" : "bad"}`}>Account {t.accountDisabled ? "disabled" : "not disabled"}</span>
          <span className={`pill ${t.licenseRemoved ? "good" : "bad"}`}>License {t.licenseRemoved ? "removed" : "not removed"}</span>
          <span className={`pill ${t.removedFromGroup ? "good" : "bad"}`}>Access group {t.removedFromGroup ? "removed" : "not removed"}</span>
        </div>
      </div>
      {t.error && <div className="note" style={{ marginTop: 6, color: "var(--bad)" }}>{t.error}</div>}
    </div>
  );
}

// Assets currently pending collection from an offboarded employee — created automatically the
// moment their account is deactivated (see itAdmin.ts's /offboarding-tasks/:id/complete). IT Admin
// picks an expected date, then resolves every asset to Received or Missing in one pass once the
// hardware actually comes back.
function AssetCollectionTaskCard({ t, onReload }: { t: any; onReload: () => void }) {
  const { show } = useToast();
  const savedDate = t.expectedDate ? t.expectedDate.slice(0, 10) : "";
  const [expectedDate, setExpectedDate] = useState(savedDate);
  const [savingDate, setSavingDate] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const saveDate = async () => {
    setSavingDate(true);
    try { await api.put(`/it-admin/asset-collection/${t.id}`, { expectedDate: expectedDate || null }); show("Saved"); onReload(); }
    catch (e: any) { show(e.message, "error"); } finally { setSavingDate(false); }
  };
  const overdue = !!t.expectedDate && new Date(t.expectedDate) < new Date();
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t.employee?.name} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{t.employee?.empNo ? `· ${t.employee.empNo}` : ""}</span></div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{t.items.length} asset{t.items.length === 1 ? "" : "s"} to collect · Queued {fmtDateTime(t.createdAt)}</div>
          {overdue && <span className="pill bad" style={{ marginTop: 4, display: "inline-block" }}>Overdue — reminder {t.reminderSentAt ? "sent" : "pending"}</span>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
            Expected date
            <DateInput value={expectedDate} onChange={(e: any) => setExpectedDate(e.target.value)} />
          </label>
          {expectedDate !== savedDate && <GhostButton disabled={savingDate} onClick={saveDate}>{savingDate ? "Saving…" : "Save"}</GhostButton>}
          <AddButton onClick={() => setReceiving(true)}>Receive Asset Collection</AddButton>
        </div>
      </div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table><thead><tr><th>Asset Name</th><th>Category</th><th>Asset ID</th><th>Serial Number</th></tr></thead>
          <tbody>{t.items.map((i: any) => (
            <tr key={i.id}><td>{i.asset.name}</td><td>{i.asset.category}</td><td style={{ fontWeight: 600 }}>{i.asset.assetTag}</td><td>{i.asset.serialNo || "—"}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {receiving && <ReceiveAssetCollectionModal task={t} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); onReload(); }} />}
    </div>
  );
}

function ReceiveAssetCollectionModal({ task, onClose, onDone }: { task: any; onClose: () => void; onDone: () => void }) {
  const { show } = useToast();
  const [results, setResults] = useState<Record<number, { result: "RECEIVED" | "MISSING"; remark: string }>>(
    () => Object.fromEntries(task.items.map((i: any) => [i.id, { result: "RECEIVED" as const, remark: "" }])),
  );
  const [busy, setBusy] = useState(false);
  const setResult = (id: number, result: "RECEIVED" | "MISSING") => setResults((r) => ({ ...r, [id]: { ...r[id], result } }));
  const setRemark = (id: number, remark: string) => setResults((r) => ({ ...r, [id]: { ...r[id], remark } }));
  const missingCount = Object.values(results).filter((r) => r.result === "MISSING").length;
  const submit = async () => {
    const missingWithoutRemark = task.items.find((i: any) => results[i.id].result === "MISSING" && !results[i.id].remark.trim());
    if (missingWithoutRemark) return show("A remark is required for every asset marked Missing.", "error");
    setBusy(true);
    try {
      await api.post(`/it-admin/asset-collection/${task.id}/receive`, { items: task.items.map((i: any) => ({ itemId: i.id, result: results[i.id].result, remark: results[i.id].remark || undefined })) });
      show(missingCount ? `Recorded — ${task.items.length - missingCount} received, ${missingCount} missing` : `All ${task.items.length} asset(s) received`);
      onDone();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Receive Asset Collection — ${task.employee?.name}`} open onClose={onClose} onSave={submit} saveLabel={busy ? "Saving…" : "Save"} busy={busy} wide>
      <div className="note" style={{ marginTop: 0 }}>Mark exactly which assets came back. A remark is required for anything Missing — it stays associated with {task.employee?.name} and out of the reassignment pool.</div>
      <table style={{ marginTop: 8 }}><thead><tr><th>Asset</th><th>Status</th><th>Remark</th></tr></thead>
        <tbody>
          {task.items.map((i: any) => (
            <tr key={i.id}>
              <td style={{ whiteSpace: "nowrap" }}>{i.asset.assetTag} · {i.asset.name}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <label style={{ marginRight: 10 }}><input type="radio" name={`r-${i.id}`} checked={results[i.id].result === "RECEIVED"} onChange={() => setResult(i.id, "RECEIVED")} /> Received</label>
                <label><input type="radio" name={`r-${i.id}`} checked={results[i.id].result === "MISSING"} onChange={() => setResult(i.id, "MISSING")} /> Missing</label>
              </td>
              <td>{results[i.id].result === "MISSING" && <input placeholder="Reason (required)" value={results[i.id].remark} onChange={(e) => setRemark(i.id, e.target.value)} style={{ width: "100%" }} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function CompletedAssetCollectionCard({ t }: { t: any }) {
  const [open, setOpen] = useState(false);
  const missing = t.items.filter((i: any) => i.result === "MISSING");
  const received = t.items.filter((i: any) => i.result === "RECEIVED");
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10, cursor: "pointer" }} onClick={() => setOpen(true)}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t.employee?.name} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{t.employee?.empNo ? `· ${t.employee.empNo}` : ""}</span></div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Processed {t.processedAt ? fmtDateTime(t.processedAt) : "—"}</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="pill good">{received.length} received</span>
          {missing.length > 0 && <span className="pill bad">{missing.length} missing</span>}
          <GhostButton onClick={(e: any) => { e.stopPropagation(); setOpen(true); }}>Details</GhostButton>
        </div>
      </div>
      {missing.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          {missing.map((i: any) => <div key={i.id} style={{ color: "var(--bad)" }}>⚠ {i.asset.assetTag} — {i.asset.name}: {i.remark}</div>)}
        </div>
      )}
      {open && <CollectionDetailModal t={t} onClose={(e: any) => { e?.stopPropagation?.(); setOpen(false); }} />}
    </div>
  );
}

// Permanent record of exactly what happened at this employee's offboarding handover — what was
// assigned (the task's own snapshot, taken the moment the account was deactivated), what actually
// came back, what's missing and why. Stays available here exactly as it was at the time, regardless
// of whatever later happens to those assets in Asset Inventory (reassigned, retired, etc.) — this is
// the offboarding record, not a live asset-status view.
function CollectionDetailModal({ t, onClose }: { t: any; onClose: (e?: any) => void }) {
  const missing = t.items.filter((i: any) => i.result === "MISSING");
  const received = t.items.filter((i: any) => i.result === "RECEIVED");
  const assetRow = (i: any) => <tr key={i.id}><td>{i.asset.assetTag}</td><td>{i.asset.name}</td><td>{i.asset.category}</td><td>{i.asset.serialNo || "—"}</td></tr>;
  return (
    <Modal title={`Collection Details — ${t.employee?.name}`} open onClose={onClose} wide>
      <table style={{ marginBottom: 14 }}><tbody>
        <tr><td>Employee Name</td><td className="num">{t.employee?.name}</td></tr>
        <tr><td>Employee ID</td><td className="num">{t.employee?.empNo || "—"}</td></tr>
        <tr><td>Collection Date</td><td className="num">{t.processedAt ? fmtDateTime(t.processedAt) : "—"}</td></tr>
        <tr><td>Collected By</td><td className="num">{t.processedByName || "—"}</td></tr>
      </tbody></table>

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Assets Assigned to Employee ({t.items.length})</div>
      <table style={{ marginBottom: 14 }}><thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Serial</th></tr></thead>
        <tbody>{t.items.map(assetRow)}</tbody>
      </table>

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "var(--good)" }}>Assets Received ({received.length})</div>
      {received.length === 0 ? <div className="note" style={{ marginBottom: 14 }}>None received.</div> : (
        <table style={{ marginBottom: 14 }}><thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Serial</th></tr></thead>
          <tbody>{received.map(assetRow)}</tbody>
        </table>
      )}

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "var(--bad)" }}>Assets Missing / Not Returned ({missing.length})</div>
      {missing.length === 0 ? <div className="note">None missing.</div> : (
        <table><thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Serial</th><th>Return Remark</th></tr></thead>
          <tbody>{missing.map((i: any) => <tr key={i.id}><td>{i.asset.assetTag}</td><td>{i.asset.name}</td><td>{i.asset.category}</td><td>{i.asset.serialNo || "—"}</td><td>{i.remark}</td></tr>)}</tbody>
        </table>
      )}
    </Modal>
  );
}

export function ItOffboardingDashboard() {
  const { data: tasks, reload } = useFetch<any[]>("/it-admin/offboarding-tasks");
  const { data: history, reload: reloadHistory } = useFetch<any[]>("/it-admin/offboarding-tasks/history");
  const { data: assetTasks, reload: reloadAssetTasks } = useFetch<any[]>("/it-admin/asset-collection");
  const { data: assetHistory, reload: reloadAssetHistory } = useFetch<any[]>("/it-admin/asset-collection/history");
  const { show } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    const cleanup = watchRoom("helpdesk:activity", "helpdesk:activity", () => { reload(); reloadHistory(); reloadAssetTasks(); reloadAssetHistory(); });
    return () => cleanup();
  }, []);

  // Returns the full server response so the Deactivation Checklist modal can show each selected
  // group's ✅ Removed / ❌ Failed result.
  const complete = async (id: number, alreadyDeactivated: boolean, removeGroupIds: number[]) => {
    setBusyId(id);
    try {
      const r: any = await api.post(`/it-admin/offboarding-tasks/${id}/complete`, { alreadyDeactivated, removeGroupIds });
      if (r?.warnings?.length) show(r.warnings.join(" "), "error");
      else show(r?.assetCollectionTask ? `Account deactivated — Finance and HR notified · ${r.assetCollectionTask.items.length} asset(s) queued for collection` : "Account deactivated — Finance and HR notified.");
      reload(); reloadHistory(); reloadAssetTasks();
      return r;
    } catch (e: any) { show(e.message, "error"); throw e; } finally { setBusyId(null); }
  };

  return (
    <div>
      <h1>Offboarding</h1>
      <div className="subtitle">Queued the moment someone is deactivated or terminated. Deactivate Account disables their Microsoft 365 sign-in, frees their license(s), removes them from the Intune access group, and notifies Finance and HR.</div>
      <Panel title={`Pending (${(tasks || []).length})`} style={{ marginTop: 12 }}>
        {(tasks || []).length === 0 ? <div className="note">Nothing pending — all caught up.</div> :
          (tasks || []).map((t: any) => <OffboardingTaskCard key={t.id} t={t} busy={busyId === t.id} onComplete={complete} />)}
      </Panel>
      <Panel title={`Asset Collection — Pending (${(assetTasks || []).length})`} style={{ marginTop: 14 }}>
        <div className="subtitle" style={{ marginTop: 0 }}>Hardware still owed back from a deactivated account — set an expected date, then Receive Asset Collection once it's returned.</div>
        {(assetTasks || []).length === 0 ? <div className="note">Nothing pending — all caught up.</div> :
          (assetTasks || []).map((t: any) => <AssetCollectionTaskCard key={t.id} t={t} onReload={() => { reloadAssetTasks(); reloadAssetHistory(); }} />)}
      </Panel>
      {(assetHistory || []).length > 0 && (
        <Panel title="Asset Collection — Recently Completed" style={{ marginTop: 14 }}>
          {(assetHistory || []).map((t: any) => <CompletedAssetCollectionCard key={t.id} t={t} />)}
        </Panel>
      )}
      <Panel title="Recently Completed" style={{ marginTop: 14 }}>
        {(history || []).length === 0 ? <div className="note">No completed tasks yet.</div> :
          (history || []).map((t: any) => <CompletedOffboardingCard key={t.id} t={t} />)}
      </Panel>
    </div>
  );
}

export function ItAdminDashboard() {
  const { data: tasks, reload } = useFetch<any[]>("/it-admin/tasks");
  const { data: history, reload: reloadHistory } = useFetch<any[]>("/it-admin/tasks/history");
  // Fetched once here (not per Recently Completed card) and shared — the Assign Assets section on
  // each card reads the same live in-stock list, so assigning one asset from one card immediately
  // removes it from every other card's picker too, instead of each card holding a stale copy.
  const { data: assets, reload: reloadAssets } = useFetch<any[]>("/helpdesk/admin/assets");
  const { show } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);
  // Live — a new "Send to IT" request or an Approve elsewhere pings this room (see
  // engine/realtime.ts emitHelpdeskUpdate, fired from hrOffers.ts/itAdmin.ts), same pattern the
  // Helpdesk Console already uses, so Pending Tasks never needs a manual refresh to show up.
  useEffect(() => {
    const cleanup = watchRoom("helpdesk:activity", "helpdesk:activity", () => { reload(); reloadHistory(); reloadAssets(); });
    return () => cleanup();
  }, []);

  const [createdCredential, setCreatedCredential] = useState<{ candidateName: string; email: string; password: string; license?: string; appLoginOnly?: boolean } | null>(null);
  // Returns the full server response so the Group Checklist modal (which calls this as its
  // onConfirm) can show each selected group's ✅ Added / ℹ️ Already a Member / ❌ Failed result.
  const approve = async (offerId: number, displayName: string, emailAlreadyExists: boolean, edited: Record<EditableField, string>, groupIds: number[]) => {
    setBusyId(offerId);
    try {
      const r: any = await api.post(`/it-admin/tasks/${offerId}/complete`, { displayName, emailAlreadyExists, groupIds, ...edited });
      if (r?.temporaryPassword) {
        const t = (tasks || []).find((x: any) => x.offerId === offerId);
        // When the mailbox already existed, this password is only for the NEW app (Users & Roles)
        // login just created — not an O365 password, so the modal below says so.
        setCreatedCredential({ candidateName: t?.offer?.candidateName || "", email: t?.emailIdToCreate || "", password: r.temporaryPassword, license: r.licenseAssignedSku, appLoginOnly: r.emailAlreadyExists });
      }
      if (r?.emailWarning || r?.o365Warning || r?.provisioningWarning) show(r.provisioningWarning || r.emailWarning || r.o365Warning, "error");
      else show(r?.emailAlreadyExists ? "Approved — existing O365 account confirmed, app login created" : r?.graphUserId ? "Approved — O365 mailbox created automatically" : "Approved — O365 Admin notified and welcome email sent");
      reload();
      return r;
    } catch (e: any) { show(e.message, "error"); throw e; } finally { setBusyId(null); }
  };

  return (
    <div>
      <h1>Pending Tasks</h1>
      <div className="subtitle">New-hire IT setup requests from HR. Approving one creates the O365 mailbox action, emails the Office 365 Admin the full request, and sends the new hire GenAquarius's Welcome Email automatically.</div>
      <AutomatedProvisioningPanel />
      <GroupChecklistSettings />
      {createdCredential && (
        <Panel title={createdCredential.appLoginOnly ? "App Login Created — Temporary Password" : "Mailbox Created — Temporary Password"} style={{ marginBottom: 14, borderColor: "var(--good)" }}>
          <div className="subtitle" style={{ margin: 0 }}>
            {createdCredential.appLoginOnly
              ? "The Microsoft 365 mailbox already existed and was left untouched — this password is only for their GenAquarius ERP login (Users & Roles), just created."
              : "Shown once — not emailed, not shown again after you leave this page. They'll be forced to change it on first sign-in."} Share it with {createdCredential.candidateName} through a secure channel.
          </div>
          <table style={{ marginTop: 8 }}><tbody>
            <tr><td>Account</td><td className="num">{createdCredential.email}</td></tr>
            <tr><td>Temporary Password</td><td className="num" style={{ fontFamily: "monospace" }}>{createdCredential.password}</td></tr>
            {createdCredential.license && <tr><td>License Assigned</td><td className="num">{createdCredential.license}</td></tr>}
          </tbody></table>
          <GhostButton style={{ marginTop: 8 }} onClick={() => setCreatedCredential(null)}>Dismiss</GhostButton>
        </Panel>
      )}
      <Panel title={`Pending Tasks (${(tasks || []).length})`} style={{ marginTop: 12 }}>
        {(tasks || []).length === 0 ? <div className="note">Nothing pending — all caught up.</div> :
          (tasks || []).map((t: any) => <PendingTaskCard key={t.id} t={t} busy={busyId === t.offerId} onApprove={approve} />)}
      </Panel>
      <Panel title="Recently Completed" style={{ marginTop: 14 }}>
        {(history || []).length === 0 ? <div className="note">No completed tasks yet.</div> :
          (history || []).map((t: any) => <CompletedTaskCard key={t.id} t={t} assets={assets} reloadAssets={reloadAssets} />)}
      </Panel>
    </div>
  );
}
