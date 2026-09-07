import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutcomeKnowledgeDraft,
  formatTaskLine,
  journalUpgradeContent,
  planVaultLayoutMigration,
  renderDailyJournalDocument,
} from "@second-brain/brain-core";
import {
  applyDesiredSnapshot,
  buildCollectionCreateChange,
  buildCollectionDeleteChange,
  buildJournalCreateChange,
  buildJournalUpdateChange,
  buildLayoutMigrationChanges,
  buildProjectCreateChange,
  withRelatedProjectWikilink,
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
  assert.match(patched, new RegExp(`id: ${collectionId}`));
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
  assert.match(patched, /⏰ 09:30/);
  assert.match(patched, /⏱ 30m/);
  assert.match(patched, /"startTime":"09:30"/);
});

test("project and collection creation use safe unique Markdown paths", () => {
  const project = buildProjectCreateChange("Launch: Q4", "Work", 1, ["專案/Launch Q4.md"]);
  assert.equal(project.relativePath, "專案/Launch Q4-2.md");
  assert.equal(project.operation, "create");
  assert.match(base64ToText(project.replacementBase64), /status: planning/);

  const collection = buildCollectionCreateChange("Prompt/Library", "AI", 2, []);
  assert.equal(collection.relativePath, "知識/Prompt Library.md");
  assert.match(base64ToText(collection.replacementBase64), /type: collection/);
});

test("new knowledge writes under 知識/<category>/", () => {
  const faq = buildCollectionCreateChange("常見問題", "FAQ", 1, []);
  assert.equal(faq.relativePath, "知識/FAQ/常見問題.md");
  assert.match(base64ToText(faq.replacementBase64), /type: collection/);
  assert.match(base64ToText(faq.replacementBase64), /category: FAQ/);
  assert.match(base64ToText(faq.replacementBase64), /importance: 1/);

  const prompt = buildCollectionCreateChange("寫作助手", "提示詞/寫作", 2, ["知識/提示詞/寫作助手.md"]);
  assert.equal(prompt.relativePath, "知識/提示詞/寫作助手-2.md");
  assert.match(base64ToText(prompt.replacementBase64), /category: 提示詞\/寫作/);
});

test("related project wikilink is appended once and left unchanged if already present", () => {
  assert.equal(withRelatedProjectWikilink("步驟一", "開源發表"), "步驟一\n\n[[開源發表]]");
  assert.equal(withRelatedProjectWikilink("已有 [[開源發表]]", "開源發表"), "已有 [[開源發表]]");
  assert.equal(withRelatedProjectWikilink("步驟一", null), "步驟一");
});

test("related project stays a wikilink in the knowledge body instead of a nested folder", () => {
  const change = buildCollectionCreateChange(
    "會議紀錄",
    "方法",
    1,
    [],
    undefined,
    "步驟一\n\n[[開源發表]]",
  );
  assert.equal(change.relativePath, "知識/方法/會議紀錄.md");
  assert.match(base64ToText(change.replacementBase64), /\[\[開源發表\]\]/);
  assert.ok(!change.relativePath.startsWith("專案/"));
  assert.ok(!change.relativePath.includes("/開源發表/"));
});

test("new project writes ignore a legacy Projects/ file with the same name", () => {
  const project = buildProjectCreateChange("Launch Q4", "Work", 1, ["Projects/Launch Q4.md"]);
  assert.equal(project.relativePath, "專案/Launch Q4.md");
});

