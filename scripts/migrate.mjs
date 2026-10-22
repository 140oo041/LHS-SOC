import path from "node:path";
import process from "node:process";
import pg from "pg";
import { listMigrations, planMigrations } from "./migrations-core.mjs";
import { sslConfig } from "./ssl-config.mjs";

// Usage: node scripts/migrate.mjs [--check] [--if-production]
//
//   --check          Report pending migrations and exit 1 if there are any.
//   --if-production  Do nothing unless VERCEL_ENV is "production", so preview
//                    builds never migrate the production database.
const args = new Set(process.argv.slice(2));

if (args.has("--if-production") && process.env.VERCEL_ENV !== "production") {
  process.stdout.write("Skipping migrations: not a production deployment.\n");
  process.exit(0);
}

// The pooled URL runs through PgBouncer in transaction mode, which cannot
// hold the session-level advisory lock taken below.
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  if (args.has("--if-production")) {
    process.stdout.write("Skipping migrations: DATABASE_URL is not set.\n");
    process.exit(0);
  }
  throw new Error("DATABASE_URL is required to migrate the Atlas database");
}

const client = new pg.Client({ connectionString, ssl: sslConfig(connectionString) });
await client.connect();

try {
  // Two deploys migrating at once would race on the same files.
  await client.query("SELECT pg_advisory_lock(hashtext('atlas_migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = (await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version")).rows;
  const available = await listMigrations(path.join(process.cwd(), "db", "migrations"));
  const pending = planMigrations(applied, available);

  if (args.has("--check")) {
    if (pending.length) {
      process.stdout.write(`Pending migrations:\n${pending.map((m) => `  ${m.version}_${m.name}`).join("\n")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("Atlas database schema is current.\n");
    }
  } else {
    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query("COMMIT");
        process.stdout.write(`Applied ${migration.version}_${migration.name}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    process.stdout.write(pending.length ? "Atlas database schema is current.\n" : "No pending migrations.\n");
  }
} finally {
  await client.end();
}
