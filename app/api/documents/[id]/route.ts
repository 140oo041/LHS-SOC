import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { deleteDocument, DocumentError, getDocumentRevision, updateDocument } from "@/lib/documents";
import { createDownloadUrl, getObject } from "@/lib/storage";

type Context = { params: Promise<{ id: string }> };

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}

/** Opens the current revision, or `?revision=N`. */
export async function GET(request: Request, context: Context) {
  const access = await requireActor();
  if (!access.actor) return access.response;
  const { id } = await context.params;
  const requested = new URL(request.url).searchParams.get("revision");
  const revisionNumber = requested ? Number(requested) : undefined;
  if (revisionNumber !== undefined && !(Number.isInteger(revisionNumber) && revisionNumber > 0)) {
    return Response.json({ error: "Revision must be a positive whole number" }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Document not found" }, { status: 404 });
  const revision = await getDocumentRevision(id, revisionNumber);
  if (!revision) return Response.json({ error: "Document not found" }, { status: 404 });

  // Responses are capped at about 4.5 MB on the host, so the bucket serves
  // the bytes through a link that expires in a minute.
  const url = await createDownloadUrl(revision.storageKey, revision.filename, revision.mimeType);
  if (url) return Response.redirect(url, 302);

  try {
    const bytes = await getObject(revision.storageKey);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": revision.mimeType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(revision.filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return Response.json({ error: "Document content is unavailable" }, { status: 404 });
  }
}

const changes = z
  .object({
    archived: z.boolean().optional(),
    title: z.string().trim().min(1).max(180).optional(),
    blockIds: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export async function PATCH(request: Request, context: Context) {
  const access = await requireActor(["admin", "editor"]);
  if (!access.actor) return access.response;
  const parsed = changes.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Nothing valid to change" }, { status: 400 });
  try {
    return Response.json({ document: await updateDocument(access.actor, (await context.params).id, parsed.data) });
  } catch (error) {
    return failure(error);
  }
}

/** Permanent: removes every revision. Archiving is the reversible option. */
export async function DELETE(_request: Request, context: Context) {
  const access = await requireActor(["admin"]);
  if (!access.actor) return access.response;
  try {
    await deleteDocument(access.actor, (await context.params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
