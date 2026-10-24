import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskLine, type BrainTaskSnapshot } from "@second-brain/brain-core";
import { VaultLoader } from "./vault-loader";

const id = "11111111-1111-4111-8111-111111111111";
const originalTask: BrainTaskSnapshot = {
  schemaVersion: 2, id, title: "本機任務", status: "todo", dueDate: null,
  plannedDate: null, priority: "normal", projectId: null, projectName: null,
  rank: "a", sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
};

function base64(text: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(text))); }

test("loading again only reads files whose hash changed since the last read", async () => {
  const hashes: Record<string, string> = { "a.md": "a".repeat(64), "b.md": "b".repeat(64) };
  const contents: Record<string, string> = { "a.md": "# A\r\n", "b.md": "# B\r\n" };
  const requested: string[][] = [];
  const native = {
    async scanVault() {
      return Object.keys(hashes).map((relativePath) => ({ relativePath, sha256: hashes[relativePath]!, bytes: 4, hasBom: false, newline: "cr_lf" as const }));
    },
    async readMarkdownFiles(paths: string[]) {
      requested.push([...paths]);
      return paths.map((relativePath) => ({ relativePath, sha256: hashes[relativePath]!, bytesBase64: base64(contents[relativePath]!) }));
    },
  } as unknown as ConstructorParameters<typeof VaultLoader>[0];
  const loader = new VaultLoader(native);
  await loader.loadLocal();
  hashes["b.md"] = "c".repeat(64);
  contents["b.md"] = "# B2\r\n";
  const second = await loader.loadLocal();
  // A new loader on the same adapter (the app makes one per reload) shares the cache.
  delete hashes["a.md"];
  const third = await new VaultLoader(native).loadLocal();
  assert.deepEqual(requested, [["a.md", "b.md"], ["b.md"]]);
  assert.deepEqual(second.files.map((file) => atob(file.bytesBase64)), ["# A\r\n", "# B2\r\n"]);
  assert.deepEqual(third.files.map((file) => file.relativePath), ["b.md"]);
});

test("loading an unchanged vault again reuses the parse but never shares it with callers", async () => {
  let content = formatTaskLine(originalTask) + "\r\n";
  let hash = "a".repeat(64);
  const native = {
    async scanVault() { return [{ relativePath: "tasks.md", sha256: hash, bytes: content.length, hasBom: false, newline: "cr_lf" as const }]; },
    async readMarkdownFiles() { return [{ relativePath: "tasks.md", sha256: hash, bytesBase64: base64(content) }]; },
  } as unknown as ConstructorParameters<typeof VaultLoader>[0];
  const load = () => new VaultLoader(native).loadLocal();
  const first = await load();
  first.tasks[0]!.title = "changed by a caller";
  first.tasks.push({ ...originalTask, id: "33333333-3333-4333-8333-333333333333" });
  const second = await load();
  assert.deepEqual(second.tasks.map((task) => task.title), ["本機任務"]);
  content = formatTaskLine({ ...originalTask, title: "改過的任務" }) + "\r\n";
  hash = "b".repeat(64);
  const third = await load();
  assert.deepEqual(third.tasks.map((task) => task.title), ["改過的任務"]);
});

test("files in subfolders survive when the scan uses backslashes and reads use slashes", async () => {
  const native = {
    async scanVault() {
      return ["10-收件匣\\待辦.md", "root.md"].map((relativePath) => ({ relativePath, sha256: "d".repeat(64), bytes: 4, hasBom: false, newline: "cr_lf" as const }));
    },
    async readMarkdownFiles(paths: string[]) {
      return paths.map((relativePath) => ({ relativePath: relativePath.replace(/\\/g, "/"), sha256: "d".repeat(64), bytesBase64: base64("# X\r\n") }));
    },
  } as unknown as ConstructorParameters<typeof VaultLoader>[0];
  for (let load = 0; load < 2; load += 1) {
    const local = await new VaultLoader(native).loadLocal();
    assert.deepEqual(local.files.map((file) => file.relativePath), ["10-收件匣/待辦.md", "root.md"]);
  }
});
