import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  applyRedo,
  applyUndo,
  canRedo,
  canUndo,
  emptyUndoState,
  recordUndo,
  UNDO_LIMIT,
  type WorkspaceSnapshot,
} from "./undo-history";

function task(id: string, overrides: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot {
  return {
    schemaVersion: 6,
    id,
    title: id,
    sourcePath: null,
    status: "todo",
    taskDate: null,
    startTime: null,
    durationMinutes: null,
    timeZone: "Asia/Taipei",
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: "00000000",
    sourceHeading: null,
    completedAt: null,
    body: "",
    ...overrides,
  };
}

function snapshot(taskIds: string[]): WorkspaceSnapshot {
  return { tasks: taskIds.map((id) => task(id)), projects: [], collections: [] };
}

test("recordUndo keeps the pre-change state and clears the redo branch", () => {
  let state = emptyUndoState();
  state = recordUndo(state, snapshot(["a"]));
  state = recordUndo(state, snapshot(["a", "b"]));
  assert.deepEqual(state.past.map((item) => item.tasks.map((task) => task.id)), [["a"], ["a", "b"]]);
  const steppedBack = applyUndo(state, snapshot(["a", "b", "c"]));
  state = steppedBack.next;
  state = recordUndo(state, snapshot(["a", "b", "c"]));
  assert.equal(canRedo(state), false, "a new mutation discards redo history");
});

test("recordUndo ignores writes that did not change anything", () => {
  let state = emptyUndoState();
  state = recordUndo(state, snapshot(["a"]));
  const unchanged = recordUndo(state, snapshot(["a"]));
  assert.equal(unchanged.past.length, 1, "identical snapshots collapse");
});

test("undo restores the previous drag result and redo reverses the undo", () => {
  const beforeDrag = snapshot(["a", "b"]);
  let state = recordUndo(emptyUndoState(), beforeDrag);
  const afterDrag = snapshot(["b", "a"]);

  const undone = applyUndo(state, afterDrag);
  assert.ok(undone.snapshot);
  assert.deepEqual(undone.snapshot!.tasks.map((task) => task.id), ["a", "b"]);
  state = undone.next;
  assert.equal(canUndo(state), false);
  assert.equal(canRedo(state), true);

  const redone = applyRedo(state, undone.snapshot!);
  assert.ok(redone.snapshot);
  assert.deepEqual(redone.snapshot!.tasks.map((task) => task.id), ["b", "a"]);
});

test("undo and redo return null when their stacks are empty", () => {
  const state = emptyUndoState();
  assert.equal(applyUndo(state, snapshot(["a"])).snapshot, null);
  assert.equal(applyRedo(state, snapshot(["a"])).snapshot, null);
});

test("history is bounded so a long session cannot grow without limit", () => {
  let state = emptyUndoState();
  for (let index = 0; index < UNDO_LIMIT + 20; index += 1) {
    state = recordUndo(state, snapshot([`task-${index}`]));
  }
  assert.equal(state.past.length, UNDO_LIMIT);
  assert.equal(state.past[0]!.tasks[0]!.id, "task-20", "oldest entries are dropped first");

  // Undoing still walks back through every retained entry.
  let current = snapshot(["latest"]);
  let steps = 0;
  for (;;) {
    const result = applyUndo(state, current);
    if (!result.snapshot) break;
    state = result.next;
    current = result.snapshot;
    steps += 1;
  }
  assert.equal(steps, UNDO_LIMIT);
});
