"use client";

import { useState } from "react";
import { PageEditor } from "@/components/wiki/page-editor";

const slugify = (title: string) =>
  title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/** Name the page, then write it. The file name follows the title. */
export function NewPageForm({ branch }: { branch: string }) {
  const [title, setTitle] = useState("");
  const [started, setStarted] = useState(false);
  const slug = slugify(title);
  if (started) return <PageEditor slug={slug} branch={branch} initialSource={`# ${title}\n\n`} initialBlobSha={null} />;
  return (
    <form className="wiki-start-draft" onSubmit={(event) => { event.preventDefault(); if (slug) setStarted(true); }}>
      <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={80} autoFocus /></label>
      <p>Saved as <code>docs/{slug || "…"}.md</code></p>
      <button className="primary-button" type="submit" disabled={!slug}>Write the page</button>
    </form>
  );
}
