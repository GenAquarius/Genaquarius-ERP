// Client-side companion to the Module Access Matrix (RolePermission table, server routes/permissions.ts).
// Fetches the signed-in user's own allowed pageKeys once after login and exposes can(pageKey).
//
// This is UI-only convenience — it drives nav visibility and route redirects (additively, alongside
// the existing roles/admin checks in App.tsx), it is NOT the security boundary. The server-side
// requirePermission() gate (engine/permissions.ts) is what actually enforces access. Because of that,
// this fails OPEN (returns true) whenever it hasn't loaded yet, the fetch failed, or a pageKey isn't
// present in the matrix — a slow/broken network call must never hide a nav item or bounce a user that
// the server would otherwise still allow.
import React, { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

interface PermissionsCtx {
  can: (pageKey?: string) => boolean;
  loaded: boolean;
}

const Ctx = createContext<PermissionsCtx>({ can: () => true, loaded: false });
export const usePermissions = () => useContext(Ctx);

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    if (!user) { setPerms(null); return; }
    let alive = true;
    api.get("/permissions/mine").then((p) => { if (alive) setPerms(p || {}); }).catch(() => { if (alive) setPerms(null); });
    return () => { alive = false; };
  }, [user?.id]);

  const can = (pageKey?: string) => {
    if (!pageKey) return true;          // items with no pageKey aren't matrix-governed
    if (!perms) return true;            // not loaded yet / fetch failed → fail open
    if (!(pageKey in perms)) return true; // page not migrated into the matrix yet → fail open
    return perms[pageKey];
  };

  return <Ctx.Provider value={{ can, loaded: !!perms }}>{children}</Ctx.Provider>;
}
