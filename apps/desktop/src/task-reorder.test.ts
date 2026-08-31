import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  movedIds,
  reorderDisplayed,
  reorderTodayTray,
  reorderTodayTrayBatch,
  todayTraySegmentKey,
  withReassignedRanks,
} from "./task-reorder";

function task(id: string, overrides: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot {
  return {
    schemaVersion: 6,
    id,
    title: id,
    sourcePath: null,
    status: "todo",
    taskDate: "2026-08-20",
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

test("reorderDisplayed moves a card before or after the drop target", () => {
  const ids = (items: { id?: string | null }[] | null) => items?.map((item) => item.id);
  assert.deepEqual(ids(reorderDisplayed([{ id: "a" }, { id: "b" }, { id: "c" }], "a", "c", "before")), ["b", "a", "c"]);
  assert.deepEqual(ids(reorderDisplayed([{ id: "a" }, { id: "b" }, { id: "c" }], "a", "b", "after")), ["b", "a", "c"]);
  assert.deepEqual(ids(reorderDisplayed([{ id: "a" }, { id: "b" }], "b", "a", "before")), ["b", "a"]);
});

test("reorderDisplayed rejects impossible or no-op drops", () => {
  const list = [{ id: "a" }, { id: "b" }];
  assert.equal(reorderDisplayed(list, null, "b", "before"), null);
  assert.equal(reorderDisplayed(list, "a", null, "before"), null);
  assert.equal(reorderDisplayed(list, "a", "a", "before"), null);
  assert.equal(reorderDisplayed(list, "a", "missing", "before"), null);
  // a is already directly before b
  assert.equal(reorderDisplayed(list, "a", "b", "before"), null);
});

const TODAY = "2026-08-20";

test("today tray drags only reorder inside one priority/date group", () => {
  const tray = [
    task("p1a", { priority: "highest" }),
    task("p1b", { priority: "highest" }),
    task("p1c", { priority: "highest" }),
    task("p4a", { priority: "normal" }),
    task("overdue", { priority: "normal", taskDate: "2026-08-18" }),
  ];
  // P4 dropped onto a P1 card cannot stick: sorting keeps priority groups apart.
  assert.equal(reorderTodayTray(tray, TODAY, "p4a", "p1a", "before"), null);
  // Within the P1 group the order follows the drop.
  const next = reorderTodayTray(tray, TODAY, "p1a", "p1c", "after");
  assert.ok(next);
  assert.deepEqual(next!.map((item) => item.id), ["p1b", "p1c", "p1a", "p4a", "overdue"]);
  // Overdue and today buckets stay separated even at the same priority.
  assert.equal(todayTraySegmentKey(tray[3]!, TODAY), todayTraySegmentKey(task("x"), TODAY));
  assert.notEqual(
    todayTraySegmentKey(tray[4]!, TODAY),
    todayTraySegmentKey(tray[3]!, TODAY),
  );
});

test("withReassignedRanks patches only the listed tasks", () => {
  const tasks = [task("a", { rank: "00000009" }), task("b", { rank: "00000004" }), task("c")];
  const next = withReassignedRanks(tasks, ["b", "a"]);
  assert.equal(next.find((item) => item.id === "b")!.rank, "00000000");
  assert.equal(next.find((item) => item.id === "a")!.rank, "00000001");
  assert.equal(next.find((item) => item.id === "c")!.rank, "00000000", "unlisted ranks stay untouched");
  assert.deepEqual(withReassignedRanks(tasks, []), tasks);
});

test("reorderTodayTrayBatch moves the whole selected group as one block", () => {
  const tray = [
    task("p1a", { priority: "highest" }),
    task("p1b", { priority: "highest" }),
    task("p1c", { priority: "highest" }),
    task("p4a", { priority: "normal" }),
  ];
  // Selecting p1a+p1b and dropping them after p1c keeps the pair together.
  const next = reorderTodayTrayBatch(tray, TODAY, ["p1a", "p1b"], "p1c", "after");
  assert.ok(next);
  assert.deepEqual(next!.map((item) => item.id), ["p1c", "p1a", "p1b", "p4a"]);
  // Dropping before keeps the pair's internal order too.
  const before = reorderTodayTrayBatch(tray, TODAY, ["p1a", "p1b"], "p1c", "before");
  assert.deepEqual(before!.map((item) => item.id), ["p1a", "p1b", "p1c", "p4a"]);
});

test("reorderTodayTrayBatch ignores cross-group members and no-op drops", () => {
  const tray = [
    task("p1a", { priority: "highest" }),
    task("p1b", { priority: "highest" }),
    task("p1c", { priority: "highest" }),
    task("overdue", { priority: "highest", taskDate: "2026-08-18" }),
  ];
  // The overdue card in the selection does not travel into the P1 group;
  // only the members of the dragged task's own group move.
  const next = reorderTodayTrayBatch(tray, TODAY, ["p1a", "overdue"], "p1c", "after");
  assert.ok(next);
  assert.deepEqual(next!.map((item) => item.id), ["p1b", "p1c", "p1a", "overdue"]);
  // Dropping the group onto one of its own members changes nothing.
  assert.equal(reorderTodayTrayBatch(tray, TODAY, ["p1a", "p1b"], "p1b", "after"), null);
  // A single-member selection delegates to the plain single reorder.
  const single = reorderTodayTrayBatch(tray, TODAY, ["p1a"], "p1c", "after");
  assert.deepEqual(single!.map((item) => item.id), reorderTodayTray(tray, TODAY, "p1a", "p1c", "after")!.map((item) => item.id));
});

test("movedIds reports which rows actually changed position", () => {
  const before = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const after = reorderDisplayed(before, "c", "a", "before")!;
  assert.deepEqual(after.map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(movedIds(before, after), ["c", "a", "b"]);
  // A no-op drop leaves every row in place.
  const same = reorderDisplayed(before, "a", "b", "before") ?? before;
  assert.deepEqual(movedIds(before, same), []);
});
