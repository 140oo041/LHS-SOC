import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/domain";

// The session is whatever the current test says it is. lib/authz calls
// auth() only once a provider and a secret are configured, which every test
// below does.
let sessionEmail: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (sessionEmail ? { user: { email: sessionEmail, name: "Test Person" } } : null) }));

const { currentActor, requireActor } = await import("@/lib/authz");
const { listMembers, resolveAccess, revokeMember, setMemberRole, commaList, MemberChangeError } = await import("@/lib/roles");

const GUARDED = [
  "NODE_ENV",
  "DATABASE_URL",
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "ATLAS_ADMIN_EMAILS",
  "ATLAS_EDITOR_EMAILS",
  "ATLAS_ALLOWED_EMAILS",
  "ATLAS_ALLOWED_EMAIL_DOMAINS",
  "ATLAS_PUBLIC_ACCESS",
  "ATLAS_DEMO_AUTH",
] as const;

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(GUARDED.map((key) => [key, env[key]]));
  for (const key of GUARDED) delete env[key];
  env.NODE_ENV = "production";
  env.AUTH_SECRET = "secret";
  env.AUTH_GOOGLE_ID = "id";
  env.AUTH_GOOGLE_SECRET = "secret";
  env.ATLAS_ADMIN_EMAILS = "lead@example.com";
  env.ATLAS_ALLOWED_EMAIL_DOMAINS = "example.com";
  globalThis.__atlasMembers = new Map();
  globalThis.__atlasAudit = [];
  sessionEmail = null;
});

afterEach(() => {
  for (const key of GUARDED) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

const lead: Actor = { email: "lead@example.com", name: "Lead", role: "admin" };

describe("access precedence", () => {
  const policy = {
    bootstrapAdmins: commaList("boot@example.com"),
    envEditors: commaList("rtl@example.com"),
    envAllowed: commaList("guest@other.test"),
    allowedDomains: commaList("example.com"),
    localDevelopment: false,
  };

  it.each([
    ["a bootstrap admin, whatever the membership says", "BOOT@example.com", { role: "viewer", revoked: true }, { admitted: true, role: "admin", source: "bootstrap" }],
    ["a revoked member of an allowed domain", "pat@example.com", { role: "editor", revoked: true }, { admitted: false, source: "revoked" }],
    ["a member", "pat@example.com", { role: "editor", revoked: false }, { admitted: true, role: "editor", source: "membership" }],
    ["a member who outranks the environment list", "rtl@example.com", { role: "viewer", revoked: false }, { admitted: true, role: "viewer", source: "membership" }],
    ["an environment editor", "rtl@example.com", null, { admitted: true, role: "editor", source: "environment" }],
    ["an allowlisted outsider", "guest@other.test", null, { admitted: true, role: "viewer", source: "environment" }],
    ["someone from an allowed domain", "pat@example.com", null, { admitted: true, role: "viewer", source: "domain" }],
    ["someone from elsewhere", "pat@elsewhere.test", null, { admitted: false, source: "none" }],
  ] as const)("resolves %s", (_label, email, membership, expected) => {
    expect(resolveAccess(email, policy, membership)).toMatchObject(expected);
  });

  it("admits nobody unknown when no domain decision has been made", () => {
    expect(resolveAccess("pat@example.com", { ...policy, allowedDomains: new Set() }, null).admitted).toBe(false);
    expect(resolveAccess("pat@example.com", { ...policy, allowedDomains: new Set(), localDevelopment: true }, null).admitted).toBe(true);
    // Local demo accounts carry their own roles, below a membership the People panel set.
    const demo = { ...policy, localDevelopment: true, demoRoles: new Map([["rtl@atlas.local", "editor" as const]]) };
    expect(resolveAccess("rtl@atlas.local", demo, null)).toMatchObject({ admitted: true, role: "editor" });
    expect(resolveAccess("rtl@atlas.local", demo, { role: "viewer", revoked: false }).role).toBe("viewer");
  });
});

describe("roles take effect on the next request", () => {
  it("promotes, demotes, and revokes without a new session", async () => {
    sessionEmail = "pat@example.com";
    expect((await currentActor())?.role).toBe("viewer");

    await setMemberRole(lead, "Pat@Example.com", "editor");
    expect((await currentActor())?.role).toBe("editor");
    expect((await requireActor(["admin", "editor"])).response).toBeNull();

    await setMemberRole(lead, "pat@example.com", "viewer");
    expect((await requireActor(["admin", "editor"])).response?.status).toBe(403);

    await revokeMember(lead, "pat@example.com");
    expect(await currentActor()).toBeNull();
    expect((await requireActor()).response?.status).toBe(401);

    await setMemberRole(lead, "pat@example.com", "viewer");
    expect((await currentActor())?.role).toBe("viewer");
  });

  it("admits an invited person from outside the allowed domains", async () => {
    sessionEmail = "contractor@other.test";
    expect(await currentActor()).toBeNull();
    await setMemberRole(lead, "contractor@other.test", "editor");
    expect((await currentActor())?.role).toBe("editor");
  });
});

describe("member changes", () => {
  it("cannot change a bootstrap admin", async () => {
    await expect(setMemberRole(lead, "lead@example.com", "viewer")).rejects.toBeInstanceOf(MemberChangeError);
    await expect(revokeMember(lead, "lead@example.com")).rejects.toThrow(/ATLAS_ADMIN_EMAILS/);
  });

  it("keeps at least one administrator", async () => {
    delete env.ATLAS_ADMIN_EMAILS;
    await setMemberRole(lead, "only@example.com", "admin");
    await expect(setMemberRole(lead, "only@example.com", "editor")).rejects.toThrow(/at least one administrator/);
    await setMemberRole(lead, "second@example.com", "admin");
    await setMemberRole(lead, "only@example.com", "editor");
  });

  it("lets non-admins be added and changed when no admin is a member", async () => {
    delete env.ATLAS_ADMIN_EMAILS;
    await setMemberRole(lead, "pat@example.com", "editor");
    await setMemberRole(lead, "pat@example.com", "viewer");
    await revokeMember(lead, "pat@example.com");
  });

  it("refuses the public visitor address", async () => {
    await expect(setMemberRole(lead, "public@atlas.invalid", "editor")).rejects.toThrow(/cannot be a member/);
  });

  it("lists bootstrap admins who have not signed in, and records an audit trail", async () => {
    await setMemberRole(lead, "pat@example.com", "editor");
    const members = await listMembers();
    expect(members.map((m) => [m.email, m.role, m.source])).toEqual([
      ["lead@example.com", "admin", "bootstrap"],
      ["pat@example.com", "editor", "membership"],
    ]);
    expect(globalThis.__atlasAudit?.[0]).toMatchObject({ actorEmail: "lead@example.com", action: "member.role", target: "pat@example.com" });
  });
});
