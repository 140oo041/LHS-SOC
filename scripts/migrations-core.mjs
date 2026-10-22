import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Pure migration bookkeeping, kept apart from the runner so it can be tested
 * without a database.
 *
 * A migration is a file named `NNNN_snake_case.sql`. Once applied, a file is
 * immutable: its checksum is recorded, and a later edit is reported rather
 * than silently diverging from what the database actually ran.
 */
export const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

export async function listMigrations(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const migrations = [];
  for (const name of names) {
    const match = name.match(MIGRATION_FILENAME);
    if (!match) throw new Error(`Migration ${name} does not match NNNN_snake_case.sql`);
    const sql = await readFile(path.join(dir, name), "utf8");
    migrations.push({ version: match[1], name: match[2], sql, checksum: checksum(sql) });
  }
  return migrations;
}

/**
 * Which available migrations still need to run.
 *
 * `applied` is what schema_migrations records; `available` is what is on
 * disk. Throws when the two disagree about history, because applying more on
 * top of a database that ran something else is how schemas quietly drift.
 */
export function planMigrations(applied, available) {
  const byVersion = new Map(available.map((migration) => [migration.version, migration]));
  const seen = new Set();

  for (const record of applied) {
    const migration = byVersion.get(record.version);
    if (!migration) {
      throw new Error(`Migration ${record.version}_${record.name} was applied but is no longer on disk`);
    }
    if (migration.checksum !== record.checksum) {
      throw new Error(
        `Migration ${record.version}_${record.name} changed after it was applied. ` +
          "Add a new migration instead of editing an applied one.",
      );
    }
    seen.add(record.version);
  }

  const versions = available.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length) throw new Error("Two migrations share a version number");

  return available.filter((migration) => !seen.has(migration.version));
}