test("project and collection creation includes full Markdown body", () => {
  const project = buildProjectCreateChange("Launch", null, null, [], undefined, "## Goal\n\nShip it");
  const collection = buildCollectionCreateChange("Prompt", null, null, [], undefined, "```text\nhello\n```");
  assert.match(base64ToText(project.replacementBase64), /## Goal\r\n\r\nShip it/);
  assert.match(base64ToText(collection.replacementBase64), /```text\r\nhello\r\n```/);
});

test("legacy Projects/ notes still scan as projects", () => {
  const source = `---\r\ntype: project\r\nid: ${projectId}\r\n---\r\n# Alpha\r\n`;
  const result = scanStructuredVault([file("Projects/A.md", source)]);
  assert.equal(result.snapshot.projects.length, 1);
  assert.equal(result.snapshot.projects[0]?.name, "Alpha");
  assert.equal(result.snapshot.projects[0]?.sourcePath, "Projects/A.md");
});

test("legacy Collections/ notes still scan as collections", () => {
  const source = `---\r\ntype: collection\r\ncategory: 參考\r\n---\r\n# 舊收藏\r\n`;
  const result = scanStructuredVault([file("Collections/Old.md", source)], () => "66666666-6666-4666-8666-666666666666");
  assert.equal(result.snapshot.collections.length, 1);
  assert.equal(result.snapshot.collections[0]?.sourcePath, "Collections/Old.md");
});

test("legacy Collections/A.md still appears beside categorized knowledge", () => {
  const legacy = `---\r\ntype: collection\r\nid: 66666666-6666-4666-8666-666666666666\r\ncategory: 參考\r\n---\r\n# 舊檔\r\n`;
  const faq = `---\r\ntype: collection\r\nid: 77777777-7777-4777-8777-777777777777\r\ncategory: FAQ\r\n---\r\n# 新知識\r\n`;
  const uncategorized = `---\r\ntype: collection\r\nid: 88888888-8888-4888-8888-888888888888\r\n---\r\n# 未分類舊檔\r\n`;
  const result = scanStructuredVault([
    file("Collections/A.md", legacy),
    file("知識/FAQ/新知識.md", faq),
    file("Collections/Loose.md", uncategorized),
  ]);
  assert.equal(result.snapshot.collections.length, 3);
  assert.ok(result.snapshot.collections.some((item) => item.sourcePath === "Collections/A.md"));
  assert.ok(result.snapshot.collections.some((item) => item.sourcePath === "知識/FAQ/新知識.md"));
  assert.ok(result.snapshot.collections.some((item) => item.sourcePath === "Collections/Loose.md" && !item.category));
});

test("tmp/backup, templates, and attachments are not indexed even if supplied", () => {
  const project = `---\r\ntype: project\r\nid: ${projectId}\r\n---\r\n# Alpha\r\n`;
  const result = scanStructuredVault([
    file("Projects/A.md", project),
    file("tmp/backup-2026-08-15/A.md", project),
    file("模板/通用專案.md", "---\r\ntype: template\r\n---\r\n# T\r\n"),
    file("90-模板/通用專案.md", "---\r\ntype: template\r\n---\r\n# T\r\n"),
    file("附件/note.md", "# file\r\n"),
  ]);
  assert.equal(result.snapshot.projects.length, 1);
  assert.equal(result.snapshot.projects[0]?.sourcePath, "Projects/A.md");
  assert.equal(result.snapshot.fileHashes?.["tmp/backup-2026-08-15/A.md"], undefined);
});

test("new tasks keep writing the legacy inbox when the canonical file is absent", () => {
  const inboxPath = "10-收件匣/待辦收件匣.md";
  const files = [file(inboxPath, "# 待辦收件匣\r\n")];
  const desired = {
    schemaVersion: 6 as const,
    tasks: [{
      schemaVersion: 6 as const, id: taskId, title: "Legacy inbox", status: "todo" as const,
      taskDate: null, priority: "normal" as const, projectId: null, projectName: null,
      rank: "a", sourcePath: null, sourceHeading: null, completedAt: null,
    }],
    projects: [], collections: [], routineTemplates: [], fileHashes: {},
  };
  const changes = applyDesiredSnapshot(files, desired);
  assert.equal(changes[0]?.relativePath, inboxPath);
  assert.notEqual(changes[0]?.operation, "create");
  assert.match(base64ToText(changes[0]!.replacementBase64), /Legacy inbox/);
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
  assert.equal(changes[0]?.relativePath, "收件匣/待辦.md");
  assert.match(base64ToText(changes[0]!.replacementBase64), /My first Markdown/);
});

test("new tasks with a projectId are appended to the project file, not the inbox", () => {
  const create = buildProjectCreateChange("Launch", "Work", 1, [], () => projectId, "Goal text");
  assert.equal(create.relativePath, "專案/Launch.md");
  const files = [
    { relativePath: create.relativePath, sha256: "b".repeat(64), bytesBase64: create.replacementBase64 },
    file("收件匣/待辦.md", "# 待辦\r\n"),
  ];
  const scanned = scanStructuredVault(files);
  const newId = "33333333-3333-4333-8333-333333333333";
  const ideaId = "44444444-4444-4444-8444-444444444444";
  const desired = {
    ...scanned.snapshot,
    tasks: [
      ...scanned.snapshot.tasks,
      {
        schemaVersion: 6 as const, id: newId, title: "Ship docs", status: "todo" as const,
        taskDate: null, priority: "normal" as const, projectId, projectName: "Launch",
        rank: "a", sourcePath: null, sourceHeading: null, completedAt: null,
        body: "## Notes\n\nVisible under the task",
      },
      {
        schemaVersion: 6 as const, id: ideaId, title: "Loose idea", status: "todo" as const,
        taskDate: null, priority: "normal" as const, projectId: null, projectName: null,
        rank: "b", sourcePath: null, sourceHeading: null, completedAt: null,
      },
    ],
  };
  const changes = applyDesiredSnapshot(files, desired);
  const projectChange = changes.find((change) => change.relativePath === "專案/Launch.md");
  const inboxChange = changes.find((change) => change.relativePath === "收件匣/待辦.md");
  assert.ok(projectChange && projectChange.operation !== "delete");
  assert.ok(inboxChange && inboxChange.operation !== "delete");
  const projectText = base64ToText(projectChange.replacementBase64);
  assert.match(projectText, /Goal text/);
  assert.match(projectText, /Ship docs/);
  assert.match(projectText, /\[\[Launch\]\]/);
  assert.match(projectText, /  ## Notes/);
  assert.match(projectText, /Visible under the task/);
  assert.doesNotMatch(projectText, /Loose idea/);
  const inboxText = base64ToText(inboxChange.replacementBase64);
  assert.match(inboxText, /Loose idea/);
  assert.doesNotMatch(inboxText, /Ship docs/);
  const updatedFiles = files.map((item) => {
    const change = changes.find((candidate) => candidate.relativePath === item.relativePath);
    return change && "replacementBase64" in change && change.replacementBase64
      ? { ...item, bytesBase64: change.replacementBase64 }
      : item;
  });
  const rescanned = scanStructuredVault(updatedFiles);
  const reapplied = applyDesiredSnapshot(updatedFiles, {
    ...desired,
    projects: rescanned.snapshot.projects,
    collections: rescanned.snapshot.collections,
  });
  assert.equal(reapplied.length, 0);
});

test("changing status or schedule does not move a task to another file", () => {
  const linked = formatTaskLine({
    id: taskId, title: "Stay in inbox", status: "todo", taskDate: "2026-08-15",
    priority: "normal", projectId, projectName: "Launch", rank: "a",
    sourcePath: "收件匣/待辦.md", sourceHeading: null, completedAt: null,
  });
  const embeddedId = "33333333-3333-4333-8333-333333333333";
  const embedded = formatTaskLine({
    id: embeddedId, title: "Stay in project", status: "todo", taskDate: null,
    priority: "normal", projectId, projectName: "Launch", rank: "b",
    sourcePath: "專案/Launch.md", sourceHeading: null, completedAt: null,
  });
  const files = [
    file("專案/Launch.md", `---\r\ntype: project\r\nid: ${projectId}\r\n---\r\n# Launch\r\n\r\n${embedded}\r\n`),
    file("收件匣/待辦.md", `# 待辦\r\n${linked}\r\n`),
  ];
  const scanned = scanStructuredVault(files);
  const desired = {
    ...scanned.snapshot,
    tasks: scanned.snapshot.tasks.map((item) => {
      if (item.id === taskId) return { ...item, status: "doing" as const };
      if (item.id === embeddedId) {
        return { ...item, taskDate: "2026-08-20", startTime: "09:30", durationMinutes: 30, timeZone: "Asia/Taipei" };
      }
      return item;
    }),
  };
  const changes = applyDesiredSnapshot(files, desired);
  assert.equal(changes.length, 2);
  const inboxChange = changes.find((change) => change.relativePath === "收件匣/待辦.md")!;
  const projectChange = changes.find((change) => change.relativePath === "專案/Launch.md")!;
  const inboxText = base64ToText(inboxChange.replacementBase64);
  const projectText = base64ToText(projectChange.replacementBase64);
  assert.match(inboxText, /Stay in inbox/);
  assert.match(inboxText, /"status":"doing"/);
  assert.doesNotMatch(inboxText, /Stay in project/);
  assert.match(projectText, /Stay in project/);
  assert.match(projectText, /⏳ 2026-08-20/);
  assert.match(projectText, /⏰ 09:30/);
  assert.doesNotMatch(projectText, /Stay in inbox/);
});

test("new tasks append to a legacy Projects/ note when that is the project source", () => {
  const files = [
    file("Projects/Launch.md", `---\r\ntype: project\r\nid: ${projectId}\r\n---\r\n# Launch\r\n`),
    file("收件匣/待辦.md", "# 待辦\r\n"),
  ];
  const scanned = scanStructuredVault(files);
  const newId = "33333333-3333-4333-8333-333333333333";
  const desired = {
    ...scanned.snapshot,
    tasks: [{
      schemaVersion: 6 as const, id: newId, title: "Legacy project task", status: "todo" as const,
      taskDate: null, priority: "normal" as const, projectId, projectName: "Launch",
      rank: "a", sourcePath: null, sourceHeading: null, completedAt: null,
    }],
  };
  const changes = applyDesiredSnapshot(files, desired);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.relativePath, "Projects/Launch.md");
  assert.match(base64ToText(changes[0]!.replacementBase64), /Legacy project task/);
});

test("new tasks fall back to the inbox when the project file is missing", () => {
  const files = [file("收件匣/待辦.md", "# 待辦\r\n")];
  const desired = {
    schemaVersion: 6 as const,
    tasks: [{
      schemaVersion: 6 as const, id: taskId, title: "Orphan project task", status: "todo" as const,
      taskDate: null, priority: "normal" as const, projectId, projectName: "Launch",
      rank: "a", sourcePath: null, sourceHeading: null, completedAt: null,
    }],
    projects: [{
      schemaVersion: 6 as const, id: projectId, name: "Launch", sourcePath: "專案/Launch.md",
      status: "planning", area: null, priority: null, progress: 0, focusToday: false,
      startDate: null, endDate: null, completedAt: null,
    }],
    collections: [], routineTemplates: [], fileHashes: {},
  };
  const changes = applyDesiredSnapshot(files, desired);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.relativePath, "收件匣/待辦.md");
  assert.match(base64ToText(changes[0]!.replacementBase64), /Orphan project task/);
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
  const migrated = base64ToText(scanned.bootstrapChanges[0]!.replacementBase64);
  assert.doesNotMatch(migrated, /second-brain-task-content/);
  assert.match(migrated, /  - \[ \] #task Example only/);
});

test("indented task notes are not adopted as extra tasks", () => {
  const line = formatTaskLine({
    id: taskId, title: "Parent", status: "todo", taskDate: null, priority: "normal",
    projectId: null, projectName: null, rank: "a", sourcePath: "tasks.md",
    sourceHeading: null, completedAt: null,
  });
  const source = `${line}\r\n\r\n  - [ ] #task Example only\r\n`;
  const scanned = scanStructuredVault([file("tasks.md", source)]);
  assert.equal(scanned.snapshot.tasks.length, 1);
  assert.match(scanned.snapshot.tasks[0]?.body ?? "", /Example only/);
});

test("scan moves trailing HTML comment notes under the task without dropping its outline", () => {
  const line = formatTaskLine({
    id: taskId, title: "M09", status: "todo", taskDate: null, priority: "normal",
    projectId: null, projectName: null, rank: "a", sourcePath: "project.md",
    sourceHeading: null, completedAt: null,
  });
  const source = `${line}\r\n\r\n  - [ ] keep outline\r\n- [ ] #task Next <!-- publisher-task:{\"id\":\"22222222-2222-4222-8222-222222222222\",\"status\":\"todo\",\"rank\":\"b\"} -->\r\n<!-- second-brain-task-content:${taskId}:start -->\r\ntest123\r\n<!-- second-brain-task-content:${taskId}:end -->\r\n`;
  const scanned = scanStructuredVault([file("project.md", source)]);
  assert.equal(scanned.snapshot.tasks.length, 2);
  assert.match(scanned.snapshot.tasks[0]?.body ?? "", /keep outline/);
  assert.match(scanned.snapshot.tasks[0]?.body ?? "", /test123/);
  const migrated = base64ToText(scanned.bootstrapChanges[0]!.replacementBase64);
  assert.doesNotMatch(migrated, /second-brain-task-content/);
  assert.match(migrated, /#task M09[\s\S]*keep outline[\s\S]*test123[\s\S]*#task Next/);
});

test("scan migrates JSON-only startTime onto visible ⏰ ⏱ tokens", () => {
  const source = `- [ ] #task Timed <!-- publisher-task:{"id":"${taskId}","status":"todo","rank":"a","startTime":"09:30","durationMinutes":45,"timeZone":"Asia/Taipei"} -->\r\n`;
  const scanned = scanStructuredVault([file("tasks.md", source)]);
  assert.equal(scanned.snapshot.tasks[0]?.startTime, "09:30");
  assert.equal(scanned.snapshot.tasks[0]?.durationMinutes, 45);
  const patched = base64ToText(scanned.bootstrapChanges[0]!.replacementBase64);
  assert.match(patched, /⏰ 09:30/);
  assert.match(patched, /⏱ 45m/);
  assert.match(patched, /<!-- second-brain-task:/);
  assert.doesNotMatch(patched, /publisher-task:/);
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

test("project deletion unlinks canonical project-file tasks into 收件匣/待辦.md", () => {
  const embedded = formatTaskLine({
    id: taskId, title: "Keep me", status: "todo", taskDate: null,
    priority: "normal", projectId, projectName: "Launch", rank: "a",
    sourcePath: "專案/Launch.md", sourceHeading: null, completedAt: null,
  });
  const projectSource = `---\r\ntype: project\r\nid: ${projectId}\r\n---\r\n# Launch\r\n${embedded}\r\n`;
  const inboxPath = "收件匣/待辦.md";
  const files = [file("專案/Launch.md", projectSource), file(inboxPath, "# 待辦\r\n")];
  const scanned = scanStructuredVault(files);
  const changes = buildProjectDeleteChanges(files, scanned.snapshot, projectId);
  assert.equal(changes.find((change) => change.relativePath === "專案/Launch.md")?.operation, "delete");
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
  // would break every cross-reference the user already has. The first load still
  // rewrites the legacy publisher-task prefix.
  const legacy = '- [ ] #task 舊資料 <!-- publisher-task:{"id":"task-1","rank":"00000000"} -->\r\n';
  const result = scanStructuredVault([file("board.md", legacy)], () => taskId);
  assert.equal(result.snapshot.tasks[0]?.id, "task-1");
  const patched = base64ToText(result.bootstrapChanges[0]!.replacementBase64);
  assert.match(patched, /<!-- second-brain-task:/);
  assert.doesNotMatch(patched, /publisher-task:/);
  assert.match(patched, /"id":"task-1"/);
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

test("switching a task's project rewrites the wiki link and rescans to the new id", () => {
  // Regression for the detail-dialog project picker: every switch round-trips
  // through Markdown, so the [[link]] must survive and the next scan must
  // resolve the new project by name — including back to “no project”.
  const idA = "44444444-4444-4444-8444-444444444441";
  const idB = "44444444-4444-4444-8444-444444444442";
  const noteA = "---\r\ntype: project\r\nstatus: active\r\npublisher_id: " + idA + "\r\n---\r\n# 專案甲\r\n\r\n";
  const noteB = "---\r\ntype: project\r\nstatus: active\r\npublisher_id: " + idB + "\r\n---\r\n# 專案乙\r\n\r\n";
  let files = [
    file("projects/a.md", noteA),
    file("projects/b.md", noteB),
    file(
      "tasks.md",
      formatTaskLine({
        id: taskId, title: "自由切換", status: "todo", dueDate: null, plannedDate: null,
        priority: "normal", projectId: null, projectName: null, rank: "a",
        sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
      }) + "\r\n",
    ),
  ];
  const taskFile = () => files.find((item) => item.relativePath === "tasks.md")!;
  const scannedProjectId = () => scanStructuredVault(files).snapshot.tasks[0]?.projectId ?? null;

  const switchTo = (projectName: string | null) => {
    const scanned = scanStructuredVault(files);
    assert.equal(scanned.snapshot.tasks.length, 1);
    const desired = { ...scanned.snapshot, tasks: [{ ...scanned.snapshot.tasks[0]!, projectName }] };
    for (const change of applyDesiredSnapshot(files, desired)) {
      if (!change.replacementBase64) continue;
      files = files.map((item) => item.relativePath === change.relativePath
        ? { ...item, bytesBase64: change.replacementBase64 }
        : item);
    }
  };

  assert.equal(scannedProjectId(), null, "starts unassigned");

  switchTo("專案甲");
  assert.match(base64ToText(taskFile().bytesBase64), /\[\[專案甲\]\]/, "the wiki link is rewritten in place");
  assert.equal(scannedProjectId(), idA, "rescan resolves the new project id");

  switchTo("專案乙");
  assert.match(base64ToText(taskFile().bytesBase64), /\[\[專案乙\]\]/);
  assert.equal(scannedProjectId(), idB, "switching again resolves the other project");

  switchTo(null);
  assert.doesNotMatch(base64ToText(taskFile().bytesBase64), /\[\[/, "clearing the project drops the link");
  assert.equal(scannedProjectId(), null, "rescan returns to unassigned");
});

test("first load rewrites publisher-task and publisher_id but keeps the ids", () => {
  const projectSource = `---\r\ntype: project\r\npublisher_id: ${projectId}\r\n---\r\n# Launch\r\n`;
  const taskSource = `- [ ] #task Timed ⏳ 2026-08-15 <!-- publisher-task:{"id":"${taskId}","status":"todo","rank":"a"} -->\r\n`;
  const result = scanStructuredVault([
    file("Projects/Launch.md", projectSource),
    file("tasks.md", taskSource),
  ]);
  assert.equal(result.snapshot.projects[0]?.id, projectId);
  assert.equal(result.snapshot.tasks[0]?.id, taskId);
  const projectPatched = base64ToText(
    result.bootstrapChanges.find((change) => change.relativePath === "Projects/Launch.md")!.replacementBase64,
  );
  const taskPatched = base64ToText(
    result.bootstrapChanges.find((change) => change.relativePath === "tasks.md")!.replacementBase64,
  );
  assert.match(projectPatched, new RegExp(`id: ${projectId}`));
  assert.doesNotMatch(projectPatched, /publisher_id/);
  assert.match(taskPatched, /<!-- second-brain-task:/);
  assert.doesNotMatch(taskPatched, /publisher-task:/);
  assert.match(taskPatched, /⏳ 2026-08-15/);
});

test("already-canonical markers and ids are not rewritten on scan", () => {
  const projectSource = `---\r\ntype: project\r\nid: ${projectId}\r\n---\r\n# Launch\r\n`;
  const taskSource = `- [ ] #task Timed ⏳ 2026-08-15 <!-- second-brain-task:{"id":"${taskId}","status":"todo","rank":"a"} -->\r\n`;
  const result = scanStructuredVault([
    file("Projects/Launch.md", projectSource),
    file("tasks.md", taskSource),
  ]);
  assert.equal(result.snapshot.projects[0]?.id, projectId);
  assert.equal(result.snapshot.tasks[0]?.id, taskId);
  assert.equal(result.bootstrapChanges.length, 0);
});

test("new journal files write 日誌/YYYY-MM-DD.md with the four headings", () => {
  const change = buildJournalCreateChange("2026-08-15", []);
  assert.equal(change?.operation, "create");
  assert.equal(change?.relativePath, "日誌/2026-08-15.md");
  const body = base64ToText(change!.replacementBase64);
  assert.match(body, /^# 2026-08-15/);
  assert.match(body, /## 今日會議/);
  assert.match(body, /## 結論/);
  assert.match(body, /## 產生的任務/);
  assert.match(body, /## 可升級的知識/);
  assert.ok(!body.includes("2026-08-16"));
});

test("journal create does not write yesterday or tomorrow's file", () => {
  const today = buildJournalCreateChange("2026-08-15", ["日誌/2026-08-14.md", "日誌/2026-08-16.md"]);
  assert.equal(today?.relativePath, "日誌/2026-08-15.md");
  assert.equal(buildJournalCreateChange("2026-08-16", ["日誌/2026-08-15.md"])?.relativePath, "日誌/2026-08-16.md");
});

test("legacy 05-每日工作台 journal is opened instead of creating 日誌/", () => {
  assert.equal(
    buildJournalCreateChange("2026-08-15", ["05-每日工作台/2026-08-15.md"]),
    null,
  );
  assert.equal(
    buildJournalCreateChange("2026-08-15", ["日誌/2026-08-15.md"]),
    null,
  );
});

test("journal updates rewrite the existing file, including a legacy daily note", () => {
  const legacy = file("05-每日工作台/2026-08-15.md", "# 舊日誌\r\n\r\n結論\r\n");
  const change = buildJournalUpdateChange(legacy, "# 2026-08-15\n\n## 結論\n\n開源發表");
  assert.equal(change.relativePath, "05-每日工作台/2026-08-15.md");
  assert.notEqual(change.operation, "create");
  assert.equal(base64ToText(change.replacementBase64), "# 2026-08-15\r\n\r\n## 結論\r\n\r\n開源發表\r\n");
});

test("daily journal files are scanned as journals, not projects or collections", () => {
  const typed = `---\r\ntype: collection\r\ncategory: 日誌\r\n---\r\n# 2026-08-15\r\n`;
  const projectShaped = `---\r\ntype: project\r\nstatus: active\r\n---\r\n# 2026-08-15\r\n`;
  const result = scanStructuredVault([
    file("日誌/2026-08-15.md", typed),
    file("05-每日工作台/2026-08-16.md", projectShaped),
  ]);
  assert.equal(result.snapshot.collections.length, 0);
  assert.equal(result.snapshot.projects.length, 0);
});

test("tasks written under 產生的任務 stay on the journal file", () => {
  const task = formatTaskLine({
    id: taskId, title: "跟進會議", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId: null, projectName: null, rank: "a",
    sourcePath: "日誌/2026-08-15.md", sourceHeading: null, completedAt: null,
  });
  const source = `# 2026-08-15\r\n\r\n## 產生的任務\r\n\r\n${task}\r\n`;
  const result = scanStructuredVault([file("日誌/2026-08-15.md", source)]);
  assert.equal(result.snapshot.tasks.length, 1);
  assert.equal(result.snapshot.tasks[0]?.title, "跟進會議");
  assert.equal(result.snapshot.tasks[0]?.sourcePath, "日誌/2026-08-15.md");
});

test("invalid journal dates are rejected", () => {
  assert.throws(() => buildJournalCreateChange("2026-13-40", []), /INVALID_JOURNAL_DATE/);
});

test("saving an outcome as knowledge creates a new note and leaves the inbox and journal unchanged", () => {
  const taskLine = formatTaskLine({
    id: taskId, title: "寫第一份教學", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId: null, projectName: "開源發表", rank: "a",
    sourcePath: "收件匣/待辦.md", sourceHeading: null, completedAt: null,
    taskDate: "2026-08-15",
  });
  const inboxSource = `# 待辦\r\n\r\n${taskLine}\r\n\r\n  ## Notes\r\n\r\n  - 可見的任務清單\r\n`;
  const journalSource = renderDailyJournalDocument("2026-08-15").replace(
    "## 可升級的知識\r\n",
    "## 可升級的知識\r\n\r\n會議結論：改用可見 Markdown\r\n",
  );
  const inbox = file("收件匣/待辦.md", inboxSource);
  const journal = file("日誌/2026-08-15.md", journalSource);
  const files = [inbox, journal];
  const scanned = scanStructuredVault(files);
  const task = scanned.snapshot.tasks[0]!;
  assert.equal(task.title, "寫第一份教學");
  assert.match(task.body ?? "", /可見的任務清單/);

  const draft = buildOutcomeKnowledgeDraft({
    title: task.title,
    content: task.body ?? "",
    sourceDate: task.taskDate ?? "2026-08-15",
  });
  const create = buildCollectionCreateChange(
    draft.name,
    "方法",
    1,
    files.map((item) => item.relativePath),
    undefined,
    withRelatedProjectWikilink(draft.body, "開源發表"),
  );
  assert.equal(create.operation, "create");
  assert.equal(create.relativePath, "知識/方法/寫第一份教學.md");
  const created = base64ToText(create.replacementBase64);
  assert.match(created, /type: collection/);
  assert.match(created, /來源：2026-08-15/);
  assert.match(created, /可見的任務清單/);
  assert.match(created, /\[\[開源發表\]\]/);

  const afterCreate = scanStructuredVault([
    ...files,
    { relativePath: create.relativePath, sha256: "c".repeat(64), bytesBase64: create.replacementBase64 },
  ]);
  assert.equal(afterCreate.snapshot.collections.length, 1);
  assert.equal(afterCreate.snapshot.collections[0]?.name, "寫第一份教學");
  assert.equal(afterCreate.snapshot.tasks[0]?.title, "寫第一份教學");
  assert.equal(afterCreate.snapshot.tasks[0]?.sourcePath, "收件匣/待辦.md");
  assert.match(inboxSource, /寫第一份教學/);
  assert.match(journalSource, /會議結論：改用可見 Markdown/);
  assert.equal(journalUpgradeContent(journalSource), "會議結論：改用可見 Markdown");
});

test("completing a task does not create a knowledge file", () => {
  const taskLine = formatTaskLine({
    id: taskId, title: "寫第一份教學", status: "todo", dueDate: null, plannedDate: null,
    priority: "normal", projectId: null, projectName: null, rank: "a",
    sourcePath: "收件匣/待辦.md", sourceHeading: null, completedAt: null,
    taskDate: "2026-08-15",
  });
  const files = [file("收件匣/待辦.md", `# 待辦\r\n\r\n${taskLine}\r\n`)];
  const scanned = scanStructuredVault(files);
  const changes = applyDesiredSnapshot(files, {
    ...scanned.snapshot,
    tasks: scanned.snapshot.tasks.map((task) => task.id === taskId
      ? { ...task, status: "done" as const, completedAt: "2026-08-15" }
      : task),
  });
  assert.ok(changes.some((change) => change.relativePath === "收件匣/待辦.md"));
  assert.equal(changes.some((change) => change.relativePath.startsWith("知識/")), false);
  assert.equal(changes.some((change) => change.operation === "create"), false);
});

test("layout migration copies exact bytes to the new path and deletes the old file", () => {
  const source = "\uFEFF---\r\ntype: project\r\nid: " + projectId + "\r\n---\r\n# A\r\n";
  const files = [file("Projects/A.md", source)];
  const plan = planVaultLayoutMigration([{ relativePath: "Projects/A.md", entityType: "project" }]);
  const changes = buildLayoutMigrationChanges(files, plan);
  assert.deepEqual(
    changes.map((change) => [change.operation ?? "write", change.relativePath]),
    [
      ["create", "專案/A.md"],
      ["delete", "Projects/A.md"],
    ],
  );
  assert.equal(changes[0] && "replacementBase64" in changes[0] ? changes[0].replacementBase64 : "", files[0]!.bytesBase64);
  assert.equal(changes[1]?.expectedSha256, files[0]!.sha256);
});

test("layout migration never emits changes for duplicate destinations", () => {
  const files = [
    file("Projects/A.md", "---\ntype: project\n---\n# A\n"),
    file("專案/A.md", "---\ntype: project\n---\n# A\n"),
  ];
  const plan = planVaultLayoutMigration([
    { relativePath: "Projects/A.md", entityType: "project" },
    { relativePath: "專案/A.md", entityType: "project" },
  ]);
  assert.equal(plan.moves.length, 0);
  assert.equal(buildLayoutMigrationChanges(files, plan).length, 0);
});

test("layout migration skips non-markdown attachments so native md writes stay .md-only", () => {
  const files = [file("99-附件/開源發表/shot.png", "not-markdown")];
  const plan = planVaultLayoutMigration([{ relativePath: "99-附件/開源發表/shot.png" }]);
  assert.equal(plan.moves[0]?.to, "附件/開源發表/shot.png");
  assert.equal(buildLayoutMigrationChanges(files, plan).length, 0);
});