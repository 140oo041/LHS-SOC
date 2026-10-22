import { requireActor } from "@/lib/authz";
import { canEdit } from "@/lib/domain";
import { listDocuments } from "@/lib/documents";

export async function GET(request: Request) {
  const access = await requireActor();
  if (!access.actor) return access.response;
  // Archived documents stay readable by id, but only editors list them.
  const includeArchived = canEdit(access.actor.role) && new URL(request.url).searchParams.get("archived") === "include";
  return Response.json({ documents: await listDocuments({ includeArchived }) });
}
