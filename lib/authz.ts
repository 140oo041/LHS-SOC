import { auth } from "@/auth";
import { demoAuthEnabled, deploymentIsMisconfigured } from "@/lib/config";
import type { Actor, Role } from "@/lib/domain";

export async function currentActor(): Promise<Actor | null> {
  // A deployment missing its secret, its provider, or its domain allowlist
  // denies everyone rather than falling through to the demo actor below.
  if (deploymentIsMisconfigured()) return null;

  const session = await auth();
  if (session?.user?.email) {
    return {
      email: session.user.email,
      name: session.user.name ?? session.user.email.split("@")[0],
      image: session.user.image,
      role: session.user.role,
    };
  }

  if (!demoAuthEnabled()) return null;

  return {
    email: "architect@atlas.local",
    name: "Avery Chen",
    role: "admin",
  };
}

export async function requireActor(allowed: Role[] = ["admin", "editor", "viewer"]) {
  const actor = await currentActor();
  if (!actor) return { actor: null, response: Response.json({ error: "Authentication required" }, { status: 401 }) };
  if (!allowed.includes(actor.role)) {
    return { actor: null, response: Response.json({ error: "Insufficient permission" }, { status: 403 }) };
  }
  return { actor, response: null };
}
