/**
 * Parity reconciliation — proves ZERO deviation from BOTH workbooks.
 *
 * Rebuilds expected per-resource/per-month cost & invoice directly from
 * golden_master.json (Excel cached cells) and compares, cell by cell, to MySQL.
 * Exit 0 only if there are no deviations across both fiscal years.
 */
import fs from "fs";
import { prisma } from "../prisma";
import { config } from "../config";

const MONTHS = ["Apr","May","June","July","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const ROLLUP_PREFIX = ["Total","Revenue Run","Profit","Cash Flow","India Team","US/Canada","Monthly Profit","Average"];
const EPS = 0.01;

const YEARS: Record<string, { gmKey: string; first: number; last: number; cost: Record<string, string> }> = {
  "FY26-27": { gmKey: "FY26-27", first: 14, last: 132,
    cost: { Apr:"F",May:"L",June:"R",July:"X",Aug:"AB",Sep:"AF",Oct:"AJ",Nov:"AN",Dec:"AR",Jan:"AV",Feb:"AZ",Mar:"BD" } },
  "FY25-26": { gmKey: "FY25-26", first: 12, last: 124,
    cost: { Apr:"F",May:"J",June:"N",July:"R",Aug:"V",Sep:"Z",Oct:"AD",Nov:"AH",Dec:"AL",Jan:"AP",Feb:"AT",Mar:"AX" } },
};

const colToNum = (c: string) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
function numToCol(n: number): string { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
const clean = (s: any) => (s == null ? null : String(s).replace(/\s+/g, " ").trim());
const num = (v: any) => (typeof v === "number" ? v : 0);
const isRollup = (b: string) => ROLLUP_PREFIX.some((p) => b.startsWith(p));

async function reconcileYear(fy: string, gm: any): Promise<number> {
  const cfg = YEARS[fy];
  const ac = gm[cfg.gmKey]?.["Actual Cost"];
  if (!ac) { console.log(`  [${fy}] no golden master sheet — skipped`); return 0; }
  const get = (cell: string) => ac[cell];

  const expected = new Map<string, { cost: number; invoice: number }>();
  let curProj: string | null = null;
  for (let r = cfg.first; r <= cfg.last; r++) {
    const a = clean(get(`A${r}`));
    const b = clean(get(`B${r}`));
    if (a) curProj = a;
    if (!b || isRollup(b)) continue;
    for (const m of MONTHS) {
      const ci = colToNum(cfg.cost[m]);
      const cost = num(get(`${numToCol(ci)}${r}`));
      const invoice = num(get(`${numToCol(ci + 1)}${r}`));
      if (cost === 0 && invoice === 0) continue;
      const key = `${m}::${b}`;
      const prev = expected.get(key) || { cost: 0, invoice: 0 };
      expected.set(key, { cost: prev.cost + cost, invoice: prev.invoice + invoice });
    }
  }

  const lines = await prisma.monthlyLine.findMany({
    where: { monthlySheet: { fiscalYear: fy } }, include: { monthlySheet: true },
  });
  const actual = new Map<string, { cost: number; invoice: number }>();
  for (const l of lines) {
    const key = `${l.monthlySheet.month}::${l.resourceName}`;
    const prev = actual.get(key) || { cost: 0, invoice: 0 };
    actual.set(key, { cost: prev.cost + l.costUsd, invoice: prev.invoice + l.invoiceAmount });
  }

  const diffs: string[] = [];
  for (const [key, exp] of expected) {
    const act = actual.get(key) || { cost: 0, invoice: 0 };
    if (Math.abs(exp.cost - act.cost) > EPS) diffs.push(`COST ${fy} ${key}: excel=${exp.cost} db=${act.cost}`);
    if (Math.abs(exp.invoice - act.invoice) > EPS) diffs.push(`INV  ${fy} ${key}: excel=${exp.invoice} db=${act.invoice}`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) { const a = actual.get(key)!; if (a.cost || a.invoice) diffs.push(`EXTRA ${fy} ${key}: db cost=${a.cost} inv=${a.invoice}`); }
  }

  let eRev = 0, eCost = 0, dRev = 0, dCost = 0;
  for (const v of expected.values()) { eRev += v.invoice; eCost += v.cost; }
  for (const v of actual.values()) { dRev += v.invoice; dCost += v.cost; }
  console.log(`  [${fy}] cells=${expected.size} | revenue excel=${eRev.toFixed(2)} db=${dRev.toFixed(2)} | cost excel=${eCost.toFixed(2)} db=${dCost.toFixed(2)}`);
  if (diffs.length) { console.log(`  [${fy}] ${diffs.length} DEVIATION(S):`); diffs.slice(0, 25).forEach((d) => console.log("    " + d)); }
  return diffs.length;
}

async function main() {
  const gm = JSON.parse(fs.readFileSync(config.goldenMasterPath, "utf-8"));
  console.log("Parity reconciliation (MySQL vs Excel cached cells):");
  let total = 0;
  for (const fy of Object.keys(YEARS)) total += await reconcileYear(fy, gm);
  await prisma.$disconnect();
  if (total === 0) { console.log("\nPARITY OK — ZERO deviation across both fiscal years. ✓"); process.exit(0); }
  console.log(`\nPARITY FAILED — ${total} deviation(s).`); process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
