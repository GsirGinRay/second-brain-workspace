import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskLine } from "@second-brain/brain-core";
import { applyDesiredSnapshot, scanStructuredVault, type LocalMarkdownFile } from "./vault";

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
  assert.throws(
    () => scanStructuredVault([file("a.md", task), file("b.md", task)]),
    /DUPLICATE_TASK_ID/,
  );
});

test("structured vault snapshot never uploads parser-only location metadata", () => {
  const files = [file("20-project.md", `---\ntype: project\nstatus: active\n---\n# Launch\n\n- [ ] #task Ship [[Launch]]` )];
  const structured = scanStructuredVault(files, () => "11111111-1111-4111-8111-111111111111");
  const task = structured.snapshot.tasks[0] as Record<string, unknown>;
  const project = structured.snapshot.projects[0] as Record<string, unknown>;

  assert.equal("lineIndex" in task, false);
  assert.equal("rawLine" in task, false);
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
