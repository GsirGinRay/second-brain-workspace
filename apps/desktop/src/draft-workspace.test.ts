import assert from "node:assert/strict";
import test from "node:test";
import { DRAFT_WORKSPACE_KEY, loadDraftWorkspace, saveDraftWorkspace } from "./draft-workspace";

test("draft workspace persists valid beginner content and discards malformed items", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  saveDraftWorkspace({ tasks: [{
    schemaVersion: 6, id: "11111111-1111-4111-8111-111111111111", title: "Draft", status: "todo",
    taskDate: null, priority: "normal", projectId: null, projectName: null, rank: "a",
    sourcePath: null, sourceHeading: null, completedAt: null, body: "## Notes",
  }], projects: [], collections: [] }, storage);
  const raw = JSON.parse(values.get(DRAFT_WORKSPACE_KEY)!);
  raw.tasks.push({ nope: true });
  values.set(DRAFT_WORKSPACE_KEY, JSON.stringify(raw));
  assert.equal(loadDraftWorkspace(storage).tasks[0]?.body, "## Notes");
  assert.equal(loadDraftWorkspace(storage).tasks.length, 1);
});
