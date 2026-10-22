export type Migration = { version: string; name: string; sql: string; checksum: string };
export type AppliedMigration = { version: string; name: string; checksum: string };

export const MIGRATION_FILENAME: RegExp;
export function checksum(sql: string): string;
export function listMigrations(dir: string): Promise<Migration[]>;
export function planMigrations(applied: AppliedMigration[], available: Migration[]): Migration[];
