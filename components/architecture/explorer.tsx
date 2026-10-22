"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import type { ViewSnapshot } from "@/lib/model/view";
import { ChangesPanel } from "./changes-panel";
import { DiagramCanvas } from "./diagram-canvas";
import { Inspector } from "./inspector";
import { LensControls, SequenceStepDetail } from "./lens-controls";
import { useModelSession } from "./model-session";
import { OutlineTree } from "./outline-tree";
import { lensFromParams, lensToParams, type Lens } from "./lens";
import type { Insets } from "./use-camera";

/** What the viewer may change, and where. Absent for readers. */
export type ModelEditContext = {
  branch: string;
  /** The model blob on screen; an edit made from a stale one is refused. */
  blobSha: string;
  /** On the published branch, editing starts by creating a branch. */
  onDefault: boolean;
};

type Props = {
  snapshot: ViewSnapshot;
  initialSelectedId: string | null;
  initialLens: Lens;
  /** The version being viewed, as query parameters every URL keeps. */
  versionQuery?: string;
  editing?: ModelEditContext | null;
};

function ancestorsOf(snapshot: ViewSnapshot, blockId: string | null): string[] {
  const chain: string[] = [];
  let cursor = blockId ? snapshot.blocks[blockId]?.parent ?? null : null;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    chain.push(cursor);
    cursor = snapshot.blocks[cursor]?.parent ?? null;
  }
  return chain;
}

/**
 * What the explorer was showing, per version. The refresh after an edit can
 * remount it (the address names the selected block, so the page segment
 * changes), and this is what brings it back exactly as it was: the same
 * canvas, outline, and panels, and the block an edit asked to select.
 */
type Remembered = {
  focusId: string;
  expanded: string[];
  outlineCollapsed: boolean;
  inspectorCollapsed: boolean;
  panelsHidden: boolean;
  showChanges: boolean;
  pendingSelect: string | null;
};
const remembered = new Map<string, Remembered>();

/** The canvas to open on: the remembered one while it still shows the selection, else the selection's own. */
function startingFocus(snapshot: ViewSnapshot, memory: Remembered | undefined, selectedId: string | null) {
  const home = selectedId ? snapshot.blocks[selectedId]?.focusId ?? snapshot.product.defaultFocus : snapshot.product.defaultFocus;
  const layout = memory ? snapshot.layouts[memory.focusId] : undefined;
  if (!memory || !layout) return home;
  if (!selectedId || selectedId === memory.focusId || layout.nodes[selectedId]) return memory.focusId;
  return home;
}

/**
 * The architecture explorer.
 *
 * Selection and focus are deliberately separate pieces of state. Selecting a
 * block always succeeds and only moves the inspector; focus — which authored
 * canvas is drawn — changes only when you enter a composite or arrive at a
 * block the current canvas does not contain. That split is what removes the
 * dead "Down" control from 81 of the 97 blocks.
 *
 * State is mirrored into the URL with history.pushState rather than a router
 * navigation, so back/forward and sharing work without remounting the canvas
 * and losing pan/zoom.
 */
