import { canAdmin, canEdit, type Actor, type Role } from "@/lib/domain";

/**
 * When a wiki change may merge. Pure, so the rule can be read and tested as
 * a table. The rule: an administrator merges, after at least one approval
 * from an editor or administrator other than the author, given on the exact
 * commit being merged, with nothing outstanding against it.
 */

export type ReviewVerdict = "approved" | "changes_requested" | "commented";

export type Review = {
  id: string;
  reviewerEmail: string;
  verdict: ReviewVerdict;
  headSha: string;
  body: string;
  dismissed: boolean;
  createdAt: string;
};

export type MergeInput = {
  actor: Actor;
  status: "open" | "merged" | "closed";
  authorEmail: string | null;
  /** The branch head GitHub reports right now. */
  headSha: string;
  mergeable: boolean | null;
  reviews: Review[];
  /** Each reviewer's role now, or null if they no longer have access. */
  roleOf: (email: string) => Role | null;
};

export function evaluateMerge(input: MergeInput): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!canAdmin(input.actor.role)) reasons.push("Only an administrator can merge.");
  if (input.status !== "open") reasons.push("This change request is not open.");

  const current = input.reviews.filter((review) => !review.dismissed && review.headSha === input.headSha);
  const approvals = current.filter((review) => {
    if (review.verdict !== "approved") return false;
    if (input.authorEmail && review.reviewerEmail === input.authorEmail) return false;
    const role = input.roleOf(review.reviewerEmail);
    return role !== null && canEdit(role);
  });
  if (!approvals.length) reasons.push("Needs an approval from an editor or administrator who is not the author.");

  // A reviewer's own later approval supersedes their earlier objection.
  const latestByReviewer = new Map<string, Review>();
  for (const review of current.filter((item) => item.verdict !== "commented")) latestByReviewer.set(review.reviewerEmail, review);
  if ([...latestByReviewer.values()].some((review) => review.verdict === "changes_requested")) {
    reasons.push("A reviewer asked for changes.");
  }

  if (input.mergeable === null) reasons.push("GitHub is still checking whether this merges cleanly. Try again in a moment.");
  else if (!input.mergeable) reasons.push("This branch conflicts with the published wiki. Update the branch first.");

  return { allowed: reasons.length === 0, reasons };
}

/** Whether this person may record this verdict at all. */
export function reviewRefusal(actor: Actor, authorEmail: string | null, verdict: ReviewVerdict): string | null {
  if (!canEdit(actor.role)) return "Reviewing needs the editor role.";
  if (verdict !== "commented" && authorEmail === actor.email) return "Authors cannot approve or reject their own change.";
  return null;
}
