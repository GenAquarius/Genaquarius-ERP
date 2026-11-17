import React, { useMemo, useState } from "react";
import Pagination from "@mui/material/Pagination";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import FilterAltOutlinedIcon from "@mui/icons-material/FilterAltOutlined";
import { EditAction, DeleteAction, GhostButton } from "./components";
import { usePageSize } from "./ui";

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  render?: (row: T) => React.ReactNode;
  value?: (row: T) => any; // for search/sort/filter
  noSort?: boolean;        // opt a column out of sort/filter
}

// ---- shared sort/filter primitives (used by DataTable AND custom tables app-wide) ----
export interface SFCol { key: string; label: string; num?: boolean; get?: (r: any) => any; noSort?: boolean; }
export const asText = (v: any) => (v == null ? "" : typeof v === "object" ? JSON.stringify(Object.values(v)) : String(v)).toLowerCase();

export function useSortFilter(rows: any[], cols: SFCol[]) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [show, setShow] = useState(false);
  const get = (c: SFCol, r: any) => (c.get ? c.get(r) : r[c.key]);
  const view = useMemo(() => {
    let out = rows || [];
    const active = Object.entries(filters).filter(([, v]) => String(v).trim());
    if (active.length) {
      out = out.filter((r) => active.every(([k, v]) => {
        const c = cols.find((x) => x.key === k); if (!c) return true;
        return asText(get(c, r)).includes(String(v).toLowerCase());
      }));
    }
    if (sort) {
      const c = cols.find((x) => x.key === sort.key);
      if (c) out = [...out].sort((a, b) => {
        const va = get(c, a), vb = get(c, b);
        const cmp = (typeof va === "number" && typeof vb === "number") ? va - vb : asText(va).localeCompare(asText(vb), undefined, { numeric: true });
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, sort, filters, cols]);
  const toggle = (k: string) => {
    const c = cols.find((x) => x.key === k); if (c?.noSort) return;
    setSort((s) => s?.key !== k ? { key: k, dir: "asc" } : s.dir === "asc" ? { key: k, dir: "desc" } : null);
  };
  return { view, sort, toggle, filters, setFilter: (k: string, v: string) => setFilters((f) => ({ ...f, [k]: v })), show, setShow };
}

export type SF = ReturnType<typeof useSortFilter>;

/** Filters on/off toggle button — place near a custom table's title. */
export function FilterToggle({ sf }: { sf: SF }) {
  return <GhostButton onClick={() => sf.setShow(!sf.show)} icon={<FilterAltOutlinedIcon />}>{sf.show ? "Hide filters" : "Filters"}</GhostButton>;
}

/** <thead> with sortable headers + (toggleable) per-column filter row. leading/trailing add extra columns (expand/actions). */
export function SortableHead({ cols, sf, leading, trailing }: { cols: SFCol[]; sf: SF; leading?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <thead>
      <tr>
        {leading}
        {cols.map((c) => (
          <th key={c.key} className={c.num ? "num" : ""} onClick={() => sf.toggle(c.key)} style={{ cursor: c.noSort ? "default" : "pointer", userSelect: "none", whiteSpace: "nowrap" }} title={(c as any).tip || (c.noSort ? "" : "Sort")}>
            {c.label}
            {sf.sort?.key === c.key && (sf.sort.dir === "asc"
              ? <ArrowUpwardRoundedIcon sx={{ fontSize: 13, verticalAlign: "-2px", ml: 0.3, color: "var(--accent)" }} />
              : <ArrowDownwardRoundedIcon sx={{ fontSize: 13, verticalAlign: "-2px", ml: 0.3, color: "var(--accent)" }} />)}
          </th>
        ))}
        {trailing}
      </tr>
      {sf.show && (
        <tr>
          {leading ? <th /> : null}
          {cols.map((c) => (
            <th key={c.key} style={{ padding: 4 }}>
              {!c.noSort && <input placeholder={c.label || "filter"} value={sf.filters[c.key] || ""} onChange={(e) => sf.setFilter(c.key, e.target.value)} style={{ fontSize: 12, padding: "3px 6px" }} />}
            </th>
          ))}
          {trailing ? <th /> : null}
        </tr>
      )}
    </thead>
  );
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  pageSize?: number;
  searchKeys?: (row: T) => string;
  onEdit?: (row: T) => void;
  onDelete?: (row: T) => void;
  empty?: string;
}

/** Reusable table: global search + per-column sort & filter + pagination + Edit/Delete actions. */
export function DataTable<T extends { id?: number }>({
  rows, columns, pageSize, searchKeys, onEdit, onDelete, empty = "No records.",
}: Props<T>) {
  const globalSize = usePageSize();
  const size = pageSize ?? globalSize;
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  // global text search runs first; then per-column sort/filter via the shared hook
  const searched = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    const text = searchKeys || ((r: any) => Object.values(r).join(" "));
    return rows.filter((r) => String(text(r)).toLowerCase().includes(needle));
  }, [rows, q, searchKeys]);

  const sfCols: SFCol[] = useMemo(() => columns.map((c) => ({ key: c.key, label: c.label, num: c.num, noSort: c.noSort, get: c.value })), [columns]);
  const sf = useSortFilter(searched, sfCols);

  const pages = Math.max(1, Math.ceil(sf.view.length / size));
  const cur = Math.min(page, pages);
  const slice = sf.view.slice((cur - 1) * size, cur * size);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", display: "flex", color: "var(--muted)" }}><SearchRoundedIcon fontSize="small" /></span>
          <input style={{ paddingLeft: 34 }} placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <div style={{ flex: 0 }}><FilterToggle sf={sf} /></div>
        <div style={{ flex: 0, color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>{sf.view.length} record(s)</div>
      </div>
      <table>
        <SortableHead cols={sfCols} sf={sf} trailing={(onEdit || onDelete) ? <th style={{ width: 1, textAlign: "right" }}>Actions</th> : undefined} />
        <tbody>
          {slice.length === 0 ? (
            <tr><td colSpan={columns.length + 1} style={{ color: "var(--muted)" }}>{empty}</td></tr>
          ) : slice.map((row: any, i: number) => (
            <tr key={row.id ?? i}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? "num" : ""}>{c.render ? c.render(row) : (row as any)[c.key]}</td>
              ))}
              {(onEdit || onDelete) && (
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {onEdit && <EditAction onClick={() => onEdit(row)} />}
                  {onDelete && <DeleteAction onClick={() => onDelete(row)} />}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
          <Pagination count={pages} page={cur} onChange={(_, p) => setPage(p)} color="primary" shape="rounded" size="small" siblingCount={1} />
        </div>
      )}
    </div>
  );
}
