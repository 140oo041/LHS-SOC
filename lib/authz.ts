import { cookies } from "next/headers";
import { auth } from "@/auth";
import {
  demoAuthEnabled,
  deploymentIsMisconfigured,
  publicReadAccessEnabled,
  signInAvailable,
} from "@/lib/config";
import { PUBLIC_VISITOR_EMAIL, type Actor, type Role } from "@/lib/domain";
import { DEMO_ACCOUNT_COOKIE, DEMO_ACCOUNTS } from "@/lib/demo-accounts";
import { lookupAccess, normalizeEmail } from "@/lib/roles";

export async function currentActor(): Promise<Actor | null> {
  // A deployment whose sign-in is half-configured denies everyone rather than
  // falling through to one of the actors below.
  if (deploymentIsMisconfigured()) return null;

  // Skipped entirely when no provider and no secret exist: next-auth would
  // log MissingSecret on every request of an otherwise healthy public site.
  if (signInAvailable()) {
    const session = await auth();
    if (session?.user?.email) {
      // Re-checked on every request: a revoked person is signed out from
      // their next request, whatever their session token says.
      const access = await lookupAccess(session.user.email);
      if (!access.admitted) return null;
      return {
        email: normalizeEmail(session.user.email),
        name: session.user.name ?? session.user.email.split("@")[0],
        image: session.user.image,
        role: access.role,
      };
    }
  }

  if (demoAuthEnabled()) {
    // Which local demo person this browser is being; the account menu switches it.
    const chosen = (await cookies()).get(DEMO_ACCOUNT_COOKIE)?.value;
    const account = DEMO_ACCOUNTS.find((item) => item.email === chosen) ?? DEMO_ACCOUNTS[0];
    const access = await lookupAccess(account.email);
    if (!access.admitted) return null;
    return { email: account.email, name: account.name, role: access.role };
  }

  // Public read access. `viewer` is what makes this safe: every mutating
  // route requires admin or editor, so a visitor can read everything and
  // change nothing.
  if (publicReadAccessEnabled()) {
    return {
      email: PUBLIC_VISITOR_EMAIL,
      name: "Public visitor",
      role: "viewer",
    };
  }

  return null;
}

/** True for the anonymous actor that public read access produces. */
export function isPublicVisitor(actor: Actor | null) {
  return actor?.email === PUBLIC_VISITOR_EMAIL;
}

export async function requireActor(allowed: Role[] = ["admin", "editor", "viewer"]) {
  const actor = await currentActor();
  if (!actor) return { actor: null, response: Response.json({ error: "Authentication required" }, { status: 401 }) };
  if (!allowed.includes(actor.role)) {
    return { actor: null, response: Response.json({ error: "Insufficient permission" }, { status: 403 }) };
  }
  return { actor, response: null };
}
