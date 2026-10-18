import { requireActor } from "@/lib/authz";
import { deleteExpiredThreads } from "@/lib/repository";

export async function POST(request: Request) {
  const secret = request.headers.get("x-atlas-ingestion-secret");
  const trustedAutomation = Boolean(process.env.ATLAS_INGESTION_SECRET && secret === process.env.ATLAS_INGESTION_SECRET);
  if (!trustedAutomation) {
    const access = await requireActor(["admin"]);
    if (!access.actor) return access.response;
  }
  return Response.json({ deleted: await deleteExpiredThreads() });
}
