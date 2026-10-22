/**
 * TLS options for a Postgres connection string.
 *
 * Shared by lib/db.ts and scripts/migrate.mjs so the app and its migrations
 * cannot disagree about whether certificates are checked.
 *
 * pg merges the parsed URL over the config object, so when the URL names an
 * `sslmode` it wins regardless of what is returned here; returning undefined
 * in that case just makes that explicit. Otherwise a remote database gets
 * full certificate verification. Managed hosts such as Neon present publicly
 * trusted certificates, so no CA bundle is needed; DATABASE_CA_CERT exists for
 * a host that uses a private one.
 */
export function sslConfig(connectionString, env = process.env) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  if (url.searchParams.has("sslmode")) return undefined;
  if (env.DATABASE_SSL === "disable") return false;
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return false;
  return { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}) };
}

/**
 * Why a connection string is unsafe to use outside local development, if it is.
 *
 * `sslmode=disable` sends credentials in clear text, and `no-verify` accepts
 * any certificate, which is the same thing against an active attacker.
 */
export function insecureSslReason(connectionString, env = process.env) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return "DATABASE_URL is not a valid URL.";
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (local) return null;
  const mode = url.searchParams.get("sslmode");
  if (mode === "disable" || mode === "no-verify") {
    return `DATABASE_URL uses sslmode=${mode}. Use sslmode=verify-full, or omit sslmode.`;
  }
  // Under libpq semantics, prefer and require encrypt without checking who
  // is on the other end. pg only applies those semantics when asked to.
  if (url.searchParams.get("uselibpqcompat") === "true" && (mode === "prefer" || mode === "require")) {
    return `DATABASE_URL uses sslmode=${mode} with uselibpqcompat=true, which skips certificate checks. Use sslmode=verify-full.`;
  }
  if (env.DATABASE_SSL === "disable") return "DATABASE_SSL=disable is set for a remote database. Remove it.";
  return null;
}
