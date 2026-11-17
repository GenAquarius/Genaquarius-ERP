import React, { useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { api } from "../../api";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Default to showing the Microsoft button so the user is never stranded on a
  // blank card while /auth/config is loading (or if that request fails).
  const [cfg, setCfg] = useState<{ azureEnabled: boolean; allowLocalLogin: boolean }>({ azureEnabled: true, allowLocalLogin: false });

  useEffect(() => {
    api.get("/auth/config").then((c) => setCfg({ ...c, allowLocalLogin: false })).catch(() => setCfg({ azureEnabled: true, allowLocalLogin: false }));
    const e = new URLSearchParams(location.search).get("error");
    if (e) setErr(e);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await login(email, password); window.location.href = "/"; }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="panel login-card">
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <img src="/genaquarius.png" alt="GenAquarius" style={{ maxHeight: 56, maxWidth: 220 }} />
          <div className="subtitle" style={{ marginTop: 6 }}>Internal Portal</div>
        </div>

        {cfg?.azureEnabled && (
          <a href="/api/auth/azure/login" style={{ display: "block" }}>
            <button style={{ width: "100%", marginTop: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span style={{ fontWeight: 700 }}>⊞</span> Sign in with Microsoft
            </button>
          </a>
        )}
        {cfg?.azureEnabled && cfg?.allowLocalLogin && (
          <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 12, margin: "14px 0" }}>— or —</div>
        )}

        {cfg?.allowLocalLogin && (
          <form onSubmit={submit}>
            <label>Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            <button style={{ width: "100%", marginTop: 14 }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}

        {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}

        {cfg && !cfg.azureEnabled && !cfg.allowLocalLogin && (
          <div className="note">No sign-in method is enabled. Configure Entra SSO or enable local login.</div>
        )}
      </div>
    </div>
  );
}
