import React, { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useFetch, Panel } from "../../ui";
import { useToast } from "../../components";

// Full dynamic Module Access Matrix — backed by RolePermission (server routes/permissions.ts).
// CEO/CTO/COO edit this; the change actually drives nav visibility + route access for every role
// via client/src/permissions.ts's usePermissions()/can(), and server-side requirePermission()
// on the routers that have been wired in (see report — not all routers are wired yet).
const ROLES = ["CEO", "COO", "CTO", "FINANCE", "HR", "PROJECT_MANAGER", "EMPLOYEE", "CONTRACTOR", "INTERN", "QA", "IT_ADMIN"];
// CTO is the one column that stays locked full-access — a hard guardrail against ever
// accidentally locking themselves out of the matrix (and everything else). CEO and COO are
// deliberately NOT locked: CTO has final say over exactly what every other role, including CEO
// and COO, can reach.
const LOCKED_ROLES = ["CTO"];

interface PageRow { pageKey: string; pageLabel: string; roles: Record<string, boolean>; }
interface ModuleGroup { moduleKey: string; pages: PageRow[]; }

export function AccessMatrix() {
  const { data, loading, reload } = useFetch<ModuleGroup[]>("/permissions");
  const { show } = useToast();
  const [grid, setGrid] = useState<Record<string, boolean> | null>(null); // key: `${pageKey}|${role}`
  const [meta, setMeta] = useState<Record<string, { moduleKey: string; pageLabel: string }>>({});
  const [saving, setSaving] = useState(false);
  const original = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (!data) return;
    const g: Record<string, boolean> = {};
    const m: Record<string, { moduleKey: string; pageLabel: string }> = {};
    for (const mod of data) {
      for (const p of mod.pages) {
        m[p.pageKey] = { moduleKey: mod.moduleKey, pageLabel: p.pageLabel };
        for (const role of ROLES) g[`${p.pageKey}|${role}`] = !!p.roles[role];
      }
    }
    setGrid(g);
    setMeta(m);
    original.current = { ...g };
  }, [data]);

  const toggle = (pageKey: string, role: string) => {
    if (LOCKED_ROLES.includes(role)) return; // CTO always full-access — see LOCKED_ROLES note above
    setGrid((g) => (g ? { ...g, [`${pageKey}|${role}`]: !g[`${pageKey}|${role}`] } : g));
  };

  const dirty = !!grid && Object.keys(grid).some((k) => grid[k] !== original.current[k]);

  const save = async () => {
    if (!grid) return;
    const changes = Object.keys(grid)
      .filter((k) => grid[k] !== original.current[k])
      .map((k) => {
        const idx = k.lastIndexOf("|");
        const pageKey = k.slice(0, idx);
        const role = k.slice(idx + 1);
        return { role, pageKey, allowed: grid[k], moduleKey: meta[pageKey]?.moduleKey, pageLabel: meta[pageKey]?.pageLabel };
      });
    if (!changes.length) { show("No changes to save"); return; }
    setSaving(true);
    try {
      await api.put("/permissions", changes);
      show("Access matrix updated");
      reload();
    } catch (e: any) {
      show(e.message || "Failed to save access matrix", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1>Module Access Matrix</h1>
      <div className="subtitle">
        Controls what each role can see and do across the app — enforced on the API (not just hidden in the
        sidebar) for HR Admin Settings, Offers &amp; Lifecycle, and Employees today, with the rest of the app
        rolling onto this dynamically over time. CTO is always full-access and can't be unchecked here —
        every other role, including CEO and COO, is freely editable.
      </div>
      {loading || !grid ? (
        <Panel>Loading…</Panel>
      ) : (
        <>
          {data!.map((mod) => (
            <Panel key={mod.moduleKey} title={mod.moduleKey} style={{ marginTop: 14 }}>
              <table style={{ tableLayout: "fixed", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ width: "auto", textAlign: "left" }}>Page</th>
                    {ROLES.map((r) => <th key={r} style={{ width: 90, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r}>{r}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {mod.pages.map((p) => (
                    <tr key={p.pageKey}>
                      <td>{p.pageLabel}</td>
                      {ROLES.map((role) => {
                        const key = `${p.pageKey}|${role}`;
                        const locked = LOCKED_ROLES.includes(role);
                        return (
                          <td key={role} style={{ width: 90, textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={!!grid[key]}
                              disabled={locked}
                              title={locked ? "CTO is always full-access" : undefined}
                              onChange={() => toggle(p.pageKey, role)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ))}
          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={save} disabled={!dirty || saving}>{saving ? "Saving…" : "Save Changes"}</button>
            {dirty && <span className="subtitle" style={{ margin: 0 }}>You have unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  );
}
