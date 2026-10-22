"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { restoreVersionAction } from "@/app/(workspace)/wiki/actions";

export function RestoreButton(props: { branch: string; slug: string; fromSha: string; expectedBlobSha: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="text-link-button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Restore this version as a new commit on ${props.branch}? Later versions stay in history.`)) return;
        startTransition(async () => {
          const result = await restoreVersionAction(props);
          if (!result.ok) window.alert(result.error);
          else router.push(`/wiki/${props.slug}?branch=${encodeURIComponent(props.branch)}`);
        });
      }}
    >
      {pending ? "Restoring…" : "Restore"}
    </button>
  );
}
