import { requireActor } from "@/lib/authz";
import { isLocalDevelopment, maxUploadBytes } from "@/lib/config";
import { DocumentError, getPendingUpload } from "@/lib/documents";
import { putObject } from "@/lib/storage";

/**
 * Stands in for the bucket on a developer's machine, which has none. Refused
 * everywhere else: a host sends bytes straight to object storage.
 */
export async function PUT(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  if (!isLocalDevelopment()) return Response.json({ error: "Not found" }, { status: 404 });
  const access = await requireActor(["admin", "editor"]);
  if (!access.actor) return access.response;
  try {
    const pending = await getPendingUpload(access.actor, (await context.params).uploadId);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxUploadBytes()) return Response.json({ error: "File is too large" }, { status: 413 });
    await putObject(pending.storageKey, bytes, pending.mimeType);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof DocumentError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
