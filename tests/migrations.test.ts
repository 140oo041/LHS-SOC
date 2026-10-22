import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checksum, listMigrations, planMigrations } from "@/scripts/migrations-core.mjs";

function migration(version: string, name: string, sql = `SELECT ${version};`) {
  return { version, name, sql, checksum: checksum(sql) };
}

describe("migration planning", () => {
  it("returns every migration for an empty database", () => {
    const available = [migration("0001", "baseline"), migration("0002", "roles")];
    expect(planMigrations([], available).map((m) => m.version)).toEqual(["0001", "0002"]);
  });

  it("returns only the migrations that have not run", () => {
    const available = [migration("0001", "baseline"), migration("0002", "roles")];
    const applied = [{ version: "0001", name: "baseline", checksum: available[0].checksum }];
    expect(planMigrations(applied, available).map((m) => m.version)).toEqual(["0002"]);
  });

  it("refuses when an applied migration was edited", () => {
    const available = [migration("0001", "baseline", "SELECT 2;")];
    const applied = [{ version: "0001", name: "baseline", checksum: checksum("SELECT 1;") }];
    expect(() => planMigrations(applied, available)).toThrow(/changed after it was applied/);
  });

  it("refuses when an applied migration is missing from disk", () => {
    const applied = [{ version: "0001", name: "baseline", checksum: "x" }];
    expect(() => planMigrations(applied, [])).toThrow(/no longer on disk/);
  });

  it("refuses duplicate version numbers", () => {
    expect(() => planMigrations([], [migration("0001", "a"), migration("0001", "b")])).toThrow(/share a version/);
  });
});

describe("migration files", () => {
  it("rejects a file that does not follow the naming rule", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-migrations-"));
    await writeFile(path.join(dir, "add-roles.sql"), "SELECT 1;");
    await expect(listMigrations(dir)).rejects.toThrow(/NNNN_snake_case/);
  });

  it("reads the checked-in migrations in order", async () => {
    const migrations = await listMigrations(path.join(process.cwd(), "db", "migrations"));
    expect(migrations[0]).toMatchObject({ version: "0001", name: "baseline" });
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort());
  });
});
