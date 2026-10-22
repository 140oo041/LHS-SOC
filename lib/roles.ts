import { cache } from "react";
import { demoAuthEnabled, isLocalDevelopment } from "@/lib/config";
import { DEMO_ACCOUNTS } from "@/lib/demo-accounts";
import { hasDatabase, query } from "@/lib/db";
import { PUBLIC_VISITOR_EMAIL, WORKSPACE_SLUG, type Actor, type Role } from "@/lib/domain";

/**
 * Who may sign in to Atlas, and with what role.
 *
 * Roles used to be read from environment lists once, at sign-in, and frozen
 * into an 8-hour session token, so changing one meant a redeploy followed by
 * waiting for the old token to expire. They now live in `memberships` and are
 * resolved on every request. The environment lists remain for bootstrapping:
 * ATLAS_ADMIN_EMAILS names administrators that the UI cannot demote, so a
 * workspace can never lose its last way back in.
 */

export type AccessSource = "bootstrap" | "membership" | "environment" | "domain" | "development" | "revoked" | "none";

export type Access = { admitted: boolean; role: Role; source: AccessSource };

export type AccessPolicy = {
  bootstrapAdmins: Set<string>;
  envEditors: Set<string>;
  envAllowed: Set<string>;
  allowedDomains: Set<string>;
  localDevelopment: boolean;
  /** The local demo accounts' roles; only set under ATLAS_DEMO_AUTH. */
  demoRoles?: Map<string, Role>;
};

export type MembershipState = { role: Role; revoked: boolean } | null;

export function commaList(value?: string) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function accessPolicyFromEnv(): AccessPolicy {
  return {
    bootstrapAdmins: commaList(process.env.ATLAS_ADMIN_EMAILS),
    envEditors: commaList(process.env.ATLAS_EDITOR_EMAILS),
    envAllowed: commaList(process.env.ATLAS_ALLOWED_EMAILS),
    allowedDomains: commaList(process.env.ATLAS_ALLOWED_EMAIL_DOMAINS),
    localDevelopment: isLocalDevelopment(),
    demoRoles: demoAuthEnabled() ? new Map(DEMO_ACCOUNTS.map((account) => [account.email, account.role])) : undefined,
  };
}

/**
 * The single precedence rule, kept pure so it can be tested as a table.
 *
 * 1. A bootstrap admin is always an admitted admin.
 * 2. A revoked membership denies, even if the domain is allowlisted.
 * 3. A membership grants its role.
 * 4. ATLAS_EDITOR_EMAILS grants editor (kept for existing deployments).
 * 5. ATLAS_ALLOWED_EMAILS or an allowlisted domain admits as viewer.
 *
 * An empty domain allowlist means no decision has been made, which is not the
 * same as admitting everyone; only a developer's own machine treats it so.
 */
export function resolveAccess(email: string, policy: AccessPolicy, membership: MembershipState): Access {
  const normalized = normalizeEmail(email);
  if (policy.bootstrapAdmins.has(normalized)) return { admitted: true, role: "admin", source: "bootstrap" };
  if (membership?.revoked) return { admitted: false, role: "viewer", source: "revoked" };
  if (membership) return { admitted: true, role: membership.role, source: "membership" };
  const demoRole = policy.demoRoles?.get(normalized);
  if (demoRole) return { admitted: true, role: demoRole, source: "development" };
  if (policy.envEditors.has(normalized)) return { admitted: true, role: "editor", source: "environment" };
  if (policy.envAllowed.has(normalized)) return { admitted: true, role: "viewer", source: "environment" };
  if (policy.allowedDomains.size) {
    const domain = normalized.split("@")[1];
    if (domain && policy.allowedDomains.has(domain)) return { admitted: true, role: "viewer", source: "domain" };
    return { admitted: false, role: "viewer", source: "none" };
  }
  if (policy.localDevelopment) return { admitted: true, role: "viewer", source: "development" };
  return { admitted: false, role: "viewer", source: "none" };
}

type MemoryMember = {
  email: string;
  name: string;
  role: Role | null;
  revokedAt: string | null;
  grantedBy: string | null;
  updatedAt: string;
  lastSignInAt: string | null;
};

type MemoryAudit = { actorEmail: string; action: string; target: string | null; details: Record<string, unknown>; createdAt: string };

declare global {
  var __atlasMembers: Map<string, MemoryMember> | undefined;
  var __atlasAudit: MemoryAudit[] | undefined;
}

function memoryMembers() {
  globalThis.__atlasMembers ??= new Map();
  return globalThis.__atlasMembers;
}

