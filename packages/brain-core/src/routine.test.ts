import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRoutineTemplate,
  createDefaultRoutineTemplate,
  enforceTemplateSingleP1,
  routineTaskId,
} from "./routine";

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

test("a template with several P1 rows still starts the day with exactly one", () => {
  const template = createDefaultRoutineTemplate();
  template.items[0]!.priority = "highest";
  template.items[2]!.priority = "highest";
  template.items[4]!.priority = "highest";
  const result = applyRoutineTemplate(template, [], "2026-08-14");

  assert.deepEqual(result.created.filter((task) => task.priority === "highest").map((task) => task.title),
    [template.items[0]!.title]);
  assert.equal(result.created.filter((task) => task.priority === "high").length, 2);
});

test("a disabled P1 row never claims the day, the first enabled one does", () => {
  const template = createDefaultRoutineTemplate();
  template.items[0]!.priority = "highest";
  template.items[0]!.enabled = false;
  template.items[3]!.priority = "highest";
  const result = applyRoutineTemplate(template, [], "2026-08-14");

  assert.deepEqual(result.created.filter((task) => task.priority === "highest").map((task) => task.title),
    [template.items[3]!.title]);
});

test("a P1 already on the board outranks the template, which lands as P2", () => {
  const template = createDefaultRoutineTemplate();
  template.items[0]!.priority = "highest";
  const starred = applyRoutineTemplate(createDefaultRoutineTemplate("11111111-1111-4111-8111-111111111111"),
    [], "2026-08-14").created[0]!;
  const result = applyRoutineTemplate(template, [{ ...starred, priority: "highest" }], "2026-08-14");

  assert.equal(result.created.filter((task) => task.priority === "highest").length, 0);
  assert.equal(result.tasks.filter((task) => task.taskDate === "2026-08-14" && task.priority === "highest").length, 1);
  assert.equal(result.created[0]?.priority, "high");
});

test("pressing start twice never adds a second P1", () => {
  const template = createDefaultRoutineTemplate();
  template.items[0]!.priority = "highest";
  const first = applyRoutineTemplate(template, [], "2026-08-14");
  template.items.push({
    id: "late-p1", title: "臨時最重要", enabled: true, projectId: null, projectName: null,
    priority: "highest", startTime: null, durationMinutes: null, rank: "00000009",
  });
  const second = applyRoutineTemplate(template, first.tasks, "2026-08-14");

  assert.equal(second.created[0]?.priority, "high");
  assert.equal(second.tasks.filter((task) => task.taskDate === "2026-08-14" && task.priority === "highest").length, 1);
});

test("enforceTemplateSingleP1 keeps the first ranked P1 and passes valid templates through", () => {
  const template = createDefaultRoutineTemplate();
  template.items[1]!.priority = "highest";
  template.items[3]!.priority = "highest";
  const folded = enforceTemplateSingleP1(template);

  assert.deepEqual(folded.items.map((item) => item.priority),
    ["normal", "highest", "normal", "high", "normal", "normal"]);
  assert.equal(enforceTemplateSingleP1(folded), folded);
  assert.equal(enforceTemplateSingleP1(createDefaultRoutineTemplate()).items.filter(
    (item) => item.priority === "highest").length, 0);
});