export function Explorer({ snapshot, initialSelectedId, initialLens, versionQuery = "", editing = null }: Props) {
  const router = useRouter();
  const [memory] = useState(() => remembered.get(versionQuery));
  // A block an edit asked to select (one just added) wins over the address,
  // which still names the selection from before the edit.
  const [startSelected] = useState(() =>
    memory?.pendingSelect && snapshot.blocks[memory.pendingSelect] ? memory.pendingSelect : initialSelectedId,
  );
  const [selectedId, setSelectedId] = useState<string | null>(startSelected);
  const [lens, setLens] = useState<Lens>(initialLens);
  const [focusId, setFocusId] = useState<string>(() => startingFocus(snapshot, memory, startSelected));
  // Two booleans because the control means different things per breakpoint:
  // on desktop the outline is a column that can be collapsed for canvas room,
  // on narrow screens it is a drawer that starts closed.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(memory?.outlineCollapsed ?? false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(memory?.inspectorCollapsed ?? false);
  // ⌘\ hides every panel at once, as in Figma, without forgetting which were open.
  const [panelsHidden, setPanelsHidden] = useState(memory?.panelsHidden ?? false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([...(memory?.expanded ?? snapshot.rootIds), ...ancestorsOf(snapshot, startSelected)]),
  );

  const toggleExpanded = useCallback((blockId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);

  /** Open the outline down to a block so a selection is never hidden. */
  const reveal = useCallback(
    (blockId: string) => {
      setExpanded((current) => {
        const chain = ancestorsOf(snapshot, blockId);
        if (chain.every((id) => current.has(id))) return current;
        return new Set([...current, ...chain]);
      });
    },
    [snapshot],
  );

  const pushUrl = useCallback((blockId: string | null, nextLens: Lens) => {
    if (typeof window === "undefined") return;
    const params = lensToParams(nextLens);
    for (const [key, value] of new URLSearchParams(versionQuery)) params.set(key, value);
    const query = params.toString();
    const url = `/architecture${blockId ? `/${blockId}` : ""}${query ? `?${query}` : ""}`;
    if (url === window.location.pathname + window.location.search) return;
    window.history.pushState({ blockId, lens: nextLens }, "", url);
  }, [versionQuery]);

  const select = useCallback(
    (blockId: string) => {
      const block = snapshot.blocks[blockId];
      if (!block) return;
      setSelectedId(blockId);
      // Only move the canvas when the current one cannot show the block.
      setFocusId((current) => (snapshot.layouts[current]?.nodes[blockId] ? current : block.focusId));
      reveal(blockId);
      setOutlineOpen(false);
      pushUrl(blockId, lens);
    },
    [snapshot, lens, pushUrl, reveal],
  );

  const deselect = useCallback(() => {
    setSelectedId(null);
    pushUrl(null, lens);
  }, [lens, pushUrl]);

  /**
   * How much of the canvas the floating panels cover, so framing and
   * revealing keep blocks out from under them. Measured rather than assumed,
   * because the panels change shape at each breakpoint.
   */
  const insets = useCallback((): Insets => {
    const stage = stageRef.current?.getBoundingClientRect();
    const none = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!stage) return none;
    const covered = (element: HTMLElement | null) => {
      const rect = element?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      const overlaps = rect.left < stage.right && rect.right > stage.left && rect.top < stage.bottom && rect.bottom > stage.top;
      return overlaps ? rect : null;
    };
    const outline = covered(outlineRef.current);
    const inspector = covered(inspectorRef.current);
    return {
      ...none,
      left: outline ? Math.max(0, outline.right - stage.left) : 0,
      right: inspector ? Math.max(0, stage.right - inspector.left) : 0,
    };
  }, []);

  const enter = useCallback(
    (blockId: string) => {
      if (!snapshot.layouts[blockId]) return;
      setFocusId(blockId);
      setSelectedId(blockId);
      reveal(blockId);
      pushUrl(blockId, lens);
    },
    [snapshot.layouts, lens, pushUrl, reveal],
  );

  const trail = useMemo(() => {
    const chain: string[] = [];
    let cursor: string | null = focusId;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      chain.unshift(cursor);
      cursor = snapshot.blocks[cursor]?.parent ?? null;
    }
    return chain;
  }, [focusId, snapshot.blocks]);

  const parentFocus = useMemo(() => {
    let cursor = snapshot.blocks[focusId]?.parent ?? null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      if (snapshot.layouts[cursor]) return cursor;
      cursor = snapshot.blocks[cursor]?.parent ?? null;
    }
    return null;
  }, [focusId, snapshot]);

  const leave = useCallback(() => {
    if (!parentFocus) return;
    setFocusId(parentFocus);
    setSelectedId(parentFocus);
    reveal(parentFocus);
    pushUrl(parentFocus, lens);
  }, [parentFocus, lens, pushUrl, reveal]);

  const changeLens = useCallback(
    (next: Lens) => {
      setLens(next);
      pushUrl(selectedId, next);
    },
    [selectedId, pushUrl],
  );

  const [showChanges, setShowChanges] = useState(memory?.showChanges ?? true);
  // After an edit the server sends a new snapshot. The block to select next
  // (one just added, or the parent of one just removed) waits until it is in it.
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const edited = useCallback(
    (nextSelection?: string | null) => {
      if (nextSelection !== undefined) {
        setPendingSelect(nextSelection);
        // Written straight through too: the refresh may remount before an effect runs.
        const saved = remembered.get(versionQuery);
        if (saved) saved.pendingSelect = nextSelection;
      }
      router.refresh();
    },
    [router, versionQuery],
  );

  useEffect(() => {
    remembered.set(versionQuery, {
      focusId,
      expanded: [...expanded],
      outlineCollapsed,
      inspectorCollapsed,
      panelsHidden,
      showChanges,
      pendingSelect,
    });
  }, [versionQuery, focusId, expanded, outlineCollapsed, inspectorCollapsed, panelsHidden, showChanges, pendingSelect]);

  // A selection handed over from before a remount is not in the address yet.
  useEffect(() => {
    if (startSelected !== initialSelectedId) pushUrl(startSelected, lens);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = useModelSession(editing, edited);

  // Adjusted while rendering rather than in an effect, so the canvas never
  // draws a frame with a selection or focus the new snapshot lacks.
  const [seenSnapshot, setSeenSnapshot] = useState(snapshot);
  if (seenSnapshot !== snapshot) {
    setSeenSnapshot(snapshot);
    const next = pendingSelect && snapshot.blocks[pendingSelect] ? pendingSelect : null;
    if (next) {
      setPendingSelect(null);
      setSelectedId(next);
      setFocusId(snapshot.layouts[focusId]?.nodes[next] ? focusId : snapshot.blocks[next].focusId);
      setExpanded((current) => new Set([...current, ...ancestorsOf(snapshot, next)]));
    } else {
      if (selectedId && !snapshot.blocks[selectedId]) setSelectedId(null);
      if (!snapshot.layouts[focusId]) setFocusId(snapshot.product.defaultFocus);
    }
  }

  // The address bar follows a selection an edit made.
  const firstSnapshot = useRef(snapshot);
  useEffect(() => {
    if (seenSnapshot === firstSnapshot.current) return;
    pushUrl(selectedId, lens);
    // Only after a new snapshot; selections made by hand push their own URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenSnapshot]);

  // Back/forward restores both selection and lens from the URL itself, which
  // keeps the address bar authoritative rather than a decoration.
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname.replace(/^\/architecture\/?/, "");
      const blockId = path ? decodeURIComponent(path) : null;
      const nextLens = lensFromParams(new URLSearchParams(window.location.search));
      setLens(nextLens);
      setSelectedId(blockId && snapshot.blocks[blockId] ? blockId : null);
      if (blockId && snapshot.blocks[blockId]) {
        setFocusId((current) => (snapshot.layouts[current]?.nodes[blockId] ? current : snapshot.blocks[blockId].focusId));
        reveal(blockId);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [snapshot, reveal]);

  // Global shortcuts: "/" jumps to the outline filter, Alt+Up leaves the canvas.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setOutlineOpen(true);
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".outline-search input")?.focus();
        });
        return;
      }
      if (session?.canUndo && !typing && (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        session.undo();
        return;
      }
      if (event.key === "ArrowUp" && event.altKey) {
        event.preventDefault();
        leave();
        return;
      }
      if (event.key === "\\" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPanelsHidden((hidden) => !hidden);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leave, session]);

  const outlineHidden = panelsHidden || outlineCollapsed;
  const inspectorHidden = panelsHidden || inspectorCollapsed;

  return (
    <div
      className={`explorer${outlineOpen ? " outline-open" : ""}${outlineHidden ? " outline-collapsed" : ""}${inspectorHidden ? " inspector-collapsed" : ""}`}
    >
      <div className="explorer-bar">
        <button
          className="bar-toggle"
          type="button"
          aria-expanded={!outlineHidden || outlineOpen}
          aria-label={outlineHidden ? "Show the outline" : "Hide the outline"}
          title="Outline"
          onClick={() => {
            setPanelsHidden(false);
            setOutlineOpen((open) => !open);
            setOutlineCollapsed(!outlineHidden);
          }}
        >
          <Icon name="sidebar" aria-hidden="true" />
        </button>

        <nav className="trail" aria-label="Canvas location">
          {trail.map((id, index) => {
            const block = snapshot.blocks[id];
            if (!block) return null;
            const isLast = index === trail.length - 1;
            const drawable = Boolean(snapshot.layouts[id]);
            return (
              <span key={id}>
                {index > 0 && <Icon name="chevron" aria-hidden="true" />}
                {isLast || !drawable ? (
                  <b aria-current={isLast ? "true" : undefined}>{block.name}</b>
                ) : (
                  <button type="button" onClick={() => enter(id)}>
                    {block.name}
                  </button>
                )}
              </span>
            );
          })}
        </nav>

        <LensControls snapshot={snapshot} lens={lens} onLens={changeLens} />

        <button
          className="bar-toggle mirrored"
          type="button"
          aria-expanded={!inspectorHidden}
          aria-label={inspectorHidden ? "Show the inspector" : "Hide the inspector"}
          title="Inspector"
          onClick={() => {
            setPanelsHidden(false);
            setInspectorCollapsed(!inspectorHidden);
          }}
        >
          <Icon name="sidebar" aria-hidden="true" />
        </button>
      </div>

      <div className="explorer-body">
        <div className="explorer-stage" ref={stageRef}>
          <DiagramCanvas
            snapshot={snapshot}
            focusId={focusId}
            selectedId={selectedId}
            lens={lens}
            onSelect={select}
            onDeselect={deselect}
            onEnter={enter}
            onLeave={leave}
            canLeave={Boolean(parentFocus)}
            showChanges={showChanges}
            session={session}
            insets={insets}
          />
          <div className="stage-overlays">
            {snapshot.changes && (
              <ChangesPanel snapshot={snapshot} shown={showChanges} onToggle={() => setShowChanges((shown) => !shown)} onSelect={select} />
            )}
            <SequenceStepDetail snapshot={snapshot} lens={lens} />
          </div>
          {session && (session.pending > 0 || session.last || session.error) && (
            <div
              // A success fades on its own (Undo stays in the toolbar); an error waits to be dismissed.
              key={session.error || session.pending ? "busy" : session.last}
              className={`canvas-edit-status${session.error ? " error" : session.pending ? "" : " done"}`}
              role="status"
            >
              {session.error ? (
                <>
                  <span>{session.error}</span>
                  <button type="button" onClick={session.dismiss}>Dismiss</button>
                </>
              ) : session.pending > 0 ? (
                <span>Committing to {editing?.branch}…</span>
              ) : (
                <>
                  <span>{session.last}</span>
                  {session.canUndo && <button type="button" onClick={session.undo}>Undo</button>}
                </>
              )}
            </div>
          )}
        </div>

        {outlineOpen && <button className="outline-scrim" aria-label="Close outline" onClick={() => setOutlineOpen(false)} />}

        <div className="float-panel outline-panel" ref={outlineRef}>
          <OutlineTree
            snapshot={snapshot}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={toggleExpanded}
            onSelect={select}
          />
        </div>

        <div className="float-panel inspector-panel" ref={inspectorRef} data-scrollable>
          <Inspector
            snapshot={snapshot}
            selectedId={selectedId}
            lens={lens}
            onSelect={select}
            versionQuery={versionQuery}
            editing={editing}
            session={session}
            showChanges={showChanges}
          />
        </div>
      </div>
    </div>
  );
}
