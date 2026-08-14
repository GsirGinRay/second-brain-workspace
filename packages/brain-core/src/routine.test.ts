import assert from "node:assert/strict";
import test from "node:test";
import { applyRoutineTemplate, createDefaultRoutineTemplate, routineTaskId } from "./routine";

test("routine task ids are stable UUIDs scoped by item and date", () => {
  const first = routineTaskId("11111111-1111-4111-8111-111111111111", "item-a", "2026-08-14");
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, routineTaskId("11111111-1111-4111-8111-111111111111", "item-a", "2026-08-14"));
  assert.notEqual(first, routineTaskId("11111111-1111-4111-8111-111111111111", "item-a", "2026-08-15"));
});

test("applying a routine only creates enabled missing tasks", () => {
  const template = createDefaultRoutineTemplate();
  template.items[1]!.enabled = false;
  template.items[0]!.startTime = "08:30";
  template.items[0]!.durationMinutes = 15;
  const first = applyRoutineTemplate(template, [], "2026-08-14");
  const second = applyRoutineTemplate(template, first.tasks, "2026-08-14");

  assert.equal(first.created.length, template.items.length - 1);
  assert.equal(second.created.length, 0);
  assert.equal(first.created[0]?.taskDate, "2026-08-14");
  assert.equal(first.created[0]?.startTime, "08:30");
  assert.equal(first.created[0]?.sourcePath, null);
  assert.deepEqual(Object.keys(first.created[0]!).sort(), [
    "completedAt", "durationMinutes", "id", "priority", "projectId", "projectName", "rank",
    "schemaVersion", "sourceHeading", "sourcePath", "startTime", "status", "taskDate", "timeZone", "title",
  ]);
});

test("a new template item is backfilled without duplicating prior items", () => {
  const template = createDefaultRoutineTemplate();
  const first = applyRoutineTemplate(template, [], "2026-08-14");
  template.items.push({
    id: "extra-item", title: "整理桌面", enabled: true, projectId: null, projectName: null,
    priority: "low", startTime: null, durationMinutes: null, rank: "00000006",
  });
  const second = applyRoutineTemplate(template, first.tasks, "2026-08-14");
  assert.deepEqual(second.created.map((task) => task.title), ["整理桌面"]);
});
