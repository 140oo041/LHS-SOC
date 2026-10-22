"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { createBranchAction } from "@/app/(workspace)/wiki/actions";
import type { ModelEdit } from "@/lib/model/edit";
import type { ViewBlock, ViewConnection, ViewSnapshot } from "@/lib/model/view";
import type { ModelEditContext } from "./explorer";
import type { ModelSession } from "./model-session";
import { MATURITY_LABEL, MATURITY_ORDER } from "./lens";

/**
 * Editing the model from the inspector.
 *
 * Every form here turns into one structured edit (lib/model/edit.ts) that the
 * server applies to the YAML, validates, and commits to the branch being
 * viewed. Nobody types YAML and nobody positions anything: placement and
 * ports are worked out for them.
 */

/** Sends one form's edit through the session and reports on it. */
function useModelEdit(session: ModelSession) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const run = async (edit: ModelEdit, nextSelection?: string | null, done?: () => void) => {
    setError("");
    setPending(true);
    const result = await session.submit(edit, nextSelection);
    setPending(false);
    if (!result.ok) setError(result.error);
    else done?.();
  };
  return { run, pending, error };
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const lines = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

function kindsOf(snapshot: ViewSnapshot) {
  return [...new Set(Object.values(snapshot.blocks).map((block) => block.kind))].sort();
}

/** On the published branch: editing begins with a branch of one's own. */
export function StartBranch({ block, editing }: { block: ViewBlock; editing: ModelEditContext }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <section className="inspector-block model-edit-start">
      <h3>Change this block</h3>
      <p className="inspector-absent">The published model only changes through an approved change request. Edit on a branch, then propose it.</p>
      <button
        type="button"
        className="model-edit-primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError("");
            // A branch for this block may exist from an earlier session; take the next free name.
            let result = await createBranchAction(`model ${block.name}`, editing.branch);
            for (let n = 2; !result.ok && /already exists/i.test(result.error) && n < 10; n += 1) {
              result = await createBranchAction(`model ${block.name} ${n}`, editing.branch);
            }
            if (!result.ok) setError(result.error);
            else router.push(`/architecture/${encodeURIComponent(block.id)}?branch=${encodeURIComponent(result.branch)}`);
          })
        }
      >
        {pending ? "Creating branch…" : "Start a branch to edit"}
      </button>
      {error && <p role="alert" className="model-edit-error">{error}</p>}
    </section>
  );
}

type Mode = "fields" | "add" | "connect" | "remove" | null;

