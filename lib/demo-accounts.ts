import type { Role } from "@/lib/domain";

/**
 * People to be on a developer's own machine, where nobody signs in.
 *
 * One identity cannot exercise review: an author may not approve their own
 * change request, so trying the flow end to end needs a second person. These
 * accounts exist only with ATLAS_DEMO_AUTH=true under `next dev`.
 */
export const DEMO_ACCOUNT_COOKIE = "atlas_demo_account";

export const DEMO_ACCOUNTS: ReadonlyArray<{ email: string; name: string; role: Role }> = [
  { email: "architect@atlas.local", name: "Avery Chen", role: "admin" },
  { email: "rtl@atlas.local", name: "Riley Park", role: "editor" },
  { email: "verification@atlas.local", name: "Sam Ortiz", role: "editor" },
  { email: "guest@atlas.local", name: "Jordan Lee", role: "viewer" },
];