function memoryAudit() {
  globalThis.__atlasAudit ??= [];
  return globalThis.__atlasAudit;
}

const now = () => new Date().toISOString();

async function membershipFor(email: string): Promise<MembershipState> {
  if (!hasDatabase()) {
    const member = memoryMembers().get(email);
    if (!member || (!member.role && !member.revokedAt)) return null;
    return { role: member.role ?? "viewer", revoked: Boolean(member.revokedAt) };
  }
  const result = await query<{ role: Role; revoked_at: Date | null }>(
    `SELECT m.role, m.revoked_at FROM memberships m
     JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
     WHERE lower(u.email) = $1 AND w.slug = $2`,
    [email, WORKSPACE_SLUG],
  );
  const row = result.rows[0];
  return row ? { role: row.role, revoked: Boolean(row.revoked_at) } : null;
}

/**
 * The access a signed-in email has right now. Memoised per request, so one
 * page render costs at most one indexed query however many times it asks.
 */
export const lookupAccess = cache(async (email: string): Promise<Access> => {
  const normalized = normalizeEmail(email);
  return resolveAccess(normalized, accessPolicyFromEnv(), await membershipFor(normalized));
});

/** Records a successful sign-in, which is what puts a person on the member list. */
export async function recordSignIn(person: { email: string; name?: string | null; image?: string | null }) {
  const email = normalizeEmail(person.email);
  const name = person.name || email.split("@")[0];
  if (!hasDatabase()) {
    const existing = memoryMembers().get(email);
    memoryMembers().set(email, {
      email,
      name,
      role: existing?.role ?? null,
      revokedAt: existing?.revokedAt ?? null,
      grantedBy: existing?.grantedBy ?? null,
      updatedAt: existing?.updatedAt ?? now(),
      lastSignInAt: now(),
    });
    return;
  }
  await query(
    `INSERT INTO users (email, name, avatar_url, last_sign_in_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_sign_in_at = now()`,
    [email, name, person.image ?? null],
  );
}

export type Member = {
  email: string;
  name: string;
  role: Role;
  admitted: boolean;
  source: AccessSource;
  lastSignInAt: string | null;
};

/**
 * Everyone who has signed in or been granted a role, plus bootstrap admins
 * who have not signed in yet, each with the access they would get now.
 */