/** The edit toolbar and its forms for one selected block on a draft branch. */
export function BlockEditor({
  snapshot,
  block,
  session,
}: {
  snapshot: ViewSnapshot;
  block: ViewBlock;
  session: ModelSession;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const toggle = (next: Mode) => setMode((current) => (current === next ? null : next));
  const close = () => setMode(null);

  return (
    <section className="inspector-block model-edit">
      <div className="model-edit-tools" role="toolbar" aria-label={`Edit ${block.name}`}>
        <button type="button" aria-pressed={mode === "fields"} onClick={() => toggle("fields")}>Edit</button>
        <button type="button" aria-pressed={mode === "add"} onClick={() => toggle("add")}>Add block inside</button>
        <button type="button" aria-pressed={mode === "connect"} onClick={() => toggle("connect")}>Connect</button>
        <button type="button" className="danger" aria-pressed={mode === "remove"} onClick={() => toggle("remove")}>Remove</button>
      </div>
      {mode === "fields" && <BlockFieldsForm key={block.id} snapshot={snapshot} block={block} session={session} onDone={close} />}
      {mode === "add" && <AddBlockForm key={block.id} snapshot={snapshot} parent={block} session={session} onDone={close} />}
      {mode === "connect" && <ConnectForm key={block.id} snapshot={snapshot} block={block} session={session} onDone={close} />}
      {mode === "remove" && <RemoveBlock key={block.id} snapshot={snapshot} block={block} session={session} onDone={close} />}
    </section>
  );
}

type FormProps = { snapshot: ViewSnapshot; session: ModelSession; onDone(): void };

function Actions({ pending, error, label, onCancel }: { pending: boolean; error: string; label: string; onCancel(): void }) {
  return (
    <>
      <div className="model-edit-actions">
        <button type="submit" className="model-edit-primary" disabled={pending}>{pending ? "Committing…" : label}</button>
        <button type="button" onClick={onCancel} disabled={pending}>Cancel</button>
      </div>
      {error && <p role="alert" className="model-edit-error">{error}</p>}
    </>
  );
}

function BlockFields({
  snapshot,
  values,
  onChange,
  brief = false,
}: {
  snapshot: ViewSnapshot;
  /** Only what a new block needs; the description can be filled in later. */
  brief?: boolean;
  values: { name: string; kind: string; owner: string; maturity: string; summary: string; responsibilities: string };
  onChange(field: string, value: string): void;
}) {
  const kinds = useMemo(() => kindsOf(snapshot), [snapshot]);
  return (
    <>
      <label>
        <span>Name</span>
        <input value={values.name} onChange={(event) => onChange("name", event.target.value)} required maxLength={80} />
      </label>
      <div className="model-edit-pair">
        <label>
          <span>Kind</span>
          <input value={values.kind} onChange={(event) => onChange("kind", event.target.value)} list="model-kinds" required maxLength={40} />
          <datalist id="model-kinds">{kinds.map((kind) => <option key={kind} value={kind} />)}</datalist>
        </label>
        <label>
          <span>Maturity</span>
          <select value={values.maturity} onChange={(event) => onChange("maturity", event.target.value)}>
            {MATURITY_ORDER.map((value) => <option key={value} value={value}>{MATURITY_LABEL[value]}</option>)}
          </select>
        </label>
      </div>
      <label>
        <span>Owner</span>
        <select value={values.owner} onChange={(event) => onChange("owner", event.target.value)}>
          {Object.entries(snapshot.owners).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      {!brief && (
        <>
          <label>
            <span>Summary</span>
            <textarea value={values.summary} onChange={(event) => onChange("summary", event.target.value)} maxLength={600} rows={3} />
          </label>
          <label>
            <span>Responsibilities, one per line</span>
            <textarea value={values.responsibilities} onChange={(event) => onChange("responsibilities", event.target.value)} rows={4} />
          </label>
        </>
      )}
    </>
  );
}

function BlockFieldsForm({ snapshot, block, session, onDone }: FormProps & { block: ViewBlock }) {
  const [values, setValues] = useState({
    name: block.name,
    kind: block.kind,
    owner: block.owner,
    maturity: block.maturity as string,
    summary: block.summary,
    responsibilities: block.responsibilities.join("\n"),
  });
  const { run, pending, error } = useModelEdit(session);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const responsibilities = lines(values.responsibilities);
    const fields: Extract<ModelEdit, { op: "updateBlock" }>["fields"] = {};
    if (values.name.trim() !== block.name) fields.name = values.name.trim();
    if (values.kind.trim() !== block.kind) fields.kind = values.kind.trim();
    if (values.owner !== block.owner) fields.owner = values.owner;
    if (values.maturity !== block.maturity) fields.maturity = values.maturity as (typeof MATURITY_ORDER)[number];
    if (values.summary.trim() !== block.summary) fields.summary = values.summary.trim();
    if (responsibilities.join("\n") !== block.responsibilities.join("\n")) fields.responsibilities = responsibilities;
    if (!Object.keys(fields).length) return onDone();
    run({ op: "updateBlock", id: block.id, fields }, undefined, onDone);
  }

  return (
    <form className="model-edit-form" onSubmit={submit}>
      <BlockFields snapshot={snapshot} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
      <Actions pending={pending} error={error} label="Commit to branch" onCancel={onDone} />
    </form>
  );
}

function AddBlockForm({ snapshot, parent, session, onDone }: FormProps & { parent: ViewBlock }) {
  const [values, setValues] = useState({ name: "", kind: "module", owner: parent.owner, maturity: "proposal", summary: "", responsibilities: "" });
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const { run, pending, error } = useModelEdit(session);
  const blockId = idTouched ? id : slugify(values.name);
  const taken = Boolean(blockId && snapshot.blocks[blockId]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    run(
      {
        op: "addBlock",
        parent: parent.id,
        id: blockId,
        name: values.name.trim(),
        kind: values.kind.trim(),
        owner: values.owner,
        maturity: values.maturity as (typeof MATURITY_ORDER)[number],
      },
      blockId,
      onDone,
    );
  }

  return (
    <form className="model-edit-form" onSubmit={submit}>
      <p className="model-edit-note">A new block inside <strong>{parent.name}</strong>. Atlas places it in free space on {parent.name}&rsquo;s canvas.</p>
      <BlockFields brief snapshot={snapshot} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
      <label>
        <span>ID {taken && <em className="model-edit-error">already used</em>}</span>
        <input
          value={blockId}
          onChange={(event) => {
            setIdTouched(true);
            setId(slugify(event.target.value));
          }}
          pattern="[a-z0-9][a-z0-9\-]*"
          required
          maxLength={63}
        />
      </label>
      <Actions pending={pending || taken} error={error} label="Add block" onCancel={onDone} />
    </form>
  );
}

type Direction = "out" | "in" | "both";

function ConnectForm({ snapshot, block, session, onDone }: FormProps & { block: ViewBlock }) {
  // Only blocks drawn on a canvas together with this one: a connection
  // between blocks never shown side by side could not be drawn.
  const peers = useMemo(() => {
    const ids = new Set<string>();
    for (const layout of Object.values(snapshot.layouts)) {
      if (!layout.nodes[block.id]) continue;
      for (const id of Object.keys(layout.nodes)) if (id !== block.id && snapshot.changes?.blocks[id] !== "removed") ids.add(id);
    }
    return [...ids].map((id) => snapshot.blocks[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot, block.id]);
  const protocols = Object.entries(snapshot.protocols).filter(([id]) => id !== "containment");

  const [peer, setPeer] = useState(peers[0]?.id ?? "");
  const [protocol, setProtocol] = useState(protocols[0]?.[0] ?? "");
  const [direction, setDirection] = useState<Direction>("out");
  const [label, setLabel] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [peerPort, setPeerPort] = useState("");
  const { run, pending, error } = useModelEdit(session);

  const portsOf = (id: string) => (snapshot.ports[id] ?? []).filter((port) => port.protocol === protocol);

  if (!peers.length) {
    return <p className="model-edit-note">No other block is drawn on a canvas with {block.name}, so there is nothing to connect it to here.</p>;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const outbound = direction !== "in";
    run(
      {
        op: "addConnection",
        from: outbound ? block.id : peer,
        to: outbound ? peer : block.id,
        fromPort: (outbound ? localPort : peerPort) || undefined,
        toPort: (outbound ? peerPort : localPort) || undefined,
        protocol,
        label: label.trim(),
        bidirectional: direction === "both",
      },
      undefined,
      onDone,
    );
  }

  const portSelect = (owner: ViewBlock | undefined, value: string, set: (value: string) => void) => (
    <label>
      <span>Port on {owner?.name ?? "peer"}</span>
      <select value={value} onChange={(event) => set(event.target.value)}>
        <option value="">New port, placed automatically</option>
        {owner && portsOf(owner.id).map((port) => <option key={port.id} value={port.id}>{port.label} ({port.side})</option>)}
      </select>
    </label>
  );

  return (
    <form className="model-edit-form" onSubmit={submit}>
      <label>
        <span>Connect {block.name} with</span>
        <select value={peer} onChange={(event) => { setPeer(event.target.value); setPeerPort(""); }}>
          {peers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <div className="model-edit-pair">
        <label>
          <span>Protocol</span>
          <select value={protocol} onChange={(event) => { setProtocol(event.target.value); setLocalPort(""); setPeerPort(""); }}>
            {protocols.map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>Direction</span>
          <select value={direction} onChange={(event) => setDirection(event.target.value as Direction)}>
            <option value="out">From {block.name}</option>
            <option value="in">Into {block.name}</option>
            <option value="both">Both ways</option>
          </select>
        </label>
      </div>
      <label>
        <span>Label</span>
        <input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={80} placeholder="What travels on it" />
      </label>
      {portSelect(block, localPort, setLocalPort)}
      {portSelect(snapshot.blocks[peer], peerPort, setPeerPort)}
      <Actions pending={pending} error={error} label="Add connection" onCancel={onDone} />
    </form>
  );
}

function RemoveBlock({ snapshot, block, session, onDone }: FormProps & { block: ViewBlock }) {
  const { run, pending, error } = useModelEdit(session);
  const links = snapshot.connections.filter((item) => item.from === block.id || item.to === block.id).length;
  return (
    <form
      className="model-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        run({ op: "removeBlock", id: block.id }, block.parent, onDone);
      }}
    >
      <p className="model-edit-note">
        Remove <strong>{block.name}</strong>
        {links ? ` and its ${links} connection${links === 1 ? "" : "s"}` : ""} from this branch? It stays in the published model until a change request merges.
      </p>
      <Actions pending={pending} error={error} label="Remove block" onCancel={onDone} />
    </form>
  );
}

/** Rename or remove one connection, from the inspector's connection list. */
export function ConnectionEditor({ connection, session }: { connection: ViewConnection; session: ModelSession }) {
  const [mode, setMode] = useState<"rename" | "remove" | null>(null);
  const [label, setLabel] = useState(connection.label);
  const { run, pending, error } = useModelEdit(session);
  const close = () => setMode(null);

  if (!mode) {
    return (
      <span className="edge-tools">
        <button type="button" onClick={() => setMode("rename")} aria-label={`Rename connection ${connection.label}`}>Rename</button>
        <button type="button" className="danger" onClick={() => setMode("remove")} aria-label={`Remove connection ${connection.label}`}>Remove</button>
      </span>
    );
  }
  return (
    <form
      className="model-edit-form edge-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (mode === "remove") run({ op: "removeConnection", id: connection.id }, undefined, close);
        else if (label.trim() === connection.label) close();
        else run({ op: "updateConnection", id: connection.id, label: label.trim() }, undefined, close);
      }}
    >
      {mode === "rename" ? (
        <label>
          <span>Label</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={80} autoFocus />
        </label>
      ) : (
        <p className="model-edit-note">Remove this connection? Ports that only it used go too.</p>
      )}
      <Actions pending={pending} error={error} label={mode === "remove" ? "Remove" : "Rename"} onCancel={close} />
    </form>
  );
}
