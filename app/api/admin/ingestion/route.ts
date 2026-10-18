import { requireActor } from "@/lib/authz";
import { ingestKnowledge } from "@/lib/ingestion";
import { latestKnowledgeRevision } from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  const access = await requireActor(["admin"]);
  if (!access.actor) return access.response;
  return Response.json({ revision: await latestKnowledgeRevision() });
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-atlas-ingestion-secret");
  const trustedAutomation = Boolean(process.env.ATLAS_INGESTION_SECRET && secret === process.env.ATLAS_INGESTION_SECRET);
  if (!trustedAutomation) {
    const access = await requireActor(["admin"]);
    if (!access.actor) return access.response;
  }
  try {
    return Response.json(await ingestKnowledge(), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingestion failed";
    return Response.json({ error: process.env.NODE_ENV === "production" ? "Ingestion failed" : message }, { status: 502 });
  }
}
