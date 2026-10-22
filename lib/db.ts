import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { sslConfig } from "@/scripts/ssl-config.mjs";

declare global {
  var __atlasPool: Pool | undefined;
}

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!globalThis.__atlasPool) {
    // Serverless instances each hold their own pool, so keep it small; the
    // pooled (PgBouncer) URL multiplexes them. The connection timeout leaves
    // room for a scaled-to-zero Neon compute to wake up.
    globalThis.__atlasPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslConfig(process.env.DATABASE_URL),
    });
  }
  return globalThis.__atlasPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
