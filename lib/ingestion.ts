import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  beginKnowledgeRevision,
  completeKnowledgeRevision,
  failKnowledgeRevision,
  listKnowledgeRevisions,
  listKnowledgeSources,
  liveKnowledgeRevisionFor,
  markKnowledgeRevisionDeleted,
  recordKnowledgeSources,
  setKnowledgeRevisionProvider,
} from "@/lib/repository";
import { currentGitRevision, loadKnowledgeAt } from "@/lib/knowledge";
import { aiOperational } from "@/lib/config";
import type { KnowledgeRevision, KnowledgeSourceRecord } from "@/lib/domain";

/**
 * Indexing the wiki and evidence into an OpenAI vector store.
 *
 * Split in two because a serverless call is time-limited and the provider
 * processes files at its own pace: `startIngestion` uploads and hands over a
 * batch, and `finishIngestion` checks on it later (from the admin console's
 * request, or the daily cron). Each revision is one commit; a commit already
 * indexed or being indexed is not indexed again.
 */

const EVIDENCE_FILES = ["reef_spec.pdf", "reef_spec2.pdf", "SoC presentation.pdf"];

async function openAI(pathname: string, init: RequestInit) {
  if (!aiOperational()) throw new Error("Atlas has no AI integration, so no request was sent.");
  const response = await fetch(`https://api.openai.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`OpenAI ingestion failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
  return response;
}

async function uploadFile(relativePath: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set("purpose", "assistants");
  const fileBytes = Uint8Array.from(bytes).buffer;
  form.set("file", new File([fileBytes], relativePath.replaceAll("/", "__"), { type: relativePath.endsWith(".pdf") ? "application/pdf" : "text/plain" }));
  const response = await openAI("/files", { method: "POST", body: form });
  return (await response.json()) as { id: string; filename: string };
}

/** Uploads what changed since the last good index and starts processing. */
export async function startIngestion(commitSha?: string): Promise<KnowledgeRevision> {
  if (!aiOperational()) throw new Error("Atlas has no AI integration, so there is nothing to ingest into.");
  const gitRevision = commitSha ?? (await currentGitRevision());
  const existing = await liveKnowledgeRevisionFor(gitRevision);
  if (existing) return existing;

  const revision = await beginKnowledgeRevision(gitRevision);
  try {
    // Files whose content is unchanged since the last good index are reused
    // rather than uploaded again, which saves time, storage, and money.
    const previous = (await listKnowledgeRevisions(["ready"])).at(-1);
    const reusable = new Map(
      (previous ? await listKnowledgeSources(previous.id) : [])
        .filter((source) => source.providerFileId)
        .map((source) => [`${source.relativePath}:${source.contentSha256}`, source.providerFileId!]),
    );

    const vectorStore = (await (
      await openAI("/vector_stores", { method: "POST", body: JSON.stringify({ name: `Atlas Coral ${gitRevision.slice(0, 12)}` }) })
    ).json()) as { id: string };
    await setKnowledgeRevisionProvider(revision.id, { vectorStoreId: vectorStore.id });

    const records: KnowledgeSourceRecord[] = [];
    const sources: Array<{ relativePath: string; title: string; bytes: Uint8Array; category: string }> = [
      ...(await loadKnowledgeAt(gitRevision)).map((source) => ({
        relativePath: source.relativePath,
        title: source.title,
        bytes: new TextEncoder().encode(source.content),
        category: typeof source.metadata.category === "string" ? source.metadata.category : "repository",
      })),
      ...(await Promise.all(
        EVIDENCE_FILES.map(async (relativePath) => ({
          relativePath,
          title: relativePath.replace(/\.[^.]+$/, ""),
          bytes: new Uint8Array(await readFile(path.join(/* turbopackIgnore: true */ process.cwd(), relativePath))),
          category: "evidence",
        })),
      )),
    ];

    for (const source of sources) {
      const contentSha256 = createHash("sha256").update(source.bytes).digest("hex");
      const fileId = reusable.get(`${source.relativePath}:${contentSha256}`) ?? (await uploadFile(source.relativePath, source.bytes)).id;
      records.push({
        relativePath: source.relativePath,
        title: source.title,
        providerFileId: fileId,
        contentSha256,
        metadata: { category: source.category, relative_path: source.relativePath },
      });
    }
    await recordKnowledgeSources(revision.id, records);

    const batch = (await (
      await openAI(`/vector_stores/${vectorStore.id}/file_batches`, {
        method: "POST",
        body: JSON.stringify({
          files: records.map((record) => ({ file_id: record.providerFileId, attributes: { relative_path: record.relativePath, category: String(record.metadata.category) } })),
        }),
      })
    ).json()) as { id: string };
    await setKnowledgeRevisionProvider(revision.id, { batchId: batch.id });
    return { ...revision, vectorStoreId: vectorStore.id, providerBatchId: batch.id };
  } catch (error) {
    await failKnowledgeRevision(revision.id, error instanceof Error ? error.message : "Unknown ingestion failure");
    throw error;
  }
}

/** Checks a running revision once. Returns its status afterwards. */
export async function finishIngestion(revision: KnowledgeRevision): Promise<KnowledgeRevision["status"]> {
  if (revision.status !== "running") return revision.status;
  if (!revision.vectorStoreId || !revision.providerBatchId) {
    await failKnowledgeRevision(revision.id, "Ingestion stopped before its files were handed to the provider");
    return "failed";
  }
  const batch = (await (await openAI(`/vector_stores/${revision.vectorStoreId}/file_batches/${revision.providerBatchId}`, { method: "GET" })).json()) as {
    status: string;
    file_counts?: { failed?: number; completed?: number };
  };
  if (batch.status === "failed" || batch.status === "cancelled" || batch.file_counts?.failed) {
    await failKnowledgeRevision(revision.id, "One or more Atlas sources failed vector-store processing");
    return "failed";
  }
  if (batch.status !== "completed") return "running";
  await completeKnowledgeRevision(revision.id, (await listKnowledgeSources(revision.id)).length);
  await pruneVectorStores();
  return "ready";
}

/**
 * Starts (or finds) the index for a commit and waits for it within a time
 * budget that leaves room inside a serverless call. Anything still running
 * afterwards is finished by the daily cron.
 */
export async function runIngestion(commitSha?: string, budgetMs = 40_000) {
  const deadline = Date.now() + budgetMs;
  let revision = await startIngestion(commitSha);
  let status = revision.status;
  while (status === "running" && Date.now() + 3000 < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await finishIngestion(revision);
  }
  revision = { ...revision, status };
  return { revisionId: revision.id, status, gitRevision: revision.gitRevision, vectorStoreId: revision.vectorStoreId };
}

export async function finishRunningIngestions() {
  if (!aiOperational()) return "skipped: AI is off";
  const results: Record<string, string> = {};
  for (const revision of await listKnowledgeRevisions(["running"])) results[revision.gitRevision.slice(0, 7)] = await finishIngestion(revision);
  return results;
}

/**
 * Deletes vector stores that newer indexes replaced, and failed ones, with
 * their files. Deleting a vector store does not delete its files, and files
 * are shared between revisions when content did not change, so only files no
 * kept revision uses are removed.
 */
export async function pruneVectorStores(keep = 1) {
  if (!aiOperational()) return "skipped: AI is off";
  const ready = await listKnowledgeRevisions(["ready"]);
  const kept = ready.slice(-keep);
  const doomed = [...ready.slice(0, Math.max(0, ready.length - keep)), ...(await listKnowledgeRevisions(["failed"]))];
  const inUse = new Set<string>();
  for (const revision of [...kept, ...(await listKnowledgeRevisions(["queued", "running"]))]) {
    for (const source of await listKnowledgeSources(revision.id)) if (source.providerFileId) inUse.add(source.providerFileId);
  }

  let pruned = 0;
  for (const revision of doomed) {
    try {
      if (revision.vectorStoreId) await openAI(`/vector_stores/${revision.vectorStoreId}`, { method: "DELETE" }).catch(() => undefined);
      for (const source of await listKnowledgeSources(revision.id)) {
        if (source.providerFileId && !inUse.has(source.providerFileId)) {
          await openAI(`/files/${source.providerFileId}`, { method: "DELETE" }).catch(() => undefined);
          inUse.add(source.providerFileId); // shared by several doomed revisions: delete once
        }
      }
      await markKnowledgeRevisionDeleted(revision.id);
      pruned += 1;
    } catch (error) {
      console.error(`Could not prune knowledge revision ${revision.id}`, error);
    }
  }
  return pruned;
}
