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

test("Publisher sync is implemented only through explicit native commands", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src-tauri/src/lib.rs"),
    "utf8",
  );
  assert.match(source, /publisher_http_request/);
  assert.match(source, /open_publisher_pairing/);
  assert.match(source, /apply_markdown_changes/);
  assert.match(source, /save_pending_commit/);
});

test("WebView CSP never grants arbitrary HTTPS connectivity", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"));
  const connectSource = String(config.app.security.csp).match(/connect-src\s+([^;]+)/i)?.[1] ?? "";
  assert.doesNotMatch(connectSource, /https:/i);
  assert.doesNotMatch(connectSource, /(^|\s)\*(\s|$)/);
});
