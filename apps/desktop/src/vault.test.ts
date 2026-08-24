import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskLine } from "@second-brain/brain-core";
import {
  applyDesiredSnapshot,
  buildCollectionCreateChange,
  buildCollectionDeleteChange,
  buildProjectCreateChange,
  buildProjectDeleteChanges,
  scanStructuredVault,
  type LocalMarkdownFile,
} from "./vault";

const taskId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function file(relativePath: string, text: string): LocalMarkdownFile {
  return { relativePath, sha256: "a".repeat(64), bytesBase64: bytesToBase64(new TextEncoder().encode(text)) };
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToText(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

test("structured vault scan assigns ids without losing BOM, CRLF, or unknown tokens", () => {
  const source = "\uFEFF- [ ] #task 測試 [[專案 A]] ⏫ ⏳ 2026-08-12 custom ^block\r\n";
  const result = scanStructuredVault([file("notes/tasks.md", source)], () => taskId);
  assert.equal(result.snapshot.tasks[0]?.id, taskId);
  assert.equal(result.snapshot.tasks[0]?.taskDate, "2026-08-12");
  const patched = base64ToText(result.bootstrapChanges[0]!.replacementBase64);
  assert.ok(patched.startsWith("\uFEFF"));
  assert.ok(patched.endsWith("\r\n"));
  assert.match(patched, /custom .* \^block/);
  assert.match(patched, new RegExp(taskId));
});

test("structured vault scan links tasks to project ids and rejects duplicate ids", () => {
  const project = "---\r\ntype: project\r\npublisher_id: " + projectId + "\r\n---\r\n# 專案 A\r\n正文\r\n";
  const task = formatTaskLine({
    id: taskId, title: "任務", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId: null, projectName: "專案 A", rank: "a",
    sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
  });
  const result = scanStructuredVault([file("project.md", project), file("tasks.md", task)]);
  assert.equal(result.snapshot.tasks[0]?.projectId, projectId);
  // Duplicated ids no longer abort the scan; the later occurrence is re-minted
  // and surfaced as a warning (see the dedicated test below).
  const healed = scanStructuredVault(
    [file("a.md", task), file("b.md", task)],
    () => "99999999-9999-4999-8999-999999999999",
  );
  assert.equal(healed.snapshot.tasks.length, 2);
  assert.notEqual(healed.snapshot.tasks[0]?.id, healed.snapshot.tasks[1]?.id);
  assert.equal(healed.warnings[0]?.issue, "duplicate-id");
});

test("structured vault scan indexes collection metadata and body without treating it as a project", () => {
  const collectionId = "44444444-4444-4444-8444-444444444444";
  const source = `---\r\ntype: collection\r\npublisher_id: ${collectionId}\r\ncategory: AI\r\nimportance: 1\r\n---\r\n# 常用提示詞\r\n\r\n影片腳本與股票分析\r\n`;
  const result = scanStructuredVault([file("Collections/Prompts.md", source)]);
  assert.equal(result.snapshot.projects.length, 0);
  assert.deepEqual(result.snapshot.collections, [{
    schemaVersion: 6,
    id: collectionId,
    name: "常用提示詞",
    sourcePath: "Collections/Prompts.md",
    category: "AI",
    importance: 1,
    body: "影片腳本與股票分析",
  }]);
});

test("structured vault scan bootstraps a missing collection id while preserving CRLF", () => {
  const collectionId = "55555555-5555-4555-8555-555555555555";
  const source = "---\r\ntype: collection\r\ncategory: 參考\r\n---\r\n# 剪輯資料\r\n正文\r\n";
  const result = scanStructuredVault([file("Collections/Editing.md", source)], () => collectionId);
  const patched = base64ToText(result.bootstrapChanges[0]!.replacementBase64);
  assert.match(patched, new RegExp(`publisher_id: ${collectionId}`));
  assert.ok(patched.includes("\r\n"));
});

test("structured vault snapshot never uploads parser-only location metadata", () => {
  const files = [file("20-project.md", `---\ntype: project\nstatus: active\n---\n# Launch\n\n- [ ] #task Ship [[Launch]]` )];
  const structured = scanStructuredVault(files, () => "11111111-1111-4111-8111-111111111111");
  const task = structured.snapshot.tasks[0] as Record<string, unknown>;
  const project = structured.snapshot.projects[0] as Record<string, unknown>;

  assert.equal("lineIndex" in task, false);
  assert.equal("rawLine" in task, false);
  assert.equal("markerIssue" in task, false);
  assert.equal("frontmatterStart" in project, false);
  assert.equal("frontmatterEnd" in project, false);
});

test("desired cloud snapshot minimally patches existing files and inserts a new inbox task once", () => {
  const existing = formatTaskLine({
    id: taskId, title: "舊標題", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId: null, projectName: null, rank: "a",
    sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
  }) + "\r\n";
  const inbox = "# 待辦收件匣\r\n\r\n## 新增 Task\r\n";
  const files = [file("tasks.md", existing), file("10-收件匣/待辦收件匣.md", inbox)];
  const scanned = scanStructuredVault(files);
  const newId = "33333333-3333-4333-8333-333333333333";
  const desired = {
    ...scanned.snapshot,
    tasks: [
      { ...scanned.snapshot.tasks[0]!, title: "新標題", plannedDate: "2026-08-13" },
      {
        schemaVersion: 2 as const, id: newId, title: "手機新增", status: "todo" as const,
        dueDate: null, plannedDate: "2026-08-14", priority: "normal" as const,
        projectId: null, projectName: null, rank: "b", sourcePath: null,
        sourceHeading: null, completedAt: null,
      },
    ],
  };
  const changes = applyDesiredSnapshot(files, desired);
  assert.equal(changes.length, 2);
  const taskChange = changes.find((change) => change.relativePath === "tasks.md")!;
  assert.match(base64ToText(taskChange.replacementBase64), /新標題.*⏳ 2026-08-13/);
  const inboxChange = changes.find((change) => change.relativePath.includes("待辦收件匣"))!;
  const first = base64ToText(inboxChange.replacementBase64);
  assert.equal(first.match(new RegExp(newId, "g"))?.length, 1);
  const reapplied = applyDesiredSnapshot(
    files.map((item) => item.relativePath === inboxChange.relativePath
      ? { ...item, bytesBase64: inboxChange.replacementBase64 }
      : item),
    desired,
  );
  assert.equal(reapplied.find((change) => change.relativePath === inboxChange.relativePath), undefined);
});

test("desired snapshot permanently removes a missing task line while preserving neighboring markdown", () => {
  const removable = formatTaskLine({
    id: taskId, title: "remove me", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId: null, projectName: null, rank: "a",
    sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
  });
  const source = `# Tasks\r\nkeep before\r\n${removable}\r\nkeep after\r\n`;
  const files = [file("tasks.md", source)];
  const scanned = scanStructuredVault(files);
  const changes = applyDesiredSnapshot(files, { ...scanned.snapshot, tasks: [] });
  assert.equal(changes.length, 1);
  assert.equal(base64ToText(changes[0]!.replacementBase64), "# Tasks\r\nkeep before\r\nkeep after\r\n");
});

test("scheduling a task that lives inside a project note survives the project body rewrite", () => {
  // Regression: the project pass rewrote the document body from the scanned
  // snapshot AFTER task lines were patched, reverting the schedule edit and
  // producing a byte-identical no-op write.
  const inner = formatTaskLine({
    id: taskId, title: "Ship", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId, projectName: "Launch", rank: "a",
    sourcePath: "project.md", sourceHeading: null, completedAt: null,
  });
  const source = `---\r\ntype: project\r\nstatus: active\r\npublisher_id: ${projectId}\r\n---\r\n# Launch\r\n\r\n${inner}\r\n`;
  const files = [file("project.md", source)];
  const scanned = scanStructuredVault(files);
  const desired = {
    ...scanned.snapshot,
    tasks: scanned.snapshot.tasks.map((item) =>
      item.id === taskId
        ? { ...item, taskDate: "2026-08-20", startTime: "09:30", durationMinutes: 30, timeZone: "Asia/Taipei" }
        : item),
  };
  const changes = applyDesiredSnapshot(files, desired);
  const change = changes.find((item) => item.relativePath === "project.md");
  assert.ok(change && change.operation !== "delete");
  const patched = base64ToText(change.replacementBase64);
  assert.match(patched, /⏳ 2026-08-20/);
  assert.match(patched, /"startTime":"09:30"/);
});

test("project and collection creation use safe unique Markdown paths", () => {
  const project = buildProjectCreateChange("Launch: Q4", "Work", 1, ["Projects/Launch Q4.md"]);
  assert.equal(project.relativePath, "Projects/Launch Q4-2.md");
  assert.equal(project.operation, "create");
  assert.match(base64ToText(project.replacementBase64), /status: planning/);

  const collection = buildCollectionCreateChange("Prompt/Library", "AI", 2, []);
  assert.equal(collection.relativePath, "Collections/Prompt Library.md");
  assert.match(base64ToText(collection.replacementBase64), /type: collection/);
});

test("project and collection creation includes full Markdown body", () => {
  const project = buildProjectCreateChange("Launch", null, null, [], undefined, "## Goal\n\nShip it");
  const collection = buildCollectionCreateChange("Prompt", null, null, [], undefined, "```text\nhello\n```");
  assert.match(base64ToText(project.replacementBase64), /## Goal\r\n\r\nShip it/);
  assert.match(base64ToText(collection.replacementBase64), /```text\r\nhello\r\n```/);
});

test("desired snapshot creates a beginner inbox when the selected folder is empty", () => {
  const desired = {
    schemaVersion: 6 as const,
    tasks: [{
      schemaVersion: 6 as const, id: taskId, title: "First task", status: "todo" as const,
      taskDate: null, priority: "normal" as const, projectId: null, projectName: null,
      rank: "a", sourcePath: null, sourceHeading: null, completedAt: null,
      body: "## Notes\n\nMy first Markdown",
    }],
    projects: [], collections: [], routineTemplates: [], fileHashes: {},
  };
  const changes = applyDesiredSnapshot([], desired);
  assert.equal(changes[0]?.operation, "create");
  assert.equal(changes[0]?.relativePath, "10-收件匣/待辦收件匣.md");
  assert.match(base64ToText(changes[0]!.replacementBase64), /My first Markdown/);
});

test("task checkboxes inside a task Markdown body are not indexed as separate tasks", () => {
  const line = formatTaskLine({
    id: taskId, title: "Parent", status: "todo", taskDate: null, priority: "normal",
    projectId: null, projectName: null, rank: "a", sourcePath: "tasks.md",
    sourceHeading: null, completedAt: null,
  });
  const source = `${line}\r\n<!-- second-brain-task-content:${taskId}:start -->\r\n- [ ] #task Example only\r\n<!-- second-brain-task-content:${taskId}:end -->\r\n`;
  const scanned = scanStructuredVault([file("tasks.md", source)]);
  assert.equal(scanned.snapshot.tasks.length, 1);
  assert.match(scanned.snapshot.tasks[0]?.body ?? "", /Example only/);
});

test("project deletion preserves tasks by unlinking them and deletes only the project source", () => {
  const projectSource = `---\r\ntype: project\r\npublisher_id: ${projectId}\r\n---\r\n# Launch\r\nnotes\r\n`;
  const linkedTask = formatTaskLine({
    id: taskId, title: "Ship", status: "todo", taskDate: null,
    priority: "normal", projectId, projectName: "Launch", rank: "a",
    sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
  }) + "\r\n";
  const files = [file("Projects/Launch.md", projectSource), file("tasks.md", linkedTask)];
  const scanned = scanStructuredVault(files);
  const changes = buildProjectDeleteChanges(files, scanned.snapshot, projectId);
  assert.equal(changes.find((change) => change.relativePath === "Projects/Launch.md")?.operation, "delete");
  const taskChange = changes.find((change) => change.relativePath === "tasks.md")!;
  const patchedTask = base64ToText("replacementBase64" in taskChange ? taskChange.replacementBase64 : "");
  assert.doesNotMatch(patchedTask, /\[\[Launch\]\]/);
  assert.match(patchedTask, /Ship/);
});

test("project deletion relocates tasks stored inside the project note to the inbox", () => {
  const embedded = formatTaskLine({
    id: taskId, title: "Keep me", status: "todo", taskDate: null,
    priority: "normal", projectId, projectName: "Launch", rank: "a",
    sourcePath: "Projects/Launch.md", sourceHeading: null, completedAt: null,
  });
  const projectSource = `---\r\ntype: project\r\npublisher_id: ${projectId}\r\n---\r\n# Launch\r\n${embedded}\r\n`;
  const inboxPath = "10-收件匣/待辦收件匣.md";
  const files = [file("Projects/Launch.md", projectSource), file(inboxPath, "# 收件匣\r\n")];
  const scanned = scanStructuredVault(files);
  const changes = buildProjectDeleteChanges(files, scanned.snapshot, projectId);
  const inbox = changes.find((change) => change.relativePath === inboxPath)!;
  const text = base64ToText(inbox.replacementBase64);
  assert.match(text, /Keep me/);
  assert.doesNotMatch(text, /\[\[Launch\]\]/);
});

test("collection deletion yields a single delete change for the collection source file", () => {
  const collectionId = "55555555-5555-4555-8555-555555555555";
  const collectionSource = `---\r\ntype: collection\r\npublisher_id: ${collectionId}\r\ncategory: AI\r\n---\r\n# 常用提示詞\r\n\r\n正文\r\n`;
  const files = [file("Collections/Prompts.md", collectionSource)];
  const scanned = scanStructuredVault(files);
  const target = scanned.snapshot.collections[0]!;
  const change = buildCollectionDeleteChange(files, target);
  assert.equal(change.relativePath, "Collections/Prompts.md");
  assert.equal(change.operation, "delete");
  assert.equal(change.expectedSha256, files[0]!.sha256);
  assert.throws(
    () => buildCollectionDeleteChange(files, { id: collectionId, sourcePath: null }),
    /COLLECTION_SOURCE_NOT_FOUND/,
  );
});

test("documentation about the task format is neither adopted nor rewritten", () => {
  // Reproduces the real failure: a note explaining the task syntax made the app
  // adopt the example as a task, and the placeholder id aborted the whole scan
  // with TASK_ID_INVALID.
  const doc = [
    "# 任務格式說明",
    "",
    "```markdown",
    '- [ ] #task 修除權息顯示 <!-- publisher-task:{"id":"...","status":"todo","rank":"..."} -->',
    "- [x] #task 已完成範例 ✅ 2026-08-19",
    "```",
    "",
    "以上是格式範例。",
    "",
  ].join("\r\n");
  const board = "- [ ] #task 真正的任務\r\n";

  const result = scanStructuredVault(
    [file("docs/格式說明.md", doc), file("board.md", board)],
    () => taskId,
  );

  const titles = result.snapshot.tasks.map((task) => task.title);
  assert.deepEqual(titles, ["真正的任務"], "only the real task is adopted");
  assert.ok(
    result.bootstrapChanges.every((change) => change.relativePath !== "docs/格式說明.md"),
    "the documentation file is left untouched",
  );
});

test("an unsafe marker id is re-adopted instead of failing the scan", () => {
  // A truncated write or hand edit can leave an id that would break out of the
  // HTML-comment marker. It must heal (fresh id) rather than abort every other
  // file in the vault, which is what the old throw did.
  const broken =
    '- [ ] #task 壞掉的標記 <!-- publisher-task:{"id":"not a valid id","status":"todo"} -->\r\n';
  const result = scanStructuredVault([file("board.md", broken)], () => taskId);
  assert.equal(result.snapshot.tasks.length, 1);
  assert.equal(result.snapshot.tasks[0]?.id, taskId, "assigned a fresh valid id");
});

test("a foreign but harmless marker id is kept, not silently re-identified", () => {
  // Ids minted by an older vault or another tool are legitimate; rewriting them
  // would break every cross-reference the user already has.
  const legacy = '- [ ] #task 舊資料 <!-- publisher-task:{"id":"task-1","rank":"00000000"} -->\r\n';
  const result = scanStructuredVault([file("board.md", legacy)], () => taskId);
  assert.equal(result.snapshot.tasks[0]?.id, "task-1");
  assert.equal(result.bootstrapChanges.length, 0, "no rewrite of the user's file");
});

test("scan reports healed marker anomalies with file and line, and stays quiet otherwise", () => {
  // The tolerate-and-heal behavior must not be silent: an interrupted sync
  // write or a hand-edit that corrupts a marker should surface as a warning
  // naming the exact file and line, so real damage is discoverable.
  const corrupted = [
    "# Board",
    '- [ ] #task 標記內容損毀 <!-- publisher-task:{"id":"11111111-1111-4111-8111",} -->',
    "- [ ] #task 正常任務",
  ].join("\r\n") + "\r\n";
  let serial = 0;
  const nextId = () => `${++serial}`.padStart(8, "0") + "-1111-4111-8111-111111111111";
  const result = scanStructuredVault([file("board.md", corrupted)], nextId);
  assert.deepEqual(result.warnings, [
    { relativePath: "board.md", line: 2, issue: "unparsable" },
  ]);
  assert.equal(result.snapshot.tasks.length, 2, "both tasks still adopted");

  const clean = "- [ ] #task 乾淨任務\r\n";
  const quiet = scanStructuredVault([file("ok.md", clean)], () => taskId);
  assert.deepEqual(quiet.warnings, [], "healthy vault produces no warnings");
});

test("an unsafe marker id is reported as a warning, not just healed", () => {
  const broken =
    '- [ ] #task 壞 id <!-- publisher-task:{"id":"not a valid id","status":"todo"} -->\r\n';
  const result = scanStructuredVault([file("b.md", broken)], () => taskId);
  assert.deepEqual(result.warnings, [
    { relativePath: "b.md", line: 1, issue: "unsafe-id" },
  ]);
});

test("a duplicated task id is re-minted with a warning instead of aborting the scan", () => {
  // Copy-pasting a task line (or two placeholder markers colliding) used to
  // kill the entire vault scan with DUPLICATE_TASK_ID and no file name.
  const marker = '<!-- publisher-task:{"id":"...","status":"todo","rank":"00000000"} -->';
  const a = "- [ ] #task 第一條 " + marker + "\r\n";
  const b = "- [ ] #task 第二條 " + marker + "\r\n";
  const result = scanStructuredVault([file("a.md", a), file("b.md", b)], () => taskId);
  assert.equal(result.snapshot.tasks.length, 2, "both tasks survive");
  assert.equal(result.snapshot.tasks[0]?.id, "...", "first occurrence keeps its id");
  assert.equal(result.snapshot.tasks[1]?.id, taskId, "second occurrence is re-minted");
  assert.deepEqual(result.warnings, [
    { relativePath: "b.md", line: 1, issue: "duplicate-id" },
  ]);
  assert.ok(
    result.bootstrapChanges.some((change) => change.relativePath === "b.md"),
    "the re-minted id is patched back into the second file",
  );
});
