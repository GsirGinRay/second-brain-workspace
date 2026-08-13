import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskLine, type BrainTaskSnapshot } from "@second-brain/brain-core";
import { SyncEngine, type SyncDeviceClient } from "./sync-engine";
import type { NativeAdapter, PendingCommitRecord } from "./ipc";

const id = "11111111-1111-4111-8111-111111111111";
const originalTask: BrainTaskSnapshot = {
  schemaVersion: 2, id, title: "本機任務", status: "todo", dueDate: null,
  plannedDate: null, priority: "normal", projectId: null, projectName: null,
  rank: "a", sourcePath: "tasks.md", sourceHeading: null, completedAt: null,
};

function base64(text: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(text))); }

function harness(commitFails = false) {
  let content = formatTaskLine(originalTask) + "\r\n";
  let pending: PendingCommitRecord | null = null;
  const confirmed: string[] = [];
  const native = {
    async scanVault() { return [{ relativePath: "tasks.md", sha256: "a".repeat(64), bytes: content.length, hasBom: false, newline: "cr_lf" as const }]; },
    async readMarkdownFiles() { return [{ relativePath: "tasks.md", sha256: "a".repeat(64), bytesBase64: base64(content) }]; },
    async applyMarkdownChanges(changes) {
      const bytes = Uint8Array.from(atob(changes[0]!.replacementBase64), (character) => character.charCodeAt(0));
      content = new TextDecoder().decode(bytes);
      return { journalPath: `journal-${confirmed.length}.journal.json`, backupPath: "backup.zip" };
    },
    async confirmServerCommit(path) { confirmed.push(path); },
    async savePendingCommit(value) { pending = value; },
    async loadPendingCommit() { return pending; },
    async clearPendingCommit() { pending = null; },
    async pendingJournals() { return []; },
  } as Pick<NativeAdapter, "scanVault" | "readMarkdownFiles" | "applyMarkdownChanges" | "confirmServerCommit" | "savePendingCommit" | "loadPendingCommit" | "clearPendingCommit" | "pendingJournals">;
  const client: SyncDeviceClient = {
    async getState() { return { kind: "modified", etag: '"brain-1"', state: { revision: 1, pendingCount: 0, lastSyncAt: null } }; },
    async createPlan(input) { return { planId: "22222222-2222-4222-8222-222222222222", baseRevision: 1, targetRevision: 1, payloadDigest: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), desiredTasks: [{ ...input.tasks[0]!, title: "雲端合併" }], desiredProjects: [], conflicts: [] }; },
    async commitPlan() { if (commitFails) throw new Error("network"); return { ok: true }; },
    async getPlanStatus() { throw new Error("network"); },
  };
  return { engine: new SyncEngine(native, client), getContent: () => content, getPending: () => pending, confirmed };
}

test("sync engine writes merged markdown, durably records commit, then confirms journal", async () => {
  const value = harness();
  const result = await value.engine.sync();
  assert.equal(result.kind, "synced");
  assert.match(value.getContent(), /雲端合併/);
  assert.equal(value.getPending(), null);
  assert.equal(value.confirmed.length, 1);
});

test("lost commit response keeps durable pending commit and journal for retry", async () => {
  const value = harness(true);
  await assert.rejects(() => value.engine.sync(), /network/);
  assert.ok(value.getPending());
  assert.equal(value.confirmed.length, 0);
});

test("shadow preview creates a plan without writing Markdown or committing", async () => {
  const value = harness();
  const before = value.getContent();
  const result = await value.engine.sync({ previewOnly: true });
  assert.equal(result.kind, "preview");
  assert.equal(value.getContent(), before);
  assert.equal(value.getPending(), null);
  assert.equal(value.confirmed.length, 0);
});
