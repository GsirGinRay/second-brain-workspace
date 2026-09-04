import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeEntityFrontmatterId,
  canonicalizeTaskMarker,
  formatTaskLine,
  parseCollectionFrontmatter,
  parseProjectFrontmatter,
  parseTaskLine,
  patchTaskLine,
  updateProjectFrontmatter,
} from "./index";

const legacyMarker =
  '<!-- publisher-task:{"id":"task-1","status":"todo","rank":"1"} -->';
const canonicalMarker =
  '<!-- second-brain-task:{"id":"task-1","status":"todo","rank":"1"} -->';

test("parseTaskLine reads both publisher-task and second-brain-task markers", () => {
  const legacy = parseTaskLine(`- [ ] #task Legacy ${legacyMarker}`, "a.md", 0);
  const next = parseTaskLine(`- [ ] #task Next ${canonicalMarker}`, "a.md", 0);
  assert.equal(legacy?.id, "task-1");
  assert.equal(legacy?.status, "todo");
  assert.equal(next?.id, "task-1");
  assert.equal(next?.rank, "1");
});

test("formatTaskLine writes second-brain-task and never publisher-task", () => {
  const line = formatTaskLine({
    id: "task-1",
    title: "Ship",
    status: "todo",
    taskDate: "2026-08-15",
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: "1",
    sourcePath: "a.md",
    sourceHeading: null,
    completedAt: null,
  });
  assert.match(line, /<!-- second-brain-task:\{/);
  assert.doesNotMatch(line, /publisher-task:/);
  assert.equal(parseTaskLine(line, "a.md", 0)?.id, "task-1");
});

test("patchTaskLine rewrites a legacy marker prefix while keeping unknown fields", () => {
  const raw =
    '- [ ] #task Keep ⏳ 2026-08-14 <!-- publisher-task:{"id":"task-1","status":"todo","rank":"1","unknown":"keep"} -->';
  const parsed = parseTaskLine(raw, "a.md", 0);
  assert.ok(parsed);
  const patched = patchTaskLine(raw, parsed);
  assert.match(patched, /<!-- second-brain-task:\{/);
  assert.doesNotMatch(patched, /publisher-task:/);
  assert.match(patched, /"unknown":"keep"/);
  assert.match(patched, /⏳ 2026-08-14/);
});

test("canonicalizeTaskMarker is a no-op for the new prefix and content comments", () => {
  assert.equal(canonicalizeTaskMarker(`- [ ] #task X ${canonicalMarker}`), `- [ ] #task X ${canonicalMarker}`);
  const content = "<!-- second-brain-task-content:11111111-1111-4111-8111-111111111111:start -->";
  assert.equal(canonicalizeTaskMarker(content), content);
});

test("project and collection frontmatter prefer id and still read publisher_id", () => {
  const legacyProject = parseProjectFrontmatter(
    "---\ntype: project\npublisher_id: project-1\n---\n# Launch\n",
    "Launch.md",
  );
  const canonicalProject = parseProjectFrontmatter(
    "---\ntype: project\nid: project-2\n---\n# Launch\n",
    "Launch.md",
  );
  const both = parseProjectFrontmatter(
    "---\ntype: project\nid: project-new\npublisher_id: project-old\n---\n# Launch\n",
    "Launch.md",
  );
  assert.equal(legacyProject?.id, "project-1");
  assert.equal(canonicalProject?.id, "project-2");
  assert.equal(both?.id, "project-new");

  const legacyCollection = parseCollectionFrontmatter(
    "---\ntype: collection\npublisher_id: col-1\n---\n# Notes\n",
    "Notes.md",
  );
  const canonicalCollection = parseCollectionFrontmatter(
    "---\ntype: collection\nid: col-2\n---\n# Notes\n",
    "Notes.md",
  );
  assert.equal(legacyCollection?.id, "col-1");
  assert.equal(canonicalCollection?.id, "col-2");
});

test("frontmatter writes id and renames publisher_id in place", () => {
  const source = "---\r\ntype: project\r\npublisher_id: project-1\r\nstatus: active\r\n---\r\n# Launch\r\n";
  const renamed = canonicalizeEntityFrontmatterId(source);
  assert.match(renamed, /^---\r\ntype: project\r\nid: project-1\r\n/);
  assert.doesNotMatch(renamed, /publisher_id/);
  assert.equal(canonicalizeEntityFrontmatterId(renamed), renamed);

  const both =
    "---\ntype: collection\nid: col-new\npublisher_id: col-old\n---\n# Notes\n";
  const dropped = canonicalizeEntityFrontmatterId(both);
  assert.match(dropped, /^---\ntype: collection\nid: col-new\n---/);
  assert.doesNotMatch(dropped, /publisher_id/);

  const updated = updateProjectFrontmatter(source, { status: "done" });
  assert.match(updated, /id: project-1/);
  assert.match(updated, /status: done/);
  assert.doesNotMatch(updated, /publisher_id/);
});
