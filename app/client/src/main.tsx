import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import "./index.css";
import { AuthProvider } from "./auth";
import { PermissionsProvider } from "./permissions";
import { ToastProvider, ConfirmProvider } from "./components";
import App from "./App";

// apply saved theme (dark default) before first paint
document.documentElement.dataset.theme = localStorage.getItem("theme") || "dark";

/**
 * Catches any render-time crash so a broken page (e.g. an expired session that
 * trips up a component) never shows a blank white screen with no way out — the
 * user always gets a visible "Sign in again" option to refresh their session.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("App crashed:", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="login-wrap">
        <div className="panel login-card" style={{ textAlign: "center" }}>
          <img src="/genaquarius.png" alt="GenAquarius" style={{ maxHeight: 56, maxWidth: 220 }} />
          <div className="subtitle" style={{ margin: "10px 0 4px" }}>Your session may have expired.</div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>Please sign in again to continue.</div>
          <a href="/api/auth/azure/login" style={{ display: "block" }}>
            <button style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span style={{ fontWeight: 700 }}>⊞</span> Sign in with Microsoft
            </button>
          </a>
          <button className="ghost" style={{ width: "100%", marginTop: 10 }} onClick={() => { window.location.href = "/login"; }}>
            Back to login
          </button>
        </div>
      </div>
    );
  }
}

/** Keeps the MUI palette mode in sync with the app's light/dark toggle (fires "themechange"). */
function MuiBridge({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = React.useState<"light" | "dark">((localStorage.getItem("theme") as any) || "dark");
  React.useEffect(() => {
    const h = () => setMode((localStorage.getItem("theme") as any) || "dark");
    window.addEventListener("themechange", h);
    return () => window.removeEventListener("themechange", h);
  }, []);
  const theme = React.useMemo(() => createTheme({
    palette: { mode, primary: { main: mode === "light" ? "#6d28d9" : "#8b7bff" }, secondary: { main: "#1863DC" } },
    shape: { borderRadius: 8 },
    typography: { fontFamily: "inherit" },
  }), [mode]);
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <MuiBridge>
          <AuthProvider>
            <PermissionsProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <App />
                </ConfirmProvider>
              </ToastProvider>
            </PermissionsProvider>
          </AuthProvider>
        </MuiBridge>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
