import { requireActor } from "@/lib/authz";
import { maxDirectUploadBytes } from "@/lib/config";
import { completeUpload, DocumentError, getPendingUpload } from "@/lib/documents";
import { headObject } from "@/lib/storage";

/** Step two of an upload: confirm what reached storage and record it. */
export async function POST(_request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const access = await requireActor(["admin", "editor"]);
  if (!access.actor) return access.response;
  try {
    const pending = await getPendingUpload(access.actor, (await context.params).uploadId);
    const document = await completeUpload(access.actor, pending, await headObject(pending.storageKey), maxDirectUploadBytes());
    return Response.json({ document }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
