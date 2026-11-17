import React, { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

export interface User { id: number; name: string; email: string; role: string; employeeId: number | null; }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void | Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

// QA = full testing access (QA/demo environment only; never provisioned on live).
export const ADMIN = ["CEO", "COO", "CTO", "FINANCE", "QA"];
export const isAdmin = (r?: string) => !!r && ADMIN.includes(r);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // session lives in an httpOnly cookie — ask the server who we are
    api.get("/auth/me").then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Any protected request that comes back 401 (expired / invalid JWT) drops us
    // to the login screen so the user can sign in again, instead of hanging.
    const onUnauthorized = () => { setUser(null); setLoading(false); };
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.post("/auth/login", { email, password });
    setUser(r.user);
  };
  const logout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    setUser(null);
    window.location.href = "/login";
  };

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
