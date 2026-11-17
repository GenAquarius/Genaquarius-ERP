import { Router } from "express";
import { prisma } from "../../prisma";
import { requireAdmin } from "../../auth/auth";
import { requirePermission } from "../../engine/permissions";
import { getFinancePnl } from "../../engine/calc";
import {
  ANTHROPIC_PROVIDER, AVAILABLE_MODELS, DEFAULT_MODEL,
  resolveAiConfig, callMessages,
} from "../../engine/anthropic";
import {
  DATA_TOOLS, RENDER_REPORT_TOOL, UNSUPPORTED_TOOL, buildSystemPrompt,
} from "../../engine/aiTools";

const router = Router();
router.use(requireAdmin); // AI reports are admin-tier only
// /config is also used by the Settings page's embedded AI Report panel (same ADMIN_ROLES
// audience as the "ai-report" page today, so gating the whole router here is zero-regression).
router.use(requirePermission("ai-report"));

// ---- Settings: API key + model (key is write-only; never returned) ----
router.get("/config", async (_req, res) => {
  const cfg = await resolveAiConfig();
  res.json({
    configured: !!cfg.apiKey,
    source: cfg.source,          // 'db' | 'env' | 'none'
    model: cfg.model,
    models: AVAILABLE_MODELS,
    defaultModel: DEFAULT_MODEL,
  });
});

router.put("/config", async (req, res) => {
  const { apiKey, model, clearKey } = req.body || {};
  const ex = await prisma.integration.findUnique({ where: { provider: ANTHROPIC_PROVIDER } });
  const cur = (ex?.authConfig as any) || {};
  const next: any = { ...cur };
  if (clearKey) delete next.apiKey;
  else if (typeof apiKey === "string" && apiKey.trim()) next.apiKey = apiKey.trim();
  if (typeof model === "string" && model.trim()) next.model = model.trim();
  await prisma.integration.upsert({
    where: { provider: ANTHROPIC_PROVIDER },
    update: { authConfig: next, status: next.apiKey ? "CONNECTED" : "DISCONNECTED" },
    create: { provider: ANTHROPIC_PROVIDER, authConfig: next, status: next.apiKey ? "CONNECTED" : "DISCONNECTED" },
  });
  const cfg = await resolveAiConfig();
  res.json({ ok: true, configured: !!cfg.apiKey, source: cfg.source, model: cfg.model });
});

// ---- Capabilities (what the assistant can build today) ----
router.get("/capabilities", async (_req, res) => {
  res.json({ tools: DATA_TOOLS.map((t) => ({ name: t.name, description: t.description })) });
});

