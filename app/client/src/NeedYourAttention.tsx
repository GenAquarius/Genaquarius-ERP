// Cross-cutting "Need your Attention" dashboard widget — one real-time, role-appropriate list of
// pending approvals (CTC, Appraisal, Termination/FnF, Timesheet). Backed by GET /dashboard/attention
// (server/src/routes/shared/attention.ts), which computes the right items for the CALLING user's
// own role; this component is just the rendering + the socket subscription that triggers a refetch.
//
// Room choice by role:
//  - HR/FINANCE/CTO/CEO/COO: `attention:role:<role>` (engine/realtime.ts's emitAttention) — the
//    purpose-built channel for CTC/Appraisal/Termination/Timesheet-to-Finance/Profile-Submission
//    approvals.
//  - PROJECT_MANAGER: reuses the EXISTING `pending:activity` broadcast (already fires on every
//    timesheet submit, see emitPendingActionsUpdate) rather than a new room — no new emit needed.
//  - IT_ADMIN: reuses the EXISTING `helpdesk:activity` room (already fires on provisioning/
//    offboarding changes) for the same reason.
import { useAuth } from "./auth";
import { useFetch, Panel } from "./ui";
import { watchRoom } from "./realtime";
import { useEffect } from "react";
import { Link } from "react-router-dom";

type AttentionItem = { label: string; count: number; href: string };

export function NeedYourAttention() {
  const { user } = useAuth();
  const { data, reload } = useFetch<{ items: AttentionItem[] }>("/dashboard/attention");
  const role = user?.role;
  useEffect(() => {
    if (!role) return;
    const room = ["HR", "FINANCE", "CTO", "CEO", "COO"].includes(role) ? `attention:role:${role}`
      : role === "PROJECT_MANAGER" ? "pending:activity"
      : role === "IT_ADMIN" ? "helpdesk:activity"
      : null;
    const event = room === "pending:activity" ? "pending:activity" : room === "helpdesk:activity" ? "helpdesk:activity" : "attention:update";
    if (!room) return;
    return watchRoom(room, event, reload);
  }, [role]);

  const items = data?.items || [];
  if (!items.length) return null;
  return (
    <Panel title="⚠ Need your Attention" style={{ marginBottom: 14, borderLeft: "3px solid var(--accent, #fbbf24)" }}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((it, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <Link to={it.href}>{it.label}</Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
