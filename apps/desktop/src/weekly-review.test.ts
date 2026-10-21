import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { completionStreak, overdueCount, weeklyReview } from "./weekly-review";

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

const done = (id: string, completedAt: string, patch: Partial<BrainTaskSnapshot> = {}) =>
  task(id, { status: "done", completedAt, ...patch });

// 2026-10-21 is a Wednesday; the week starts on Monday 10-19.
const TODAY = "2026-10-21";

test("the current week counts completions per day up to today", () => {
  const review = weeklyReview([
    done("a", "2026-10-19", { projectName: "官網", durationMinutes: 60 }),
    done("b", "2026-10-21", { projectName: "官網" }),
    done("c", "2026-10-21", { projectName: "課程", durationMinutes: 30 }),
    done("d", "2026-10-18"),
    task("e"),
  ], TODAY);
  assert.equal(review.start, "2026-10-19");
  assert.equal(review.end, TODAY);
  assert.deepEqual(review.days.map((day) => day.count), [1, 0, 2, 0, 0, 0, 0]);
  assert.deepEqual(review.days.map((day) => day.future), [false, false, false, true, true, true, true]);
  assert.equal(review.done, 3);
  assert.equal(review.estimatedMinutes, 90);
  assert.equal(review.unestimated, 1);
  assert.deepEqual(review.projects, [{ name: "官網", count: 2 }, { name: "課程", count: 1 }]);
  assert.equal(review.unassigned, 0);
  assert.equal(review.isCurrentWeek, true);
});

test("the comparison uses the same weekdays of the previous week", () => {
  const review = weeklyReview([
    done("mon", "2026-10-12"),
    done("wed", "2026-10-14"),
    done("thu", "2026-10-15"),
  ], TODAY);
  assert.equal(review.previousDone, 2, "Thursday is after today's weekday, so it is left out");
});

test("an earlier week covers Monday to Sunday", () => {
  const review = weeklyReview([done("sun", "2026-10-18"), done("mon", "2026-10-12")], TODAY, 1);
  assert.equal(review.start, "2026-10-12");
  assert.equal(review.end, "2026-10-18");
  assert.equal(review.done, 2);
  assert.ok(review.days.every((day) => !day.future));
  assert.equal(review.isCurrentWeek, false);
});

test("the streak keeps going while today has nothing done yet", () => {
  const tasks = [done("a", "2026-10-18"), done("b", "2026-10-19"), done("c", "2026-10-20")];
  assert.equal(completionStreak(tasks, TODAY), 3);
  assert.equal(completionStreak([...tasks, done("d", TODAY)], TODAY), 4);
  assert.equal(completionStreak([done("a", "2026-10-19")], TODAY), 0);
});

test("overdue counts open dated tasks before today, not waiting ones", () => {
  assert.equal(overdueCount([
    task("late", { taskDate: "2026-10-20" }),
    task("wait", { taskDate: "2026-10-01", status: "waiting" }),
    task("today", { taskDate: TODAY }),
    done("old", "2026-10-02", { taskDate: "2026-10-01" }),
  ], TODAY), 1);
});
