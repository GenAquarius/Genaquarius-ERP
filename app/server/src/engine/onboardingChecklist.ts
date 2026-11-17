import { prisma } from "../prisma";

// Onboarding document checklist — one place that decides which document types apply to an
// employee and how their stored documents map onto that list.
//
// Why this exists: HR Settings lets a Business Unit clone the global default checklist into its
// own copy (OnboardingDocumentType.businessUnitId), so every document NAME exists once globally
// (businessUnitId null) and again per cloned BU. Callers used to list every type row and look up
// documents by docTypeId, which (a) showed every document twice in Employee Master / Offer &
// Onboarding ("Offer Letter … APPROVED" plus a phantom "Offer Letter … PENDING"), and (b) treated
// a document filed under one copy as missing under the other — so pending-action badges and the
// onboarding reminder email kept asking people for documents already on file.
//
// Rule (same fallback as HR Settings' `?fallback=1` for Generate Offer): the employee's Business
// Unit's own list if it has one, else the global default list. Stored documents are matched by
// document NAME, so a file uploaded against either copy counts.

type DocType = { id: number; name: string; businessUnitId: number | null; required: boolean; order: number };
type StoredDoc = { id: number; employeeId: number; docTypeId: number; status: string; docType?: DocType | null; [k: string]: any };

const norm = (s: string) => (s || "").trim().toLowerCase();
const RANK: Record<string, number> = { APPROVED: 0, SUBMITTED: 1, REJECTED: 2, PENDING: 3 };
const byRank = (a: StoredDoc, b: StoredDoc) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.id - b.id;
/** A document that is on file (counts as done for pending checks). */
const isOnFile = (d: StoredDoc) => d.status === "APPROVED" || d.status === "SUBMITTED";

async function employeeBusinessUnitId(employeeId: number): Promise<number | null> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { businessUnitId: true, offer: { select: { businessUnitId: true } } } });
  return emp?.businessUnitId ?? emp?.offer?.businessUnitId ?? null;
}

/** The checklist that applies to this employee: their BU's own list, else the global defaults. */
export async function checklistTypesForEmployee(employeeId: number): Promise<DocType[]> {
  const buId = await employeeBusinessUnitId(employeeId);
  if (buId) {
    const own = await prisma.onboardingDocumentType.findMany({ where: { businessUnitId: buId }, orderBy: { order: "asc" } });
    if (own.length) return own;
  }
  return prisma.onboardingDocumentType.findMany({ where: { businessUnitId: null }, orderBy: { order: "asc" } });
}

/**
 * Types for an explicit name list (an Offer's documentChecklist): one type per name, preferring
 * the employee's own list's row, falling back to any other same-named row.
 */
export async function checklistTypesByNames(employeeId: number, names: string[]): Promise<DocType[]> {
  const wanted = new Set(names.map(norm));
  const preferred = await checklistTypesForEmployee(employeeId);
  const all = await prisma.onboardingDocumentType.findMany({ orderBy: { order: "asc" } });
  const out: DocType[] = [];
  const seen = new Set<string>();
  for (const t of [...preferred, ...all]) {
    const k = norm(t.name);
    if (!wanted.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * One row per document name for display. Real documents (APPROVED/SUBMITTED/REJECTED) are always
 * shown — even several for one name, so an approved file is never hidden. A PENDING placeholder is
 * only produced when nothing at all is stored under that name. Stored documents whose name isn't
 * on the list are appended rather than dropped.
 */
export function mergeChecklist(types: DocType[], existing: StoredDoc[], employeeId: number) {
  const byName = new Map<string, StoredDoc[]>();
  for (const d of existing) {
    const k = norm(d.docType?.name || "");
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(d);
  }
  const out: any[] = [];
  const used = new Set<string>();
  const pick = (docs: StoredDoc[]) => {
    const real = docs.filter((d) => d.status !== "PENDING").sort(byRank);
    return real.length ? real : [docs.sort(byRank)[0]];
  };
  for (const t of types) {
    const k = norm(t.name);
    if (used.has(k)) continue;
    used.add(k);
    const docs = byName.get(k);
    if (docs?.length) {
      // keep each document's own docTypeId (so Replace/Review hit the right row) but show this
      // list's Required/order flags, which is the checklist that actually applies to the employee
      for (const d of pick(docs)) out.push({ ...d, docType: { ...(d.docType || t), required: t.required, order: t.order } });
    } else {
      out.push({ id: null, employeeId, docTypeId: t.id, docType: t, fileName: null, status: "PENDING" });
    }
  }
  for (const [k, docs] of byName) if (!used.has(k)) out.push(...pick(docs));
  return out;
}

/** Types still outstanding: nothing APPROVED/SUBMITTED on file under that document name. */
export function pendingTypes(types: DocType[], existing: StoredDoc[]): DocType[] {
  const done = new Set(existing.filter(isOnFile).map((d) => norm(d.docType?.name || "")));
  const seen = new Set<string>();
  return types.filter((t) => {
    const k = norm(t.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return !done.has(k);
  });
}
