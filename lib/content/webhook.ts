import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks GitHub's `X-Hub-Signature-256` header: an HMAC-SHA256 of the raw
 * body under the webhook secret. Anything unsigned or mis-signed is refused,
 * since the webhook can expire caches and record merges.
 */
export function verifyGithubSignature(body: string, header: string | null, secret: string | undefined) {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "utf8");
  const provided = Buffer.from(header.slice("sha256=".length), "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

declare global {
  var __atlasDeliveries: Set<string> | undefined;
}

/** True the first time a delivery id is seen; GitHub retries deliveries. */
export async function firstDelivery(id: string, event: string) {
  const { hasDatabase, query } = await import("@/lib/db");
  if (!hasDatabase()) {
    globalThis.__atlasDeliveries ??= new Set();
    if (globalThis.__atlasDeliveries.has(id)) return false;
    globalThis.__atlasDeliveries.add(id);
    return true;
  }
  const result = await query("INSERT INTO webhook_deliveries (id, event) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [id, event]);
  return (result.rowCount ?? 0) > 0;
}

/** GitHub stops retrying after a few days, so older ids are not needed. */
export async function pruneDeliveries() {
  const { hasDatabase, query } = await import("@/lib/db");
  if (!hasDatabase()) return 0;
  const result = await query("DELETE FROM webhook_deliveries WHERE received_at < now() - interval '7 days'");
  return result.rowCount ?? 0;
}
