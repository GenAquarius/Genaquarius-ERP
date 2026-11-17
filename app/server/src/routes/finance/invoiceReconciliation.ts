// Invoice Reconciliation — read-only cross-check between Monthly Forecast & Actuals and what's
// actually been invoiced, for a selected month. Answers three questions Finance can't easily see
// anywhere else today: (1) which billable resources have no invoice at all yet, (2) which
// generated invoices haven't been sent, (3) where an invoiced amount drifted from the forecast's
// own Actual Invoice figure.
//
// Matching is exact: InvoiceAnnexure.lineId is a permanent reference back to the originating
// MonthlyLine, set at Generate time (buildInvoiceDraft/sanitizeAnnexure in invoices.ts always
// carries it through for a per-resource row). A null lineId just means the row predates this
// column, or is a manually-added annexure row with no backing forecast line — it never matches
// anything here, same as a resource that's genuinely not yet invoiced.
import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";

const router = Router();
router.use(requireAdmin);
router.use(requirePermission("invoice-reconciliation"));

const round2 = (n: number) => Math.round((n || 0) * 100) / 100;

router.get("/", async (req, res) => {
  const fiscalYear = String(req.query.fiscalYear || "FY26-27");
  const month = String(req.query.month || "");
  if (!month) return res.status(400).json({ error: "month is required" });

  const sheet = await prisma.monthlySheet.findUnique({ where: { fiscalYear_month: { fiscalYear, month } } });
  if (!sheet) {
    return res.json({
      notYetInvoiced: [], notSent: [], sent: [], mismatches: [], notYetInvoicedByProject: [], notSentByProject: [], sentByProject: [],
      totalForecastAmount: 0,
      forecastBreakdown: { sent: { count: 0, amount: 0 }, notSent: { count: 0, amount: 0 }, mismatched: { count: 0, amount: 0 }, notYetInvoiced: { count: 0, amount: 0 } },
      kpis: {
        notYetInvoicedCount: 0, notYetInvoicedAmount: 0, notSentCount: 0, notSentAmount: 0, sentCount: 0, sentAmount: 0,
        mismatchCount: 0, mismatchAmount: 0, atRiskCount: 0, atRiskAmount: 0,
      },
    });
  }

  // Every billable resource line on this month's sheet with something actually billable on it.
  const lines = await prisma.monthlyLine.findMany({
    where: { monthlySheetId: sheet.id, isExpense: false, isBillable: true, invoiceAmount: { gt: 0 } },
    include: { project: { select: { id: true, name: true, clientId: true, currency: true, client: { select: { id: true, name: true, currency: true } } } } },
  });

  const lineIds = lines.map((l) => l.id);
  const matchedAnnexure = lineIds.length
    ? await prisma.invoiceAnnexure.findMany({
        where: { lineId: { in: lineIds } },
        include: { invoice: { select: { id: true, invoiceNo: true, status: true } } },
      })
    : [];
  const byLineId = new Map<number, { amount: number; invoiceNo: string; invoiceId: number; invoiceStatus: string }>();
  for (const a of matchedAnnexure) if (a.lineId != null) byLineId.set(a.lineId, { amount: a.amount, invoiceNo: a.invoice.invoiceNo, invoiceId: a.invoice.id, invoiceStatus: a.invoice.status });

  // Invoiced amounts on a CAD-billed project are stored/shown in CAD (buildInvoiceDraft converts
  // USD -> CAD for display: see invoices.ts's toCcy). MonthlyLine.invoiceAmount is ALWAYS USD. So
  // the gap must be computed in USD on both sides — convert the invoiced CAD figure back to USD
  // (USD = CAD x CANADA_FACTOR, the exact inverse of toCcy) before comparing, per explicit
  // instruction: compare in USD only, never raw CAD-vs-USD.
  const fx = await prisma.fxRate.findFirst({ where: { context: "CANADA_FACTOR" }, orderBy: { effectiveFrom: "desc" } });
  const cadFactor = fx?.rate || 0.71;

  const notYetInvoiced: any[] = [];
  const mismatches: any[] = [];
  // Every billable line falls into EXACTLY one of these four buckets, each counted at its own
  // forecast (Actual Invoice) amount — so the four always add up to totalForecastAmount below,
  // which is the exact figure Monthly Forecast's "Invoice (actual)" tile and Finance Dashboard's
  // "Revenue (Total Billing)" show for this same month. That's the reconciling identity Finance
  // asked for: Sent + Generated-Not-Sent + Mismatched + Not-Yet-Invoiced = Monthly Forecast total.
  let matchedSentForecastAmount = 0, matchedSentCount = 0;
  let matchedDraftForecastAmount = 0, matchedDraftCount = 0;
  let mismatchForecastAmount = 0;
  for (const l of lines) {
    const clientId = l.project?.clientId ?? null;
    const clientName = l.project?.client?.name || "(no project/client linked)";
    const projectName = l.projectName || l.project?.name || "—";
    const match = byLineId.get(l.id);
    const lineCcy = l.project?.currency || l.project?.client?.currency || "USD";
    const isCad = String(lineCcy) === "CAD";
    // `estimateAmount` (Rate x Estimate, billingAmount) is the early-month projection — shown only
    // behind the client's optional "Show Forecast (Estimate)" toggle, off by default. The DEFAULT,
    // primary comparison is always `actualInvoiceAmount` (Rate x Actual, invoiceAmount) — what the
    // Monthly Forecast & Actuals sheet itself labels "Actual Invoice" — against what's really on
    // the generated invoice (`invoicedAmount` below).
    if (!match) {
      notYetInvoiced.push({ lineId: l.id, client: clientName, clientId, project: projectName, resourceName: l.resourceName, actualInvoiceAmount: l.invoiceAmount, estimateAmount: l.billingAmount });
      continue;
    }
    const invoicedAmountUsd = isCad ? round2(match.amount * cadFactor) : match.amount;
    if (Math.abs(invoicedAmountUsd - l.invoiceAmount) > 0.01) {
      mismatches.push({
        lineId: l.id, client: clientName, clientId, project: projectName, resourceName: l.resourceName,
        actualInvoiceAmount: round2(l.invoiceAmount), estimateAmount: round2(l.billingAmount),
        invoicedAmount: round2(match.amount), invoicedCurrency: lineCcy, invoicedAmountUsd: round2(invoicedAmountUsd),
        difference: round2(invoicedAmountUsd - l.invoiceAmount), invoiceNo: match.invoiceNo, invoiceId: match.invoiceId,
      });
      mismatchForecastAmount += l.invoiceAmount;
    } else if (match.invoiceStatus === "DRAFT") {
      matchedDraftForecastAmount += l.invoiceAmount; matchedDraftCount++;
    } else {
      matchedSentForecastAmount += l.invoiceAmount; matchedSentCount++;
    }
  }

  const draftInvoices = await prisma.invoice.findMany({
    where: { fiscalYear, month, status: "DRAFT" },
    select: { id: true, invoiceNo: true, totalAmount: true, invoiceDate: true, clientId: true, client: { select: { name: true } }, project: { select: { name: true } }, projectTitle: true, projectCode: true },
  });
  // Project name: prefer the durable projectId link (the actual Project chosen at Generate time)
  // over the editable text snapshot, which can be blank or hand-edited away — see Invoice.projectId
  // in schema.prisma.
  const notSent = draftInvoices.map((i) => ({
    id: i.id, invoiceNo: i.invoiceNo, client: i.client?.name || "—", clientId: i.clientId,
    project: i.project?.name || i.projectTitle || i.projectCode || "—", amount: i.totalAmount, invoiceDate: i.invoiceDate,
  }));

  // Completes the lifecycle picture alongside Not Yet Invoiced / Generated-Not-Sent: what's
  // actually gone out the door this month (SENT or PAID), so Finance can see the full funnel
  // rather than just the two "needs attention" buckets.
  const sentInvoices = await prisma.invoice.findMany({
    where: { fiscalYear, month, status: { in: ["SENT", "PAID"] } },
    select: { id: true, invoiceNo: true, totalAmount: true, invoiceDate: true, status: true, clientId: true, client: { select: { name: true } }, project: { select: { name: true } }, projectTitle: true, projectCode: true },
  });
  const sent = sentInvoices.map((i) => ({
    id: i.id, invoiceNo: i.invoiceNo, client: i.client?.name || "—", clientId: i.clientId,
    project: i.project?.name || i.projectTitle || i.projectCode || "—", amount: i.totalAmount, invoiceDate: i.invoiceDate, status: i.status,
  }));

  // Project-level rollups — same two datasets, grouped by Client + Project, for a quick "which
  // projects still need attention" view instead of scanning every individual resource/invoice row.
  type ByProjectRow = { client: string; clientId: number | null; project: string; count: number; amount: number };
  const groupByProject = (rows: { client: string; clientId: number | null; project: string; amount: number }[]): ByProjectRow[] => {
    const map = new Map<string, ByProjectRow>();
    for (const r of rows) {
      const key = `${r.clientId ?? r.client}|${r.project}`;
      const existing = map.get(key);
      if (existing) { existing.count++; existing.amount = round2(existing.amount + r.amount); }
      else map.set(key, { client: r.client, clientId: r.clientId, project: r.project, count: 1, amount: round2(r.amount) });
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  };
  const notYetInvoicedByProject = groupByProject(notYetInvoiced.map((r) => ({ client: r.client, clientId: r.clientId, project: r.project, amount: r.actualInvoiceAmount })));
  const notSentByProject = groupByProject(notSent.map((r) => ({ client: r.client, clientId: r.clientId, project: r.project, amount: r.amount })));
  const sentByProject = groupByProject(sent.map((r) => ({ client: r.client, clientId: r.clientId, project: r.project, amount: r.amount })));

  const notYetInvoicedAmount = round2(notYetInvoiced.reduce((s, x) => s + x.actualInvoiceAmount, 0));
  const notSentAmount = round2(notSent.reduce((s, x) => s + (x.amount || 0), 0));
  const sentAmount = round2(sent.reduce((s, x) => s + (x.amount || 0), 0));
  const mismatchAmount = round2(mismatches.reduce((s, x) => s + Math.abs(x.difference), 0));

  // The reconciling total: every billable line's own forecast (Actual Invoice) amount, partitioned
  // into exactly the 4 buckets above — this is the SAME figure as Monthly Forecast's "Invoice
  // (actual)" tile and Finance Dashboard's "Revenue (Total Billing)" for this month, so Finance can
  // see the whole month's billing accounted for in one place: sent + not-sent + mismatched + not
  // yet invoiced = the month's total.
  const totalForecastAmount = round2(lines.reduce((s, l) => s + (l.invoiceAmount || 0), 0));
  const forecastBreakdown = {
    sent: { count: matchedSentCount, amount: round2(matchedSentForecastAmount) },
    notSent: { count: matchedDraftCount, amount: round2(matchedDraftForecastAmount) },
    mismatched: { count: mismatches.length, amount: round2(mismatchForecastAmount) },
    notYetInvoiced: { count: notYetInvoiced.length, amount: notYetInvoicedAmount },
  };

  res.json({
    notYetInvoiced, notSent, sent, mismatches, notYetInvoicedByProject, notSentByProject, sentByProject,
    totalForecastAmount, forecastBreakdown,
    kpis: {
      notYetInvoicedCount: notYetInvoiced.length, notYetInvoicedAmount,
      notSentCount: notSent.length, notSentAmount,
      sentCount: sent.length, sentAmount,
      mismatchCount: mismatches.length, mismatchAmount,
      // "Needs Attention" bottom-line — the single number Finance leadership actually wants:
      // everything not yet invoiced, generated-but-unsent, or invoiced-wrong, combined.
      atRiskCount: notYetInvoiced.length + notSent.length + mismatches.length,
      atRiskAmount: round2(notYetInvoicedAmount + notSentAmount + mismatchAmount),
    },
  });
});

export default router;