// ---- State-wise revenue: deterministic (no LLM) — works for ANY fiscal year, even with no API key ----
// Same data as the get_revenue_by_state AI tool, formatted straight into the report spec the page renders.
router.get("/state-revenue", async (req, res) => {
  const fy = String(req.query.fy || "FY26-27");
  const month = String(req.query.month || "ALL");
  const tool = DATA_TOOLS.find((t) => t.name === "get_revenue_by_state")!;
  // READ-ONLY look at the Finance Dashboard's own numbers for the same FY/month, so this report's
  // headline numbers agree with it exactly. Nothing on the dashboard or Monthly Forecast is changed.
  const fin: any = await getFinancePnl(fy, month);
  const finAll: any = month === "ALL" ? fin : await getFinancePnl(fy, "ALL"); // full-year monthly arrays
  const d: any = await tool.run({ fy, month, alignRevenue: finAll.monthlyRevenue }, { fy });
  const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString("en-US");
  const states: any[] = d.states || [];
  const total = d.totals?.revenue || 0;
  const resourceCost = d.totals?.cost || 0;                       // sum of resource-line cost (what each state's cost is built from)
  const dashRevenue = fin.totalRevenue ?? total;
  const dashSalary = fin.totalSalary ?? 0;
  const dashCost = fin.totalCost ?? resourceCost;
  const dashProfit = fin.yearProfit ?? (dashRevenue - dashCost);
  const leftoverRev = dashRevenue - states.reduce((s: number, x: any) => s + x.revenue, 0);
  const overhead = dashCost - resourceCost;                      // overhead / expense lines not tied to a state
  const pctOf = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 + "%" : "—");
  const named = states.filter((s) => s.state !== "No state set");
  const missing: string[] = d.clientsWithoutState || [];
  const top = named[0];
  const insights: string[] = [];
  if (top && total) insights.push(`${top.state} is the largest state: ${usd(top.revenue)} (${Math.round((top.revenue / total) * 100)}% of ${fy} revenue) from ${top.clients.map((c: any) => c.client).join(", ")}.`);
  if (missing.length) insights.push(`${missing.length} client(s) have no State set and are grouped under "No state set": ${missing.join(", ")}. Set their State on the Clients page to place them correctly.`);
  if (!states.length) insights.push(`No customer revenue found for ${fy}${month !== "ALL" ? " / " + month : ""}.`);
  // How this report ties to the Finance Dashboard.
  insights.push(`Ties to the Finance Dashboard (${fy}): Revenue ${usd(dashRevenue)} − Total Cost ${usd(dashCost)} = Profit ${usd(dashProfit)}. Total Cost = resource cost ${usd(resourceCost)} (split by state below) + overhead / expense lines ${usd(overhead)} (not tied to any one state, shown as its own row).`);
  if (month === "ALL" && Math.abs(d.revenueAdjustment || 0) >= 1) insights.push(`Revenue in locked months follows the Finance Dashboard's saved figures: that changes ${fy} revenue by ${usd(d.revenueAdjustment)} versus adding up the invoice lines, shared across clients in proportion to their revenue in each of those months.`);
  if (Math.abs(dashSalary - resourceCost) > 1) insights.push(`The dashboard's Salary Expense card (${usd(dashSalary)}) differs from the resource cost used here (${usd(resourceCost)}) by ${usd(resourceCost - dashSalary)}. For locked months the dashboard shows the saved workbook figures rather than adding up the line costs; Total Cost and Revenue agree either way.`);
  res.json({
    spec: {
      title: `State-wise Revenue — ${fy}`,
      subtitle: `${d.scope} · each client's revenue is listed under the State set on the client · headline figures match the Finance Dashboard · amounts in USD`,
      kpis: [
        { label: "Revenue (Total Billing)", value: usd(dashRevenue) },
        { label: "Salary Expense", value: usd(dashSalary), sub: "as on Finance Dashboard" },
        { label: "Total Cost", value: usd(dashCost) },
        { label: "Profit", value: usd(dashProfit), sub: pctOf(dashProfit, dashRevenue) + " net" },
        { label: "States", value: String(named.length), sub: missing.length ? `+ ${missing.length} client(s) with no state` : undefined },
        { label: "Top State", value: top ? top.state : "—", sub: top ? usd(top.revenue) : undefined },
      ],
      charts: [
        { type: "bar", title: "Revenue by State", labels: states.map((s) => s.state), series: [{ name: "Revenue (USD)", data: states.map((s) => s.revenue) }] },
        { type: "doughnut", title: "Share of Revenue", labels: states.map((s) => s.state), series: [{ name: "Revenue", data: states.map((s) => s.revenue) }] },
      ],
      tables: [
        {
          title: "Revenue by State",
          columns: [{ key: "state", label: "State" }, { key: "clients", label: "Clients" }, { key: "revenue", label: "Revenue", num: true }, { key: "cost", label: "Resource Cost", num: true }, { key: "profit", label: "Profit (after resource cost)", num: true }, { key: "margin", label: "Margin", num: true }],
          rows: [
            ...states.map((s) => ({ state: s.state, clients: s.clients.map((c: any) => c.client).join(", "), revenue: usd(s.revenue), cost: usd(s.cost), profit: usd(s.profit), margin: s.margin + "%" })),
            // Any dashboard revenue that can't be tied to a client line (e.g. a locked month with no lines) — keeps the table adding up.
            ...(Math.abs(leftoverRev) >= 1 ? [{ state: "Other revenue (not tied to a client line)", clients: "", revenue: usd(leftoverRev), cost: usd(0), profit: usd(leftoverRev), margin: "" }] : []),
            // Overhead / expense lines aren't tied to a state — their own row so the table adds up to the dashboard.
            { state: "Overhead / expenses (not state-specific)", clients: "", revenue: usd(0), cost: usd(overhead), profit: usd(-overhead), margin: "" },
            { state: "TOTAL — matches Finance Dashboard", clients: "", revenue: usd(dashRevenue), cost: usd(dashCost), profit: usd(dashProfit), margin: pctOf(dashProfit, dashRevenue) },
          ],
        },
        {
          title: "Revenue by Client within State",
          columns: [{ key: "state", label: "State" }, { key: "client", label: "Client" }, { key: "projects", label: "Projects" }, { key: "revenue", label: "Revenue", num: true }],
          rows: states.flatMap((s) => s.clients.map((c: any) => ({ state: s.state, client: c.client, projects: (c.projects || []).join(", "), revenue: usd(c.revenue) }))),
        },
      ],
      insights,
    },
  });
});

