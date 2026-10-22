import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { documentStorageConfigured, maxDirectUploadBytes } from "@/lib/config";
import { DocumentError, reserveUpload } from "@/lib/documents";
import { createUploadTarget } from "@/lib/storage";

const schema = z.object({
  filename: z.string().trim().min(1).max(240),
  mimeType: z.string().max(120),
  byteSize: z.number().int().positive(),
  title: z.string().trim().max(180).optional(),
  blockIds: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  documentId: z.uuid().optional(),
  note: z.string().trim().max(500).default(""),
});

/** Step one of an upload: reserve a key and get somewhere to send the bytes. */
export async function POST(request: Request) {
  const access = await requireActor(["admin", "editor"]);
  if (!access.actor) return access.response;
  if (!documentStorageConfigured()) {
    return Response.json({ error: "Document storage is not configured, so uploads are disabled." }, { status: 503 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Upload details are invalid" }, { status: 400 });
  try {
    const pending = await reserveUpload(access.actor, parsed.data, maxDirectUploadBytes());
    const target = await createUploadTarget(pending.storageKey, pending.mimeType, `/api/documents/uploads/${pending.id}/local`);
    return Response.json({ uploadId: pending.id, target }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
