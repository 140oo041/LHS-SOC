import { after } from "next/server";
import { aiOperational } from "@/lib/config";
import { contentStore, expireBranch, expireBranchList } from "@/lib/content";
import { startIngestion } from "@/lib/ingestion";
import { mapPull, type GithubPull } from "@/lib/content/github-store";
import { firstDelivery, verifyGithubSignature } from "@/lib/content/webhook";
import { syncFromPull } from "@/lib/change-requests/service";

/**
 * Tells Atlas about changes made outside it: a push from a clone, or a pull
 * request opened, updated, merged, or closed on GitHub. Without this, Atlas
 * would only notice when its cached branch heads expired.
 */
export async function POST(request: Request) {
  // The signature covers the exact bytes, so read them before parsing.
  const body = await request.text();
  if (!verifyGithubSignature(body, request.headers.get("x-hub-signature-256"), process.env.GITHUB_WEBHOOK_SECRET)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (!delivery) return Response.json({ error: "Missing delivery id" }, { status: 400 });
  if (!(await firstDelivery(delivery, event))) return Response.json({ ok: true, duplicate: true });

  const payload = JSON.parse(body);

  if (event === "push" && typeof payload.ref === "string" && payload.ref.startsWith("refs/heads/")) {
    const branch = payload.ref.slice("refs/heads/".length);
    await expireBranch(branch);
    if (payload.created || payload.deleted) await expireBranchList();
    // The published wiki moved, so the copilot's index is out of date. The
    // response goes back to GitHub first; indexing continues after it.
    const store = await contentStore();
    if (branch === store.defaultBranch && !payload.deleted && aiOperational() && typeof payload.after === "string") {
      after(() => startIngestion(payload.after).catch((error) => console.error("Indexing after push failed", error)));
    }
  }

  if (event === "pull_request" && ["opened", "reopened", "synchronize", "closed", "edited"].includes(payload.action)) {
    await syncFromPull(mapPull(payload.pull_request as GithubPull));
  }

  return Response.json({ ok: true });
}
