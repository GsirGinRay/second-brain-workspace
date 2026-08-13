import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { archiveTask, boardLane, completedForDate, filterCompletedTasks, isCompleteShortcut, isQuickAddShortcut, markMostImportant, moveTaskToLane, nextWeekPriorities, priorityDisplay, scheduleTask } from "./task-actions";

function task(id: string, taskDate: string | null, priority: BrainTaskSnapshot["priority"] = "normal"): BrainTaskSnapshot {
  return {
    schemaVersion: 3,
    id,
    title: id,
    status: "todo",
    taskDate,
    priority,
    projectId: null,
    projectName: null,
    rank: id,
    sourcePath: "tasks.md",
    sourceHeading: null,
    completedAt: null,
  };
}

test("a date can have exactly one most important task", () => {
  const tasks = [task("old", "2026-08-12", "highest"), task("next", null), task("other-day", "2026-08-13", "highest")];
  const result = markMostImportant(tasks, "next", "2026-08-12");
  assert.equal(result.find((item) => item.id === "next")?.priority, "highest");
  assert.equal(result.find((item) => item.id === "next")?.taskDate, "2026-08-12");
  assert.equal(result.find((item) => item.id === "old")?.priority, "high");
  assert.equal(result.find((item) => item.id === "other-day")?.priority, "highest");
  assert.equal(result.filter((item) => item.taskDate === "2026-08-12" && item.priority === "highest").length, 1);
});

test("safe delete archives a task and preserves Markdown history", () => {
  const result = archiveTask(task("idea", "2026-08-12"), "2026-08-12");
  assert.equal(result.status, "done");
  assert.equal(result.completedAt, "2026-08-12");
});

test("keyboard shortcuts ignore editable controls", () => {
  assert.equal(isQuickAddShortcut({ key: "n", metaKey: false, ctrlKey: false, altKey: false, editable: false }), true);
  assert.equal(isQuickAddShortcut({ key: "n", metaKey: false, ctrlKey: false, altKey: false, editable: true }), false);
  assert.equal(isCompleteShortcut({ key: " ", editable: false }), true);
  assert.equal(isCompleteShortcut({ key: "Enter", editable: false }), true);
  assert.equal(isCompleteShortcut({ key: " ", editable: true }), false);
});

test("priority is displayed as an unambiguous numbered level", () => {
  assert.deepEqual(priorityDisplay("highest"), { code: "P1", label: "最重要" });
  assert.deepEqual(priorityDisplay("high"), { code: "P2", label: "高" });
  assert.deepEqual(priorityDisplay("medium"), { code: "P3", label: "中" });
  assert.deepEqual(priorityDisplay("normal"), { code: "P4", label: "一般" });
  assert.deepEqual(priorityDisplay("low"), { code: "P5", label: "低" });
});

test("completed tasks for a day are separated from unfinished work", () => {
  const doneToday = { ...task("done-today", "2026-08-12"), status: "done" as const, completedAt: "2026-08-12" };
  const doneEarlier = { ...task("done-earlier", "2026-08-12"), status: "done" as const, completedAt: "2026-08-11" };
  const open = task("open", "2026-08-12");
  assert.deepEqual(completedForDate([doneToday, doneEarlier, open], "2026-08-12").map((item) => item.id), ["done-today"]);
});

test("completed tasks are hidden by default and can be revealed explicitly", () => {
  const open = task("open", "2026-08-12");
  const done = { ...task("done", "2026-08-12"), status: "done" as const, completedAt: "2026-08-12" };
  assert.deepEqual(filterCompletedTasks([open, done], false).map((item) => item.id), ["open"]);
  assert.deepEqual(filterCompletedTasks([open, done], true).map((item) => item.id), ["open", "done"]);
});

test("unscheduled todo tasks form an idea inbox without changing the public status schema", () => {
  const idea = task("idea", null);
  assert.equal(boardLane(idea), "idea");
  assert.equal(boardLane(task("scheduled", "2026-08-12")), "todo");
  assert.deepEqual(moveTaskToLane(idea, "todo", "2026-08-12"), { ...idea, status: "todo", taskDate: "2026-08-12", completedAt: null });
  assert.deepEqual(moveTaskToLane(task("planned", "2026-08-12"), "idea", "2026-08-12"), { ...task("planned", "2026-08-12"), status: "todo", taskDate: null, completedAt: null });
});

test("calendar scheduling moves only the task date and next-week priorities exclude completed work", () => {
  const planned = scheduleTask(task("move", null), "2026-08-15");
  assert.equal(planned.taskDate, "2026-08-15");
  const next = nextWeekPriorities([
    { ...task("p1", "2026-08-13", "highest") },
    { ...task("p2", "2026-08-18", "high") },
    { ...task("normal", "2026-08-14", "normal") },
    { ...task("done", "2026-08-15", "highest"), status: "done" as const },
  ], "2026-08-12");
  assert.deepEqual(next.map((item) => item.id), ["p1", "p2"]);
});
