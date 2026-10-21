import assert from "node:assert/strict";
import test from "node:test";
import { checklistProgress } from "./task-badges";
import { customRuleFrom, recurrencePresets, toggleWeekday, withCustomUnit } from "./recurrence-picker";

test("checklist progress counts checklist items only", () => {
  assert.equal(checklistProgress(undefined), null);
  assert.equal(checklistProgress("只是說明"), null);
  assert.deepEqual(checklistProgress("- [x] 一\n- [ ] 二\n  * [X] 三\n- [ ] #task 子任務"), { done: 2, total: 3 });
  assert.deepEqual(checklistProgress("```\n- [ ] 範例\n```\n- [ ] 真的"), { done: 0, total: 1 });
});

test("repeat presets follow the task's weekday and day of month", () => {
  // 2026-10-22 is a Thursday.
  const presets = recurrencePresets("2026-10-22", "2026-10-20");
  assert.ok(presets.includes("every week on Thursday"));
  assert.ok(presets.includes("every 2 weeks on Thursday"));
  assert.ok(presets.includes("every month on the 22nd"));
  assert.ok(recurrencePresets(null, "2026-10-20").includes("every week on Tuesday"));
});

test("the custom repeat editor starts from the current rule or the task date", () => {
  // 2026-10-22 is a Thursday.
  assert.deepEqual(customRuleFrom(null, "2026-10-22"), { unit: "week", interval: 1, weekdays: [4] });
  assert.deepEqual(customRuleFrom("every weekday", "2026-10-22"), { unit: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(customRuleFrom("every 3 days", "2026-10-22"), { unit: "day", interval: 3 });
  assert.deepEqual(customRuleFrom("every 2 months", "2026-10-22"), { unit: "month", interval: 2, day: 22 });
});

test("switching the custom unit keeps the interval and fills in an anchored detail", () => {
  const rule = { unit: "day" as const, interval: 3 };
  assert.deepEqual(withCustomUnit(rule, "week", "2026-10-22"), { unit: "week", interval: 3, weekdays: [4] });
  assert.deepEqual(withCustomUnit(rule, "month", "2026-10-22"), { unit: "month", interval: 3, day: 22 });
  assert.deepEqual(withCustomUnit({ unit: "week", interval: 2, weekdays: [1, 3] }, "year", "2026-10-22"), { unit: "year", interval: 2 });
});

test("weekday toggles keep at least one day and stay sorted", () => {
  assert.deepEqual(toggleWeekday([3], 1), [1, 3]);
  assert.deepEqual(toggleWeekday([1, 3], 3), [1]);
  assert.deepEqual(toggleWeekday([1], 1), [1]);
});
