import assert from "node:assert/strict";
import test from "node:test";
import {
  addDateDays,
  buildMonthCells,
  buildWeekDates,
  getCalendarTaskEntries,
  getUnscheduledTasks,
  taskDatePatch,
  taipeiDateKey,
} from "./calendar";
import { isValidDateKey } from "@second-brain/brain-core";

const task = (
  id: string,
  taskDate: string | null,
  status: "todo" | "done" = "todo",
) => ({
  id,
  title: id,
  status,
  taskDate,
  priority: "normal" as const,
  rank: "00000000",
});

test("Taipei date keys change at the local midnight boundary", () => {
  assert.equal(taipeiDateKey(new Date("2026-01-01T15:59:59.999Z")), "2026-01-01");
  assert.equal(taipeiDateKey(new Date("2026-01-01T16:00:00.000Z")), "2026-01-02");
});

test("date arithmetic handles leap days and cross-month boundaries", () => {
  assert.equal(addDateDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDateDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addDateDays("2026-01-01", -1), "2025-12-31");
  assert.deepEqual(buildWeekDates("2026-08-11"), [
    "2026-08-09",
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
  ]);
});

test("date inputs reject impossible calendar days and fallback controls patch only taskDate", () => {
  assert.equal(isValidDateKey("2024-02-29"), true);
  assert.equal(isValidDateKey("2024-02-30"), false);
  assert.equal(isValidDateKey("2026-13-01"), false);
  assert.deepEqual(taskDatePatch("2026-08-12"), { taskDate: "2026-08-12" });
  assert.deepEqual(taskDatePatch(null), { taskDate: null });
});

test("month cells preserve leap-day and adjacent-month context", () => {
  const cells = buildMonthCells("2024-02");
  assert.equal(cells.some((cell) => cell.date === "2024-02-29" && cell.currentMonth), true);
  assert.equal(cells.some((cell) => cell.date === "2024-01-31" && !cell.currentMonth), true);
  assert.equal(cells.some((cell) => cell.date === "2024-03-01" && !cell.currentMonth), true);
  assert.equal(cells.length % 7, 0);
});

test("calendar contains one entry per scheduled task and ignores ideas", () => {
  const entries = getCalendarTaskEntries(
    [
      task("scheduled", "2026-08-11"),
      task("idea", null),
    ],
    "2026-08-11",
  );

  assert.deepEqual(
    entries.map(({ task: item, date }) => ({
      id: item.id,
      date,
    })),
    [
      { id: "scheduled", date: "2026-08-11" },
    ],
  );
});

test("unscheduled drawer contains only incomplete tasks without a task date", () => {
  const result = getUnscheduledTasks([
    task("idea", null),
    task("scheduled", "2026-08-12"),
    task("completed", null, "done"),
  ]);
  assert.deepEqual(result.map((item) => item.id), ["idea"]);
});
