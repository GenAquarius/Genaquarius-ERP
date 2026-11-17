// Timesheet Template Management — Finance Settings tab. Library (list/preview/edit/duplicate/
// version/assign/deactivate), the Advanced Builder (section/field config + live HTML preview,
// same debounced-preview pattern used across this app's other Advanced Builders), Project
// Template Assignment, and Import Timesheet → Approved Hours. See the server routes
// (routes/finance/timesheetTemplates.ts, routes/finance/importTimesheet.ts) and the shared config
// shape (engine/timesheetTemplate.ts) for the data model this UI edits.
import React, { useState } from "react";
import { api } from "../../api";
import { useFetch, Panel } from "../../ui";
import { fmtDate, fmtDateTime } from "../../dateFormat";
import { useToast, GhostButton, AddButton, Input, Select, confirmDialog } from "../../components";

const FIELD_TYPES = ["TEXT", "NUMBER", "DATE", "HOURS", "BOOLEAN", "SELECT", "CALCULATED", "APPROVAL"];

function emptyConfig() {
  return { header: { title: "Monthly Timesheet", showLogo: true, companyName: "GenAquarius" }, footer: { text: "", showSignatures: true }, sections: [] as any[], blocks: [] as any[] };
}

// ---- Advanced Layout (Blocks) — the generic, "every element controllable" engine on top of the
// simple section/field editor above. A block config is resolved against real timesheet data on
// export (XLSX/PDF) and against built-in sample data here for live preview — see
// engine/templateDocumentEngine.ts server-side for the exact shapes these fields map to.
const BLOCK_TYPES = ["TEXT", "KEYVALUE", "TABLE", "PIVOT_GRID", "SUMMARY_TABLE"] as const;
const BLOCK_TYPE_LABELS: Record<string, string> = { TEXT: "Text", KEYVALUE: "Key/Value Details", TABLE: "Table (flat entry list)", PIVOT_GRID: "Pivot Grid (day columns)", SUMMARY_TABLE: "Summary Table (multi-employee)" };
const KV_FIELD_OPTIONS = ["employeeName", "employeeId", "project", "client", "period", "billingCriteria"];
const TABLE_FIELD_OPTIONS = ["date", "hours", "head", "comment"];
const SUMMARY_FIELD_OPTIONS = ["resourceName", "projectName", "totalHours", "leaveDays"];

