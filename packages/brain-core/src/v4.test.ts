import assert from "node:assert/strict";
import test from "node:test";
import {
  completeProject,
  formatTaskLine,
  migrateProjectSnapshot,
  migrateTaskSnapshot,
  parseProjectFrontmatter,
  parseTaskLine,
  patchTaskLine,
  updateProjectFrontmatter,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "./index";

const task: BrainTaskSnapshot = {
  id: "task-1",
  title: "Calendar-safe task",
  status: "todo",
  taskDate: "2026-08-14",
  startTime: "09:30",
  durationMinutes: 45,
  timeZone: "Asia/Taipei",
  priority: "normal",
  projectId: "project-1",
  projectName: "Launch",
  rank: "00000001",
  sourcePath: "tasks.md",
  sourceHeading: null,
  completedAt: null,
  schemaVersion: 4,
};

const project: BrainProjectSnapshot = {
  id: "project-1",
  name: "Launch",
  sourcePath: "Launch.md",
  status: "active",
  area: "Business",
  priority: 1,
  progress: 40,
  focusToday: true,
  startDate: "2026-08-01",
  endDate: "2026-08-31",
  completedAt: null,
  schemaVersion: 4,
};

test("V4 task metadata round-trips only through the structured marker", () => {
  const line = formatTaskLine(task);
  assert.match(line, /"startTime":"09:30"/);
  assert.match(line, /"durationMinutes":45/);
  assert.doesNotMatch(line, /accessToken|refreshToken|eventId/i);

  const parsed = parseTaskLine(line, "tasks.md", 0);
  assert.equal(parsed?.startTime, "09:30");
  assert.equal(parsed?.durationMinutes, 45);
  assert.equal(parsed?.timeZone, "Asia/Taipei");
});

test("V4 minimal patch preserves unrelated Markdown body and unknown marker fields", () => {
  const raw = '- [ ] #task Keep [private note](local.md) [[Launch]] ⏳ 2026-08-14 <!-- publisher-task:{"id":"task-1","status":"todo","rank":"1","unknown":"keep"} -->';
  const updated = patchTaskLine(raw, { ...task, title: "Keep [private note](local.md)", rank: "1" });
  assert.match(updated, /Keep \[private note\]\(local\.md\)/);
  assert.match(updated, /"unknown":"keep"/);
  assert.match(updated, /"startTime":"09:30"/);
});

test("V3 snapshots migrate to V4 with safe defaults", () => {
  const migratedTask = migrateTaskSnapshot({
    ...task,
    startTime: undefined,
    durationMinutes: undefined,
    timeZone: undefined,
    schemaVersion: 3,
  });
  assert.equal(migratedTask.schemaVersion, 4);
  assert.equal(migratedTask.startTime, null);
  assert.equal(migratedTask.durationMinutes, null);
  assert.equal(migratedTask.timeZone, "Asia/Taipei");

  const migratedProject = migrateProjectSnapshot({
    ...project,
    completedAt: undefined,
    schemaVersion: 3,
  });
  assert.equal(migratedProject.schemaVersion, 4);
  assert.equal(migratedProject.completedAt, null);
});

test("project completedAt round-trips in frontmatter", () => {
  const source = "---\r\ntype: project\r\nstatus: active\r\n---\r\n# Launch\r\n";
  const updated = updateProjectFrontmatter(source, {
    status: "done",
    completed_at: "2026-08-14",
  });
  const parsed = parseProjectFrontmatter(updated, "Launch.md");
  assert.equal(parsed?.status, "done");
  assert.equal(parsed?.completedAt, "2026-08-14");
});

test("completing a project finishes linked open tasks as one deterministic snapshot", () => {
  const result = completeProject(project, [
    task,
    { ...task, id: "other", projectId: "other-project" },
    { ...task, id: "already", status: "done", completedAt: "2026-08-01" },
  ], "2026-08-14");
  assert.deepEqual(result.project, {
    ...project,
    status: "done",
    progress: 100,
    focusToday: false,
    completedAt: "2026-08-14",
  });
  assert.equal(result.tasks[0]?.status, "done");
  assert.equal(result.tasks[0]?.completedAt, "2026-08-14");
  assert.equal(result.tasks[1]?.status, "todo");
  assert.equal(result.tasks[2]?.completedAt, "2026-08-01");
});
