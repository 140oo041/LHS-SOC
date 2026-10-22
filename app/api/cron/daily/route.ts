import { secretMatches } from "@/lib/config";
import { reconcileChangeRequests } from "@/lib/change-requests/service";
import { pruneDeliveries } from "@/lib/content/webhook";
import { sweepPendingUploads } from "@/lib/documents";
import { finishRunningIngestions, pruneVectorStores } from "@/lib/ingestion";
import { pruneRateLimitBuckets } from "@/lib/rate-limit";
import { deleteExpiredThreads } from "@/lib/repository";

// Vercel Hobby runs crons at most once a day, so every periodic chore hangs
// off this one route. Each job is isolated: one failing does not skip the
// rest, and the response says which ones failed.
const jobs: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: "deleteExpiredThreads", run: deleteExpiredThreads },
  { name: "sweepPendingUploads", run: sweepPendingUploads },
  { name: "reconcileChangeRequests", run: reconcileChangeRequests },
  { name: "pruneDeliveries", run: pruneDeliveries },
  { name: "pruneRateLimitBuckets", run: pruneRateLimitBuckets },
  { name: "finishRunningIngestions", run: finishRunningIngestions },
  { name: "pruneVectorStores", run: () => pruneVectorStores() },
];

export const maxDuration = 60;

export async function GET(request: Request) {
  // Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled calls.
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secretMatches(bearer, process.env.CRON_SECRET)) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const results: Record<string, { ok: boolean; result?: unknown; ms: number }> = {};
  for (const job of jobs) {
    const started = Date.now();
    try {
      results[job.name] = { ok: true, result: await job.run(), ms: Date.now() - started };
    } catch (error) {
      console.error(`Cron job ${job.name} failed`, error);
      results[job.name] = { ok: false, ms: Date.now() - started };
    }
  }
  const failed = Object.values(results).some((result) => !result.ok);
  return Response.json({ results }, { status: failed ? 500 : 200 });
}
