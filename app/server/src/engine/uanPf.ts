// UAN / PF Details — optional free-text field captured at Stage 1 (Candidate Information &
// Generate Offer) for an India full-time employee, carried onto the Employee at Confirm Joining,
// and editable in Employee Master. Free text (not a strict 12-digit UAN) because HR sometimes
// records the PF account number or "Not applicable" alongside / instead of the UAN.
export const UAN_PF_MAX = 191;

/** undefined = field not sent (leave as-is); null = cleared; otherwise trimmed text. */
export function cleanUanPf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim().slice(0, UAN_PF_MAX);
  return s || null;
}
