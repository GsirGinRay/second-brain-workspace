import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { closedProjectIds, nextRecurringDate, resetChecklist, withRecurringFollowUps } from "./recurring-tasks";

const task = (patch: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot => ({
  id: "weekly",
  title: "交週報",
  status: "todo",
  taskDate: "2026-10-19",
  priority: "highest",
  projectId: "p1",
  projectName: "工作",
  rank: "a",
  sourcePath: "專案/工作.md",
  sourceHeading: null,
  completedAt: null,
  startTime: "09:00",
  durationMinutes: 30,
  timeZone: "Asia/Taipei",
  recurrence: "every week on Monday",
  body: "- [x] 整理數據\n- [ ] 寄出",
  ...patch,
});

const done = (patch: Partial<BrainTaskSnapshot> = {}) => task({ status: "done", completedAt: "2026-10-19", ...patch });

test("completing a repeating task adds the next occurrence right after it, in the same file", () => {
  const result = withRecurringFollowUps([task()], [done()], "2026-10-19", { createId: () => "next" });
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], {
    ...task(),
    id: "next",
    taskDate: "2026-10-26",
    priority: "high",
    body: "- [ ] 整理數據\n- [ ] 寄出",
  });
});

test("saving again, or a second save from the same stale render, adds no second copy", () => {
  const first = withRecurringFollowUps([task()], [done()], "2026-10-19", { createId: () => "next" });
  assert.equal(withRecurringFollowUps([task()], first, "2026-10-19", { createId: () => "other" }).length, 2);
  // The vault now has the first save: the task is done and the copy exists.
  const staleSecond = [done(), first[1]!];
  assert.equal(withRecurringFollowUps(first, staleSecond, "2026-10-19", { createId: () => "other" }).length, 2);
});

test("an open copy moved to another day still counts as the next occurrence", () => {
  const moved = task({ id: "copy", taskDate: "2026-10-28" });
  assert.equal(withRecurringFollowUps([task(), moved], [done(), moved], "2026-10-19").length, 2);
});

test("tasks that were already done, are not repeating, are reopened or are new add nothing", () => {
  assert.equal(withRecurringFollowUps([done()], [done()], "2026-10-19").length, 1);
  assert.equal(withRecurringFollowUps([task({ recurrence: null })], [done({ recurrence: null })], "2026-10-19").length, 1);
  assert.equal(withRecurringFollowUps([done()], [task()], "2026-10-19").length, 1);
  assert.equal(withRecurringFollowUps([], [done()], "2026-10-19").length, 1);
});

test("completing or archiving a project closes its repeating tasks without copies", () => {
  const closed = closedProjectIds([{ id: "p1", status: "done" }, { id: "p2", status: "active" }, { id: "p3", status: "archived" }]);
  assert.deepEqual([...closed].sort(), ["p1", "p3"]);
  assert.equal(withRecurringFollowUps([task()], [done()], "2026-10-19", { closedProjectIds: closed }).length, 1);
});

test("the copy drops the block id so it is not duplicated mid-line", () => {
  const result = withRecurringFollowUps([task({ title: "澆花 ^abc123" })], [done({ title: "澆花 ^abc123" })], "2026-10-19");
  assert.equal(result[1]!.title, "澆花");
});

test("an overdue repeating task skips past occurrences", () => {
  assert.equal(nextRecurringDate(task({ recurrence: "every day", taskDate: "2026-10-01" }), "2026-10-20"), "2026-10-20");
  assert.equal(nextRecurringDate(task({ taskDate: null }), "2026-10-20"), "2026-10-26");
  assert.equal(nextRecurringDate(task({ recurrence: "nonsense" }), "2026-10-20"), null);
});

test("resetChecklist only unchecks checklist items, not sub-tasks", () => {
  assert.equal(
    resetChecklist("- [x] a\n  * [X] b\n- [x] #task 子任務\n完成 [x] 不是清單"),
    "- [ ] a\n  * [ ] b\n- [x] #task 子任務\n完成 [x] 不是清單",
  );
});

test("twin chains with the same title keep repeating independently", () => {
  const morning = task({ id: "am", startTime: "08:00", title: "吃藥", recurrence: "every day", taskDate: "2026-10-20" });
  const evening = task({ id: "pm", startTime: "20:00", title: "吃藥", recurrence: "every day", taskDate: "2026-10-20" });
  const result = withRecurringFollowUps([morning, evening], [{ ...morning, status: "done" }, evening], "2026-10-20", { createId: () => "next" });
  assert.equal(result.length, 3);
  assert.equal(result[1]!.taskDate, "2026-10-21");
  const otherProject = task({ id: "p2", projectId: "p2", projectName: "其他" });
  assert.equal(withRecurringFollowUps([task(), otherProject], [done(), otherProject], "2026-10-19").length, 3);
});

test("completing the copy while the original was reopened still repeats", () => {
  const copy = task({ id: "copy", taskDate: "2026-10-26" });
  const result = withRecurringFollowUps([task(), copy], [task(), { ...copy, status: "done" }], "2026-10-19", { createId: () => "third" });
  assert.equal(result.length, 3);
  assert.equal(result[2]!.taskDate, "2026-11-02");
});
