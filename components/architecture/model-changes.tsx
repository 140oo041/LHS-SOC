import Link from "next/link";
import type { ModelDiff } from "@/lib/model/diff";
import { diffIsEmpty } from "@/lib/model/diff";

const STATUS_LABEL = { added: "Added", removed: "Removed", changed: "Changed" } as const;

function show(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("; ") || "none";
  return value === null || value === undefined ? "none" : typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * A change request's edits to the architecture model, in model terms, above
 * the raw YAML diff. The canvas link shows the same changes drawn in place.
 */
export function ModelChanges({ diff, branch, names }: { diff: ModelDiff; branch: string | { ref: string }; names: Record<string, string> }) {
  const version = typeof branch === "string" ? `branch=${encodeURIComponent(branch)}` : `ref=${branch.ref}`;
  if (diffIsEmpty(diff)) return null;
  const name = (id: string) => names[id] ?? id;
  return (
    <section className="model-changes">
      <h2 className="section-title">
        Architecture model <Link href={`/architecture?${version}`}>See it on the canvas</Link>
      </h2>
      <ul>
        {diff.blocks.map((block) => (
          <li key={`block-${block.id}`}>
            <span className={`change-mark ${block.status}`}>{STATUS_LABEL[block.status]}</span>
            <Link href={`/architecture/${encodeURIComponent(block.id)}?${version}`}>{block.name}</Link>
            {block.fields.length > 0 && (
              <dl>
                {block.fields.map((field) => (
                  <div key={field.field}>
                    <dt>{field.field}</dt>
                    <dd><del>{show(field.before)}</del> <ins>{show(field.after)}</ins></dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
        {diff.connections.map((connection) => (
          <li key={`connection-${connection.id}`}>
            <span className={`change-mark ${connection.status}`}>{STATUS_LABEL[connection.status]}</span>
            <span>
              Connection {name(connection.from)} → {name(connection.to)} <small>{connection.label}</small>
            </span>
            {connection.fields.length > 0 && (
              <dl>
                {connection.fields.map((field) => (
                  <div key={field.field}>
                    <dt>{field.field}</dt>
                    <dd><del>{show(field.before)}</del> <ins>{show(field.after)}</ins></dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
        {diff.sections
          .filter((section) => !(["layouts", "ports"].includes(section) && (diff.blocks.length || diff.connections.length)))
          .map((section) => (
            <li key={`section-${section}`}>
              <span className="change-mark changed">Changed</span>
              <span>{section.replace("_", " ")}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}
