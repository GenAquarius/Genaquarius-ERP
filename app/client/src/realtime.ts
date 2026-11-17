// Single shared Socket.IO connection for real-time push (Adobe Sign status updates today).
// Same-origin, so the httpOnly session cookie rides along automatically — no token to manage
// here, mirroring how api.ts never stores a token in JS either.
import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: "/socket.io", withCredentials: true, autoConnect: true });
  }
  return socket;
}

// Joins a room and wires `handler` to `event`, returning a cleanup function for a useEffect.
// Re-joins on reconnect (e.g. after the app server restarts on deploy) since Socket.IO rooms
// don't survive a reconnect.
export function watchRoom(room: string, event: string, handler: (payload: any) => void) {
  const s = getSocket();
  const join = () => s.emit("join", room);
  join();
  s.on("connect", join);
  s.on(event, handler);
  return () => {
    s.off("connect", join);
    s.off(event, handler);
  };
}
