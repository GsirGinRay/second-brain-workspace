import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "./markdown-editor";

test("Markdown preview renders useful syntax without interpreting raw HTML", () => {
  const html = renderToStaticMarkup(<MarkdownPreview value={'## Title\n\n- **Bold**\n\n<script>alert(1)</script>'} />);
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(1\)/);
});
