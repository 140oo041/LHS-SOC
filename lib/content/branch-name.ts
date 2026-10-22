/**
 * Branches Atlas creates are named `atlas/<topic>`, so they are easy to tell
 * apart from branches people push from a clone, and Atlas only ever writes to
 * its own. The topic is deliberately narrower than Git allows.
 */
export const ATLAS_BRANCH_PREFIX = "atlas/";

const TOPIC = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Turns "DMA timeout proposal" into "atlas/dma-timeout-proposal". */
export function branchNameFromTopic(topic: string) {
  const slug = topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${ATLAS_BRANCH_PREFIX}${slug}`;
}

export function isAtlasBranch(name: string) {
  return name.startsWith(ATLAS_BRANCH_PREFIX) && TOPIC.test(name.slice(ATLAS_BRANCH_PREFIX.length));
}

/** Any existing branch name that is safe to put in a URL and an API path. */
export function isReadableBranchName(name: string) {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock")
  );
}

export function isCommitSha(value: string) {
  return /^[0-9a-f]{40}$/.test(value);
}
