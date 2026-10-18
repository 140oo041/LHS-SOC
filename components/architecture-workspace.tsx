"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";

type Selection = { id: string; name: string; kind?: string; summary?: string; sourcePath?: string };

export function ArchitectureWorkspace({ selected = "coral-system" }: { selected?: string }) {
  const [selection, setSelection] = useState<Selection>({
    id: selected,
    name: selected === "coral-system" ? "Coral system" : selected.replaceAll("-", " "),
    kind: "system boundary",
    summary: selected === "coral-system"
      ? "The complete evidence-linked planning boundary for Coral SoC and external memory."
      : "Selected from an Atlas deep link. The architecture model remains the canonical description.",
    sourcePath: "architecture/soc.yaml",
  });
  const frameSource = useMemo(() => {
    const hash = new URLSearchParams({ view: "structure", focus: "coral-system" });
    if (selected) hash.set("selected", selected);
    return `/legacy/index.html#${hash}`;
  }, [selected]);
  const copilotHref = useMemo(() => {
    const params = new URLSearchParams({ blockId: selection.id, blockName: selection.name });
    if (selection.sourcePath) params.set("sourcePath", selection.sourcePath);
    return `/copilot?${params}`;
  }, [selection]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "atlas-selection") return;
      setSelection(event.data.block);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  return (
    <div className="artifact-workbench">
      <section className="artifact-stage" aria-label="Interactive Coral architecture">
        <iframe
          className="architecture-frame"
          src={frameSource}
          title="Coral architecture workbench"
        />
      </section>
      <aside className="field-log" aria-label="Architecture context">
        <header>
          <span className="status-light" />
          <p>Model ready</p>
          <strong>Git-backed</strong>
        </header>
        <div className="field-selection">
          <span>{selection.kind ?? "architecture block"}</span>
          <h1>{selection.name}</h1>
          <p>{selection.summary ?? "Inspect the block, then ask Atlas from this exact architecture context."}</p>
        </div>
        <div className="field-actions">
          <Link className="primary-field-action" href={copilotHref}>
            <Icon name="copilot" />
            <span><strong>Ask Atlas</strong><small>Explain this block with evidence</small></span>
            <Icon name="arrow" />
          </Link>
          <Link href={`/tasks?block=${encodeURIComponent(selection.id)}`}>
            <Icon name="tasks" />
            <span><strong>Related work</strong><small>Tasks linked to this block</small></span>
            <Icon name="arrow" />
          </Link>
          <Link href={`/documents?block=${encodeURIComponent(selection.id)}`}>
            <Icon name="documents" />
            <span><strong>Evidence</strong><small>Specifications and attachments</small></span>
            <Icon name="arrow" />
          </Link>
        </div>
        <dl className="field-facts">
          <div><dt>Stable ID</dt><dd>{selection.id}</dd></div>
          <div><dt>Source</dt><dd>{selection.sourcePath ?? "architecture/soc.yaml"}</dd></div>
          <div><dt>Authority</dt><dd>Canonical model</dd></div>
        </dl>
        <p className="field-note">Generated explanations remain secondary to the cited Git source.</p>
      </aside>
    </div>
  );
}
