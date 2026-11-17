// Thin Anthropic Messages API client (no SDK dependency — uses global fetch).
// The API key + model are resolved from the DB (Settings → AI Report) first, then
// falling back to the ANTHROPIC_API_KEY / ANTHROPIC_MODEL environment variables.
// Storing the key in the Integration table mirrors how Tally/BoA creds are kept.
import { prisma } from "../prisma";

export const ANTHROPIC_PROVIDER = "ANTHROPIC";
export const DEFAULT_MODEL = "claude-opus-4-8";

// Models offered in the Settings dropdown. Labels are advisory only.
export const AVAILABLE_MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest / cheapest" },
];

export interface AiConfig { apiKey: string | null; model: string; source: "db" | "env" | "none"; }

/** Resolve the effective API key + model. DB override wins; else env; else none. */
export async function resolveAiConfig(): Promise<AiConfig> {
  const row = await prisma.integration.findUnique({ where: { provider: ANTHROPIC_PROVIDER } }).catch(() => null);
  const cfg = (row?.authConfig as any) || {};
  const dbKey = typeof cfg.apiKey === "string" && cfg.apiKey.trim() ? cfg.apiKey.trim() : null;
  const dbModel = typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : null;
  const envKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  const envModel = process.env.ANTHROPIC_MODEL?.trim() || null;
  const apiKey = dbKey || envKey;
  const model = dbModel || envModel || DEFAULT_MODEL;
  return { apiKey, model, source: dbKey ? "db" : envKey ? "env" : "none" };
}

export interface AnthropicTool { name: string; description: string; input_schema: any; }
export type AnthropicMessage = { role: "user" | "assistant"; content: any };

export interface MessagesRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: any;
  max_tokens?: number;
}

/** One round-trip to POST /v1/messages. Throws a friendly error on failure. */
export async function callMessages(apiKey: string, req: MessagesRequest): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ max_tokens: 2048, ...req }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = data?.error?.message || `Anthropic API error ${res.status}`;
    const e: any = new Error(msg);
    e.status = res.status === 401 ? 400 : 502; // surface bad-key as 400 to the admin
    throw e;
  }
  return data;
}
