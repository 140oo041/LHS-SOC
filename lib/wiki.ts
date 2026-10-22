import yaml from "js-yaml";
import { contentStore, readBlob, readFiles, readHead, WIKI_ROOT } from "@/lib/content";
import { isCommitSha, isReadableBranchName } from "@/lib/content/branch-name";

export type WikiPage = {
  slug: string;
  title: string;
  summary: string;
  /** The Markdown to render, without front matter. */
  content: string;
  /** The file exactly as stored, which is what the editor works on. */
  source: string;
  relativePath: string;
  updatedLabel: string;
  relatedBlocks: string[];
  /** The blob this page was read from; an edit must start from it. */
  blobSha: string;
  /** The commit this page was read at. */
  commitSha: string;
};

/** Which version of the wiki to read: a branch's latest, or one exact commit. */
export type WikiRef = { branch: string } | { sha: string };

// Links for pages that predate front matter. A page's own `blocks:` list
// takes precedence, so this shrinks as pages are edited.
const legacyBlockMap: Record<string, string[]> = {
  "architecture-overview": ["coral-system", "coral-soc", "coral-core"],
  "boot-flow": ["coral-soc", "flash-controller", "host-link", "itcm"],
  "coral-core": ["coral-core", "compute-cluster", "dtcm", "itcm"],
  dma: ["dma", "dma-control-fsm", "dma-address-gen"],
  "editing-guide": ["coral-system"],
};

const SLUG = /^[a-z0-9-]+$/;

// These are wiki routes, so a page with one of these names could never be opened.
const RESERVED = new Set(["changes", "commits", "new"]);

export function isWikiSlug(value: string) {
  return SLUG.test(value) && value.length <= 80 && !RESERVED.has(value);
}

export function slugToPath(slug: string) {
  if (!isWikiSlug(slug)) throw new Error("Invalid wiki page name");
  return `${WIKI_ROOT}/${slug}.md`;
}

/**
 * Splits optional YAML front matter from the body.
 *
 * Only `blocks:` is read today. Malformed front matter is left in the body
 * rather than dropped, so a mistake is visible instead of silently losing
 * text; the editor validates it before anything is committed.
 */
export function splitFrontMatter(source: string): { data: { blocks?: string[] }; body: string; error?: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: source };
  try {
    const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    const blocks = (parsed as { blocks?: unknown } | null)?.blocks;
    if (blocks !== undefined && !(Array.isArray(blocks) && blocks.every((item) => typeof item === "string"))) {
      return { data: {}, body: source, error: "blocks must be a list of block IDs" };
    }
    return { data: { blocks: blocks as string[] | undefined }, body: source.slice(match[0].length) };
  } catch (error) {
    return { data: {}, body: source, error: error instanceof Error ? error.message.split("\n")[0] : "Front matter is not valid YAML" };
  }
}

/** Writes a block list into a page's front matter, keeping the body as is. */
export function withBlocks(source: string, blocks: string[]) {
  const { body } = splitFrontMatter(source);
  if (!blocks.length) return body;
  return `---\nblocks: [${blocks.join(", ")}]\n---\n\n${body.replace(/^\n+/, "")}`;
}

export function parsePage(slug: string, source: string, blobSha: string, commitSha: string): WikiPage {
  const { data, body } = splitFrontMatter(source);
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug.replaceAll("-", " ");
  const summary = body
    .replace(/^#\s+.+$/m, "")
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 220);
  return {
    slug,
    title,
    summary,
    content: body,
    source,
    relativePath: `${WIKI_ROOT}/${slug}.md`,
    updatedLabel: `Git ${commitSha.slice(0, 7)}`,
    relatedBlocks: data.blocks ?? legacyBlockMap[slug] ?? [],
    blobSha,
    commitSha,
  };
}

/** The commit a ref points at, or null for a branch that does not exist. */
export async function resolveWikiRef(ref?: WikiRef): Promise<string | null> {
  if (ref && "sha" in ref) return isCommitSha(ref.sha) ? ref.sha : null;
  const branch = ref?.branch ?? (await contentStore()).defaultBranch;
  if (!isReadableBranchName(branch)) return null;
  return readHead(branch);
}

function slugOf(filePath: string) {
  const name = filePath.slice(WIKI_ROOT.length + 1);
  if (name.includes("/") || !name.endsWith(".md")) return null;
  const slug = name.slice(0, -3);
  return isWikiSlug(slug) ? slug : null;
}

export async function listWikiPages(ref?: WikiRef): Promise<WikiPage[]> {
  const commitSha = await resolveWikiRef(ref);
  if (!commitSha) return [];
  const files = await readFiles(commitSha);
  const pages = await Promise.all(
    files.map(async (file) => {
      const slug = slugOf(file.path);
      return slug ? parsePage(slug, await readBlob(file.blobSha), file.blobSha, commitSha) : null;
    }),
  );
  return pages.filter((page): page is WikiPage => page !== null).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getWikiPage(slug: string, ref?: WikiRef): Promise<WikiPage | null> {
  if (!isWikiSlug(slug)) return null;
  const commitSha = await resolveWikiRef(ref);
  if (!commitSha) return null;
  const file = (await readFiles(commitSha)).find((entry) => entry.path === slugToPath(slug));
  if (!file) return null;
  return parsePage(slug, await readBlob(file.blobSha), file.blobSha, commitSha);
}
