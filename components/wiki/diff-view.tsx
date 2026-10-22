import { parsePatch } from "@/lib/content/diff";
import type { ComparedFile } from "@/lib/content/types";

const statusLabel: Record<ComparedFile["status"], string> = { added: "Added", modified: "Changed", removed: "Removed", renamed: "Renamed" };

/** One file's unified diff as numbered, coloured lines. */
export function PatchView({ patch }: { patch: string }) {
  const lines = parsePatch(patch);
  return (
    <table className="diff-lines">
      <tbody>
        {lines.map((line, index) =>
          line.kind === "hunk" ? (
            <tr key={index} className="diff-hunk"><td colSpan={3}>{line.text}</td></tr>
          ) : (
            <tr key={index} className={`diff-${line.kind}`}>
              <td className="diff-number">{line.oldNumber ?? ""}</td>
              <td className="diff-number">{line.newNumber ?? ""}</td>
              <td><span aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><span className="sr-only">{line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}</span>{line.text || " "}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

export function DiffView({ files }: { files: ComparedFile[] }) {
  if (!files.length) return <p className="diff-empty">No differences.</p>;
  return (
    <div className="diff-view">
      {files.map((file) => (
        <section key={file.path} className="diff-file">
          <header><span className={`diff-status ${file.status}`}>{statusLabel[file.status]}</span><code>{file.previousPath ? `${file.previousPath} → ` : ""}{file.path}</code></header>
          {file.patch ? <PatchView patch={file.patch} /> : <p className="diff-empty">This change is too large to show here. Open it on GitHub.</p>}
        </section>
      ))}
    </div>
  );
}
