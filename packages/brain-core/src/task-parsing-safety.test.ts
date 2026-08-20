import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodeFenceTracker,
  extractTaskMarkdownContent,
  isManagedTaskId,
  isValidTaskId,
  parseTaskLine,
  patchTaskMarkdownContent,
} from "./index";

const VALID_ID = "914039bd-7b48-42f8-93fc-eb942a2d87b7";

/**
 * Regression cover for two defects found while a vault contained ordinary
 * documentation about the task format:
 *
 *  1. Task syntax inside a fenced code block was adopted as a real task, so
 *     writing "this is what a task looks like" in a note created a phantom task
 *     and rewrote the documentation.
 *  2. A placeholder id in such an example reached taskContentMarkers and threw
 *     TASK_ID_INVALID, aborting the entire vault scan with an error that named
 *     no file.
 */

test("code fence tracker skips fenced content and the delimiters themselves", () => {
  const lines = [
    "# Doc",
    "```markdown",
    "- [ ] #task example inside a fence",
    "```",
    "- [ ] #task real task",
  ];
  const inFence = createCodeFenceTracker();
  const skipped = lines.map((line) => inFence(line));
  assert.deepEqual(skipped, [false, true, true, true, false]);
});

test("code fence tracker handles tildes, longer closing fences and info strings", () => {
  const inFence = createCodeFenceTracker();
  assert.equal(inFence("~~~ts"), true, "opening tilde fence");
  assert.equal(inFence("- [ ] #task inside"), true, "content inside fence");
  assert.equal(inFence("```"), true, "backticks do not close a tilde fence");
  assert.equal(inFence("~~~~"), true, "longer closing fence is accepted");
  assert.equal(inFence("- [ ] #task outside"), false, "fence closed");
});

test("an unterminated fence keeps the rest of the file quarantined", () => {
  const inFence = createCodeFenceTracker();
  assert.equal(inFence("```"), true);
  assert.equal(inFence("- [ ] #task never adopted"), true);
});

test("an id that could break out of the marker is dropped, not carried", () => {
  const line =
    '- [ ] #task 壞掉 <!-- publisher-task:{"id":"not a valid id","status":"todo"} -->';
  const parsed = parseTaskLine(line, "doc.md", 0);
  assert.ok(parsed, "line still parses as a task");
  assert.equal(parsed.id, null, "unsafe id is dropped so a fresh one is minted");
});

test("a placeholder id is safe to keep and no longer aborts anything", () => {
  // The original crash: "..." reached taskContentMarkers and threw
  // TASK_ID_INVALID, killing the whole scan. It is harmless to retain — it
  // cannot break the marker — and body lookups simply return nothing.
  const line =
    '- [ ] #task 修除權息顯示 <!-- publisher-task:{"id":"...","status":"todo","rank":"..."} -->';
  const parsed = parseTaskLine(line, "doc.md", 0);
  assert.equal(parsed?.id, "...");
  assert.equal(extractTaskMarkdownContent("# Note\n", "..."), "");
});

test("a valid marker id is preserved", () => {
  const line = `- [ ] #task real <!-- publisher-task:{"id":"${VALID_ID}","status":"todo","rank":"00000000"} -->`;
  const parsed = parseTaskLine(line, "board.md", 0);
  assert.equal(parsed?.id, VALID_ID);
});

test("body helpers degrade instead of throwing on an unusable id", () => {
  const source = "# Note\n";
  assert.equal(extractTaskMarkdownContent(source, "..."), "");
  assert.equal(patchTaskMarkdownContent(source, "...", "body"), source);
});

test("id validation separates 'safe to store' from 'minted by this app'", () => {
  // Lenient: foreign ids from older vaults or other tools must survive, or the
  // app would silently re-identify every task it did not create itself.
  assert.equal(isValidTaskId(VALID_ID), true);
  assert.equal(isValidTaskId("task-1"), true, "legacy short id kept");
  assert.equal(isValidTaskId("..."), true, "harmless placeholder kept");
  assert.equal(isValidTaskId("has space"), false);
  assert.equal(isValidTaskId("-->injected"), false);
  assert.equal(isValidTaskId(""), false);
  assert.equal(isValidTaskId(undefined), false);

  // Strict: content-block delimiters are only built for app-minted UUIDs.
  assert.equal(isManagedTaskId(VALID_ID), true);
  assert.equal(isManagedTaskId("task-1"), false);
  assert.equal(isManagedTaskId("..."), false);
});
