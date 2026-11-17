// Candidate-facing Mandatory Document Collection portal — the secure-link side of
// routes/hrms/hrOffers.ts's /offers/:id/document-collection/send. Mounted BEFORE the global
// `authenticate` gate in index.ts (same pattern as the Adobe Sign webhook) — the opaque token IS
// the only credential, there is no login. Never trust anything here beyond the token lookup;
// every route re-derives the offer/request from `token`, never from a client-supplied id.
import { Router } from "express";
import { prisma } from "../../prisma";
import { emitEsignUpdate } from "../../engine/realtime";

const router = Router();
const MAX_FILES_PER_DOC = 5;

async function loadByToken(token: string) {
  const request = await prisma.documentCollectionRequest.findUnique({
    where: { token }, include: { documents: true, offer: { select: { id: true, candidateName: true, offerRef: true } } },
  });
  return request;
}

router.get("/:token", async (req, res) => {
  const request = await loadByToken(req.params.token);
  if (!request) return res.status(404).json({ error: "This link is invalid or has expired." });
  res.json({
    candidateName: request.offer.candidateName, offerRef: request.offer.offerRef,
    completed: !!request.completedAt,
    documents: request.documents.map((d) => ({
      docType: d.docType, label: d.label, status: d.status, rejectionNote: d.rejectionNote, required: d.required,
      files: (Array.isArray(d.files) ? (d.files as any[]) : []).map((f, i) => ({ index: i, fileName: f.fileName, uploadedAt: f.uploadedAt })),
    })),
  });
});

router.post("/:token/upload", async (req, res) => {
  const request = await loadByToken(req.params.token);
  if (!request) return res.status(404).json({ error: "This link is invalid or has expired." });
  if (request.completedAt) return res.status(400).json({ error: "These documents have already been submitted." });
  const { docType, fileName, fileData } = req.body || {};
  if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData (base64) are required" });
  const doc = request.documents.find((d) => d.docType === docType);
  if (!doc) return res.status(404).json({ error: "Unknown document type for this request." });
  const existing = Array.isArray(doc.files) ? (doc.files as any[]) : [];
  const nextFiles = doc.multipleFiles
    ? existing.length >= MAX_FILES_PER_DOC ? existing : [...existing, { fileName, fileData, uploadedAt: new Date() }]
    : [{ fileName, fileData, uploadedAt: new Date() }]; // single-file types: replace
  const updated = await prisma.candidateDocument.update({ where: { id: doc.id }, data: { files: nextFiles as any, status: "UPLOADED", rejectionNote: null } });
  res.json({ docType: updated.docType, status: updated.status, fileCount: (updated.files as any[]).length });
});

router.post("/:token/remove", async (req, res) => {
  const request = await loadByToken(req.params.token);
  if (!request) return res.status(404).json({ error: "This link is invalid or has expired." });
  if (request.completedAt) return res.status(400).json({ error: "These documents have already been submitted." });
  const { docType, index } = req.body || {};
  const doc = request.documents.find((d) => d.docType === docType);
  if (!doc) return res.status(404).json({ error: "Unknown document type for this request." });
  const existing = Array.isArray(doc.files) ? (doc.files as any[]) : [];
  const nextFiles = existing.filter((_, i) => i !== Number(index));
  const updated = await prisma.candidateDocument.update({ where: { id: doc.id }, data: { files: nextFiles as any, status: nextFiles.length ? "UPLOADED" : "PENDING" } });
  res.json({ docType: updated.docType, status: updated.status, fileCount: nextFiles.length });
});

router.get("/:token/file/:docType/:index", async (req, res) => {
  const request = await loadByToken(req.params.token);
  if (!request) return res.status(404).json({ error: "This link is invalid or has expired." });
  const doc = request.documents.find((d) => d.docType === req.params.docType);
  const file = doc && (Array.isArray(doc.files) ? (doc.files as any[]) : [])[Number(req.params.index)];
  if (!file) return res.status(404).json({ error: "File not found" });
  const ext = (file.fileName || "").split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
  res.send(Buffer.from(file.fileData, "base64"));
});

// Section 5 — submitting does NOT advance the workflow to Stage 4. It only marks every
// not-yet-approved document SUBMITTED (candidate says "I'm done") so it shows up in HR's review
// queue; the stage only actually completes once HR has approved every required document
// (maybeAutoCompleteDocumentCollection in routes/hrms/hrOffers.ts, called from /verify). A
// re-submit after a rejection round works the same way — only VERIFIED docs are left untouched.
router.post("/:token/submit", async (req, res) => {
  const request = await loadByToken(req.params.token);
  if (!request) return res.status(404).json({ error: "This link is invalid or has expired." });
  if (request.completedAt) return res.status(400).json({ error: "Already submitted." });
  // Optional documents (e.g. Contractor's Salary Slips) never block submit even with zero files.
  const missing = request.documents.filter((d) => d.required && d.status !== "VERIFIED" && !(Array.isArray(d.files) ? (d.files as any[]) : []).length);
  if (missing.length) return res.status(400).json({ error: `Please upload: ${missing.map((d) => d.label).join(", ")}.` });
  await prisma.$transaction(
    request.documents
      .filter((d) => d.status !== "VERIFIED" && (Array.isArray(d.files) ? (d.files as any[]) : []).length)
      .map((d) => prisma.candidateDocument.update({ where: { id: d.id }, data: { status: "SUBMITTED" } })),
  );
  // Live-refreshes HR's Offer Detail wizard the instant the candidate submits — same room the
  // e-signature updates already use, so the existing watchRoom effect there (reload + stage-status
  // reload) picks this up too and HR sees the documents waiting for review right away.
  emitEsignUpdate("OFFER", request.offer.id, { documentCollectionSubmitted: true });
  res.json({ ok: true });
});

export default router;
