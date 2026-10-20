import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  dayLoad,
  focusQueue,
  formatHours,
  loadAvailableHours,
  moveTasksToDate,
  waitingItems,
  weekStart,
  wrapUpSummary,
} from "./today-planning";

const task = (id: string, patch: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot => ({
  id,
  title: id,
  status: "todo",
  taskDate: "2026-10-20",
  priority: "normal",
  projectId: null,
  projectName: null,
  rank: id,
  sourcePath: null,
  sourceHeading: null,
  completedAt: null,
  startTime: null,
  durationMinutes: null,
  ...patch,
});

test("day load sums estimates and counts unestimated tasks as 30 minutes", () => {
  const load = dayLoad([
    task("a", { startTime: "09:00", durationMinutes: 120 }),
    task("b"),
    task("c", { status: "done", durationMinutes: 600 }),
  ], 2);
  assert.deepEqual(load, { plannedMinutes: 150, availableMinutes: 120, unestimated: 1, overBy: 30 });
  assert.equal(formatHours(150, "zh-TW"), "2.5 小時");
  assert.equal(loadAvailableHours({ getItem: () => "7" }), 7);
  assert.equal(loadAvailableHours({ getItem: () => "13" }), 8);
});

test("focus order puts the most important task first, then by start time, overdue last", () => {
  const queue = focusQueue(
    [task("late", { startTime: "15:00" }), task("free"), task("early", { startTime: "09:00" }), task("top", { priority: "highest" }), task("w", { status: "waiting" })],
    [task("old", { taskDate: "2026-10-18" })],
  );
  assert.deepEqual(queue.map((item) => item.id), ["top", "early", "late", "free", "old"]);
});

test("waiting items surface follow-ups that are due first", () => {
  const items = waitingItems([
    task("later", { status: "waiting", taskDate: "2026-10-25" }),
    task("due", { status: "waiting", taskDate: "2026-10-19" }),
    task("open"),
    task("undated", { status: "waiting", taskDate: null }),
  ], "2026-10-20");
  assert.deepEqual(items.map((item) => [item.task.id, item.followUpDue]), [["due", true], ["later", false], ["undated", false]]);
});

test("wrap-up summarizes today and this week and lists what to move", () => {
  // 2026-10-20 is a Tuesday, so the week starts on Monday 2026-10-19.
  assert.equal(weekStart("2026-10-20"), "2026-10-19");
  assert.equal(weekStart("2026-10-25"), "2026-10-19");
  const summary = wrapUpSummary([
    task("d1", { status: "done", completedAt: "2026-10-20", projectName: "業務" }),
    task("d2", { status: "done", completedAt: "2026-10-19", projectName: "業務" }),
    task("d3", { status: "done", completedAt: "2026-10-19", projectName: "內容" }),
    task("d4", { status: "done", completedAt: "2026-10-18", projectName: "內容" }),
    task("open"),
    task("overdue", { taskDate: "2026-10-17" }),
    task("tomorrow", { taskDate: "2026-10-21" }),
    task("waiting", { status: "waiting" }),
  ], "2026-10-20");
  assert.deepEqual(summary.doneToday.map((item) => item.id), ["d1"]);
  assert.equal(summary.doneThisWeek, 3);
  assert.deepEqual(summary.topProjects, [{ name: "業務", count: 2 }, { name: "內容", count: 1 }]);
  assert.deepEqual(summary.unfinished.map((item) => item.id), ["open", "overdue"]);
});

test("moving tasks only changes the chosen dates", () => {
  const moved = moveTasksToDate([task("a", { startTime: "10:00" }), task("b")], new Set(["a"]), "2026-10-21");
  assert.equal(moved[0]!.taskDate, "2026-10-21");
  assert.equal(moved[0]!.startTime, "10:00");
  assert.equal(moved[1]!.taskDate, "2026-10-20");
});
