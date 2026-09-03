import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTaskMarkdownContent,
  parseProjectFrontmatter,
  patchTaskMarkdownContent,
  replaceMarkdownDocumentBody,
} from "./index";

const taskId = "11111111-1111-4111-8111-111111111111";
const taskLine = `- [ ] #task Draft <!-- publisher-task:{"id":"${taskId}"} -->`;

test("project parser exposes full Markdown body", () => {
  const source = `---\r\ntype: project\r\n---\r\n# Launch\r\n\r\n## Outcome\r\n\r\n- **Ship** safely\r\n`;
  assert.equal(parseProjectFrontmatter(source, "Projects/Launch.md")?.body, "## Outcome\n\n- **Ship** safely");
});

test("document body replacement preserves BOM, CRLF, heading and frontmatter", () => {
  const source = "\uFEFF---\r\ntype: collection\r\ncustom: keep\r\n---\r\n# Prompt\r\n\r\nold\r\n";
  const next = replaceMarkdownDocumentBody(source, "## Role\n\nYou are **helpful**.");
  assert.ok(next.startsWith("\uFEFF---\r\n"));
  assert.match(next, /custom: keep/);
  assert.match(next, /# Prompt\r\n\r\n## Role\r\n\r\nYou are \*\*helpful\*\*\.\r\n$/);
});

test("task Markdown content round-trips as indented notes under the list item", () => {
  const source = `# Tasks\r\n${taskLine}\r\n`;
  const body = "## Notes\r\n\r\n- Preserve **Markdown**";
  const next = patchTaskMarkdownContent(source, taskId, body);
  assert.equal(extractTaskMarkdownContent(next, taskId), body);
  assert.match(next, /\r\n\r\n  ## Notes\r\n  \r\n  - Preserve \*\*Markdown\*\*\r\n/);
  assert.doesNotMatch(next, /second-brain-task-content/);
  assert.equal(patchTaskMarkdownContent(next, taskId, ""), source);
});

test("task Markdown content still reads a legacy HTML comment block", () => {
  const source = `# Tasks\r\n${taskLine}\r\n<!-- second-brain-task-content:${taskId}:start -->\r\n## Notes\r\n\r\nlegacy\r\n<!-- second-brain-task-content:${taskId}:end -->\r\n`;
  assert.equal(extractTaskMarkdownContent(source, taskId), "## Notes\r\n\r\nlegacy");
  const next = patchTaskMarkdownContent(source, taskId, "## Notes\r\n\r\nlegacy");
  assert.doesNotMatch(next, /second-brain-task-content/);
  assert.match(next, /  ## Notes\r\n  \r\n  legacy\r\n/);
});

test("indented task notes keep nested #task examples inside the parent body", () => {
  const source = `# Tasks\r\n${taskLine}\r\n`;
  const next = patchTaskMarkdownContent(source, taskId, "- [ ] #task Example only");
  assert.match(next, /  - \[ \] #task Example only/);
  assert.equal(extractTaskMarkdownContent(next, taskId), "- [ ] #task Example only");
});
