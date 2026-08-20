import assert from "node:assert/strict";
import test from "node:test";
import { renderVaultIndex } from "@second-brain/brain-core";
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
