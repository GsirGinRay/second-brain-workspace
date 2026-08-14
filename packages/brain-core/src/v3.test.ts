import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskLine,
  migrateProjectSnapshot,
  migrateTaskSnapshot,
  parseProjectFrontmatter,
  parseTaskLine,
  patchTaskLine,
  projectColor,
  updateProjectFrontmatter,
  enforceDailyP1,
} from "./index";

const legacyTask = {
  id: "task-1",
  title: "V3 task",
  status: "todo" as const,
  plannedDate: "2026-08-15",
  dueDate: "2026-08-20",
  priority: "normal" as const,
  projectId: null,
  projectName: "Project A",
  rank: "00000001",
  sourcePath: "tasks.md",
  sourceHeading: null,
  completedAt: null,
};

test("V3 task migration prefers plannedDate and removes the legacy due token", () => {
  const migrated = migrateTaskSnapshot(legacyTask);
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.taskDate, "2026-08-15");

  const raw = "  - [ ] #task V3 task [[Project A]] 📅 2026-08-20 ⏳ 2026-08-15 <!-- publisher-task:{\"id\":\"task-1\",\"status\":\"todo\",\"rank\":\"00000001\"} -->\r";
  const patched = patchTaskLine(raw, migrated);
  assert.equal(patched.includes("📅"), false);
  assert.match(patched, /⏳ 2026-08-15/);
  assert.match(patched, /^  - /);
  assert.match(patched, /\r$/);
});

test("V3 task migration falls back to dueDate and formatter writes one date", () => {
  const migrated = migrateTaskSnapshot({ ...legacyTask, plannedDate: null });
  assert.equal(migrated.taskDate, "2026-08-20");
  const line = formatTaskLine(migrated);
  assert.match(line, /⏳ 2026-08-20/);
  assert.equal(line.includes("📅"), false);
  assert.equal(parseTaskLine(line, "tasks.md", 0)?.taskDate, "2026-08-20");
});

test("V3 project migration maps targetDate to endDate and writes start/end frontmatter", () => {
  const source = "---\r\ntype: project\r\ntarget_date: 2026-09-30\r\n---\r\n# Project A\r\n";
  const parsed = parseProjectFrontmatter(source, "project.md");
  assert.ok(parsed);
  const { frontmatterStart: _start, frontmatterEnd: _end, ...snapshot } = parsed;
  const migrated = migrateProjectSnapshot(snapshot);
  assert.equal(migrated.startDate, null);
  assert.equal(migrated.endDate, "2026-09-30");
  const updated = updateProjectFrontmatter(source, {
    start_date: "2026-08-01",
    end_date: migrated.endDate,
    target_date: null,
  });
  assert.match(updated, /start_date: 2026-08-01/);
  assert.match(updated, /end_date: 2026-09-30/);
  assert.match(updated, /target_date:\s*\r?\n/);
});

test("project colors are stable and use the neutral palette for unassigned tasks", () => {
  assert.deepEqual(projectColor("project-a"), projectColor("project-a"));
  assert.notDeepEqual(projectColor("project-a"), projectColor("project-b"));
  assert.equal(projectColor(null).key, "neutral");
});

test("each date keeps one deterministically ranked P1", () => {
  const tasks = enforceDailyP1([
    { id: "later", taskDate: "2026-08-15", priority: "highest" as const, rank: "2" },
    { id: "winner", taskDate: "2026-08-15", priority: "highest" as const, rank: "1" },
    { id: "other-day", taskDate: "2026-08-16", priority: "highest" as const, rank: "3" },
  ]);
  assert.deepEqual(tasks.map(({ id, priority }) => [id, priority]), [
    ["later", "high"], ["winner", "highest"], ["other-day", "highest"],
  ]);
});
