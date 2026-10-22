import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { listMembers, MemberChangeError, setMemberRole } from "@/lib/roles";

const schema = z.object({
  email: z.email().max(320),
  role: z.enum(["admin", "editor", "viewer"]),
});

export async function GET() {
  const access = await requireActor(["admin"]);
  if (!access.actor) return access.response;
  return Response.json({ members: await listMembers() });
}

/** Invites someone, or changes the role of someone already listed. */
export async function POST(request: Request) {
  const access = await requireActor(["admin"]);
  if (!access.actor) return access.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter an email address and a role" }, { status: 400 });
  try {
    await setMemberRole(access.actor, parsed.data.email, parsed.data.role);
  } catch (error) {
    if (error instanceof MemberChangeError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return Response.json({ members: await listMembers() }, { status: 201 });
}
