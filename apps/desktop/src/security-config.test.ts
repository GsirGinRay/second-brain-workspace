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

test("Tauri capability grants the window close commands the close flow relies on", () => {
  const capability = readFileSync(capabilityPath, "utf8");
  assert.match(capability, /core:window:allow-close/);
  assert.match(capability, /core:window:allow-destroy/);
});

test("Markdown writes go through explicit native commands and nothing syncs to a server", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src-tauri/src/lib.rs"),
    "utf8",
  );
  assert.match(source, /apply_markdown_changes/);
  assert.doesNotMatch(source, /publisher_http_request|open_publisher_pairing|save_pending_commit/);
});

test("WebView CSP never grants arbitrary HTTPS connectivity", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"));
  const connectSource = String(config.app.security.csp).match(/connect-src\s+([^;]+)/i)?.[1] ?? "";
  assert.doesNotMatch(connectSource, /https:/i);
  assert.doesNotMatch(connectSource, /(^|\s)\*(\s|$)/);
});

test("WebView img-src allows blob previews but not https images", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"));
  const imgSource = String(config.app.security.csp).match(/img-src\s+([^;]+)/i)?.[1] ?? "";
  assert.match(imgSource, /blob:/);
  assert.doesNotMatch(imgSource, /https:/i);
});
