import { requireActor } from "@/lib/authz";
import { getDocument, listDocumentRevisions } from "@/lib/documents";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await requireActor();
  if (!access.actor) return access.response;
  const { id } = await context.params;
  if (!(await getDocument(id))) return Response.json({ error: "Document not found" }, { status: 404 });
  return Response.json({ revisions: await listDocumentRevisions(id) });
}
