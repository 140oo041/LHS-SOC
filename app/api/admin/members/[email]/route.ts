import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { listMembers, MemberChangeError, revokeMember, setMemberRole } from "@/lib/roles";

type Context = { params: Promise<{ email: string }> };

async function change(work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    if (error instanceof MemberChangeError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return Response.json({ members: await listMembers() });
}

export async function PATCH(request: Request, context: Context) {
  const access = await requireActor(["admin"]);
  if (!access.actor) return access.response;
  const parsed = z.object({ role: z.enum(["admin", "editor", "viewer"]) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose admin, editor, or viewer" }, { status: 400 });
  const email = decodeURIComponent((await context.params).email);
  return change(() => setMemberRole(access.actor, email, parsed.data.role));
}

/** Revokes access. Restoring it is a PATCH with a role. */
export async function DELETE(_request: Request, context: Context) {
  const access = await requireActor(["admin"]);
  if (!access.actor) return access.response;
  const email = decodeURIComponent((await context.params).email);
  return change(() => revokeMember(access.actor, email));
}
