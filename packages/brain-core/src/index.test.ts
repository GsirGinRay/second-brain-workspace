import assert from "node:assert/strict";
import test from "node:test";
import {
  BrainTaskSnapshotSchema,
  formatTaskLine,
  getTodayTasks,
  migrateSyncSnapshot,
  migrateTaskSnapshot,
  mergeSnapshots,
  patchTaskLine,
  parseProjectFrontmatter,
  parseTaskLine,
  parseSyncSnapshot,
  updateProjectFrontmatter,
} from "./index";

const task = {
  id: "task-1",
  title: "Keep [markdown](https://example.com) and 🔁",
  status: "todo" as const,
  taskDate: "2026-08-11",
  priority: "high" as const,
  projectId: null,
  projectName: "Project",
  rank: "00000001",
  sourcePath: "tasks.md",
  sourceHeading: null,
  completedAt: null,
};

test("taskDate round-trips as the Obsidian Tasks ⏳ token", () => {
  const line = formatTaskLine(task);
  assert.match(line, /⏳ 2026-08-11/);
  assert.deepEqual(parseTaskLine(line, "tasks.md", 2), {
    ...task,
    startTime: null,
    durationMinutes: null,
    timeZone: "Asia/Taipei",
    calendarSyncEnabled: false,
    lineIndex: 2,
    rawLine: line,
  });
});

test("parser preserves BOM, CRLF callers, markdown links, and unknown tokens", () => {
  const line = "\uFEFF- [ ] #task title [link](https://example.com) 🔁";
  const parsed = parseTaskLine(line, "tasks.md", 0);
  assert.equal(parsed?.title, "title [link](https://example.com) 🔁");
});

test("three-way merge includes taskDate in field-level merging", () => {
  const base = { ...task, taskDate: null as string | null };
  const local = { ...base, taskDate: "2026-08-11" };
  const server = { ...base, title: "server title" };
  const result = mergeSnapshots([base], [local], [server]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.items[0]?.taskDate, "2026-08-11");
  assert.equal(result.items[0]?.title, "server title");
});

test("today selector considers taskDate while excluding completed tasks", () => {
  const result = getTodayTasks(
    [
      { ...task, id: "planned", taskDate: "2026-08-11" },
      { ...task, id: "future", taskDate: "2026-08-12" },
      { ...task, id: "done", status: "done", taskDate: "2026-08-11" },
    ],
    [],
    "2026-08-11",
  );
  assert.deepEqual(result.map(({ id }) => id), ["planned"]);
});

test("Zod DTO accepts taskDate and rejects malformed task snapshots", () => {
  assert.equal(BrainTaskSnapshotSchema.parse(task).taskDate, "2026-08-11");
  assert.throws(() => parseSyncSnapshot({ tasks: [{ ...task, status: "invalid" }], projects: [] }));
});

test("migrates legacy task and sync snapshots to schemaVersion 4", () => {
  const v1 = { ...task, taskDate: undefined, plannedDate: "2026-08-10" };
  const migratedTask = migrateTaskSnapshot(v1);
  assert.equal(migratedTask.schemaVersion, 4);
  assert.equal(migratedTask.taskDate, "2026-08-10");

  const migratedSync = migrateSyncSnapshot({ tasks: [v1], projects: [] });
  assert.equal(migratedSync.schemaVersion, 4);
  assert.equal(migratedSync.tasks[0]?.taskDate, "2026-08-10");
  assert.equal(migratedSync.tasks[0]?.schemaVersion, 4);
});

test("mergeEntity treats taskDate as a field when a legacy base omits it", () => {
  const base = { id: "task-1", title: "same" };
  const local = { ...base, taskDate: "2026-08-11" };
  const server = { ...base, taskDate: "2026-08-12" };
  const result = mergeSnapshots([base], [local], [server]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.conflicts, [{ id: "task-1", fields: ["taskDate"] }]);
});

test("mergeSnapshots handles missing and new entities without undefined items", () => {
  const base = [{ id: "base", title: "base" }];
  const local = [{ id: "local-only", title: "local" }];
  const server = [{ id: "server-only", title: "server" }];
  const result = mergeSnapshots(base, local, server);
  assert.deepEqual(result.items, [
    { id: "local-only", title: "local" },
    { id: "server-only", title: "server" },
  ]);
  assert.equal(result.items.some((item) => item === undefined), false);

  const bothNew = mergeSnapshots(
    [],
    [{ id: "same", title: "local" }],
    [{ id: "same", title: "server" }],
  );
  assert.deepEqual(bothNew.items, []);
  assert.deepEqual(bothNew.conflicts, [{ id: "same", fields: ["title"] }]);

  const bothMissing = mergeSnapshots(
    [{ id: "gone", title: "gone" }],
    [],
    [],
  );
  assert.deepEqual(bothMissing.items, []);
  assert.equal(bothMissing.items.some((item) => item === undefined), false);

  assert.deepEqual(
    mergeSnapshots([], [], [{ id: "server-new", title: "server" }]).items,
    [{ id: "server-new", title: "server" }],
  );
  assert.deepEqual(
    mergeSnapshots(
      [{ id: "removed", title: "base" }],
      [{ id: "removed", title: "local" }],
      [],
    ).items,
    [{ id: "removed", title: "local" }],
  );
});

test("minimal task patch preserves BOM, CRLF, indentation, links, wikilinks, unknown tokens and block id", () => {
  const raw = "\uFEFF  - [ ] #task Keep [link](https://example.com) [[Area]] [[Project]] \u{1F501} \u{23EB} 📅 2026-08-12 ⏳ 2026-08-11 ✅ 2026-08-10 ^block-id <!-- publisher-task:{\"id\":\"task-1\",\"status\":\"doing\",\"rank\":\"00000001\"} -->\r";
  const parsed = parseTaskLine(raw, "tasks.md", 4);
  assert.ok(parsed);
  assert.equal(patchTaskLine(raw, parsed), raw.replace(" 📅 2026-08-12", ""));

  const updated = patchTaskLine(raw, { ...parsed, taskDate: "2026-08-13" });
  assert.equal(
    updated,
    raw.replace(" 📅 2026-08-12", "").replace("⏳ 2026-08-11", "⏳ 2026-08-13"),
  );
  assert.match(updated, /\uFEFF  - /);
  assert.match(updated, /\[\[Area\]\] \[\[Project\]\]/);
  assert.match(updated, /\u{1F501} \u{23EB}/u);
  assert.match(updated, /\^block-id/);
  assert.match(updated, /✅ 2026-08-10/);
});

test("frontmatter updater preserves a BOM and CRLF", () => {
  const source = "\uFEFF---\r\ntype: project\r\nfocus_today: false\r\n---\r\n# Project\r\n";
  const parsed = parseProjectFrontmatter(source, "project.md");
  assert.equal(parsed?.name, "Project");
  assert.equal(
    updateProjectFrontmatter(source, { focus_today: true }),
    "\uFEFF---\r\ntype: project\r\nfocus_today: true\r\n---\r\n# Project\r\n",
  );
});