function blankBlock(type: string, order: number): any {
  const id = `blk${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  if (type === "TEXT") return { id, type, order, title: "", text: "" };
  if (type === "KEYVALUE") return { id, type, order, title: "Details", fields: [{ id: "f1", label: "Employee Name", fieldId: "employeeName" }] };
  if (type === "TABLE") return { id, type, order, title: "Hours", columns: [{ id: "c1", label: "Date", fieldId: "date" }, { id: "c2", label: "Hours", fieldId: "hours" }] };
  if (type === "PIVOT_GRID") return { id, type, order, title: "Daily Hours", pivot: { rowField: "task", columnMode: "DAY_OF_MONTH", valueField: "hours", rowLabel: "Task", showRowTotal: true, showColumnTotal: true } };
  return { id, type, order, title: "Summary Report", summaryColumns: [] };
}

const TS_TEMPLATE_SUBTABS = ["library", "assignment", "import", "approved-hours"] as const;
export function TimesheetTemplatesTab() {
  const [sub, setSub] = useState<typeof TS_TEMPLATE_SUBTABS[number]>("library");
  const subs: [typeof sub, string][] = [["library", "Template Library"], ["assignment", "Project Assignment"], ["import", "Import Timesheet"], ["approved-hours", "Approved Hours"]];
  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {subs.map(([k, label]) => (
          <div key={k} onClick={() => setSub(k)} className={`pill ${sub === k ? "accent" : ""}`} style={{ cursor: "pointer" }}>{label}</div>
        ))}
      </div>
      {sub === "library" && <TemplateLibrary />}
      {sub === "assignment" && <TemplateAssignment />}
      {sub === "import" && <ImportTimesheet />}
      {sub === "approved-hours" && <ApprovedHours />}
    </div>
  );
}

// ---------------- Template Library + Advanced Builder ----------------
function TemplateLibrary() {
  const { data, reload } = useFetch<any[]>("/timesheet-templates");
  const { show } = useToast();
  const [sel, setSel] = useState<any>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const createNew = async (fromId?: number) => {
    const name = window.prompt(fromId ? "New template name (Save As):" : "New template name:");
    if (!name?.trim()) return;
    const t = await api.post("/timesheet-templates", { name: name.trim(), fromId });
    show("Template created"); reload(); setSel(t); setBuilderOpen(true);
  };
  const makeDefault = async (t: any) => { await api.put(`/timesheet-templates/${t.id}`, { isDefault: true }); show("Set as default"); reload(); };
  const deactivate = async (t: any) => {
    if (!(await confirmDialog({ title: `Deactivate "${t.name}"?`, message: "Projects assigned to it fall back to the Default Template. Kept for history (any past timesheet that used it keeps its own copy).", danger: true, confirmLabel: "Deactivate" }))) return;
    await api.del(`/timesheet-templates/${t.id}`); show("Deactivated"); reload();
  };
  const newVersion = async (t: any) => {
    if (!(await confirmDialog({ title: `Create a new version of "${t.name}"?`, message: "Projects currently assigned to it move to the new version automatically. Historical timesheets keep using the old version." }))) return;
    const next = await api.post(`/timesheet-templates/${t.id}/new-version`, { config: t.config });
    show(`Created v${next.version}`); reload(); setSel(next); setBuilderOpen(true);
  };
  // Permanent — unlike Deactivate, only offered (and only succeeds) when nothing references
  // this version at all: no project currently assigned to it, no historical timesheet ever used it.
  const deletePermanent = async (t: any) => {
    if (!(await confirmDialog({ title: `Permanently delete "${t.name}"?`, message: "This cannot be undone — unlike Deactivate, the template row itself is removed. Only possible because no project or past timesheet references it.", danger: true, confirmLabel: "Delete Permanently" }))) return;
    try { await api.del(`/timesheet-templates/${t.id}/permanent`); show("Deleted"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };

  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <AddButton onClick={() => createNew()}>+ Create New Template</AddButton>
      </div>
      <Panel title={`Template Library (${(data || []).length})`}>
        <table>
          <thead><tr><th>Template</th><th>Version</th><th>Projects</th><th>Status</th><th>Last Modified</th><th></th></tr></thead>
          <tbody>
            {(data || []).map((t: any) => (
              <tr key={t.id}>
                <td>{t.name}{t.isDefault && <span className="pill good" style={{ marginLeft: 6 }}>Default</span>}</td>
                <td>{t.version}.0</td>
                <td>{t.projectCount}</td>
                <td>{t.status}</td>
                <td>{fmtDate(t.updatedAt)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => previewTemplate(t)}>Preview</button>{" "}
                  <button className="ghost" onClick={() => { setSel(t); setBuilderOpen(true); }}>Edit</button>{" "}
                  <button className="ghost" onClick={() => createNew(t.id)}>Duplicate</button>{" "}
                  <button className="ghost" onClick={() => newVersion(t)}>Create New Version</button>{" "}
                  {!t.isDefault && <button className="ghost" onClick={() => makeDefault(t)}>Set Default</button>}{" "}
                  <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} onClick={() => deactivate(t)}>Deactivate</button>{" "}
                  <button className="ghost" style={{ color: "var(--bad, #e5484d)" }} disabled={t.projectCount > 0 || t.timesheetCount > 0}
                    title={(t.projectCount > 0 || t.timesheetCount > 0) ? `Still in use — ${t.projectCount} project(s), ${t.timesheetCount} historical timesheet(s). Deactivate instead.` : "Permanently remove this template — only possible because nothing references it"}
                    onClick={() => deletePermanent(t)}>Delete</button>
                </td>
              </tr>
            ))}
            {(data || []).length === 0 && <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No templates yet — Create New Template to start.</td></tr>}
          </tbody>
        </table>
      </Panel>
      {builderOpen && sel && <TemplateBuilder template={sel} onClose={() => { setBuilderOpen(false); reload(); }} />}
    </div>
  );
}

async function previewTemplate(t: any) {
  const blob = await api.postBlob("/timesheet-templates/preview", { config: t.config });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

function TemplateBuilder({ template, onClose }: { template: any; onClose: () => void }) {
  const { show } = useToast();
  const [name, setName] = useState(template.name);
  const [config, setConfig] = useState<any>(() => ({ blocks: [], ...(template.config || emptyConfig()) }));
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewMode, setPreviewMode] = useState<"SINGLE" | "REPORT">("SINGLE");
  const seq = React.useRef(0);
  React.useEffect(() => {
    const s = ++seq.current;
    const t = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const blob = await api.postBlob("/timesheet-templates/preview", { config, previewMode });
        if (s === seq.current) setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      } catch { /* keep previous preview on transient errors */ }
      finally { if (s === seq.current) setPreviewBusy(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [config, previewMode]);

  const blocks: any[] = config.blocks || [];
  const setBlocks = (next: any[]) => setConfig({ ...config, blocks: next });
  const addBlock = (type: string) => setBlocks([...blocks, blankBlock(type, blocks.length)]);
  const removeBlock = (bi: number) => setBlocks(blocks.filter((_, i) => i !== bi));
  const updateBlock = (bi: number, patch: any) => setBlocks(blocks.map((b, i) => i === bi ? { ...b, ...patch } : b));
  const moveBlock = (bi: number, dir: -1 | 1) => {
    const next = [...blocks];
    const target = bi + dir;
    if (target < 0 || target >= next.length) return;
    [next[bi], next[target]] = [next[target], next[bi]];
    next.forEach((b, i) => { b.order = i; });
    setBlocks(next);
  };

  const addSection = () => setConfig({ ...config, sections: [...config.sections, { id: `s${Date.now()}`, title: "New Section", order: config.sections.length, fields: [] }] });
  const removeSection = (si: number) => setConfig({ ...config, sections: config.sections.filter((_: any, i: number) => i !== si) });
  const updateSection = (si: number, patch: any) => setConfig({ ...config, sections: config.sections.map((s: any, i: number) => i === si ? { ...s, ...patch } : s) });
  const addField = (si: number) => updateSection(si, { fields: [...config.sections[si].fields, { id: `f${Date.now()}`, label: "New Field", type: "TEXT", order: config.sections[si].fields.length, width: 3 }] });
  const removeField = (si: number, fi: number) => updateSection(si, { fields: config.sections[si].fields.filter((_: any, i: number) => i !== fi) });
  const updateField = (si: number, fi: number, patch: any) => updateSection(si, { fields: config.sections[si].fields.map((f: any, i: number) => i === fi ? { ...f, ...patch } : f) });
  const moveField = (si: number, fi: number, dir: -1 | 1) => {
    const fields = [...config.sections[si].fields];
    const target = fi + dir;
    if (target < 0 || target >= fields.length) return;
    [fields[fi], fields[target]] = [fields[target], fields[fi]];
    fields.forEach((f, i) => { f.order = i; });
    updateSection(si, { fields });
  };

  const save = async () => {
    setBusy(true);
    try { await api.put(`/timesheet-templates/${template.id}`, { name, config }); show("Template saved"); }
    catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={{ width: "min(1500px, 97vw)", maxWidth: "min(1500px, 97vw)", height: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>{"✨ Advanced Template Builder — "}<input value={name} onChange={(e) => setName(e.target.value)} style={{ fontWeight: 700, border: "none", borderBottom: "1px solid var(--border)", background: "transparent" }} /></h3>
          <span className="subtitle" style={{ margin: "0 0 0 14px" }}>{previewBusy ? "⟳ updating live preview…" : "live preview — every change re-renders it →"}</span>
          <button className="ghost" style={{ marginLeft: "auto" }} onClick={onClose}>✕ Close</button>
        </div>
        <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
          <div style={{ flex: "1 1 48%", display: "flex", flexDirection: "column", overflowY: "auto", paddingRight: 6 }}>
            <Panel title="Header">
              <Input label="Title" value={config.header.title} onChange={(e: any) => setConfig({ ...config, header: { ...config.header, title: e.target.value } })} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}><input type="checkbox" checked={config.header.showLogo} onChange={(e) => setConfig({ ...config, header: { ...config.header, showLogo: e.target.checked } })} /> Show company logo/name</label>
            </Panel>
            {config.sections.sort((a: any, b: any) => a.order - b.order).map((s: any, si: number) => (
              <Panel key={s.id} actions={<div style={{ display: "flex", alignItems: "center", gap: 8 }}><input value={s.title} onChange={(e) => updateSection(si, { title: e.target.value })} style={{ fontWeight: 600, border: "none", background: "transparent" }} /><button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => removeSection(si)}>Remove Section</button></div>}>
                <table style={{ marginBottom: 6 }}>
                  <thead><tr><th>Label</th><th>Type</th><th>Width</th><th>Required</th><th>Formula</th><th></th></tr></thead>
                  <tbody>
                    {s.fields.sort((a: any, b: any) => a.order - b.order).map((f: any, fi: number) => (
                      <tr key={f.id}>
                        <td><input value={f.label} onChange={(e) => updateField(si, fi, { label: e.target.value })} style={{ width: 120 }} /></td>
                        <td>
                          <select value={f.type} onChange={(e) => updateField(si, fi, { type: e.target.value })}>
                            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td><input type="number" value={f.width || 3} onChange={(e) => updateField(si, fi, { width: +e.target.value })} style={{ width: 50 }} /></td>
                        <td><input type="checkbox" checked={!!f.required} onChange={(e) => updateField(si, fi, { required: e.target.checked })} /></td>
                        <td>{f.type === "CALCULATED" ? <input value={f.formula || ""} placeholder="regularHours+otHours" onChange={(e) => updateField(si, fi, { formula: e.target.value })} style={{ width: 130 }} /> : "—"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button className="ghost" onClick={() => moveField(si, fi, -1)} title="Move up">↑</button>
                          <button className="ghost" onClick={() => moveField(si, fi, 1)} title="Move down">↓</button>
                          <button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => removeField(si, fi)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <GhostButton onClick={() => addField(si)}>+ Add Field</GhostButton>
              </Panel>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 14 }}>
              <GhostButton onClick={addSection}>+ Add Section</GhostButton>
            </div>

            <Panel title="Advanced Layout (Blocks) — full control over the exported document">
              <div className="subtitle" style={{ marginTop: 0 }}>Drives the real XLSX/PDF export and this preview. Mix Text/Key-Value/Table/Pivot Grid/Summary blocks in any order to reproduce any client's exact layout.</div>
              {blocks.sort((a, b) => a.order - b.order).map((b, bi) => (
                <Panel key={b.id} style={{ marginTop: 10 }} actions={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="pill">{BLOCK_TYPE_LABELS[b.type] || b.type}</span>
                    <input value={b.title || ""} placeholder="Block title (optional)" onChange={(e) => updateBlock(bi, { title: e.target.value })} style={{ fontWeight: 600, border: "none", background: "transparent", width: 160 }} />
                    {/* Excel-toolbar-style formatting for this whole block (title/header bar) —
                        same bold/font-color/fill-color controls as every field/column row below,
                        applied identically in the live preview and the real XLSX/PDF export. */}
                    <button className="ghost" title="Bold" style={{ fontWeight: b.style?.bold ? 900 : 400, padding: "4px 8px" }}
                      onClick={() => updateBlock(bi, { style: { ...b.style, bold: !b.style?.bold } })}>B</button>
                    <label title="Font color" style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, color: "var(--muted)" }}>
                      A<input type="color" value={b.style?.fontColor || "#000000"} onChange={(e) => updateBlock(bi, { style: { ...b.style, fontColor: e.target.value } })} style={{ width: 22, height: 22, padding: 0, border: "none" }} />
                    </label>
                    <label title="Fill color" style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, color: "var(--muted)" }}>
                      🪣<input type="color" value={b.style?.fillColor || "#528BCB"} onChange={(e) => updateBlock(bi, { style: { ...b.style, fillColor: e.target.value } })} style={{ width: 22, height: 22, padding: 0, border: "none" }} />
                    </label>
                    <button className="ghost" onClick={() => moveBlock(bi, -1)} title="Move up">↑</button>
                    <button className="ghost" onClick={() => moveBlock(bi, 1)} title="Move down">↓</button>
                    <button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => removeBlock(bi)}>Remove Block</button>
                  </div>
                }>
                  {b.type === "TEXT" && (
                    <textarea rows={3} style={{ width: "100%" }} value={b.text || ""} placeholder="Free text shown as its own paragraph" onChange={(e) => updateBlock(bi, { text: e.target.value })} />
                  )}
                  {b.type === "KEYVALUE" && (
                    <table style={{ marginBottom: 6 }}>
                      <thead><tr><th>Label</th><th>Source Field</th><th>Style</th><th></th></tr></thead>
                      <tbody>
                        {(b.fields || []).map((f: any, fi: number) => (
                          <tr key={f.id}>
                            <td><input value={f.label} onChange={(e) => updateBlock(bi, { fields: b.fields.map((x: any, i: number) => i === fi ? { ...x, label: e.target.value } : x) })} style={{ width: 150 }} /></td>
                            <td>
                              <select value={f.fieldId} onChange={(e) => updateBlock(bi, { fields: b.fields.map((x: any, i: number) => i === fi ? { ...x, fieldId: e.target.value } : x) })}>
                                {KV_FIELD_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            </td>
                            <td>
                              <button className="ghost" title="Bold" style={{ fontWeight: f.style?.bold ? 900 : 400, padding: "2px 6px" }}
                                onClick={() => updateBlock(bi, { fields: b.fields.map((x: any, i: number) => i === fi ? { ...x, style: { ...x.style, bold: !x.style?.bold } } : x) })}>B</button>{" "}
                              <input type="color" title="Font color" value={f.style?.fontColor || "#000000"} style={{ width: 20, height: 20, padding: 0, border: "none", verticalAlign: "middle" }}
                                onChange={(e) => updateBlock(bi, { fields: b.fields.map((x: any, i: number) => i === fi ? { ...x, style: { ...x.style, fontColor: e.target.value } } : x) })} />{" "}
                              <input type="color" title="Fill color" value={f.style?.fillColor || "#ffffff"} style={{ width: 20, height: 20, padding: 0, border: "none", verticalAlign: "middle" }}
                                onChange={(e) => updateBlock(bi, { fields: b.fields.map((x: any, i: number) => i === fi ? { ...x, style: { ...x.style, fillColor: e.target.value } } : x) })} />
                            </td>
                            <td><button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => updateBlock(bi, { fields: b.fields.filter((_: any, i: number) => i !== fi) })}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr><td colSpan={4}><GhostButton onClick={() => updateBlock(bi, { fields: [...(b.fields || []), { id: `f${Date.now()}`, label: "New Field", fieldId: "employeeName" }] })}>+ Add Field</GhostButton></td></tr></tfoot>
                    </table>
                  )}
                  {b.type === "TABLE" && (
                    <table style={{ marginBottom: 6 }}>
                      <thead><tr><th>Label</th><th>Source Field</th><th>Formula (if CALCULATED)</th><th>Style</th><th></th></tr></thead>
                      <tbody>
                        {(b.columns || []).map((c: any, ci: number) => (
                          <tr key={c.id}>
                            <td><input value={c.label} onChange={(e) => updateBlock(bi, { columns: b.columns.map((x: any, i: number) => i === ci ? { ...x, label: e.target.value } : x) })} style={{ width: 130 }} /></td>
                            <td>
                              <select value={c.fieldId} onChange={(e) => updateBlock(bi, { columns: b.columns.map((x: any, i: number) => i === ci ? { ...x, fieldId: e.target.value, type: undefined } : x) })}>
                                {TABLE_FIELD_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                <option value="_calc">— calculated —</option>
                              </select>
                            </td>
                            <td>{c.fieldId === "_calc" ? <input value={c.formula || ""} placeholder="hours" onChange={(e) => updateBlock(bi, { columns: b.columns.map((x: any, i: number) => i === ci ? { ...x, type: "CALCULATED", formula: e.target.value } : x) })} style={{ width: 110 }} /> : "—"}</td>
                            <td>
                              <button className="ghost" title="Bold" style={{ fontWeight: c.style?.bold ? 900 : 400, padding: "2px 6px" }}
                                onClick={() => updateBlock(bi, { columns: b.columns.map((x: any, i: number) => i === ci ? { ...x, style: { ...x.style, bold: !x.style?.bold } } : x) })}>B</button>{" "}
                              <input type="color" title="Font color" value={c.style?.fontColor || "#000000"} style={{ width: 20, height: 20, padding: 0, border: "none", verticalAlign: "middle" }}
                                onChange={(e) => updateBlock(bi, { columns: b.columns.map((x: any, i: number) => i === ci ? { ...x, style: { ...x.style, fontColor: e.target.value } } : x) })} />{" "}
                              <input type="color" title="Fill color" value={c.style?.fillColor || "#ffffff"} style={{ width: 20, height: 20, padding: 0, border: "none", verticalAlign: "middle" }}
                                onChange={(e) => updateBlock(bi, { columns: b.columns.map((x: any, i: number) => i === ci ? { ...x, style: { ...x.style, fillColor: e.target.value } } : x) })} />
                            </td>
                            <td><button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => updateBlock(bi, { columns: b.columns.filter((_: any, i: number) => i !== ci) })}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr><td colSpan={5}><GhostButton onClick={() => updateBlock(bi, { columns: [...(b.columns || []), { id: `c${Date.now()}`, label: "New Column", fieldId: "hours" }] })}>+ Add Column</GhostButton></td></tr></tfoot>
                    </table>
                  )}
                  {b.type === "PIVOT_GRID" && (
                    <div className="form-grid">
                      <Input label="Row Label" value={b.pivot?.rowLabel || ""} onChange={(e: any) => updateBlock(bi, { pivot: { ...b.pivot, rowLabel: e.target.value } })} />
                      <Select label="Columns" value={b.pivot?.columnMode || "DAY_OF_MONTH"} onChange={(e: any) => updateBlock(bi, { pivot: { ...b.pivot, columnMode: e.target.value } })}
                        options={[{ value: "DAY_OF_MONTH", label: "Day of Month" }, { value: "DAY_OF_WEEK", label: "Day of Week" }]} />
                      <Select label="Cell Value" value={b.pivot?.valueField || "hours"} onChange={(e: any) => updateBlock(bi, { pivot: { ...b.pivot, valueField: e.target.value } })}
                        options={[{ value: "hours", label: "Hours (number)" }, { value: "status", label: "Status (Y/blank)" }]} />
                      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 20 }}><input type="checkbox" checked={!!b.pivot?.showRowTotal} onChange={(e) => updateBlock(bi, { pivot: { ...b.pivot, showRowTotal: e.target.checked } })} /> Show row total column</label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 20 }}><input type="checkbox" checked={!!b.pivot?.showColumnTotal} onChange={(e) => updateBlock(bi, { pivot: { ...b.pivot, showColumnTotal: e.target.checked } })} /> Show column total row</label>
                    </div>
                  )}
                  {b.type === "SUMMARY_TABLE" && (
                    <div>
                      <div className="subtitle" style={{ marginTop: 0 }}>Only shows data in the Multi-Employee Report preview mode below — leave columns empty to use the default (Resource Name / Project Name / Value).</div>
                      <table style={{ marginBottom: 6 }}>
                        <thead><tr><th>Label</th><th>Source Field</th><th></th></tr></thead>
                        <tbody>
                          {(b.summaryColumns || []).map((c: any, ci: number) => (
                            <tr key={c.id}>
                              <td><input value={c.label} onChange={(e) => updateBlock(bi, { summaryColumns: b.summaryColumns.map((x: any, i: number) => i === ci ? { ...x, label: e.target.value } : x) })} style={{ width: 130 }} /></td>
                              <td>
                                <select value={c.fieldId} onChange={(e) => updateBlock(bi, { summaryColumns: b.summaryColumns.map((x: any, i: number) => i === ci ? { ...x, fieldId: e.target.value } : x) })}>
                                  {SUMMARY_FIELD_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                </select>
                              </td>
                              <td><button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => updateBlock(bi, { summaryColumns: b.summaryColumns.filter((_: any, i: number) => i !== ci) })}>✕</button></td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr><td colSpan={3}><GhostButton onClick={() => updateBlock(bi, { summaryColumns: [...(b.summaryColumns || []), { id: `sc${Date.now()}`, label: "Resource Name", fieldId: "resourceName" }] })}>+ Add Column</GhostButton></td></tr></tfoot>
                      </table>
                    </div>
                  )}
                </Panel>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {BLOCK_TYPES.map((t) => <GhostButton key={t} onClick={() => addBlock(t)}>+ Add {BLOCK_TYPE_LABELS[t]}</GhostButton>)}
              </div>
            </Panel>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <AddButton disabled={busy} onClick={save}>Save Changes</AddButton>
            </div>
          </div>
          <div style={{ flex: "1 1 52%", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span className="subtitle" style={{ margin: 0 }}>Preview as:</span>
              <button className={`ghost ${previewMode === "SINGLE" ? "accent" : ""}`} onClick={() => setPreviewMode("SINGLE")}>Single Employee</button>
              <button className={`ghost ${previewMode === "REPORT" ? "accent" : ""}`} onClick={() => setPreviewMode("REPORT")}>Multi-Employee Report</button>
            </div>
            {previewUrl ? <iframe title="Timesheet preview" src={previewUrl} style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
              : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Generating preview…</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Project Template Assignment ----------------
function TemplateAssignment() {
  const { data, reload } = useFetch<any[]>("/timesheet-templates/assignments/all");
  const { data: templates } = useFetch<any[]>("/timesheet-templates");
  const { show } = useToast();
  const assign = async (projectId: number, templateId: string) => {
    await api.post(`/timesheet-templates/assignments/${projectId}`, { templateId: templateId === "" ? null : Number(templateId) });
    show("Assignment updated"); reload();
  };
  return (
    <Panel title="Project Template Assignment">
      <table>
        <thead><tr><th>Project</th><th>Assigned Template</th><th>Source</th><th>Status</th><th>Change</th></tr></thead>
        <tbody>
          {(data || []).map((r: any) => (
            <tr key={r.projectId}>
              <td>{r.projectName}</td>
              <td>{r.assignedTemplate}</td>
              <td><span className={`pill ${r.source === "DEFAULT" ? "" : "accent"}`}>{r.source === "DEFAULT" ? "Default" : "Project Specific"}</span></td>
              <td>{r.status}</td>
              <td>
                <select defaultValue="" onChange={(e) => assign(r.projectId, e.target.value)}>
                  <option value="">Use Default Template</option>
                  {(templates || []).map((t: any) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ---------------- Import Timesheet ----------------
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function ImportTimesheet() {
  const { show } = useToast();
  const { data: batches, reload } = useFetch<any[]>("/import-timesheet/batches");
  const [format, setFormat] = useState("GENERIC_XLSX");
  const [periodMonth, setPeriodMonth] = useState(new Date().getMonth() + 1);
  const [periodYear, setPeriodYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fileData = await fileToBase64(file);
      const r: any = await api.post("/import-timesheet/upload", { fileName: file.name, fileData, format, periodMonth, periodYear });
      show(r.note ? r.note : `Imported ${r.rowCount} row(s) — review in Approved Hours`);
      reload();
    } catch (e: any) { show(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <div>
      <Panel title="Import Timesheet">
        <div className="form-grid">
          <Select label="Format" value={format} onChange={(e: any) => setFormat(e.target.value)} options={[
            { value: "GENERIC_XLSX", label: "Generic Excel (auto-detected columns)" },
            { value: "STATION_CASINO_XLSX", label: "Station Casino Excel (Azure DevOps work-item export)" },
            { value: "WENERGY_PDF", label: "WEnergy PDF (weekly timesheet)" },
            { value: "SYMSOFT_PDF", label: "Symsoft PDF (weekly timesheet)" },
            { value: "PDF_MANUAL", label: "Other PDF (manual entry)" },
          ]} />
          <Input label="Period Month (1-12)" type="number" value={periodMonth} onChange={(e: any) => setPeriodMonth(+e.target.value)} disabled={format !== "GENERIC_XLSX"} title={format !== "GENERIC_XLSX" ? "Not used — this format's period is read from the file itself, per row" : undefined} />
          <Input label="Period Year" type="number" value={periodYear} onChange={(e: any) => setPeriodYear(+e.target.value)} disabled={format !== "GENERIC_XLSX"} title={format !== "GENERIC_XLSX" ? "Not used — this format's period is read from the file itself, per row" : undefined} />
        </div>
        {(format === "WENERGY_PDF" || format === "SYMSOFT_PDF") && (
          <div className="note" style={{ marginTop: 6 }}>If this PDF turns out to be an image-only scan with no extractable text (e.g. a screenshot pasted into a PDF), the batch is still recorded so you can key the hours in by hand below — it won't fail the upload.</div>
        )}
        <label className="ghost" style={{ display: "inline-block", marginTop: 10, padding: "8px 14px", cursor: "pointer" }}>
          {busy ? "Uploading…" : "Choose File"}
          <input type="file" accept=".xlsx,.xls,.pdf" style={{ display: "none" }} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        </label>
      </Panel>
      <Panel title="Import History" style={{ marginTop: 14 }}>
        <table>
          <thead><tr><th>File</th><th>Format</th><th>Period</th><th>Rows</th><th>Uploaded</th></tr></thead>
          <tbody>
            {(batches || []).map((b: any) => (
              <tr key={b.id}><td>{b.fileName}</td><td>{b.format}</td><td>{b.periodMonth}/{b.periodYear}</td><td>{b.rowCount}</td><td>{fmtDateTime(b.uploadedAt)}</td></tr>
            ))}
            {(batches || []).length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No imports yet.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// ---------------- Finance — Approved Hours ----------------
// Timesheets a PM has already approved and that are now sitting in the normal Timesheet
// approval cycle's queue waiting on Finance (same `/timesheets/finance-queue` + `/finance-approve`
// routes TimesheetCalendar.tsx's own admin table already uses) — surfaced here too, per explicit
// request, so Finance can review+approve from Approved Hours without hunting for it elsewhere,
// with a one-click Excel preview laid out using the project's own resolved template.
function AwaitingFinanceApproval() {
  const { data, reload } = useFetch<any[]>("/timesheets/finance-queue");
  const { show } = useToast();
  const [impactOpenId, setImpactOpenId] = useState<number | null>(null);
  const [impact, setImpact] = useState<any>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const toggleImpact = async (id: number) => {
    if (impactOpenId === id) { setImpactOpenId(null); return; }
    setImpactOpenId(id); setImpact(null); setImpactBusy(true);
    try { setImpact(await api.get(`/timesheets/${id}/finance-approve-preview`)); }
    catch (e: any) { show(e.message, "error"); }
    finally { setImpactBusy(false); }
  };
  const approve = async (id: number) => {
    try {
      const r: any = await api.post(`/timesheets/${id}/finance-approve`, {});
      show(r?.mapping?.applied ? `Approved → reflected into ${r.mapping.month} ${r.mapping.fiscalYear} Invoice` : `Approved (not reflected: ${r?.mapping?.reason || "no matching line"})`, r?.mapping?.applied ? "success" : "error");
      setImpactOpenId(null); reload();
    } catch (e: any) { show(e.message, "error"); }
  };
  const rows = data || [];
  if (rows.length === 0) return null;
  return (
    <Panel title={`Awaiting Finance Approval (${rows.length})`} style={{ marginBottom: 14 }}>
      <table>
        <thead><tr><th>Employee</th><th>Project</th><th>Period</th><th>Hours</th><th>Leave</th><th></th></tr></thead>
        <tbody>
          {rows.map((t: any) => (
            <React.Fragment key={t.id}>
            <tr>
              <td>{t.employee?.name}</td>
              <td>{t.project?.name}</td>
              <td>{t.periodMonth}/{t.periodYear}</td>
              <td className="num">{t.totalHours}</td>
              <td className="num">{t.leaveDays}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="ghost" onClick={() => window.open(api.pdfUrl(`/timesheet-templates/export/${t.id}?format=xlsx`), "_blank")}>Preview Excel</button>{" "}
                <button className="ghost" onClick={() => toggleImpact(t.id)}>{impactOpenId === t.id ? "Hide Impact" : "View Impact"}</button>{" "}
                <AddButton onClick={() => approve(t.id)}>Approve (Finance)</AddButton>
              </td>
            </tr>
            {impactOpenId === t.id && (
              <tr><td colSpan={6} style={{ background: "var(--panel2)", padding: 10 }}>
                {impactBusy ? "Checking Monthly Forecast impact…" : !impact ? "—" : !impact.found ? (
                  <span style={{ color: "var(--muted)" }}>No Monthly Forecast impact — {impact.reason}.</span>
                ) : (
                  <span>
                    <b>{impact.month} {impact.fiscalYear}</b> · {impact.projectName}: Actual Hours <b>{impact.current.actualHours}</b> → <b>{impact.projected.actualHours}</b>,
                    {" "}Invoice Amount <b>{impact.current.invoiceAmount?.toLocaleString()}</b> → <b>{impact.projected.invoiceAmount?.toLocaleString()}</b>
                    {" "}({impact.deltaInvoiceAmount >= 0 ? "+" : ""}{impact.deltaInvoiceAmount?.toLocaleString()})
                  </span>
                )}
              </td></tr>
            )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ApprovedHours() {
  const { data: employees } = useFetch<any[]>("/employees");
  const { data: projects } = useFetch<any[]>("/projects");
  const { data, reload } = useFetch<any[]>("/import-timesheet/approved-hours");
  const { show } = useToast();

  const mapRow = async (id: number, field: "employeeId" | "projectId", value: string) => {
    await api.put(`/import-timesheet/approved-hours/${id}`, { [field]: value === "" ? null : Number(value) });
    reload();
  };
  const approve = async (id: number) => {
    try { const r: any = await api.post(`/import-timesheet/approved-hours/${id}/approve`); show(r.appliedToMonthlyLine ? "Approved — applied to Monthly Forecast" : "Approved — no matching Monthly Forecast line found for that month, hours recorded only"); reload(); }
    catch (e: any) { show(e.message, "error"); }
  };
  const del = async (id: number) => { await api.del(`/import-timesheet/approved-hours/${id}`); reload(); };

  return (
    <>
    <AwaitingFinanceApproval />
    <Panel title={`Approved Hours (${(data || []).length})`}>
      <table>
        <thead><tr><th>Employee</th><th>Project</th><th>Period</th><th>Regular</th><th>OT</th><th>Total</th><th>Source</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {(data || []).map((r: any) => (
            <tr key={r.id}>
              <td>{r.employee ? r.employee.name : (
                <select value="" onChange={(e) => mapRow(r.id, "employeeId", e.target.value)} title={`Imported as: ${r.employeeNameRaw}`}>
                  <option value="">⚠ {r.employeeNameRaw || "Unmapped"} — map…</option>
                  {(employees || []).map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              )}</td>
              <td>{r.project ? r.project.name : (
                <select value="" onChange={(e) => mapRow(r.id, "projectId", e.target.value)} title={`Imported as: ${r.projectNameRaw || ""}`}>
                  <option value="">⚠ {r.projectNameRaw || "Unmapped"} — map…</option>
                  {(projects || []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}</td>
              <td>{r.periodMonth}/{r.periodYear}</td>
              <td className="num">{r.regularHours}</td>
              <td className="num">{r.otHours}</td>
              <td className="num">{r.totalHours}</td>
              <td><span className={`pill ${r.source === "IMPORTED" ? "accent" : ""}`}>{r.source}</span></td>
              <td><span className={`pill ${r.status === "APPROVED" ? "good" : ""}`}>{r.status}</span></td>
              <td style={{ whiteSpace: "nowrap" }}>
                {r.status !== "APPROVED" && <button className="ghost" onClick={() => approve(r.id)}>Approve</button>}{" "}
                <button className="ghost" style={{ color: "var(--bad,#e5484d)" }} onClick={() => del(r.id)}>Delete</button>
              </td>
            </tr>
          ))}
          {(data || []).length === 0 && <tr><td colSpan={9} style={{ color: "var(--muted)" }}>No imported hours yet — use Import Timesheet.</td></tr>}
        </tbody>
      </table>
    </Panel>
    </>
  );
}