// ---- The prompt → report endpoint (Claude tool-use loop) ----
router.post("/query", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const fy = String(req.body?.fy || "FY26-27");
  if (!prompt) return res.status(400).json({ error: "A prompt is required" });

  const { apiKey, model } = await resolveAiConfig();
  if (!apiKey) return res.status(400).json({ error: "Claude API key is not configured. Add it in Settings → AI Report." });

  const today = new Date().toISOString().slice(0, 10);
  const system = buildSystemPrompt(fy, today);
  const tools = [
    ...DATA_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    RENDER_REPORT_TOOL, UNSUPPORTED_TOOL,
  ];

  const messages: any[] = [{ role: "user", content: prompt }];
  const toolCalls: { name: string; input: any }[] = [];

  for (let step = 0; step < 6; step++) {
    const resp = await callMessages(apiKey, { model, system, messages, tools, max_tokens: 4096 });
    messages.push({ role: "assistant", content: resp.content });
    const toolUses = (resp.content || []).filter((c: any) => c.type === "tool_use");

    if (!toolUses.length) {
      // Model answered in prose without rendering — surface it as a narrative-only report.
      const text = (resp.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      return res.json({ spec: { title: "Report", narrative: text || "No result." }, toolCalls });
    }

    // Terminal: render_report → final spec
    const render = toolUses.find((t: any) => t.name === "render_report");
    if (render) return res.json({ spec: render.input, toolCalls });

    // Terminal: unsupported_request → graceful Tier-1 gap (logged for developers)
    const unsup = toolUses.find((t: any) => t.name === "unsupported_request");
    if (unsup) {
      await prisma.auditLog.create({
        data: {
          userId: req.user!.id, action: "AI_REPORT_GAP", entity: "AiReport",
          after: { prompt, ...(unsup.input || {}) },
        },
      }).catch(() => {});
      return res.json({ unsupported: { prompt, ...(unsup.input || {}) }, toolCalls });
    }

    // Otherwise execute the requested data tools and feed results back.
    const results: any[] = [];
    for (const tu of toolUses) {
      const tool = DATA_TOOLS.find((t) => t.name === tu.name);
      let content: string; let is_error = false;
      if (!tool) { content = JSON.stringify({ error: `Unknown tool ${tu.name}` }); is_error = true; }
      else {
        try { content = JSON.stringify(await tool.run(tu.input || {}, { fy })); toolCalls.push({ name: tu.name, input: tu.input }); }
        catch (e: any) { content = JSON.stringify({ error: e?.message || "Tool failed" }); is_error = true; }
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, ...(is_error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }

  return res.status(504).json({ error: "The assistant did not finish building the report (too many steps). Try a more specific prompt." });
});

export default router;
