import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTaskMarkdownContent,
  parseProjectFrontmatter,
  patchTaskMarkdownContent,
  replaceMarkdownDocumentBody,
} from "./index";

const taskId = "11111111-1111-4111-8111-111111111111";

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

test("task Markdown content round-trips in a stable hidden block", () => {
  const source = "# Tasks\r\n- [ ] #task Draft <!-- publisher-task:{\"id\":\"11111111-1111-4111-8111-111111111111\"} -->\r\n";
  const body = "## Notes\r\n\r\n- Preserve **Markdown**";
  const next = patchTaskMarkdownContent(source, taskId, body);
  assert.equal(extractTaskMarkdownContent(next, taskId), body);
  assert.ok(next.includes("\r\n<!-- second-brain-task-content:"));
  assert.equal(patchTaskMarkdownContent(next, taskId, ""), source);
});
