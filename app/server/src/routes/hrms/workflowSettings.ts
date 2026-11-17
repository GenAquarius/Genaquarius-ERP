// HR Settings -> Workflow & Stage Configuration. CRUD on a DRAFT WorkflowDefinition + its stages
// (reorder, add/remove, per-stage config), validate, and publish. Real app routes never read this
// router — they consult engine/workflow.ts against whatever's PUBLISHED.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireRole, HR_OPS_ROLES } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { STAGE_TYPES, invalidatePublishedWorkflowCache } from "../../engine/workflow";

const router = Router();
// Baseline: only HR-tier roles can even open this page (matches every other HR Settings screen).
// Finer-grained view/configure/preview/publish per role (Section 29) is layered on top via each
// workflow's own `permissions` JSON — see hasPerm() below — defaulting to "everyone in this
// baseline gets full access" when a workflow hasn't customized it.
router.use(requireRole(...HR_OPS_ROLES));
router.use(requirePermission("hr-workflow-settings"));

const DEFAULT_PERMISSIONS: Record<string, { view: boolean; configure: boolean; preview: boolean; publish: boolean }> = {
  CEO: { view: true, configure: true, preview: true, publish: true },
  CTO: { view: true, configure: true, preview: true, publish: true },
  HR: { view: true, configure: true, preview: true, publish: true },
};
function hasPerm(wf: { permissions: any } | null, role: string, action: "view" | "configure" | "preview" | "publish"): boolean {
  const matrix = (wf?.permissions as any) || DEFAULT_PERMISSIONS;
  const row = matrix[role];
  if (!row) return DEFAULT_PERMISSIONS[role]?.[action] ?? false;
  return !!row[action];
}
async function requireConfigure(req: any, res: any, next: any) {
  const wf = await prisma.workflowDefinition.findUnique({ where: { id: Number(req.params.id) } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (!hasPerm(wf, req.user!.role, "configure")) return res.status(403).json({ error: "You don't have permission to configure this workflow." });
  next();
}

async function loadWithStages(id: number) {
  return prisma.workflowDefinition.findUnique({ where: { id }, include: { stages: { orderBy: { order: "asc" } } } });
}

router.get("/stage-types", (_req, res) => res.json(STAGE_TYPES));

const empType = (req: any) => {
  const v = req.query.employmentType || req.body?.employmentType;
  return v === "CONTRACTOR" ? "CONTRACTOR" : v === "INTERN" ? "INTERN" : v === "US_CANADA" ? "US_CANADA" : "EMPLOYEE";
};

// The workflow HR is currently editing: the latest DRAFT if one exists, else the live PUBLISHED
// one (read as a starting point — HR must explicitly "Create New Version" to start editing it).
// Employee and Contractor are fully separate templates (own draft/published/history lineage) —
// ?employmentType= picks which one; defaults to EMPLOYEE.
router.get("/", async (req, res) => {
  const employmentType = empType(req);
  const draft = await prisma.workflowDefinition.findFirst({ where: { status: "DRAFT", employmentType }, orderBy: { version: "desc" } });
  const published = await prisma.workflowDefinition.findFirst({ where: { status: "PUBLISHED", employmentType }, orderBy: { version: "desc" } });
  const current = draft || published;
  const editing = current ? await loadWithStages(current.id) : null;
  res.json({
    editing, hasDraft: !!draft, published: published ? await loadWithStages(published.id) : null,
    myPermissions: {
      view: hasPerm(current, req.user!.role, "view"), configure: hasPerm(current, req.user!.role, "configure"),
      preview: hasPerm(current, req.user!.role, "preview"), publish: hasPerm(current, req.user!.role, "publish"),
    },
    permissionMatrix: editing?.permissions || DEFAULT_PERMISSIONS,
  });
});

router.put("/:id/permissions", async (req, res) => {
  const wf = await prisma.workflowDefinition.findUnique({ where: { id: Number(req.params.id) } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  // Publish-level trust to edit who can configure/publish — same bar as actually publishing.
  if (!hasPerm(wf, req.user!.role, "publish")) return res.status(403).json({ error: "Only someone who can publish this workflow can change its permissions." });
  const updated = await prisma.workflowDefinition.update({ where: { id: wf.id }, data: { permissions: req.body?.permissions || {} } });
  res.json(updated);
});

router.get("/history", async (req, res) => {
  res.json(await prisma.workflowDefinition.findMany({ where: { employmentType: empType(req) }, orderBy: { version: "desc" }, select: { id: true, name: true, version: true, status: true, publishedAt: true, appliesTo: true, employmentType: true } }));
});

// "Create New Version" — clones the published workflow's stages into a fresh DRAFT so HR edits
// never touch what's actually live. No-ops (returns the existing one) if a draft already exists.
router.post("/draft", async (req, res) => {
  const employmentType = empType(req);
  const existingDraft = await prisma.workflowDefinition.findFirst({ where: { status: "DRAFT", employmentType }, orderBy: { version: "desc" } });
  if (existingDraft) return res.json(await loadWithStages(existingDraft.id));
  const published = await prisma.workflowDefinition.findFirst({ where: { status: "PUBLISHED", employmentType }, orderBy: { version: "desc" }, include: { stages: true } });
  const nextVersion = (published?.version || 0) + 1;
  const defaultName = employmentType === "CONTRACTOR" ? "Contractor Lifecycle" : employmentType === "INTERN" ? "Intern Lifecycle" : employmentType === "US_CANADA" ? "US/Canada Onboarding" : "Employee Lifecycle";
  const draft = await prisma.workflowDefinition.create({ data: { name: published?.name || defaultName, employmentType, version: nextVersion, status: "DRAFT", appliesTo: "NEW_ONLY", createdById: req.user!.id } });
  for (const s of published?.stages || []) {
    await prisma.workflowStage.create({ data: {
      workflowId: draft.id, key: s.key, name: s.name, stageType: s.stageType, order: s.order, enabled: s.enabled, required: s.required,
      allowSkip: s.allowSkip, allowRevisit: s.allowRevisit, candidateFacing: s.candidateFacing, hrApprovalRequired: s.hrApprovalRequired,
      completionMode: s.completionMode, mandatoryFields: s.mandatoryFields as any, requiredDocuments: s.requiredDocuments as any,
      actions: s.actions as any, dependsOnKeys: s.dependsOnKeys as any, notification: s.notification as any,
    } });
  }
  res.status(201).json(await loadWithStages(draft.id));
});

router.put("/:id", requireConfigure, async (req, res) => {
  const id = Number(req.params.id);
  const wf = await prisma.workflowDefinition.findUnique({ where: { id } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (wf.status !== "DRAFT") return res.status(400).json({ error: "Only a DRAFT workflow can be edited — create a new version first." });
  const { name, appliesTo } = req.body || {};
  const updated = await prisma.workflowDefinition.update({ where: { id }, data: { name: name || undefined, appliesTo: appliesTo || undefined } });
  res.json(updated);
});

const slugify = (s: string) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "stage";

router.post("/:id/stages", requireConfigure, async (req, res) => {
  const workflowId = Number(req.params.id);
  const wf = await prisma.workflowDefinition.findUnique({ where: { id: workflowId }, include: { stages: true } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (wf.status !== "DRAFT") return res.status(400).json({ error: "Only a DRAFT workflow can be edited." });
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: "Stage name is required" });
  const stageType = STAGE_TYPES.includes(b.stageType) ? b.stageType : "CUSTOM_STAGE";
  if (stageType !== "CUSTOM_STAGE" && wf.stages.some((s) => s.stageType === stageType)) {
    return res.status(400).json({ error: `This workflow already has a "${stageType}" stage — only one is allowed per type.` });
  }
  let key = slugify(b.name);
  if (wf.stages.some((s) => s.key === key)) key = `${key}_${wf.stages.length + 1}`;
  const maxOrder = wf.stages.reduce((m, s) => Math.max(m, s.order), 0);
  const stage = await prisma.workflowStage.create({ data: {
    workflowId, key, name: b.name.trim(), stageType, order: maxOrder + 1,
    candidateFacing: b.candidateFacing || "HR_ONLY", completionMode: b.completionMode || "MANUAL",
  } });
  res.status(201).json(stage);
});

router.put("/:id/stages/:stageId", requireConfigure, async (req, res) => {
  const workflowId = Number(req.params.id);
  const stageId = Number(req.params.stageId);
  const wf = await prisma.workflowDefinition.findUnique({ where: { id: workflowId } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (wf.status !== "DRAFT") return res.status(400).json({ error: "Only a DRAFT workflow can be edited." });
  const b = req.body || {};
  const data: any = {};
  for (const k of ["name", "enabled", "required", "allowSkip", "allowRevisit", "candidateFacing", "hrApprovalRequired", "completionMode"]) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  for (const k of ["mandatoryFields", "requiredDocuments", "actions", "dependsOnKeys", "notification"]) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  const stage = await prisma.workflowStage.update({ where: { id: stageId }, data });
  res.json(stage);
});

router.delete("/:id/stages/:stageId", requireConfigure, async (req, res) => {
  const wf = await prisma.workflowDefinition.findUnique({ where: { id: Number(req.params.id) } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (wf.status !== "DRAFT") return res.status(400).json({ error: "Only a DRAFT workflow can be edited." });
  await prisma.workflowStage.delete({ where: { id: Number(req.params.stageId) } }).catch(() => {});
  res.json({ ok: true });
});

// Drag-and-drop reorder — body: { stageIds: number[] } in the new top-to-bottom order.
router.put("/:id/reorder", requireConfigure, async (req, res) => {
  const workflowId = Number(req.params.id);
  const wf = await prisma.workflowDefinition.findUnique({ where: { id: workflowId } });
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (wf.status !== "DRAFT") return res.status(400).json({ error: "Only a DRAFT workflow can be edited." });
  const stageIds: number[] = Array.isArray(req.body?.stageIds) ? req.body.stageIds.map(Number) : [];
  await prisma.$transaction(stageIds.map((sid, i) => prisma.workflowStage.update({ where: { id: sid }, data: { order: i + 1 } })));
  res.json(await loadWithStages(workflowId));
});

function validateWorkflow(wf: any): { level: "ok" | "warn" | "error"; message: string }[] {
  const out: { level: "ok" | "warn" | "error"; message: string }[] = [];
  const enabled = wf.stages.filter((s: any) => s.enabled);
  const byKey = new Map(enabled.map((s: any) => [s.key, s]));
  // ONBOARDING_ACTIVATION is the US/Canada simplified pipeline's own equivalent of
  // EMPLOYEE_ACTIVATION (same real Confirm Joining form, see engine/workflow.ts's
  // STAGE_TYPE_ALIASES) — without this, a US/Canada workflow could never pass validation at all.
  if (!enabled.some((s: any) => s.stageType === "EMPLOYEE_ACTIVATION" || s.stageType === "ONBOARDING_ACTIVATION")) out.push({ level: "error", message: "No Employee Activation stage is configured." });
  for (const s of enabled) {
    const deps: string[] = Array.isArray(s.dependsOnKeys) ? s.dependsOnKeys : [];
    for (const d of deps) if (!byKey.has(d)) out.push({ level: "warn", message: `"${s.name}" depends on a stage that no longer exists — remove or fix that dependency.` });
    if (s.stageType === "DOCUMENT_COLLECTION") {
      const docs = Array.isArray(s.requiredDocuments) ? s.requiredDocuments : [];
      const names = docs.map((d: any) => d.docType);
      if (new Set(names).size !== names.length) out.push({ level: "warn", message: `"${s.name}" has a duplicate document in its required list.` });
    }
    if ((s.stageType === "OFFER_ACCEPTANCE" || s.stageType === "APPOINTMENT_ACCEPTANCE") && !(Array.isArray(s.dependsOnKeys) && s.dependsOnKeys.length) && s.completionMode !== "AUTO") {
      out.push({ level: "warn", message: `"${s.name}" has no completion condition — it may never be markable as done.` });
    }
  }
  // Cycle check (simple DFS) — a workflow where stages depend on each other in a loop can never progress.
  const visiting = new Set<string>(), visited = new Set<string>();
  const hasCycle = (key: string): boolean => {
    if (visited.has(key)) return false;
    if (visiting.has(key)) return true;
    visiting.add(key);
    for (const d of (byKey.get(key) as any)?.dependsOnKeys || []) if (byKey.has(d) && hasCycle(d)) return true;
    visiting.delete(key); visited.add(key);
    return false;
  };
  for (const s of enabled) if (hasCycle(s.key)) { out.push({ level: "error", message: "The configured dependencies contain a cycle — no stage in it could ever unlock." }); break; }
  if (!out.length) out.push({ level: "ok", message: "No issues found." });
  return out;
}

router.get("/:id/validate", async (req, res) => {
  const wf = await loadWithStages(Number(req.params.id));
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  res.json({ results: validateWorkflow(wf) });
});

router.post("/:id/publish", async (req, res) => {
  const id = Number(req.params.id);
  const wf = await loadWithStages(id);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (!hasPerm(wf, req.user!.role, "publish")) return res.status(403).json({ error: "You don't have permission to publish this workflow." });
  if (wf.status !== "DRAFT") return res.status(400).json({ error: "Only a DRAFT workflow can be published." });
  const results = validateWorkflow(wf);
  if (results.some((r) => r.level === "error")) return res.status(400).json({ error: "Fix validation errors before publishing.", results });
  const appliesTo = req.body?.appliesTo || wf.appliesTo;
  const previousPublished = await prisma.workflowDefinition.findFirst({ where: { status: "PUBLISHED", employmentType: wf.employmentType } });
  await prisma.$transaction([
    prisma.workflowDefinition.updateMany({ where: { status: "PUBLISHED", employmentType: wf.employmentType }, data: { status: "ARCHIVED" } }),
    prisma.workflowDefinition.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: req.user!.id, appliesTo } }),
  ]);
  // Section 28 "Apply New Workflow To" — NEW_ONLY (default) leaves every already-pinned offer
  // exactly where it is; NEW_AND_IN_PROGRESS/ALL re-pins offers currently on the previous
  // published version to this one. Stage `key`s are preserved verbatim by "Create New Version"
  // (see /draft above), so each offer's existing OfferStageProgress rows keep meaning unchanged —
  // already-completed stages stay completed, only newly-added/reordered stages are "new" to them.
  let migrated = 0;
  if (appliesTo !== "NEW_ONLY" && previousPublished) {
    const where = appliesTo === "ALL"
      ? { workflowId: previousPublished.id }
      : { workflowId: previousPublished.id, status: { notIn: ["DECLINED", "EXPIRED", "WITHDRAWN", "CANCELLED"] } as any };
    const r = await prisma.offer.updateMany({ where, data: { workflowId: id } });
    migrated = r.count;
  }
  invalidatePublishedWorkflowCache();
  res.json({ ...(await loadWithStages(id)), migratedOfferCount: migrated });
});

export default router;
