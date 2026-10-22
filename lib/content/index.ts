import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { revalidateTag, unstable_cache } from "next/cache";
import { isLocalDevelopment } from "@/lib/config";
import { githubConfigured, githubSettings } from "@/lib/content/github-app";
import { GithubContentStore } from "@/lib/content/github-store";
import { createMemoryRepository, MemoryContentStore, type MemoryRepository } from "@/lib/content/memory-store";
import { MODEL_PATH } from "@/lib/model/load";
import type { BranchInfo, CommitSummary, Comparison, ContentStore, FileEntry, GraphCommit } from "@/lib/content/types";

export const WIKI_ROOT = "docs";

declare global {
  var __atlasContent: { repo: Promise<MemoryRepository> } | undefined;
}

async function seedFromBundle() {
  const dir = path.join(process.cwd(), WIKI_ROOT);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  const files: Record<string, string> = {};
  for (const name of names) files[`${WIKI_ROOT}/${name}`] = await readFile(path.join(/* turbopackIgnore: true */ dir, name), "utf8");
  files[MODEL_PATH] = await readFile(path.join(/* turbopackIgnore: true */ process.cwd(), MODEL_PATH), "utf8");
  return createMemoryRepository("main", files);
}

/** Replaces the in-process repository; tests use this to start clean. */
export function resetMemoryContent(repo?: MemoryRepository) {
  globalThis.__atlasContent = { repo: repo ? Promise.resolve(repo) : seedFromBundle() };
}

let githubStore: GithubContentStore | null = null;

/**
 * The GitHub store when the App is configured, otherwise the in-process one
 * seeded from the `docs/` and model bundled with this deployment.
 */
export async function contentStore(): Promise<ContentStore> {
  if (githubConfigured()) {
    githubStore ??= new GithubContentStore(githubSettings());
    return githubStore;
  }
  globalThis.__atlasContent ??= { repo: seedFromBundle() };
  return new MemoryContentStore(await globalThis.__atlasContent.repo, "main");
}

/**
 * Whether the wiki can be changed from Atlas here.
 *
 * Without GitHub, a host would keep edits in one serverless instance's memory
 * and lose them on the next cold start, which is worse than not offering
 * editing at all. Only a developer's own machine gets the in-process store
 * read-write.
 */
export function wikiEditingAvailable() {
  return githubConfigured() || isLocalDevelopment();
}

const branchTag = (branch: string) => `wiki:branch:${branch}`;
const BRANCHES_TAG = "wiki:branches";
const PULLS_TAG = "wiki:pulls";

/**
 * Cached reads for the GitHub store.
 *
 * Only a branch's head is ever invalidated. Trees and blobs are addressed by
 * sha, so they never change and are cached for good, and once a head is
 * known, rendering any page at it costs no GitHub calls at all. The webhook
 * expires a branch's head when someone pushes; the five-minute revalidation
 * is a safety net for a missed delivery.
 */
function cached<A extends unknown[], R>(store: ContentStore, key: string, work: (...args: A) => Promise<R>, options: { tags?: (...args: A) => string[]; revalidate: number | false }) {
  if (store.kind !== "github") return work;
  return (...args: A) =>
    unstable_cache(() => work(...args), [key, ...args.map(String)], {
      tags: options.tags?.(...args),
      revalidate: options.revalidate,
    })();
}

export async function readHead(branch: string): Promise<string | null> {
  const store = await contentStore();
  return cached(store, "wiki-head", (name: string) => store.resolveHead(name), { tags: (name) => [branchTag(name)], revalidate: 300 })(branch);
}

export async function readBranches(): Promise<BranchInfo[]> {
  const store = await contentStore();
  return cached(store, "wiki-branches", () => store.listBranches(), { tags: () => [BRANCHES_TAG], revalidate: 300 })();
}

export async function readFiles(commitSha: string, dir = WIKI_ROOT): Promise<FileEntry[]> {
  const store = await contentStore();
  return cached(store, "wiki-tree", (sha: string, root: string) => store.listFiles(sha, root), { revalidate: false })(commitSha, dir);
}

export async function readBlob(blobSha: string): Promise<string> {
  const store = await contentStore();
  return cached(store, "wiki-blob", (sha: string) => store.readBlob(sha), { revalidate: false })(blobSha);
}

/**
 * Where a branch left another: what a change request's diff is measured
 * from. Both inputs are commits, so the answer never changes.
 */
export async function readMergeBase(baseSha: string, headSha: string): Promise<string> {
  const store = await contentStore();
  return cached(store, "wiki-merge-base", async (base: string, head: string) => (await store.compare(base, head)).mergeBaseSha, { revalidate: false })(
    baseSha,
    headSha,
  );
}

/** Commits reachable from these heads. Heads are commits, so this never goes stale. */
export async function readCommits(heads: string[], limit: number): Promise<GraphCommit[]> {
  const store = await contentStore();
  return cached(store, "wiki-commits", (key: string, max: number) => store.listCommits(key.split(","), max), { revalidate: false })(
    [...heads].sort().join(","),
    limit,
  );
}

/** What one commit changed, or a branch since another: both ends are commits, so cached for good. */
export async function readComparison(baseSha: string, headSha: string): Promise<Comparison> {
  const store = await contentStore();
  return cached(store, "wiki-compare", (base: string, head: string) => store.compare(base, head), { revalidate: false })(baseSha, headSha);
}

export async function readCommit(sha: string): Promise<GraphCommit | null> {
  const store = await contentStore();
  return cached(store, "wiki-commit", (id: string) => store.getCommit(id), { revalidate: false })(sha);
}

/** A file's history, cached per head so a new commit is a new key. */
export async function readHistory(branch: string, headSha: string, filePath: string): Promise<CommitSummary[]> {
  const store = await contentStore();
  return cached(store, "wiki-history", (name: string, _head: string, file: string) => store.fileHistory(name, file, 30), { revalidate: false })(
    branch,
    headSha,
    filePath,
  );
}

/**
 * Marks a branch's cached head as stale after Atlas or a push changed it.
 * The memory store has no cache, and outside a Next request there is none to
 * expire, so this is a no-op in both cases.
 */
export async function expireBranch(...branches: string[]) {
  if ((await contentStore()).kind !== "github") return;
  for (const branch of branches) revalidateTag(branchTag(branch), { expire: 0 });
}

export async function expireBranchList() {
  if ((await contentStore()).kind !== "github") return;
  revalidateTag(BRANCHES_TAG, { expire: 0 });
}

export async function expirePulls() {
  if ((await contentStore()).kind !== "github") return;
  revalidateTag(PULLS_TAG, { expire: 0 });
}
