import assert from "node:assert/strict";
import test from "node:test";
import { rebaseEntities } from "./workspace-rebase";

type Item = { id: string | null; value: string };
const item = (id: string | null, value: string): Item => ({ id, value });

test("an untouched list returns the caller's list as-is, order included", () => {
  const base = [item("a", "1"), item("b", "1")];
  const desired = [base[1]!, { ...base[0]!, value: "2" }];
  assert.deepEqual(rebaseEntities(base, desired, structuredClone(base)), desired);
});

test("a stale write keeps a newer save of an entity it did not touch", () => {
  const base = [item("a", "old"), item("b", "old")];
  const latest = [item("a", "saved elsewhere"), item("b", "old")];
  const desired = [base[0]!, { ...base[1]!, value: "mine" }];
  assert.deepEqual(rebaseEntities(base, desired, latest), [item("a", "saved elsewhere"), item("b", "mine")]);
});

test("the caller's edit to a field wins over a newer value of that field", () => {
  const base = [item("a", "old")];
  const latest = [item("a", "newer")];
  assert.deepEqual(rebaseEntities(base, [item("a", "mine")], latest), [item("a", "mine")]);
});

test("additions and removals apply on top of entities created meanwhile", () => {
  const base = [item("a", "1"), item("b", "1")];
  const latest = [item("a", "1"), item("b", "1"), item("c", "added elsewhere")];
  const desired = [base[0]!, item("d", "new")];
  assert.deepEqual(rebaseEntities(base, desired, latest), [item("a", "1"), item("c", "added elsewhere"), item("d", "new")]);
});

test("an entity deleted elsewhere is not resurrected by an unrelated stale write", () => {
  const base = [item("a", "1"), item("b", "1")];
  const latest = [item("b", "1")];
  const desired = [base[0]!, { ...base[1]!, value: "2" }];
  assert.deepEqual(rebaseEntities(base, desired, latest), [item("b", "2")]);
});

test("rebuilt but unchanged objects do not count as edits", () => {
  const base = [item("a", "old")];
  const latest = [item("a", "newer")];
  assert.deepEqual(rebaseEntities(base, [item("a", "old")], latest), [item("a", "newer")]);
});

test("concurrent edits to different fields of one entity both survive", () => {
  type Note = { id: string; body: string; importance: number };
  const before: Note = { id: "a", body: "old", importance: 2 };
  const latest: Note[] = [{ id: "a", body: "typed text", importance: 2 }];
  const desired: Note[] = [{ ...before, importance: 1 }];
  assert.deepEqual(rebaseEntities([before], desired, latest), [{ id: "a", body: "typed text", importance: 1 }]);
});

test("key order does not make an untouched field look edited", () => {
  const base = [{ id: "a", a: 1, b: 2 }];
  const desired = [{ id: "a", b: 2, a: 1 }];
  const latest = [{ id: "a", a: 1, b: 3 }];
  assert.deepEqual(rebaseEntities(base, desired, latest), [{ id: "a", a: 1, b: 3 }]);
});

test("rebuilt id-less entries are not duplicated", () => {
  const base = [item(null, "x"), item("b", "1")];
  const latest = [item(null, "x"), item("b", "2")];
  const desired = [item(null, "x"), item("b", "1")];
  assert.deepEqual(rebaseEntities(base, desired, latest), [item(null, "x"), item("b", "2")]);
});