// Real-time push — a single Socket.IO server shared by every live-updating widget in the app:
// Adobe Sign status (EsignPanel joins `esign:<docType>:<docId>`, the HR Dashboard's activity feed
// joins `esign:activity`) and employee pending-actions (the Employee Dashboard joins
// `pending:<employeeId>`, PM/CTO approval queues join the fixed `pending:activity` room).
// Handshake auth mirrors the REST `authenticate` middleware (same session cookie/JWT secret) —
// any authenticated user connects, but `esign:*` room joins are role-gated the same as the actual
// REST routes (HR_OPS_ROLES/ADMIN_ROLES): the event PAYLOAD is the real EsignAgreement row
// (candidate email, doc type, status), not just a bare "go refetch" ping, so letting anyone join
// that room would leak it directly over the socket regardless of the REST layer's own auth.
// `pending:*` payloads are just `{employeeId}` (low sensitivity — still requires an authorized
// REST call to see anything real), so those stay open to any authenticated user.
import { Server as IOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { HR_OPS_ROLES, ADMIN_ROLES } from "../auth/auth";
import { Role } from "@prisma/client";

let io: IOServer | null = null;
const ESIGN_ROLES = new Set<string>([...HR_OPS_ROLES, ...ADMIN_ROLES]);
// IT Admin Dashboard — same access level as the Helpdesk Console/Settings pages themselves.
const HELPDESK_ROLES = new Set<string>([Role.IT_ADMIN, ...ADMIN_ROLES]);

function tokenFromHandshake(cookieHeader: string | undefined, authToken: unknown): string | undefined {
  if (cookieHeader) {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${config.sessionCookie}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return typeof authToken === "string" ? authToken : undefined;
}

export function initRealtime(server: HttpServer) {
  io = new IOServer(server, { path: "/socket.io", cors: { origin: false } });
  io.use((socket, next) => {
    try {
      const token = tokenFromHandshake(socket.handshake.headers.cookie, socket.handshake.auth?.token);
      if (!token) return next(new Error("unauthenticated"));
      const payload = jwt.verify(token, config.jwtSecret) as any;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error("unauthenticated"));
    }
  });
  io.on("connection", (socket) => {
    socket.on("join", (room: unknown) => {
      if (typeof room !== "string") return;
      const isEsignRoom = room === "esign:activity" || room.startsWith("esign:");
      if (isEsignRoom) { if (ESIGN_ROLES.has(socket.data.role)) socket.join(room); return; }
      if (room === "pending:activity" || room.startsWith("pending:")) { socket.join(room); return; }
      if (room === "helpdesk:activity") { if (HELPDESK_ROLES.has(socket.data.role)) socket.join(room); return; }
      // Per-requester room for their own ticket unread/chat updates — `pending:*`-style, low
      // sensitivity (just "go refetch"), open to any authenticated user for their OWN id (the
      // room name itself is unguessable-but-not-secret; the real access control is still the REST
      // layer, same reasoning as pending:<employeeId> above).
      if (room.startsWith("helpdesk:user:")) { socket.join(room); return; }
      // One room per ROLE — the "Need your Attention" widget's own real-time channel (CTC/
      // Appraisal/Termination/Timesheet approvals pending for that role). A socket may only join
      // the room matching its OWN role (never an arbitrary one it names) — payload is just a
      // lightweight "go refetch" kind+timestamp (see emitAttention), so this is pending:*-style
      // low sensitivity, but there's no reason to let a role peek at another role's room name.
      if (room.startsWith("attention:role:")) { if (room === `attention:role:${socket.data.role}`) socket.join(room); return; }
      // Monthly Forecast "what changed & its impact" feed (Finance/Executive Dashboard) — same
      // admin tier as every other financial view, since the payload is the actual $ delta.
      if (room === "forecast:changes") { if (ADMIN_ROLES.includes(socket.data.role)) socket.join(room); return; }
    });
  });
  return io;
}

// Pushes a fresh EsignAgreement row to anyone watching that specific document, and to the HR
// Dashboard's live activity feed. No-op (not a crash) if called before initRealtime or from a
// context where sockets aren't relevant (e.g. a script run outside the app boot sequence).
export function emitEsignUpdate(docType: string, docId: number, row: unknown) {
  if (!io) return;
  io.to(`esign:${docType}:${docId}`).emit("esign:update", row);
  io.to("esign:activity").emit("esign:activity", row);
}

// Pushes a "your pending actions changed" ping for one employee (onboarding doc uploaded/
// reviewed, a Timesheet action opened/closed, etc.) — the Employee Dashboard refetches its own
// list, and any PM/CTO approval queue watching the shared activity room refetches too.
export function emitPendingActionsUpdate(employeeId: number) {
  if (!io) return;
  io.to(`pending:${employeeId}`).emit("pending:update", { employeeId });
  io.to("pending:activity").emit("pending:activity", { employeeId });
}

// Pushes a "something changed in the helpdesk" ping (new ticket, comment, status change, approval
// decision, access granted/rotated, asset assigned) to the IT Admin Dashboard — a lightweight
// "go refetch" signal, same pattern as emitPendingActionsUpdate, not the full row (the dashboard's
// own aggregation query is the source of truth, not the socket payload).
export function emitHelpdeskUpdate(kind: string, detail?: Record<string, unknown>) {
  if (!io) return;
  io.to("helpdesk:activity").emit("helpdesk:activity", { kind, at: new Date().toISOString(), ...detail });
}

// Same ping, but to one specific requester — used alongside emitHelpdeskUpdate so an employee's
// own "My Tickets" unread badge / open ticket chat updates live too, not just IT's queue (the
// broad helpdesk:activity room is IT-only — see initRealtime).
export function emitHelpdeskUpdateToUser(userId: number, kind: string, detail?: Record<string, unknown>) {
  if (!io) return;
  io.to(`helpdesk:user:${userId}`).emit("helpdesk:activity", { kind, at: new Date().toISOString(), ...detail });
}

// "Need your Attention" — pushes a lightweight "go refetch" ping to EVERY currently-connected
// user holding one of the given roles, the moment something new lands that needs THEIR approval
// (CTC, Appraisal, Termination/FnF, Timesheet-to-Finance, Timesheet-to-PM). The dashboard widget
// re-queries GET /dashboard/attention (the real source of truth for counts/items) on receipt —
// same "ping, don't push the real row" convention as emitHelpdeskUpdate.
export function emitAttention(roles: string[], kind: string, detail?: Record<string, unknown>) {
  if (!io) return;
  for (const role of roles) io.to(`attention:role:${role}`).emit("attention:update", { kind, at: new Date().toISOString(), ...detail });
}

// Monthly Forecast change — Finance/Executive Dashboard's live "what changed & its impact" feed.
// Unlike the "ping, go refetch" convention above, this pushes the actual small change record
// (action/month/resource/project/$ impact) directly — it's cheap, self-contained, and the whole
// point is the viewer sees the number that just moved without an extra round trip.
export function emitForecastChange(detail: { action: string; fiscalYear: string; month: string; resourceName?: string; projectName?: string; impact: Record<string, number> }) {
  if (!io) return;
  io.to("forecast:changes").emit("forecast:change", { at: new Date().toISOString(), ...detail });
}
