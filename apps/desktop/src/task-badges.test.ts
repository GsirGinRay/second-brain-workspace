import assert from "node:assert/strict";
import test from "node:test";
import { checklistProgress } from "./task-badges";
import { recurrencePresets } from "./recurrence-picker";

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
