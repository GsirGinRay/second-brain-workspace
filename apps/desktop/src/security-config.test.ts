import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const capabilityPath = resolve(
  import.meta.dirname,
  "../src-tauri/capabilities/default.json",
);

test("Tauri capability does not grant filesystem or shell/process plugins", () => {
  const capability = readFileSync(capabilityPath, "utf8");
  assert.match(capability, /core:default/);
  assert.doesNotMatch(capability, /fs:|shell:|process:|plugin:fs|plugin:shell/i);
  assert.doesNotMatch(capability, /\*\*/);
});

test("WP6 enables sync only through explicit native commands", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src-tauri/src/lib.rs"),
    "utf8",
  );
  assert.match(source, /const SYNC_AGENT_ENABLED: bool = true/);
  assert.match(source, /apply_markdown_changes/);
  assert.match(source, /save_pending_commit/);
});
