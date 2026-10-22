import { createHash } from "node:crypto";
import { hasDatabase, query } from "@/lib/db";

/**
 * A monthly ceiling on AI spend, enforced before each paid request.
 *
 * Rate limits bound how fast one person can spend; this bounds how much the
 * whole workspace can. A request is reserved before it is sent and refused
 * once the month's request count or estimated cost reaches its limit. Cost is
 * estimated from token usage and the prices configured below, so set a hard
 * budget on the provider's own dashboard as well: this is the inner fence,
 * that is the outer one.
 */

export type AiKind = "chat" | "image" | "ingest";

export type AiUsage = { model?: string; inputTokens?: number; outputTokens?: number; toolCalls?: number; images?: number };

type MemoryMonth = { requests: number; costMicros: number };

declare global {
  var __atlasAiUsage: Map<string, MemoryMonth> | undefined;
}

const price = (name: string) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
};

export function aiBudget() {
  return {
    monthlyRequests: Math.floor(price("ATLAS_AI_MONTHLY_REQUEST_LIMIT")),
    monthlyMicros: Math.round(price("ATLAS_AI_MONTHLY_BUDGET_USD") * 1_000_000),
  };
}

/** Estimated cost in millionths of a dollar. */
export function estimateCostMicros(usage: AiUsage) {
  const usd =
    ((usage.inputTokens ?? 0) / 1_000_000) * price("ATLAS_AI_PRICE_INPUT_PER_MTOK") +
    ((usage.outputTokens ?? 0) / 1_000_000) * price("ATLAS_AI_PRICE_OUTPUT_PER_MTOK") +
    ((usage.toolCalls ?? 0) / 1000) * price("ATLAS_AI_PRICE_FILE_SEARCH_PER_1K") +
    (usage.images ?? 0) * price("ATLAS_AI_PRICE_IMAGE_EACH");
  return Math.round(usd * 1_000_000);
}

const monthKey = () => new Date().toISOString().slice(0, 7);

/** Claims one request against this month's budget, or refuses. */
export async function reserveAiRequest(): Promise<boolean> {
  const { monthlyRequests, monthlyMicros } = aiBudget();
  if (monthlyRequests <= 0 || monthlyMicros <= 0) return false;
  if (!hasDatabase()) {
    globalThis.__atlasAiUsage ??= new Map();
    const month = globalThis.__atlasAiUsage.get(monthKey()) ?? { requests: 0, costMicros: 0 };
    if (month.requests >= monthlyRequests || month.costMicros >= monthlyMicros) return false;
    month.requests += 1;
    globalThis.__atlasAiUsage.set(monthKey(), month);
    return true;
  }
  // One statement, so concurrent requests cannot both take the last slot.
  const result = await query(
    `INSERT INTO ai_usage_months (month, requests) VALUES (date_trunc('month', now())::date, 1)
     ON CONFLICT (month) DO UPDATE SET requests = ai_usage_months.requests + 1
     WHERE ai_usage_months.requests < $1 AND ai_usage_months.cost_micros < $2
     RETURNING requests`,
    [monthlyRequests, monthlyMicros],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function recordAiUsage(kind: AiKind, actorEmail: string, usage: AiUsage) {
  const costMicros = estimateCostMicros(usage);
  if (!hasDatabase()) {
    globalThis.__atlasAiUsage ??= new Map();
    const month = globalThis.__atlasAiUsage.get(monthKey()) ?? { requests: 0, costMicros: 0 };
    month.costMicros += costMicros;
    globalThis.__atlasAiUsage.set(monthKey(), month);
    return costMicros;
  }
  const actorHash = createHash("sha256").update(`atlas-usage:${actorEmail.toLowerCase()}`).digest("hex").slice(0, 32);
  await query(
    `WITH event AS (
       INSERT INTO ai_usage_events (actor_hash, kind, model, input_tokens, output_tokens, tool_calls, cost_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
     )
     INSERT INTO ai_usage_months (month, cost_micros) VALUES (date_trunc('month', now())::date, $7)
     ON CONFLICT (month) DO UPDATE SET cost_micros = ai_usage_months.cost_micros + EXCLUDED.cost_micros`,
    [actorHash, kind, usage.model ?? null, usage.inputTokens ?? null, usage.outputTokens ?? null, usage.toolCalls ?? null, costMicros],
  );
  return costMicros;
}

export async function aiUsageThisMonth(): Promise<MemoryMonth> {
  if (!hasDatabase()) return globalThis.__atlasAiUsage?.get(monthKey()) ?? { requests: 0, costMicros: 0 };
  const result = await query<{ requests: number; cost_micros: string }>(
    "SELECT requests, cost_micros FROM ai_usage_months WHERE month = date_trunc('month', now())::date",
  );
  const row = result.rows[0];
  return row ? { requests: Number(row.requests), costMicros: Number(row.cost_micros) } : { requests: 0, costMicros: 0 };
}
