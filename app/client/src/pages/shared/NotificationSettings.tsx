import React, { useState } from "react";
import { api } from "../../api";
import { useFetch, Panel } from "../../ui";
import { useToast } from "../../components";

interface Flow {
  key: string; label: string; category: string; description: string; hasCc: boolean; cadence?: boolean; companyWide?: boolean; to?: string;
  enabled: boolean; ccExcludedUserIds: number[]; reminderTimes: string[] | null;
}
const COMPANY_WIDE_BUCKET = "⚠ Company-Wide Broadcasts (off by default)";
interface CcUser { id: number; name: string; email: string; role: string; }

const DEFAULT_TIMES = ["09:00"];

export function NotificationSettings() {
  const { data, loading, reload } = useFetch<{ flows: Flow[]; ccPool: CcUser[] }>("/notification-settings");
  const { show } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Local draft state for the expanded flow's CC checkboxes / reminder times, keyed by flowKey —
  // only committed to the server on "Save", so opening a row to look never risks an accidental change.
  const [draft, setDraft] = useState<{ ccExcludedUserIds: number[]; reminderTimes: string[] } | null>(null);

  const toggleEnabled = async (f: Flow) => {
    setBusyKey(f.key);
    try {
      await api.put(`/notification-settings/${f.key}`, { enabled: !f.enabled });
      show(`${f.label} ${!f.enabled ? "enabled" : "disabled"}`);
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusyKey(null); }
  };

  const openDetail = (f: Flow) => {
    if (expanded === f.key) { setExpanded(null); setDraft(null); return; }
    setExpanded(f.key);
    setDraft({ ccExcludedUserIds: [...f.ccExcludedUserIds], reminderTimes: f.reminderTimes?.length ? [...f.reminderTimes] : [...DEFAULT_TIMES] });
  };

  const saveDetail = async (f: Flow) => {
    if (!draft) return;
    setBusyKey(f.key);
    try {
      await api.put(`/notification-settings/${f.key}`, { ccExcludedUserIds: draft.ccExcludedUserIds, reminderTimes: f.cadence ? draft.reminderTimes : undefined });
      show("Saved"); setExpanded(null); setDraft(null); reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusyKey(null); }
  };

  if (loading || !data) return <Panel>Loading…</Panel>;
  const { flows, ccPool } = data;
  // Company-wide flows (scan-and-email-everyone, e.g. the daily onboarding-document nudge) get
  // pulled into their own bucket regardless of their normal category, shown first and clearly
  // marked — they default OFF (see server's own isFlowEnabled comment) specifically because a real
  // incident here once emailed the entire company, not just people actually mid-onboarding.
  const bucketFor = (f: Flow) => f.companyWide ? COMPANY_WIDE_BUCKET : f.category;
  const categories = [...new Set(flows.map(bucketFor))].sort((a, b) => a === COMPANY_WIDE_BUCKET ? -1 : b === COMPANY_WIDE_BUCKET ? 1 : 0);

  return (
    <div>
      <h1>Notification Settings</h1>
      <div className="subtitle">
        Turn any email notification on or off, and — for candidate/employee-facing emails — choose which
        Finance/HR people are copied by default. New Finance/HR hires are automatically included everywhere
        unless you uncheck them for a specific notification.
      </div>
      {categories.map((cat) => (
        <Panel key={cat} title={cat} style={cat === COMPANY_WIDE_BUCKET ? { marginTop: 14, border: "1px solid var(--warn, #f59e0b)" } : { marginTop: 14 }}>
          {cat === COMPANY_WIDE_BUCKET && (
            <div className="note" style={{ marginBottom: 10 }}>
              These scan and email every active employee on a daily schedule, rather than one specific person tied to a single action — off by default until you explicitly turn one on.
            </div>
          )}
          <table><tbody>
            {flows.filter((f) => bucketFor(f) === cat).map((f) => (
              <React.Fragment key={f.key}>
                <tr style={{ cursor: (f.hasCc || f.cadence) ? "pointer" : "default" }} onClick={() => (f.hasCc || f.cadence) && openDetail(f)}>
                  <td style={{ width: 26 }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={f.enabled} disabled={busyKey === f.key} onChange={() => toggleEnabled(f)} title={f.enabled ? "Enabled — click to turn off" : "Disabled — click to turn on"} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, opacity: f.enabled ? 1 : 0.55 }}>{f.label}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{f.description}</div>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {/* Always visible on the row itself — never hidden behind the CC-only expand
                        section — so it's immediately clear which flows go to an individual employee
                        (vs. a Finance/HR/IT Admin role broadcast) without an extra click. */}
                    {f.to && <span className="pill" style={{ marginRight: 6 }} title="Primary recipient">To: {f.to}</span>}
                    {f.hasCc && <span className="pill" style={{ marginRight: 6 }}>{f.ccExcludedUserIds.length ? `CC: ${ccPool.length - f.ccExcludedUserIds.length}/${ccPool.length}` : `CC: all Finance/HR`}</span>}
                    {f.cadence && <span className="pill">{(f.reminderTimes?.length ? f.reminderTimes : DEFAULT_TIMES).join(", ")}</span>}
                    {(f.hasCc || f.cadence) && <span style={{ marginLeft: 8, color: "var(--muted)" }}>{expanded === f.key ? "▾" : "▸"}</span>}
                  </td>
                </tr>
                {expanded === f.key && draft && (
                  <tr>
                    <td></td>
                    <td colSpan={2} style={{ paddingBottom: 14 }}>
                      <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                        {f.hasCc && (
                          <>
                            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>CC on this notification (default: all Finance + HR)</div>
                            {ccPool.length === 0 ? <div style={{ fontSize: 12, color: "var(--muted)" }}>No Finance/HR users yet.</div> : (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                                {ccPool.map((u) => {
                                  const checked = !draft.ccExcludedUserIds.includes(u.id);
                                  return (
                                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                                      <input type="checkbox" checked={checked} onChange={() =>
                                        setDraft((d) => d ? { ...d, ccExcludedUserIds: checked ? [...d.ccExcludedUserIds, u.id] : d.ccExcludedUserIds.filter((id) => id !== u.id) } : d)
                                      } />
                                      {u.name} <span style={{ color: "var(--muted)" }}>({u.role.charAt(0) + u.role.slice(1).toLowerCase()})</span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}
                        {f.cadence && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Send times each day (24h, server-local)</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                              {draft.reminderTimes.map((t, i) => (
                                <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <input type="time" value={t} style={{ width: 110 }}
                                    onChange={(e) => setDraft((d) => d ? { ...d, reminderTimes: d.reminderTimes.map((x, xi) => xi === i ? e.target.value : x) } : d)} />
                                  <span onClick={() => setDraft((d) => d ? { ...d, reminderTimes: d.reminderTimes.filter((_, xi) => xi !== i) } : d)}
                                    style={{ cursor: "pointer", color: "var(--bad, #e5484d)", fontWeight: 700, padding: "0 4px" }}>×</span>
                                </span>
                              ))}
                              <button className="ghost" type="button" onClick={() => setDraft((d) => d ? { ...d, reminderTimes: [...d.reminderTimes, "09:00"] } : d)}>+ Add time</button>
                            </div>
                            <div className="subtitle" style={{ margin: "6px 0 0" }}>{draft.reminderTimes.length} send(s)/day — each employee with a pending action gets at most one email per configured time, deduped automatically.</div>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button disabled={busyKey === f.key} onClick={() => saveDetail(f)}>{busyKey === f.key ? "Saving…" : "Save"}</button>
                          <button className="ghost" onClick={() => { setExpanded(null); setDraft(null); }}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody></table>
        </Panel>
      ))}
    </div>
  );
}
