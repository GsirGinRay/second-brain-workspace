import assert from "node:assert/strict";
import test from "node:test";
import {
  getCalendarDisplayRange,
  getEntriesInCalendarRange,
  shiftCalendarRange,
  type CalendarTaskEntry,
} from "./range";

const entry = (date: string): CalendarTaskEntry<{ id: string; title: string; status: "todo"; taskDate: string | null; priority: "normal"; rank: string }> => ({
  task: { id: date, title: date, status: "todo", taskDate: date, priority: "normal", rank: "00000000" },
  date,
  planned: true,
  due: false,
  overdue: false,
});

test("mobile agenda exposes a month range and filters entries to that month", () => {
  const range = getCalendarDisplayRange("month", "2024-02", "2024-02-15");
  assert.deepEqual(range, {
    mode: "month",
    startDate: "2024-02-01",
    endDate: "2024-02-29",
    label: "2024-02",
  });
  assert.deepEqual(
    getEntriesInCalendarRange([entry("2024-02-29"), entry("2024-03-01")], range).map((item) => item.date),
    ["2024-02-29"],
  );
});

test("agenda range navigation changes both range label and filtered dates", () => {
  const nextMonth = shiftCalendarRange("month", "2024-02", "2024-02-15", 1);
  const nextRange = getCalendarDisplayRange("month", nextMonth.month, nextMonth.weekAnchor);
  assert.equal(nextRange.label, "2024-03");
  assert.equal(nextRange.startDate, "2024-03-01");
  assert.equal(nextRange.endDate, "2024-03-31");

  const nextWeek = shiftCalendarRange("week", "2024-02", "2024-02-15", 1);
  const weekRange = getCalendarDisplayRange("week", nextWeek.month, nextWeek.weekAnchor);
  assert.deepEqual(weekRange, {
    mode: "week",
    startDate: "2024-02-18",
    endDate: "2024-02-24",
    label: "2024-02-18 – 2024-02-24",
  });
});
