import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

// Candidate-facing Mandatory Document Collection portal — no login (the token in the URL is the
// only credential), reached from the "Send Document Collection Request" email. Talks directly to
// /api/public/document-collection/:token/* (server/src/routes/public/documentUpload.ts), which
// sits outside the app's normal auth gate. Deliberately standalone markup, not the app Shell —
// a candidate has no account and should never see the sidebar/login chrome.
const api = async (path: string, opts?: RequestInit) => {
  const res = await fetch(`/api/public/document-collection${path}`, { ...opts, headers: opts?.body ? { "Content-Type": "application/json" } : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = reject;
  r.readAsDataURL(file);
});

const STATUS_LABEL: Record<string, string> = { PENDING: "Not uploaded", UPLOADED: "Uploaded — not yet submitted", SUBMITTED: "Submitted", VERIFIED: "Verified", REJECTED: "Rejected — please re-upload" };
const STATUS_COLOR: Record<string, string> = { PENDING: "#8b96b0", UPLOADED: "#fbbf24", SUBMITTED: "#34d399", VERIFIED: "#34d399", REJECTED: "#f87171" };

export default function CandidateDocumentUpload() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDoc, setBusyDoc] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reload = React.useCallback(() => {
    api(`/${token}`).then(setData).catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => { reload(); }, [reload]);

  const upload = async (docType: string, file: File) => {
    setBusyDoc(docType);
    try {
      const fileData = await toBase64(file);
      await api(`/${token}/upload`, { method: "POST", body: JSON.stringify({ docType, fileName: file.name, fileData }) });
      reload();
    } catch (e: any) { setError(e.message); } finally { setBusyDoc(null); }
  };
  const remove = async (docType: string, index: number) => {
    setBusyDoc(docType);
    try { await api(`/${token}/remove`, { method: "POST", body: JSON.stringify({ docType, index }) }); reload(); }
    catch (e: any) { setError(e.message); } finally { setBusyDoc(null); }
  };
  const submit = async () => {
    setSubmitting(true); setSubmitError(null);
    try { await api(`/${token}/submit`, { method: "POST" }); reload(); }
    catch (e: any) { setSubmitError(e.message); } finally { setSubmitting(false); }
  };

  const wrap: React.CSSProperties = { minHeight: "100vh", background: "#0d1526", color: "#e6ebf5", fontFamily: "'Poppins', -apple-system, system-ui, sans-serif", display: "flex", justifyContent: "center", padding: "40px 16px" };
  const card: React.CSSProperties = { width: "100%", maxWidth: 640, background: "#161d2c", border: "1px solid #243049", borderRadius: 14, padding: 28 };

  if (error) return <div style={wrap}><div style={card}><h2 style={{ marginTop: 0 }}>Link unavailable</h2><p style={{ color: "#8b96b0" }}>{error}</p></div></div>;
  if (!data) return <div style={wrap}><div style={card}>Loading…</div></div>;

  // Optional documents (e.g. Salary Slips for a Contractor) never block "done" — only required ones do.
  const allSubmitted = data.documents.every((d: any) => d.required === false || ["SUBMITTED", "VERIFIED"].includes(d.status));

  return (
    <div style={wrap}>
      <div style={card}>
        <img src="/genaquarius.png" alt="GenAquarius" style={{ maxHeight: 34, marginBottom: 18 }} />
        <h2 style={{ margin: "0 0 4px" }}>Mandatory Document Collection</h2>
        <div style={{ color: "#8b96b0", fontSize: 13, marginBottom: 22 }}>Hi {data.candidateName}, please upload the following documents for {data.offerRef}.</div>

        {data.completed ? (
          <div style={{ padding: 16, borderRadius: 10, background: "rgba(52,211,153,.12)", border: "1px solid #34d399", color: "#34d399" }}>
            ✓ All documents verified. Our HR team will be in touch — you can close this page.
          </div>
        ) : allSubmitted ? (
          <div style={{ padding: 16, borderRadius: 10, background: "rgba(52,211,153,.12)", border: "1px solid #34d399", color: "#34d399" }}>
            ✓ Thank you — your documents have been submitted and are being reviewed by our HR team. We'll email you if anything needs to be re-uploaded; otherwise you don't need to do anything further. You can close this page.
          </div>
        ) : (
          <>
            {data.documents.map((d: any) => (
              <div key={d.docType} style={{ border: "1px solid #243049", borderRadius: 10, padding: 14, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{d.label}{d.required === false && <span style={{ fontWeight: 400, color: "#8b96b0" }}> (optional)</span>}</div>
                  <span style={{ fontSize: 11, color: STATUS_COLOR[d.status] || "#8b96b0" }}>{STATUS_LABEL[d.status] || d.status}</span>
                </div>
                {d.rejectionNote && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>⚠ {d.rejectionNote}</div>}
                {d.files.map((f: any) => (
                  <div key={f.index} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 0" }}>
                    <a href={`/api/public/document-collection/${token}/file/${d.docType}/${f.index}`} target="_blank" rel="noreferrer" style={{ color: "#8aa2ff" }}>{f.fileName}</a>
                    <button type="button" onClick={() => remove(d.docType, f.index)} disabled={busyDoc === d.docType} style={{ marginLeft: "auto", background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: 16, padding: 0 }}>×</button>
                  </div>
                ))}
                <label style={{ display: "inline-block", marginTop: 8, padding: "6px 14px", borderRadius: 8, border: "1px solid #243049", cursor: "pointer", fontSize: 12.5 }}>
                  {busyDoc === d.docType ? "Uploading…" : d.files.length ? "Add another file" : "Choose file"}
                  <input type="file" style={{ display: "none" }} disabled={busyDoc === d.docType}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(d.docType, f); e.target.value = ""; }} />
                </label>
              </div>
            ))}
            {submitError && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 10 }}>{submitError}</div>}
            <button onClick={submit} disabled={submitting || (!allSubmitted && !data.documents.every((d: any) => d.required === false || d.files.length))} style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "#8aa2ff", color: "#06101f", fontWeight: 700, cursor: "pointer", marginTop: 8 }}>
              {submitting ? "Submitting…" : "Submit Documents"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
