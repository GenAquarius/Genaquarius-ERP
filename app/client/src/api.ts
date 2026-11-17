// Session is an httpOnly cookie set by the server; the browser sends it
// automatically with credentials:"include". No token is stored in JS (XSS-safe).

async function req(method: string, path: string, body?: any) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth")) {
    // Session is missing / expired / invalid — tell the app to drop auth state
    // and render the login screen (handled in AuthProvider). Using an event
    // instead of a hard `location.href` keeps the SPA from getting stuck.
    window.dispatchEvent(new Event("auth:unauthorized"));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (p: string) => req("GET", p),
  post: (p: string, b?: any) => req("POST", p, b),
  put: (p: string, b?: any) => req("PUT", p, b),
  del: (p: string) => req("DELETE", p),
  // same-origin link; the httpOnly session cookie is sent automatically
  pdfUrl: (p: string) => `/api${p}`,
  // POST a JSON body and get back a binary (e.g. a rendered PDF) as a Blob.
  postBlob: async (p: string, b?: any) => {
    const res = await fetch(`/api${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: b ? JSON.stringify(b) : undefined });
    if (!res.ok) { const t = await res.text(); let m = `HTTP ${res.status}`; try { m = JSON.parse(t).error || m; } catch { /* non-JSON */ } throw new Error(m); }
    return res.blob();
  },
};