export async function listMembers(): Promise<Member[]> {
  const policy = accessPolicyFromEnv();
  const rows: Array<{ email: string; name: string; membership: MembershipState; lastSignInAt: string | null }> = [];

  if (!hasDatabase()) {
    for (const member of memoryMembers().values()) {
      rows.push({
        email: member.email,
        name: member.name,
        membership: member.role || member.revokedAt ? { role: member.role ?? "viewer", revoked: Boolean(member.revokedAt) } : null,
        lastSignInAt: member.lastSignInAt,
      });
    }
  } else {
    const result = await query<{ email: string; name: string; role: Role | null; revoked_at: Date | null; last_sign_in_at: Date | null }>(
      `SELECT u.email, u.name, m.role, m.revoked_at, u.last_sign_in_at
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
         AND m.workspace_id = (SELECT id FROM workspaces WHERE slug = $1)
       WHERE u.email <> $2
       ORDER BY u.email`,
      [WORKSPACE_SLUG, PUBLIC_VISITOR_EMAIL],
    );
    for (const row of result.rows) {
      rows.push({
        email: normalizeEmail(row.email),
        name: row.name,
        membership: row.role ? { role: row.role, revoked: Boolean(row.revoked_at) } : null,
        lastSignInAt: row.last_sign_in_at ? row.last_sign_in_at.toISOString() : null,
      });
    }
  }

  const known = new Set(rows.map((row) => row.email));
  for (const email of policy.bootstrapAdmins) {
    if (!known.has(email)) rows.push({ email, name: email.split("@")[0], membership: null, lastSignInAt: null });
  }

  return rows
    .map((row) => {
      const access = resolveAccess(row.email, policy, row.membership);
      return { email: row.email, name: row.name, role: access.role, admitted: access.admitted, source: access.source, lastSignInAt: row.lastSignInAt };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

export class MemberChangeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

/**
 * Refuses a change that would leave the workspace with no administrator.
 *
 * Bootstrap admins cannot be changed from the UI at all, so when any exist
 * the workspace always has one; this guard matters only for a workspace
 * whose admins were all granted through memberships.
 */
async function assertAdminRemains(changingEmail: string, nextRole: Role | null) {
  if (nextRole === "admin") return;
  const members = await listMembers();
  // Changing someone who is not an admin cannot reduce the admin count.
  const current = members.find((member) => member.email === changingEmail);
  if (!current?.admitted || current.role !== "admin") return;
  const remaining = members.filter((member) => member.admitted && member.role === "admin" && member.email !== changingEmail);
  if (!remaining.length) throw new MemberChangeError("Atlas needs at least one administrator. Make someone else an admin first.", 409);
}

function assertChangeable(email: string) {
  if (email === PUBLIC_VISITOR_EMAIL || email.endsWith(".invalid")) {
    throw new MemberChangeError("That address cannot be a member.", 400);
  }
  if (accessPolicyFromEnv().bootstrapAdmins.has(email)) {
    throw new MemberChangeError("This administrator is set by ATLAS_ADMIN_EMAILS and can only be changed there.", 409);
  }
}

/** Grants a role, adding the person if needed and lifting any revocation. */
export async function setMemberRole(actor: Actor, rawEmail: string, role: Role) {
  const email = normalizeEmail(rawEmail);
  assertChangeable(email);
  await assertAdminRemains(email, role);

  if (!hasDatabase()) {
    const existing = memoryMembers().get(email);
    memoryMembers().set(email, {
      email,
      name: existing?.name ?? email.split("@")[0],
      role,
      revokedAt: null,
      grantedBy: actor.email,
      updatedAt: now(),
      lastSignInAt: existing?.lastSignInAt ?? null,
    });
  } else {
    await query(
      `WITH person AS (
         INSERT INTO users (email, name) VALUES ($1, split_part($1, '@', 1))
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id
       ), granter AS (SELECT id FROM users WHERE lower(email) = $3)
       INSERT INTO memberships (user_id, workspace_id, role, granted_by, updated_at, revoked_at)
       SELECT person.id, w.id, $2, (SELECT id FROM granter), now(), NULL FROM person, workspaces w WHERE w.slug = $4
       ON CONFLICT (user_id, workspace_id) DO UPDATE
         SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now(), revoked_at = NULL`,
      [email, role, normalizeEmail(actor.email), WORKSPACE_SLUG],
    );
  }
  await recordAudit(actor, "member.role", email, { role });
}

/** Denies sign-in from the next request on, whatever the allowlists say. */
export async function revokeMember(actor: Actor, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  assertChangeable(email);
  await assertAdminRemains(email, null);

  if (!hasDatabase()) {
    const existing = memoryMembers().get(email);
    memoryMembers().set(email, {
      email,
      name: existing?.name ?? email.split("@")[0],
      role: existing?.role ?? "viewer",
      revokedAt: now(),
      grantedBy: actor.email,
      updatedAt: now(),
      lastSignInAt: existing?.lastSignInAt ?? null,
    });
  } else {
    await query(
      `WITH person AS (
         INSERT INTO users (email, name) VALUES ($1, split_part($1, '@', 1))
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id
       ), granter AS (SELECT id FROM users WHERE lower(email) = $2)
       INSERT INTO memberships (user_id, workspace_id, role, granted_by, updated_at, revoked_at)
       SELECT person.id, w.id, 'viewer', (SELECT id FROM granter), now(), now() FROM person, workspaces w WHERE w.slug = $3
       ON CONFLICT (user_id, workspace_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, updated_at = now(), revoked_at = now()`,
      [email, normalizeEmail(actor.email), WORKSPACE_SLUG],
    );
  }
  await recordAudit(actor, "member.revoke", email);
}

export async function recordAudit(actor: Actor, action: string, target: string | null, details: Record<string, unknown> = {}) {
  if (!hasDatabase()) {
    memoryAudit().unshift({ actorEmail: actor.email, action, target, details, createdAt: now() });
    return;
  }
  await query(
    `INSERT INTO audit_events (workspace_id, actor_email, action, target, details)
     SELECT id, $2, $3, $4, $5 FROM workspaces WHERE slug = $1`,
    [WORKSPACE_SLUG, actor.email, action, target, JSON.stringify(details)],
  );
}

export async function listAuditEvents(limit = 50): Promise<MemoryAudit[]> {
  if (!hasDatabase()) return memoryAudit().slice(0, limit);
  const result = await query<{ actor_email: string; action: string; target: string | null; details: Record<string, unknown>; created_at: Date }>(
    `SELECT a.actor_email, a.action, a.target, a.details, a.created_at FROM audit_events a
     JOIN workspaces w ON w.id = a.workspace_id WHERE w.slug = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [WORKSPACE_SLUG, limit],
  );
  return result.rows.map((row) => ({
    actorEmail: row.actor_email,
    action: row.action,
    target: row.target,
    details: row.details,
    createdAt: row.created_at.toISOString(),
  }));
}
