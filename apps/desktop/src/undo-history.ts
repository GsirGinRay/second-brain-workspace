import type {
  BrainCollectionSnapshot,
  BrainProjectSnapshot,
  BrainTaskSnapshot,
} from "@second-brain/brain-core";

/**
 * Snapshot of the whole local workspace at a moment in time. Every mutation that
 * reaches Markdown goes through one funnel (persistLocal), so restoring a whole
 * snapshot is simpler and safer than replaying per-field patches — an undone
 * drag restores the exact date/time/lane/rank values the task had before it.
 */
export interface WorkspaceSnapshot {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  collections: BrainCollectionSnapshot[];
}

export interface UndoState {
  past: WorkspaceSnapshot[];
  future: WorkspaceSnapshot[];
}

/** Bounds memory; each entry is a plain-data snapshot, so 100 covers a long session. */
export const UNDO_LIMIT = 100;

export function emptyUndoState(): UndoState {
  return { past: [], future: [] };
}

function sameSnapshot(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return (
    JSON.stringify(left.tasks) === JSON.stringify(right.tasks) &&
    JSON.stringify(left.projects) === JSON.stringify(right.projects) &&
    JSON.stringify(left.collections) === JSON.stringify(right.collections)
  );
}

/**
 * Record `present` as a restorable point. Called with the state *before* a
 * successful write; no-op when nothing actually changed so failed or identical
 * writes never pollute the history. A new entry discards the redo branch.
 */
export function recordUndo(
  state: UndoState,
  present: WorkspaceSnapshot,
): UndoState {
  const last = state.past.at(-1);
  if (last && sameSnapshot(last, present)) return state;
  const past = [...state.past, present];
  while (past.length > UNDO_LIMIT) past.shift();
  return { past, future: [] };
}

export function canUndo(state: UndoState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: UndoState): boolean {
  return state.future.length > 0;
}

/**
 * Step back: returns the snapshot to restore plus the next history state.
 * The current workspace moves onto the redo stack so redo can reverse the undo.
 * Returns `snapshot: null` when there is nothing to undo.
 */
export function applyUndo(
  state: UndoState,
  present: WorkspaceSnapshot,
): { next: UndoState; snapshot: WorkspaceSnapshot | null } {
  const snapshot = state.past.at(-1);
  if (!snapshot) return { next: state, snapshot: null };
  const future = [present, ...state.future];
  while (future.length > UNDO_LIMIT) future.pop();
  return { next: { past: state.past.slice(0, -1), future }, snapshot };
}

/** Step forward again after an undo; `snapshot: null` when nothing to redo. */
export function applyRedo(
  state: UndoState,
  present: WorkspaceSnapshot,
): { next: UndoState; snapshot: WorkspaceSnapshot | null } {
  const snapshot = state.future[0];
  if (!snapshot) return { next: state, snapshot: null };
  const past = [...state.past, present];
  while (past.length > UNDO_LIMIT) past.shift();
  return { next: { past, future: state.future.slice(1) }, snapshot };
}
