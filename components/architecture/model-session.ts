"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { modelEditAction, modelRestoreAction, type ModelEditResult } from "@/app/(workspace)/architecture/actions";
import type { ModelEdit } from "@/lib/model/edit";
import type { ModelEditContext } from "./explorer";

/**
 * One person's run of edits to the model on a branch.
 *
 * Canvas edits come quickly (drag, drag, drag), and each is a commit that
 * must start from the commit before it. Edits therefore go through a queue,
 * each one sent with the model version the previous one produced, so fast
 * work never trips over itself. The page refreshes once the queue is empty.
 *
 * Undo commits the version from before the last edit back onto the branch.
 *
 * The state lives outside React, one store per branch: the refresh after a
 * commit can remount the explorer (the address names the selected block, so
 * the page segment changes), and the undo history and status must survive it.
 */
export type ModelSession = {
  submit(edit: ModelEdit, select?: string | null): Promise<ModelEditResult>;
  undo(): void;
  canUndo: boolean;
  pending: number;
  /** What the last edit did, for the status line. */
  last: string;
  error: string;
  dismiss(): void;
};

type Step = { before: string; after: string; summary: string };
type View = { pending: number; history: Step[]; last: string; error: string };

type Store = {
  blob: string;
  queue: Promise<unknown>;
  inFlight: number;
  nextSelection: string | null | undefined;
  view: View;
  listeners: Set<() => void>;
  /** The mounted explorer's refresh, replaced whenever one mounts. */
  onSettled: (select?: string | null) => void;
};

const stores = new Map<string, Store>();
const EMPTY: View = { pending: 0, history: [], last: "", error: "" };

function storeFor(branch: string, blobSha: string): Store {
  let store = stores.get(branch);
  if (!store) {
    store = { blob: blobSha, queue: Promise.resolve(), inFlight: 0, nextSelection: undefined, view: EMPTY, listeners: new Set(), onSettled: () => {} };
    stores.set(branch, store);
  }
  return store;
}

function update(store: Store, change: (view: View) => Partial<View>) {
  store.view = { ...store.view, ...change(store.view) };
  for (const listener of store.listeners) listener();
}

export function useModelSession(editing: ModelEditContext | null, onSettled: (select?: string | null) => void): ModelSession | null {
  const branch = editing?.branch ?? "";
  const store = editing ? storeFor(branch, editing.blobSha) : null;
  const storeRef = useRef(store);
  useLayoutEffect(() => {
    storeRef.current = store;
    const target = storeRef.current;
    if (target) target.onSettled = onSettled;
  });

  const view = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (!store) return () => {};
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      [store],
    ),
    () => store?.view ?? EMPTY,
    () => EMPTY,
  );

  // A newer version from the server (someone else's commit, or a reload) is
  // the one to build on, once nothing of ours is still on its way.
  useEffect(() => {
    const target = storeRef.current;
    if (target && editing && !target.inFlight) target.blob = editing.blobSha;
  }, [editing]);

  const enqueue = useCallback(
    (send: (before: string) => Promise<ModelEditResult>, onDone: (result: ModelEditResult, before: string) => void, select?: string | null) => {
      const target = storeRef.current!;
      target.inFlight += 1;
      update(target, (current) => ({ pending: current.pending + 1 }));
      const task = target.queue.then(async () => {
        const before = target.blob;
        const result = await send(before).catch(() => ({ ok: false as const, error: "Atlas could not reach the server. Try again." }));
        if (result.ok) {
          target.blob = result.blobSha;
          update(target, () => ({ last: result.summary, error: "" }));
          if (select !== undefined) target.nextSelection = select;
        } else update(target, () => ({ error: result.error }));
        onDone(result, before);
        return result;
      });
      target.queue = task.finally(() => {
        target.inFlight -= 1;
        update(target, (current) => ({ pending: current.pending - 1 }));
        if (!target.inFlight) {
          const selection = target.nextSelection;
          target.nextSelection = undefined;
          target.onSettled(selection);
        }
      });
      return task;
    },
    [],
  );

  const submit = useCallback(
    (edit: ModelEdit, select?: string | null) =>
      enqueue(
        (before) => modelEditAction({ branch, expectedBlobSha: before, edit }),
        (result, before) => {
          if (!result.ok) return;
          update(storeRef.current!, (current) => ({ history: [...current.history.slice(-29), { before, after: result.blobSha, summary: result.summary }] }));
        },
        select,
      ),
    [branch, enqueue],
  );

  const undo = useCallback(() => {
    const target = storeRef.current;
    const step = target?.view.history.at(-1);
    if (!target || !step) return;
    void enqueue(
      (before) =>
        before === step.after
          ? modelRestoreAction({ branch, expectedBlobSha: before, blobSha: step.before })
          : Promise.resolve({ ok: false as const, error: "Someone changed the model since your last edit, so it cannot be undone here." }),
      (result) => {
        if (result.ok) update(target, (current) => ({ history: current.history.slice(0, -1), last: `Undid: ${step.summary}` }));
      },
    );
  }, [branch, enqueue]);

  const dismiss = useCallback(() => {
    if (storeRef.current) update(storeRef.current, () => ({ error: "" }));
  }, []);

  if (!editing || editing.onDefault) return null;
  return { submit, undo, canUndo: view.history.length > 0, pending: view.pending, last: view.last, error: view.error, dismiss };
}
