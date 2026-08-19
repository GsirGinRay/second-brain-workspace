import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor, MarkdownPreview } from "./markdown-editor";

test("Markdown preview renders useful syntax without interpreting raw HTML", () => {
  const html = renderToStaticMarkup(<MarkdownPreview value={'## Title\n\n- **Bold**\n\n<script>alert(1)</script>'} />);
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(1\)/);
});

test("Markdown preview renders fenced code blocks with a copy control", () => {
  const html = renderToStaticMarkup(<MarkdownPreview value={"```js\nconst a = 1;\n```"} />);
  assert.match(html, /class="code-block"/);
  assert.match(html, /class="code-copy"/);
  assert.match(html, /<pre><code class="language-js">const a = 1;\s*<\/code><\/pre>/);
  assert.match(html, /複製<\/button>/);
});

test("MarkdownEditor starts in write mode and honours a controlled preview mode", () => {
  const write = renderToStaticMarkup(<MarkdownEditor value="# Hi" onChange={() => {}} />);
  assert.match(write, /<textarea/);
  const preview = renderToStaticMarkup(<MarkdownEditor value="# Hi" mode="preview" onModeChange={() => {}} onChange={() => {}} />);
  assert.match(preview, /<h1>Hi<\/h1>/);
  assert.doesNotMatch(preview, /<textarea/);
});

test("MarkdownEditor renders an icon-only toggle instead of the segmented control", () => {
  const html = renderToStaticMarkup(<MarkdownEditor value="# Hi" mode="preview" iconToggle onModeChange={() => {}} onChange={() => {}} />);
  assert.match(html, /editor-toggle-icon/);
  assert.doesNotMatch(html, /segmented-control/);
  assert.match(html, /<h1>Hi<\/h1>/);
});

test("MarkdownEditor write mode shows a basic formatting toolbar with code block and inline helpers", () => {
  const html = renderToStaticMarkup(<MarkdownEditor value="" onChange={() => {}} />);
  assert.match(html, /markdown-toolbar/);
  assert.match(html, /aria-label="程式碼區塊"/);
  assert.match(html, /aria-label="粗體"/);
  assert.match(html, /aria-label="分隔線"/);
  const preview = renderToStaticMarkup(<MarkdownEditor value="" mode="preview" onModeChange={() => {}} onChange={() => {}} />);
  assert.doesNotMatch(preview, /markdown-toolbar/);
});