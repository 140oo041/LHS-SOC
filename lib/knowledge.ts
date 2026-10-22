import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AtlasContext, Citation, KnowledgeSourceRecord } from "@/lib/domain";

export type LocalKnowledgeSource = KnowledgeSourceRecord & {
  content: string;
  absolutePath: string;
};

const SUPPORTED_ROOT_FILES = [
  "architecture/soc.yaml",
  "architecture/schema.json",
  "README.md",
];

function titleFromContent(relativePath: string, content: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.basename(relativePath).replace(/[-_]/g, " ").replace(/\.[^.]+$/, "");
}

export async function loadLocalKnowledge(): Promise<LocalKnowledgeSource[]> {
  const root = process.cwd();
  const docNames = (await readdir(path.join(root, "docs"))).filter((name) => name.endsWith(".md"));
  const relativePaths = [
    ...docNames.map((name) => `docs/${name}`),
    ...SUPPORTED_ROOT_FILES,
  ];

  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolutePath = path.join(/* turbopackIgnore: true */ root, relativePath);
      const content = await readFile(absolutePath, "utf8");
      return {
        relativePath,
        absolutePath,
        content,
        title: titleFromContent(relativePath, content),
        contentSha256: createHash("sha256").update(content).digest("hex"),
        metadata: {
          category: relativePath.startsWith("docs/") ? "wiki" : "architecture",
          relative_path: relativePath,
        },
      } satisfies LocalKnowledgeSource;
    }),
  );
}

/**
 * The sources at one commit of the wiki: its pages and the architecture
 * model read through the content store (so merges that have not been
 * redeployed are included), plus the other files bundled with this deployment.
 */
export async function loadKnowledgeAt(commitSha: string): Promise<LocalKnowledgeSource[]> {
  const { readBlob, readFiles, WIKI_ROOT } = await import("@/lib/content");
  const root = process.cwd();
  const { MODEL_PATH } = await import("@/lib/model/load");
  const wiki = [
    ...(await readFiles(commitSha, WIKI_ROOT)).filter((file) => file.path.endsWith(".md")),
    ...(await readFiles(commitSha, "architecture")).filter((file) => file.path === MODEL_PATH),
  ];
  const pages = await Promise.all(
    wiki.map(async (file) => {
      const content = await readBlob(file.blobSha);
      return {
        relativePath: file.path,
        absolutePath: path.join(/* turbopackIgnore: true */ root, file.path),
        content,
        title: titleFromContent(file.path, content),
        contentSha256: createHash("sha256").update(content).digest("hex"),
        metadata: { category: file.path === MODEL_PATH ? "architecture" : "wiki", relative_path: file.path },
      } satisfies LocalKnowledgeSource;
    }),
  );
  const read = new Set(wiki.map((file) => file.path));
  const bundled = (await loadLocalKnowledge()).filter((source) => !source.relativePath.startsWith(`${WIKI_ROOT}/`) && !read.has(source.relativePath));
  return [...pages, ...bundled];
}

function queryTerms(question: string) {
  const stop = new Set(["about", "after", "again", "also", "does", "from", "have", "into", "that", "their", "this", "what", "when", "where", "which", "with", "would"]);
  return [...new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])].filter((term) => !stop.has(term));
}

function excerpt(content: string, terms: string[]) {
  const normalized = content.replace(/\s+/g, " ").trim();
  const firstIndex = terms
    .map((term) => normalized.toLowerCase().indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstIndex - 90);
  const value = normalized.slice(start, start + 360).trim();
  return `${start > 0 ? "…" : ""}${value}${start + 360 < normalized.length ? "…" : ""}`;
}

export async function searchLocalKnowledge(
  question: string,
  context: AtlasContext = {},
): Promise<Array<{ source: LocalKnowledgeSource; citation: Citation; score: number }>> {
  const sources = await loadLocalKnowledge();
  const terms = queryTerms(`${question} ${context.blockId ?? ""} ${context.blockName ?? ""}`);
  return sources
    .map((source) => {
      const haystack = `${source.title} ${source.relativePath} ${source.content}`.toLowerCase();
      let score = terms.reduce((total, term) => total + Math.min(6, haystack.split(term).length - 1), 0);
      if (context.sourcePath === source.relativePath) score += 20;
      if (context.blockId && haystack.includes(context.blockId.toLowerCase())) score += 8;
      return {
        source,
        score,
        citation: {
          id: source.contentSha256.slice(0, 12),
          title: source.title,
          path: source.relativePath,
          quote: excerpt(source.content, terms),
        },
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/**
 * The commit the wiki is at. A Vercel deployment has no .git directory, but
 * names the commit it was built from; the GitHub store knows the live head,
 * which is newer than the build once wiki changes merge without a redeploy.
 */
export async function currentGitRevision() {
  const { githubConfigured } = await import("@/lib/content/github-app");
  if (githubConfigured()) {
    const { contentStore } = await import("@/lib/content");
    const store = await contentStore();
    const head = await store.resolveHead(store.defaultBranch);
    if (head) return head;
  }
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  const head = path.join(process.cwd(), ".git", "HEAD");
  try {
    const value = (await readFile(head, "utf8")).trim();
    if (!value.startsWith("ref:")) return value.slice(0, 40);
    const ref = value.slice(5).trim();
    return (await readFile(path.join(process.cwd(), ".git", ref), "utf8")).trim().slice(0, 40);
  } catch {
    return `working-tree-${new Date().toISOString()}`;
  }
}
