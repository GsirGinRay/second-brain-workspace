import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { renderVaultIndex, TEMPLATE_PACKS } from "@second-brain/brain-core";
import { decodeBase64, renderIndexChange, scaffoldArchitectureChanges } from "./architecture";
import type { LocalMarkdownFile } from "./vault";

function file(relativePath: string, content: string): LocalMarkdownFile {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    relativePath,
    sha256: "a".repeat(64),
    bytesBase64: btoa(binary),
  };
}

test("scaffoldArchitectureChanges emits create changes only for missing files", () => {
  const changes = scaffoldArchitectureChanges(
    [], // empty vault
    ["projects", "prompts", "ai"],
  );
  const paths = changes.map((change) => change.relativePath);
  assert.ok(paths.includes(".ai/INSTRUCTIONS.md"));
  assert.ok(paths.includes("CLAUDE.md"));
  assert.ok(paths.includes("AGENTS.md"));
  assert.ok(paths.includes("10-收件匣/待辦收件匣.md"));
  assert.ok(paths.includes("Collections/股票選股分析.md"));
  assert.ok(changes.every((change) => change.operation === "create"));
});

test("scaffoldArchitectureChanges skips files that already exist (case-insensitive)", () => {
  const existing = [".ai/INSTRUCTIONS.md", "CLAUDE.md"];
  const changes = scaffoldArchitectureChanges(existing, ["ai"]);
  const paths = changes.map((change) => change.relativePath);
  assert.ok(!paths.includes(".ai/INSTRUCTIONS.md"));
  assert.ok(!paths.includes("CLAUDE.md"));
  assert.ok(paths.includes("AGENTS.md"));
});

test("first-run samples skip an existing inbox and still create missing project files", () => {
  let n = 0;
  const changes = scaffoldArchitectureChanges(
    ["10-收件匣/待辦收件匣.md"],
    TEMPLATE_PACKS.map((pack) => pack.id),
    {
      today: "2026-08-15",
      samples: true,
      createId: () => `11111111-1111-4111-8111-11111111111${n++}`,
    },
  );
  const paths = changes.map((change) => change.relativePath);
  assert.ok(!paths.includes("10-收件匣/待辦收件匣.md"));
  assert.ok(paths.some((path) => path.startsWith("Projects/") && path !== "Projects/README.md"));
  assert.ok(paths.some((path) => path.startsWith("Collections/") && path !== "Collections/README.md"));
  assert.ok(changes.every((change) => change.operation === "create"));
});

test("sample vault uses official folder conventions and visible task Markdown", () => {
  const root = resolve(import.meta.dirname, "../../../examples/sample-vault");
  const rootNames = readdirSync(root);
  assert.ok(!rootNames.includes("Inbox.md"));
  assert.ok(!rootNames.includes("Personal System.md"));
  assert.ok(!rootNames.includes("Prompt Library.md"));
  const project = join(root, "Projects", "Personal System.md");
  const collection = join(root, "Collections", "Prompt Library.md");
  const inbox = join(root, "10-收件匣", "待辦收件匣.md");
  assert.ok(existsSync(project));
  assert.ok(existsSync(collection));
  assert.ok(existsSync(inbox));
  const projectText = readFileSync(project, "utf8");
  const collectionText = readFileSync(collection, "utf8");
  const inboxText = readFileSync(inbox, "utf8");
  assert.match(projectText, /^---\r?\ntype: project\r?\npublisher_id: [0-9a-f-]{36}/i);
  assert.match(collectionText, /^---\r?\ntype: collection\r?\npublisher_id: [0-9a-f-]{36}/i);
  assert.match(inboxText, /⏳ 2026-08-15/);
  assert.match(inboxText, /⏰ 09:30/);
  assert.match(inboxText, /⏱ 30m/);
  assert.match(inboxText, /\n  ## Notes\n/);
  assert.doesNotMatch(inboxText, /publisher_id/);
  assert.doesNotMatch(inboxText, /<!-- publisher-task:/);
});

test("renderIndexChange returns null when index is unchanged", () => {
  const input = {
    today: "2026-08-15",
    generatedAt: "2026-08-15T00:00:00.000Z",
    tasks: [],
    projects: [],
    collections: [],
  };
  const existing = file(".ai/INDEX.md", renderVaultIndex(input));
  assert.equal(renderIndexChange(input, existing), null);
});

test("renderIndexChange returns null when only the generated-at timestamp differs", () => {
  // Every render stamps a new millisecond timestamp; identical vault content
  // must not count as a change, or every scan rewrites the file (git churn)
  // and invalidates concurrently prepared hashes (scaffold-confirm race).
  const base = {
    today: "2026-08-15",
    tasks: [],
    projects: [],
    collections: [],
  };
  const existing = file(
    ".ai/INDEX.md",
    renderVaultIndex({ ...base, generatedAt: "2026-08-15T00:00:00.000Z" }),
  );
  assert.equal(
    renderIndexChange(
      { ...base, generatedAt: "2026-08-15T09:41:07.123Z" },
      existing,
    ),
    null,
  );
});

test("renderIndexChange emits a create when index is missing and write when changed", () => {
  const input = {
    today: "2026-08-15",
    generatedAt: "2026-08-15T00:00:00.000Z",
    tasks: [],
    projects: [],
    collections: [],
  };
  const created = renderIndexChange(input, undefined);
  assert.ok(created);
  assert.equal(created.operation, "create");
  // A different on-disk index forces a write.
  const stale = file(".ai/INDEX.md", "# stale");
  const written = renderIndexChange(input, stale);
  assert.ok(written);
  assert.equal(written.operation, "write");
  assert.equal(written.expectedSha256, stale.sha256);
});
